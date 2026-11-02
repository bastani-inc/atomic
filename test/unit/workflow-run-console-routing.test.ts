import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import {
	MAX_RUN_CONSOLE_LOG_BYTES,
	MAX_RUN_CONSOLE_LOG_DIRECTORY_BYTES,
	openWorkflowConsoleLogs,
	RUN_CONSOLE_LOG_RETENTION_MS,
	routeWorkflowConsoleOutput,
	runConsoleLogPath,
	stopRoutingWorkflowConsoleOutput,
} from "../../packages/workflows/src/engine/run-console.js";
import {
	openRunRejectionScope,
	type RunRejectionScope,
} from "../../packages/workflows/src/engine/run-rejection-boundary.js";

type Method = "log" | "warn" | "error";
const terminal: Array<{ readonly method: Method; readonly text: string }> = [];
const saved = { log: console.log, warn: console.warn, error: console.error };
const root = mkdtempSync(join(tmpdir(), "atomic-run-console-"));
let logDirectory = "";
let directories = 0;
const opened: RunRejectionScope[] = [];

beforeAll(() => {
	for (const method of ["log", "warn", "error"] as const) {
		console[method] = (...args: unknown[]) => terminal.push({ method, text: args.map(String).join(" ") });
	}
});

/** Each test logs into a fresh directory, so retention pruning and per-run files never carry over between tests. */
function routeToFreshDirectory(): void {
	logDirectory = join(root, `logs-${++directories}`);
	routeWorkflowConsoleOutput(logDirectory);
}

afterEach(() => {
	for (const scope of opened.splice(0)) scope.close();
	stopRoutingWorkflowConsoleOutput();
	terminal.length = 0;
});

afterAll(() => {
	Object.assign(console, saved);
	rmSync(root, { recursive: true, force: true });
});

function open(runId: string, parentRunId?: string): RunRejectionScope {
	const scope = openRunRejectionScope({
		runId,
		...(parentRunId === undefined ? {} : { parentRunId }),
		fail: () => {},
	});
	opened.push(scope);
	return scope;
}

function quitAbort(runId: string): Error {
	return Object.assign(new Error(`atomic-workflows: run ${runId} suspended by workflow quit`), { name: "AbortError" });
}

function logLines(rootRunId: string): string[] {
	return readFileSync(runConsoleLogPath(logDirectory, rootRunId), "utf8").trimEnd().split("\n");
}

test("a run's console output goes to its log file, and the chat gets one line naming it", async () => {
	routeToFreshDirectory();
	await open("run-a").run(async () => {
		for (let index = 1; index <= 40; index += 1) console.error(`dispatcher: save-${index} failed`);
		await Promise.resolve();
		console.log("still going");
	});

	const path = runConsoleLogPath(logDirectory, "run-a");
	assert.deepEqual(terminal, [{ method: "warn", text: `atomic-workflows: run run-a console output is in ${path}` }]);
	const lines = logLines("run-a");
	assert.equal(lines.length, 41);
	assert.match(lines[0] ?? "", / error dispatcher: save-1 failed$/);
	assert.match(lines[40] ?? "", / log still going$/);
});

test("cancellations from quitting a run, even after its scope closed, are logged but never reach the chat", async () => {
	routeToFreshDirectory();
	const run = open("run-quit");
	const pending = [1, 2, 3].map((index) =>
		run.run(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			try {
				throw quitAbort("run-quit");
			} catch (error) {
				console.error(`step-${index} failed:`, error);
			}
		}),
	);
	run.close();
	await Promise.all(pending);

	assert.deepEqual(terminal, []);
	assert.equal(logLines("run-quit").filter((line) => line.includes("suspended by workflow quit")).length, 3);
});

test("a nested run writes to its root run's log", () => {
	routeToFreshDirectory();
	open("root-run");
	open("child-run", "root-run").run(() => console.warn("from the child"));

	assert.deepEqual(readdirSync(logDirectory), ["root-run.log"]);
	assert.match(logLines("root-run")[0] ?? "", / warn from the child$/);
});

