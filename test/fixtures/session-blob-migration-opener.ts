import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.ts";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";

const [adapter, path, hash, mode] = process.argv.slice(2);
const database = adapter === "node-sqlite"
	? await openNodeSqliteDatabase(path!)
	: await openLibsqlDatabase({ url: pathToFileURL(path!).href });
const resume = () => new Promise<void>((resolve) => process.once("message", () => resolve()));
let paused = false;
const observed: SqliteDatabase = {
	descriptor: database.descriptor,
	exec: database.exec.bind(database),
	run: database.run.bind(database),
	get: database.get.bind(database),
	all: database.all.bind(database),
	close: database.close.bind(database),
	async transaction(callback, options) {
		let pause = false;
		const result = await database.transaction(async (tx) => {
			const result = await callback(tx);
			if (mode?.startsWith("pause") && !paused && await tx.get(`SELECT 1 FROM session_blobs b
				WHERE chunks = -1 AND EXISTS (SELECT 1 FROM session_blob_chunks c
				WHERE c.session_id = b.session_id AND c.hash = b.hash) LIMIT 1`)) {
				paused = pause = true;
				const continued = resume();
				process.send?.("locked");
				await continued;
			}
			return result;
		}, options);
		if (pause) {
			const continued = resume();
			process.send?.("batch");
			await continued;
		}
		return result;
	},
};
try {
	process.send?.("opening");
	const store = await SqlSessionStore.open(observed);
	if (mode === "open") {
		process.send?.("opened");
	} else {
		const row = await database.get("SELECT bytes FROM session_blobs WHERE session_id = 'session' AND hash = ?", hash!);
		const original = Buffer.alloc(Number(row!.bytes));
		if (mode?.includes("binary")) original.fill(Buffer.from([0, 1, 127, 128, 255]));
		await store.putBlob("session", original);
		const data = await store.getBlob("session", hash!);
		process.send?.({ type: "written", hash: data ? createHash("sha256").update(data).digest("hex") : null });
	}
	await store.close();
} finally {
	await database.close();
	process.disconnect?.();
}
