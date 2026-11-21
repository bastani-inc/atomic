import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { spawnSyncCollect } from "../helpers/runtime.js";

// The built module, run in a child process of its own: vitest's own preload counts as a user preload, which turns the
// spare thread off, and each scenario needs a process whose threads it can count from the start.
const threadModule = new URL("../../packages/coding-agent/dist/core/storage/node-sqlite-thread.js", import.meta.url)
	.href;
/** One child process start plus a few SQLite opens: generous, since the child is only ever waited on, never raced. */
const CHILD_TIMEOUT_MS = 20_000;

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "atomic-spare-thread-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

interface ChildRun {
	readonly exitCode: number | null;
	readonly report: Record<string, unknown>;
}

/** Runs `body` in a child Node process that counts every worker thread it starts and prints `report` as JSON. */
function runChild(body: string, nodeFlags: readonly string[] = []): ChildRun {
	const script = join(dir, "child.mjs");
	writeFileSync(
		script,
		`const { ThreadConnection } = await import(${JSON.stringify(threadModule)});
const workers = [];
// Each worker's start and end, watched from the moment it exists so neither event can pass unseen.
const online = [];
const exited = [];
process.on("worker", (worker) => {
	workers.push(worker);
	online.push(new Promise((resolve) => worker.once("online", resolve)));
	exited.push(new Promise((resolve) => worker.once("exit", resolve)));
});
// Node reports a new worker on a later turn.
const settle = () => new Promise((resolve) => setImmediate(resolve));
const report = {};
${body}
console.log(JSON.stringify(report));
`,
	);
	const result = spawnSyncCollect([process.execPath, ...nodeFlags, script], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		timeout: CHILD_TIMEOUT_MS,
	});
	const lines = result.stdout.toString().trim().split("\n");
	assert.equal(result.exitCode, 0, `child failed: ${result.stderr.toString()}`);
	return { exitCode: result.exitCode, report: JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown> };
}

test("the first open after startSpare uses the thread it started; the next open starts its own", () => {
	const { report } = runChild(`
ThreadConnection.startSpare();
await settle();
report.afterStart = workers.length;
const first = await ThreadConnection.open(${JSON.stringify(join(dir, "a.db"))}, { readOnly: false });
report.afterFirst = workers.length;
const second = await ThreadConnection.open(${JSON.stringify(join(dir, "b.db"))}, { readOnly: false });
report.afterSecond = workers.length;
report.locations = [first.location, second.location];
await first.connection.request({ kind: "close" });
await second.connection.request({ kind: "close" });
`);
	assert.deepEqual(report, {
		afterStart: 1,
		afterFirst: 1,
		afterSecond: 2,
		locations: [join(dir, "a.db"), join(dir, "b.db")],
	});
});

test("an open whose spare thread is lost before it answers opens on a thread of its own", () => {
	const { report } = runChild(`
ThreadConnection.startSpare();
await settle();
const opening = ThreadConnection.open(${JSON.stringify(join(dir, "a.db"))}, { readOnly: false });
await workers[0].terminate();
const opened = await opening;
report.location = opened.location;
await settle();
report.threads = workers.length;
await opened.connection.request({ kind: "close" });
`);
	assert.deepEqual(report, { location: join(dir, "a.db"), threads: 2 });
});

test("a database error on the spare thread is the open's error, with no second thread", () => {
	const { report } = runChild(`
ThreadConnection.startSpare();
try {
	await ThreadConnection.open(${JSON.stringify(join(dir, "missing", "deeper", "a.db"))}, { readOnly: true });
	report.error = null;
} catch (error) {
	report.error = error.code ?? error.name;
}
await settle();
report.threads = workers.length;
`);
	assert.deepEqual(report, { error: "ERR_SQLITE_ERROR", threads: 1 });
});

test("startSpare starts nothing in a process that runs a preload, which every worker thread would run again", () => {
	const preload = join(dir, "preload.cjs");
	writeFileSync(preload, "");
	const { report } = runChild(
		`
ThreadConnection.startSpare();
await settle();
report.threads = workers.length;
`,
		["--require", preload],
	);
	assert.deepEqual(report, { threads: 0 });
});

test("an idle spare thread neither keeps the process running nor outlives releaseSpare", () => {
	const { report } = runChild(`
// An idle spare keeps nothing alive, so this child holds itself open while it waits for the thread's events.
const holdOpen = setInterval(() => {}, 1000);
ThreadConnection.startSpare();
await settle();
await online[0];
ThreadConnection.releaseSpare();
await exited[0];
clearInterval(holdOpen);
report.released = true;
ThreadConnection.startSpare();
await settle();
report.threads = workers.length;
`);
	// The child printed its report and exited by itself, with the second spare still idle.
	assert.deepEqual(report, { released: true, threads: 2 });
});
