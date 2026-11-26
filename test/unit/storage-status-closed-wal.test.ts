/**
 * `atomic storage status` opens a local SQLite store read-only. When the last connection to a store closes cleanly,
 * SQLite removes its `-wal` and `-shm` files, so the next read-only open finds a WAL-mode database with neither.
 * Stock SQLite, which Node bundles, creates the `-wal` for that reader; Apple's, which Bun uses on macOS, does not and
 * fails the open with "unable to open database file" (SQLITE_CANTOPEN, code 14). Status then reported a healthy store
 * that `atomic storage import` had just written to as failed. The same script runs under both runtimes.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, test } from "vitest";
import { bunExecutable, makeTempDirectory, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

/** Budget for a Node or Bun child that loads the storage sources and opens a SQLite file twice, under CI load. */
const CHILD_TIMEOUT_MS = 60_000;

const repoRoot = resolve(import.meta.dirname, "../..");
const sourceUrl = (path: string) => pathToFileURL(join(repoRoot, "packages/coding-agent/src", path)).href;

// Atomic's sources import `.js` specifiers that name `.ts` files; Bun resolves them, and so does this hook for Node.
const RESOLVE_TS_SOURCES = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
	try { return nextResolve(specifier, context); }
	catch (error) {
		if (/^\\.\\.?\\//.test(specifier) && specifier.endsWith(".js"))
			return nextResolve(specifier.slice(0, -3) + ".ts", context);
		throw error;
	}
} });`;

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) removeTempDirectory(dir);
});

describe.each(["node", "bun"] as const)("storage status under %s", (runtime) => {
	test(
		"reports a cleanly closed SQLite store as answering",
		() => {
			const dir = makeTempDirectory("atomic-status-closed-wal-");
			tempDirs.push(dir);
			const scriptPath = join(dir, "script.mts");
			writeFileSync(
				scriptPath,
				`${runtime === "node" ? RESOLVE_TS_SOURCES : ""}
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const { openNodeSqliteDatabase } = await import(${JSON.stringify(sourceUrl("core/storage/node-sqlite.ts"))});
const { collectStorageStatus } = await import(${JSON.stringify(sourceUrl("core/storage/storage-status.ts"))});
const dir = ${JSON.stringify(dir)};
const agentDir = join(dir, "agent");
const file = join(dir, "store", "sessions.sqlite");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessions: { storage: { path: file } } }));
// A store written and closed, as \`atomic storage import\` leaves it.
const writer = await openNodeSqliteDatabase(file);
await writer.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
await writer.run("INSERT INTO items (id) VALUES (1)");
await writer.close();
const sidecars = ["-wal", "-shm"].filter((suffix) => existsSync(file + suffix));
const status = await collectStorageStatus({ cwd: dir, agentDir, probe: true });
const sessions = status.domains.find((domain) => domain.domain === "sessions");
console.log(JSON.stringify({ sidecars, selection: sessions?.selection, connection: sessions?.probe?.connection }));
`,
				"utf8",
			);
			const executable = runtime === "bun" ? bunExecutable() : process.execPath;
			const result = spawnSyncCollect([executable, scriptPath], {
				cwd: dir,
				timeout: CHILD_TIMEOUT_MS,
				env: {
					...process.env,
					ATOMIC_STORAGE: "",
					ATOMIC_SESSIONS_STORAGE: "",
					ATOMIC_CODING_AGENT_SESSION_DIR: "",
				},
			});
			const stdout = result.stdout.toString();
			assert.equal(result.exitCode, 0, `stderr:\n${result.stderr.toString()}\nstdout:\n${stdout}`);
			const outcome = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
				sidecars: string[];
				selection: string;
				connection: { status: string; detail: string };
			};
			// The state under test: the last close removed the WAL and its index.
			assert.deepEqual(outcome.sidecars, []);
			assert.equal(outcome.selection, `SQLite ${join(dir, "store", "sessions.sqlite")}`);
			assert.equal(outcome.connection.status, "ok", outcome.connection.detail);
		},
		CHILD_TIMEOUT_MS,
	);
});
