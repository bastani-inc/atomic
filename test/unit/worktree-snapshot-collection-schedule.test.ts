import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { SqliteDatabase, SqliteExecutor } from "../../packages/coding-agent/src/core/storage/database.ts";
import { StoreClosedError } from "../../packages/coding-agent/src/core/storage/errors.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import {
	MemorySnapshotBlobStore,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import {
	isRetryableWorkspaceError,
	isWorkspaceCollectionError,
	WorkspaceCollectionError,
} from "../../packages/coding-agent/src/core/worktree-snapshot/errors.ts";
import {
	resetSnapshotCollectionScheduleForTesting,
	scheduleSnapshotCollection,
} from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../../packages/coding-agent/src/core/worktree-snapshot/settings.ts";
import { countingDatabase } from "../helpers/counting-database.js";
import { ageBlobs, textBlob } from "../helpers/snapshot-reference-index.js";

let directory: string;
const closers: Array<() => Promise<void>> = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "snapshot-collection-schedule-"));
	resetSnapshotCollectionScheduleForTesting();
});
afterEach(async () => {
	vi.restoreAllMocks();
	resetSnapshotCollectionScheduleForTesting();
	while (closers.length > 0) await closers.pop()?.();
	rmSync(directory, { recursive: true, force: true });
});

const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
const silent = { onFailure: () => {} };

type Fault = (sql: string) => Error | undefined;

/** A connection to the shared test file whose statements can be counted and made to fail. */
async function connection(options: { fault?: { current?: Fault }; file?: string } = {}) {
	const database = await openNodeSqliteDatabase(join(directory, options.file ?? "shared.sqlite"));
	const fail = (sql: string) => {
		const error = options.fault?.current?.(sql);
		if (error) throw error;
	};
	const faulty = (executor: SqliteExecutor): SqliteExecutor => ({
		exec: async (sql) => {
			fail(sql);
			return executor.exec(sql);
		},
		run: async (sql, ...params) => {
			fail(sql);
			return executor.run(sql, ...params);
		},
		get: async (sql, ...params) => {
			fail(sql);
			return executor.get(sql, ...params);
		},
		all: async (sql, ...params) => {
			fail(sql);
			return executor.all(sql, ...params);
		},
	});
	const counted = countingDatabase({
		...faulty(database),
		descriptor: database.descriptor,
		transaction: (callback, transactionOptions) =>
			database.transaction((transaction) => callback(faulty(transaction)), transactionOptions),
		close: () => database.close(),
	} satisfies SqliteDatabase);
	const store = await SqlSnapshotBlobStore.open(counted.wrapped);
	closers.push(() => database.close().catch(() => undefined));
	const reset = () => {
		counted.statements.length = 0;
		counted.counts.transactions = 0;
	};
	return { database, store, counted, reset };
}

async function claimRow(database: SqliteDatabase) {
	return database.get<{
		claimed_at: number | null;
		finished_at: number | null;
		deleted: number | null;
		error_code: string | null;
	}>("SELECT claimed_at, finished_at, deleted, error_code FROM snapshot_collection WHERE id = 1");
}

async function agedOrphans(store: SqlSnapshotBlobStore, database: SqliteDatabase, count: number): Promise<string[]> {
	const blobs = Array.from({ length: count }, (_, index) => textBlob(`orphan-${index}`));
	await store.putBlobs(blobs);
	await ageBlobs(database, store.table, settings.graceSeconds + 10);
	return blobs.map((blob) => blob.hash);
}

