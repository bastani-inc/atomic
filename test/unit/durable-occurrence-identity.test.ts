import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore, store as workflowStore } from "../../packages/workflows/src/shared/store.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { testRunId } from "../helpers/run-id.js";

/**
 * How long the run may take to reject the poisoned occurrence before the test stops it. A run that never rejects it
 * waits on its prompt forever, and stopping it ends it `killed`, not `failed`. The run's journal reads and lease
 * writes run on its connection's thread, so on a loaded host its start takes far longer than an idle one's; a passing
 * run ends as soon as it rejects the occurrence and never waits this long.
 */
const POISON_REJECTION_BOUND_MS = 10_000;

afterEach(() => {
	setDurableBackend(undefined);
	workflowStore.clear();
});

test("fresh journal active root rejects an occurrence bound to different replay keys before prompt replay", async () => {
	const rootId = testRunId("prompt-occurrence-active-poison");
	const writer = await JournalTestBackend.create();
	await writer.commitWorkflowRegistration({
		workflowId: rootId,
		name: rootId,
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	for (const [index, replayKey] of ["prompt:input:first", "prompt:input:SECOND-DIFFERENT"].entries()) {
		await writer.commitCheckpoint({
			kind: "stage",
			workflowId: rootId,
			checkpointId: `active-prompt-poison-${index}`,
			name: "input",
			replayKey,
			completedAt: 2 + index,
			startedAt: 1,
			endedAt: 2 + index,
			topology: {
				version: 1,
				stageId: "active-poison-stage",
				parentIds: [],
				sourceOrder: 0,
				occurrenceKey: "active-shared-occurrence",
				status: "completed",
				run: { runId: rootId, runName: rootId },
			},
		});
	}
	const backend = await writer.reopen();
	await backend.hydrateWorkflow(rootId);
	const store = createStore();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("poison was not rejected")), POISON_REJECTION_BOUND_MS);
	const root = workflow({
		name: rootId,
		description: "",
		inputs: {},
		outputs: { response: Type.String() },
		run: async (ctx) => ({ response: await ctx.ui.input("must never become pending") }),
	});
	try {
		const result = await run(
			root,
			{},
			{
				runId: rootId,
				store,
				durableBackend: backend,
				signal: controller.signal,
				usePromptNodesForUi: true,
			},
		);
		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", /prompt occurrence is bound to multiple replay keys/);
		assert.deepEqual(store.runs().find((snapshot) => snapshot.id === rootId)?.stages, []);
	} finally {
		clearTimeout(timeout);
	}
});
