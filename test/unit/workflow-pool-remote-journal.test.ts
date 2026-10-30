import assert from "node:assert/strict";
import { join } from "node:path";
import type { SessionEntry } from "@bastani/atomic";
import { test, vi } from "vitest";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { PoolCheckpointIndex } from "../../packages/workflows/src/durable/journal/pool-checkpoint-index.js";
import { PoolRemoteJournal } from "../../packages/workflows/src/durable/journal/pool-remote-journal.js";
import { openSqlPoolQueue, STALE_WORK_LEASE } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	type JournalEntry,
	type Lease,
	RUN_EVENT_TYPES,
	StaleLeaseError,
} from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableStageCheckpoint, DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const { work, boundary } = poolWorkFixture();
const run = { ...boundary.topology!.boundary!.child };
const tool: DurableToolCheckpoint = {
	kind: "tool",
	workflowId: "root",
	checkpointId: `${work.scope}:tool:1`,
	name: "tool",
	argsHash: `${work.scope}:args`,
	output: { saved: true },
	completedAt: 1,
	topology: { version: 1, nodeId: "tool", parentIds: [], ordinal: 0, order: 0, run },
};
const stage: DurableStageCheckpoint = {
	kind: "stage",
	workflowId: "root",
	checkpointId: `${work.scope}:session:0`,
	name: "stage",
	replayKey: `${work.scope}:stage`,
	sessionId: "session",
	completedAt: 0,
	topology: { version: 1, stageId: "stage", parentIds: [], sourceOrder: 0, run },
};
const header = { id: "session", version: 4 as const, createdAt: "2026-01-01T00:00:00Z", cwd: "/gone/scratch" };
const messages: SessionEntry[] = [
	{
		type: "message",
		id: "message",
		parentId: null,
		timestamp: header.createdAt,
		message: { role: "user", content: "durable prompt", timestamp: 1 },
	},
];
const checkpointKey = (checkpoint: { kind: string; checkpointId: string }) =>
	JSON.stringify([RUN_EVENT_TYPES.checkpointRecorded, checkpoint.kind, checkpoint.checkpointId]);

/**
 * The root's durable journal is an in-memory run journal, which no SQL transaction reaches, so the pool's database is
 * a separate SQLite file, as it is when the journal is a libSQL database or another storage adapter.
 */
async function fixture() {
	const directory = makeTempDirectory("pool-remote-journal-");
	const durable = new MemoryRunJournal({ adapter: "remote", location: "memory" });
	await durable.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
	const acquired = await durable.acquire("root", "holder");
	assert.equal(acquired.status, "acquired");
	if (acquired.status !== "acquired") assert.fail("No root lease");
	const lease = acquired.lease;
	const coordination = await openSqlRunJournal(join(directory, "pool.sqlite"));
	const storage = sqlPoolStorage(coordination)!;
	/** A coordinator process: its own handle on the durable journal and on the pool's database. */
	const open = async () => {
		const remote = new PoolRemoteJournal(durable, storage);
		await remote.mirror(lease);
		const pool = await openSqlPoolQueue(coordination, remote);
		await pool.initialize(lease, 60_000);
		return { remote, pool };
	};
	const first = await open();
	await first.pool.enqueue(lease, work, boundary);
	const attempt = (await first.pool.claim(lease, "worker", [work], 60_000))!;
	assert.ok(attempt);
	const events = async (): Promise<JournalEntry[]> => {
		const entries: JournalEntry[] = [];
		for await (const entry of durable.read("root")) entries.push(entry);
		return entries;
	};
	const poolEvents = async () =>
		Number((await storage.read((tx) => tx.get("SELECT COUNT(*) AS count FROM wf_events")))?.count);
	return {
		directory,
		durable,
		coordination,
		storage,
		lease,
		attempt,
		...first,
		open,
		events,
		poolEvents,
		close: async () => {
			await coordination.close();
			removeTempDirectory(directory);
		},
	};
}

const toolMutation = { kind: "checkpoint" as const, checkpoint: tool };
const sessionMutation = { kind: "session-create" as const, checkpoint: stage, header, entries: messages };

