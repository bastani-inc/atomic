import assert from "node:assert/strict";
import { type AgentSession, SessionManager } from "@bastani/atomic";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

interface StageFixture {
	readonly result: Awaited<ReturnType<typeof run>>;
	readonly stage: Harness;
	readonly toolResults: readonly { readonly isError: boolean; readonly text: string }[];
	readonly status: string | undefined;
}

/**
 * Runs one workflow stage on a real session whose creation is held at a gate after the stage's
 * session id is recorded, as a pool worker's adapter does (#3996). The stage makes one bash call.
 */
async function runStage(
	duringStartup: (handle: NonNullable<ReturnType<ReturnType<typeof createStageControlRegistry>["get"]>>) => void,
	duringTurn: (stage: Harness) => void = () => {},
): Promise<StageFixture> {
	const store = createStore();
	const registry = createStageControlRegistry();
	const sessionManager = SessionManager.inMemory();
	const gate = Promise.withResolvers<void>();
	const creating = Promise.withResolvers<{ runId: string; stageId: string }>();
	let stage: Harness | undefined;
	const definition = workflow({
		name: "stage-generation-during-startup",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("work").prompt("Run the round.");
			return {};
		},
	});
	const running = run(
		definition,
		{},
		{
			durableBackend: await createMemoryTestBackend(),
			store,
			stageControlRegistry: registry,
			adapters: {
				agentSession: {
					async create(options, meta) {
						assert.ok(meta);
						store.recordStageSession(meta.runId, meta.stageId, { sessionId: sessionManager.getSessionId() });
						creating.resolve({ runId: meta.runId, stageId: meta.stageId });
						await gate.promise;
						const harness = await createHarness({
							sessionManager,
							orchestrationContext: options.orchestrationContext,
							settings: { retry: { enabled: false } },
						});
						harness.setResponses([
							fauxAssistantMessage(fauxToolCall("bash", { command: "echo ROUND-MARKER" }), {
								stopReason: "toolUse",
							}),
							fauxAssistantMessage("Round done."),
							fauxAssistantMessage("Acknowledged."),
						]);
						harness.session.subscribe((event) => {
							if (event.type === "tool_execution_start") duringTurn(harness);
						});
						stage = harness;
						return harness.session as StageSessionRuntime;
					},
				},
			},
		},
	);
	const { runId, stageId } = await creating.promise;
	const handle = registry.get(runId, stageId);
	assert.ok(handle, "stage handle should be registered");
	duringStartup(handle);
	gate.resolve();
	const result = await running;
	assert.ok(stage);
	const toolResults = stage.session.messages.flatMap((message) =>
		message.role === "toolResult"
			? [
					{
						isError: message.isError,
						text: message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
					},
				]
			: [],
	);
	const status = store
		.runs()
		.find((candidate) => candidate.id === runId)
		?.stages.find((candidate) => candidate.id === stageId)?.status;
	await stage.cleanup();
	return { result, stage, toolResults, status };
}

test("a user message sent while the stage's session starts leaves the stage's tools working (#3996)", async () => {
	let sent: Promise<unknown> | undefined;
	const fixture = await runStage((handle) => {
		// Queued, so the stage's own prompt takes it into its turn, as the pooled stage did.
		sent = handle.steer("/workflow attach some-run work-0");
	});
	await sent;

	assert.equal(fixture.toolResults.length, 1);
	assert.equal(fixture.toolResults[0]!.isError, false, fixture.toolResults[0]!.text);
	assert.match(fixture.toolResults[0]!.text, /ROUND-MARKER/);
	assert.equal(fixture.result.status, "completed");
	assert.equal(fixture.status, "completed");
});

test("a stage whose generation closed before it finished fails instead of completing (#3996)", async () => {
	let closed = false;
	const fixture = await runStage(
		() => {},
		(stage) => {
			if (closed) return;
			closed = true;
			// Anything but the stage's own finish closing its generation: its tool calls are refused from here on.
			(stage.session as AgentSession & { sealWorkflowStageGeneration(): void }).sealWorkflowStageGeneration();
		},
	);

	assert.equal(fixture.toolResults[0]?.isError, true, "the stage's tool call was refused");
	assert.equal(fixture.status, "failed");
	assert.equal(fixture.result.status, "failed");
	assert.match(fixture.result.error ?? "", /generation closed before the stage finished/);
});
