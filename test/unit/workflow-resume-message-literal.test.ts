import { createSyntheticSourceInfo, type PromptTemplate } from "@bastani/atomic";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { createHarness, getUserTexts } from "../../packages/coding-agent/test/suite/harness.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { assert, createStageControlRegistry, createStore, deferred, run, test, workflow } from "./executor-shared.js";

const reviewTemplate: PromptTemplate = {
	name: "review",
	description: "Review template",
	content: "Review this code: $1",
	filePath: "/virtual/review.md",
	sourceInfo: createSyntheticSourceInfo("/virtual/review.md", {
		source: "local",
		scope: "temporary",
		origin: "top-level",
	}),
};

// An idle stage-chat resume already delivers its message literally; a stage paused in the
// middle of its workflow prompt must read the same message the same way.
test("a resume message replacing a paused stage prompt is delivered literally", async () => {
	const harness = await createHarness({
		resourceLoader: {
			...createTestResourceLoader(),
			getPrompts: () => ({ prompts: [reviewTemplate], diagnostics: [] }),
		},
	});
	try {
		const providerStarted = deferred();
		harness.setResponses([
			async (_context, options) => {
				providerStarted.resolve();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("interrupted");
			},
			fauxAssistantMessage("resume message read"),
		]);
		const registry = createStageControlRegistry();
		const store = createStore();
		const sawStage = deferred<{ runId: string; stageId: string }>();
		const definition = workflow({
			name: "resume-message-literal",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("paused-stage").prompt("start workflow stage");
				return {};
			},
		});
		const runPromise = run(
			definition,
			{},
			{
				adapters: {
					agentSession: {
						async create() {
							return harness.session as StageSessionRuntime;
						},
					},
				},
				store,
				stageControlRegistry: registry,
				onStageStart: (runId, stage) => {
					if (stage.name === "paused-stage") sawStage.resolve({ runId, stageId: stage.id });
				},
			},
		);
		const [{ runId, stageId }] = await Promise.all([sawStage.promise, providerStarted.promise]);
		const handle = registry.get(runId, stageId);
		assert.ok(handle, "live stage handle should exist");
		await handle.pause();
		assert.equal(handle.status, "paused");

		await handle.resume("/review src/index.ts");
		const result = await runPromise;

		assert.equal(result.status, "completed");
		const texts = getUserTexts(harness);
		assert.ok(texts.includes("/review src/index.ts"), JSON.stringify(texts));
		assert.deepEqual(
			texts.filter((text) => text.startsWith("Review this code")),
			[],
		);
	} finally {
		await harness.cleanup();
	}
});