test("a pooled child's boundary start and checkpoints go to the durable journal, and nothing else does", async () => {
	const f = await fixture();
	try {
		const recordedStart = (await f.events()).filter((entry) => entry.key === checkpointKey(boundary));
		assert.equal(recordedStart.length, 1, "the boundary's start is the journal's event");
		// Enqueueing the boundary again, as a resumed root does, records nothing new and keeps the same work.
		assert.equal((await f.pool.enqueue(f.lease, work, boundary)).id, f.attempt.id);
		assert.equal((await f.events()).length, 1);

		const receipt = await f.pool.commit(f.lease, f.attempt, "tool", toolMutation);
		const entries = await f.events();
		assert.deepEqual(
			entries.map((entry) => entry.key),
			[checkpointKey(boundary), checkpointKey(tool)],
		);
		assert.equal(receipt.seq, entries[1]!.seq);
		assert.equal(receipt.at, entries[1]!.at);
		assert.equal(entries[1]!.epoch, f.lease.epoch);
		assert.equal(await f.poolEvents(), 0, "the pool's own database holds no journal events");
		// A retry of the operation answers from its stored receipt and records nothing.
		assert.deepEqual(await f.pool.commit(f.lease, f.attempt, "tool", toolMutation), receipt);
		assert.equal((await f.events()).length, 2);
		// The same operation with another request is refused, and a changed checkpoint under the key is a conflict.
		await assert.rejects(
			f.pool.commit(f.lease, f.attempt, "tool", {
				kind: "checkpoint",
				checkpoint: { ...tool, output: "changed" },
			}),
			/operation identity conflict/,
		);
		await assert.rejects(
			f.pool.commit(f.lease, f.attempt, "other", {
				kind: "checkpoint",
				checkpoint: { ...tool, output: "changed" },
			}),
			/checkpoint identity conflict/,
		);
		assert.equal((await f.events()).length, 2);
	} finally {
		await f.close();
	}
});

test("a commit whose journal write fails keeps what it accepted, and the same operation finishes it once", async () => {
	const f = await fixture();
	try {
		const unavailable = vi.spyOn(f.durable, "append").mockRejectedValueOnce(new Error("journal unavailable"));
		await assert.rejects(f.pool.commit(f.lease, f.attempt, "create", sessionMutation), /journal unavailable/);
		unavailable.mockRestore();
		assert.equal((await f.events()).filter((entry) => entry.key === checkpointKey(stage)).length, 0);
		// Accepted: the session exists in the pool's database and the usage is billed, but the journal has no event.
		assert.ok(await f.storage.read((tx) => tx.get("SELECT 1 AS held FROM wf_runs_pool_outbox")));

		const receipt = await f.pool.commit(f.lease, f.attempt, "create", sessionMutation);
		const recorded = (await f.events()).filter((entry) => entry.key === checkpointKey(stage));
		assert.equal(recorded.length, 1, "the journal records the checkpoint once");
		assert.equal(receipt.seq, recorded[0]!.seq);
		assert.equal(receipt.lastSeq, 1, "the session's own sequence comes back with the journal's");
		assert.equal(await f.storage.read((tx) => tx.get("SELECT 1 AS held FROM wf_runs_pool_outbox")), undefined);
		assert.deepEqual(await f.pool.commit(f.lease, f.attempt, "create", sessionMutation), receipt);
		assert.equal((await f.events()).filter((entry) => entry.key === checkpointKey(stage)).length, 1);
	} finally {
		await f.close();
	}
});

test("a restarted coordinator delivers what an earlier one accepted before any work is handed out", async () => {
	const f = await fixture();
	try {
		vi.spyOn(f.durable, "append").mockRejectedValueOnce(new Error("journal unavailable"));
		await assert.rejects(f.pool.commit(f.lease, f.attempt, "tool", toolMutation), /journal unavailable/);
		vi.restoreAllMocks();
		assert.equal((await f.events()).filter((entry) => entry.key === checkpointKey(tool)).length, 0);

		// The coordinator dies with the attempt; the next incarnation of the pool opens the same database.
		const restarted = await f.open();
		assert.equal(await restarted.pool.releaseExited(f.lease, f.attempt), true);
		const next = await restarted.pool.claim(f.lease, "replacement", [work], 60_000);
		assert.ok(next, "the replacement attempt is handed the work");
		assert.equal(next.generation, f.attempt.generation + 1);
		const recorded = (await f.events()).filter((entry) => entry.key === checkpointKey(tool));
		assert.equal(recorded.length, 1, "the accepted checkpoint reached the journal before the claim returned");

		// The replacement replays the child and commits the same checkpoint: the journal keeps the first event.
		const replay = await restarted.pool.commit(f.lease, next, "tool-again", {
			kind: "checkpoint",
			checkpoint: { ...tool, completedAt: 2 },
		});
		assert.equal(replay.seq, recorded[0]!.seq);
		assert.equal((await f.events()).filter((entry) => entry.key === checkpointKey(tool)).length, 1);
	} finally {
		await f.close();
	}
});

