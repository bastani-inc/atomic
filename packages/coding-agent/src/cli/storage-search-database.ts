import { lstat, realpath, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { SqliteDatabase, SqliteRow, SqliteValue } from "../core/storage/database.js";
import { SqliteSelectorConnection } from "../core/tools/sqlite-selector-connection.ts";

async function existingFile(path: string): Promise<boolean> {
	try {
		if (!(await lstat(path)).isFile()) throw new Error(`Not a regular SQLite companion file: ${path}`);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** A SELECT-only handle, independent of the adapter's writer queue, open locks and migrations. */
export async function openSearchDatabase(filename: string) {
	// SQLite resolves symbolic links before looking for the WAL beside their target.
	const path = await realpath(filename);
	if (/^[/\\]{2}/.test(path)) throw new Error("An existing local SQLite session file is required.");
	// Start the worker before inspecting the sidecars. Attach the selected file without ever making it writable.
	const worker = await SqliteSelectorConnection.open(":memory:", { readonly: true });
	async function attach() {
		const before = await stat(path, { bigint: true });
		if (!before.isFile()) throw new Error(`Not a local SQLite file: ${path}`);
		const [live, journal] = await Promise.all([existingFile(`${path}-wal`), existingFile(`${path}-journal`)]);
		if (journal || (live && (before.size < 100n || !(await existingFile(`${path}-shm`)))))
			throw new Error("Cannot read this SQLite database without recovery. Close its writer cleanly, then retry.");
		// Immutable reads ignore committed WAL frames. With a WAL, use its existing read-only index instead.
		const uri = pathToFileURL(path);
		uri.search = live ? "mode=ro&readonly_shm=1" : "mode=ro&immutable=1";
		try {
			await worker.run("ATTACH DATABASE ? AS transcript", [uri.href]);
		} catch (error) {
			if (live)
				throw new Error(
					"Cannot read the existing SQLite WAL and shared-memory index. The writer may have just closed; retry against a cleanly closed database.",
					{ cause: error },
				);
			throw error;
		}
		return { live, before };
	}
	try {
		await worker.run("PRAGMA temp_store=MEMORY");
		await worker.run("PRAGMA query_only=ON");
		await worker.run("PRAGMA trusted_schema=OFF");
		let source = await attach();
		const readOnly = () => {
			throw new Error("The transcript search connection is read-only.");
		};
		return {
			readOnly: true as const,
			descriptor: { adapter: "node-sqlite", location: path },
			async get<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) {
				return (await worker.storageRows<T>(sql, params))[0];
			},
			all<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) {
				return worker.storageRows<T>(sql, params);
			},
			exec: readOnly,
			run: readOnly,
			transaction: readOnly,
			/** Never publish a page read through an immutable handle if the file changed or a writer started. */
			async refresh() {
				if (source.live) return false;
				const now = await stat(path, { bigint: true });
				const { before } = source;
				if (
					now.dev === before.dev &&
					now.ino === before.ino &&
					now.size === before.size &&
					now.mtimeNs === before.mtimeNs &&
					now.ctimeNs === before.ctimeNs &&
					!(await existingFile(`${path}-wal`)) &&
					!(await existingFile(`${path}-journal`))
				)
					return false;
				await worker.run("DETACH DATABASE transcript");
				source = await attach();
				return true;
			},
			close: () => worker.close(),
		} satisfies SqliteDatabase & { refresh(): Promise<boolean> };
	} catch (error) {
		await worker.close();
		throw error;
	}
}
