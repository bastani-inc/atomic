import assert from "node:assert/strict";
import type { AgentSession } from "@bastani/atomic";
import { test } from "vitest";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

test("stage-scoped resume rebinds the live run to a fresh owner generation before releasing stages (#3621)", async () => {
	const runId = "stage-resume-after-fence-loss";
	const store = createStore();
	store.recordRunStart({ id: runId, name: "fence", inputs: {}, status: "running", stages: [], startedAt: 1 });
	store.recordStageStart(runId, { id: "first", name: "first", status: "running", parentIds: [], toolEvents: [] });
	store.recordStagePaused(runId, "first");
	const order: string[] = [];
	const toolControlRegistry = createToolControlRegistry();
	toolControlRegistry.registerRun(runId, {
		paused: false,
		pause: async () => {},
		resume: async () => {},
		quit: async () => {},
		recoverExecutionGeneration: async () => {
			order.push("recover");
		},
	});
	const stageControlRegistry = createStageControlRegistry();
	let status: "paused" | "running" = "paused";
	stageControlRegistry.register({
		runId,
		stageId: "first",
		stageName: "first",
		get status() {
			return status;
		},
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: false,
		messages: [] as AgentSession["messages"],
		async ensureAttached() {},
		async prompt() {},
		async steer() {},
		async followUp() {},
		async pause() {},
		async resume() {
			order.push("stage");
			status = "running";
			store.recordStageResumed(runId, "first");
		},
		subscribe: () => () => {},
	});

	const result = await resumeRun(runId, { store, stageControlRegistry, toolControlRegistry });

	assert.equal(result.ok, true);
	assert.deepEqual(order, ["recover", "stage"]);
});