test("a delivery that waits is never lost to a fence that lands meanwhile, and a fence before acceptance refuses the write", async () => {
	const f = await fixture();
	try {
		const append = f.durable.append.bind(f.durable);
		const reached = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		vi.spyOn(f.durable, "append").mockImplementationOnce(async (...args) => {
			reached.resolve();
			await proceed.promise;
			return append(...args);
		});
		const committing = f.pool.commit(f.lease, f.attempt, "tool", toolMutation);
		await reached.promise;
		// Accepted under a current attempt; its worker is declared lost before the journal answers.
		assert.equal(await f.pool.releaseExited(f.lease, f.attempt), true);
		proceed.resolve();
		const receipt = await committing;
		const recorded = (await f.events()).filter((entry) => entry.key === checkpointKey(tool));
		assert.equal(recorded.length, 1);
		assert.equal(receipt.seq, recorded[0]!.seq);
		vi.restoreAllMocks();

		// A write the fenced attempt makes now is refused before anything exists for it.
		const before = (await f.events()).length;
		await assert.rejects(
			f.pool.commit(f.lease, f.attempt, "more", {
				kind: "checkpoint",
				checkpoint: { ...tool, checkpointId: `${work.scope}:tool:2`, argsHash: `${work.scope}:args2` },
			}),
			new RegExp(STALE_WORK_LEASE),
		);
		assert.equal((await f.events()).length, before);
		assert.equal(await f.storage.read((tx) => tx.get("SELECT 1 AS held FROM wf_runs_pool_outbox")), undefined);
	} finally {
		await f.close();
	}
});

test("a root whose lease the journal gave away is refused by the pool, and its accepted events wait for a holder", async () => {
	const f = await fixture();
	try {
		vi.spyOn(f.durable, "append").mockRejectedValueOnce(new Error("journal unavailable"));
		await assert.rejects(f.pool.commit(f.lease, f.attempt, "tool", toolMutation), /journal unavailable/);
		vi.restoreAllMocks();

		// Another holder takes the root over in the journal.
		const taken = await f.durable.takeover("root", "next-holder", "holder");
		assert.equal(taken.status, "acquired");
		if (taken.status !== "acquired") assert.fail("No takeover");
		await assert.rejects(f.remote.mirror(f.lease), StaleLeaseError);
		await assert.rejects(f.pool.claim(f.lease, "other", [work], 60_000), StaleLeaseError);
		await assert.rejects(f.pool.drainOutbox(f.lease), StaleLeaseError);
		assert.equal((await f.events()).filter((entry) => entry.key === checkpointKey(tool)).length, 0);

		// Its next incarnation, on this machine, mirrors the new holder's lease and delivers under it.
		const remote = new PoolRemoteJournal(f.durable, f.storage);
		await remote.mirror(taken.lease);
		const pool = await openSqlPoolQueue(f.coordination, remote);
		await pool.initialize(taken.lease, 60_000);
		assert.equal(await pool.drainOutbox(taken.lease), 1);
		const [recorded] = (await f.events()).filter((entry) => entry.key === checkpointKey(tool));
		assert.equal(recorded?.epoch, taken.lease.epoch);
	} finally {
		await f.close();
	}
});

test("a different checkpoint already under the key is a conflict that applies nothing, and a child never completes with events outstanding", async () => {
	const f = await fixture();
	try {
		await f.durable.append(
			f.lease,
			{ type: RUN_EVENT_TYPES.checkpointRecorded, payload: { ...stage, name: "someone else's" } as never },
			{ key: checkpointKey(stage) },
		);
		await assert.rejects(
			f.pool.commit(f.lease, f.attempt, "create", sessionMutation),
			/checkpoint identity conflict/,
		);
		assert.equal(
			await f.storage.read((tx) => tx.get("SELECT 1 AS held FROM wf_runs_pool_session_owners")),
			undefined,
			"no session was created for a checkpoint the journal will not take",
		);

		vi.spyOn(f.durable, "append").mockRejectedValueOnce(new Error("journal unavailable"));
		await assert.rejects(f.pool.commit(f.lease, f.attempt, "tool", toolMutation), /journal unavailable/);
		vi.restoreAllMocks();
		await assert.rejects(
			f.pool.complete(f.lease, f.attempt, { runId: work.childRunId, status: "completed" } as never),
			/journal events not yet recorded/,
		);
		await f.pool.drainOutbox(f.lease);
		await f.pool.complete(f.lease, f.attempt, { runId: work.childRunId, status: "completed" } as never);
	} finally {
		await f.close();
	}
});

