import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import type { Worker } from "node:worker_threads";
import { openNodeSqliteDatabase } from "@bastani/atomic";
import { StorageUnavailableError } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import {
	ShipIdentityConflictError,
	ShipShard,
	shipShardPath,
} from "../../packages/workflows/src/workers/ship-shard.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const threads = vi.hoisted(() => ({ started: [] as Worker[], exited: new Set<Worker>() }));

vi.mock("node:worker_threads", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:worker_threads")>();
	class TrackedWorker extends actual.Worker {
		constructor(...args: ConstructorParameters<typeof actual.Worker>) {
			super(...args);
			threads.started.push(this);
			this.once("exit", () => threads.exited.add(this));
		}
	}
	return { ...actual, Worker: TrackedWorker };
});

const ROOT = "root-5321";
const LEASE = { id: "work-1", generation: 1, worker: "host/1", epoch: 1 } as const;
const LEASE_MS = 600_000;
const SLOW_ROWS = 1_500;
const LOCK_RELEASE_MS = 20;

const directories: string[] = [];
const opened: { close(): Promise<void> }[] = [];

afterEach(async () => {
	for (const item of opened.splice(0)) await item.close().catch(() => {});
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
	threads.started.splice(0);
	threads.exited.clear();
});

async function openShard(): Promise<{ shard: ShipShard; path: string }> {
	const directory = makeTempDirectory("ship-shard-event-loop-");
	directories.push(directory);
	const path = shipShardPath(directory, "journal", ROOT);
	const shard = await ShipShard.open(path, ROOT);
	opened.push(shard);
	await shard.hold(LEASE, LEASE_MS);
	return { shard, path };
}

async function waitForExits(): Promise<void> {
	for (const thread of threads.started)
		if (!threads.exited.has(thread)) await new Promise((resolve) => thread.once("exit", resolve));
}

async function slowInserts(path: string): Promise<void> {
	const side = await openNodeSqliteDatabase(path);
	try {
		await side.exec(`
			CREATE TABLE slow(n INTEGER);
			WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < ${SLOW_ROWS}) INSERT INTO slow SELECT n FROM r;
			CREATE TRIGGER slow_insert AFTER INSERT ON ship_events BEGIN SELECT count(*) FROM slow a, slow b; END;
		`);
	} finally {
		await side.close();
	}
}

test("a timer due while a checkpoint shard commits fires before the commit settles (#5321)", async () => {
	const { shard, path } = await openShard();
	await slowInserts(path);
	const order: string[] = [];
	const accepting = shard.accept(ROOT, LEASE, "slow", '{"step":1}', 1).then((receipt) => {
		order.push("accepted");
		return receipt;
	});
	await new Promise<void>((resolve) => setTimeout(resolve, 1));
	order.push("timer");
	assert.deepEqual(await accepting, { localSeq: 1, accepted: true });
	assert.deepEqual(order, ["timer", "accepted"]);
	assert.deepEqual(
		(await shard.pending(LEASE)).map((event) => event.key),
		["slow"],
	);
});

test("a checkpoint shard write waiting for another connection's lock leaves the event loop free to release it (#5321)", async () => {
	const { shard, path } = await openShard();
	const { localSeq } = await shard.accept(ROOT, LEASE, "discarded", "{}", 1);
	const side = await openNodeSqliteDatabase(path);
	opened.push(side);
	const held = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const holding = side.transaction(async () => {
		held.resolve();
		await release.promise;
	});
	await held.promise;
	const order: string[] = [];
	const discarding = shard.discard(LEASE, localSeq).then(() => order.push("discarded"));
	setTimeout(() => {
		order.push("released");
		release.resolve();
	}, LOCK_RELEASE_MS);
	await Promise.all([holding, discarding]);
	assert.deepEqual(order, ["released", "discarded"]);
	assert.deepEqual(await shard.pending(LEASE), []);
});

test("checkpoints accepted together commit in order, a conflicting one rolls back alone, and a read sees only what was queued before it (#5321)", async () => {
	const { shard, path } = await openShard();
	await shard.accept(ROOT, LEASE, "taken", '{"v":1}', 1);
	const first = shard.accept(ROOT, LEASE, "a", "{}", 2);
	const conflicting = shard.accept(ROOT, LEASE, "taken", '{"v":2}', 3);
	const second = shard.accept(ROOT, LEASE, "b", "{}", 4);
	const between = shard.pending(LEASE);
	const after = shard.accept(ROOT, LEASE, "c", "{}", 5);
	assert.deepEqual(await first, { localSeq: 2, accepted: true });
	await assert.rejects(conflicting, ShipIdentityConflictError);
	assert.deepEqual(await second, { localSeq: 3, accepted: true });
	assert.deepEqual(
		(await between).map((event) => event.key),
		["taken", "a", "b"],
	);
	assert.deepEqual(await after, { localSeq: 4, accepted: true });
	const reader = await openNodeSqliteDatabase(path);
	opened.push(reader);
	assert.deepEqual(
		(await reader.all<{ event_key: string }>("SELECT event_key FROM ship_events ORDER BY local_seq")).map(
			(row) => row.event_key,
		),
		["taken", "a", "b", "c"],
	);
});

for (const failure of ["error", "exit"] as const)
	test(`a checkpoint shard whose connection thread reports ${failure} fails its pending and later writes instead of leaving them waiting (#5321)`, async () => {
		const { shard, path } = await openShard();
		const { localSeq } = await shard.accept(ROOT, LEASE, "held", "{}", 1);
		const thread = threads.started.at(-1);
		assert.ok(thread !== undefined);
		const side = await openNodeSqliteDatabase(path);
		opened.push(side);
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const holding = side.transaction(async () => {
			held.resolve();
			await release.promise;
		});
		await held.promise;
		const discarding = shard.discard(LEASE, localSeq);
		if (failure === "error") thread.emit("error", new Error("connection thread failed"));
		else thread.emit("exit", 1);
		await assert.rejects(discarding, StorageUnavailableError);
		await assert.rejects(shard.accept(ROOT, LEASE, "later", "{}", 2), StorageUnavailableError);
		release.resolve();
		await holding;
		await shard.close();
	});

test("a checkpoint shard stops its connection threads when it closes, and when its file cannot open (#5321)", async () => {
	const { shard, path } = await openShard();
	assert.ok(threads.started.length > 0);
	await shard.close({ retire: true });
	await waitForExits();
	threads.started.splice(0);
	mkdirSync(path, { recursive: true });
	await assert.rejects(ShipShard.open(path, ROOT), StorageUnavailableError);
	assert.ok(threads.started.length > 0);
	await waitForExits();
	rmSync(path, { recursive: true });
	const reopened = await ShipShard.open(path, ROOT);
	opened.push(reopened);
	await reopened.hold(LEASE, LEASE_MS);
	assert.equal((await reopened.accept(ROOT, LEASE, "after", "{}", 1)).accepted, true);
});
