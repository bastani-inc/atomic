import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	adoptJournals,
	consolidateJournalStore,
	isJournalCatalogError,
	isJournalShardUnavailableError,
	JournalCatalog,
	openNodeSqliteDatabase,
	StorageConfigError,
	StorageProvider,
	StorageUnavailableError,
	storageSelectionKey,
} from "@bastani/atomic/storage";
import { afterEach, beforeEach, test } from "vitest";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { openSelectedRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { ShardedRunJournal } from "../../packages/workflows/src/durable/journal/sharded-run-journal.js";
import { openSqlRunJournal, SqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	JournalClosedError,
	JournalInvalidTextError,
	type Lease,
	type RunJournal,
	RunNotFoundError,
	StaleLeaseError,
} from "../../packages/workflows/src/durable/journal/types.js";
import { durableRunNotFoundError, formatRunNotFound } from "../../packages/workflows/src/durable/run-not-found.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";

let root: string;
let store: string;
const closing: (() => Promise<void>)[] = [];
beforeEach(() => {
	root = makeTempDirectory("journal-store-routing-");
	store = join(root, "journal");
});
afterEach(async () => {
	for (const close of closing.splice(0).reverse()) await close();
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

test("invalid identifiers fail with JournalInvalidTextError before the catalog is read, also for runs the store does not hold (#4325)", async () => {
	const journal = await open();
	const catalog = Reflect.get(journal, "catalog") as JournalCatalog;
	let reads = 0;
	for (const method of ["locate", "place", "shards", "owners", "homeShard"] as const) {
		const original = (catalog[method] as (...args: never[]) => unknown).bind(catalog);
		Reflect.set(catalog, method, (...args: never[]) => {
			reads++;
			return original(...args);
		});
	}
	const bad = "bad\u0000id";
	const lease = { runId: "ghost", holderId: "owner", epoch: 1 };
	const event = { type: "RunStarted", payload: null } as const;
	const header = { runId: "ghost", name: "wf", cwd: "/p", createdAt: 1, status: "running" };
	const cases: [string, () => Promise<unknown>][] = [
		["runId", () => journal.createRun({ ...header, runId: bad })],
		["name", () => journal.createRun({ ...header, name: bad })],
		["cwd", () => journal.createRun({ ...header, cwd: bad })],
		["status", () => journal.createRun({ ...header, status: bad })],
		["runId", () => journal.getRun(bad)],
		["cwd", () => journal.listRuns({ cwd: bad })],
		["runId", () => journal.snapshotTail(bad)],
		["runId", () => journal.acquire(bad, "h")],
		["holderId", () => journal.acquire("ghost", bad)],
		["runId", () => journal.takeover(bad, "h", "e")],
		["holderId", () => journal.takeover("ghost", bad, "e")],
		["expectedHolder", () => journal.takeover("ghost", "h", bad)],
		["runId", () => journal.takeoverExpired(bad, "h", 1)],
		["holderId", () => journal.takeoverExpired("ghost", bad, 1)],
		["runId", () => journal.leaseState(bad)],
		["runId", () => journal.renew({ ...lease, runId: bad })],
		["holderId", () => journal.renew({ ...lease, holderId: bad })],
		["runId", () => journal.release({ ...lease, runId: bad })],
		["holderId", () => journal.release({ ...lease, holderId: bad })],
		["runId", () => journal.append({ ...lease, runId: bad }, event)],
		["holderId", () => journal.append({ ...lease, holderId: bad }, event)],
		["runId", () => journal.appendMany({ ...lease, runId: bad }, [])],
		["holderId", () => journal.appendMany({ ...lease, holderId: bad }, [])],
		["runId", () => journal.read(bad)[Symbol.asyncIterator]().next()],
		["runId", () => journal.readKey(bad, "k")],
		["key", () => journal.readKey("ghost", bad)],
		["runId", () => journal.deleteRun(bad)],
		["runId", () => journal.deleteOwnedRun({ ...lease, runId: bad })],
		["holderId", () => journal.deleteOwnedRun({ ...lease, holderId: bad })],
		["runId", () => journal.journalFor(bad)],
		["runId", () => journal.existingJournalFor(bad)],
	];
	for (const [field, operation] of cases)
		await assert.rejects(operation(), (error: Error) => {
			assert.ok(error instanceof JournalInvalidTextError, `${field}: ${error}`);
			assert.equal(error.field, field);
			return true;
		});
	assert.equal(reads, 0, "no invalid identifier reached the catalog");
	await assert.rejects(
		journal.createRun({ ...header, inputs: { big: 1n } as never }),
		(error: Error) => error instanceof StorageUnavailableError && error.location === store,
	);
	assert.deepEqual(await journal.listRuns(), [], "an unserializable header places nothing");
});

test("a run the store does not hold is absent to reads and refused to writes as a single-file journal refuses it (#4325)", async () => {
	const journal = await open();
	const lease = { runId: "ghost", holderId: "owner", epoch: 1 };
	assert.equal(await journal.getRun("ghost"), undefined);
	assert.equal(await journal.leaseState("ghost"), undefined);
	assert.equal(await journal.snapshotTail("ghost"), undefined);
	assert.equal(await journal.readKey("ghost", "k"), undefined);
	assert.equal(await journal.existingJournalFor("ghost"), undefined);
	const entries = [];
	for await (const entry of journal.read("ghost")) entries.push(entry);
	assert.deepEqual(entries, []);
	await journal.deleteRun("ghost");
	for (const operation of [
		() => journal.acquire("ghost", "h"),
		() => journal.takeover("ghost", "h", "e"),
		() => journal.takeoverExpired("ghost", "h", 1),
	])
		await assert.rejects(operation(), (error: Error) => error instanceof RunNotFoundError && error.runId === "ghost");
	for (const operation of [
		() => journal.renew(lease),
		() => journal.release(lease),
		() => journal.append(lease, { type: "RunStarted", payload: null }),
		() => journal.deleteOwnedRun(lease),
	])
		await assert.rejects(operation(), StaleLeaseError);
	await assert.rejects(
		journal.appendMany(lease, [{ event: { type: "RunStarted", payload: null }, context: (action) => action() }]),
		StaleLeaseError,
	);
});

test("a closed store refuses every operation as a closed journal, names its directory, and closes once (#4325)", async () => {
	const journal = await ShardedRunJournal.open({ directory: store, openShard: (path) => openSqlRunJournal(path) });
	const lease = await start(journal, "r");
	assert.equal(journal.catalogPath, join(store, "catalog.sqlite"));
	assert.deepEqual(journal.descriptor, { adapter: "journal-store", location: store });
	const first = journal.close();
	assert.equal(journal.close(), first);
	await first;
	for (const operation of [
		() => journal.createRun({ runId: "x", name: "wf", cwd: "/p", createdAt: 1, status: "running" }),
		() => journal.getRun("r"),
		() => journal.listRuns(),
		() => journal.changeToken(),
		() => journal.runVersions(),
		() => journal.snapshotTail("r"),
		() => journal.acquire("r", "o"),
		() => journal.leaseState("r"),
		() => journal.append(lease, { type: "RunStarted", payload: null }),
		() => journal.read("r")[Symbol.asyncIterator]().next(),
		() => journal.journalFor("r"),
		() => journal.existingJournalFor("r"),
		() => journal.deleteRun("r"),
	])
		await assert.rejects(operation(), (error: Error) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.ok(error.cause instanceof JournalClosedError);
			assert.equal(error.location, store);
			assert.equal(error.adapter, "journal-store");
			return true;
		});
});

test("listings order runs across shards and list a run once, from the shard the catalog places it on (#4325)", async () => {
	const journal = await open();
	const later = await start(journal, "b-root");
	await start(journal, "a-root");
	const bShard = journal.shardOf("b-root")!;
	const aShard = journal.shardOf("a-root")!;
	assert.notEqual(aShard.id, bShard.id);
	assert.deepEqual(
		(await journal.listRuns()).map((run) => run.runId),
		["a-root", "b-root"],
	);
	await journal.append(later, { type: "SummaryRecorded", payload: "owner copy" });
	const stray = await openSqlRunJournal(aShard.path);
	await stray.createRun({ runId: "b-root", name: "stray copy", cwd: "/elsewhere", createdAt: 1, status: "running" });
	await stray.close();
	const listed = await journal.listRuns();
	assert.deepEqual(
		listed.map((run) => [run.runId, run.name]),
		[
			["a-root", "wf"],
			["b-root", "wf"],
		],
	);
	assert.deepEqual(
		(await journal.listRuns({ cwd: "/elsewhere" })).map((run) => run.runId),
		[],
	);
	const earlier = await openSqlRunJournal(bShard.path);
	await earlier.createRun({ runId: "a-root", name: "stray copy", cwd: "/elsewhere", createdAt: 1, status: "running" });
	const strayLease = await earlier.acquire("a-root", "stray");
	if (strayLease.status === "acquired") {
		await earlier.append(strayLease.lease, { type: "SummaryRecorded", payload: 1 });
		await earlier.append(strayLease.lease, { type: "SummaryRecorded", payload: 2 });
	}
	await earlier.close();
	assert.equal((await journal.listRuns()).find((run) => run.runId === "a-root")?.name, "wf");
	const versions = await journal.runVersions();
	assert.deepEqual([...versions.keys()].sort(), ["a-root", "b-root"]);
	assert.equal(versions.get("b-root")?.seq, 1, "the owner's version, not the stray copy's");
	assert.equal(versions.get("a-root")?.seq, 0, "the owner's version even when a stray copy's shard comes first");
});

test("a run no catalog lists that two adopted journals hold is listed once, from the first (#4325)", async () => {
	const first = join(root, "one", "journal.sqlite");
	const second = join(root, "two", "journal.sqlite");
	for (const path of [first, second]) {
		mkdirSync(join(path, ".."), { recursive: true });
		await (await openSqlRunJournal(path)).close();
	}
	await adoptJournals(store, [first, second]);
	for (const [path, name] of [
		[first, "first"],
		[second, "second"],
	] as const) {
		const journal = await openSqlRunJournal(path);
		await journal.createRun({ runId: "twin", name, cwd: "/p", createdAt: 1, status: "failed" });
		await journal.close();
	}
	const journal = await open();
	assert.deepEqual(
		(await journal.listRuns()).map((run) => run.name),
		["first"],
	);
	assert.deepEqual([...(await journal.runVersions()).keys()], ["twin"]);
});

test("the change token moves with catalog commits, shard commits and a shard that disappears, and only then (#4325)", async () => {
	const legacy = join(root, "old", "journal.sqlite");
	mkdirSync(join(legacy, ".."), { recursive: true });
	const seed = await openSqlRunJournal(legacy);
	await seed.createRun({ runId: "old-run", name: "wf", cwd: "/p", createdAt: 1, status: "failed" });
	await seed.close();
	await adoptJournals(store, [legacy]);
	const journal = await open();
	const lease = await start(journal, "r");
	const before = await journal.changeToken();
	assert.equal(await journal.changeToken(), before);
	await journal.append(lease, { type: "SummaryRecorded", payload: 1 });
	const afterShard = await journal.changeToken();
	assert.notEqual(afterShard, before);
	const other = await JournalCatalog.open(store);
	await other.setStatus("r", "paused");
	await other.close();
	const afterCatalog = await journal.changeToken();
	assert.notEqual(afterCatalog, afterShard);
	await journal.close();
	rmSync(join(root, "old"), { recursive: true, force: true });
	const reopened = await open();
	const token = JSON.parse(await reopened.changeToken()) as string[];
	assert.ok(token.includes("unavailable:shard-missing"), JSON.stringify(token));
});

test("appendMany records the last status it appended, and shards without appendMany append one by one (#4325)", async () => {
	for (const withBatch of [true, false]) {
		const journal = await open(async (path) => {
			const shard = await openSqlRunJournal(path);
			if (!withBatch) Reflect.set(shard, "appendMany", undefined);
			return shard;
		});
		const runId = `batch-${withBatch}`;
		const lease = await start(journal, runId);
		const context = <R>(action: () => R): R => action();
		const results = await journal.appendMany(lease, [
			{ event: { type: "StatusChanged", payload: { status: "paused" } }, context },
			{ event: { type: "CheckpointRecorded", payload: { kind: "tool" } }, key: "k", context },
			{ event: { type: "StatusChanged", payload: { status: "completed" } }, context },
			{ event: { type: "CheckpointRecorded", payload: { kind: "tool" } }, key: "k", context },
		]);
		assert.deepEqual(
			results.map((result) => (result.status === "fulfilled" ? result.value.status : "rejected")),
			["appended", "appended", "appended", "exists"],
		);
		const catalog = await JournalCatalog.open(store);
		assert.equal((await catalog.locate(runId))?.run.status, "completed");
		await catalog.close();
		await journal.close();
	}
});

test("a run moved by a consolidation is found again by a store that cached its old shard (#4325)", async () => {
	const legacy = join(root, "old", "journal.sqlite");
	mkdirSync(join(legacy, ".."), { recursive: true });
	const seed = await openSqlRunJournal(legacy);
	const lease = await start(seed, "mover");
	await seed.append(lease, { type: "RunStarted", payload: { snapshot: 1 } });
	await seed.append(lease, { type: "StatusChanged", payload: { status: "completed" } });
	await seed.release(lease);
	await seed.close();
	await adoptJournals(store, [legacy]);
	const journal = await open();
	assert.equal(journal.shardOf("mover"), undefined);
	assert.equal((await journal.getRun("mover"))?.status, "completed");
	assert.equal(journal.shardOf("mover")?.kind, "adopted");
	assert.equal((await consolidateJournalStore(store)).moved, 1);
	assert.equal((await journal.getRun("mover"))?.status, "completed", "getRun follows the move");
	assert.equal(journal.shardOf("mover")?.kind, "native");
	const moved = await open();
	await moved.getRun("mover");
	assert.equal((await consolidateJournalStore(store)).moved, 0);
	const catalog = await JournalCatalog.open(store);
	const adopted = (await catalog.shards()).find((shard) => shard.kind === "adopted")!;
	await catalog.close();
	const cached = await open();
	await cached.getRun("mover");
	Reflect.get(cached, "located").set("mover", adopted);
	const read = [];
	for await (const entry of cached.read("mover")) read.push(entry.event.type);
	assert.deepEqual(read, ["RunStarted", "StatusChanged"], "read follows the move");
	Reflect.get(cached, "located").set("mover", adopted);
	assert.equal(
		(await cached.snapshotTail("mover"))?.snapshot.event.type,
		"StatusChanged",
		"snapshotTail follows the move",
	);
});

test("a shard that failed to open is retried, and leaves the unavailable list once it opens (#4325)", async () => {
	const legacy = join(root, "flaky", "journal.sqlite");
	mkdirSync(join(legacy, ".."), { recursive: true });
	const seed = await openSqlRunJournal(legacy);
	await seed.createRun({ runId: "flaky-run", name: "wf", cwd: "/p", createdAt: 1, status: "failed" });
	await seed.close();
	await adoptJournals(store, [legacy]);
	const saved = join(root, "saved.sqlite");
	rmSync(saved, { force: true });
	const database = new DatabaseSync(legacy);
	database.exec(`VACUUM INTO '${saved}'`);
	database.close();
	for (const suffix of ["", "-wal", "-shm"]) rmSync(`${legacy}${suffix}`, { force: true });
	writeFileSync(legacy, "not a database ".repeat(500));
	const journal = await open();
	const failure = await journal.getRun("flaky-run").catch((error: Error) => error);
	assert.ok(isJournalShardUnavailableError(failure) && failure.code === "shard-open-failed");
	assert.deepEqual(await journal.listRuns(), []);
	assert.equal(journal.unavailableShards().length, 1);
	rmSync(legacy);
	writeFileSync(legacy, new Uint8Array(await (await import("node:fs/promises")).readFile(saved)));
	assert.equal((await journal.getRun("flaky-run"))?.runId, "flaky-run");
	await journal.listRuns();
	assert.deepEqual(journal.unavailableShards(), []);
});

test("deleting a run removes it from its shard and the catalog (#4325)", async () => {
	const journal = await open();
	await start(journal, "plain");
	const owned = await start(journal, "owned");
	await journal.deleteRun("plain");
	await journal.deleteOwnedRun(owned);
	const catalog = await JournalCatalog.open(store);
	try {
		for (const runId of ["plain", "owned"]) {
			assert.equal(await journal.getRun(runId), undefined);
			assert.equal(await catalog.locate(runId), undefined);
			assert.equal(journal.shardOf(runId), undefined);
		}
	} finally {
		await catalog.close();
	}
});

test("only a given legacy journal is adopted when a store opens (#4325)", async () => {
	const legacy = join(root, "journal.sqlite");
	const seed = await openSqlRunJournal(legacy);
	await seed.createRun({ runId: "legacy-run", name: "wf", cwd: "/p", createdAt: 1, status: "failed" });
	await seed.close();
	for (const legacyJournal of [false, undefined] as const) {
		const journal = await ShardedRunJournal.open({
			directory: store,
			openShard: (path) => openSqlRunJournal(path),
			...(legacyJournal === undefined ? {} : { legacyJournal }),
		});
		assert.deepEqual(await journal.listRuns(), []);
		await journal.close();
	}
	const adopted = await ShardedRunJournal.open({
		directory: store,
		openShard: (path) => openSqlRunJournal(path),
		legacyJournal: legacy,
	});
	closing.push(() => adopted.close());
	assert.deepEqual(
		(await adopted.listRuns()).map((run) => run.runId),
		["legacy-run"],
	);
});

test("the provider opens the journal store only for a journal, keyed by its resolved directory (#4325)", async () => {
	const memory = (descriptor: { adapter: string; location: string }) => new MemoryRunJournal(descriptor);
	const sql = SqlRunJournal.open;
	const context = { agentDir: root, domain: "journal" as const };
	const withoutStore = new StorageProvider({ memory, sql });
	await assert.rejects(withoutStore.openRunJournal({ kind: "sharded", dir: store }, context), (error: Error) => {
		assert.ok(error instanceof StorageConfigError);
		assert.deepEqual([error.source, error.field, error.reason], ["sdk", "journal", "adapter-domain-unsupported"]);
		return true;
	});
	const provider = new StorageProvider({ memory, sql, store: () => Promise.resolve(new MemoryRunJournal()) });
	for (const dir of ["", 5 as unknown as string])
		await assert.rejects(provider.openRunJournal({ kind: "sharded", dir }, context), (error: Error) => {
			assert.ok(error instanceof StorageConfigError);
			assert.deepEqual([error.source, error.field, error.reason], ["sdk", "dir", "invalid-dir"]);
			return true;
		});
	await assert.rejects(provider.openSessionStore({ kind: "sharded", dir: store }, context), (error: Error) => {
		assert.ok(error instanceof StorageConfigError);
		assert.deepEqual([error.source, error.field, error.reason], ["sdk", "dir", "adapter-domain-unsupported"]);
		return true;
	});
	await assert.rejects(provider.openRunJournal(null as never, context), (error: Error) => {
		assert.ok(error instanceof StorageConfigError);
		assert.deepEqual([error.source, error.reason], ["sdk", "selection-object-required"]);
		return true;
	});
	const seen: [string, string][] = [];
	const recording = new StorageProvider({
		memory,
		sql,
		store: async (directory, _openShard, legacyJournal) => {
			seen.push([directory, legacyJournal]);
			return new MemoryRunJournal();
		},
	});
	await (await recording.openRunJournal({ kind: "sharded", dir: store }, context)).close();
	assert.deepEqual(seen, [[store, join(root, "journal.sqlite")]]);
	assert.equal(
		storageSelectionKey({ kind: "sharded", dir: relative(process.cwd(), store) }),
		storageSelectionKey({ kind: "sharded", dir: store }),
	);
	assert.equal(storageSelectionKey({ kind: "sharded", dir: store }), JSON.stringify(["sharded", store]));
	assert.notEqual(
		storageSelectionKey({ kind: "sharded", dir: store }),
		storageSelectionKey({ kind: "sqlite", path: store }),
	);
});

test("run-not-found names the storage searched and whether it is local only, for every journal selection (#4325)", async () => {
	const backends: JournalDurableBackend[] = [];
	const backendOver = async (journal: RunJournal) => {
		const backend = await JournalDurableBackend.open(journal, { runs: [] });
		backends.push(backend);
		return backend;
	};
	try {
		const sqlite = await backendOver(
			await openSelectedRunJournal({ kind: "sqlite", path: join(root, "one.sqlite") }, root),
		);
		const memory = await backendOver(await openSelectedRunJournal({ kind: "memory" }, root));
		const fixture = join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts");
		const adapter = await backendOver(
			await openSelectedRunJournal(
				{ kind: "adapter", module: fixture, options: { path: join(root, "adapter.sqlite") } },
				root,
			),
		);
		const caller = await openNodeSqliteDatabase(join(root, "caller.sqlite"));
		const database = await backendOver(await openSelectedRunJournal({ kind: "database", database: caller }, root));
		const direct = await backendOver(new MemoryRunJournal());
		const sharded = await backendOver(await openSelectedRunJournal({ kind: "sharded", dir: store }, root));
		const elsewhere = {} as DurableWorkflowBackend;
		const rows = [sqlite, memory, adapter, database, direct, sharded, elsewhere].map((backend) => {
			const error = durableRunNotFoundError(backend, "r");
			return [
				error.fields.selection,
				error.fields.catalogPath,
				error.fields.localOnly,
				error.hint.includes("atomic storage join"),
			];
		});
		assert.deepEqual(rows, [
			[`SQLite journal ${join(root, "one.sqlite")}`, join(root, "one.sqlite"), true, true],
			["memory journal", "", true, true],
			[`storage adapter ${fixture}`, join(root, "adapter.sqlite"), false, false],
			["caller-owned database node-sqlite", join(root, "caller.sqlite"), true, true],
			["this session's workflow store", "", true, true],
			[`journal store ${store}`, join(store, "catalog.sqlite"), true, true],
			["this session's workflow store", "", true, true],
		]);
		const error = durableRunNotFoundError(sharded, "r");
		assert.equal(formatRunNotFound(error), `${error.message}\n${error.hint}`);
		assert.ok(isJournalCatalogError(error) && error.code === "run-not-found" && error.runId === "r");
		await caller.close();
	} finally {
		for (const backend of backends) await backend.close();
	}
});
