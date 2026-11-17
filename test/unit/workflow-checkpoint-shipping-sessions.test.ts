import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	type PoolMutation,
	type PoolSessionAppend,
	PoolSessionFold,
	type PoolSessionMutation,
} from "../../packages/workflows/src/durable/journal/pool-mutations.js";
import type { PoolCommitReceipt } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import {
	CheckpointShipping,
	type ShipDelivery,
	type ShippingFallback,
} from "../../packages/workflows/src/workers/checkpoint-shipping.js";
import {
	SHIP_BATCH_MAX_PAYLOAD,
	type ShipSessionState,
	ShipShard,
	shipDigest,
	shipShardPath,
} from "../../packages/workflows/src/workers/ship-shard.js";
import { ShipShard as ReleasedShipShard } from "../fixtures/ship-shard-0.9.88/ship-shard.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * Pooled stage session writes, checkpoints that bill usage and checkpoints that record worktree snapshots, kept in a
 * host's local journal and shipped with its checkpoints (#4768).
 */

const ROOT = "root-4768";
const LEASE = { id: "work-1", generation: 1, worker: "host/1", epoch: 3 } as const;
const LEASE_MS = 60_000;
const SHIPPING = { intervalMs: 60_000, maxBatch: 64, maxLagMs: 30_000 } as const;

const directories: string[] = [];
const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const item of opened.splice(0)) await item.close().catch(() => {});
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

async function shardAt(path?: string): Promise<{ shard: ShipShard; path: string }> {
	let at = path;
	if (at === undefined) {
		const directory = makeTempDirectory("ship-sessions-");
		directories.push(directory);
		at = shipShardPath(directory, "journal", ROOT);
	}
	const shard = await ShipShard.open(at, ROOT);
	opened.push(shard);
	return { shard, path: at };
}

/** A shared journal as a fake delivery sees it: every row of each batch it took, in order, once. */
function fakeShared() {
	const rows: { readonly key: string; readonly op: string }[] = [];
	const batches = new Set<string>();
	const deliver: ShipDelivery = async (_attempt, batch) => {
		if (batches.has(batch.id)) return;
		batches.add(batch.id);
		for (const event of batch.events) rows.push({ key: event.key, op: event.op ?? "checkpoint" });
	};
	return { rows, batches, deliver };
}

function shippingOf(
	shard: ShipShard,
	deliver: ShipDelivery,
	extra: {
		readonly sessionState?: (attempt: unknown, session: string) => Promise<ShipSessionState>;
		readonly snapshotsStored?: (checkpoint: DurableCheckpoint) => Promise<void>;
		readonly onFallback?: (fallback: ShippingFallback) => void;
	} = {},
): CheckpointShipping {
	const shipping = new CheckpointShipping(shard, { ...SHIPPING, host: "host", deliver, ...extra });
	opened.push(shipping);
	return shipping;
}

const noShared = async (): Promise<PoolCommitReceipt> => assert.fail("nothing commits to the shared journal directly");

const header = (id = "session") => ({ id, version: 4, createdAt: "2026-01-01T00:00:00Z", cwd: "/" });
const entry = (id: string) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-01-01T00:00:00Z",
	message: { role: "user", content: id, timestamp: 1 },
});
const binding = (id: string, session = "session", replayKey = "scope:stage") =>
	({
		kind: "stage",
		workflowId: ROOT,
		checkpointId: `scope:session:${id}`,
		name: "stage",
		replayKey,
		sessionId: session,
		completedAt: 1,
	}) as unknown as DurableCheckpoint;
const create = (id: string, entries: number, session = "session") =>
	({
		kind: "session-create",
		checkpoint: binding(id, session),
		header: header(session),
		entries: Array.from({ length: entries }, (_, index) => entry(`${id}-${index}`)),
	}) as unknown as PoolMutation;
