import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Where the macOS standalone binary's SQLite library is, relative to the binary's directory. `build-binaries.sh`
 * stages it there from `scripts/build-macos-sqlite.sh`: the SQLite release Node's `node:sqlite` bundles, pinned in
 * `scripts/bundled-sqlite.json`, built with Node's compile options.
 */
export const BUNDLED_SQLITE_LIBRARY = join("lib", "libsqlite3.dylib");

/** The library Bun loads on macOS when it is given no other: the system's. */
const SYSTEM_SQLITE_LIBRARY = "libsqlite3.dylib";

/** What this module uses of `bun:sqlite`. */
interface BunSqlite {
	readonly Database: { setCustomSQLite(path: string): boolean };
}

/**
 * Points Bun at the SQLite library shipped next to the macOS binary in `executableDir`, before anything opens a
 * database. Bun's SQLite on macOS, `node:sqlite` included, is otherwise the system's, whose version depends on the
 * macOS release and can be older than the one Atomic is tested with. Bun loads the library here, so a library that
 * cannot be loaded is found now: Atomic then warns once with `warn` and keeps the system's. Does nothing on other
 * platforms, under Node, and where no library was shipped, as for a binary built without one.
 */
export function useBundledSqlite(executableDir: string, warn: (message: string) => void): void {
	if (process.platform !== "darwin" || process.versions.bun === undefined) return;
	const library = join(executableDir, BUNDLED_SQLITE_LIBRARY);
	if (!existsSync(library)) return;
	const { Database } = createRequire(pathToFileURL(join(executableDir, "atomic")).href)("bun:sqlite") as BunSqlite;
	try {
		Database.setCustomSQLite(library);
	} catch (error) {
		// Bun keeps the failed path, so every open would fail with it: give it the system's back.
		try {
			Database.setCustomSQLite(SYSTEM_SQLITE_LIBRARY);
		} catch {
			// The system's loads on first use, as it did before.
		}
		warn(
			`Atomic could not load its own SQLite library (${library}): ${(error as Error).message}. It uses the system's SQLite instead.`,
		);
	}
}