test("duplicate deliveries of one operation share a single journal write", async () => {
	const f = await fixture();
	try {
		const append = vi.spyOn(f.durable, "append");
		const [one, two] = await Promise.all([
			f.pool.commit(f.lease, f.attempt, "tool", toolMutation),
			f.pool.commit(f.lease, f.attempt, "tool", toolMutation),
		]);
		assert.deepEqual(one, two);
		assert.equal(
			append.mock.calls.filter(([, event]) => event.type === RUN_EVENT_TYPES.checkpointRecorded).length,
			1,
		);
	} finally {
		await f.close();
	}
});

test("the pool validates against checkpoints other writers recorded in the durable journal", async () => {
	const f = await fixture();
	try {
		// A checkpoint of this child recorded by someone else, such as an earlier incarnation's coordinator.
		const earlier = { ...tool, checkpointId: `${work.scope}:tool:0`, argsHash: `${work.scope}:args0`, order: 0 };
		await f.durable.append(
			f.lease,
			{ type: RUN_EVENT_TYPES.checkpointRecorded, payload: earlier as never },
			{ key: checkpointKey(earlier) },
		);
		// A tool checkpoint's topology is validated against the child's recorded ones: node `tool` repeats under
		// another arguments hash, which the validation reads from the journal and refuses.
		await assert.rejects(
			f.pool.commit(f.lease, f.attempt, "clash", {
				kind: "checkpoint",
				checkpoint: { ...tool, checkpointId: `${work.scope}:tool:clash`, argsHash: `${work.scope}:args-clash` },
			}),
			/Pool tool topology scope mismatch/,
		);
	} finally {
		await f.close();
	}
});

test("a lease the journal still holds keeps the pool's copy fresh, and one it lost fails the pool's next write", async () => {
	const f = await fixture();
	try {
		const lease: Lease = f.lease;
		await f.remote.fresh(lease, 0);
		assert.ok(await f.pool.renew(lease, f.attempt, 60_000));
		await f.durable.release(lease);
		await assert.rejects(f.remote.fresh(lease, 0), StaleLeaseError);
		await assert.rejects(f.pool.renew(lease, f.attempt, 60_000), StaleLeaseError);
	} finally {
		await f.close();
	}
});

function checkpointEntry(seq: number, at: number, checkpointId: string): JournalEntry {
	const checkpoint = { ...tool, checkpointId, argsHash: `${checkpointId}:args` };
	return {
		runId: "root",
		seq,
		epoch: 1,
		key: checkpointKey(checkpoint),
		event: { type: RUN_EVENT_TYPES.checkpointRecorded, payload: checkpoint as never },
		at,
	};
}

test("the checkpoint index reads a remote journal from its watermark, and starts over when the root was replaced", async () => {
	const index = new PoolCheckpointIndex();
	const journal = (entries: readonly JournalEntry[], asked: number[]) =>
		async function* (from: number) {
			asked.push(from);
			for (const entry of entries) if (entry.seq >= from) yield entry;
		};
	const ids = (view: {
		entries(partition: "byRun", key: string): readonly { checkpoint: { checkpointId: string } }[];
	}) => view.entries("byRun", run.runId).map((entry) => entry.checkpoint.checkpointId);
	const history = [checkpointEntry(1, 10, "a"), checkpointEntry(2, 20, "b"), checkpointEntry(3, 30, "c")];

	const first: number[] = [];
	const read = index.begin("root");
	assert.deepEqual(ids(await read.readEntries(journal(history, first))), ["a", "b", "c"]);
	read.commit();
	assert.deepEqual(first, [1]);

	// One more event: only the watermark and what follows is read.
	const grown: number[] = [];
	const more = index.begin("root");
	assert.deepEqual(ids(await more.readEntries(journal([...history, checkpointEntry(4, 40, "d")], grown))), [
		"a",
		"b",
		"c",
		"d",
	]);
	more.commit();
	assert.deepEqual(grown, [3]);

	// The root's history was deleted and recorded again: the watermark's event is not the same event, so all is re-read.
	const replaced: number[] = [];
	const again = index.begin("root");
	const other = [
		checkpointEntry(1, 11, "x"),
		checkpointEntry(2, 21, "y"),
		checkpointEntry(3, 31, "z"),
		checkpointEntry(4, 41, "w"),
	];
	assert.deepEqual(ids(await again.readEntries(journal(other, replaced))), ["x", "y", "z", "w"]);
	assert.deepEqual(replaced, [4, 1]);
	// A history shorter than the watermark is replaced too.
	again.commit();
	const shorter: number[] = [];
	assert.deepEqual(ids(await index.begin("root").readEntries(journal(other.slice(0, 2), shorter))), ["x", "y"]);
	assert.deepEqual(shorter, [4, 1]);
});

