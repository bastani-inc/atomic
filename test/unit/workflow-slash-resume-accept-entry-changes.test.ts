import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { PiCommandContext } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { handleRunControlCommand } from "../../packages/workflows/src/extension/workflow-run-control-command.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const definition = workflow({
	name: "accept-entry-changes",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("finish", {}, async () => "done");
		return {};
	},
});

beforeEach(async () => {
	store.clear();
	setDurableBackend(await createMemoryTestBackend());
});

afterEach(() => {
	stageControlRegistry.clear();
	store.clear();
	setDurableBackend(undefined);
});

test.sequential.each([
	{ args: (runId: string) => [runId, "--accept-entry-changes"], accepted: true },
	{ args: (runId: string) => ["--accept-entry-changes", runId], accepted: true },
	{ args: (runId: string) => [runId], accepted: undefined },
])(
	"/workflow resume passes --accept-entry-changes to the durable resume, and never takes it for the run id (#4200) %#",
	async ({ args, accepted }) => {
		const runId = testRunId("accept-entry-changes");
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: definition.name,
			inputs: {},
			createdAt: 1,
			updatedAt: 1,
			status: "paused",
			completedCheckpoints: 1,
			invocationCwd: process.cwd(),
		});
		const runtime = createExtensionRuntime({ definitions: [definition], store });
		const resume = vi.spyOn(runtime, "resumeDurableWorkflow");
		const errors: string[] = [];
		const ctx: PiCommandContext = { hasUI: false, cwd: process.cwd(), ui: { notify: () => undefined } };
		await handleRunControlCommand(
			"resume",
			args(runId),
			ctx,
			{ info: () => undefined, error: (message) => errors.push(message) },
			{
				pi: {},
				overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
				runtimeForContext: () => runtime,
				ensureWorkflowResourcesLoaded: () => undefined,
			},
		);
		assert.deepEqual(errors, []);
		assert.equal(resume.mock.calls.length, 1);
		assert.equal(resume.mock.calls[0]![0], runId);
		assert.equal(resume.mock.calls[0]![1]?.acceptEntryChanges, accepted);
		await vi.waitFor(() => assert.equal(backend.getWorkflow(runId)?.status, "completed"));
	},
);
