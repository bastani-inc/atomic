import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { stageTimingFields } from "../../packages/workflows/src/shared/timing.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { sleep } from "../helpers/runtime.js";
import { TEST_TIMEOUT_MS } from "../helpers/test-timeout.js";
import { waitForExecutorStagePendingPrompt } from "../unit/executor-shared.js";

afterEach(() => setDurableBackend(undefined));

// #3038: prompt answers live in UI checkpoints, not in their completed stage metadata.
test.each(["valid", "missing-ui", "mismatched-ui"] as const)(
	"public durable prompt/tool recovery (%s)",
	async (mode) => {
		let backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const initialStore = createStore();
		let receipts = 0;
		let attempts = 0;
		const definition = workflow({
			name: "prompt-tool-resume",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				assert.equal(await ctx.ui.confirm("Keep original No"), false);
				await ctx.tool("receipt", {}, async () => ++receipts);
				await ctx.tool(
					"frontier",
					{},
					async () => {
						if (++attempts < 3) throw new Error("controlled frontier failure");
						return true;
					},
					{ retriesAllowed: false },
				);
				return {};
			},
		});
		const pendingRun = run(
			definition,
			{},
			{ store: initialStore, durableBackend: backend, usePromptNodesForUi: true },
		);
		const pending = await waitForExecutorStagePendingPrompt(initialStore);
		await sleep(5);
		initialStore.resolveStagePendingPrompt(pending.runId, pending.stageId, pending.promptId, false);
		const original = await pendingRun;
		assert.equal(original.status, "failed");
		const prompt = original.stages.find((stage) => stage.name === "confirm")!;
		assert.ok(prompt.durationMs! > 0);
		if (mode !== "valid") {
			const incomplete = new InMemoryDurableBackend();
			incomplete.registerWorkflow(backend.getWorkflow(original.runId)!);
			for (const checkpoint of backend.listCheckpoints(original.runId)) {
				if (checkpoint.kind !== "ui") incomplete.recordCheckpoint(checkpoint);
				else if (mode === "mismatched-ui")
					incomplete.recordCheckpoint({ ...checkpoint, promptHash: "different-prompt" });
			}
			backend = incomplete;
			setDurableBackend(backend);
		}
		for (let index = 0; index < 2; index++) {
			const store = createStore();
			const runtime = createExtensionRuntime({ store, registry: createRegistry([definition]) });
			const resumed = await runtime.resumeDurableWorkflow(original.runId);
			assert.ok(resumed.ok, resumed.message);
			const deadline = Date.now() + TEST_TIMEOUT_MS / 2;
			while (!store.runs().some((entry) => entry.id === original.runId && entry.endedAt !== undefined)) {
				assert.ok(Date.now() < deadline, "recovery must not reask a completed prompt");
				assert.ok(
					!store.runs().some((entry) => entry.stages.some((stage) => stage.pendingPrompt !== undefined)),
					"must not reask",
				);
				await sleep(10);
			}
			const recovered = store.runs().find((entry) => entry.id === original.runId)!;
			if (mode !== "valid") {
				assert.equal(recovered.status, "failed");
				assert.match(recovered.error ?? "", /insufficient_state: missing durable UI answer/);
				assert.equal(recovered.stages.length, 0, "reject before exposing a prompt node");
				assert.equal(receipts, 1, "no completed callback reruns");
				assert.equal(attempts, 1, "no frontier side effect without the original answer");
				return;
			}
			assert.equal(recovered.status, index === 0 ? "failed" : "completed", recovered.error);
			const replay = recovered.stages.find((stage) => stage.name === "confirm")!;
			assert.ok(replay, JSON.stringify(recovered));
			assert.equal(replay.id, prompt.id);
			assert.equal(replay.replayed, true);
			assert.deepEqual(stageTimingFields(replay), stageTimingFields(prompt));
			assert.equal(replay.pendingPrompt, undefined);
		}
		assert.equal(receipts, 1);
		assert.equal(attempts, 3);
	},
);
