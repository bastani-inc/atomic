import assert from "node:assert/strict";
import { test } from "vitest";
import { SessionConflictError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { GraphFrontierTracker } from "../../packages/workflows/src/engine/graph-inference.js";
import { createWorkflowBoundaryFactory } from "../../packages/workflows/src/runs/foreground/executor-child-boundary.js";
import { createContinuationReplayIndex } from "../../packages/workflows/src/runs/foreground/executor-continuation.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { classifyWorkflowFailure } from "../../packages/workflows/src/shared/workflow-failures.js";

for (const rejected of [false, true]) {
	test(`concurrent child finalizers await the terminal commit (rejected=${rejected})`, async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const store = createStore();
		const run = {
			id: "run",
			name: "parent",
			inputs: {},
			status: "running" as const,
			toolNodes: [],
			stages: [],
			startedAt: 0,
		};
		store.recordRunStart(run);
		const failure = new SessionConflictError("session", 1, 2);
		const calls: string[] = [];
		const boundary = createWorkflowBoundaryFactory({
			runId: run.id,
			runSnapshot: run,
			activeStore: store,
			opts: {
				persistence: {
					async appendEntry(type) {
						calls.push(type);
						if (type === "workflow.stage.end") {
							entered.resolve();
							await release.promise;
							if (rejected) throw failure;
						}
					},
				},
			},
			tracker: new GraphFrontierTracker(),
			replayIndex: createContinuationReplayIndex(undefined, new Map()),
			registerWorkflowExitCleanup: () => () => {},
			workflowExitSkippedReason: () => "exit",
			classifyExecutorFailure: classifyWorkflowFailure,
		})("child", "child:1");
		const first = boundary.complete("done", {
			alias: "child",
			workflow: "child",
			runId: "child",
			status: "completed",
			outputs: {},
		});
		await entered.promise;
		let secondSettled = false;
		const second = boundary.skipForWorkflowExit().then(() => {
			secondSettled = true;
		});
		const outcomes = Promise.allSettled([first, second]);
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(secondSettled, false);
			assert.deepEqual(calls, ["workflow.stage.start", "workflow.stage.end"]);
		} finally {
			release.resolve();
		}
		for (const outcome of await outcomes) {
			if (rejected) {
				assert.equal(outcome.status, "rejected");
				if (outcome.status === "rejected") assert.equal(outcome.reason, failure);
			} else assert.equal(outcome.status, "fulfilled");
		}
	});
}
