import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.ts";
import {
	SNAPSHOT_COLLECTION_LEASE_SECONDS,
	SNAPSHOT_INDEX_BACKFILL_BATCH,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import {
	resetSnapshotCollectionScheduleForTesting,
	scheduleSnapshotCollection,
} from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../../packages/coding-agent/src/core/worktree-snapshot/settings.ts";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import {
	bunExecutable,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	sleep,
	spawnProcess,
} from "../helpers/runtime.js";
import { dropSnapshotIndex, startRun, statusEvent, textBlob } from "../helpers/snapshot-reference-index.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const FIXTURE = join(ROOT, "test/fixtures/snapshot-collection-exit.ts");
/**
 * Makes a Node child resolve the packages the sources import from each other to their sources, as the test runner
 * does, so that one module instance serves the whole process: a collection recognizes only the blob store and the
 * closed-store error of its own instance, not those of a built copy.
 */
const SOURCE_ALIASES = JSON.stringify({
	"@bastani/atomic/storage": join(ROOT, "packages/coding-agent/src/core/storage/index.ts"),
	"@bastani/atomic": join(ROOT, "packages/coding-agent/src/index.ts"),
});
const DISPOSE_FIXTURE = join(ROOT, "test/fixtures/snapshot-collection-dispose.ts");
/** Each test starts real Node or Bun processes that load the sources, which takes seconds, not a test's default. */
const CHILD_PROCESS_TEST_TIMEOUT_MS = 120_000;
/**
 * How long the parent holds the write lock waiting for the child to exit. The child's connection would wait ten
 * minutes for the lock (see the fixture), so a collection that waited for it would still be running at this point.
 */
const LOCK_HELD_EXIT_BUDGET_MS = 60_000;
/**
 * Backfill transactions' worth of checkpoints, each referencing its own blob, of one failed run. Enough that no
 * plausible number of batches finishing before a stopped process exits, however loaded the machine, completes the
 * backfill: a test may assert it was cut short.
 */
const EXIT_SEED_BATCHES = 10;
const EVENTS = SNAPSHOT_INDEX_BACKFILL_BATCH * EXIT_SEED_BATCHES;
const ORPHANS = [textBlob("unreferenced a"), textBlob("unreferenced b")];

const RUNTIMES = [
	["node", () => [process.execPath, "--import", "jiti/register"]],
	["bun", () => [bunExecutable()]],
] as const;

/** A database written before the reference index existed: a failed run whose checkpoints reference `EVENTS` blobs. */
async function unindexedHistory(path: string): Promise<void> {
	const database = await openNodeSqliteDatabase(path);
	try {
		const sessions = await SqlSessionStore.open(database);
		const journal = await SqlRunJournal.open(database);
		const lease = await startRun(journal, "big");
		await journal.append(lease, statusEvent("big", { status: "running" }, "RunStarted"));
		await database.run(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO snapshot_blobs (hash, bytes, data, created_at) SELECT 'padded-' || i, 1, x'00', 1 FROM n`,
			EVENTS,
		);
		await database.run(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO wf_events SELECT 'big', 1 + i, ?, NULL, 'CheckpointRecorded',
				json_object('kind', 'tool', 'checkpointId', 'c' || i, 'worktreeSnapshots',
					json_array(json_object('chain', json_array(json_object('patch', 'padded-' || i))))), 0 FROM n`,
			EVENTS,
			lease.epoch,
		);
		await journal.append(lease, statusEvent("big", { status: "failed" }));
		await journal.snapshotBlobs.putBlobs(ORPHANS);
		await database.run("UPDATE snapshot_blobs SET created_at = 1");
		await journal.close();
		await sessions.close();
		await dropSnapshotIndex(database);
	} finally {
		await database.close();
	}
}

type ChildMode = "schedule" | "await" | "dispose-session" | "dispose-journal";