const replace = (id: string, entries: number, expectSeq: number, replayKey?: string) =>
	({
		kind: "session-replace",
		checkpoint: binding(id, "session", replayKey),
		header: header(),
		entries: Array.from({ length: entries }, (_, index) => entry(`${id}-${index}`)),
		expectSeq,
	}) as unknown as PoolMutation;
const append = (id: string, entries: number, expectSeq: number, session = "session") =>
	({
		kind: "session-append",
		sessionId: session,
		entries: Array.from({ length: entries }, (_, index) => entry(`${id}-${index}`)),
		expectSeq,
	}) as unknown as PoolMutation;

test("a session's writes are acknowledged from the local journal with the sequence the shared store gives them (#4768)", async () => {
	const { shard } = await shardAt();
	const shared = fakeShared();
	const shipping = shippingOf(shard, shared.deliver, {
		sessionState: async () => assert.fail("the attempt created the session"),
	});
	await shipping.hold(LEASE, LEASE_MS);
	const created = await shipping.commit(LEASE, create("c", 2), noShared);
	assert.deepEqual([created.local, created.lastSeq], [true, 2]);
	const appended = await shipping.commit(LEASE, append("a", 3, 2), noShared, { operation: "op-1" });
	assert.deepEqual([appended.local, appended.lastSeq], [true, 5]);
	// The worker sends the same commit again when it never got the answer: the same write, the same sequence.
	assert.equal((await shipping.commit(LEASE, append("a", 3, 2), noShared, { operation: "op-1" })).lastSeq, 5);
	// A replace starts the session's sequence over, as the session store numbers it.
	assert.equal((await shipping.commit(LEASE, replace("r", 1, 5), noShared)).lastSeq, 1);
	assert.equal((await shipping.commit(LEASE, append("b", 1, 1), noShared, { operation: "op-2" })).lastSeq, 2);
	assert.equal(shared.rows.length, 0, "nothing ships before its time");
	await shipping.flush(LEASE);
	assert.deepEqual(
		shared.rows.map((row) => row.op),
		["session-create", "session-append", "session-replace", "session-append"],
		"the writes ship once each, in the order the attempt made them",
	);
	assert.deepEqual(await shard.pending(LEASE), []);
});

test("a session write the shared store would refuse is refused locally, and the attempt keeps shipping (#4768)", async () => {
	const { shard } = await shardAt();
	const fallbacks: ShippingFallback[] = [];
	const shipping = shippingOf(shard, fakeShared().deliver, {
		sessionState: async () => ({ lastSeq: 0, replayKey: "scope:stage" }),
		onFallback: (fallback) => fallbacks.push(fallback),
	});
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.commit(LEASE, create("c", 1), noShared);
	await assert.rejects(shipping.commit(LEASE, create("again", 1), noShared), { name: "SessionExistsError" });
	await assert.rejects(shipping.commit(LEASE, append("stale", 1, 0), noShared, { operation: "op-1" }), {
		name: "SessionConflictError",
		expectedSeq: 0,
		actualSeq: 1,
	});
	await assert.rejects(
		shipping.commit(LEASE, replace("other-stage", 1, 1, "scope:other"), noShared),
		/Pool session scope mismatch/,
	);
	assert.deepEqual(fallbacks, [], "a refused write is the attempt's, not a failure of the local journal");
	assert.equal(shipping.isSyncOnly(LEASE), false);
	assert.equal((await shipping.commit(LEASE, append("ok", 1, 1), noShared, { operation: "op-2" })).lastSeq, 2);
});

