/**
 * Pausing a root whose stages run on local workers. Those stages have no handle in the root's process, so the
 * root's run control is what pauses them, through the pool; the stages of the root's own process and its
 * running `ctx.tool` nodes must not hide them.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { pauseRun } from "../../packages/workflows/src/runs/background/status.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { testRunId } from "../helpers/run-id.js";

function pooledRoot(options: { readonly rootStages?: readonly StageSnapshot[] } = {}) {
	const root = testRunId("pooled-pause-root");
	const child = testRunId("pooled-pause-child");
	const store = createStore();
	store.recordRunStart({
		id: root,
		name: "root",
		inputs: {},
		status: "running",
		startedAt: 1,
		toolNodes: [],
		rootRunId: root,
		stages: [
			{
				id: "boundary",
				name: "child",
				status: "running",
				parentIds: [],
				toolEvents: [],
				workflowChildRun: { alias: "child", workflow: "child", runId: child },
			},
			...(options.rootStages ?? []),
		],
	});
	const workerExecution = { worker: "worker-1", generation: 1, renewedAt: 1, expiresAt: 2 };
	store.recordRunStart({
		id: child,
		name: "child",
		inputs: {},
		status: "running",
		startedAt: 1,
		toolNodes: [],
		parentRunId: root,
		parentStageId: "boundary",
		rootRunId: root,
		stages: ["lane-0", "lane-1"].map((id) => ({
			id,
			name: id,
			status: "running" as const,
			parentIds: [],
			toolEvents: [],
			workerExecution,
		})),
	});
	const toolControlRegistry = createToolControlRegistry();
	const stageControlRegistry = createStageControlRegistry();
	let poolPauses = 0;
	toolControlRegistry.registerRun(root, {
		paused: false,
		async pause() {
			poolPauses++;
		},
		async resume() {},
		async quit() {},
	});
	return { root, store, toolControlRegistry, stageControlRegistry, poolPauses: () => poolPauses };
}

test("pausing a root pauses its stages on local workers while one of its own ctx.tool nodes runs", async () => {
	const f = pooledRoot();
	const controller = new AbortController();
	const unregister = f.toolControlRegistry.register({
		runId: f.root,
		nodeId: "orchestrate",
		name: "orchestrate",
		controller,
		settled: new Promise(() => {}),
	});
	try {
		const result = await pauseRun(f.root, f);
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(f.poolPauses(), 1, "the root's run control pauses the pool");
		assert.equal(f.store.runs().find((run) => run.id === f.root)?.status, "paused");
	} finally {
		unregister();
	}
});

test("pausing a root again once its workers paused every stage reports it already paused", async () => {
	const f = pooledRoot();
	const controller = new AbortController();
	const unregister = f.toolControlRegistry.register({
		runId: f.root,
		nodeId: "orchestrate",
		name: "orchestrate",
		controller,
		settled: new Promise(() => {}),
	});
	try {
		assert.equal((await pauseRun(f.root, f)).ok, true);
		// The workers' next activity publishes their stages paused; the root's child boundary stays open meanwhile.
		const child = f.store.runs().find((run) => run.parentRunId === f.root)!;
		for (const stage of child.stages) f.store.recordStagePaused(child.id, stage.id);
		f.store.recordRunPaused(child.id);
		const again = await pauseRun(f.root, f);
		assert.deepEqual(again.ok ? "ok" : again.reason, "already_paused");
		assert.equal(f.poolPauses(), 1, "a paused pool is not paused again");
	} finally {
		unregister();
	}
});