async function runChild(runtime: (typeof RUNTIMES)[number], mode: ChildMode, path: string) {
	const command = mode.startsWith("dispose-")
		? [...runtime[1](), DISPOSE_FIXTURE, path, mode.slice("dispose-".length)]
		: [...runtime[1](), FIXTURE, mode, path];
	const child = spawnProcess(command, {
		cwd: ROOT,
		env: { ...process.env, JITI_ALIAS: SOURCE_ALIASES },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	return { child, stdout, stderr };
}

async function progress(database: SqliteDatabase) {
	const sources = await database.all<{ source: string; watermark: number; backfilled_through: number }>(
		"SELECT source, watermark, backfilled_through FROM snapshot_index_sources ORDER BY source",
	);
	const claim = await database.get<{ holder: string | null; claimed: number; finished: number }>(
		"SELECT holder, claimed_at IS NOT NULL AS claimed, finished_at IS NOT NULL AS finished FROM snapshot_collection",
	);
	return { sources, claim };
}

describe.each(RUNTIMES)("an automatic collection never keeps its %s process alive (#4355)", (name, command) => {
	const runtime = [name, command] as const;

	test(
		"a process that only starts a collection exits after the batch in progress, and a living host takes over after the lease",
		async () => {
			const directory = makeTempDirectory("snapshot-collection-exit-");
			const path = join(directory, "shared.sqlite");
			let database: SqliteDatabase | undefined;
			try {
				await unindexedHistory(path);

				const { child, stdout, stderr } = await runChild(runtime, "schedule", path);
				assert.equal(await child.exited, 0, await stderr);
				assert.equal(await stdout, "scheduled\n");

				database = await openNodeSqliteDatabase(path);
				const stopped = await progress(database);
				const events = stopped.sources.find((row) => row.source === "journal-events")!;
				assert.ok(events.backfilled_through < events.watermark, "the backfill was cut short by the exit");
				assert.deepEqual([stopped.claim?.claimed, stopped.claim?.finished], [1, 0], "its claim is left unfinished");
				assert.equal((await database.all("SELECT hash FROM snapshot_blobs")).length, EVENTS + ORPHANS.length);

				resetSnapshotCollectionScheduleForTesting();
				const store = await SqlSnapshotBlobStore.open(database);
				assert.deepEqual(await scheduleSnapshotCollection(store, DEFAULT_WORKTREE_SNAPSHOT_SETTINGS), {
					status: "skipped",
					reason: "not-due",
				});
				await database.run(
					"UPDATE snapshot_collection SET claimed_at = claimed_at - ?",
					SNAPSHOT_COLLECTION_LEASE_SECONDS + 5,
				);
				resetSnapshotCollectionScheduleForTesting();
				const resumed = await scheduleSnapshotCollection(store, DEFAULT_WORKTREE_SNAPSHOT_SETTINGS);

				assert.equal(resumed.status, "collected");
				assert.deepEqual(
					[...(resumed as { deleted: readonly string[] }).deleted].sort(),
					ORPHANS.map((orphan) => orphan.hash).sort(),
				);
				const finished = await progress(database);
				for (const source of finished.sources)
					assert.equal(source.backfilled_through, source.watermark, source.source);
				assert.equal(finished.claim?.finished, 1);
			} finally {
				resetSnapshotCollectionScheduleForTesting();
				await database?.close();
				removeTempDirectory(directory);
			}
		},
		CHILD_PROCESS_TEST_TIMEOUT_MS,
	);

	test.each(["session", "journal"] as const)(
		"a process whose storage keeps it alive until closed exits once its %s store is closed, with the collection stopped at a batch",
		async (kind) => {
			const directory = makeTempDirectory("snapshot-collection-dispose-");
			const path = join(directory, "shared.sqlite");
			let database: SqliteDatabase | undefined;
			try {
				await unindexedHistory(path);

				const { child, stdout, stderr } = await runChild(runtime, `dispose-${kind}`, path);
				assert.equal(await child.exited, 0, await stderr);
				assert.equal(
					await stdout,
					"closed\n",
					"closing the store did not wait for the collection, and no failure was reported",
				);

				database = await openNodeSqliteDatabase(path);
				const stopped = await progress(database);
				const events = stopped.sources.find((row) => row.source === "journal-events")!;
				assert.ok(events.backfilled_through < events.watermark, "the close stopped the collection part way");
				assert.equal(stopped.claim?.finished, 0, "a stopped collection's claim is left for the lease to expire");
				assert.equal(
					Number(
						(
							await database.get<{ n: number }>(
								"SELECT count(*) AS n FROM snapshot_blobs WHERE hash LIKE 'padded-%'",
							)
						)?.n,
					),
					EVENTS,
					"no blob a journal references was deleted",
				);
			} finally {
				await database?.close();
				removeTempDirectory(directory);
			}
		},
		CHILD_PROCESS_TEST_TIMEOUT_MS,
	);

	test(
		"a process that waits for runningSnapshotCollection stays alive until the collection has finished",
		async () => {
			const directory = makeTempDirectory("snapshot-collection-keep-alive-");
			const path = join(directory, "shared.sqlite");
			let database: SqliteDatabase | undefined;
			try {
				await unindexedHistory(path);

				const { child, stdout, stderr } = await runChild(runtime, "await", path);
				assert.equal(await child.exited, 0, await stderr);
				assert.equal(await stdout, "scheduled\noutcome collected\n");

				database = await openNodeSqliteDatabase(path);
				const finished = await progress(database);
				for (const source of finished.sources)
					assert.equal(source.backfilled_through, source.watermark, source.source);
				assert.equal(finished.claim?.finished, 1);
				assert.equal((await database.all("SELECT hash FROM snapshot_blobs")).length, EVENTS);
			} finally {
				await database?.close();
				removeTempDirectory(directory);
			}
		},
		CHILD_PROCESS_TEST_TIMEOUT_MS,
	);

	test(
		"a process whose collection finds the write lock held exits while it is still held, and claims nothing",
		async () => {
			const directory = makeTempDirectory("snapshot-collection-contended-");
			const path = join(directory, "shared.sqlite");
			let holder: DatabaseSync | undefined;
			let running: Awaited<ReturnType<typeof runChild>> | undefined;
			try {
				const database = await openNodeSqliteDatabase(path);
				const store = await SqlSnapshotBlobStore.open(database);
				await store.putBlobs(ORPHANS);
				await database.run("UPDATE snapshot_blobs SET created_at = 1");
				await database.close();
				holder = new DatabaseSync(path);
				holder.exec("BEGIN IMMEDIATE");

				running = await runChild(runtime, "schedule", path);
				const exited = await Promise.race([
					running.child.exited.then(() => true),
					sleep(LOCK_HELD_EXIT_BUDGET_MS).then(() => false),
				]);

				assert.equal(exited, true, "the child exited while the write lock was still held");
				assert.equal(await running.child.exited, 0, await running.stderr);
				assert.equal(await running.stdout, "scheduled\n");
				holder.exec("ROLLBACK");
				const after = holder.prepare("SELECT holder, claimed_at FROM snapshot_collection").get() as {
					holder: string | null;
					claimed_at: number | null;
				};
				assert.deepEqual({ ...after }, { holder: null, claimed_at: null });
				assert.equal((holder.prepare("SELECT count(*) AS n FROM snapshot_blobs").get() as { n: number }).n, 2);
			} finally {
				if (holder?.isTransaction) holder.exec("ROLLBACK");
				holder?.close();
				if (running && running.child.exitCode === null) running.child.kill("SIGKILL");
				await running?.child.exited;
				removeTempDirectory(directory);
			}
		},
		CHILD_PROCESS_TEST_TIMEOUT_MS,
	);
});
