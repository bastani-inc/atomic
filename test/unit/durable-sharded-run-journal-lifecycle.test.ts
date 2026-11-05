import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	adoptJournals,
	consolidateJournalStore,
	isJournalCatalogError,
	isJournalShardUnavailableError,
	JournalCatalog,
	JournalCatalogError,
	openNodeSqliteDatabase,
	rehydrateJournalStoreError,
	type SqliteDatabase,
	serializeJournalStoreError,
} from "@bastani/atomic/storage";
import { afterEach, beforeEach, test } from "vitest";
import { JOURNAL_READ_PAGE_SIZE } from "../../packages/workflows/src/durable/journal/internal.js";
import {
	isShardedRunJournal,
	ShardedRunJournal,
} from "../../packages/workflows/src/durable/journal/sharded-run-journal.js";
import { openSqlRunJournal, SqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	JournalClosedError,
	JournalSchemaVersionError,
	type Lease,
	type RunJournal,
	RunNotFoundError,
	StaleLeaseError,
	StorageUnavailableError,
} from "../../packages/workflows/src/durable/journal/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

let root: string;
let store: string;
const closing: (() => Promise<void>)[] = [];
beforeEach(() => {
	root = makeTempDirectory("journal-store-lifecycle-");
	store = join(root, "journal");
});
afterEach(async () => {
	for (const close of closing.splice(0).reverse()) await close().catch(() => {});
	removeTempDirectory(root);
});

async function open(openShard: (path: string) => Promise<RunJournal> = (path) => openSqlRunJournal(path)) {
	const journal = await ShardedRunJournal.open({ directory: store, openShard });
	closing.push(() => journal.close());
	return journal;
}

async function start(journal: RunJournal, runId: string): Promise<Lease> {
	await journal.createRun({ runId, name: "wf", cwd: "/p", createdAt: 1, status: "running" });
	const outcome = await journal.acquire(runId, "owner");
	if (outcome.status !== "acquired") throw new Error("not acquired");
	return outcome.lease;
}

function countCalls<T extends object>(target: T, methods: readonly (keyof T & string)[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const method of methods) {
		counts[method] = 0;
		const original = (target[method] as (...args: never[]) => unknown).bind(target);
		Reflect.set(target, method, (...args: never[]) => {
			counts[method]!++;
			return original(...args);
		});
	}
	return counts;
}

test("opening an initialized journal takes no write lock; a new one is initialized once (#4325)", async () => {
	const database = await openNodeSqliteDatabase(join(root, "journal.sqlite"));
	try {
		const counted: SqliteDatabase = database;
		const counts = countCalls(database, ["transaction"]);
		const first = await SqlRunJournal.open(counted);
		assert.equal(counts.transaction, 1, "a new journal creates its tables in one transaction");
		await first.close();
		const second = await SqlRunJournal.open(counted);
		await second.close();
		assert.equal(counts.transaction, 1, "an initialized journal opens without a transaction");
		await database.run("UPDATE wf_meta SET schema_version = 2");
		await assert.rejects(SqlRunJournal.open(counted), (error: Error) => {
			assert.ok(error instanceof JournalSchemaVersionError);
			assert.deepEqual([error.domain, error.found, error.supported], ["journal", 2, 1]);
			return true;
		});
		assert.equal(counts.transaction, 1, "an unsupported version is refused without a transaction");
		await database.run("DELETE FROM wf_meta");
		await (await SqlRunJournal.open(counted)).close();
		assert.equal(counts.transaction, 2, "missing metadata goes through the initializing transaction");
	} finally {
		await database.close();
	}
});

test("listings across many shards come back in run ID order (#4325)", async () => {
	const journal = await open();
	for (const runId of ["d-root", "b-root", "e-root", "a-root", "c-root"]) await start(journal, runId);
	assert.equal(
		new Set(["a-root", "b-root", "c-root", "d-root", "e-root"].map((id) => journal.shardOf(id)!.id)).size,
		5,
	);
	assert.deepEqual(
		(await journal.listRuns()).map((run) => run.runId),
		["a-root", "b-root", "c-root", "d-root", "e-root"],
	);
});

test("a located run is not looked up in the catalog again, and an existing root is not placed again (#4325)", async () => {
	const journal = await open();
	const lease = await start(journal, "r");
	const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
	const counts = countCalls(catalog, ["locate", "place", "shards"]);
	await journal.getRun("r");
	await journal.append(lease, { type: "SummaryRecorded", payload: 1 });
	await journal.journalFor("r");
	await journal.existingJournalFor("r");
	assert.deepEqual(counts, { locate: 0, place: 0, shards: 0 });
	const fresh = await open();
	const freshCatalog = Reflect.get(fresh, "catalog") as JournalCatalog;
	const freshCounts = countCalls(freshCatalog, ["locate", "place"]);
	await fresh.journalFor("r");
	assert.deepEqual(freshCounts, { locate: 1, place: 0 });
});

test("a run the catalog does not list is looked for only in adopted journals, past one that cannot open (#4325)", async () => {
	const missing = join(root, "a-missing", "journal.sqlite");
	const empty = join(root, "b-empty", "journal.sqlite");
	const found = join(root, "c-found", "journal.sqlite");
	for (const path of [missing, empty, found]) {
		mkdirSync(join(path, ".."), { recursive: true });
		await (await openSqlRunJournal(path)).close();
	}
	await adoptJournals(store, [missing, empty, found]);
	const late = await openSqlRunJournal(found);
	await late.createRun({ runId: "late", name: "wf", cwd: "/p", createdAt: 1, status: "failed" });
	await late.close();
	removeTempDirectory(join(root, "a-missing"));
	const asked: string[] = [];
	const journal = await open(async (path) => {
		const shard = await openSqlRunJournal(path);
		const getRun = shard.getRun.bind(shard);
		shard.getRun = (runId) => {
			asked.push(path);
			return getRun(runId);
		};
		return shard;
	});
	await start(journal, "native-root");
	await journal.getRun("native-root");
	asked.length = 0;
	assert.equal((await journal.getRun("late"))?.runId, "late");
	assert.deepEqual(asked, [empty, found, found], "only adopted journals were asked, past the missing one");
	assert.equal(journal.shardOf("late")?.path, found);
	const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
	assert.equal((await catalog.locate("late"))?.shard.path, found, "the run is indexed where it was found");
	assert.deepEqual(
		[...(await journal.runVersions()).keys()].sort(),
		["late", "native-root"],
		"versions skip the missing shard",
	);
});

test("a run indexed elsewhere meanwhile is routed to the shard the catalog chose (#4325)", async () => {
	const first = join(root, "first", "journal.sqlite");
	const second = join(root, "second", "journal.sqlite");
	for (const path of [first, second]) {
		mkdirSync(join(path, ".."), { recursive: true });
		await (await openSqlRunJournal(path)).close();
	}
	await adoptJournals(store, [first, second]);
	const seed = await openSqlRunJournal(first);
	await seed.createRun({ runId: "raced", name: "wf", cwd: "/p", createdAt: 1, status: "failed" });
	await seed.close();
	const journal = await open();
	const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
	const shards = await catalog.shards();
	Reflect.set(catalog, "index", async () => shards[1]!.id);
	assert.equal(await journal.getRun("raced"), undefined, "the shard the catalog chose does not hold it");
	assert.equal(journal.shardOf("raced")?.id, shards[1]!.id);
	Reflect.set(catalog, "index", async () => 99);
	Reflect.get(journal, "located").delete("raced");
	assert.equal(await journal.getRun("raced"), undefined, "a shard the catalog does not register is no location");
});

