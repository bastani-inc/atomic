import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import { createHistoryRouter } from "../../packages/coding-agent/src/core/tools/history-protocol.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { PiEventContext } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createSessionRunControl } from "../../packages/workflows/src/extension/workflow-session-run-control.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const SESSION_ID = "history-session";

function context(): PiEventContext {
	return {
		sessionManager: { getSessionId: () => SESSION_ID },
		cwd: process.cwd(),
		ui: { notify: () => undefined },
		hasUI: false,
	};
}

beforeEach(() => {
	store.clear();
	setDurableBackend(undefined);
});
afterEach(() => {
	store.clear();
	setDurableBackend(undefined);
});

test("history://workflows reads the workflow store's durable runs for this project only (#4252)", async () => {
	const backend = await createMemoryTestBackend();
	setDurableBackend(backend);
	const definition = workflow({
		name: "history-demo",
		description: "",
		inputs: {},
		outputs: {},
		run: async () => ({}),
	});
	const execute = makeExecuteWorkflowTool(
		createExtensionRuntime({ definitions: [definition], store }),
		() => undefined,
		() => undefined,
	);
	const control = createSessionRunControl({
		execute,
		context,
		store,
		catalog: () => backend.prepareWorkflowCatalog(),
	});
	const here = testRunId("history-here");
	const userStarted = testRunId("history-user-started");
	const elsewhere = testRunId("history-elsewhere");
	const userElsewhere = testRunId("history-user-elsewhere");
	const child = testRunId("history-child");
	for (const [workflowId, invocationCwd, objective, owner, root] of [
		[here, process.cwd(), "Migrate the billing tables", SESSION_ID, undefined],
		[userStarted, process.cwd(), "Rotate the signing keys", undefined, undefined],
		[elsewhere, `${process.cwd()}/foreign`, "Foreign project secret", SESSION_ID, undefined],
		[userElsewhere, `${process.cwd()}/foreign`, "Foreign user-started secret", undefined, undefined],
		[child, process.cwd(), "Nested step of billing", SESSION_ID, here],
	] as const) {
		await backend.commitWorkflowRegistration({
			workflowId,
			name: "history-demo",
			inputs: { objective },
			createdAt: 1_700_000_000_000,
			status: "completed",
			completedCheckpoints: 1,
			label: objective,
			summary: `Summary of ${objective}`,
			invocationCwd,
			...(owner === undefined ? {} : { modelOwner: owner }),
			...(root === undefined ? {} : { rootWorkflowId: root }),
		});
	}
	const quiet = testRunId("history-zero-checkpoints");
	const cancelled = testRunId("history-cancelled");
	for (const [workflowId, status, objective] of [
		[quiet, "completed", "Quiet run without checkpoints"],
		[cancelled, "cancelled", "Cancelled before any step"],
	] as const) {
		await backend.commitWorkflowRegistration({
			workflowId,
			name: "history-demo",
			inputs: { objective },
			createdAt: 1_700_000_000_001,
			status,
			completedCheckpoints: 0,
			label: objective,
			invocationCwd: process.cwd(),
			modelOwner: SESSION_ID,
		});
	}
	const router = createHistoryRouter({
		cwd: process.cwd(),
		sessionStore: () => undefined,
		workflows: () => control,
	});

	const listing = String(await router.read?.("history://workflows"));
	assert.match(listing, new RegExp(`history://workflows/${here} \\| .* \\| completed \\| history-demo`));
	assert.doesNotMatch(listing, new RegExp(elsewhere));
	assert.match(listing, new RegExp(`history://workflows/${userStarted} `));
	assert.doesNotMatch(listing, new RegExp(`${userElsewhere}|${child}`));
	assert.deepEqual(
		(await control.listRuns({ includeDurable: true })).map((run) => run.runId),
		[here],
		"listRuns keeps its model-owner scope",
	);
	for (const id of [quiet, cancelled]) {
		assert.match(listing, new RegExp(`history://workflows/${id} `), "a run with no checkpoints is listed");
		assert.match(String(await router.read?.(`history://workflows/${id}`)), /name: history-demo/);
	}

	const detail = String(await router.read?.(`history://workflows/${here}`));
	assert.match(detail, /name: history-demo/);
	assert.match(detail, /Migrate the billing tables/);
	const userDetail = String(await router.read?.(`history://workflows/${userStarted}`));
	assert.match(userDetail, /Rotate the signing keys/);
	assert.match(
		String(await router.read?.(`history://workflows/${userStarted.slice(0, 12)}`)),
		/Rotate the signing keys/,
	);

	const found = String(
		await router.search?.("history://workflows", {
			pattern: "billing",
			ignoreCase: false,
			literal: false,
			contextBefore: 0,
			contextAfter: 0,
		}),
	);
	assert.match(found, new RegExp(`history://workflows/${here}:\\d+:`));
	assert.doesNotMatch(found, /Foreign project secret/);
	const foundUser = String(
		await router.search?.("history://workflows", {
			pattern: "signing keys",
			ignoreCase: false,
			literal: false,
			contextBefore: 0,
			contextAfter: 0,
		}),
	);
	assert.match(foundUser, new RegExp(`history://workflows/${userStarted}:\\d+:`));

	for (const hidden of [elsewhere, userElsewhere, child])
		await assert.rejects(
			async () => router.read?.(`history://workflows/${hidden}`),
			/not found in this project's history/,
		);
});