test("output is on disk as soon as it is logged, with nothing left to flush before exit", () => {
	routeToFreshDirectory();
	open("run-exit").run(() => console.error("last words"));
	assert.match(logLines("run-exit")[0] ?? "", / error last words$/);
});

test("a log that cannot be written is reported once, and the run's later output is dropped, not sent to the chat", () => {
	routeToFreshDirectory();
	mkdirSync(runConsoleLogPath(logDirectory, "run-unwritable"));
	const run = open("run-unwritable");
	for (let index = 0; index < 20; index += 1) run.run(() => console.error(`line ${index}`));

	assert.equal(terminal.length, 1);
	assert.match(
		terminal[0]?.text ?? "",
		/^atomic-workflows: run run-unwritable console output could not be written to .*; its later console output is dropped$/,
	);
});

test("a resumed run's log keeps its size limit across processes", () => {
	routeToFreshDirectory();
	const path = runConsoleLogPath(logDirectory, "run-resumed");
	writeFileSync(path, "x".repeat(MAX_RUN_CONSOLE_LOG_BYTES));
	open("run-resumed").run(() => console.error("more output after a restart"));

	assert.equal(statSync(path).size, MAX_RUN_CONSOLE_LOG_BYTES);
});

test("a log filling its limit gets one marker, then nothing more", () => {
	routeToFreshDirectory();
	const path = runConsoleLogPath(logDirectory, "run-noisy");
	writeFileSync(path, "x".repeat(MAX_RUN_CONSOLE_LOG_BYTES - 100));
	const run = open("run-noisy");
	for (let index = 0; index < 10; index += 1) run.run(() => console.error("y".repeat(60)));

	const tail = readFileSync(path, "utf8").slice(MAX_RUN_CONSOLE_LOG_BYTES - 100);
	assert.equal(tail.match(/log limit reached; later output is dropped/g)?.length, 1);
	assert.ok(statSync(path).size < MAX_RUN_CONSOLE_LOG_BYTES + 100);
});

test("open logs are bounded, and a closed one reopens without announcing its run again", () => {
	routeToFreshDirectory();
	const runs = Array.from({ length: 70 }, (_, index) => open(`run-${index}`));
	for (const run of runs) run.run(() => console.error("first"));
	runs[0]?.run(() => console.error("second"));

	assert.equal(openWorkflowConsoleLogs().length, 64);
	assert.equal(terminal.length, 70);
	assert.deepEqual(
		logLines("run-0").map((line) => line.split(" ").slice(2).join(" ")),
		["first", "second"],
	);
});

test("starting to route deletes logs past their retention, then the oldest until the directory fits", () => {
	const directory = join(root, "retention");
	mkdirSync(directory);
	const now = Date.now();
	const write = (name: string, bytes: number, ageMs: number) => {
		const path = join(directory, name);
		writeFileSync(path, "");
		truncateSync(path, bytes);
		utimesSync(path, (now - ageMs) / 1000, (now - ageMs) / 1000);
	};
	write("stale.log", 10, RUN_CONSOLE_LOG_RETENTION_MS + 1000);
	write("old-large.log", MAX_RUN_CONSOLE_LOG_DIRECTORY_BYTES / 2 + 1, 60_000);
	write("recent-large.log", MAX_RUN_CONSOLE_LOG_DIRECTORY_BYTES / 2, 1000);
	write("notes.txt", 10, RUN_CONSOLE_LOG_RETENTION_MS + 1000);

	routeWorkflowConsoleOutput(directory, now);

	assert.deepEqual(readdirSync(directory).sort(), ["notes.txt", "recent-large.log"]);
});

test("console output outside any run, or with routing off, still reaches the terminal", () => {
	routeToFreshDirectory();
	console.error("host message");
	stopRoutingWorkflowConsoleOutput();
	open("run-off").run(() => console.error("run message while routing is off"));

	assert.deepEqual(terminal, [
		{ method: "error", text: "host message" },
		{ method: "error", text: "run message while routing is off" },
	]);
});