test("a session an earlier attempt wrote is taken up at the state the shared store holds it in, once (#4768)", async () => {
	const { shard } = await shardAt();
	const asked: string[] = [];
	const shipping = shippingOf(shard, fakeShared().deliver, {
		sessionState: async (_attempt, session) => {
			asked.push(session);
			if (session === "missing")
				throw Object.assign(new Error("Session not found: missing"), { name: "SessionNotFoundError" });
			return { lastSeq: 7, replayKey: "scope:stage" };
		},
	});
	await shipping.hold(LEASE, LEASE_MS);
	assert.equal((await shipping.commit(LEASE, append("a", 2, 7), noShared, { operation: "op-1" })).lastSeq, 9);
	assert.equal((await shipping.commit(LEASE, append("b", 1, 9), noShared, { operation: "op-2" })).lastSeq, 10);
	assert.deepEqual(asked, ["session"]);
	await assert.rejects(shipping.commit(LEASE, append("c", 1, 0, "missing"), noShared, { operation: "op-3" }), {
		name: "SessionNotFoundError",
	});
	assert.deepEqual(await shard.session(LEASE, "missing"), undefined);
});

test("without a way to read a session's shared state, a write of a session the attempt did not create commits directly (#4768)", async () => {
	const { shard } = await shardAt();
	const shipping = shippingOf(shard, fakeShared().deliver);
	await shipping.hold(LEASE, LEASE_MS);
	assert.equal((await shipping.commit(LEASE, create("c", 1), noShared)).local, true);
	const direct = { calls: 0 };
	const receipt = await shipping.commit(
		LEASE,
		append("a", 1, 0, "other"),
		async () => {
			direct.calls++;
			return { at: 1, lastSeq: 1 };
		},
		{ operation: "op-1" },
	);
	assert.equal(receipt.local, undefined);
	assert.equal(direct.calls, 1);
	assert.deepEqual(await shard.pending(LEASE), [], "what the attempt kept before it shipped first");
});

test("a read of a session ships what the attempt holds of it, and only then (#4768)", async () => {
	const { shard } = await shardAt();
	const shared = fakeShared();
	const shipping = shippingOf(shard, shared.deliver);
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.commit(
		LEASE,
		{ kind: "checkpoint", checkpoint: { ...binding("plain"), kind: "tool", argsHash: "scope:t" } } as PoolMutation,
		noShared,
	);
	await shipping.flushSession(LEASE, "session");
	assert.equal(shared.rows.length, 0, "the attempt holds no write of the session");
	await shipping.flushSession(LEASE);
	assert.equal(shared.rows.length, 0, "nor of any session");
	await shipping.commit(LEASE, create("c", 1), noShared);
	await shipping.flushSession(LEASE, "other");
	assert.equal(shared.rows.length, 0);
	await shipping.flushSession(LEASE, "session");
	assert.deepEqual(
		shared.rows.map((row) => row.op),
		["checkpoint", "session-create"],
	);
});

test("a checkpoint with worktree snapshots is kept only once the shared store holds their blobs (#4768)", async () => {
	const { shard } = await shardAt();
	const shared = fakeShared();
	let stored = false;
	const collected = Object.assign(new Error("blobs-collected"), {
		name: "WorkspaceSnapshotError",
		code: "blobs-collected",
	});
	const shipping = shippingOf(shard, shared.deliver, {
		snapshotsStored: async () => {
			if (!stored) throw collected;
		},
	});
	await shipping.hold(LEASE, LEASE_MS);
	const snapshot = {
		kind: "checkpoint",
		checkpoint: { ...binding("snap"), kind: "tool", argsHash: "scope:snap", worktreeSnapshots: [{ root: "/r" }] },
	} as unknown as PoolMutation;
	await assert.rejects(shipping.commit(LEASE, snapshot, noShared), collected);
	assert.deepEqual(await shard.pending(LEASE), [], "nothing is kept while a blob is missing");
	stored = true;
	assert.equal((await shipping.commit(LEASE, snapshot, noShared)).local, true);
	await shipping.flush(LEASE);
	assert.equal(shared.rows.length, 1);
	// Without a way to check its blobs, the host commits it directly.
	const directOnly = shippingOf((await shardAt()).shard, fakeShared().deliver);
	await directOnly.hold(LEASE, LEASE_MS);
	let direct = 0;
	await directOnly.commit(LEASE, snapshot, async () => {
		direct++;
		return { at: 1, seq: 1 };
	});
	assert.equal(direct, 1);
});

