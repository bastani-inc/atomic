/**
 * `/workflow pause <run> <stage>` and `/workflow resume <run> <stage>` act on that stage only,
 * for a stage in this process and for one on a local worker (#3996).
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { currentWorkflowStore } from "../../packages/workflows/src/shared/store-factory.js";
import { registerPooledStageSource } from "../../packages/workflows/src/workers/pooled-stage-sources.js";
import { testRunId } from "../helpers/run-id.js";
import { buildCtx, installSlashDispatchTestHooks, registerWorkflowCommand } from "./slash-dispatch-utils.js";

installSlashDispatchTestHooks();

/** A stage handle that records the controls it received and reflects them in its status. */
function controlledStage(runId: string, stageId: string, calls: string[]): StageControlHandle {
	let status: StageControlHandle["status"] = "running";
	return {
		runId,
		stageId,
		stageName: stageId,
		get status() {
			return status;
		},
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: true,
		messages: [],
		async ensureAttached() {},
		async prompt() {},
		async steer() {},
		async followUp() {},
		async pause() {
			calls.push(`pause ${stageId}`);
			status = "paused";
		},
		async resume() {
			calls.push(`resume ${stageId}`);
			status = "running";
			return undefined;
		},
		subscribe: () => () => {},
	};
}

describe("/workflow pause and resume with a stage", () => {
	test.sequential("pause <run> <stage> pauses only that stage and resume <run> <stage> resumes it (#3996)", async () => {
		const store = currentWorkflowStore();
		const runId = testRunId(`slash-stage-pause-${Date.now()}`);
		store.recordRunStart({
			id: runId,
			name: "fan-out",
			inputs: {},
			status: "running",
			toolNodes: [],
			startedAt: Date.now(),
			stages: ["work-1", "work-4"].map((name) => ({
				id: name,
				name,
				status: "running" as const,
				parentIds: [],
				toolEvents: [],
			})),
		});
		// Pooled: no handle in this process; the pool's live view reaches the worker.
		store.recordStageStart(runId, {
			id: "work-pooled",
			name: "work-pooled",
			status: "running",
			parentIds: [],
			toolEvents: [],
			workerExecution: { worker: "worker-1", generation: 1, renewedAt: 1, expiresAt: 2 },
		});
		const calls: string[] = [];
		const unregisterLocal = ["work-1", "work-4"].map((stageId) =>
			stageControlRegistry.register(controlledStage(runId, stageId, calls)),
		);
		const pooled = controlledStage(runId, "work-pooled", calls);
		const unregisterPool = registerPooledStageSource(store, {
			async acquire(_runId, stageId) {
				return stageId === "work-pooled" ? { handle: pooled, release() {} } : undefined;
			},
		});
		try {
			const { workflowCmd } = await registerWorkflowCommand();
			const stageStatus = (stageId: string) =>
				store
					.runs()
					.find((run) => run.id === runId)
					?.stages.find((stage) => stage.id === stageId)?.status;

			const { ctx, messages } = buildCtx();
			await workflowCmd.options.handler(`pause ${runId} work-4 -y`, ctx);
			assert.deepEqual(calls, ["pause work-4"], messages.join("\n"));
			assert.equal(stageStatus("work-4"), "paused");
			assert.equal(stageStatus("work-1"), "running");

			await workflowCmd.options.handler(`resume ${runId} work-4`, ctx);
			assert.deepEqual(calls, ["pause work-4", "resume work-4"], messages.join("\n"));
			assert.equal(stageStatus("work-4"), "running");

			await workflowCmd.options.handler(`pause ${runId} work-pooled -y`, ctx);
			assert.deepEqual(calls.slice(2), ["pause work-pooled"], messages.join("\n"));
			assert.equal(stageStatus("work-1"), "running");
			await workflowCmd.options.handler(`resume ${runId} work-pooled`, ctx);
			assert.deepEqual(calls.slice(2), ["pause work-pooled", "resume work-pooled"], messages.join("\n"));
		} finally {
			for (const unregister of unregisterLocal) unregister();
			unregisterPool();
			store.removeRun(runId);
		}
	});
});
