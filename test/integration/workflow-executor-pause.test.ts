import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { isDurableWorkflowResumable } from "../../packages/workflows/src/durable/resume-eligibility.js";
import { toolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import {
	workflowInterruptAction,
	workflowPauseAction,
	workflowResumeAction,
} from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { INTERACTIVE_WORKFLOW_POLICY } from "../../packages/workflows/src/shared/types.js";
import { createMockSdk } from "../unit/durable-dbos-backend-helpers.js";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => {
	store.clear();
	setDurableBackend(undefined);
});

// PR #2885: the public resume surface must adopt a paused live owner, even before registration.
for (const action of ["pause", "interrupt"] as const) {
	for (const phase of ["before-turn", "admission", "completion"] as const) {
		test(`${action}/${phase}: public resume preserves the owner and DBOS pause durability`, async () => {
			const sdk = createMockSdk();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let bodyReturned = false;
			let blocked = false;
			class DelayedFlush extends DbosDurableBackend {
				override async flush(runId?: string): Promise<void> {
					await super.flush(runId);
					if (!blocked && (phase === "admission" || (phase === "completion" && bodyReturned))) {
						blocked = true;
						entered.resolve();
						await release.promise;
					}
				}
			}
			const backend = new DelayedFlush(sdk);
			setDurableBackend(backend);
			let bodyCalls = 0;
			let effects = 0;
			const definition = workflow({
				name: "durable-live-pause",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					bodyCalls++;
					await ctx.tool("once", {}, async () => {
						effects++;
						return "done";
					});
					bodyReturned = true;
					return {};
				},
			});
			const runtime = createExtensionRuntime({ definitions: [definition], store });
			const { runId } = runDetached(definition, {}, { store });
			const job = jobTracker.get(runId)!;
			const owner = toolControlRegistry.runControl(runId);
			try {
				if (phase !== "before-turn") await entered.promise;
				const paused = await (action === "pause" ? workflowPauseAction : workflowInterruptAction)({
					action,
					runId,
				});
				assert.ok(paused.action === "pause" || paused.action === "interrupt");
				assert.equal(paused.status, "paused");
				assert.doesNotMatch(paused.message, /quit|cannot be resumed/);
				release.resolve();
				await turn();
				assert.equal(store.runs()[0]?.status, "paused");
				assert.equal(store.runs()[0]?.exitReason, undefined);
				assert.equal(store.runs()[0]?.resumable, true);
				assert.equal(store.runs()[0]?.endedAt, undefined);
				assert.equal(jobTracker.get(runId), job);
				assert.equal(toolControlRegistry.runControl(runId), owner);
				assert.equal(effects, phase === "completion" ? 1 : 0);
				if (phase !== "before-turn") {
					const hydrated = new DbosDurableBackend(sdk);
					await hydrated.hydrateWorkflow(runId);
					assert.equal(hydrated.getWorkflow(runId)?.status, "paused");
					assert.equal(isDurableWorkflowResumable(hydrated.getWorkflow(runId)!), phase === "completion");
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
				assert.equal(resumed.status, "ok", resumed.message);
				await job.promise;
				assert.equal(bodyCalls, 1);
				assert.equal(effects, 1);
				assert.equal(store.runs()[0]?.status, "completed");
				const hydrated = new DbosDurableBackend(sdk);
				await hydrated.hydrateWorkflow(runId);
				assert.equal(hydrated.getWorkflow(runId)?.status, "completed");
				assert.equal(
					sdk.state.starts.filter((start) => start.workflowId === runId).length,
					1,
					"live resume must not launch a new root",
				);
			} finally {
				release.resolve();
				job.controller.abort();
				await job.promise;
			}
		});
	}
}

// PR #2885: all live descendant barriers precede the root's async durability acknowledgement.
test("already-live children stay held through DBOS pause and failed resume persistence", async () => {
	const sdk = createMockSdk();
	const pauseFlushing = Promise.withResolvers<void>();
	const releasePause = Promise.withResolvers<void>();
	const resumeFlushing = Promise.withResolvers<void>();
	const releaseResume = Promise.withResolvers<void>();
	let phase: "pause" | "resume" | undefined;
	class DelayedControlFlush extends DbosDurableBackend {
		override async flush(runId?: string): Promise<void> {
			if (phase === "pause") {
				phase = undefined;
				pauseFlushing.resolve();
				await releasePause.promise;
			} else if (phase === "resume") {
				phase = undefined;
				resumeFlushing.resolve();
				await releaseResume.promise;
				throw new Error("resume flush unavailable");
			}
			await super.flush(runId);
		}
	}
	const backend = new DelayedControlFlush(sdk);
	setDurableBackend(backend);
	const entered = Promise.withResolvers<string>();
	const body = Promise.withResolvers<void>();
	let effects = 0;
	const child = workflow({
		name: "dbos-already-live-child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			entered.resolve(ctx.runId);
			await body.promise;
			await ctx.tool("after-pause", {}, async () => {
				effects++;
				return "done";
			});
			return {};
		},
	});
	const definition = workflow({
		name: "dbos-parent-of-live-child",
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
	const rootOwner = toolControlRegistry.runControl(runId);
	const childOwner = toolControlRegistry.runControl(childId);
	try {
		phase = "pause";
		const pausing = pauseRun(runId);
		await pauseFlushing.promise;
		body.resolve();
		await turn();
		assert.equal(effects, 0);
		assert.equal(rootOwner?.paused, true);
		assert.equal(childOwner?.paused, true);
		releasePause.resolve();
		assert.equal((await pausing).ok, true);
		const hydrated = new DbosDurableBackend(sdk);
		await hydrated.hydrateWorkflow(runId);
		assert.equal(hydrated.getWorkflow(runId)?.status, "paused");
		phase = "resume";
		const resuming = resumeRun(runId);
		const rejected = assert.rejects(resuming, /resume flush unavailable/);
		await resumeFlushing.promise;
		await turn();
		assert.equal(effects, 0);
		assert.equal(childOwner?.paused, true);
		releaseResume.resolve();
		await rejected;
		assert.equal(rootOwner?.paused, true);
		assert.equal(childOwner?.paused, true);
		assert.equal(toolControlRegistry.runControl(childId), childOwner);
		assert.equal((await resumeRun(runId)).ok, true);
		await job.promise;
		assert.equal(effects, 1);
		assert.ok(store.runs().every((candidate) => candidate.status === "completed"));
		const completed = new DbosDurableBackend(sdk);
		await completed.hydrateWorkflow(runId);
		assert.equal(completed.getWorkflow(runId)?.status, "completed");
		assert.equal(sdk.state.starts.filter((start) => start.workflowId === runId).length, 1);
	} finally {
		releasePause.resolve();
		releaseResume.resolve();
		body.resolve();
		job.controller.abort();
		await job.promise;
	}
});
