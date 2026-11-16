import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { openNodeSqliteDatabase } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { StaleWorkLeaseError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import { SHIP_SHARD_SCHEMA, ShipShard, shipShardPath } from "../../packages/workflows/src/workers/ship-shard.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const ROOT = "root-4768";
const LEASE_G1 = { id: "work-1", generation: 1, worker: "host/1", epoch: 1 } as const;
const LEASE_G2 = { id: "work-1", generation: 2, worker: "host/2", epoch: 2 } as const;
const LEASE_MS = 1_000;

const directories: string[] = [];
const opened: { close(): Promise<void> }[] = [];

afterEach(async () => {
	for (const item of opened.splice(0)) await item.close().catch(() => {});
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

function createShardPath(): string {
	const directory = makeTempDirectory("ship-shard-reg-");
	directories.push(directory);
	return shipShardPath(directory, "journal", ROOT);
}

async function openShard(path = createShardPath(), clock = { now: 0 }): Promise<{ shard: ShipShard; path: string }> {
	const shard = await ShipShard.open(path, ROOT, () => clock.now);
	opened.push(shard);
	return { shard, path };
}

async function assertRefused(promise: Promise<unknown>, reason: string): Promise<void> {
	await assert.rejects(
		promise,
		(error: unknown) => error instanceof StaleWorkLeaseError && error.reason === reason,
		`expected StaleWorkLeaseError with reason ${reason}`,
	);
}

test("an in-memory checkpoint journal creates no disk files while open or after close and retirement (#5194)", async () => {
	const directory = makeTempDirectory("ship-shard-memory-");
	directories.push(directory);
	const cwd = process.cwd();
	process.chdir(directory);
	try {
		for (const retire of [false, true]) {
			const shard = await ShipShard.open(":memory:", ROOT);
			try {
				await shard.hold(LEASE_G1, LEASE_MS);
				await shard.accept(ROOT, LEASE_G1, "key", '{"saved":true}', 1);
				assert.equal(await shard.pendingCount(LEASE_G1), 1);
				assert.deepEqual(readdirSync(directory), [], "an open in-memory journal creates no files");
			} finally {
				await shard.close({ retire });
			}
			assert.deepEqual(readdirSync(directory), [], "closing an in-memory journal creates no files");
		}
	} finally {
		process.chdir(cwd);
	}
});

test("holding an older generation ignores it and preserves the newer generation lease and pending rows (#4768)", async () => {
	const { shard } = await openShard();
	await shard.hold(LEASE_G2, LEASE_MS);
	const first = await shard.accept(ROOT, LEASE_G2, "k1", '{"step":1}', 1);
	assert.deepEqual(first, { localSeq: 1, accepted: true });

	await shard.hold(LEASE_G1, LEASE_MS);

	const pending = await shard.pending(LEASE_G2);
	assert.equal(pending.length, 1);
	assert.equal(pending[0]?.key, "k1");

	const second = await shard.accept(ROOT, LEASE_G2, "k2", '{"step":2}', 2);
	assert.deepEqual(second, { localSeq: 2, accepted: true });
	await assertRefused(shard.accept(ROOT, LEASE_G1, "k3", '{"step":3}', 3), "generation-mismatch");
});

test("a reopened shard preserves the stored replacement lease and refuses old-generation checkpoint keys (#4768)", async () => {
	const path = createShardPath();
	const { shard: firstHost } = await openShard(path);
	await firstHost.hold(LEASE_G1, LEASE_MS);
	await firstHost.accept(ROOT, LEASE_G1, "k1", '{"gen":1}', 1);
	await firstHost.close();

	const { shard: secondHost } = await openShard(path);
	await secondHost.hold(LEASE_G2, LEASE_MS);
	const acceptedG2 = await secondHost.accept(ROOT, LEASE_G2, "k1", '{"gen":2}', 2);
	assert.equal(acceptedG2.accepted, true);
	await secondHost.close();

	const { shard: lateHost } = await openShard(path);
	await lateHost.hold(LEASE_G1, LEASE_MS);
	assert.equal((await lateHost.pending(LEASE_G2)).length, 1);
	await assertRefused(lateHost.accept(ROOT, LEASE_G1, "k1", '{"gen":1}', 3), "generation-mismatch");
	await assertRefused(lateHost.accept(ROOT, LEASE_G1, "k1", '{"gen":2}', 3), "generation-mismatch");
	await lateHost.fence(LEASE_G1);
	await lateHost.hold(LEASE_G2, LEASE_MS);
	assert.deepEqual(await lateHost.accept(ROOT, LEASE_G2, "k1", '{"gen":2}', 4), {
		localSeq: acceptedG2.localSeq,
		accepted: false,
	});
});

test("opening an existing shard file migrates legacy UNIQUE(work, event_key) tables (#4768)", async () => {
	const path = createShardPath();
	const raw = await openNodeSqliteDatabase(path);
	await raw.exec(SHIP_SHARD_SCHEMA);
	await raw.exec(`
		DROP TABLE ship_events;
		CREATE TABLE ship_events(
			local_seq INTEGER PRIMARY KEY AUTOINCREMENT,
			work TEXT NOT NULL, generation INTEGER NOT NULL, epoch INTEGER NOT NULL,
			event_key TEXT NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL, at INTEGER NOT NULL,
			batch TEXT,
			UNIQUE(work, event_key)
		);
		INSERT INTO ship_events(local_seq, work, generation, epoch, event_key, payload, digest, at)
		VALUES (1, 'work-1', 1, 1, 'shared-key', '{"g":1}', 'd1', 1);
		INSERT INTO ship_lease(work, generation, worker, epoch) VALUES ('work-1', 1, 'host/1', 1);
	`);
	await raw.close();

	const { shard: migrated } = await openShard(path);
	const checkDb = await openNodeSqliteDatabase(path);
	opened.push(checkDb);
	await checkDb.run(
		`INSERT INTO ship_events(work, generation, epoch, event_key, payload, digest, at)
		VALUES ('work-1', 2, 2, 'shared-key', '{"g":2}', 'd2', 2)`,
	);
	assert.equal((await migrated.pending(LEASE_G1)).length, 1);
	assert.equal((await migrated.pending(LEASE_G2)).length, 1);
});

test("shipped deletes only the exact local_seq and discard removes a rejected local_seq without advancing the cursor (#4768)", async () => {
	const { shard } = await openShard();
	await shard.hold(LEASE_G1, LEASE_MS);
	const e1 = await shard.accept(ROOT, LEASE_G1, "k1", '{"a":1}', 1);
	const e2 = await shard.accept(ROOT, LEASE_G1, "k2", '{"a":2}', 2);
	await shard.accept(ROOT, LEASE_G1, "k3", '{"a":3}', 3);

	await shard.shipped(LEASE_G1, e2.localSeq);
	assert.deepEqual(
		(await shard.pending(LEASE_G1)).map((row) => row.key),
		["k1", "k3"],
	);

	await shard.discard(LEASE_G1, e1.localSeq);
	assert.deepEqual(
		(await shard.pending(LEASE_G1)).map((row) => row.key),
		["k3"],
	);

	const retried = await shard.accept(ROOT, LEASE_G1, "k1", '{"a":99}', 4);
	assert.equal(retried.accepted, true);

	shard.release(LEASE_G1);
	await assertRefused(shard.accept(ROOT, LEASE_G1, "k4", "{}", 5), "missing");

	await shard.hold(LEASE_G2, LEASE_MS);
	shard.release(LEASE_G1);
	assert.equal((await shard.accept(ROOT, LEASE_G2, "k5", "{}", 6)).accepted, true);
});
