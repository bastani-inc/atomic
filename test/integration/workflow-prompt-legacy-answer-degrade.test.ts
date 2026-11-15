import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { toolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { sleep } from "../helpers/runtime.js";
import { TEST_TIMEOUT_MS } from "../helpers/test-timeout.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { waitForExecutorStagePendingPrompt } from "../unit/executor-shared.js";

afterEach(() => setDurableBackend(undefined));

test(
	"a journal holding a completed prompt without its answer, as the last step its run recorded, asks the prompt again once and completes (#4941)",
	async () => {
		let backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		const used: string[] = [];
		const definition = workflow({
			name: "prompt-legacy-answer-degrade",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const branch = await ctx.ui.input("which?");
				// The first run is quit while it waits here.
				await ctx.ui.input("hold");
				await ctx.tool("use", { branch }, async () => {
					used.push(branch);
					return branch;
				});
				return {};
			},
		});
		const initialStore = createStore();
		const runId = testRunId("prompt-legacy-answer-degrade");
		const original = run(
			definition,
			{},
			{ runId, store: initialStore, durableBackend: backend, usePromptNodesForUi: true },
		);
		const pending = await waitForExecutorStagePendingPrompt(initialStore);
		initialStore.resolveStagePendingPrompt(pending.runId, pending.stageId, pending.promptId, "lost-answer");
		const deadline = Date.now() + TEST_TIMEOUT_MS / 2;
		while (
			!initialStore.runs().some((entry) => entry.stages.some((stage) => stage.pendingPrompt?.message === "hold"))
		) {
			assert.ok(Date.now() < deadline, "the run asks its second prompt");
			await sleep(10);
		}
		await toolControlRegistry.runControl(runId)!.quit();
		const failed = await original;
		assert.equal(failed.status, "paused");

		// The journal as an attempt left it that ended right after it recorded the prompt completed, before this fix
		// recorded the answer with the completion: no UI answer, and nothing recorded after it.
		const legacy = await createMemoryTestBackend();
		await legacy.commitWorkflowRegistration(backend.getWorkflow(failed.runId)!);
		for (const checkpoint of backend.listCheckpoints(failed.runId)) {
			if (checkpoint.kind === "ui") continue;
			if (checkpoint.kind !== "stage") {
				await legacy.commitCheckpoint(checkpoint);
				continue;
			}
			const { promptAnswer, ...answerless } = checkpoint;
			await legacy.commitCheckpoint(answerless);
			if (promptAnswer !== undefined) break;
		}
		// Its owner went away with it, leaving it paused for another to resume.
		await legacy.commitWorkflowStatus(failed.runId, "paused", 0, true);
		assert.ok(
			legacy
				.listCheckpoints(failed.runId)
				.some(
					(checkpoint) =>
						checkpoint.kind === "stage" &&
						checkpoint.topology?.stageId === pending.stageId &&
						checkpoint.topology.status === "completed",
				),
			"the legacy journal holds the prompt completed",
		);
		backend = legacy;
		setDurableBackend(backend);

		const store = createStore();
		const runtime = createExtensionRuntime({ store, registry: createRegistry([definition]) });
		const resumed = await runtime.resumeDurableWorkflow(failed.runId);
		assert.ok(resumed.ok, resumed.message);
		let asked = 0;
		while (!store.runs().some((entry) => entry.id === failed.runId && entry.endedAt !== undefined)) {
			assert.ok(Date.now() < deadline, "the resumed run settles");
			for (const entry of store.runs())
				for (const stage of entry.stages)
					if (stage.pendingPrompt !== undefined) {
						if (stage.pendingPrompt.message === "which?") asked++;
						const answer = stage.pendingPrompt.message === "which?" ? "asked-again" : "held";
						store.resolveStagePendingPrompt(entry.id, stage.id, stage.pendingPrompt.id, answer);
					}
			await sleep(10);
		}
		const recovered = store.runs().find((entry) => entry.id === failed.runId)!;
		assert.equal(recovered.status, "completed", recovered.error);
		assert.equal(asked, 1, "the prompt whose answer was lost is asked again once");
		assert.deepEqual(used, ["asked-again"]);
	},
	TEST_TIMEOUT_MS,
);
