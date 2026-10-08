import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	type HostInput,
	type HostInputOptions,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { shutdownDbos } from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import { initializeDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { bindWorkflowHumanInput } from "../../packages/workflows/src/extension/workflow-human-input.js";
import { loadWorkflowModule } from "../../packages/workflows/src/extension/workflow-module-loader.js";
import { workflowQuitAction } from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { attachedCliPresentation, forwardCliDialogs } from "../integration/fixtures/sdk-host-cli.js";
const DURABLE_PHASE_TIMEOUT_MS = 30_000;

const definition = loadWorkflowModule(fileURLToPath(new URL("./sdk-host-durable-workflow.ts", import.meta.url)))
	.default as WorkflowDefinition;
const home = process.env.ATOMIC_FAULT_TEST_HOME!;
assert.ok(home);
const backend = await initializeDurableBackend();
assert.equal(backend.persistent, true, "must use actual on-disk durability");
const runtime = createExtensionRuntime({ definitions: [definition], store });
const hash = createHash("sha256")
	.update(readFileSync(new URL("./sdk-host-durable-workflow.ts", import.meta.url)))
	.digest("hex");
const requests: HostInputOptions[] = [];
const late = Promise.withResolvers<boolean>();
const presentation = attachedCliPresentation(
	"  durable text  ",
	process.env.HANDOFF_PHASE === "start" ? "late" : "true",
);
const options = {
	cwd: home,
	agentDir: join(home, "agent"),
	settingsManager: SettingsManager.inMemory(),
	builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
};
const { session: cli } = await createAgentSession({
	...options,
	sessionManager: SessionManager.inMemory(home),
	extensionBindings: { uiContext: presentation.uiContext },
});
const cliInput = forwardCliDialogs(cli.extensionRunner!.createContext().ui);
const humanInput: HostInput = {
	...cliInput,
	input: async (...args) => {
		requests.push(args[2]);
		return process.env.HANDOFF_HOST === "cli" ? cliInput.input(...args) : "  durable text  ";
	},
	confirm: async (...args) => {
		requests.push(args[2]);
		if (process.env.HANDOFF_HOST === "cli") return cliInput.confirm(...args);
		return process.env.HANDOFF_PHASE === "start" ? late.promise : true;
	},
};
const { session } = await createAgentSession({
	...options,
	sessionManager: SessionManager.inMemory(home),
	extensionBindings: { humanInput: process.env.HANDOFF_PHASE === "start" ? humanInput : null },
});
const context = session.extensionRunner!.createContext();
// Narrow unused terminal-only methods; retain the actual runner UI object and its private scope symbol.
const ui: Pick<typeof context.ui, "input" | "confirm" | "select" | "editor"> = context.ui;
const unbind = bindWorkflowHumanInput(store, {
	get hasUI() {
		return context.hasUI;
	},
	get hasHumanInput() {
		return context.hasHumanInput;
	},
	ui,
});
async function until(predicate: () => boolean) {
	const deadline = Date.now() + DURABLE_PHASE_TIMEOUT_MS;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, JSON.stringify(store.runs()));
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
	const { id, command, sql } = JSON.parse(line);
	try {
		let result: unknown;
		if (command === "start") {
			const { runId } = runDetached(definition, {}, { store, usePromptNodesForUi: true });
			await until(() => requests.length === 2);
			await until(() => process.env.HANDOFF_HOST !== "cli" || presentation.dialogs.length === 2);
			const pending = store
				.runs()
				.find((run) => run.id === runId)!
				.stages.find((stage) => stage.pendingPrompt)!.pendingPrompt;
			assert.equal(pending!.kind, "confirm");
			await backend.flush?.(runId);
			await session.bindExtensions({ humanInput: null });
			assert.equal(requests[1]!.signal.aborted, true);
			presentation.lateTrue();
			late.resolve(true);
			const paused = await workflowQuitAction({ action: "quit", runId });
			assert.ok("status" in paused && paused.status === "paused", JSON.stringify(paused));
			await backend.flush?.(runId);
			result = { runId, hash, pending, requestId: requests[1]!.requestId, dialogs: presentation.dialogs };
		} else if (command === "resume") {
			assert.equal(store.runs().length, 0, "new process has no live run");
			await backend.hydrateWorkflow?.(sql);
			const checkpoints = backend.listCheckpoints(sql);
			assert.ok(checkpoints.length > 0, "new backend reads disk checkpoints");
			assert.equal(backend.getWorkflow(sql)?.pendingPrompts, 1);
			const checkpoint = checkpoints.find(
				(checkpoint) =>
					checkpoint.kind === "stage" &&
					checkpoint.name === "confirm" &&
					checkpoint.topology?.status !== "completed",
			);
			assert.ok(checkpoint?.kind === "stage", "persisted unresolved prompt topology");
			const resumed = await runtime.resumeDurableWorkflow(sql);
			assert.ok(resumed.ok, resumed.message);
			await until(() =>
				store
					.runs()
					.some((run) => run.id === sql && run.stages.some((stage) => stage.pendingPrompt?.kind === "confirm")),
			);
			const stage = store
				.runs()
				.find((run) => run.id === sql)!
				.stages.find((stage) => stage.pendingPrompt?.kind === "confirm")!;
			const pending = stage.pendingPrompt;
			assert.equal(stage.id, checkpoint.topology?.stageId, "restored durable prompt identity");
			assert.equal(requests.length, 0, "missing host cannot consume restored pending descriptor");
			await session.bindExtensions({ humanInput });
			await until(() => store.runs().some((run) => run.id === sql && run.status === "completed"));
			assert.equal(requests.length, 1, "completed input must not be asked again");
			assert.equal(requests[0]!.workflowRunId, sql);
			await backend.flush?.(sql);
			assert.deepEqual(store.runs().find((run) => run.id === sql)?.result, { text: "  durable text  ", approved: true });
			result = { runId: sql, hash, pending, requestId: requests[0]!.requestId, dialogs: presentation.dialogs };
		} else if (command === "exit") {
			unbind();
			await session.dispose();
			await cli.dispose();
			await shutdownDbos();
			console.log(JSON.stringify({ id, result: {} }));
			lines.close();
			break;
		} else throw new Error(command);
		console.log(JSON.stringify({ id, result }));
	} catch (error) {
		console.log(JSON.stringify({ id, error: error instanceof Error ? error.stack : String(error) }));
	}
}