describe("automatic collection runs only when enabled, supported and due (#4355)", () => {
	test("autoCollect false and stores without a reference index are skipped without touching storage", async () => {
		const { store, counted, reset } = await connection();
		reset();
		assert.deepEqual(await scheduleSnapshotCollection(store, { ...settings, autoCollect: false }), {
			status: "skipped",
			reason: "disabled",
		});
		assert.deepEqual(await scheduleSnapshotCollection(new MemorySnapshotBlobStore(), settings), {
			status: "skipped",
			reason: "unsupported",
		});
		assert.deepEqual(await scheduleSnapshotCollection(undefined, settings), {
			status: "skipped",
			reason: "unsupported",
		});
		assert.equal(counted.statements.length, 0);
	});

	test("a due collection deletes aged unreferenced blobs and records its outcome on the database clock", async () => {
		const { database, store } = await connection();
		const orphans = await agedOrphans(store, database, 3);

		const outcome = await scheduleSnapshotCollection(store, settings, silent);

		assert.equal(outcome.status, "collected");
		assert.deepEqual([...(outcome as { deleted: readonly string[] }).deleted].sort(), [...orphans].sort());
		const row = await claimRow(database);
		assert.equal(row?.deleted, 3);
		assert.equal(row?.error_code, null);
		assert.ok(row?.finished_at !== null && row!.finished_at! >= row!.claimed_at!);
	});

	test("within the interval this process does not ask the database again", async () => {
		const { store, counted, reset } = await connection();
		await scheduleSnapshotCollection(store, settings, silent);
		reset();

		assert.deepEqual(await scheduleSnapshotCollection(store, settings, silent), {
			status: "skipped",
			reason: "not-due",
		});
		assert.equal(counted.statements.length, 0);
	});

	test("another process inside the interval only reads the claim row, without a write transaction", async () => {
		const first = await connection();
		await scheduleSnapshotCollection(first.store, settings, silent);
		resetSnapshotCollectionScheduleForTesting();
		const second = await connection();
		second.reset();

		assert.deepEqual(await scheduleSnapshotCollection(second.store, settings, silent), {
			status: "skipped",
			reason: "not-due",
		});
		assert.equal(second.counted.counts.transactions, 0);
		assert.equal(second.counted.statements.length, 1);
		assert.match(second.counted.statements[0]!.sql, /^SELECT id FROM snapshot_collection/u);
	});

	test("a claim older than the interval on the database clock makes the next collection due", async () => {
		const { database, store } = await connection();
		await scheduleSnapshotCollection(store, settings, silent);
		await database.run("UPDATE snapshot_collection SET claimed_at = claimed_at - ?", settings.collectIntervalSeconds);
		resetSnapshotCollectionScheduleForTesting();
		const orphans = await agedOrphans(store, database, 1);

		assert.deepEqual(await scheduleSnapshotCollection(store, settings, silent), {
			status: "collected",
			deleted: orphans,
		});
	});

	test("this process asks again once its own interval has passed", async () => {
		const { database, store } = await connection();
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValue(1_000);
		await scheduleSnapshotCollection(store, { ...settings, collectIntervalSeconds: 60 }, silent);
		await database.run("UPDATE snapshot_collection SET claimed_at = claimed_at - 60");
		clock.mockReturnValue(1_000 + 59_999);
		assert.deepEqual(await scheduleSnapshotCollection(store, { ...settings, collectIntervalSeconds: 60 }, silent), {
			status: "skipped",
			reason: "not-due",
		});
		clock.mockReturnValue(1_000 + 60_000);
		assert.equal(
			(await scheduleSnapshotCollection(store, { ...settings, collectIntervalSeconds: 60 }, silent)).status,
			"collected",
		);
	});

	test("concurrent triggers collect once: one in this process, one claim among connections", async () => {
		const { database, store } = await connection();
		await agedOrphans(store, database, 2);
		const outcomes = await Promise.all(
			Array.from({ length: 8 }, () => scheduleSnapshotCollection(store, settings, silent)),
		);
		assert.deepEqual(
			outcomes.map((outcome) => outcome.status).sort(),
			["collected", ...Array<string>(7).fill("skipped")].sort(),
		);
		assert.ok(outcomes.slice(1).every((outcome) => outcome.status === "skipped" && outcome.reason === "in-progress"));

		await database.run("UPDATE snapshot_collection SET claimed_at = NULL");
		const others = await Promise.all(Array.from({ length: 4 }, () => connection()));
		const claims = await Promise.all(
			others.map((other, index) => other.store.claimCollection(3600, `holder-${index}`)),
		);
		assert.deepEqual(claims.filter(Boolean).length, 1);
	});
});

