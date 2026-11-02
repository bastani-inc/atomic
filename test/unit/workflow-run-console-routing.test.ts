import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import {
	flushWorkflowConsoleOutput,
	routeWorkflowConsoleOutput,
	stopRoutingWorkflowConsoleOutput,
	workflowConsoleLogPath,
} from "../../packages/workflows/src/engine/run-console.js";
import {
	openRunRejectionScope,
	type RunRejectionScope,
} from "../../packages/workflows/src/engine/run-rejection-boundary.js";

type Method = "log" | "warn" | "error";
const terminal: Array<{ readonly method: Method; readonly text: string }> = [];
const saved = { log: console.log, warn: console.warn, error: console.error };
let logDirectory = "";
const opened: RunRejectionScope[] = [];

beforeAll(() => {
	for (const method of ["log", "warn", "error"] as const) {
		console[method] = (...args: unknown[]) => terminal.push({ method, text: args.map(String).join(" ") });
	}
	logDirectory = mkdtempSync(join(tmpdir(), "atomic-run-console-"));
	routeWorkflowConsoleOutput(logDirectory);
});

afterEach(() => {
	for (const scope of opened.splice(0)) scope.close();
	terminal.length = 0;
	routeWorkflowConsoleOutput(logDirectory);
});

afterAll(() => {
	stopRoutingWorkflowConsoleOutput();
	Object.assign(console, saved);
	rmSync(logDirectory, { recursive: true, force: true });
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

test("a run's console output goes to its log file, and the chat gets one line naming it", async () => {
	const run = open("run-a");
	await run.run(async () => {
		for (let index = 1; index <= 40; index += 1) console.error(`dispatcher: save-${index} failed`);
		await Promise.resolve();
		console.log("still going");
	});
	await flushWorkflowConsoleOutput();

	const path = workflowConsoleLogPath("run-a");
	assert.ok(path);
	assert.ok(path.startsWith(logDirectory));
	assert.deepEqual(terminal, [{ method: "warn", text: `atomic-workflows: run run-a console output is in ${path}` }]);
	const lines = readFileSync(path, "utf8").trimEnd().split("\n");
	assert.equal(lines.length, 41);
	assert.match(lines[0] ?? "", / error dispatcher: save-1 failed$/);
	assert.match(lines[40] ?? "", / log still going$/);
});

test("cancellations from quitting a run are logged but never reach the chat", async () => {
	const run = open("run-quit");
	const pending = [1, 2, 3].map((index) =>
		run.run(() =>
			Promise.reject(quitAbort("run-quit")).catch((error) => console.error(`step-${index} failed:`, error)),
		),
	);
	await Promise.all(pending);
	await flushWorkflowConsoleOutput();

	assert.deepEqual(terminal, []);
	const path = workflowConsoleLogPath("run-quit");
	assert.ok(path);
	assert.equal(readFileSync(path, "utf8").match(/suspended by workflow quit/g)?.length, 3);
});

test("a nested run writes to its root run's log", async () => {
	open("root-run");
	const child = open("child-run", "root-run");
	child.run(() => console.warn("from the child"));
	await flushWorkflowConsoleOutput();

	assert.equal(workflowConsoleLogPath("child-run"), undefined);
	assert.match(readFileSync(workflowConsoleLogPath("root-run") ?? "", "utf8"), / warn from the child$/m);
});

test("console output outside any run, or with routing off, still reaches the terminal", () => {
	console.error("host message");
	stopRoutingWorkflowConsoleOutput();
	open("run-off").run(() => console.error("run message while routing is off"));

	assert.deepEqual(terminal, [
		{ method: "error", text: "host message" },
		{ method: "error", text: "run message while routing is off" },
	]);
});