test("a run deleted from its shard behind the catalog's back reads as absent, not as an error (#4325)", async () => {
	const journal = await open();
	await start(journal, "gone");
	const shard = new DatabaseSync(journal.shardOf("gone")!.path);
	shard.exec("DELETE FROM wf_runs; DELETE FROM wf_events; DELETE FROM wf_leases");
	shard.close();
	assert.equal(await journal.getRun("gone"), undefined);
	assert.equal(await journal.snapshotTail("gone"), undefined);
	const entries = [];
	for await (const entry of journal.read("gone")) entries.push(entry);
	assert.deepEqual(entries, []);
});

test("shards without the optional change tracking still list, version and tail (#4325)", async () => {
	const journal = await open(async (path) => {
		const shard = await openSqlRunJournal(path);
		for (const method of ["changeToken", "runVersions", "snapshotTail"]) Reflect.set(shard, method, undefined);
		return shard;
	});
	await start(journal, "plain");
	assert.ok((JSON.parse(await journal.changeToken()) as string[]).includes("untracked"));
	assert.deepEqual(await journal.runVersions(), new Map([["plain", { seq: 0, at: 0 }]]));
	assert.equal(await journal.snapshotTail("plain"), undefined);
	const elsewhere = { ...journal.shardOf("plain")!, id: 999 };
	Reflect.get(journal, "located").set("plain", elsewhere);
	assert.equal(
		await journal.snapshotTail("plain"),
		undefined,
		"a run found again on another shard is tailed only if that shard can",
	);
});

test("the catalog records a status only for a status change that was appended (#4325)", async () => {
	const journal = await open();
	const lease = await start(journal, "status");
	const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
	const status = async () => (await catalog.locate("status"))?.run.status;
	await journal.append(lease, { type: "SummaryRecorded", payload: "no status" });
	assert.equal(await status(), "running");
	assert.deepEqual(journal.catalogBacklog(), { pending: 0 }, "an append without a status records nothing");
	await journal.append(lease, { type: "StatusChanged", payload: { status: "paused" } }, { key: "status" });
	assert.equal(await status(), "paused");
	const existing = await journal.append(
		lease,
		{ type: "StatusChanged", payload: { status: "failed" } },
		{ key: "status" },
	);
	assert.equal(existing.status, "exists");
	assert.equal(await status(), "paused", "a status whose key already exists was not appended");
	const context = <R>(action: () => R): R => action();
	await journal.appendMany(lease, [
		{ event: { type: "StatusChanged", payload: { status: "failed" } }, key: "status", context },
		{ event: { type: "SummaryRecorded", payload: null }, context },
	]);
	assert.equal(await status(), "paused", "a batch whose only status change already exists records nothing");
	await journal.appendMany(lease, [{ event: { type: "SummaryRecorded", payload: null }, context }]);
	assert.deepEqual(journal.catalogBacklog(), { pending: 0 }, "a batch without a status records nothing");
	await journal.appendMany(lease, [
		{ event: { type: "StatusChanged", payload: { status: "bad\u0000" } }, context },
		{ event: { type: "SummaryRecorded", payload: null }, context },
	]);
	assert.equal(await status(), "paused", "a rejected status change records nothing");
	await journal.appendMany(lease, [
		{ event: { type: "SummaryRecorded", payload: null }, context },
		{ event: { type: "StatusChanged", payload: { status: "failed" } }, key: "status", context },
	]);
	assert.equal(await status(), "paused", "a status change that already exists records nothing, last in its batch");
	await journal.appendMany(lease, [
		{ event: { type: "StatusChanged", payload: { status: "completed" } }, key: "done", context },
		{ event: { type: "SummaryRecorded", payload: null }, context },
	]);
	assert.equal(await status(), "completed", "an appended status change is recorded, whatever follows it");
	assert.deepEqual(journal.catalogBacklog(), { pending: 0 });
});

