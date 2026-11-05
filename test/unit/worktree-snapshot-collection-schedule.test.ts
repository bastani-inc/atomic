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
	runningSnapshotCollectionsOn,
	SNAPSHOT_COLLECTION_LEASE_SECONDS,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import {
	isRetryableWorkspaceError,
	isWorkspaceCollectionError,
	isWorkspaceConfigError,
	WorkspaceCollectionError,
} from "../../packages/coding-agent/src/core/worktree-snapshot/errors.ts";
import {
	resetSnapshotCollectionScheduleForTesting,
	runningSnapshotCollection,
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
async function connection(options: { fault?: { current?: Fault }; file?: string; gate?: Promise<void> } = {}) {
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
			if (sql.startsWith("SELECT id FROM snapshot_collection")) await options.gate;
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

/** Moves the last collection's claim and finish back by `seconds`, as that much time passing would. */
async function ageClaim(database: SqliteDatabase, seconds: number): Promise<void> {
	await database.run(
		"UPDATE snapshot_collection SET claimed_at = claimed_at - ?, finished_at = finished_at - ?",
		seconds,
		seconds,
	);
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
		await ageClaim(database, settings.collectIntervalSeconds);
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
		await ageClaim(database, 60);
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
		await ageClaim(database, settings.collectIntervalSeconds);
		fault.current = (sql) => (sql.startsWith("DELETE") ? new Error("locked") : undefined);
		clock.mockReturnValue(settings.collectIntervalSeconds * 1000);
		assert.equal((await scheduleSnapshotCollection(store, settings, { onFailure })).status, "failed");
		assert.equal(reported.length, 1);

		resetSnapshotCollectionScheduleForTesting();
		fault.current = undefined;
		await ageClaim(database, settings.collectIntervalSeconds);
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

	test("a failure while indexing existing references is reported with phase index, and nothing was deleted", async () => {
		const fault: { current?: Fault } = {};
		const { database, store } = await connection({ fault });
		await agedOrphans(store, database, 2);
		fault.current = (sql) =>
			sql.startsWith("SELECT source, watermark, backfilled_through FROM")
				? new Error("schema read failed")
				: undefined;

		const outcome = await scheduleSnapshotCollection(store, settings, silent);

		assert.equal(outcome.status, "failed");
		const { error } = outcome as { error: WorkspaceCollectionError };
		assert.deepEqual(error.fields, { table: "snapshot_blobs", phase: "index", deleted: 0 });
		assert.ok(error.summary.endsWith("while indexing existing snapshot references of snapshot_blobs"));
		fault.current = undefined;
		assert.equal((await store.listBlobHashes()).length, 2);
		assert.equal((await claimRow(database))?.error_code, "collection-failed");
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

describe("the claim is a lease every batch renews, and the interval runs from the last finish (#4355)", () => {
	const interval = settings.collectIntervalSeconds;
	const lease = SNAPSHOT_COLLECTION_LEASE_SECONDS;
	const ago = (seconds: number | null) => (seconds === null ? "NULL" : `unixepoch() - ${seconds}`);

	test.each([
		["no collection was ever claimed", null, null, true],
		["an unfinished claim renewed within the lease", 10, null, false],
		["an unfinished claim that stopped renewing past the lease", lease + 5, null, true],
		["a collection that finished within the interval", 20, 10, false],
		["a collection that finished past the interval", interval + 30, interval + 5, true],
		["a collection claimed long ago that finished within the interval", interval + 100, 10, false],
	] as const)("%s", async (_name, claimedAgo, finishedAgo, due) => {
		const { database, store } = await connection();
		await database.run(
			`UPDATE snapshot_collection SET claimed_at = ${ago(claimedAgo)}, finished_at = ${ago(finishedAgo)}, holder = 'previous'`,
		);

		assert.equal(await store.claimCollection(interval, "claimant"), due);

		const row = await database.get<{ holder: string; finished_at: number | null; fresh: number }>(
			"SELECT holder, finished_at, unixepoch() - claimed_at < 5 AS fresh FROM snapshot_collection",
		);
		if (due) {
			assert.equal(row?.holder, "claimant", "a due claim takes the row");
			assert.equal(row?.finished_at, null, "and starts it unfinished");
			assert.equal(row?.fresh, 1);
		} else {
			assert.equal(row?.holder, "previous", "a claim that is not due leaves the row alone");
		}
	});

	test("a collection that failed backs off for the whole interval, not just the lease", async () => {
		const { database, store } = await connection();
		await database.run(
			`UPDATE snapshot_collection SET claimed_at = ${ago(lease + 60)}, finished_at = ${ago(lease + 30)}, error_code = 'collection-failed', holder = 'previous'`,
		);

		assert.equal(await store.claimCollection(interval, "claimant"), false);
	});

	test("a sweep renews its own holder's claim in every batch, and no other holder's", async () => {
		const { database, store } = await connection();
		await agedOrphans(store, database, 1);
		const claimAge = async () =>
			Number(
				(await database.get<{ age: number }>("SELECT unixepoch() - claimed_at AS age FROM snapshot_collection"))
					?.age,
			);
		await database.run("UPDATE snapshot_collection SET holder = 'owner', claimed_at = unixepoch() - 100");

		await store.sweep({ graceSeconds: 0, holder: "someone else" });
		assert.ok((await claimAge()) >= 99, "another holder's sweep leaves the claim alone");

		await store.sweep({ graceSeconds: 0, holder: "owner" });
		assert.ok((await claimAge()) < 5, "the owner's sweep renews it");
	});

	test("an interrupted collection is resumed by the next process once its lease has expired, not once its interval has", async () => {
		const fault: { current?: Fault } = {};
		const { database, store } = await connection({ fault });
		const orphans = await agedOrphans(store, database, 300);
		let pages = 0;
		fault.current = (sql) => {
			if (!sql.startsWith("SELECT created_at, hash")) return undefined;
			return ++pages === 2 ? new StoreClosedError(database.descriptor) : undefined;
		};
		const interrupted = await scheduleSnapshotCollection(store, settings, silent);
		assert.equal(interrupted.status, "interrupted");
		fault.current = undefined;

		resetSnapshotCollectionScheduleForTesting();
		assert.deepEqual(await scheduleSnapshotCollection(store, settings, silent), {
			status: "skipped",
			reason: "not-due",
		});
		await database.run("UPDATE snapshot_collection SET claimed_at = claimed_at - ?", lease + 5);
		resetSnapshotCollectionScheduleForTesting();
		const resumed = await scheduleSnapshotCollection(store, settings, silent);

		assert.equal(resumed.status, "collected");
		assert.equal((resumed as { deleted: readonly string[] }).deleted.length, orphans.length - 256);
		assert.deepEqual(await store.listBlobHashes(), []);
	});

	test("after an interrupted collection this process asks the database again at the next trigger, not after its interval", async () => {
		const fault: { current?: Fault } = {};
		const { database, store, counted, reset } = await connection({ fault });
		await agedOrphans(store, database, 300);
		let pages = 0;
		fault.current = (sql) =>
			sql.startsWith("SELECT created_at, hash") && ++pages === 2
				? new StoreClosedError(database.descriptor)
				: undefined;
		await scheduleSnapshotCollection(store, settings, silent);
		fault.current = undefined;
		reset();

		const next = await scheduleSnapshotCollection(store, settings, silent);

		assert.deepEqual(next, { status: "skipped", reason: "not-due" });
		assert.equal(counted.statements.length, 1, "it read the claim row instead of trusting its own throttle");
	});
});

describe("the collection a process is running, and a failure listener that throws (#4355)", () => {
	test("runningSnapshotCollection returns the collection of that database until it settles, whichever store asks", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { store } = await connection({ gate });
		const { store: sibling } = await connection();

		const running = scheduleSnapshotCollection(store, settings, silent);

		assert.equal(runningSnapshotCollection(store), running);
		assert.equal(runningSnapshotCollection(sibling), running, "a store of the same database and prefix shares it");
		assert.equal(runningSnapshotCollection(new MemorySnapshotBlobStore()), undefined);
		assert.equal(runningSnapshotCollection(undefined), undefined);
		release();
		await running;
		assert.equal(runningSnapshotCollection(store), undefined);
	});

	test("runningSnapshotCollectionsOn lists the collections of the database it names and no other", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const held = await connection({ gate, file: "held.sqlite" });
		const other = await connection({ file: "other.sqlite" });

		const running = scheduleSnapshotCollection(held.store, settings, silent);

		assert.deepEqual(runningSnapshotCollectionsOn(held.database.descriptor), [running]);
		assert.deepEqual(runningSnapshotCollectionsOn(other.database.descriptor), []);
		release();
		await running;
		assert.deepEqual(runningSnapshotCollectionsOn(held.database.descriptor), []);
	});

	test.each([
		["an error", new Error("listener failed"), "listener failed"],
		["something that is not an error", "listener text", "listener text"],
	] as const)(
		"a listener that throws %s changes neither the outcome nor later collections, and is reported as a warning",
		async (_name, thrown, message) => {
			const fault: { current?: Fault } = {
				current: (sql) => (sql.startsWith("DELETE") ? new Error("locked") : undefined),
			};
			const { database, store } = await connection({ fault });
			await agedOrphans(store, database, 1);
			const warnings: unknown[] = [];
			vi.spyOn(process, "emitWarning").mockImplementation((warning) => void warnings.push(warning));
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => unhandled.push(reason);
			process.on("unhandledRejection", onUnhandled);
			closers.push(async () => void process.off("unhandledRejection", onUnhandled));
			const clock = vi.spyOn(performance, "now").mockReturnValue(0);
			const onFailure = () => {
				throw thrown;
			};

			const outcome = await scheduleSnapshotCollection(store, settings, { onFailure });
			await new Promise((resolve) => setTimeout(resolve, 0));

			assert.equal(outcome.status, "failed");
			assert.equal(warnings.length, 1);
			assert.ok(warnings[0] instanceof Error);
			assert.equal(warnings[0].message, message);
			assert.deepEqual(unhandled, []);
			assert.equal(runningSnapshotCollection(store), undefined, "the table is not stuck in progress");

			await database.run(
				"UPDATE snapshot_collection SET claimed_at = claimed_at - ?, finished_at = finished_at - ?",
				settings.collectIntervalSeconds,
				settings.collectIntervalSeconds,
			);
			clock.mockReturnValue(settings.collectIntervalSeconds * 1000);
			const again = await scheduleSnapshotCollection(store, settings, { onFailure });
			assert.equal(again.status, "failed", "the next due trigger runs a collection");
			assert.equal(warnings.length, 1, "the same failure is reported once");
		},
	);
});

describe("scheduleSnapshotCollection validates its settings at entry, before any storage is touched (#4355)", () => {
	const GRACE = "a non-negative integer number of seconds";
	const INTERVAL = "a positive integer";
	test.each([
		["graceSeconds", -5, GRACE],
		["graceSeconds", -100_000, GRACE],
		["graceSeconds", 1.5, GRACE],
		["graceSeconds", Number.NaN, GRACE],
		["graceSeconds", "10", GRACE],
		["collectIntervalSeconds", 0, INTERVAL],
		["collectIntervalSeconds", -1, INTERVAL],
		["collectIntervalSeconds", Number.NaN, INTERVAL],
		["autoCollect", "yes", "true or false"],
	] as const)("%s %s is refused with a typed config error and no statement runs", async (field, value, expected) => {
		const { database, store, counted, reset } = await connection();
		await agedOrphans(store, database, 1);
		reset();

		assert.throws(
			() => scheduleSnapshotCollection(store, { ...settings, [field]: value } as never, silent),
			(error: unknown) => {
				assert.ok(isWorkspaceConfigError(error));
				assert.equal(error.code, "invalid-setting");
				assert.deepEqual(error.fields, { source: "sdk", field: `settings.${field}`, expected });
				return true;
			},
		);

		assert.equal(counted.statements.length, 0);
		assert.equal(counted.counts.transactions, 0);
		assert.equal((await store.listBlobHashes()).length, 1, "nothing was deleted");
	});

	test("an invalid setting is refused even when the collection would have been skipped, and a non-object too", () => {
		assert.throws(
			() => scheduleSnapshotCollection(new MemorySnapshotBlobStore(), { ...settings, graceSeconds: -1 }, silent),
			isWorkspaceConfigError,
		);
		assert.throws(
			() =>
				scheduleSnapshotCollection(
					undefined,
					{ ...settings, autoCollect: false, collectIntervalSeconds: 0 },
					silent,
				),
			isWorkspaceConfigError,
		);
		assert.throws(
			() => scheduleSnapshotCollection(undefined, null as never, silent),
			(error: unknown) => {
				assert.ok(isWorkspaceConfigError(error));
				assert.deepEqual(error.fields, { source: "sdk", field: "settings", expected: "an object" });
				return true;
			},
		);
	});
});
