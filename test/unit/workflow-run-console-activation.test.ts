import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { stopRoutingWorkflowConsoleOutput } from "../../packages/workflows/src/engine/run-console.js";
import { openRunRejectionScope } from "../../packages/workflows/src/engine/run-rejection-boundary.js";

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

function logFromRun(runId: string, text: string): void {
	const scope = openRunRejectionScope({ runId, fail: () => {} });
	scope.run(() => console.error(text));
	scope.close();
}

const logs = join(agentDir, "workflow-logs");

test("an RPC host with dialog UI keeps workflow console output on stderr", async () => {
	await startSession("rpc");
	terminal.length = 0;
	logFromRun("rpc-run", "from a run under an RPC host");

	assert.deepEqual(terminal, ["from a run under an RPC host"]);
	assert.equal(existsSync(join(logs, "rpc-run.log")), false);
});

test("a terminal UI session routes workflow console output to the run's log", async () => {
	await startSession("tui");
	terminal.length = 0;
	logFromRun("tui-run", "from a run under a terminal UI");

	assert.deepEqual(terminal, [`atomic-workflows: run tui-run console output is in ${join(logs, "tui-run.log")}`]);
	assert.deepEqual(readdirSync(logs), ["tui-run.log"]);
});
