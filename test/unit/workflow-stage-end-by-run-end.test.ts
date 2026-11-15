import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	persistStageEndWhenRunEndsIt,
	runEndedInFlightStages,
} from "../../packages/workflows/src/runs/foreground/stage-end-by-run-end.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunStatus, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

/** A running run whose one stage finalized unfinished, as a stage whose call an abort stopped does. */
function runWithUnfinishedStage() {
	const store = createStore();
	const stage: StageSnapshot = {
		id: "stage",
		name: "stage",
		status: "running",
		parentIds: [],
		toolEvents: [],
		startedAt: 1,
		endedAt: 2,
	};
	store.recordRunStart({
		id: "run",
		name: "run",
		inputs: {},
		status: "running",
		startedAt: 1,
		stages: [stage],
		toolNodes: [],
	});
	const persisted: string[] = [];
	const persist = async () => {
		persisted.push(stage.status);
	};
	return { store, stage, persisted, persist };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("an unfinished stage's end is recorded once its run ends killed or cancelled (#4875)", () => {
	for (const [status, ends] of [
		["killed", true],
		["cancelled", true],
		["failed", false],
		["completed", false],
		["blocked", false],
	] as const satisfies readonly (readonly [RunStatus, boolean])[]) {
		test(`a run that ends ${status} ${ends ? "ends" : "does not end"} its in-flight stages (#4875)`, () => {
			const { store } = runWithUnfinishedStage();
			assert.equal(runEndedInFlightStages(store, "run"), false, "a running run has not ended");
			store.recordRunEnd("run", status);
			assert.equal(runEndedInFlightStages(store, "run"), ends);
		});
	}

	test("an unknown run has not ended any stage (#4875)", () => {
		assert.equal(runEndedInFlightStages(createStore(), "missing"), false);
	});

	test("the stage's end is recorded once, when its run ends killed, and not while the run only pauses (#4875)", async () => {
		const { store, persisted, persist } = runWithUnfinishedStage();
		persistStageEndWhenRunEndsIt(store, "run", store.run("run")!.stages[0]!, persist);

		store.recordRunPaused("run");
		await settle();
		assert.deepEqual(persisted, []);

		store.recordRunEnd("run", "killed");
		await settle();
		assert.deepEqual(persisted, ["failed"]);

		store.recordNotice({ id: "later", runId: "run", level: "info", message: "later", createdAt: 3 });
		await settle();
		assert.deepEqual(persisted, ["failed"], "recorded once");
	});

	test("a run that ends otherwise leaves the stage's recorded end as it was, also after a later kill attempt (#4875)", async () => {
		const { store, stage, persisted, persist } = runWithUnfinishedStage();
		persistStageEndWhenRunEndsIt(store, "run", stage, persist);

		store.recordRunEnd("run", "failed", undefined, "boom");
		await settle();
		assert.deepEqual(persisted, []);
		assert.equal(stage.status, "running");
	});

	test("a stage its run no longer holds is not recorded when the run is killed (#4875)", async () => {
		const { store, persisted, persist } = runWithUnfinishedStage();
		const detached: StageSnapshot = { ...store.run("run")!.stages[0]! };
		persistStageEndWhenRunEndsIt(store, "run", detached, persist);

		store.recordRunEnd("run", "killed");
		await settle();
		assert.deepEqual(persisted, []);
	});

	test("a removed run stops waiting without recording anything (#4875)", async () => {
		const { store, persisted, persist } = runWithUnfinishedStage();
		persistStageEndWhenRunEndsIt(store, "run", store.run("run")!.stages[0]!, persist);

		store.removeRun("run");
		await settle();
		store.recordRunStart({
			id: "run",
			name: "run",
			inputs: {},
			status: "running",
			startedAt: 1,
			stages: [],
			toolNodes: [],
		});
		store.recordRunEnd("run", "killed");
		await settle();
		assert.deepEqual(persisted, []);
	});

	test("a failing record does not surface as an unhandled rejection (#4875)", async () => {
		const { store } = runWithUnfinishedStage();
		let attempts = 0;
		persistStageEndWhenRunEndsIt(store, "run", store.run("run")!.stages[0]!, async () => {
			attempts += 1;
			throw new Error("journal unavailable");
		});
		store.recordRunEnd("run", "killed");
		await settle();
		assert.equal(attempts, 1);
	});
});
