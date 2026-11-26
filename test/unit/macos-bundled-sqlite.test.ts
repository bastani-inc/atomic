/**
 * The macOS standalone binary runs the SQLite it ships in `lib/libsqlite3.dylib`, the release Node's `node:sqlite`
 * bundles, instead of the system's, whose version depends on the macOS release. Each test compiles the binary's real
 * entry point (`split-loader.ts`) with Bun, as `build-binaries.sh` does, next to a library `build-macos-sqlite.sh` built,
 * and an `app.js` that reports what the binary runs. macOS only; the macOS test workflow runs it.
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { bunExecutable, makeTempDirectory, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const pinned = JSON.parse(readFileSync(join(repoRoot, "scripts/bundled-sqlite.json"), "utf8")) as {
	version: string;
	sourceId: string;
};
const sourcePath = (path: string) => join(repoRoot, "packages/coding-agent/src", path);

/** Downloading SQLite on a cold cache, then compiling it and the binary, under CI load. */
const SETUP_TIMEOUT_MS = 300_000;
/** A binary that opens a SQLite file twice and reads storage status. */
const RUN_TIMEOUT_MS = 60_000;

/** What `app.js` prints: the SQLite the binary runs, and `atomic storage status` of a cleanly closed store. */
interface Report {
	readonly version: string;
	readonly sourceId: string;
	readonly sidecars: readonly string[];
	readonly connection: { readonly status: string; readonly detail: string };
	readonly lines: readonly string[];
}

/**
 * The app the binary loads, bundled as `build-binaries.sh` bundles `app.js`: it reports the SQLite library, then writes
 * and closes a store, as `atomic storage import` leaves it, so its last close removes the `-wal` and `-shm` files, and
 * reads `atomic storage status` of it (#6622).
 */
const APP = `import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { formatStorageStatus } from ${JSON.stringify(sourcePath("cli/storage-command.ts"))};
import { openNodeSqliteDatabase } from ${JSON.stringify(sourcePath("core/storage/node-sqlite.ts"))};
import { collectStorageStatus } from ${JSON.stringify(sourcePath("core/storage/storage-status.ts"))};

const memory = new DatabaseSync(":memory:");
const library = memory.prepare("SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId").get();
memory.close();
const dir = process.env.ATOMIC_TEST_DIR;
const agentDir = join(dir, "agent");
const file = join(dir, "store", "sessions.sqlite");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessions: { storage: { path: file } } }));
const writer = await openNodeSqliteDatabase(file);
await writer.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
await writer.run("INSERT INTO items (id) VALUES (1)");
await writer.close();
const sidecars = ["-wal", "-shm"].filter((suffix) => existsSync(file + suffix));
const status = await collectStorageStatus({ cwd: dir, agentDir, probe: true });
const sessions = status.domains.find((domain) => domain.domain === "sessions");
console.log(JSON.stringify({
	version: library.version,
	sourceId: library.sourceId,
	sidecars,
	connection: sessions?.probe?.connection,
	lines: formatStorageStatus(status),
}));
`;

let root = "";
let library = "";
let binary = "";

beforeAll(() => {
	if (process.platform !== "darwin") return;
	root = makeTempDirectory("atomic-bundled-sqlite-");
	library = join(root, "libsqlite3.dylib");
	const built = spawnSyncCollect(
		["bash", join(repoRoot, "scripts/build-macos-sqlite.sh"), process.arch === "arm64" ? "arm64" : "x64", library],
		{ cwd: repoRoot, timeout: SETUP_TIMEOUT_MS },
	);
	assert.equal(built.exitCode, 0, built.stderr.toString());
	binary = join(root, "binary", "atomic");
	const compiled = spawnSyncCollect(
		[
			bunExecutable(),
			"build",
			"--compile",
			"--format=cjs",
			"--external",
			"mupdf",
			"--no-compile-autoload-dotenv",
			"--no-compile-autoload-bunfig",
			join(repoRoot, "packages/coding-agent/src/bun/split-loader.ts"),
			"--outfile",
			binary,
		],
		{ cwd: repoRoot, timeout: SETUP_TIMEOUT_MS },
	);
	assert.equal(compiled.exitCode, 0, compiled.stderr.toString());
	const entry = join(root, "app.ts");
	writeFileSync(entry, APP);
	const bundled = spawnSyncCollect(
		[
			bunExecutable(),
			"build",
			"--target=bun",
			"--format=esm",
			"--external",
			"mupdf",
			entry,
			"--outfile",
			join(root, "binary", "app.js"),
		],
		{ cwd: repoRoot, timeout: SETUP_TIMEOUT_MS },
	);
	assert.equal(bundled.exitCode, 0, bundled.stderr.toString());
}, SETUP_TIMEOUT_MS);

afterAll(() => {
	if (root !== "") removeTempDirectory(root);
});

/** Runs the binary with `lib/libsqlite3.dylib` copied from `shipped`, or none, in a directory of its own. */
function run(shipped: string | undefined): { report: Report; stderr: string } {
	const dir = makeTempDirectory("atomic-bundled-sqlite-run-");
	try {
		if (shipped !== undefined) {
			mkdirSync(join(root, "binary", "lib"), { recursive: true });
			copyFileSync(shipped, join(root, "binary", "lib", "libsqlite3.dylib"));
		} else removeTempDirectory(join(root, "binary", "lib"));
		const result = spawnSyncCollect([binary], {
			cwd: dir,
			timeout: RUN_TIMEOUT_MS,
			env: {
				...process.env,
				ATOMIC_TEST_DIR: dir,
				ATOMIC_STORAGE: "",
				ATOMIC_SESSIONS_STORAGE: "",
				ATOMIC_CODING_AGENT_SESSION_DIR: "",
			},
		});
		const stdout = result.stdout.toString();
		const stderr = result.stderr.toString();
		assert.equal(result.exitCode, 0, `stderr:\n${stderr}\nstdout:\n${stdout}`);
		return { report: JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Report, stderr };
	} finally {
		removeTempDirectory(dir);
	}
}

describe.skipIf(process.platform !== "darwin")("the macOS binary's SQLite", () => {
	test(
		"is the one it ships, which storage status reports, and opens a cleanly closed store read-only (#6622)",
		() => {
			const { report, stderr } = run(library);
			assert.equal(stderr, "");
			assert.equal(report.version, pinned.version);
			assert.equal(report.sourceId, pinned.sourceId);
			assert.ok(report.lines.includes(`  library:     SQLite ${pinned.version}`), report.lines.join("\n"));
			// The state #6622 is about: the last close removed the WAL and its index, and the store still answers.
			assert.deepEqual(report.sidecars, []);
			assert.equal(report.connection.status, "ok", report.connection.detail);
		},
		RUN_TIMEOUT_MS,
	);

	test(
		"is the system's, with one warning, when the shipped library cannot be loaded",
		() => {
			const broken = join(root, "broken.dylib");
			writeFileSync(broken, "not a library");
			const { report, stderr } = run(broken);
			assert.match(
				stderr,
				/^Atomic could not load its own SQLite library \(.+\): .+\. It uses the system's SQLite instead\.\n$/,
			);
			assert.notEqual(report.sourceId, pinned.sourceId);
			assert.equal(report.connection.status, "ok", report.connection.detail);
		},
		RUN_TIMEOUT_MS,
	);

	test(
		"is the system's, without a warning, in a binary built without one",
		() => {
			const { report, stderr } = run(undefined);
			assert.equal(stderr, "");
			assert.notEqual(report.sourceId, pinned.sourceId);
		},
		RUN_TIMEOUT_MS,
	);
});
