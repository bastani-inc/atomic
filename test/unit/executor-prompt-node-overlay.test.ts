/**
 * Overlay-mode `ctx.ui.custom` prompt nodes.
 *
 * `buildPromptNodeUiAdapter` used to fail the prompt stage outright when a
 * workflow (or an in-stage `ask_user_question`, which always asks for one)
 * requested `overlay: true`. The attached stage chat mounts overlay requests on
 * its ordinary custom-UI slot, so the prompt node now brokers the request and
 * completes with the answer.
 *
 * cross-ref: packages/workflows/src/runs/foreground/executor-prompt-nodes.ts
 */

import { describe } from "vitest";
import {
	assert,
	createStore,
	resolveExecutorCustomPrompt,
	run,
	stageUiBroker,
	Type,
	test,
	waitForExecutorCustomPromptStage,
	workflow,
} from "./executor-shared.js";

describe("executor.run prompt nodes", () => {
	test("ctx.ui.custom with overlay: true brokers the prompt node instead of failing the stage", async () => {
		const st = createStore();
		const def = workflow({
			name: "custom-prompt-node-overlay-wf",
			description: "",
			inputs: {},
			outputs: {
				choice: Type.Optional(Type.Any()),
			},
			run: async (ctx) => {
				const choice = await ctx.ui.custom<string>(
					() => ({ render: () => ["GRAPH-OVERLAY-QUESTION"], invalidate: () => undefined }),
					{
						overlay: true,
						overlayOptions: { anchor: "bottom-center", width: "100%" },
						replayIdentity: "custom-prompt-node-overlay:v1",
						label: "Choose an option",
					},
				);
				return { choice };
			},
		});

		const runPromise = run(def, {}, { store: st, usePromptNodesForUi: true });
		const custom = await waitForExecutorCustomPromptStage(st);
		try {
			assert.equal(custom.stage.status, "awaiting_input");
			resolveExecutorCustomPrompt(custom.runId, custom.stage.id, "Alpha");

			const result = await runPromise;
			assert.equal(result.status, "completed");
			assert.equal(result.error, undefined);
			assert.equal(result.result?.choice, "Alpha");
			const completed = st
				.runs()
				.find((candidate) => candidate.id === custom.runId)!
				.stages.find((candidate) => candidate.id === custom.stage.id)!;
			assert.equal(completed.status, "completed");
			assert.equal(completed.error, undefined);
			assert.equal(st.getStagePromptAnswer(custom.runId, custom.stage.id)?.value, "Alpha");
		} finally {
			stageUiBroker.cancelStagePrompt(custom.runId, custom.stage.id, new Error("test cleanup"));
		}
	});
});