test("a host that starts again ships the session writes it kept, and a superseded generation's session state goes with its writes (#4768)", async () => {
	const { shard, path } = await shardAt();
	const before = shippingOf(shard, async () => {
		throw new Error("the shared store is unreachable");
	});
	await before.hold(LEASE, LEASE_MS);
	await before.commit(LEASE, create("c", 1), noShared);
	await before.commit(LEASE, append("a", 1, 1), noShared, { operation: "op-1" });
	await before.close();
	const { shard: reopened } = await shardAt(path);
	const shared = fakeShared();
	const after = shippingOf(reopened, shared.deliver);
	await after.recover();
	assert.deepEqual(
		shared.rows.map((row) => row.op),
		["session-create", "session-append"],
	);
	// A later generation of the work on this host forgets what an earlier one wrote.
	await reopened.hold({ ...LEASE, generation: 2 }, LEASE_MS);
	assert.equal(await reopened.session(LEASE, "session"), undefined);
});

test("a rolled-back 0.9.88 host never recovers session rows as checkpoints (#5344)", async () => {
	const { shard, path } = await shardAt();
	const shipping = shippingOf(shard, async () => {
		throw new Error("shared store unreachable");
	});
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.commit(LEASE, create("c", 1), noShared);
	await shipping.commit(LEASE, append("a", 1, 1), noShared, { operation: "op-1" });
	await shard.seal(LEASE, 64);
	await shipping.close();
	const released = await ReleasedShipShard.open(path, ROOT);
	try {
		assert.deepEqual(
			await released.leftover(),
			[],
			"rollback replays unshipped work instead of retrying invalid batches",
		);
		assert.deepEqual(await released.pending(LEASE), []);
	} finally {
		await released.close();
	}
	const { shard: upgraded } = await shardAt(path);
	assert.deepEqual(
		(await upgraded.pending(LEASE)).map((row) => row.op),
		["session-create", "session-append"],
	);
	assert.equal((await upgraded.seal(LEASE, 64))?.events.length, 2);
});

test("upgrading again takes the rolled-back host's checkpoints and drops superseded session rows (#5344)", async () => {
	const { shard, path } = await shardAt();
	await shard.hold(LEASE, LEASE_MS);
	await shard.accept(ROOT, LEASE, "session", "{}", 1, { op: "session-create", session: "s", entries: 1 });
	await shard.close();
	const released = await ReleasedShipShard.open(path, ROOT);
	const replacement = { ...LEASE, generation: 2 };
	try {
		assert.deepEqual(await released.leftover(), []);
		await released.hold(replacement, LEASE_MS);
		await released.accept(ROOT, replacement, "replacement-checkpoint", "{}", 2);
		await released.seal(replacement, 64);
	} finally {
		await released.close();
	}
	const { shard: upgraded } = await shardAt(path);
	assert.deepEqual(await upgraded.pending(LEASE), []);
	assert.deepEqual(await upgraded.session(LEASE, "s"), undefined);
	assert.deepEqual(
		(await upgraded.pending(replacement)).map((row) => [row.key, row.op]),
		[["replacement-checkpoint", "checkpoint"]],
	);
	assert.deepEqual(
		(await upgraded.leftover()).map(({ lease }) => lease.generation),
		[2],
	);
});