test("close waits for operations in flight, closes every shard and the catalog, and reports a failed close (#4325)", async () => {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const shards: RunJournal[] = [];
	const journal = await ShardedRunJournal.open({
		directory: store,
		openShard: async (path) => {
			const shard = await openSqlRunJournal(path);
			const leaseState = shard.leaseState.bind(shard);
			shard.leaseState = async (runId) => {
				await gate;
				return leaseState(runId);
			};
			shards.push(shard);
			return shard;
		},
	});
	await start(journal, "slow");
	const pending = journal.leaseState("slow");
	await new Promise((resolve) => setTimeout(resolve, 20));
	let closed = false;
	const closing = journal.close().then(() => {
		closed = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(closed, false, "close waits for the operation in flight");
	release();
	assert.equal((await pending)?.holderId, "owner", "the operation in flight completes");
	await closing;
	assert.equal(shards.length, 2, "the shard was opened to prepare it, then to use it");
	await assert.rejects(
		shards[1]!.getRun("slow"),
		(error: Error) => error instanceof StorageUnavailableError && error.cause instanceof JournalClosedError,
	);
	await assert.rejects(
		(Reflect.get(journal, "catalog") as JournalCatalog).shards(),
		(error: Error) => isJournalCatalogError(error) && error.code === "catalog-unavailable",
	);

	let opened = 0;
	const failing = await ShardedRunJournal.open({
		directory: join(root, "other"),
		openShard: async (path) => {
			const shard = await openSqlRunJournal(path);
			if (opened++ === 1) {
				const close = shard.close.bind(shard);
				shard.close = async () => {
					await close();
					throw new Error("shard close failed");
				};
			}
			return shard;
		},
	});
	await start(failing, "x");
	await start(failing, "y");
	await assert.rejects(failing.close(), /shard close failed/, "a later shard's failed close is reported");
});

test("a store whose legacy journal cannot be registered fails to open and closes its catalog (#4325)", async () => {
	const legacy = join(root, "journal.sqlite");
	const seed = await openSqlRunJournal(legacy);
	await seed.createRun({ runId: "legacy-run", name: "wf", cwd: "/p", createdAt: 1, status: "failed" });
	await seed.close();
	const catalog = await JournalCatalog.open(store);
	await catalog.close();
	const database = new DatabaseSync(join(store, "catalog.sqlite"));
	database.exec("CREATE TRIGGER refuse BEFORE INSERT ON catalog_shards BEGIN SELECT RAISE(ABORT, 'refused'); END");
	database.close();
	await assert.rejects(
		ShardedRunJournal.open({ directory: store, openShard: (path) => openSqlRunJournal(path), legacyJournal: legacy }),
		(error: Error) => isJournalCatalogError(error) && error.code === "write-failed",
	);
	const check = new DatabaseSync(join(store, "catalog.sqlite"));
	check.exec("DROP TRIGGER refuse");
	check.close();
	const reopened = await ShardedRunJournal.open({
		directory: store,
		openShard: (path) => openSqlRunJournal(path),
		legacyJournal: legacy,
	});
	closing.push(() => reopened.close());
	assert.deepEqual(
		(await reopened.listRuns()).map((run) => run.runId),
		["legacy-run"],
	);
});

test("a journal store is recognized from another loaded copy of the workflows runtime by its registered brand (#4325)", async () => {
	const journal = await open();
	assert.ok(isShardedRunJournal(journal));
	const brand = Symbol.for("@bastani/workflows/sharded-run-journal");
	assert.ok(isShardedRunJournal({ [brand]: true } as unknown as RunJournal));
	const plain = await openSqlRunJournal(join(root, "plain.sqlite"));
	closing.push(() => plain.close());
	assert.equal(isShardedRunJournal(plain), false);
});

test("looking up a run the catalog does not list opens no native shard (#4325)", async () => {
	const journal = await open();
	await start(journal, "one");
	await start(journal, "two");
	const opened: string[] = [];
	const fresh = await open(async (path) => {
		opened.push(path);
		return openSqlRunJournal(path);
	});
	assert.equal(await fresh.getRun("unknown"), undefined);
	assert.deepEqual(opened, []);
});

test("a run another store deleted reads as absent where this store still had it located (#4325)", async () => {
	const journal = await open();
	const lease = await start(journal, "deleted");
	const record = journal.shardOf("deleted")!;
	const other = await open();
	await other.deleteOwnedRun(lease);
	const located = Reflect.get(journal, "located") as Map<string, typeof record>;
	assert.equal(await journal.getRun("deleted"), undefined);
	located.set("deleted", record);
	assert.equal(await journal.snapshotTail("deleted"), undefined);
	located.set("deleted", record);
	const entries = [];
	for await (const entry of journal.read("deleted")) entries.push(entry);
	assert.deepEqual(entries, []);
});

test("a status the catalog failed to record stays owed while an earlier one completes (#4325)", async () => {
	const journal = await open();
	const lease = await start(journal, "raced");
	const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
	const setStatus = catalog.setStatus.bind(catalog);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let calls = 0;
	Reflect.set(catalog, "setStatus", async (runId: string, status: string) => {
		if (++calls === 1) {
			entered.resolve();
			await release.promise;
			return setStatus(runId, status);
		}
		throw new JournalCatalogError({
			code: "write-failed",
			catalogPath: catalog.path,
			phase: "recording-status",
			runId,
		});
	});
	const first = journal.append(lease, { type: "StatusChanged", payload: { status: "paused" } });
	await entered.promise;
	await journal.append(lease, { type: "StatusChanged", payload: { status: "completed" } });
	release.resolve();
	await first;
	assert.equal(journal.catalogBacklog().pending, 1, "the later status is still owed to the catalog");
});

test("a read a consolidation interrupts yields each entry once (#4325)", async () => {
	const legacy = join(root, "old", "journal.sqlite");
	mkdirSync(join(legacy, ".."), { recursive: true });
	const seed = await openSqlRunJournal(legacy);
	const lease = await start(seed, "moving");
	await seed.append(lease, { type: "RunStarted", payload: { snapshot: 1 } });
	await seed.append(lease, { type: "SummaryRecorded", payload: null });
	await seed.append(lease, { type: "StatusChanged", payload: { status: "completed" } });
	await seed.release(lease);
	await seed.close();
	await adoptJournals(store, [legacy]);
	const journal = await open();
	const seen: number[] = [];
	for await (const entry of journal.read("moving")) {
		seen.push(entry.seq);
		if (seen.length === 1) assert.equal((await consolidateJournalStore(store)).moved, 1);
	}
	assert.deepEqual(seen, [1, 2, 3]);
});

test("a failed open keeps its error and attaches the catalog's failed close; several failed closes are all reported (#4325)", async () => {
	const legacy = join(root, "journal.sqlite");
	const seed = await openSqlRunJournal(legacy);
	await seed.createRun({ runId: "legacy-run", name: "wf", cwd: "/p", createdAt: 1, status: "failed" });
	await seed.close();
	await (await JournalCatalog.open(store)).close();
	const database = new DatabaseSync(join(store, "catalog.sqlite"));
	database.exec("CREATE TRIGGER refuse BEFORE INSERT ON catalog_shards BEGIN SELECT RAISE(ABORT, 'refused'); END");
	database.close();
	const closeFailure = new Error("catalog close failed");
	const close = JournalCatalog.prototype.close;
	const restore = () => {
		JournalCatalog.prototype.close = close;
	};
	JournalCatalog.prototype.close = async function (this: JournalCatalog) {
		restore();
		await close.call(this);
		throw closeFailure;
	};
	try {
		await assert.rejects(
			ShardedRunJournal.open({
				directory: store,
				openShard: (path) => openSqlRunJournal(path),
				legacyJournal: legacy,
			}),
			(error: Error) =>
				isJournalCatalogError(error) &&
				error.code === "write-failed" &&
				Object.getOwnPropertyDescriptor(error, "cleanupCause")?.value === closeFailure &&
				Object.getOwnPropertyDescriptor(error, "cleanupCause")?.configurable === true,
		);
	} finally {
		restore();
	}

	const opens = new Map<string, number>();
	const failing = await ShardedRunJournal.open({
		directory: join(root, "other"),
		openShard: async (path) => {
			const shard = await openSqlRunJournal(path);
			opens.set(path, (opens.get(path) ?? 0) + 1);
			if (opens.get(path) === 1) return shard;
			const closeShard = shard.close.bind(shard);
			shard.close = async () => {
				await closeShard();
				throw new Error(`close failed: ${path}`);
			};
			return shard;
		},
	});
	await start(failing, "x");
	await start(failing, "y");
	await assert.rejects(failing.close(), (error: Error) => {
		assert.ok(error instanceof AggregateError);
		assert.equal(error.errors.length, 2);
		assert.equal(error.message, "2 journal store databases failed to close");
		return true;
	});
});

test("a native shard whose file was deleted fails its runs with shard-missing instead of reading as an empty journal (#4325)", async () => {
	const first = await open();
	await start(first, "lost");
	const shard = first.shardOf("lost")!;
	await first.close();
	rmSync(shard.path);
	const reopened = await open();
	for (const operation of [
		() => reopened.getRun("lost"),
		() => reopened.createRun({ runId: "lost", name: "wf", cwd: "/p", createdAt: 1, status: "running" }),
	])
		await assert.rejects(operation(), (error: Error) => {
			assert.ok(isJournalShardUnavailableError(error));
			assert.deepEqual([error.code, error.shardId, error.shardPath], ["shard-missing", shard.id, shard.path]);
			return true;
		});
	assert.equal(existsSync(shard.path), false, "the store did not create an empty shard in its place");
	assert.deepEqual(await reopened.listRuns(), []);
	assert.deepEqual(
		reopened.unavailableShards().map((error) => [error.code, error.shardId]),
		[["shard-missing", shard.id]],
	);
});

test("a run seen in an adopted journal that another process consolidated is read, leased and deleted where it moved (#4325)", async () => {
	const legacy = join(root, "old", "journal.sqlite");
	mkdirSync(join(legacy, ".."), { recursive: true });
	const seed = await openSqlRunJournal(legacy);
	const lease = await start(seed, "moved");
	await seed.append(lease, { type: "RunStarted", payload: { snapshot: 1 } }, { key: "start" });
	await seed.append(lease, { type: "StatusChanged", payload: { status: "completed" } });
	await seed.release(lease);
	await seed.close();
	await adoptJournals(store, [legacy]);
	const journal = await open();
	assert.equal((await journal.getRun("moved"))?.status, "completed");
	assert.equal(journal.shardOf("moved")?.kind, "adopted");
	assert.equal((await consolidateJournalStore(store)).moved, 1);
	assert.equal((await journal.readKey("moved", "start"))?.event.type, "RunStarted");
	const resumed = await journal.acquire("moved", "resumer");
	assert.equal(resumed.status, "acquired");
	assert.equal(journal.shardOf("moved")?.kind, "native");
	await journal.deleteRun("moved");
	const native = new DatabaseSync(await nativeShardOf(store), { readOnly: true });
	try {
		assert.equal(native.prepare("SELECT count(*) AS n FROM wf_events WHERE run_id = 'moved'").get()?.n, 0);
	} finally {
		native.close();
	}
	assert.equal(await (await open()).getRun("moved"), undefined);
});

async function nativeShardOf(directory: string): Promise<string> {
	const catalog = await JournalCatalog.open(directory);
	try {
		return (await catalog.shards()).find((shard) => shard.kind === "native")!.path;
	} finally {
		await catalog.close();
	}
}

test("a run a consolidation moves between finding and reading it is read where it moved (#4325)", async () => {
	const expected = {
		getRun: "completed",
		snapshotTail: "StatusChanged",
		read: "RunStarted,StatusChanged",
	} as const;
	for (const method of ["getRun", "snapshotTail", "read"] as const) {
		const legacy = join(root, method, "old", "journal.sqlite");
		const moving = join(root, method, "journal");
		mkdirSync(join(legacy, ".."), { recursive: true });
		const seed = await openSqlRunJournal(legacy);
		const lease = await start(seed, "racing");
		await seed.append(lease, { type: "RunStarted", payload: { snapshot: 1 } });
		await seed.append(lease, { type: "StatusChanged", payload: { status: "completed" } });
		await seed.release(lease);
		await seed.close();
		await adoptJournals(moving, [legacy]);
		let consolidated = false;
		const consolidateOnce = async () => {
			if (consolidated) return;
			consolidated = true;
			assert.equal((await consolidateJournalStore(moving)).moved, 1);
		};
		const journal = await ShardedRunJournal.open({
			directory: moving,
			openShard: async (path) => {
				const shard = await openSqlRunJournal(path);
				if (path !== legacy) return shard;
				const getRun = shard.getRun.bind(shard);
				const snapshotTail = shard.snapshotTail.bind(shard);
				const read = shard.read.bind(shard);
				shard.getRun = async (runId) => {
					await consolidateOnce();
					return getRun(runId);
				};
				shard.snapshotTail = async (runId) => {
					await consolidateOnce();
					return snapshotTail(runId);
				};
				shard.read = async function* (runId, fromSeq) {
					await consolidateOnce();
					yield* read(runId, fromSeq);
				};
				return shard;
			},
		});
		closing.push(() => journal.close());
		const observed =
			method === "getRun"
				? (await journal.getRun("racing"))?.status
				: method === "snapshotTail"
					? (await journal.snapshotTail("racing"))?.snapshot.event.type
					: await (async () => {
							const types: string[] = [];
							for await (const entry of journal.read("racing")) types.push(entry.event.type);
							return types.join(",");
						})();
		assert.equal(consolidated, true, `${method} raced a consolidation`);
		assert.equal(observed, expected[method], method);
	}
});

async function finish(journal: ShardedRunJournal, runId: string): Promise<void> {
	const lease = await start(journal, runId);
	await journal.append(lease, { type: "StatusChanged", payload: { status: "completed" } });
	await journal.release(lease);
}

test("new roots are never placed on a native shard whose file was lost, and that shard stops taking roots (#4325)", async () => {
	const first = await open();
	await start(first, "busy-a");
	await finish(first, "finished-b");
	const lost = first.shardOf("busy-a")!;
	assert.notEqual(first.shardOf("finished-b")!.id, lost.id);
	await first.close();
	const backup = join(root, "lost-shard.backup");
	copyFileSync(lost.path, backup);
	rmSync(lost.path);
	const reopened = await open();
	const placed = new Set<number>();
	for (const runId of ["new-1", "new-2", "new-3"]) {
		assert.equal(
			await reopened.createRun({ runId, name: "wf", cwd: "/p", createdAt: 1, status: "running" }),
			"created",
		);
		placed.add(reopened.shardOf(runId)!.id);
		assert.equal((await reopened.getRun(runId))?.runId, runId);
	}
	assert.equal(placed.has(lost.id), false, "no new root went to the lost shard");
	const catalog = new DatabaseSync(join(store, "catalog.sqlite"), { readOnly: true });
	try {
		assert.equal(
			catalog.prepare("SELECT accepts_new_roots AS accepts FROM catalog_shards WHERE id = ?").get(lost.id)?.accepts,
			0,
			"the lost shard takes no more roots",
		);
		assert.equal(
			catalog.prepare("SELECT shard FROM catalog_runs WHERE run_id = 'busy-a'").get()?.shard,
			lost.id,
			"its registered run stays where it was",
		);
	} finally {
		catalog.close();
	}
	await assert.rejects(reopened.getRun("busy-a"), (error: Error) => {
		assert.ok(isJournalShardUnavailableError(error));
		assert.equal(error.code, "shard-missing");
		return true;
	});
	copyFileSync(backup, lost.path);
	assert.equal((await (await open()).getRun("busy-a"))?.runId, "busy-a", "restoring the file restores the run");
});

test("a root whose shard refuses it is only reserved, then recorded once its shard accepted it (#4325)", async () => {
	let refuse = true;
	const prepared = new Set<string>();
	const journal = await open(async (path) => {
		if (refuse && prepared.has(path)) throw new Error("shard refused to open");
		prepared.add(path);
		return openSqlRunJournal(path);
	});
	const header = { runId: "reserved-root", name: "wf", cwd: "/p", createdAt: 1, status: "running" } as const;
	await assert.rejects(journal.createRun(header), (error: Error) => {
		assert.ok(isJournalShardUnavailableError(error));
		assert.equal(error.code, "shard-open-failed");
		return true;
	});
	const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
	const reserved = await catalog.locate("reserved-root");
	assert.equal(reserved?.run.status, undefined, "the failed creation left a reservation, not a running root");
	refuse = false;
	assert.equal(await journal.createRun(header), "created");
	assert.equal((await catalog.locate("reserved-root"))?.run.status, "running");
	assert.equal(await journal.createRun(header), "exists");
	const counts = countCalls(catalog, ["place"]);
	await journal.createRun(header);
	assert.equal(counts.place, 1, "an existing root is looked up once, and its status is not written again");
});

const PAGED_EVENTS = 2 * JOURNAL_READ_PAGE_SIZE + 88;

/** A finished run in an adopted journal, with `PAGED_EVENTS` events: more than two pages of the journal's reads. */
async function adoptedPagedRun(): Promise<string> {
	const legacy = join(root, "paged", "journal.sqlite");
	mkdirSync(join(legacy, ".."), { recursive: true });
	const seed = await openSqlRunJournal(legacy);
	const lease = await start(seed, "paged");
	await seed.append(lease, { type: "RunStarted", payload: { snapshot: 1 } });
	await seed.append(lease, { type: "StatusChanged", payload: { status: "completed" } });
	await seed.release(lease);
	await seed.close();
	const database = new DatabaseSync(legacy);
	database.exec(
		`WITH RECURSIVE n(i) AS (SELECT 3 UNION ALL SELECT i + 1 FROM n WHERE i < ${PAGED_EVENTS})
		INSERT INTO wf_events(run_id, seq, epoch, key, type, payload, at)
		SELECT 'paged', i, 1, 'k' || i, 'SummaryRecorded', 'null', 0 FROM n`,
	);
	database.close();
	await adoptJournals(store, [legacy]);
	return legacy;
}

async function readAll(
	journal: RunJournal,
	runId: string,
	onEntry?: (count: number) => Promise<void>,
): Promise<number[]> {
	const seqs: number[] = [];
	for await (const entry of journal.read(runId)) {
		seqs.push(entry.seq);
		await onEntry?.(seqs.length);
	}
	return seqs;
}

test("a read that a consolidation interrupts between pages continues on the new shard without a gap or a repeat (#4325)", async () => {
	await adoptedPagedRun();
	const journal = await open();
	const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
	const counts = countCalls(catalog, ["locate"]);
	let moved = 0;
	const seqs = await readAll(journal, "paged", async (count) => {
		if (count === JOURNAL_READ_PAGE_SIZE) moved = (await consolidateJournalStore(store)).moved;
	});
	assert.equal(moved, 1);
	assert.deepEqual(
		seqs,
		Array.from({ length: PAGED_EVENTS }, (_, index) => index + 1),
	);
	assert.ok(counts.locate! <= 3, `the catalog was asked ${counts.locate} times`);
	assert.deepEqual(
		await readAll(await open(), "paged"),
		seqs,
		"after the move a fresh store reads it all from its new shard",
	);
});

test("a read whose continuation does not follow on fails with the retryable run-moved, never a short read (#4325)", async () => {
	await adoptedPagedRun();
	const journal = await open();
	const failure = await readAll(journal, "paged", async (count) => {
		if (count !== JOURNAL_READ_PAGE_SIZE) return;
		await consolidateJournalStore(store);
		const destination = (await (Reflect.get(journal, "catalog") as JournalCatalog).locate("paged"))!.shard.path;
		const database = new DatabaseSync(destination);
		database.exec("DELETE FROM wf_events WHERE run_id = 'paged' AND seq = 257");
		database.close();
	}).catch((error: Error) => error);
	assert.ok(isJournalCatalogError(failure));
	assert.deepEqual(
		[failure.code, failure.retryable, failure.runId, failure.fields.lastSeq],
		["run-moved", true, "paged", JOURNAL_READ_PAGE_SIZE],
	);
	const back = rehydrateJournalStoreError(serializeJournalStoreError(failure));
	assert.ok(isJournalCatalogError(back) && back.code === "run-moved" && back.retryable);
	assert.equal(back.fields.lastSeq, JOURNAL_READ_PAGE_SIZE);
});

test("a read whose run moved to a shard that is gone fails with shard-missing, not a short read (#4325)", async () => {
	await adoptedPagedRun();
	const journal = await open();
	const failure = await readAll(journal, "paged", async (count) => {
		if (count !== JOURNAL_READ_PAGE_SIZE) return;
		await consolidateJournalStore(store);
		const destination = (await (Reflect.get(journal, "catalog") as JournalCatalog).locate("paged"))!.shard.path;
		for (const suffix of ["", "-wal", "-shm"]) rmSync(`${destination}${suffix}`, { force: true });
	}).catch((error: Error) => error);
	assert.ok(isJournalShardUnavailableError(failure));
	assert.equal(failure.code, "shard-missing");
});

for (const [moves, outcome] of [
	[3, "completes"],
	[4, "fails with run-moved"],
] as const)
	test(`a read of a run that moves ${moves} times ${outcome}: it follows at most three moves (#4325)`, async () => {
		await adoptedPagedRun();
		const journal = await open();
		const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
		const locate = catalog.locate.bind(catalog);
		let calls = 0;
		Reflect.set(catalog, "locate", async (runId: string) => {
			const found = await locate(runId);
			const moved = Math.min(calls++, moves);
			return found === undefined || moved === 0 ? found : { ...found, shard: { ...found.shard, id: 100 + moved } };
		});
		const result = await readAll(journal, "paged").catch((error: Error) => error);
		if (outcome === "completes") {
			assert.deepEqual(
				result,
				Array.from({ length: PAGED_EVENTS }, (_, index) => index + 1),
			);
			return;
		}
		assert.ok(isJournalCatalogError(result) && result.code === "run-moved");
		assert.equal(result.fields.lastSeq, PAGED_EVENTS, "it names the last entry it returned");
	});

test("a read from sequence 0 returns the whole run, as one from 1 does (#4325)", async () => {
	await adoptedPagedRun();
	const journal = await open();
	const seqs: number[] = [];
	for await (const entry of journal.read("paged", 0)) seqs.push(entry.seq);
	assert.deepEqual(
		seqs,
		Array.from({ length: PAGED_EVENTS }, (_, index) => index + 1),
	);
});

test("creating a run that another writer added to an adopted file since it was adopted finds it, and makes no empty copy (#4325)", async () => {
	const legacy = join(root, "adopted", "journal.sqlite");
	mkdirSync(join(legacy, ".."), { recursive: true });
	await (await openSqlRunJournal(legacy)).close();
	await adoptJournals(store, [legacy]);
	const writer = await openSqlRunJournal(legacy);
	await writer.createRun({ runId: "late", name: "wf", cwd: "/p", createdAt: 1, status: "failed" });
	await writer.close();
	const journal = await open();
	assert.equal(
		await journal.createRun({ runId: "late", name: "wf", cwd: "/p", createdAt: 2, status: "running" }),
		"exists",
	);
	assert.equal(journal.shardOf("late")?.kind, "adopted");
	const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
	assert.deepEqual(
		(await catalog.shards()).map((shard) => shard.kind),
		["adopted"],
		"no native shard was created for it",
	);
});

test("a key range of a run is read from its shard's key index, and from the moved shard after a move (#4325)", async () => {
	const legacy = join(root, "ranged", "journal.sqlite");
	mkdirSync(join(legacy, ".."), { recursive: true });
	const seed = await openSqlRunJournal(legacy);
	const lease = await start(seed, "ranged");
	for (const key of ["a-1", "b-1", "b-2", "c-1"])
		await seed.append(lease, { type: "RunStarted", payload: { key } }, { key });
	await seed.append(lease, { type: "StatusChanged", payload: { status: "completed" } });
	await seed.release(lease);
	await seed.close();
	await adoptJournals(store, [legacy]);
	const journal = await open();
	const keysOf = async (from: string, to: string, onFirst?: () => Promise<void>) => {
		const keys: (string | undefined)[] = [];
		for await (const entry of (journal as unknown as KeyRangeReader).readKeyRange("ranged", from, to)) {
			keys.push(entry.key);
			if (keys.length === 1) await onFirst?.();
		}
		return keys;
	};
	assert.deepEqual(await keysOf("b-", "b."), ["b-1", "b-2"]);
	assert.deepEqual(await keysOf("z", "zz"), []);
	assert.deepEqual(
		await keysOf("a-", "d", async () => void (await consolidateJournalStore(store))),
		["a-1", "b-1", "b-2", "c-1"],
		"a move during the read neither drops nor repeats an event",
	);
	assert.deepEqual(await keysOf("b-", "b."), ["b-1", "b-2"], "after the move, from the new shard");
});

interface KeyRangeReader {
	readKeyRange(runId: string, fromKey: string, toKey: string): AsyncIterable<{ key?: string }>;
}

async function rangeKeys(
	journal: RunJournal,
	fromKey: string,
	toKey: string,
	runId = "paged",
): Promise<(string | undefined)[]> {
	const keys: (string | undefined)[] = [];
	for await (const entry of (journal as unknown as KeyRangeReader).readKeyRange(runId, fromKey, toKey))
		keys.push(entry.key);
	return keys;
}

test("a key range refuses text no journal can store, field by field (#4325)", async () => {
	const journal = await open();
	for (const [runId, from, to, field] of [
		["a\u0000b", "a", "b", "runId"],
		["r", "a\u0000b", "b", "key"],
		["r", "a", "a\u0000b", "key"],
	] as const) {
		const failure = await rangeKeys(journal, from, to, runId).catch((error: Error) => error);
		assert.ok(failure instanceof Error && Reflect.get(failure, "field") === field, `${field}: ${String(failure)}`);
	}
});

test("a key range of a shard without a key index is filtered from the run's entries (#4325)", async () => {
	await adoptedPagedRun();
	const journal = await open(async (path) => new Proxy(await openSqlRunJournal(path), {}));
	const keys = await rangeKeys(journal, "k10", "k11");
	assert.deepEqual(keys, ["k10", "k100", "k101", "k102", "k103", "k104", "k105", "k106", "k107", "k108", "k109"]);
	assert.deepEqual(await rangeKeys(journal, "k600", "k601"), ["k600"], "the lower bound is included");
	assert.deepEqual(await rangeKeys(journal, "k600", "k600"), [], "the upper bound is not");
	assert.deepEqual(await rangeKeys(journal, "zz", "zzz"), []);
});

for (const [moves, outcome] of [
	[3, "completes"],
	[4, "fails with run-moved"],
] as const)
	test(`a key range read of a run that moves ${moves} times ${outcome}: it follows at most three moves (#4325)`, async () => {
		await adoptedPagedRun();
		const journal = await open();
		const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
		const locate = catalog.locate.bind(catalog);
		let calls = 0;
		Reflect.set(catalog, "locate", async (runId: string) => {
			const found = await locate(runId);
			const moved = Math.min(calls++, moves);
			return found === undefined || moved === 0 ? found : { ...found, shard: { ...found.shard, id: 100 + moved } };
		});
		const result = await rangeKeys(journal, "k", "l").catch((error: Error) => error);
		if (outcome === "completes") {
			assert.equal(Array.isArray(result) && result.length, PAGED_EVENTS - 2, "every event once");
			return;
		}
		assert.ok(isJournalCatalogError(result) && result.code === "run-moved");
		assert.equal(result.fields.lastSeq, PAGED_EVENTS);
	});

test("a new native shard never takes the path of an adopted shard whose file is gone, so that run fails typed (#4325)", async () => {
	mkdirSync(store, { recursive: true });
	const adoptedPath = join(store, "shard-0002.sqlite");
	const seed = await openSqlRunJournal(adoptedPath);
	await seed.createRun({ runId: "old", name: "wf", cwd: "/p", createdAt: 1, status: "failed" });
	await seed.close();
	await adoptJournals(store, [adoptedPath]);
	const backup = join(root, "adopted.backup");
	copyFileSync(adoptedPath, backup);
	rmSync(adoptedPath);
	const journal = await open();
	assert.equal(
		await journal.createRun({ runId: "new", name: "wf", cwd: "/p", createdAt: 2, status: "running" }),
		"created",
	);
	const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
	const paths = (await catalog.shards()).map((shard) => shard.path);
	assert.equal(new Set(paths).size, paths.length, "no two shards name one path");
	assert.notEqual(journal.shardOf("new")?.path, adoptedPath);
	await assert.rejects(journal.getRun("old"), (error: Error) => {
		assert.ok(isJournalShardUnavailableError(error));
		assert.deepEqual([error.code, error.shardPath], ["shard-missing", adoptedPath]);
		return true;
	});
	assert.deepEqual(
		(await journal.listRuns()).map((run) => run.runId),
		["new"],
	);
	assert.deepEqual(
		journal.unavailableShards().map((error) => error.shardPath),
		[adoptedPath],
	);
	copyFileSync(backup, adoptedPath);
	assert.equal(
		(await journal.getRun("new"))?.runId,
		"new",
		"restoring the adopted file leaves the native shard alone",
	);
	assert.equal((await (await open()).getRun("old"))?.runId, "old");
});

async function adoptedFinishedRun(name: string): Promise<string> {
	const legacy = join(root, name, "old", "journal.sqlite");
	mkdirSync(join(legacy, ".."), { recursive: true });
	const seed = await openSqlRunJournal(legacy);
	const lease = await start(seed, "r");
	await seed.append(lease, { type: "RunStarted", payload: { snapshot: 1 } }, { key: "start" });
	await seed.append(lease, { type: "StatusChanged", payload: { status: "completed" } });
	await seed.release(lease);
	await seed.close();
	await adoptJournals(store, [legacy]);
	return legacy;
}

test("deleting a run a consolidation moved meanwhile deletes it where it moved, and leaves no entry naming a copy (#4325)", async () => {
	const legacy = await adoptedFinishedRun("delete-race");
	let consolidated = false;
	const journal = await open(async (path) => {
		const shard = await openSqlRunJournal(path);
		if (path !== legacy) return shard;
		const deleteRun = shard.deleteRun.bind(shard);
		shard.deleteRun = async (runId) => {
			if (!consolidated) {
				consolidated = true;
				assert.equal((await consolidateJournalStore(store)).moved, 1);
			}
			return deleteRun(runId);
		};
		return shard;
	});
	await journal.deleteRun("r");
	assert.equal(consolidated, true);
	assert.equal(await journal.getRun("r"), undefined);
	const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
	assert.equal(await catalog.locate("r"), undefined, "no entry is left naming the moved copy");
	for (const shard of await catalog.shards()) {
		const database = new DatabaseSync(shard.path, { readOnly: true });
		assert.equal(database.prepare("SELECT count(*) AS n FROM wf_runs WHERE run_id = 'r'").get()?.n, 0, shard.path);
		database.close();
	}
});

test("a lease taken after a move was undone finds the run where the catalog now names it (#4325)", async () => {
	const legacy = await adoptedFinishedRun("undone");
	const backup = join(root, "undone.backup");
	copyFileSync(legacy, backup);
	const journal = await open();
	assert.equal((await consolidateJournalStore(store)).moved, 1);
	assert.equal((await journal.getRun("r"))?.runId, "r");
	const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
	const native = (await catalog.locate("r"))!.shard;
	assert.equal(journal.shardOf("r")?.id, native.id, "this process now caches the native copy");
	const nativeFile = new DatabaseSync(native.path);
	for (const table of ["wf_events", "wf_leases", "wf_runs"])
		nativeFile.exec(`DELETE FROM ${table} WHERE run_id = 'r'`);
	nativeFile.close();
	for (const suffix of ["", "-wal", "-shm"]) rmSync(`${legacy}${suffix}`, { force: true });
	copyFileSync(backup, legacy);
	const adopted = (await catalog.shards()).find((shard) => shard.kind === "adopted")!;
	assert.equal(await catalog.moveRun("r", native.id, adopted.id), true);
	const outcome = await journal.acquire("r", "resumer");
	assert.equal(outcome.status, "acquired");
	assert.equal(journal.shardOf("r")?.kind, "adopted");
});

test("deleting a run that did not move asks the catalog once and removes its entry (#4325)", async () => {
	await start(await open(), "plain");
	const journal = await open();
	const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
	const counts = countCalls(catalog, ["locate", "removeFrom"]);
	await journal.deleteRun("plain");
	assert.deepEqual([counts.locate, counts.removeFrom], [1, 1]);
	assert.equal(await catalog.locate("plain"), undefined);
});

for (const [moves, outcome] of [
	[3, "completes"],
	[4, "fails with run-moved"],
] as const)
	test(`deleting a run that moves ${moves} times meanwhile ${outcome}: it follows at most three moves (#4325)`, async () => {
		await start(await open(), "moving");
		const journal = await open();
		const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
		const locate = catalog.locate.bind(catalog);
		let located = 0;
		let removals = 0;
		Reflect.set(catalog, "locate", async (runId: string) => {
			const found = await locate(runId);
			const moved = Math.min(located++, moves);
			return found === undefined || moved === 0 ? found : { ...found, shard: { ...found.shard, id: 100 + moved } };
		});
		Reflect.set(catalog, "removeFrom", async () => ++removals > moves);
		const result = await journal.deleteRun("moving").catch((error: Error) => error);
		if (outcome === "completes") {
			assert.equal(result, undefined);
			return;
		}
		assert.ok(isJournalCatalogError(result) && result.code === "run-moved");
	});

test("a lease operation on a run its shard does not hold, and the catalog does not move, is still run-not-found (#4325)", async () => {
	const journal = await open();
	await start(journal, "vanished");
	const shard = new DatabaseSync(journal.shardOf("vanished")!.path);
	for (const table of ["wf_events", "wf_leases", "wf_runs"])
		shard.exec(`DELETE FROM ${table} WHERE run_id = 'vanished'`);
	shard.close();
	await assert.rejects(journal.acquire("vanished", "resumer"), (error: Error) => error instanceof RunNotFoundError);
});

test("deleting a run that vanishes while it is followed through three moves ends without an error (#4325)", async () => {
	await start(await open(), "vanishing");
	const journal = await open();
	const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
	const locate = catalog.locate.bind(catalog);
	let located = 0;
	Reflect.set(catalog, "locate", async (runId: string) => {
		const found = await locate(runId);
		const call = located++;
		if (call >= 4) return undefined;
		return found === undefined || call === 0 ? found : { ...found, shard: { ...found.shard, id: 100 + call } };
	});
	Reflect.set(catalog, "removeFrom", async () => false);
	await journal.deleteRun("vanishing");
});

test("a lease operation on a run no shard holds is a stale lease, with nothing written and no shard made (#4325)", async () => {
	const journal = await open();
	const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
	const writes = countCalls(catalog, ["place", "homeShard", "index", "setStatus", "remove", "removeFrom", "moveRun"]);
	const ghost: Lease = { runId: "ghost", holderId: "nobody", epoch: 3 };
	const event = { type: "StatusChanged", payload: { status: "completed" } } as const;
	const operations: Record<string, () => Promise<unknown>> = {
		renew: () => journal.renew(ghost),
		release: () => journal.release(ghost),
		append: () => journal.append(ghost, event),
		appendMany: () => journal.appendMany(ghost, [{ event, context: (action) => action() }]),
		deleteOwnedRun: () => journal.deleteOwnedRun(ghost),
	};
	for (const [name, operation] of Object.entries(operations))
		await assert.rejects(operation(), (error: Error) => {
			assert.ok(error instanceof StaleLeaseError, `${name}: ${error}`);
			assert.deepEqual([error.runId, error.heldEpoch, error.currentEpoch], ["ghost", 3, 0], name);
			return true;
		});
	assert.deepEqual(Object.values(writes), [0, 0, 0, 0, 0, 0, 0], "the catalog was not written");
	assert.deepEqual(
		readdirSync(store).filter((file) => file.startsWith("shard-")),
		[],
		"no shard file was made",
	);
	await assert.rejects(journal.acquire("ghost", "h"), (error: Error) => error instanceof RunNotFoundError);
});

for (const read of ["readKey", "leaseState"] as const)
	test(`${read} on a cached native copy a move's undo deleted finds the run where the catalog now names it (#4325)`, async () => {
		const legacy = await adoptedFinishedRun(`undone-${read}`);
		const backup = join(root, `undone-${read}.backup`);
		copyFileSync(legacy, backup);
		const journal = await open();
		assert.equal((await consolidateJournalStore(store)).moved, 1);
		assert.equal((await journal.getRun("r"))?.runId, "r");
		const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
		const native = (await catalog.locate("r"))!.shard;
		const nativeFile = new DatabaseSync(native.path);
		for (const table of ["wf_events", "wf_leases", "wf_runs"])
			nativeFile.exec(`DELETE FROM ${table} WHERE run_id = 'r'`);
		nativeFile.close();
		for (const suffix of ["", "-wal", "-shm"]) rmSync(`${legacy}${suffix}`, { force: true });
		copyFileSync(backup, legacy);
		const resumed = new DatabaseSync(legacy);
		resumed.exec("UPDATE wf_leases SET holder_id = 'held-by-a-resume' WHERE run_id = 'r'");
		resumed.close();
		const adopted = (await catalog.shards()).find((shard) => shard.kind === "adopted")!;
		assert.equal(await catalog.moveRun("r", native.id, adopted.id), true);
		const locates = countCalls(catalog, ["locate"]);
		if (read === "readKey") assert.equal((await journal.readKey("r", "start"))?.event.type, "RunStarted");
		else assert.equal((await journal.leaseState("r"))?.holderId, "held-by-a-resume");
		assert.ok(locates.locate! <= 2, `the catalog was asked ${locates.locate} times`);
		assert.equal(journal.shardOf("r")?.kind, "adopted");
	});

test("a key miss on a run its shard holds asks nothing of the catalog (#4325)", async () => {
	const journal = await open();
	await start(journal, "present");
	const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
	const locates = countCalls(catalog, ["locate", "shards"]);
	assert.equal(await journal.readKey("present", "never-written"), undefined);
	assert.equal((await journal.leaseState("present"))?.holderId, "owner");
	assert.deepEqual([locates.locate, locates.shards], [0, 0]);
});

test("the first new root placed after a reopen reconciles a root the catalog still counts as running with its shard's status (#4325)", async () => {
	const first = await open();
	await start(first, "crashed");
	const finished = await start(first, "finished");
	await first.append(finished, { type: "StatusChanged", payload: { status: "completed" } });
	await first.release(finished);
	assert.notEqual(first.shardOf("crashed")?.id, first.shardOf("finished")?.id);
	await first.close();
	const catalogFile = new DatabaseSync(join(store, "catalog.sqlite"));
	catalogFile.exec("UPDATE catalog_runs SET status = 'running' WHERE run_id = 'finished'");
	catalogFile.close();
	const reopened = await open();
	const catalog = Reflect.get(reopened, "catalog") as JournalCatalog;
	assert.equal(
		(await catalog.locate("finished"))?.run.status,
		"running",
		"opening reconciles nothing and opens no shard",
	);
	const shardsBefore = (await catalog.shards()).length;
	assert.equal(
		await reopened.createRun({ runId: "next", name: "wf", cwd: "/p", createdAt: 3, status: "running" }),
		"created",
	);
	assert.equal((await catalog.locate("finished"))?.run.status, "completed", "the saved status reaches the catalog");
	assert.equal((await catalog.locate("crashed"))?.run.status, "running", "a root that is still running is unchanged");
	assert.equal((await catalog.shards()).length, shardsBefore, "the idle shard takes the new root, no shard is added");
	assert.equal(reopened.shardOf("next")?.id, (await catalog.locate("finished"))?.shard.id);
});

test("the reconciliation runs once per process, writes only a status that differs, and reports a failed write (#4325)", async () => {
	const first = await open();
	await start(first, "running-root");
	const finished = await start(first, "finished-root");
	await first.append(finished, { type: "StatusChanged", payload: { status: "completed" } });
	await first.release(finished);
	await first.close();
	const catalogFile = new DatabaseSync(join(store, "catalog.sqlite"));
	catalogFile.exec("UPDATE catalog_runs SET status = 'running' WHERE run_id = 'finished-root'");
	catalogFile.close();
	const journal = await open();
	const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
	const calls = countCalls(catalog, ["busyRuns", "setStatus"]);
	await journal.createRun({ runId: "n1", name: "wf", cwd: "/p", createdAt: 1, status: "running" });
	await journal.createRun({ runId: "n2", name: "wf", cwd: "/p", createdAt: 1, status: "running" });
	await journal.journalFor("n3");
	assert.equal(calls.busyRuns, 1, "the busy roots are read once");
	assert.equal(calls.setStatus, 1, "only the root whose saved status differs is written");
});

for (const [failure, outcome] of [
	[new JournalCatalogError({ code: "write-failed", catalogPath: "/c", phase: "recording-status" }), "is reported"],
	[new Error("not a catalog error"), "is thrown"],
] as const)
	test(`a reconciliation write that fails with ${failure.name} ${outcome} (#4325)`, async () => {
		const first = await open();
		const finished = await start(first, "finished-root");
		await first.append(finished, { type: "StatusChanged", payload: { status: "completed" } });
		await first.release(finished);
		await first.close();
		const catalogFile = new DatabaseSync(join(store, "catalog.sqlite"));
		catalogFile.exec("UPDATE catalog_runs SET status = 'running' WHERE run_id = 'finished-root'");
		catalogFile.close();
		const journal = await open();
		const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
		Reflect.set(catalog, "setStatus", async () => {
			throw failure;
		});
		const placed = journal.createRun({ runId: "next", name: "wf", cwd: "/p", createdAt: 1, status: "running" });
		if (outcome === "is thrown") {
			await assert.rejects(placed, failure);
			return;
		}
		assert.equal(await placed, "created", "the failed write does not stop the new root");
		assert.equal(journal.catalogBacklog().failure, failure);
	});

for (const [label, unreadable] of [
	["is gone", (path: string) => rmSync(path)],
	[
		"is not a database",
		(path: string) => writeFileSync(path, "not a database, though long enough to be read as one's header"),
	],
	[
		"does not hold the run",
		(path: string) => {
			const shard = new DatabaseSync(path);
			for (const table of ["wf_events", "wf_leases", "wf_runs"])
				shard.exec(`DELETE FROM ${table} WHERE run_id = 'a-unreadable'`);
			shard.close();
		},
	],
] as const)
	test(`the reconciliation skips a running root whose shard ${label} and still reconciles the roots after it (#4325)`, async () => {
		const first = await open();
		await start(first, "a-unreadable");
		const finished = await start(first, "z-finished");
		await first.append(finished, { type: "StatusChanged", payload: { status: "completed" } });
		await first.release(finished);
		const unreadablePath = first.shardOf("a-unreadable")!.path;
		assert.notEqual(unreadablePath, first.shardOf("z-finished")!.path);
		await first.close();
		unreadable(unreadablePath);
		const catalogFile = new DatabaseSync(join(store, "catalog.sqlite"));
		catalogFile.exec("UPDATE catalog_runs SET status = 'running' WHERE run_id = 'z-finished'");
		catalogFile.close();
		const journal = await open();
		const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
		const written: unknown[][] = [];
		const setStatus = catalog.setStatus.bind(catalog);
		Reflect.set(catalog, "setStatus", async (...args: [string, string]) => {
			written.push(args);
			return setStatus(...args);
		});
		assert.equal(
			await journal.createRun({ runId: "next", name: "wf", cwd: "/p", createdAt: 3, status: "running" }),
			"created",
		);
		assert.deepEqual(journal.catalogBacklog(), { pending: 0 });
		assert.deepEqual(written, [["z-finished", "completed"]], "one write, of a status that exists");
		assert.equal((await catalog.locate("z-finished"))?.run.status, "completed");
		assert.equal((await catalog.locate("a-unreadable"))?.run.status, "running", "the unreadable root is unchanged");
	});