describe("an automatic collection that fails is an outcome, reported once and recorded (#4355)", () => {
	test("a sweep failure is a retryable typed error with the storage failure as its cause, recorded in the claim row", async () => {
		const fault: { current?: Fault } = {};
		const { database, store } = await connection({ fault });
		await agedOrphans(store, database, 1);
		const cause = new Error("disk I/O error");
		fault.current = (sql) => (sql.startsWith("DELETE FROM snapshot_blobs") ? cause : undefined);
		const reported: WorkspaceCollectionError[] = [];

		const outcome = await scheduleSnapshotCollection(store, settings, { onFailure: (error) => reported.push(error) });

		assert.equal(outcome.status, "failed");
		const { error } = outcome as { error: WorkspaceCollectionError };
		assert.ok(error instanceof WorkspaceCollectionError);
		assert.ok(isWorkspaceCollectionError(error));
		assert.ok(isRetryableWorkspaceError(error));
		assert.equal(error.code, "collection-failed");
		assert.equal(error.retryable, true);
		assert.deepEqual(error.fields, { table: "snapshot_blobs", phase: "sweep", deleted: 0 });
		assert.equal(error.cause, cause);
		assert.deepEqual(reported, [error]);
		fault.current = undefined;
		assert.equal((await claimRow(database))?.error_code, "collection-failed");
	});

	test("the same failure is reported once per process, while each attempt still returns it", async () => {
		const fault: { current?: Fault } = {
			current: (sql) => (sql.startsWith("DELETE") ? new Error("locked") : undefined),
		};
		const { database, store } = await connection({ fault });
		await agedOrphans(store, database, 1);
		const clock = vi.spyOn(performance, "now").mockReturnValue(0);
		const reported: WorkspaceCollectionError[] = [];
		const onFailure = (error: WorkspaceCollectionError) => reported.push(error);

		assert.equal((await scheduleSnapshotCollection(store, settings, { onFailure })).status, "failed");
		fault.current = undefined;
		await database.run("UPDATE snapshot_collection SET claimed_at = claimed_at - ?", settings.collectIntervalSeconds);
		fault.current = (sql) => (sql.startsWith("DELETE") ? new Error("locked") : undefined);
		clock.mockReturnValue(settings.collectIntervalSeconds * 1000);
		assert.equal((await scheduleSnapshotCollection(store, settings, { onFailure })).status, "failed");
		assert.equal(reported.length, 1);

		resetSnapshotCollectionScheduleForTesting();
		fault.current = undefined;
		await database.run("UPDATE snapshot_collection SET claimed_at = claimed_at - ?", settings.collectIntervalSeconds);
		fault.current = (sql) => (sql.startsWith("DELETE") ? new Error("locked") : undefined);
		assert.equal((await scheduleSnapshotCollection(store, settings, { onFailure })).status, "failed");
		assert.equal(reported.length, 2, "forgetting reported failures reports the next one again");
	});

	test("a claim failure is reported with phase claim and leaves the claim row untouched", async () => {
		const fault: { current?: Fault } = {};
		const { database, store, counted, reset } = await connection({ fault });
		fault.current = (sql) =>
			sql.startsWith("UPDATE snapshot_collection SET claimed_at") ? new Error("busy") : undefined;
		reset();

		const outcome = await scheduleSnapshotCollection(store, settings, silent);

		assert.equal(outcome.status, "failed");
		assert.equal((outcome as { error: WorkspaceCollectionError }).error.phase, "claim");
		assert.deepEqual(
			counted.statements.map((statement) => statement.sql.split(" ").slice(0, 3).join(" ")),
			["SELECT id FROM"],
			"a collection that never held the claim records nothing",
		);
		fault.current = undefined;
		assert.deepEqual(await claimRow(database), {
			claimed_at: null,
			finished_at: null,
			deleted: null,
			error_code: null,
		});
	});

	test("a failure to record a failure is kept as the cleanup cause, never in place of the failure", async () => {
		const sweep = new Error("sweep failed");
		const record = new Error("record failed");
		const fault: { current?: Fault } = {
			current: (sql) =>
				sql.startsWith("DELETE")
					? sweep
					: sql.startsWith("UPDATE snapshot_collection SET finished_at")
						? record
						: undefined,
		};
		const { database, store } = await connection({ fault });
		await agedOrphans(store, database, 1);

		const outcome = await scheduleSnapshotCollection(store, settings, silent);

		const { error } = outcome as { error: WorkspaceCollectionError };
		assert.equal(error.cause, sweep);
		assert.equal(error.cleanupCause, record);
	});

	test("a failure while recording a finished collection is reported with phase record and the count it deleted", async () => {
		const fault: { current?: Fault } = {
			current: (sql) =>
				sql.startsWith("UPDATE snapshot_collection SET finished_at") ? new Error("readonly") : undefined,
		};
		const { database, store } = await connection({ fault });
		await agedOrphans(store, database, 2);

		const outcome = await scheduleSnapshotCollection(store, settings, silent);

		assert.deepEqual((outcome as { error: WorkspaceCollectionError }).error.fields, {
			table: "snapshot_blobs",
			phase: "record",
			deleted: 2,
		});
	});

	test("without onFailure the failure becomes a process warning", async () => {
		const fault: { current?: Fault } = { current: (sql) => (sql.startsWith("DELETE") ? new Error("io") : undefined) };
		const { database, store } = await connection({ fault });
		await agedOrphans(store, database, 1);
		const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

		const outcome = await scheduleSnapshotCollection(store, settings);

		assert.deepEqual(warn.mock.calls, [[(outcome as { error: WorkspaceCollectionError }).error]]);
	});

	test("storage closing under a collection interrupts it: not a failure, and what it deleted stays deleted", async () => {
		const fault: { current?: Fault } = {};
		const { database, store } = await connection({ fault });
		const orphans = await agedOrphans(store, database, 300);
		let deletes = 0;
		fault.current = (sql) => {
			if (!sql.startsWith("SELECT created_at, hash")) return undefined;
			return ++deletes === 2 ? new StoreClosedError(database.descriptor) : undefined;
		};
		const reported: WorkspaceCollectionError[] = [];

		const outcome = await scheduleSnapshotCollection(store, settings, { onFailure: (error) => reported.push(error) });

		assert.equal(outcome.status, "interrupted");
		assert.equal((outcome as { deleted: readonly string[] }).deleted.length, 256);
		assert.deepEqual(reported, []);
		fault.current = undefined;
		assert.equal((await store.listBlobHashes()).length, orphans.length - 256);
	});
});

test("each database is collected and its failures reported on its own, in one process (#4355)", async () => {
	const deletes = (sql: string) => (sql.startsWith("DELETE") ? new Error("disk I/O error") : undefined);
	const first = await connection({ file: "first.sqlite", fault: { current: deletes } });
	const second = await connection({ file: "second.sqlite", fault: { current: deletes } });
	await agedOrphans(first.store, first.database, 1);
	await agedOrphans(second.store, second.database, 1);
	const reported: WorkspaceCollectionError[] = [];
	const onFailure = (error: WorkspaceCollectionError) => reported.push(error);

	const outcomes = [
		await scheduleSnapshotCollection(first.store, settings, { onFailure }),
		await scheduleSnapshotCollection(second.store, settings, { onFailure }),
	];

	assert.deepEqual(
		outcomes.map((outcome) => outcome.status),
		["failed", "failed"],
	);
	assert.equal(reported.length, 2);
	assert.notEqual(first.store.identity, second.store.identity);
});
