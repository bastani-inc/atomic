import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import {
	SqlSnapshotBlobStore,
	snapshotBlobHashes,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import type { WorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/types.ts";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { openSqlPoolQueue, type SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { isStaleLeaseError, type Lease } from "../../packages/workflows/src/durable/journal/types.js";
import { countingDatabase } from "../helpers/counting-database.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import {
	ageBlobs,
	dropSnapshotIndex,
	startRun,
	syntheticSnapshot,
	textBlob,
} from "../helpers/snapshot-reference-index.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/**
 * The snapshots a shared-placement root carries to its children, its binding's and each queued work row's, are
 * references in the snapshot reference index for as long as the row that carries them exists, at any grace window
 * (#4503).
 */
useTemporaryAgentDir();

const subjects = [
	{ name: "SQLite", open: (directory: string) => openNodeSqliteDatabase(join(directory, "journal.sqlite")) },
	{
		name: "libSQL",
		open: (directory: string) => openLibsqlDatabase({ url: pathToFileURL(join(directory, "journal.db")).href }),
	},
] as const;

type Subject = (typeof subjects)[number];

let directory: string;
const closers: Array<() => Promise<void>> = [];
beforeEach(() => {
	directory = makeLibsqlDirectory("snapshot-carried-refs-");
});
afterEach(async () => {
	while (closers.length > 0) await closers.pop()?.();
	await removeLibsqlDirectory(directory);
});

interface RootPool {
	readonly database: SqliteDatabase;
	readonly journal: SqlRunJournal;
	readonly queue: SqlPoolQueue;
	readonly blobs: SqlSnapshotBlobStore;
	readonly lease: Lease;
}

/** A run journal whose root `root` holds its lease, with the pool's tables beside it and their index triggers. */
async function openRootPool(subject: Subject, options: { readonly indexed?: boolean } = {}): Promise<RootPool> {
	const database = await subject.open(directory);
	const journal = await SqlRunJournal.open(database);
	closers.push(async () => {
		await journal.close();
		await database.close();
	});
	const queue = await openSqlPoolQueue(journal);
	const lease = await startRun(journal, "root");
	// The pool's tables appeared after the journal opened its blob store: a collection, or this, indexes them.
	if (options.indexed !== false) await journal.snapshotBlobs.completeIndex();
	return { database, journal, queue, blobs: journal.snapshotBlobs, lease };
}

/** The descriptor of child `id`'s work, carrying `snapshot` when given, as the root queues it. */
function descriptor(id: string, snapshot?: WorktreeSnapshot): string {
	return JSON.stringify({
		boundaryId: `stage-${id}`,
		childRunId: `child-${id}`,
		scope: `scope-${id}`,
		definition: "child.ts#child",
		digest: "digest",
		inputs: {},
		execution: { cwd: "/repo", ...(snapshot === undefined ? {} : { workspaceSnapshot: snapshot }) },
	});
}

/** Queues work `id` for `root` as the pool's enqueue writes it, with `json` as its descriptor. */
async function queueWork(database: SqliteDatabase, id: string, json: string, root = "root"): Promise<void> {
	await database.run("INSERT INTO wf_runs_pool(root, timeout) VALUES (?, 60000) ON CONFLICT(root) DO NOTHING", root);
	await database.run(
		"INSERT INTO wf_runs_work(id, root, boundary, descriptor, fingerprint, ready_at) VALUES (?, ?, ?, ?, ?, 0)",
		id,
		root,
		`stage-${id}`,
		json,
		`fingerprint-${id}`,
	);
}

const blobsNamed = (...names: string[]) => names.map((name) => textBlob(`carried ${name}`));
const sorted = (hashes: readonly string[]) => [...hashes].sort();

async function collectAtZeroGrace(blobs: SqlSnapshotBlobStore): Promise<string[]> {
	return sorted((await collectSnapshotGarbage(blobs, { graceSeconds: 0 })).deleted);
}

async function carriedRefs(database: SqliteDatabase): Promise<string[][]> {
	return (
		await database.all<{ owner: string; hash: string }>(
			"SELECT owner, hash FROM snapshot_carried_refs ORDER BY owner, hash",
		)
	).map((row) => [row.owner, row.hash]);
}

describe.each(subjects)("snapshots dispatched work carries, on $name (#4503)", (subject) => {
	test("a queued work row keeps its snapshot's blobs at graceSeconds 0 until the row is deleted", async () => {
		const { database, blobs } = await openRootPool(subject);
		const [first, second, bundle, orphan] = blobsNamed("first", "second", "bundle", "orphan");
		await blobs.putBlobs([first!, second!, bundle!, orphan!]);
		await queueWork(
			database,
			"w1",
			descriptor("w1", syntheticSnapshot("s1", [first!.hash, null, second!.hash], { bundle: bundle!.hash })),
		);
		await ageBlobs(database, blobs.table, 10_000);

		assert.deepEqual(await collectAtZeroGrace(blobs), [orphan!.hash], "only what nothing carries");
		assert.deepEqual(
			await carriedRefs(database),
			sorted([first!.hash, second!.hash, bundle!.hash]).map((hash) => ["work:w1", hash]),
		);

		await database.run("DELETE FROM wf_runs_work WHERE id = 'w1'");

		assert.deepEqual(await collectAtZeroGrace(blobs), sorted([first!.hash, second!.hash, bundle!.hash]));
		assert.deepEqual(await carriedRefs(database), []);
	});

	test("work rows that share a blob keep it until the last goes, and a row queued again with another snapshot lets the old one go", async () => {
		const { database, blobs } = await openRootPool(subject);
		const [shared, onlyFirst, onlySecond, next] = blobsNamed("shared", "only first", "only second", "next");
		await blobs.putBlobs([shared!, onlyFirst!, onlySecond!]);
		await queueWork(database, "w1", descriptor("w1", syntheticSnapshot("s1", [shared!.hash, onlyFirst!.hash])));
		await queueWork(
			database,
			"w2",
			descriptor("w2", syntheticSnapshot("s2", [shared!.hash], { bundle: onlySecond!.hash })),
		);

		await database.run("DELETE FROM wf_runs_work WHERE id = 'w1'");
		assert.deepEqual(
			await collectAtZeroGrace(blobs),
			[onlyFirst!.hash],
			"the other row still carries the shared blob",
		);

		await blobs.putBlobs([next!]);
		await database.run(
			"UPDATE wf_runs_work SET state = 'ready', epoch = 2, descriptor = ? WHERE id = 'w2'",
			descriptor("w2", syntheticSnapshot("s3", [next!.hash])),
		);
		assert.deepEqual(await collectAtZeroGrace(blobs), sorted([shared!.hash, onlySecond!.hash]));

		await database.run("UPDATE wf_runs_work SET state = 'leased', generation = 1, worker = 'w' WHERE id = 'w2'");
		await database.run("UPDATE wf_runs_work SET state = 'completed' WHERE id = 'w2'");
		assert.deepEqual(await collectAtZeroGrace(blobs), [], "a claim or a completion keeps the row's references");
		assert.deepEqual(await carriedRefs(database), [["work:w2", next!.hash]]);
	});

	test("a work row queued without a snapshot or with one that names no blob, and a root record SQLite cannot parse, reference nothing and are written", async () => {
		const { database, blobs } = await openRootPool(subject);
		const [stored] = blobsNamed("stored");
		await blobs.putBlobs([stored!]);
		await queueWork(database, "plain", descriptor("plain"));
		await queueWork(
			database,
			"shapes",
			JSON.stringify({
				scope: "scope-shapes",
				childRunId: "child-shapes",
				execution: { workspaceSnapshot: { chain: [5, { patch: 9 }, { patch: null }, "x"], bundle: { blob: 3 } } },
			}),
		);
		await queueWork(
			database,
			"not-a-list",
			JSON.stringify({
				scope: "scope-list",
				childRunId: "child-list",
				execution: { workspaceSnapshot: { chain: stored!.hash, bundle: stored!.hash } },
			}),
		);
		const malformed = `{"chain":[{"patch":"${stored!.hash}"}`;
		await database.run(
			"INSERT INTO wf_runs_pool_root_snapshot(root, epoch, snapshot) VALUES ('root', 1, ?)",
			malformed,
		);
		await database.run("UPDATE wf_runs_pool_root_snapshot SET snapshot = ? WHERE root = 'root'", `${malformed},`);

		assert.deepEqual(await carriedRefs(database), []);
		assert.deepEqual(await collectAtZeroGrace(blobs), [stored!.hash]);
		await database.run("DELETE FROM wf_runs_pool_root_snapshot WHERE root = 'root'");
	});

	test("the root's binding keeps its snapshot's blobs at graceSeconds 0 while its pool holds it, and its incarnation lets it go", async () => {
		const { database, queue, blobs, lease } = await openRootPool(subject);
		const [first, bundle, second, orphan] = blobsNamed("first", "bundle", "second", "orphan");
		await blobs.putBlobs([first!, bundle!, orphan!]);
		await ageBlobs(database, blobs.table, 10_000);

		await queue.holdRootSnapshot(lease, syntheticSnapshot("s1", [first!.hash], { bundle: bundle!.hash }));
		assert.deepEqual(
			await collectAtZeroGrace(blobs),
			[orphan!.hash],
			"nothing is queued, and the root keeps its own",
		);

		await blobs.putBlobs([second!]);
		await queue.holdRootSnapshot(lease, syntheticSnapshot("s2", [null, second!.hash]));
		assert.deepEqual(await collectAtZeroGrace(blobs), sorted([first!.hash, bundle!.hash]), "the new one replaces it");

		for (const stale of [
			{ ...lease, epoch: lease.epoch + 1 },
			{ ...lease, holderId: "another-holder" },
			{ runId: "never-started", holderId: lease.holderId, epoch: 1 },
		]) {
			await assert.rejects(queue.holdRootSnapshot(stale, syntheticSnapshot("stale", [first!.hash])), (error) => {
				assert.ok(isStaleLeaseError(error), String(error));
				assert.deepEqual(
					[error.code, error.runId, error.heldEpoch, error.currentEpoch],
					["stale_lease", stale.runId, stale.epoch, stale.runId === "root" ? lease.epoch : 0],
				);
				return true;
			});
		}
		await queue.releaseRootSnapshot({ ...lease, epoch: lease.epoch - 1 });
		assert.deepEqual(
			await collectAtZeroGrace(blobs),
			[],
			"an earlier incarnation's release leaves a later one's record",
		);
		assert.deepEqual(await carriedRefs(database), [["root:root", second!.hash]]);

		await queue.releaseRootSnapshot(lease);

		assert.deepEqual(await collectAtZeroGrace(blobs), [second!.hash]);
		assert.deepEqual(await database.all("SELECT root FROM wf_runs_pool_root_snapshot"), []);
	});

	test("deleting the root run lets go of every snapshot its work and its binding carried", async () => {
		const { database, journal, queue, blobs, lease } = await openRootPool(subject);
		const [first, second, bound] = blobsNamed("first", "second", "bound");
		await blobs.putBlobs([first!, second!, bound!]);
		await queueWork(database, "w1", descriptor("w1", syntheticSnapshot("s1", [first!.hash])));
		await queueWork(database, "w2", descriptor("w2", syntheticSnapshot("s2", [second!.hash])));
		await queue.holdRootSnapshot(lease, syntheticSnapshot("bound", [bound!.hash]));
		assert.deepEqual(await collectAtZeroGrace(blobs), []);

		await journal.deleteRun("root");

		assert.deepEqual(await collectAtZeroGrace(blobs), sorted([first!.hash, second!.hash, bound!.hash]));
		assert.deepEqual(await carriedRefs(database), []);
	});

	test("rows queued before their table had index triggers are indexed before a sweep deletes anything", async () => {
		const { database, queue, blobs, lease } = await openRootPool(subject, { indexed: false });
		const [queued, bound, orphan] = blobsNamed("queued", "bound", "orphan");
		await blobs.putBlobs([queued!, bound!, orphan!]);
		await queueWork(database, "w1", descriptor("w1", syntheticSnapshot("s1", [queued!.hash])));
		await queue.holdRootSnapshot(lease, syntheticSnapshot("bound", [bound!.hash]));
		assert.deepEqual(await carriedRefs(database), [], "nothing indexed them yet");

		const deleted = await blobs.sweep({ graceSeconds: 0 });

		assert.deepEqual(deleted, [orphan!.hash]);
		assert.deepEqual(await carriedRefs(database), [
			["root:root", bound!.hash],
			["work:w1", queued!.hash],
		]);
	});

	test("an index an earlier build wrote, without carried references, is migrated forward on open and backfilled before a sweep deletes anything", async () => {
		const { database, queue, blobs, lease } = await openRootPool(subject);
		const [queued, later, bound, orphan] = blobsNamed("queued", "later", "bound", "orphan");
		await blobs.putBlobs([queued!, later!, bound!, orphan!]);
		await queueWork(database, "w1", descriptor("w1", syntheticSnapshot("s1", [queued!.hash])));
		await queue.holdRootSnapshot(lease, syntheticSnapshot("bound", [bound!.hash]));
		for (const { name } of await database.all<{ name: string }>(
			"SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE '%snapshot_carried%'",
		))
			await database.exec(`DROP TRIGGER ${name}`);
		await database.exec("DROP TABLE snapshot_carried_refs");
		await database.run(
			"DELETE FROM snapshot_index_sources WHERE source IN ('journal-pool-work', 'journal-pool-root-snapshot')",
		);
		// What the earlier build queues next has no trigger to index it either.
		await queueWork(database, "w2", descriptor("w2", syntheticSnapshot("s2", [later!.hash])));
		await ageBlobs(database, blobs.table, 10_000);

		const upgraded = await SqlSnapshotBlobStore.open(database);

		assert.deepEqual(
			(
				await database.all<{ source: string; watermark: number; backfilled_through: number }>(
					"SELECT source, watermark, backfilled_through FROM snapshot_index_sources WHERE source LIKE 'journal-pool-%' ORDER BY source",
				)
			).map((row) => [row.source, Number(row.watermark), Number(row.backfilled_through)]),
			[
				["journal-pool-root-snapshot", 1, 0],
				["journal-pool-work", 2, 0],
			],
			"the open installs the triggers and leaves the rows already queued to the backfill",
		);
		assert.deepEqual(await upgraded.sweep({ graceSeconds: 0 }), [orphan!.hash]);
		assert.deepEqual(await carriedRefs(database), [
			["root:root", bound!.hash],
			["work:w1", queued!.hash],
			["work:w2", later!.hash],
		]);

		const counted = countingDatabase(database);
		await SqlSnapshotBlobStore.open(counted.wrapped);
		assert.deepEqual(
			[counted.counts.transactions, counted.statements.filter(({ sql }) => sql.includes("CREATE")).length],
			[0, 0],
			"once migrated, an open takes no write lock and creates nothing",
		);
	});

	test("references of rows deleted while the index triggers were missing do not outlive them once the triggers are installed again", async () => {
		const { database, queue, blobs, lease } = await openRootPool(subject);
		const [gone, kept, bound] = blobsNamed("gone", "kept", "bound");
		await blobs.putBlobs([gone!, kept!, bound!]);
		await queueWork(database, "w1", descriptor("w1", syntheticSnapshot("s1", [gone!.hash])));
		await queueWork(database, "w2", descriptor("w2", syntheticSnapshot("s2", [kept!.hash])));
		await queue.holdRootSnapshot(lease, syntheticSnapshot("bound", [bound!.hash]));
		for (const { name } of await database.all<{ name: string }>(
			"SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE '%snapshot_carried%'",
		))
			await database.exec(`DROP TRIGGER ${name}`);
		await database.run("DELETE FROM wf_runs_work WHERE id = 'w1'");
		await database.run("DELETE FROM wf_runs_pool_root_snapshot WHERE root = 'root'");

		const reinstalled = await SqlSnapshotBlobStore.open(database);

		assert.deepEqual(sorted(await reinstalled.sweep({ graceSeconds: 0 })), sorted([gone!.hash, bound!.hash]));
		assert.deepEqual(await carriedRefs(database), [["work:w2", kept!.hash]]);
	});

	test("a database written before the reference index existed keeps what its pool carries through the first collection", async () => {
		const { database, queue, blobs, lease } = await openRootPool(subject);
		const [queued, bound, orphan] = blobsNamed("queued", "bound", "orphan");
		await blobs.putBlobs([queued!, bound!, orphan!]);
		await queueWork(database, "w1", descriptor("w1", syntheticSnapshot("s1", [queued!.hash])));
		await queue.holdRootSnapshot(lease, syntheticSnapshot("bound", [bound!.hash]));
		await dropSnapshotIndex(database);
		await ageBlobs(database, blobs.table, 10_000);

		const upgraded = await SqlSnapshotBlobStore.open(database);

		assert.deepEqual(await collectAtZeroGrace(upgraded), [orphan!.hash]);
	});
});

/** A deterministic generator, so a failing seed reproduces. */
function random(seed: number) {
	let state = seed >>> 0 || 1;
	const next = () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x1_0000_0000;
	};
	return {
		int: (bound: number) => Math.floor(next() * bound),
		pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
		chance: (probability: number) => next() < probability,
	};
}

/** The blobs the pool's rows carry, read from the rows themselves, as restore would read them. */
async function carriedByRows(database: SqliteDatabase): Promise<Set<string>> {
	const carried = new Set<string>();
	for (const { descriptor } of await database.all<{ descriptor: string }>("SELECT descriptor FROM wf_runs_work")) {
		const snapshot = (JSON.parse(descriptor) as { execution: { workspaceSnapshot?: WorktreeSnapshot } }).execution
			.workspaceSnapshot;
		if (snapshot !== undefined) for (const hash of snapshotBlobHashes(snapshot)) carried.add(hash);
	}
	for (const { snapshot } of await database.all<{ snapshot: string }>(
		"SELECT snapshot FROM wf_runs_pool_root_snapshot",
	))
		for (const hash of snapshotBlobHashes(JSON.parse(snapshot) as WorktreeSnapshot)) carried.add(hash);
	return carried;
}

describe.each(subjects)("random pool histories on $name keep exactly what their rows carry (#4503)", (subject) => {
	test.each([1, 2, 3, 4])("seed %i", async (seed) => {
		const rng = random(seed);
		const { database, queue, blobs, lease } = await openRootPool(subject, { indexed: false });
		const stored = blobsNamed(...Array.from({ length: 24 }, (_, index) => `${seed}-${index}`));
		await blobs.putBlobs(stored);
		const snapshot = (): WorktreeSnapshot | undefined =>
			rng.chance(0.2)
				? undefined
				: syntheticSnapshot(
						`snap-${rng.int(1_000_000)}`,
						Array.from({ length: 1 + rng.int(3) }, () => (rng.chance(0.2) ? null : rng.pick(stored).hash)),
						rng.chance(0.4) ? { bundle: rng.pick(stored).hash } : {},
					);
		const queued: string[] = [];
		let next = 0;
		const indexAt = rng.int(30);
		for (let step = 0; step < 30; step++) {
			if (step === indexAt) await blobs.completeIndex();
			const action = rng.int(6);
			if (action <= 1 || queued.length === 0) {
				const id = `w${next++}`;
				queued.push(id);
				await queueWork(database, id, descriptor(id, snapshot()));
			} else if (action === 2) {
				const id = rng.pick(queued);
				await database.run("UPDATE wf_runs_work SET descriptor = ? WHERE id = ?", descriptor(id, snapshot()), id);
			} else if (action === 3) {
				const id = queued.splice(rng.int(queued.length), 1)[0]!;
				await database.run("DELETE FROM wf_runs_work WHERE id = ?", id);
			} else if (action === 4) {
				const held = snapshot();
				if (held === undefined) await queue.releaseRootSnapshot(lease);
				else await queue.holdRootSnapshot(lease, held);
			} else await database.run("UPDATE wf_runs_work SET state = 'leased' WHERE id = ?", rng.pick(queued));
		}
		const expected = await carriedByRows(database);

		const deleted = await collectSnapshotGarbage(blobs, { graceSeconds: 0 });

		assert.deepEqual(sorted(await blobs.listBlobHashes()), sorted([...expected]));
		assert.deepEqual(
			sorted(deleted.deleted),
			sorted(stored.map((blob) => blob.hash).filter((hash) => !expected.has(hash))),
		);
	});
});
