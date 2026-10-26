import assert from "node:assert/strict";
import { join } from "node:path";
import { StorageUnavailableError } from "@bastani/atomic/storage";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	DurableNestedTopologyError,
	prepareDurableChildInvocation,
} from "../../packages/workflows/src/durable/boundary-topology.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { type Lease, RUN_EVENT_TYPES } from "../../packages/workflows/src/durable/journal/types.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const header = { runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" };
const { work, boundary } = poolWorkFixture();

async function fixture() {
	const directory = makeTempDirectory("pool-journal-");
	const path = join(directory, "journal.sqlite");
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	await journal.createRun(header);
	const acquired = await journal.acquire(header.runId, "coordinator");
	assert.equal(acquired.status, "acquired");
	const lease = (acquired as { lease: Lease }).lease;
	return {
		database,
		journal,
		lease,
		path,
		async close() {
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}

test("pool control revisions survive recovery and close admission without deleting work (#3869)", async () => {
	const f = await fixture();
	try {
		const pool = await openSqlPoolQueue(f.journal);
		await pool.initialize(f.lease, 60_000);
		const queued = await pool.enqueue(f.lease, work, boundary);
		const paused = await pool.setControl(f.lease, "paused");
		assert.equal(paused.revision, 1);
		assert.equal(await pool.claim(f.lease, "worker", [work], 60_000), undefined);
		const recovered = await openSqlPoolQueue(f.journal);
		assert.deepEqual(await recovered.control(f.lease), paused);
		assert.deepEqual(await recovered.inspect("root"), [queued]);
		await recovered.setControl(f.lease, "running");
		const claimed = (await recovered.claim(f.lease, "worker", [work], 60_000))!;
		await recovered.assertCurrent(f.lease, claimed);
		await assert.rejects(recovered.assertCurrent(f.lease, { ...claimed, generation: 0 }), /Stale work/);
		const quit = await recovered.setControl(f.lease, "quit");
		assert.equal(quit.revision, 3);
		assert.equal((await recovered.inspect("root"))[0]?.id, queued.id);
	} finally {
		await f.close();
	}
});

test("a paused root accepts attempt completion only under a persisted pause (#3869)", async () => {
	const f = await fixture();
	try {
		const pool = await openSqlPoolQueue(f.journal);
		await pool.initialize(f.lease, 60_000);
		await pool.enqueue(f.lease, work, boundary);
		const held = (await pool.claim(f.lease, "worker", [work], 60_000))!;
		const result = { runId: work.childRunId, status: "completed" };
		await f.journal.append(f.lease, { type: RUN_EVENT_TYPES.statusChanged, payload: { status: "paused" } });
		await assert.rejects(pool.complete(f.lease, held, result), /Stale work lease/);
		await pool.setControl(f.lease, "running");
		await assert.rejects(pool.complete(f.lease, held, result), /Stale work lease/);
		await pool.setControl(f.lease, "paused");
		await pool.complete(f.lease, held, result);
		assert.equal((await pool.inspect("root"))[0]?.state, "completed");
		assert.deepEqual(await pool.result("root", held.id), result);
	} finally {
		await f.close();
	}
});

test("child boundary enqueue is atomic, durable and idempotent (#3869)", async () => {
	const f = await fixture();
	try {
		const pool = await openSqlPoolQueue(f.journal);
		await pool.initialize(f.lease, 60_000);
		const first = await pool.enqueue(f.lease, work, boundary);
		assert.equal(first.boundaryId, work.boundaryId);
		assert.equal(
			(
				await f.journal.readKey(
					"root",
					JSON.stringify([RUN_EVENT_TYPES.checkpointRecorded, "stage", boundary.checkpointId]),
				)
			)?.event.type,
			RUN_EVENT_TYPES.checkpointRecorded,
		);
		assert.deepEqual(await pool.enqueue(f.lease, work, boundary), first);
		await assert.rejects(pool.enqueue(f.lease, { ...work, digest: "changed" }, boundary), /identity conflict/);
		await f.database.exec(
			`CREATE TRIGGER reject_boundary BEFORE INSERT ON wf_events WHEN NEW.key = '["CheckpointRecorded","stage","boundary-start:workflow:rollback:0"]' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
		);
		const rollback = poolWorkFixture("rollback");
		await assert.rejects(
			pool.enqueue(f.lease, rollback.work, rollback.boundary),
			(error: Error) =>
				error instanceof StorageUnavailableError &&
				error.cause instanceof Error &&
				error.cause.message === "injected failure",
		);
		assert.equal((await pool.inspect("root")).length, 1);
		const secondDatabase = await openNodeSqliteDatabase(f.path);
		const second = await SqlRunJournal.open(secondDatabase);
		try {
			assert.deepEqual(await (await openSqlPoolQueue(second)).inspect("root"), [first]);
		} finally {
			await second.close();
			await secondDatabase.close();
		}
	} finally {
		await f.close();
	}
});

test("queue rejects missing invocation fingerprints without publishing a boundary (#3869)", async () => {
	const f = await fixture();
	try {
		await f.journal.append(f.lease, {
			type: RUN_EVENT_TYPES.runStarted,
			payload: { workflowId: "root", name: "root", inputs: {}, createdAt: 0, status: "running" },
		});
		const pool = await openSqlPoolQueue(f.journal);
		await pool.initialize(f.lease, 60_000);
		const malformed = structuredClone(boundary);
		Reflect.deleteProperty(malformed.topology!.boundary!, "invocationFingerprint");
		await assert.rejects(pool.enqueue(f.lease, work, malformed), (error: Error) => {
			assert.ok(error instanceof DurableNestedTopologyError);
			assert.equal(error.reason, `missing invocation fingerprint at ${boundary.checkpointId}`);
			return true;
		});
		assert.deepEqual(await pool.inspect("root"), []);
		assert.equal(
			await f.journal.readKey(
				"root",
				JSON.stringify([RUN_EVENT_TYPES.checkpointRecorded, "stage", boundary.checkpointId]),
			),
			undefined,
		);
		const valid = await pool.enqueue(f.lease, work, boundary);
		const secondDatabase = await openNodeSqliteDatabase(f.path);
		try {
			const second = await SqlRunJournal.open(secondDatabase);
			const backend = await JournalDurableBackend.open(second);
			try {
				assert.deepEqual(await (await openSqlPoolQueue(second)).inspect("root"), [valid]);
				assert.deepEqual(backend.listCheckpoints("root"), [boundary]);
			} finally {
				await backend.close();
			}
		} finally {
			await secondDatabase.close();
		}
	} finally {
		await f.close();
	}
});

test.each([
	["source order", "topology", "sourceOrder", undefined],
	["topology version", "topology", "version", 2],
	["topology status", "topology", "status", "completed"],
	["boundary version", "boundary", "version", 2],
	["boundary status", "boundary", "status", "completed"],
])("queue rejects malformed boundary %s before publishing resumable work (#3869)", async (_, target, key, value) => {
	const f = await fixture();
	try {
		await f.journal.append(f.lease, {
			type: RUN_EVENT_TYPES.runStarted,
			payload: { workflowId: "root", name: "root", inputs: {}, createdAt: 0, status: "running" },
		});
		const pool = await openSqlPoolQueue(f.journal);
		await pool.initialize(f.lease, 60_000);
		const malformed = structuredClone(boundary);
		const topology = target === "topology" ? malformed.topology! : malformed.topology!.boundary!;
		if (value === undefined) Reflect.deleteProperty(topology, String(key));
		else Reflect.set(topology, String(key), value);
		await assert.rejects(pool.enqueue(f.lease, work, malformed), /boundary/i);
		assert.deepEqual(await pool.inspect("root"), []);
		assert.equal(
			await f.journal.readKey(
				"root",
				JSON.stringify([RUN_EVENT_TYPES.checkpointRecorded, "stage", boundary.checkpointId]),
			),
			undefined,
		);
		assert.equal(await pool.claim(f.lease, "worker", [work], 60_000), undefined);
		const valid = await pool.enqueue(f.lease, work, boundary);
		const secondDatabase = await openNodeSqliteDatabase(f.path);
		try {
			const second = await SqlRunJournal.open(secondDatabase);
			const backend = await JournalDurableBackend.open(second);
			try {
				const invocation = prepareDurableChildInvocation({
					workflowId: "root",
					rootWorkflowId: "root",
					backend,
					replayKey: work.scope,
					boundaryName: "child",
					alias: "child",
					workflow: "child",
					childRunName: "child",
					invocationFingerprint: "fingerprint",
					runTopology: boundary.topology!.run!,
				});
				assert.equal(invocation.identity.sourceOrder, 0);
				assert.equal(invocation.identity.childRunId, work.childRunId);
				await invocation.recordStart([], 0);
				assert.deepEqual(await (await openSqlPoolQueue(second)).inspect("root"), [valid]);
			} finally {
				await backend.close();
			}
		} finally {
			await secondDatabase.close();
		}
	} finally {
		await f.close();
	}
});

test("independent connections claim once and fence lease renewals and expiry (#3869)", async () => {
	const f = await fixture();
	const otherDatabase = await openNodeSqliteDatabase(f.path);
	const other = await SqlRunJournal.open(otherDatabase);
	try {
		const pool = await openSqlPoolQueue(f.journal);
		const peer = await openSqlPoolQueue(other);
		await pool.initialize(f.lease, 60_000);
		await pool.enqueue(f.lease, work, boundary);
		assert.equal(
			await peer.claim(f.lease, "incompatible", [{ definition: work.definition, digest: "wrong" }], 60_000),
			undefined,
		);
		const claims = await Promise.all([
			pool.claim(f.lease, "one", [work], 60_000),
			peer.claim(f.lease, "two", [work], 60_000),
		]);
		assert.equal(claims.filter(Boolean).length, 1);
		const held = claims.find((claim) => claim !== undefined)!;
		assert.equal(held.generation, 1);
		assert.ok(held.expiresAt > 0);
		assert.ok(held.renewedAt > 0);
		assert.equal(held.expiresAt - held.renewedAt, 60_000);
		const renewed = await pool.renew(f.lease, held, 60_000);
		const later = await peer.renew(f.lease, held, 70_000);
		assert.ok(later.expiresAt > renewed.expiresAt);
		assert.equal((await peer.renew(f.lease, held, 60_000)).expiresAt, later.expiresAt, "renewal never shortens");
		assert.equal((await pool.inspect("root"))[0]?.expiresAt, later.expiresAt);
		assert.equal(await pool.expire(f.lease, held), false);
		await f.database.run("UPDATE wf_runs_work SET expires_at = 0");
		await assert.rejects(pool.renew(f.lease, held, 60_000), /stale work lease/i);
		assert.equal(await pool.expire(f.lease, held), true);
		const replacement = await peer.claim(f.lease, "two", [work], 60_000);
		assert.equal(replacement?.generation, 2);
		assert.ok(replacement);
		assert.equal((await pool.renew(f.lease, replacement, 60_000)).generation, 2);
		await assert.rejects(pool.renew(f.lease, held, 60_000), /stale work lease/i);
		await assert.rejects(pool.expire(f.lease, held), /stale work lease/i);
	} finally {
		await other.close();
		await otherDatabase.close();
		await f.close();
	}
});

test.each(["renew", "expire"] as const)("same-worker generation fences stale %s (#3869)", async (operation) => {
	const f = await fixture();
	try {
		const pool = await openSqlPoolQueue(f.journal);
		await pool.initialize(f.lease, 60_000);
		await pool.enqueue(f.lease, work, boundary);
		const held = await pool.claim(f.lease, "worker", [work], 60_000);
		assert.ok(held);
		await f.database.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", held.id);
		assert.equal(await pool.expire(f.lease, held), true);
		const replacement = await pool.claim(f.lease, "worker", [work], 60_000);
		assert.ok(replacement);
		assert.equal(replacement.id, held.id);
		assert.equal(replacement.worker, held.worker);
		assert.equal(replacement.epoch, held.epoch);
		assert.equal(replacement.generation, held.generation + 1);
		await assert.rejects(
			operation === "renew" ? pool.renew(f.lease, held, 60_000) : pool.expire(f.lease, held),
			/Stale work lease/,
		);
		assert.deepEqual(await pool.inspect("root"), [replacement]);
		assert.equal((await pool.renew(f.lease, replacement, 60_000)).generation, replacement.generation);
		await f.database.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", replacement.id);
		assert.equal(await pool.expire(f.lease, replacement), true);
	} finally {
		await f.close();
	}
});

test.each(["initialize", "enqueue", "claim", "renew", "expire"] as const)(
	"same-holder coordinator epoch fences stale %s (#3869)",
	async (operation) => {
		const f = await fixture();
		try {
			const pool = await openSqlPoolQueue(f.journal);
			await pool.initialize(f.lease, 60_000);
			await pool.enqueue(f.lease, work, boundary);
			const held = await pool.claim(f.lease, "worker", [work], 60_000);
			assert.ok(held);
			await f.journal.release(f.lease);
			const reacquired = await f.journal.acquire(f.lease.runId, f.lease.holderId);
			assert.equal(reacquired.status, "acquired");
			if (reacquired.status !== "acquired") assert.fail("reacquisition failed");
			assert.equal(reacquired.lease.holderId, f.lease.holderId);
			assert.equal(reacquired.lease.epoch, f.lease.epoch + 1);
			await pool.initialize(reacquired.lease, 60_000);
			const staleMutations = {
				initialize: () => pool.initialize(f.lease, 60_000),
				enqueue: () => pool.enqueue(f.lease, work, boundary),
				claim: () => pool.claim(f.lease, "worker", [work], 60_000),
				renew: () => pool.renew(f.lease, held, 60_000),
				expire: () => pool.expire(f.lease, held),
			};
			await assert.rejects(staleMutations[operation](), /Stale lease/);
			assert.deepEqual(await pool.inspect("root"), [held]);
			assert.equal(await pool.expire(reacquired.lease, held), true);
			assert.equal(await pool.claim(reacquired.lease, "worker", [work], 60_000), undefined);
			// The resumed root re-enqueues its child before any worker may claim it (#3979).
			await pool.enqueue(reacquired.lease, work, boundary);
			const replacement = await pool.claim(reacquired.lease, "worker", [work], 60_000);
			assert.ok(replacement);
			assert.equal(replacement.epoch, reacquired.lease.epoch);
			assert.equal((await pool.renew(reacquired.lease, replacement, 60_000)).generation, replacement.generation);
		} finally {
			await f.close();
		}
	},
);

test("coordinator expiry and takeover fence every queue mutation; paused roots grant no claims (#3869)", async () => {
	const f = await fixture();
	try {
		const pool = await openSqlPoolQueue(f.journal);
		await pool.initialize(f.lease, 60_000);
		await assert.rejects(pool.initialize(f.lease, 1), /immutable/);
		await pool.enqueue(f.lease, work, boundary);
		await f.journal.append(f.lease, { type: RUN_EVENT_TYPES.statusChanged, payload: { status: "paused" } });
		assert.equal(await pool.claim(f.lease, "worker", [work], 60_000), undefined);
		await f.journal.append(f.lease, { type: RUN_EVENT_TYPES.statusChanged, payload: { status: "running" } });
		const held = (await pool.claim(f.lease, "worker", [work], 60_000))!;
		await f.database.run("UPDATE wf_leases SET renewed_at = 0");
		await assert.rejects(pool.claim(f.lease, "worker", [work], 60_000), /Stale lease/);
		await assert.rejects(pool.renew(f.lease, held, 60_000), /Stale lease/);
		const takeover = await f.journal.takeoverExpired("root", "new-coordinator", 60_000);
		assert.equal(takeover.status, "acquired");
		if (takeover.status !== "acquired") assert.fail("takeover failed");
		await pool.initialize(takeover.lease, 60_000);
		await assert.rejects(pool.enqueue(f.lease, work, boundary), /Stale lease/);
		await assert.rejects(pool.expire(f.lease, held), /Stale lease/);
		await assert.rejects(pool.renew(takeover.lease, held, 60_000), /Stale work lease/);
		assert.equal(await pool.expire(takeover.lease, held), true);
		// The resumed root re-enqueues its child before any worker may claim it (#3979).
		await pool.enqueue(takeover.lease, work, boundary);
		const next = await pool.claim(takeover.lease, "worker", [work], 60_000);
		assert.equal(next?.epoch, takeover.lease.epoch);
		assert.equal(next?.generation, held.generation + 1);
		await f.journal.deleteOwnedRun(takeover.lease);
		assert.deepEqual(await pool.inspect("root"), []);
	} finally {
		await f.close();
	}
});

test("pool schema is lazy, versioned and prefix-isolated (#3869)", async () => {
	const f = await fixture();
	try {
		assert.deepEqual(await f.database.all("SELECT name FROM sqlite_master WHERE name LIKE '%pool%'"), []);
		const prefixed = await SqlRunJournal.open(f.database, { prefix: "isolated_" });
		await openSqlPoolQueue(prefixed);
		await openSqlPoolQueue(f.journal);
		await f.database.run("UPDATE wf_runs_pool_meta SET version = 999");
		await assert.rejects(openSqlPoolQueue(f.journal), /schema version/i);
		await openSqlPoolQueue(prefixed);
		await f.journal.createRun({ ...header, runId: "ordinary" });
		assert.ok(await f.journal.getRun("ordinary"));
		await prefixed.close();
	} finally {
		await f.close();
	}
});

test("queue rejects missing initialization and mismatched child boundaries (#3869)", async () => {
	const f = await fixture();
	try {
		const pool = await openSqlPoolQueue(f.journal);
		await assert.rejects(pool.enqueue(f.lease, work, boundary), /not initialized/);
		await pool.initialize(f.lease, 60_000);
		await assert.rejects(pool.enqueue(f.lease, { ...work, childRunId: "unrelated" }, boundary), /boundary/);
		await assert.rejects(pool.enqueue(f.lease, work, { ...boundary, checkpointId: "wrong" }), /boundary/);
		await assert.rejects(pool.enqueue(f.lease, work, { ...boundary, workflowId: "wrong" }), /boundary/);
		await pool.enqueue(f.lease, work, boundary);
		for (const duplicate of [
			poolWorkFixture("duplicate", work.childRunId),
			poolWorkFixture("duplicate-scope", "other-child", work.scope),
		]) {
			await assert.rejects(pool.enqueue(f.lease, duplicate.work, duplicate.boundary), /identity conflict/);
		}
		assert.equal((await pool.inspect("root")).length, 1);
	} finally {
		await f.close();
	}
});

test("a new coordinator epoch releases every attempt leased by the previous incarnation (#3890)", async () => {
	const f = await fixture();
	try {
		const pool = await openSqlPoolQueue(f.journal);
		await pool.initialize(f.lease, 60_000);
		await pool.enqueue(f.lease, work, boundary);
		const held = (await pool.claim(f.lease, "dead-worker", [work], 60_000))!;
		await f.database.run("UPDATE wf_leases SET renewed_at = 0");
		const takeover = await f.journal.takeoverExpired("root", "resumed-coordinator", 60_000);
		if (takeover.status !== "acquired") assert.fail("takeover failed");
		assert.equal(await pool.releasePreviousIncarnations(f.lease).catch(() => "fenced"), "fenced");
		assert.equal(await pool.releasePreviousIncarnations(takeover.lease), 1);
		const [released] = await pool.inspect("root");
		assert.equal(released?.state, "ready");
		assert.equal(released?.worker, null);
		await assert.rejects(pool.renew(takeover.lease, held, 60_000), /Stale work lease/);
		assert.equal(await pool.claim(takeover.lease, "resumed-worker", [work], 60_000), undefined);
		// The resumed root re-enqueues its child before any worker may claim it (#3979).
		await pool.enqueue(takeover.lease, work, boundary);
		const next = await pool.claim(takeover.lease, "resumed-worker", [work], 60_000);
		assert.equal(next?.epoch, takeover.lease.epoch);
		assert.equal(next?.generation, held.generation + 1);
		assert.equal(await pool.releasePreviousIncarnations(takeover.lease), 0);
	} finally {
		await f.close();
	}
});

test("work a closed pool left unfinished, or failed, is unclaimable until a resumed root enqueues it again (#3996)", async () => {
	const f = await fixture();
	try {
		const pool = await openSqlPoolQueue(f.journal);
		await pool.initialize(f.lease, 60_000);
		await pool.enqueue(f.lease, work, boundary);
		const held = (await pool.claim(f.lease, "worker", [work], 60_000))!;
		assert.equal(await pool.failExited(f.lease, held), true);
		assert.equal((await pool.inspect("root"))[0]?.state, "failed");
		assert.equal(await pool.claim(f.lease, "worker", [work], 60_000), undefined, "no worker claims failed work");
		assert.equal(await pool.releaseClosed(f.lease), 0);
		await f.database.run("UPDATE wf_leases SET renewed_at = 0");
		const takeover = await f.journal.takeoverExpired("root", "resumed-coordinator", 60_000);
		if (takeover.status !== "acquired") assert.fail("takeover failed");
		await pool.enqueue(takeover.lease, work, boundary);
		const replay = await pool.claim(takeover.lease, "resumed-worker", [work], 60_000);
		assert.equal(replay?.generation, held.generation + 1);
		// A pool closing without a quit settles what its root left unfinished, claimed or not.
		assert.equal(await pool.releaseClosed(takeover.lease), 1);
		assert.deepEqual(
			(await pool.inspect("root")).map((item) => item.state),
			["failed"],
		);
	} finally {
		await f.close();
	}
});

test("extending a live worker's lease survives a coordinator stall past expiry but not reassignment (#3888)", async () => {
	const f = await fixture();
	try {
		const pool = await openSqlPoolQueue(f.journal);
		await pool.initialize(f.lease, 60_000);
		await pool.enqueue(f.lease, work, boundary);
		const held = (await pool.claim(f.lease, "live-worker", [work], 60_000))!;
		await f.database.run("UPDATE wf_runs_work SET expires_at = 1");
		const extended = await pool.extend(f.lease, held, 60_000);
		assert.equal(extended.generation, held.generation);
		assert.equal(extended.expiresAt - extended.renewedAt, 60_000);
		assert.equal(await pool.expire(f.lease, held), false);
		await f.database.run("UPDATE wf_runs_work SET expires_at = 1");
		assert.equal(await pool.expire(f.lease, held), true);
		await assert.rejects(pool.extend(f.lease, held, 60_000), /Stale work lease/);
		const replacement = (await pool.claim(f.lease, "replacement", [work], 60_000))!;
		await assert.rejects(pool.extend(f.lease, held, 60_000), /Stale work lease/);
		assert.equal((await pool.extend(f.lease, replacement, 60_000)).worker, "replacement");
	} finally {
		await f.close();
	}
});

test("lease renewals and extensions grow the journal by no rows however long a worker runs (#3903)", async () => {
	const f = await fixture();
	try {
		const pool = await openSqlPoolQueue(f.journal);
		await pool.initialize(f.lease, 60_000);
		await pool.enqueue(f.lease, work, boundary);
		const held = (await pool.claim(f.lease, "worker", [work], 60_000))!;
		const rows = async () => {
			const tables = await f.database.all("SELECT name FROM sqlite_master WHERE type = 'table'");
			let total = 0;
			for (const { name } of tables)
				total += Number((await f.database.get(`SELECT COUNT(*) AS count FROM "${String(name)}"`))!.count);
			return total;
		};
		const before = await rows();
		let renewed = held;
		for (let beat = 0; beat < 50; beat++) {
			renewed = await pool.renew(f.lease, renewed, 60_000);
			renewed = await pool.extend(f.lease, renewed, 60_000);
		}
		assert.equal(await rows(), before);
		assert.equal((await f.database.get("SELECT COUNT(*) AS count FROM wf_runs_pool_operations"))!.count, 0);
		assert.equal((await pool.inspect("root"))[0]?.renewedAt, renewed.renewedAt);
	} finally {
		await f.close();
	}
});