test("a read of a slow journal sees each checkpoint once when another commit's read advances the index meanwhile", async () => {
	const index = new PoolCheckpointIndex();
	const history = ["a", "b", "c", "d", "e"].map((id, position) =>
		checkpointEntry(position + 1, 10 * (position + 1), id),
	);
	const stream = (entries: readonly JournalEntry[]) =>
		async function* (from: number) {
			for (const entry of entries) if (entry.seq >= from) yield entry;
		};
	const ids = (view: {
		entries(partition: "byRun", key: string): readonly { checkpoint: { checkpointId: string } }[];
	}) => view.entries("byRun", run.runId).map((entry) => entry.checkpoint.checkpointId);

	const seeded = index.begin("root");
	await seeded.readEntries(stream(history.slice(0, 2)));
	seeded.commit();

	// A read that has reached the index's watermark waits on the journal for the rest.
	const gate = Promise.withResolvers<void>();
	const slow = index.begin("root");
	const slowView = slow.readEntries(async function* (from) {
		for (const entry of history.filter((candidate) => candidate.seq >= from)) {
			if (entry.seq > 2) await gate.promise;
			yield entry;
		}
	});
	await new Promise((resolve) => setTimeout(resolve, 20));

	// Meanwhile another commit reads two more events and folds them into the index.
	const quick = index.begin("root");
	await quick.readEntries(stream(history.slice(0, 4)));
	quick.commit();

	gate.resolve();
	assert.deepEqual(ids(await slowView), ["a", "b", "c", "d", "e"]);
	slow.commit();
	assert.deepEqual(ids(await index.begin("root").readEntries(stream(history))), ["a", "b", "c", "d", "e"]);
});

test("a claim made while another is delivering the outbox waits for that delivery", async () => {
	const f = await fixture();
	try {
		vi.spyOn(f.durable, "append").mockRejectedValueOnce(new Error("journal unavailable"));
		await assert.rejects(f.pool.commit(f.lease, f.attempt, "tool", toolMutation), /journal unavailable/);
		vi.restoreAllMocks();
		assert.equal(await f.pool.releaseExited(f.lease, f.attempt), true);

		// The first claim delivers the accepted checkpoint; the journal holds its write.
		const append = f.durable.append.bind(f.durable);
		const reached = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		vi.spyOn(f.durable, "append").mockImplementationOnce(async (...args) => {
			reached.resolve();
			await proceed.promise;
			return append(...args);
		});
		const first = f.pool.claim(f.lease, "replacement-1", [work], 60_000);
		await reached.promise;

		// A second claim in that interval must not start work the journal does not yet hold the history of.
		const second = f.pool.claim(f.lease, "replacement-2", [work], 60_000);
		const early = await Promise.race([second.then(() => "returned"), sleep(150).then(() => "waiting")]);
		assert.equal(early, "waiting", "the second claim returned before the checkpoint reached the journal");
		assert.equal((await f.events()).filter((entry) => entry.key === checkpointKey(tool)).length, 0);

		proceed.resolve();
		const claims = await Promise.all([first, second]);
		assert.equal(claims.filter((claim) => claim !== undefined).length, 1, "the one work item goes to one worker");
		assert.equal((await f.events()).filter((entry) => entry.key === checkpointKey(tool)).length, 1);
	} finally {
		await f.close();
	}
});

test("a slow journal read does not make the pool's copy of the lease look newer than the journal's", async () => {
	const f = await fixture();
	try {
		// The journal answers about the lease at once and about the run only after a while.
		const getRun = f.durable.getRun.bind(f.durable);
		vi.spyOn(f.durable, "getRun").mockImplementationOnce(async (...args) => {
			await sleep(400);
			return getRun(...args);
		});
		await f.remote.mirror(f.lease);
		const copy = await f.storage.read((tx) =>
			tx.get(
				"SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) - renewed_at AS age FROM wf_leases WHERE run_id = ?",
				"root",
			),
		);
		// The lease was sampled before the 400 ms wait, so the copy is at least that old, never fresher.
		assert.ok(Number(copy!.age) >= 380, `the copy of the lease is ${copy!.age} ms old, 400 ms after it was read`);
	} finally {
		await f.close();
	}
});
