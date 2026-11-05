import assert from "node:assert/strict";
import { test } from "vitest";
import type { PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type {
	CoordinatorEvent,
	CoordinatorInbound,
	PoolActivityUpdate,
} from "../../packages/workflows/src/workers/coordinator-protocol.js";
import { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import { isRunChanges } from "../../packages/workflows/src/workers/run-changes.js";
import { sleep } from "../helpers/runtime.js";

/** The parts of a coordinator this file drives directly, as its workers and its root would. */
interface CoordinatorInternals {
	publishing: boolean;
	root?: string;
	queue?: { result(root: string, workId: string): Promise<object | undefined> };
	publish(work: PoolWork, runs: readonly RunSnapshot[]): void;
	flush(): Promise<void>;
	fence(work: PoolWork): void;
	sendResult(workId: string): Promise<boolean>;
}

const work = {
	id: "work",
	generation: 1,
	worker: "worker-one",
	epoch: 1,
	renewedAt: 0,
	expiresAt: 60_000,
	state: "leased",
} as PoolWork;

function stage(id: string, overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return { id, name: id, status: "completed", parentIds: [], toolEvents: [], ...overrides };
}

function run(stages: StageSnapshot[]): RunSnapshot {
	return { id: "child", name: "child", inputs: {}, status: "running", stages, toolNodes: [], startedAt: 0 };
}

function coordinator() {
	const sent: CoordinatorEvent[] = [];
	const listeners: ((message: CoordinatorInbound) => void)[] = [];
	const instance = new PoolCoordinator({
		send: (message) => sent.push(message),
		onMessage: (listener) => listeners.push(listener),
		onClose: () => {},
		close: async () => {},
	});
	const internals = instance as never as CoordinatorInternals;
	internals.publishing = true;
	/** What the latest activity event carried for the work. */
	const activity = () => {
		const event = sent.findLast((message) => message.kind === "activity");
		assert.ok(event?.kind === "activity");
		return event;
	};
	return {
		internals,
		activity,
		runs: (): readonly PoolActivityUpdate["runs"][number][] => activity().entries[0]!.runs,
		acknowledge: (batch: number) => {
			for (const listener of listeners) listener({ kind: "published", batch, rejected: [] });
		},
	};
}

test("the coordinator sends each attempt's runs in full first and then only what changed (#4317)", async () => {
	const pool = coordinator();
	pool.internals.publish(work, [run([stage("a"), stage("b", { status: "running" })])]);
	const first = pool.internals.flush();
	assert.equal(isRunChanges(pool.runs()[0]!), false);
	pool.acknowledge(pool.activity().batch);
	await first;
	pool.internals.publish(work, [run([stage("a"), stage("b"), stage("c", { status: "running" })])]);
	const second = pool.internals.flush();
	const [changes] = pool.runs();
	assert.ok(changes !== undefined && isRunChanges(changes));
	assert.deepEqual(
		changes.stages.map((entry) => entry.id),
		["b", "c"],
	);
	const settled = await Promise.race([second.then(() => true), sleep(50).then(() => false)]);
	assert.equal(settled, false, "a flush waits for the root to apply its batch");
	pool.acknowledge(pool.activity().batch);
	await second;
});

test("an attempt fenced or finished publishes in full again (#4317)", async () => {
	const pool = coordinator();
	const runs = [run([stage("a")])];
	pool.internals.publish(work, runs);
	void pool.internals.flush();
	pool.acknowledge(pool.activity().batch);
	pool.internals.publish(work, runs);
	void pool.internals.flush();
	assert.equal(isRunChanges(pool.runs()[0]!), true, "the same attempt again");
	pool.acknowledge(pool.activity().batch);
	pool.internals.fence(work);
	pool.internals.publish(work, runs);
	void pool.internals.flush();
	assert.equal(isRunChanges(pool.runs()[0]!), false, "after a fence");
	pool.acknowledge(pool.activity().batch);
	pool.internals.root = "root";
	pool.internals.queue = { result: async () => ({ status: "completed" }) };
	assert.equal(await pool.internals.sendResult(work.id), true);
	pool.internals.publish(work, runs);
	void pool.internals.flush();
	assert.equal(isRunChanges(pool.runs()[0]!), false, "after its result");
});
