import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { StageWaitKind } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import type { RunSnapshot, StageSnapshot, ToolNodeStatus } from "../../packages/workflows/src/shared/store-types.js";
import { attemptWaitsReleased, WaitingWorkerReserve } from "../../packages/workflows/src/workers/waiting-workers.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

function stage(status: StageSnapshot["status"], wait?: StageWaitKind): StageSnapshot {
	return {
		id: `stage-${status}-${wait ?? "none"}`,
		name: "stage",
		status,
		parentIds: [],
		toolEvents: [],
		...(wait === undefined ? {} : { wait: { kind: wait, since: 0 } }),
	} as StageSnapshot;
}

function runOf(stages: StageSnapshot[], toolNodes: ToolNodeStatus[] = []): RunSnapshot {
	return {
		id: "child",
		stages,
		toolNodes: toolNodes.map((status, index) => ({ id: `tool-${index}`, status })),
	} as unknown as RunSnapshot;
}

describe("whether a pooled attempt waits released (#4374)", () => {
	test("waits when every live stage waits on a tool result or an answer, across all its runs (#4374)", () => {
		assert.equal(attemptWaitsReleased([runOf([stage("waiting", "tool")])]), true);
		assert.equal(attemptWaitsReleased([runOf([stage("awaiting_input", "tool")])]), true);
		assert.equal(attemptWaitsReleased([runOf([stage("awaiting_input", "prompt")])]), true);
		assert.equal(
			attemptWaitsReleased([
				runOf([stage("completed"), stage("waiting", "tool")], ["completed", "cached"]),
				runOf([stage("failed"), stage("skipped"), stage("paused", "prompt")]),
			]),
			true,
		);
	});

	test("does not wait while anything of it can still run (#4374)", () => {
		const cases: [string, RunSnapshot[]][] = [
			["no run", []],
			["no live stage", [runOf([stage("completed"), stage("failed"), stage("skipped")])]],
			["a running stage", [runOf([stage("waiting", "tool"), stage("running")])]],
			["a pending stage", [runOf([stage("waiting", "tool"), stage("pending")])]],
			["a stage asking without a release", [runOf([stage("awaiting_input")])]],
			["a stage the workflow released", [runOf([stage("waiting", "release")])]],
			["an idle stage", [runOf([stage("waiting", "idle")])]],
			["a running durable tool call", [runOf([stage("waiting", "tool")], ["completed", "running"])]],
			["a second run still running", [runOf([stage("waiting", "tool")]), runOf([stage("running")])]],
		];
		for (const [name, runs] of cases) assert.equal(attemptWaitsReleased(runs), false, name);
	});
});

describe("the workers a pool adds while attempts wait (#4374)", () => {
	test("starts one worker per waiting attempt, at most the pool's count, and none twice (#4374)", () => {
		const reserve = new WaitingWorkerReserve();

		const started = [
			reserve.grow(0, 2),
			reserve.grow(1, 2),
			reserve.grow(1, 2),
			reserve.grow(3, 2),
			reserve.grow(5, 2),
		];

		assert.deepEqual(started, [0, 1, 0, 1, 0]);
		assert.equal(reserve.size, 2);
	});

	test("starts none, and keeps the ones it started, when fewer attempts wait than it started workers for (#4374)", () => {
		const reserve = new WaitingWorkerReserve();
		reserve.grow(3, 4);

		assert.deepEqual([reserve.grow(1, 4), reserve.grow(0, 4), reserve.size], [0, 0, 3]);
	});

	test("ends one idle worker at a time once fewer attempts wait, down to none (#4374)", () => {
		const reserve = new WaitingWorkerReserve();
		reserve.grow(3, 3);

		const ended = [
			reserve.shrink(3, 3),
			reserve.shrink(2, 3),
			reserve.shrink(2, 3),
			reserve.shrink(0, 3),
			reserve.shrink(0, 3),
		];
		const afterwards = [reserve.size, reserve.shrink(0, 3)];

		assert.deepEqual(ended, [false, true, false, true, true]);
		assert.deepEqual(afterwards, [0, false]);
	});

	test("keeps its extra workers while the pool still has more waiting attempts than its count (#4374)", () => {
		const reserve = new WaitingWorkerReserve();
		reserve.grow(4, 1);

		assert.deepEqual([reserve.shrink(4, 1), reserve.shrink(1, 1), reserve.size], [false, false, 1]);
	});

	test("a worker that could not start no longer counts, and is started again for the next waiting attempt (#4374)", () => {
		const reserve = new WaitingWorkerReserve();
		reserve.grow(2, 2);

		reserve.lost();
		const restarted = reserve.grow(2, 2);
		reserve.lost();
		reserve.lost();
		reserve.lost();

		assert.deepEqual([restarted, reserve.size, reserve.grow(1, 2)], [1, 0, 1]);
	});
});
