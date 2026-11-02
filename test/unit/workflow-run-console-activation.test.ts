import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	stopRoutingWorkflowConsoleOutput,
	workflowConsoleLogPath,
} from "../../packages/workflows/src/engine/run-console.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { NON_INTERACTIVE_WORKFLOW_POLICY } from "../../packages/workflows/src/shared/types.js";

const agentDir = mkdtempSync(join(tmpdir(), "atomic-run-console-activation-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
const terminal: string[] = [];
const saved = { warn: console.warn, error: console.error };
console.warn = (...args: unknown[]) => terminal.push(args.map(String).join(" "));
console.error = (...args: unknown[]) => terminal.push(args.map(String).join(" "));
const { default: factory } = await import("../../packages/workflows/src/extension/index.js");
type Handler = (event: object, ctx: object) => unknown;
const logs = join(agentDir, "workflow-logs");

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

const child = workflow({
	name: "chatty-child",
	description: "",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await ctx.tool("child-step", {}, async () => {
			console.error("from a child workflow");
			return 1;
		});
		return {};
	},
});

const chatty = workflow({
	name: "chatty",
	description: "",
	inputs: {},
	outputs: {},
	async run(ctx) {
		console.error("from the workflow body");
		await ctx.tool("step", {}, async () => {
			console.error("from a durable step");
			return 1;
		});
		await ctx.workflow(child, { inputs: {} });
		return {};
	},
});

/** Launches `chatty` the way the workflow tool and `/workflow` do: through an extension runtime's dispatch. */
async function dispatchChatty(routeConsoleToLog: boolean): Promise<string> {
	const runtime = createExtensionRuntime({
		definitions: [chatty],
		store: createStore(),
		cwd: agentDir,
		...(routeConsoleToLog ? { routeConsoleToLog } : {}),
	});
	const result = await runtime.dispatch(
		{ workflow: "chatty", inputs: {}, action: "run" },
		{ policy: NON_INTERACTIVE_WORKFLOW_POLICY },
	);
	assert.ok(result.action === "run" && "runId" in result && result.status === "completed", JSON.stringify(result));
	return result.runId;
}

test("an RPC host with dialog UI does not turn routing on", async () => {
	await startSession("rpc");
	terminal.length = 0;
	await dispatchChatty(true);

	assert.deepEqual(terminal, ["from the workflow body", "from a durable step", "from a child workflow"]);
	assert.equal(existsSync(logs), false);
});

test("under a terminal UI, a dispatched run its owner routes logs to the workflow log, child included, and a headless owner's run does not", async () => {
	await startSession("tui");
	terminal.length = 0;
	const routed = await dispatchChatty(true);
	await dispatchChatty(false);

	const path = workflowConsoleLogPath();
	assert.ok(path);
	assert.ok(path.startsWith(logs));
	assert.deepEqual(terminal, [
		`atomic-workflows: run ${routed} console output is in ${path}`,
		"from the workflow body",
		"from a durable step",
		"from a child workflow",
	]);
	const lines = readFileSync(path, "utf8").trimEnd().split("\n");
	assert.deepEqual(
		lines.map((line) => line.slice(line.indexOf(" ") + 1)),
		[
			`${routed} error from the workflow body`,
			`${routed} error from a durable step`,
			`${routed} error from a child workflow`,
		],
	);
});
