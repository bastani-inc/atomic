/**
 * Text a pooled stage queues because it is busy keeps the semantics `sendUserMessage()` gives it
 * when idle (#4003): literal unless template expansion was requested, and never refused because it
 * looks like a registered slash command.
 */
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import type { PromptTemplate } from "../../packages/coding-agent/src/core/prompt-templates.js";
import { createSyntheticSourceInfo } from "../../packages/coding-agent/src/core/source-info.js";
import { createHarness, type Harness, type HarnessOptions } from "../../packages/coding-agent/test/suite/harness.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import { createStageControlHandle } from "../../packages/workflows/src/runs/foreground/executor-stage-control.js";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import {
	createStageContext,
	type InternalStageContext,
} from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { admitStageUserMessage } from "../../packages/workflows/src/workers/stage-watch.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

const REVIEW_TEMPLATE: PromptTemplate = {
	name: "review",
	description: "Review template",
	content: "TEMPLATE BODY: $1",
	filePath: "/virtual/review.md",
	sourceInfo: createSyntheticSourceInfo("/virtual/review.md", {
		source: "local",
		scope: "temporary",
		origin: "top-level",
	}),
};

/** A real stage whose real session is mid-turn: its tool call holds until the test releases it. */
async function busyStage(options: Pick<HarnessOptions, "resourceLoader" | "extensionFactories">): Promise<{
	readonly harness: Harness;
	readonly handle: StageControlHandle;
}> {
	const toolRelease = Promise.withResolvers<void>();
	const toolStarted = Promise.withResolvers<void>();
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			toolStarted.resolve();
			await toolRelease.promise;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const harness = await createHarness({ tools: [waitTool], ...options });
	harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);
	const ctx = createStageContext({
		stageId: "stage",
		stageName: "stage",
		runId: "run",
		adapters: { agentSession: { create: async () => harness.session } },
	}) as InternalStageContext;
	const turn = ctx.prompt("start").catch(() => undefined);
	await toolStarted.promise;
	const runtime = {
		runId: "run",
		stageId: "stage",
		name: "stage",
		stageSnapshot: { status: "running" },
		state: { liveHandleReleased: false, resumeContinuationPending: false },
		innerCtx: ctx,
		throwIfStageMutationBlocked() {},
		captureStageSessionMeta() {},
	};
	const handle = createStageControlHandle(runtime as never);
	cleanups.push(async () => {
		harness.session.clearQueue();
		toolRelease.resolve();
		await turn;
		await ctx.__dispose();
		await harness.cleanup();
	});
	return { harness, handle };
}

test.each(["steer", "followUp"] as const)(
	"a busy pooled stage queues a %s literally when template expansion is off (#4003)",
	async (intent) => {
		const { harness, handle } = await busyStage({
			resourceLoader: {
				...createTestResourceLoader(),
				getPrompts: () => ({ prompts: [REVIEW_TEMPLATE], diagnostics: [] }),
			},
		});
		const result = await admitStageUserMessage(handle, "/review src/app.ts", intent, false);
		assert.equal(result.action, intent);
		const queued = intent === "steer" ? harness.session.getSteeringMessages() : harness.session.getFollowUpMessages();
		assert.deepEqual(queued, ["/review src/app.ts"]);
	},
);

test("a busy pooled stage still expands a template when expansion was requested (#4003)", async () => {
	const { harness, handle } = await busyStage({
		resourceLoader: {
			...createTestResourceLoader(),
			getPrompts: () => ({ prompts: [REVIEW_TEMPLATE], diagnostics: [] }),
		},
	});
	await admitStageUserMessage(handle, "/review src/app.ts", "followUp", true);
	assert.deepEqual(harness.session.getFollowUpMessages(), ["TEMPLATE BODY: src/app.ts"]);
});

test.each(["steer", "followUp"] as const)(
	"a busy pooled stage queues a %s that looks like a registered command instead of refusing it (#4003)",
	async (intent) => {
		const { harness, handle } = await busyStage({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("workflow", { description: "Workflow command", handler: async () => {} });
				},
			],
		});
		const result = await admitStageUserMessage(handle, "/workflow attach", intent, undefined);
		assert.equal(result.action, intent);
		const queued = intent === "steer" ? harness.session.getSteeringMessages() : harness.session.getFollowUpMessages();
		assert.deepEqual(queued, ["/workflow attach"]);
	},
);
