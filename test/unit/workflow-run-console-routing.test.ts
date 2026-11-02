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
import { basename, dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import {
	CONSOLE_LOG_RETENTION_MS,
	MAX_CONSOLE_LOG_DIRECTORY_BYTES,
	MAX_PROCESS_CONSOLE_LOG_BYTES,
	MAX_RUN_CONSOLE_BYTES,
	routeWorkflowConsoleOutput,
	stopRoutingWorkflowConsoleOutput,
	workflowConsoleLogPath,
} from "../../packages/workflows/src/engine/run-console.js";
import {
	openRunRejectionScope,
	type RunRejectionScope,
} from "../../packages/workflows/src/engine/run-rejection-boundary.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";

type Method = "log" | "warn" | "error";
const terminal: Array<{ readonly method: Method; readonly text: string }> = [];
const saved = { log: console.log, warn: console.warn, error: console.error };
const root = mkdtempSync(join(tmpdir(), "atomic-run-console-"));
let directories = 0;
const opened: RunRejectionScope[] = [];

beforeAll(() => {
	for (const method of ["log", "warn", "error"] as const) {
		console[method] = (...args: unknown[]) => terminal.push({ method, text: args.map(String).join(" ") });
	}
});

/** Each test logs into a fresh directory, so retention pruning and earlier logs never carry over between tests. */
function routeToFreshDirectory(): string {
	const directory = join(root, `logs-${++directories}`);
	routeWorkflowConsoleOutput(directory);
	return directory;
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

/** A run scope; a root run routes its console output unless its owner said otherwise (`consoleLog: false`). */
function open(runId: string, parentRunId?: string, consoleLog = true): RunRejectionScope {
	const scope = openRunRejectionScope({
		runId,
		...(parentRunId === undefined ? { consoleLog } : { parentRunId }),
		fail: () => {},
	});
	opened.push(scope);
	return scope;
}

function quitAbort(runId: string): Error {
	return Object.assign(new Error(`atomic-workflows: run ${runId} suspended by workflow quit`), { name: "AbortError" });
}

/** The log's lines as `<run> <method> <text>`, without their timestamps. */
function logLines(): string[] {
	const path = workflowConsoleLogPath();
	assert.ok(path);
	return readFileSync(path, "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => line.slice(line.indexOf(" ") + 1));
}

test("a run's console output goes to the process's workflow log, and the chat gets one line naming it", async () => {
	const directory = routeToFreshDirectory();
	await open("run-a").run(async () => {
		for (let index = 1; index <= 40; index += 1) console.error(`dispatcher: save-${index} failed`);
		await Promise.resolve();
		console.log("still going");
	});

	const path = workflowConsoleLogPath();
	assert.ok(path);
	assert.equal(dirname(path), directory);
	assert.match(basename(path), new RegExp(`^${process.pid}-\\d+\\.log$`));
	assert.deepEqual(terminal, [{ method: "warn", text: `atomic-workflows: run run-a console output is in ${path}` }]);
	const lines = logLines();
	assert.equal(lines.length, 41);
	assert.equal(lines[0], "run-a error dispatcher: save-1 failed");
	assert.equal(lines[40], "run-a log still going");
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
	assert.equal(logLines().filter((line) => line.includes("suspended by workflow quit")).length, 3);
});

test("a nested run's output is tagged with its root run, and is on disk as soon as it is logged", () => {
	routeToFreshDirectory();
	open("root-run");
	open("child-run", "root-run").run(() => console.warn("from the child"));

	assert.deepEqual(logLines(), ["root-run warn from the child"]);
});

test("runs whose owner does not route their output keep writing to the terminal", () => {
	routeToFreshDirectory();
	open("other-owner-run", undefined, false).run(() => console.error("from another owner's run"));
	open("owned-run").run(() => console.error("from an owned run"));

	assert.equal(terminal[0]?.text, "from another owner's run");
	assert.deepEqual(logLines(), ["owned-run error from an owned run"]);
});

test("a log that cannot be written is reported once, and later output is dropped, not sent to the chat", () => {
	const directory = routeToFreshDirectory();
	rmSync(directory, { recursive: true });
	writeFileSync(directory, "not a directory");
	const run = open("run-unwritable");
	for (let index = 0; index < 20; index += 1) run.run(() => console.error(`line ${index}`));

	assert.equal(terminal.length, 1);
	assert.match(
		terminal[0]?.text ?? "",
		/^atomic-workflows: workflow console output could not be written to .*; later workflow console output is dropped$/,
	);
});

test("a run filling its share of the log gets one marker, and other runs keep logging", () => {
	routeToFreshDirectory();
	const megabyte = "y".repeat(1024 * 1024);
	const noisy = open("run-noisy");
	for (let index = 0; index <= MAX_RUN_CONSOLE_BYTES / megabyte.length + 2; index += 1)
		noisy.run(() => console.error(megabyte));
	open("run-quiet").run(() => console.error("still logged"));

	const lines = logLines();
	assert.equal(
		lines.filter((line) => line === "run-noisy run log limit reached; its later output is dropped").length,
		1,
	);
	assert.equal(lines.at(-1), "run-quiet error still logged");
});

test("the process log stops at its limit with one marker", () => {
	routeToFreshDirectory();
	const megabyte = "z".repeat(1024 * 1024);
	const runsNeeded = Math.ceil(MAX_PROCESS_CONSOLE_LOG_BYTES / (MAX_RUN_CONSOLE_BYTES - megabyte.length)) + 1;
	for (let run = 0; run < runsNeeded; run += 1) {
		const scope = open(`run-${run}`);
		for (let index = 0; index < MAX_RUN_CONSOLE_BYTES / megabyte.length - 1; index += 1)
			scope.run(() => console.error(megabyte));
	}

	const lines = logLines();
	assert.equal(
		lines.filter((line) => line === "log limit reached; later workflow console output is dropped").length,
		1,
	);
	assert.equal(lines.at(-1), "log limit reached; later workflow console output is dropped");
});

test("a call its run cannot afford caps that run only, even near the process limit", () => {
	routeToFreshDirectory();
	const sevenMegabytes = "w".repeat(7 * 1024 * 1024);
	const runs = Array.from({ length: 9 }, (_, index) => open(`run-${index}`));
	for (const run of runs) run.run(() => console.error(sevenMegabytes));
	runs[8]?.run(() => console.error("v".repeat(2 * 1024 * 1024)));
	open("run-quiet").run(() => console.error("still logged"));

	const lines = logLines().map((line) => line.slice(0, 80));
	assert.equal(lines.filter((line) => line === "run-8 run log limit reached; its later output is dropped").length, 1);
	assert.equal(lines.filter((line) => line.startsWith("log limit reached")).length, 0);
	assert.equal(lines.at(-1), "run-quiet error still logged");
});

test("run-limit markers never push the log past its limit", () => {
	routeToFreshDirectory();
	const sevenMegabytes = "w".repeat(7 * 1024 * 1024);
	for (let run = 0; run < 9; run += 1) open(`filler-${run}`).run(() => console.error(sevenMegabytes));
	const path = workflowConsoleLogPath();
	assert.ok(path);
	const room = MAX_PROCESS_CONSOLE_LOG_BYTES - statSync(path).size;
	open("top-up").run(() => console.error("t".repeat(room - 4300)));
	const oversized = "o".repeat(MAX_RUN_CONSOLE_BYTES + 1);
	for (let run = 0; run < 50; run += 1) open(`oversized-${run}`).run(() => console.error(oversized));

	assert.ok(statSync(path).size <= MAX_PROCESS_CONSOLE_LOG_BYTES, `${statSync(path).size} bytes`);
	const markers = logLines().filter((line) => line.startsWith("log limit reached"));
	assert.equal(markers.length, 1);
	assert.equal(logLines().at(-1), "log limit reached; later workflow console output is dropped");
});

test("a log directory that cannot be created is reported once, and routed output is dropped, not sent to the chat", () => {
	const blocked = join(root, `blocked-${++directories}`);
	writeFileSync(blocked, "a file where the log directory should be");
	routeWorkflowConsoleOutput(blocked);
	const run = open("run-without-a-directory");
	for (let index = 0; index < 20; index += 1) run.run(() => console.error(`line ${index}`));
	console.error("outside any run");

	assert.equal(terminal.length, 2);
	assert.match(terminal[0]?.text ?? "", /^atomic-workflows: workflow console output could not be written to /);
	assert.equal(terminal[1]?.text, "outside any run");
});

test("a run started again by an owner that does not route its output makes its own decision", () => {
	routeToFreshDirectory();
	const first = open("resumed-run");
	first.run(() => console.error("routed by its terminal-UI owner"));
	first.close();
	open("resumed-run", undefined, false).run(() => console.error("resumed by a headless owner"));

	assert.deepEqual(logLines(), ["resumed-run error routed by its terminal-UI owner"]);
	assert.equal(terminal.at(-1)?.text, "resumed by a headless owner");
});

test("abort listeners of a run's steps log to the run's log when the host cancels a step or the whole run", async () => {
	routeToFreshDirectory();
	const waiting = workflow({
		name: "waiting",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await Promise.allSettled(
				[1, 2, 3].map((index) =>
					ctx.tool(
						`wait-${index}`,
						{ index },
						({ signal }) =>
							new Promise<number>((_, reject) => {
								signal.addEventListener(
									"abort",
									() => {
										console.error(`listener ${index}: step aborted`);
										reject(signal.reason);
									},
									{ once: true },
								);
							}),
					),
				),
			);
			return {};
		},
	});
	const tools = createToolControlRegistry();
	const caller = new AbortController();
	const runId = testRunId("abort-listeners");
	const settled = run(
		waiting,
		{},
		{
			runId,
			cwd: root,
			store: createStore(),
			routeConsoleToLog: true,
			toolControlRegistry: tools,
			signal: caller.signal,
		},
	).catch(() => undefined);
	for (let attempt = 0; tools.active(runId).length < 3 && attempt < 500; attempt += 1)
		await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(tools.active(runId).length, 3);

	// From outside the run, as a host's quit does: one step first, then the whole run.
	tools.active(runId)[0]?.abort("quit");
	caller.abort(new Error("quit by the host"));
	await settled;

	assert.deepEqual(
		terminal.filter(({ text }) => text.includes("step aborted")),
		[],
	);
	const listenerLines = logLines().filter((line) => line.includes("step aborted"));
	assert.equal(listenerLines.length, 3);
	assert.ok(listenerLines.every((line) => line.startsWith(`${runId} error listener `)));
});

test("an error whose metadata throws when read is logged without turning the console call into a failure", () => {
	routeToFreshDirectory();
	const hostile = new Error("a failure with an unreadable cause");
	Object.defineProperty(hostile, "cause", {
		get() {
			throw new Error("cause accessor throws");
		},
	});

	assert.doesNotThrow(() => open("run-hostile-error").run(() => console.error(hostile)));
	assert.match(logLines()[0] ?? "", /^run-hostile-error error .*a failure with an unreadable cause/);
});

test("starting to route deletes exited processes' logs past retention, then the oldest until the directory fits", () => {
	const directory = join(root, "retention");
	mkdirSync(directory);
	const now = Date.now();
	const exited = 2 ** 22 + 12_345;
	const write = (name: string, bytes: number, ageMs: number) => {
		const path = join(directory, name);
		writeFileSync(path, "");
		truncateSync(path, bytes);
		utimesSync(path, (now - ageMs) / 1000, (now - ageMs) / 1000);
	};
	write(`${exited}-1.log`, 10, CONSOLE_LOG_RETENTION_MS + 1000);
	write(`${exited + 1}-2.log`, MAX_CONSOLE_LOG_DIRECTORY_BYTES / 2 + 1, 60_000);
	write(`${exited + 2}-3.log`, MAX_CONSOLE_LOG_DIRECTORY_BYTES / 2, 1000);
	write(`${process.pid}-4.log`, 10, CONSOLE_LOG_RETENTION_MS + 1000);
	write("notes.log", 10, CONSOLE_LOG_RETENTION_MS + 1000);

	routeWorkflowConsoleOutput(directory, now);

	assert.deepEqual(readdirSync(directory).sort(), [`${exited + 2}-3.log`, `${process.pid}-4.log`, "notes.log"].sort());
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
