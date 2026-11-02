import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import {
	stopRoutingWorkflowConsoleOutput,
	workflowConsoleLogPath,
} from "../../packages/workflows/src/engine/run-console.js";
import { openRunRejectionScope } from "../../packages/workflows/src/engine/run-rejection-boundary.js";
import { store } from "../../packages/workflows/src/shared/store.js";

const agentDir = mkdtempSync(join(tmpdir(), "atomic-run-console-activation-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
const terminal: string[] = [];
const saved = { warn: console.warn, error: console.error };
console.warn = (...args: unknown[]) => terminal.push(args.map(String).join(" "));
console.error = (...args: unknown[]) => terminal.push(args.map(String).join(" "));
const { default: factory } = await import("../../packages/workflows/src/extension/index.js");
type Handler = (event: object, ctx: object) => unknown;

afterAll(() => {
	stopRoutingWorkflowConsoleOutput();
	store.clear();
	Object.assign(console, saved);
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

/** Starts a session of the workflows extension on a host in `mode`, running every `session_start` handler. */
async function startSession(mode: "tui" | "rpc"): Promise<void> {
	const handlers: Handler[] = [];
	factory({
		registerTool: () => undefined,
		registerCommand: () => undefined,
		registerMessageRenderer: () => undefined,
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		on: (event: string, handler: Handler) => {
			if (event === "session_start") handlers.push(handler);
		},
		disableAsyncDiscovery: true,
	} as never);
	for (const handler of handlers) {
		try {
			await handler({ reason: "startup" }, { mode, hasUI: true });
		} catch {}
	}
}

function startRun(runId: string): void {
	store.recordRunStart({
		id: runId,
		name: runId,
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 0,
	});
}

function logFromRun(runId: string, text: string): void {
	const scope = openRunRejectionScope({ runId, fail: () => {} });
	scope.run(() => console.error(text));
	scope.close();
}

test("an RPC host with dialog UI keeps its runs' console output on stderr", async () => {
	await startSession("rpc");
	startRun("rpc-run");
	terminal.length = 0;
	logFromRun("rpc-run", "from a run under an RPC host");

	assert.deepEqual(terminal, ["from a run under an RPC host"]);
	assert.equal(existsSync(join(agentDir, "workflow-logs")), false);
});

test("a terminal UI session routes its runs' console output to the workflow log, and only its runs'", async () => {
	await startSession("tui");
	startRun("tui-run");
	terminal.length = 0;
	logFromRun("tui-run", "from a run under a terminal UI");
	logFromRun("unowned-run", "from a run no session owns");

	const path = workflowConsoleLogPath();
	assert.ok(path?.startsWith(join(agentDir, "workflow-logs")));
	assert.deepEqual(terminal, [
		`atomic-workflows: run tui-run console output is in ${path}`,
		"from a run no session owns",
	]);
	assert.match(readFileSync(path, "utf8"), / tui-run error from a run under a terminal UI\n$/);
});
