import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "vitest";
import { TestSqliteDatabase } from "./helpers/sqlite.js";

/**
 * Atomic's own worker threads run CommonJS source and need none of the process's command-line flags: a host started with
 * `--input-type=module` would turn that source into a module, and its `--import`/`--require` preloads would run again in
 * every worker (#6079). Each test runs a Node child with such flags that loads Atomic's modules from source.
 */

// Atomic's sources import `.js` specifiers that name `.ts` files; Bun resolves them, and so does this hook for Node.
const RESOLVE_TS_SOURCES = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
	try { return nextResolve(specifier, context); }
	catch (error) { if (/^\\.\\.?\\//.test(specifier) && specifier.endsWith(".js")) return nextResolve(specifier.slice(0, -3) + ".ts", context); throw error; }
} });`;
// A preload that records each run, as an SDK host's instrumentation or a test runner's setup would.
const COUNTING_PRELOAD = `import { appendFileSync } from "node:fs";
appendFileSync(process.env.ATOMIC_TEST_PRELOAD_LOG, "ran\\n");`;
const dataUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const sourceUrl = (path: string) =>
	JSON.stringify(pathToFileURL(fileURLToPath(new URL(`../src/${path}`, import.meta.url))).href);
const MISSING_NODE_SQLITE =
	"SQLite selectors need node:sqlite (Node >= 22.13 or Bun >= 1.4.2); this runtime does not provide it.";

let dir: string;
let preloadLog: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "atomic-worker-flags-"));
	preloadLog = join(dir, "preload.log");
	const db = new TestSqliteDatabase(join(dir, "data.sqlite"));
	db.run("create table n (v integer)");
	db.run("insert into n (v) values (1), (2), (3)");
	db.close();
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function runNode(flags: readonly string[], script: string): SpawnSyncReturns<string> {
	return spawnSync(process.execPath, [...flags, "--import", dataUrl(RESOLVE_TS_SOURCES), "--eval", script], {
		cwd: dir,
		encoding: "utf-8",
		env: { ...process.env, ATOMIC_TEST_PRELOAD_LOG: preloadLog },
	});
}

/** A host started with `--input-type=module` and a counting `--import` preload. */
function runModuleHost(script: string): SpawnSyncReturns<string> {
	return runNode(["--import", dataUrl(COUNTING_PRELOAD), "--input-type=module"], script);
}

function preloadRuns(): number {
	return readFileSync(preloadLog, "utf-8").split("\n").filter(Boolean).length;
}

function output(result: SpawnSyncReturns<string>): unknown {
	assert.equal(result.status, 0, `the child failed (${result.signal ?? result.status}):\n${result.stderr}`);
	return JSON.parse(result.stdout);
}

test("a SQLite selector works from a process started with --input-type=module and runs its preload once (#6079)", () => {
	const result = runModuleHost(`
		import { createReadToolDefinition } from ${sourceUrl("core/tools/read.ts")};
		const tool = createReadToolDefinition(process.cwd());
		const texts = [];
		for (const query of ["select count(*) as total from n", "select max(v) as top from n"]) {
			const read = await tool.execute("call", { path: "data.sqlite?q=" + encodeURIComponent(query) });
			texts.push(read.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
		}
		process.stdout.write(JSON.stringify(texts));
	`);
	assert.deepEqual(output(result), ['{"total":3}', '{"top":3}']);
	assert.equal(preloadRuns(), 1, "the preload ran again for a selector connection");
});

test("a SQLite selector still reports node:sqlite missing when the process disables it (#6079)", () => {
	const result = runNode(
		["--no-experimental-sqlite"],
		`(async () => {
			const { createReadToolDefinition } = await import(${sourceUrl("core/tools/read.ts")});
			const tool = createReadToolDefinition(process.cwd());
			const read = tool.execute("call", { path: "data.sqlite?q=" + encodeURIComponent("select count(*) as total from n") });
			process.stdout.write(JSON.stringify(await read.then(() => "read", (error) => error.message)));
		})();`,
	);
	assert.equal(output(result), MISSING_NODE_SQLITE);
});

test("diagnostic, settings-lock and history-search workers start without the process's flags (#6079)", () => {
	const result = runModuleHost(`
		import { DiagnosticWriter } from ${sourceUrl("core/diagnostic-writer.ts")};
		import { createLockDirectory } from ${sourceUrl("core/settings-lock-directory.ts")};
		import { matchLinesInWorker } from ${sourceUrl("core/tools/history-regex-worker.ts")};
		import { existsSync, readFileSync } from "node:fs";
		const failures = [];
		const writer = new DiagnosticWriter((_path, error) => failures.push(error.message));
		writer.append("diagnostic.log", "line\\n");
		await writer.written();
		await createLockDirectory("settings.lock").created;
		const { matchedIndices } = await matchLinesInWorker(["alpha", "beta", "gamma"], "a$", "", false, false, 10_000);
		process.stdout.write(JSON.stringify({
			failures,
			diagnostic: existsSync("diagnostic.log") ? readFileSync("diagnostic.log", "utf-8") : null,
			lock: existsSync("settings.lock"),
			matchedIndices,
		}));
	`);
	assert.deepEqual(output(result), { failures: [], diagnostic: "line\n", lock: true, matchedIndices: [0, 1, 2] });
	assert.equal(preloadRuns(), 1, "the preload ran again for a worker");
});

test("under Node's permission model, diagnostic and settings-lock workers keep the process's restrictions (#6079)", () => {
	mkdirSync(join(dir, "allowed"));
	const result = runNode(
		["--permission", "--allow-worker", "--allow-fs-read=*", `--allow-fs-write=${join(dir, "allowed")}`],
		`(async () => {
			const { DiagnosticWriter } = await import(${sourceUrl("core/diagnostic-writer.ts")});
			const { createLockDirectory } = await import(${sourceUrl("core/settings-lock-directory.ts")});
			const { existsSync } = await import("node:fs");
			const failures = [];
			const writer = new DiagnosticWriter((path) => failures.push(path));
			writer.append("denied.log", "line\\n");
			await writer.written();
			const lock = await createLockDirectory("denied.lock").created.then(() => "created", (error) => error.code);
			process.stdout.write(JSON.stringify({ failures, written: existsSync("denied.log"), lock, locked: existsSync("denied.lock") }));
		})();`,
	);
	assert.deepEqual(output(result), {
		failures: ["denied.log"],
		written: false,
		lock: "ERR_ACCESS_DENIED",
		locked: false,
	});
});

test("the parent-process guardian starts without the process's flags (#6079)", () => {
	const stopFile = join(dir, "stop");
	const result = runModuleHost(`
		import { startParentProcessGuardian } from ${sourceUrl("utils/shell.ts")};
		import { writeFileSync } from "node:fs";
		startParentProcessGuardian(process.pid, ${JSON.stringify(stopFile)});
		writeFileSync(${JSON.stringify(stopFile)}, "");
		// The guardian ends this process once it sees the stop file; outliving it means the guardian never ran.
		setTimeout(() => process.stdout.write("survived"), 15_000);
	`);
	assert.equal(result.stdout, "");
	assert.doesNotMatch(result.stderr, /Error/);
	if (process.platform !== "win32") assert.equal(result.signal, "SIGKILL");
	assert.equal(preloadRuns(), 1, "the preload ran again for the guardian");
});

// A 2x2 PNG, within every resize limit.
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==";
// Records each module a worker thread loads, so a test sees whether the image-resize worker ran.
const RECORD_WORKER_LOADS = `import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { isMainThread } from "node:worker_threads";
if (!isMainThread) registerHooks({ load(url, context, nextLoad) {
	appendFileSync(process.env.ATOMIC_TEST_PRELOAD_LOG, url + "\\n");
	return nextLoad(url, context);
} });`;

test("image resizing runs on its worker thread in a process started with --input-type=module (#6079)", () => {
	const result = runNode(
		["--import", dataUrl(RECORD_WORKER_LOADS), "--input-type=module"],
		`
		import { resizeImage } from ${sourceUrl("utils/image-resize.ts")};
		const resized = await resizeImage(Buffer.from(${JSON.stringify(TINY_PNG)}, "base64"), "image/png");
		process.stdout.write(JSON.stringify({ wasResized: resized.wasResized, width: resized.width, height: resized.height }));
	`,
	);
	assert.deepEqual(output(result), { wasResized: false, width: 2, height: 2 });
	assert.match(readFileSync(preloadLog, "utf-8"), /image-resize-worker\.ts\n/, "the resize ran on the calling thread");
});