test("a batch stops taking rows once their payloads pass the bound, and a larger row ships alone (#4768)", async () => {
	const { shard } = await shardAt();
	await shard.hold(LEASE, LEASE_MS);
	const big = "x".repeat(Math.ceil(SHIP_BATCH_MAX_PAYLOAD * 0.6));
	for (const key of ["a", "b", "c"]) await shard.accept(ROOT, LEASE, key, JSON.stringify(big), 1);
	const first = await shard.seal(LEASE, 64);
	assert.deepEqual(
		first?.events.map((event) => event.key),
		["a"],
	);
	await shard.shipped(LEASE, first!.events.at(-1)!.localSeq);
	await shard.accept(ROOT, LEASE, "d", JSON.stringify("small"), 1);
	assert.deepEqual(
		(await shard.seal(LEASE, 64))?.events.map((event) => event.key),
		["b"],
	);
});

test("session rows from the first session-shipping build migrate once with sealed batches and receipts (#5344)", async () => {
	const directory = makeTempDirectory("ship-session-upgrade-");
	directories.push(directory);
	const path = join(directory, "legacy.sqlite");
	const legacy = await openNodeSqliteDatabase(path);
	await legacy.exec(`CREATE TABLE ship_events(
		local_seq INTEGER PRIMARY KEY AUTOINCREMENT,
		work TEXT NOT NULL, generation INTEGER NOT NULL, epoch INTEGER NOT NULL,
		event_key TEXT NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL, at INTEGER NOT NULL,
		batch TEXT, op TEXT NOT NULL DEFAULT 'checkpoint', session TEXT, result_seq INTEGER,
		UNIQUE(work, generation, event_key)
	);
	CREATE TABLE ship_lease(work TEXT PRIMARY KEY, generation INTEGER NOT NULL, worker TEXT NOT NULL, epoch INTEGER NOT NULL);
	CREATE TABLE ship_sessions(work TEXT NOT NULL, generation INTEGER NOT NULL, session TEXT NOT NULL, last_seq INTEGER NOT NULL, replay_key TEXT, PRIMARY KEY(work, generation, session));
	INSERT INTO ship_lease VALUES ('work-1', 1, 'host/1', 3);
	INSERT INTO ship_sessions VALUES ('work-1', 1, 's', 2, 'scope:stage');
	INSERT INTO ship_events VALUES (17, 'work-1', 1, 3, 'created', '{}', 'd1', 1, 'sealed', 'session-create', 's', 1);
	INSERT INTO ship_events VALUES (23, 'work-1', 1, 3, 'appended', '{}', '${shipDigest("{}")}', 2, 'sealed', 'session-append', 's', 2);`);
	await legacy.close();
	for (let open = 0; open < 2; open++) {
		const { shard } = await shardAt(path);
		await shard.hold(LEASE, LEASE_MS);
		const batch = await shard.seal(LEASE, 64);
		assert.ok(batch);
		assert.equal(batch.id, "sealed");
		assert.deepEqual(
			batch.events.map((row) => [row.key, row.op]),
			[
				["created", "session-create"],
				["appended", "session-append"],
			],
		);
		assert.equal(
			(
				await shard.accept(ROOT, LEASE, "appended", "{}", 3, {
					op: "session-append",
					session: "s",
					entries: 1,
					expectSeq: 1,
				})
			).lastSeq,
			2,
		);
		assert.deepEqual(await shard.session(LEASE, "s"), { lastSeq: 2, replayKey: "scope:stage" });
		await shard.close();
		const released = await ReleasedShipShard.open(path, ROOT);
		try {
			assert.deepEqual(await released.leftover(), []);
		} finally {
			await released.close();
		}
	}
});

