import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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
	type SqliteDatabase,
} from "@bastani/atomic/storage";
import { afterEach, beforeEach, test } from "vitest";
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
	assert.equal(shards.length, 1);
	await assert.rejects(
		shards[0]!.getRun("slow"),
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

	const failing = await ShardedRunJournal.open({
		directory: join(root, "other"),
		openShard: async (path) => {
			const shard = await openSqlRunJournal(path);
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
