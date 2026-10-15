import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { StorageUnavailableError } from "../../packages/workflows/src/durable/journal/types.js";
import { toolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import {
	workflowPauseAction,
	workflowResumeAction,
} from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { INTERACTIVE_WORKFLOW_POLICY } from "../../packages/workflows/src/shared/types.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => {
	store.clear();
	setDurableBackend(undefined);
});

for (const phase of ["before-turn", "executing"] as const) {
	test(`pause/${phase}: public resume preserves the live owner and journal state (#2885)`, async () => {
		const backend = new JournalTestBackend();
		setDurableBackend(backend);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let bodyCalls = 0;
		let effects = 0;
		const definition = workflow({
			name: "durable-live-pause",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				bodyCalls++;
				entered.resolve();
				await release.promise;
				await ctx.tool("once", {}, async () => {
					effects++;
					return "done";
				});
				return {};
			},
		});
		const runtime = createExtensionRuntime({ definitions: [definition], store });
		const { runId } = runDetached(definition, {}, { store });
		const job = jobTracker.get(runId)!;
		const owner = toolControlRegistry.runControl(runId);
		try {
			if (phase === "executing") await entered.promise;
			const paused = await workflowPauseAction({ action: "pause", runId });
			assert.ok(paused.action === "pause");
			assert.equal(paused.status, "paused");
			release.resolve();
			await turn();
			assert.equal(store.runs()[0]?.status, "paused");
			assert.equal(store.runs()[0]?.endedAt, undefined);
			assert.equal(jobTracker.get(runId), job);
			assert.equal(toolControlRegistry.runControl(runId), owner);
			assert.equal(effects, 0);
			if (phase === "executing") {
				const reader = new JournalTestBackend(backend.databasePath);
				assert.equal(reader.getWorkflow(runId)?.status, "paused");
			}
			const resumed = await workflowResumeAction(
				{ action: "resume", runId },
				{
					getRuntime: () => runtime,
					policy: INTERACTIVE_WORKFLOW_POLICY,
					ensureWorkflowResourcesLoaded: async () => {},
				},
			);
			assert.ok(resumed.action === "resume");
			assert.equal(resumed.status, "ok");
			await job.promise;
			assert.equal(bodyCalls, 1);
			assert.equal(effects, 1);
			const reader = new JournalTestBackend(backend.databasePath);
			assert.equal(reader.getWorkflow(runId)?.status, "completed");
		} finally {
			release.resolve();
			job.controller.abort();
			await job.promise;
		}
	});
}

test("already-live children stay held after rejected journal resume persistence (#2885)", async () => {
	let failResume = false;
	const failure = new StorageUnavailableError("journal.sqlite", new Error("resume persistence failed"));
	class FailingResumeBackend extends JournalTestBackend {
		override async transitionWorkflowStatus(...args: Parameters<JournalTestBackend["transitionWorkflowStatus"]>) {
			if (failResume && args[2] === "running") throw failure;
			return super.transitionWorkflowStatus(...args);
		}
	}
	const backend = new FailingResumeBackend();
	setDurableBackend(backend);
	const entered = Promise.withResolvers<string>();
	const release = Promise.withResolvers<void>();
	let effects = 0;
	const child = workflow({
		name: "journal-live-child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			entered.resolve(ctx.runId);
			await release.promise;
			await ctx.tool("after-pause", {}, async () => {
				effects++;
				return "done";
			});
			return {};
		},
	});
	const definition = workflow({
		name: "journal-parent",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.workflow(child, {});
			return {};
		},
	});
	const { runId } = runDetached(definition, {}, { store });
	const job = jobTracker.get(runId)!;
	const childId = await entered.promise;
	const childOwner = toolControlRegistry.runControl(childId);
	try {
		assert.equal((await pauseRun(runId)).ok, true);
		release.resolve();
		await turn();
		assert.equal(effects, 0);
		failResume = true;
		await assert.rejects(resumeRun(runId), StorageUnavailableError);
		assert.equal(childOwner?.paused, true);
		assert.equal(effects, 0);
		failResume = false;
		assert.equal((await resumeRun(runId)).ok, true);
		await job.promise;
		assert.equal(effects, 1);
		assert.equal(new JournalTestBackend(backend.databasePath).getWorkflow(runId)?.status, "completed");
	} finally {
		release.resolve();
		job.controller.abort();
		await job.promise;
	}
});