test("a local journal an earlier build wrote is taken up with its checkpoints, as checkpoints (#4768)", async () => {
	const directory = makeTempDirectory("ship-legacy-");
	directories.push(directory);
	const path = join(directory, "legacy.sqlite");
	const legacy = await openNodeSqliteDatabase(path);
	await legacy.exec(`CREATE TABLE ship_events(
		local_seq INTEGER PRIMARY KEY AUTOINCREMENT,
		work TEXT NOT NULL, generation INTEGER NOT NULL, epoch INTEGER NOT NULL,
		event_key TEXT NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL, at INTEGER NOT NULL,
		batch TEXT,
		UNIQUE(work, generation, event_key)
	);
	CREATE TABLE ship_lease(work TEXT PRIMARY KEY, generation INTEGER NOT NULL, worker TEXT NOT NULL, epoch INTEGER NOT NULL);
	INSERT INTO ship_lease VALUES ('work-1', 1, 'host/1', 3);
	INSERT INTO ship_events(work, generation, epoch, event_key, payload, digest, at) VALUES ('work-1', 1, 3, 'k', '{}', 'd', 1);`);
	await legacy.close();
	const { shard } = await shardAt(path);
	const pending = await shard.pending(LEASE);
	assert.deepEqual(
		pending.map((event) => [event.key, event.op]),
		[["k", "checkpoint"]],
	);
	await shard.hold(LEASE, LEASE_MS);
	assert.equal(
		(await shard.accept(ROOT, LEASE, "s", "{}", 1, { op: "session-create", session: "s", entries: 2 })).lastSeq,
		2,
	);
});

test("a stage that ends with a session ships its writes at once, without waiting for the interval (#4768)", async () => {
	const { shard } = await shardAt();
	const shared = fakeShared();
	const shipping = shippingOf(shard, shared.deliver);
	await shipping.hold(LEASE, LEASE_MS);
	await shipping.commit(LEASE, create("c", 1), noShared);
	await shipping.commit(LEASE, append("a", 1, 1), noShared, { operation: "op-1" });
	assert.equal(shared.rows.length, 0);
	await shipping.commit(
		LEASE,
		{ kind: "checkpoint", checkpoint: { ...binding("end"), output: "done" } } as unknown as PoolMutation,
		noShared,
	);
	await vi.waitFor(() =>
		assert.deepEqual(
			shared.rows.map((row) => row.op),
			["session-create", "session-append", "checkpoint"],
		),
	);
});

test.each([
	["create then append", create("c", 2), append("stale", 1, 1)],
	["create then replace", create("c", 2), replace("stale", 1, 1)],
	["append then append", append("a", 2, 3), append("stale", 1, 4)],
	["append then replace", append("a", 2, 3), replace("stale", 1, 4)],
	["replace then append", replace("r", 2, 3), append("stale", 1, 1)],
] as const)("a batch refuses a discontinuous session sequence for %s (#5344)", async (_name, first, stale) => {
	const fold = new PoolSessionFold(LEASE.id, async () =>
		first.kind === "session-create" ? undefined : { work: LEASE.id, replay_key: "scope:stage" },
	);
	await fold.add(first as PoolSessionMutation | PoolSessionAppend);
	const before = structuredClone(fold.writes());
	await assert.rejects(fold.add(stale as PoolSessionMutation | PoolSessionAppend), { name: "SessionConflictError" });
	assert.deepEqual(fold.writes(), before);
});

test("a local journal that cannot say what it holds of a session sends the attempt to the shared journal, once (#4768)", async () => {
	const { shard } = await shardAt();
	const fallbacks: ShippingFallback[] = [];
	const shipping = shippingOf(shard, fakeShared().deliver, {
		sessionState: async () => assert.fail("the attempt commits directly instead"),
		onFallback: (fallback) => fallbacks.push(fallback),
	});
	await shipping.hold(LEASE, LEASE_MS);
	const broken = new Error("disk I/O error");
	shard.session = async () => {
		throw broken;
	};
	let direct = 0;
	const receipt = await shipping.commit(
		LEASE,
		append("a", 1, 3),
		async () => {
			direct++;
			return { at: 1, lastSeq: 4 };
		},
		{ operation: "op-1" },
	);
	assert.deepEqual(receipt, { at: 1, lastSeq: 4 });
	assert.equal(direct, 1);
	assert.deepEqual(fallbacks, [{ workId: LEASE.id, error: broken }]);
	assert.equal(shipping.isSyncOnly(LEASE), true);
});
