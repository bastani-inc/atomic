import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type {
	RunSnapshot,
	RunStatus,
	StageSnapshot,
	StageStatus,
	ToolNodeSnapshot,
	ToolNodeStatus,
} from "../../packages/workflows/src/shared/store-types.js";

const ENDED_AT = 10_000;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(ENDED_AT);
});
afterEach(() => {
	vi.useRealTimers();
});

function stage(id: string, status: StageStatus, fields: Partial<StageSnapshot> = {}): StageSnapshot {
	return { id, name: id, status, parentIds: [], toolEvents: [], startedAt: 1_000, ...fields };
}

function tool(id: string, status: ToolNodeStatus, fields: Partial<ToolNodeSnapshot> = {}): ToolNodeSnapshot {
	return {
		kind: "tool",
		id,
		name: id,
		argsHash: id,
		ordinal: 1,
		parentIds: [],
		status,
		attachable: false,
		...fields,
	};
}

/** A store holding one running run with the given stages and tool nodes. */
function storeWith(stages: StageSnapshot[], toolNodes: ToolNodeSnapshot[] = [], fields: Partial<RunSnapshot> = {}) {
	const store = createStore();
	store.recordRunStart({
		id: "run",
		name: "run",
		inputs: {},
		status: "running",
		startedAt: 1_000,
		stages,
		toolNodes,
		...fields,
	});
	return store;
}

function stageOf(store: ReturnType<typeof createStore>, id: string): StageSnapshot {
	const found = store.run("run")?.stages.find((candidate) => candidate.id === id);
	assert.ok(found, `stage ${id}`);
	return found;
}

const KILLED_STAGE = {
	status: "failed",
	failureKind: "cancelled",
	failureCode: "cancelled",
	failureRecoverability: "non_recoverable",
	failureDisposition: "terminal_killed",
} as const;

describe("a run that ends killed or cancelled ends the work it had in flight (#4875)", () => {
	test("killing a run fails each in-flight stage as killed and leaves finished, blocked and unstarted stages alone (#4875)", () => {
		const store = storeWith([
			stage("running", "running"),
			stage("asking", "awaiting_input", { awaitingInputSince: 2_000 }),
			stage("paused", "paused", { pausedAt: 3_000, pausedDurationMs: 500 }),
			stage("suspended", "suspended"),
			stage("done", "completed", { endedAt: 2_000, durationMs: 1_000 }),
			stage("blocked", "blocked"),
			stage("queued", "pending"),
		]);

		assert.equal(store.recordRunEnd("run", "killed", undefined, "workflow killed by test"), true);

		for (const id of ["running", "asking", "paused", "suspended"]) {
			const ended = stageOf(store, id);
			assert.deepEqual(
				{
					status: ended.status,
					failureKind: ended.failureKind,
					failureCode: ended.failureCode,
					failureRecoverability: ended.failureRecoverability,
					failureDisposition: ended.failureDisposition,
				},
				KILLED_STAGE,
				id,
			);
			assert.equal(ended.error, "workflow killed by test", id);
			assert.equal(ended.failureMessage, "workflow killed by test", id);
			assert.equal(ended.endedAt, ENDED_AT, id);
		}
		assert.equal(stageOf(store, "running").durationMs, 9_000);
		assert.equal(stageOf(store, "asking").awaitingInputSince, undefined);
		const paused = stageOf(store, "paused");
		assert.equal(paused.pausedAt, undefined);
		assert.equal(paused.pausedDurationMs, 7_500);
		assert.equal(paused.durationMs, 1_500);
		assert.deepEqual(
			["done", "blocked", "queued"].map((id) => [stageOf(store, id).status, stageOf(store, id).endedAt]),
			[
				["completed", 2_000],
				["blocked", undefined],
				["pending", undefined],
			],
		);
	});

	test("a killed run without an error fails its stages with 'workflow killed' and keeps an end they already have (#4875)", () => {
		const store = storeWith([stage("finalized", "running", { endedAt: 4_000, durationMs: 3_000 })]);

		store.recordRunEnd("run", "killed");

		const ended = stageOf(store, "finalized");
		assert.equal(ended.status, "failed");
		assert.equal(ended.error, "workflow killed");
		assert.equal(ended.endedAt, 4_000);
		assert.equal(ended.durationMs, 3_000);
	});

	test("a cancelled run skips its in-flight stages with its exit reason, or 'cancelled' without one (#4875)", () => {
		const store = storeWith([stage("running", "running", { wait: undefined })]);
		store.recordRunEnd("run", "cancelled", undefined, undefined, { exitReason: "parent exited" });
		assert.equal(stageOf(store, "running").status, "skipped");
		assert.equal(stageOf(store, "running").skippedReason, "parent exited");
		assert.equal(stageOf(store, "running").error, undefined);

		const bare = storeWith([stage("running", "running")]);
		bare.recordRunEnd("run", "cancelled");
		assert.equal(stageOf(bare, "running").skippedReason, "cancelled");
	});

	test("ending a run killed cancels its running and pending tool calls and keeps finished ones (#4875)", () => {
		const store = storeWith(
			[],
			[
				tool("running", "running", { startedAt: 4_000 }),
				tool("pending", "pending"),
				tool("done", "completed", { startedAt: 1_000, endedAt: 2_000, durationMs: 1_000 }),
				tool("failed", "failed", { endedAt: 3_000 }),
			],
		);

		store.recordRunEnd("run", "killed");

		const nodes = Object.fromEntries(
			(store.run("run")?.toolNodes ?? []).map((node) => [node.id, [node.status, node.endedAt, node.durationMs]]),
		);
		assert.deepEqual(nodes, {
			running: ["cancelled", ENDED_AT, 6_000],
			pending: ["cancelled", ENDED_AT, undefined],
			done: ["completed", 2_000, 1_000],
			failed: ["failed", 3_000, undefined],
		});
	});

	for (const status of ["completed", "failed", "skipped", "blocked"] as const satisfies readonly RunStatus[]) {
		test(`a run that ends ${status} keeps its stages and tool calls as they are (#4875)`, () => {
			const store = storeWith([stage("running", "running")], [tool("running", "running")]);
			store.recordRunEnd("run", status);
			assert.equal(stageOf(store, "running").status, "running");
			assert.equal(stageOf(store, "running").endedAt, undefined);
			assert.equal(store.run("run")?.toolNodes[0]?.status, "running");
		});
	}

	test("ending a run killed tells subscribers only that run changed (#4875)", () => {
		const store = storeWith([stage("running", "running")], [tool("running", "running")]);
		const changes: Array<readonly { readonly runId: string }[] | undefined> = [];
		store.subscribeInvalidation((change) => changes.push(change));

		store.recordRunEnd("run", "killed");

		assert.ok(changes.length > 0);
		for (const change of changes)
			assert.deepEqual(
				change?.map((entry) => entry.runId),
				["run"],
			);
	});
});
