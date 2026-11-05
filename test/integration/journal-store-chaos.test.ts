/**
 * Contention and chaos for the journal store (#4325): many writer processes on one shard and across shards, writers
 * killed while they hold a shard's write lock, a catalog writer killed mid-transaction or stalled past a connection's
 * lock wait, a lock holder stopped with SIGSTOP, a full disk, a shard file deleted before roots are created, and clock
 * skew on lease renewal. After each, no checkpoint is lost or written twice, every shard and the catalog pass
 * `PRAGMA integrity_check`, and no writer waited longer than the connection's lock wait.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	isJournalCatalogError,
	JournalCatalog,
	openNodeSqliteDatabase,
	type SqliteDatabase,
	StorageError,
} from "@bastani/atomic/storage";
import { afterEach, beforeEach, test } from "vitest";
import { ShardedRunJournal } from "../../packages/workflows/src/durable/journal/sharded-run-journal.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { StaleLeaseError } from "../../packages/workflows/src/durable/journal/types.js";
import { testRunId } from "../helpers/run-id.js";
import {
	bunExecutable,
	decodeStream,
	makeTempDirectory,
	moduleDir,
	readStreamText,
	removeTempDirectory,
	type SpawnedProcess,
	sleep,
	spawnProcess,
} from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const WRITER = join(ROOT, "test/fixtures/journal-store-writer.ts");
const HOLDER = join(ROOT, "test/fixtures/journal-store-lock-holder.mjs");
/** The lock wait of a node-sqlite connection (`DEFAULT_NODE_SQLITE_LOCK_WAIT_MS`): no writer may wait past it. */
const WRITER_WAIT_BOUND_MS = 30_000;
const CHECKPOINTS = 40;
const SQLITE_FULL = 13;

/** The SQLite result codes in an error's cause chain, including a rollback error's own cause. */
function sqliteCodes(error: unknown): number[] {
	const codes: number[] = [];
	for (let cause = error; cause instanceof Error; cause = cause.cause) {
		const code = (cause as { errcode?: unknown }).errcode;
		if (typeof code === "number") codes.push(code & 0xff);
	}
	return codes;
}
/** Writer processes each load the workflow journal from source under Bun before their first append. */
const CHAOS_SCENARIO_TIMEOUT_MS = 180_000;
/** A catalog lock held with no commit for longer than a journal connection's lock wait, which fails a journal write. */
const STALLED_CATALOG_HOLDER_MS = WRITER_WAIT_BOUND_MS + 2_000;
/** The stalled holder's time, plus starting the holder process and the placement after it. */
const STALLED_CATALOG_TIMEOUT_MS = STALLED_CATALOG_HOLDER_MS + 60_000;

let directory: string;
let store: string;
const processes: SpawnedProcess[] = [];
beforeEach(() => {
	directory = makeTempDirectory("journal-store-chaos-");
	store = join(directory, "journal");
});
afterEach(async () => {
	for (const child of processes.splice(0)) {
		if (child.exitCode === null) {
			child.kill("SIGCONT");
			child.kill("SIGKILL");
		}
		await child.exited;
	}
	removeTempDirectory(directory);
});

interface WriterSummary {
	readonly runId: string;
	readonly appended: number;
	readonly existed: number;
	readonly maxWaitMs: number;
}

function startWriter(
	mode: "router" | "shard",
	target: string,
	runId: string,
	barrier?: { readonly directory: string; readonly peers: number },
) {
	const child = spawnProcess(
		[
			bunExecutable(),
			WRITER,
			mode,
			target,
			runId,
			String(CHECKPOINTS),
			...(barrier === undefined ? [] : [barrier.directory, String(barrier.peers)]),
		],
		{ cwd: ROOT },
	);
	processes.push(child);
	const reader = decodeStream(child.stdout!).getReader();
	const stderr = readStreamText(child.stderr);
	let output = "";
	let progress = 0;
	const waiters: { readonly at: number; readonly resolve: () => void }[] = [];
	const done = (async (): Promise<WriterSummary | undefined> => {
		for (;;) {
			const { done: ended, value } = await reader.read();
			if (ended) break;
			output += value;
			for (const match of output.matchAll(/progress (\d+)\n/g)) progress = Math.max(progress, Number(match[1]));
			for (const waiter of waiters.splice(0)) {
				if (progress >= waiter.at) waiter.resolve();
				else waiters.push(waiter);
			}
		}
		const exitCode = await child.exited;
		const last = output.trim().split("\n").at(-1) ?? "";
		if (exitCode !== 0 || !last.startsWith("{")) return undefined;
		return JSON.parse(last) as WriterSummary;
	})();
	return {
		child,
		done,
		stderr,
		reached(at: number): Promise<void> {
			if (progress >= at) return Promise.resolve();
			return new Promise((resolve) => waiters.push({ at, resolve }));
		},
	};
}

async function finished(writer: ReturnType<typeof startWriter>): Promise<WriterSummary> {
	const summary = await writer.done;
	assert.ok(summary, `writer failed: ${await writer.stderr}`);
	assert.ok(summary.maxWaitMs < WRITER_WAIT_BOUND_MS, `writer ${summary.runId} waited ${summary.maxWaitMs} ms`);
	return summary;
}

async function holdLock(kind: "shard" | "catalog", path: string, runId = "") {
	const child = spawnProcess([process.execPath, HOLDER, kind, path, runId], {
		cwd: ROOT,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	processes.push(child);
	const reader = decodeStream(child.stdout!).getReader();
	let output = "";
	while (!output.includes("locked\n")) {
		const { done, value } = await reader.read();
		if (done) assert.fail(`lock holder exited early: ${await readStreamText(child.stderr)}`);
		output += value;
	}
	reader.releaseLock();
	return child;
}

/** Every checkpoint of `runId` is in `shard` exactly once, with dense sequences, and the file is intact. */
function assertRunIntact(shard: string, runId: string, count = CHECKPOINTS): void {
	const database = new DatabaseSync(shard, { readOnly: true });
	try {
		assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
		const rows = database.prepare("SELECT seq, key FROM wf_events WHERE run_id = ? ORDER BY seq").all(runId) as {
			seq: number;
			key: string | null;
		}[];
		assert.deepEqual(
			rows.map((row) => row.seq),
			rows.map((_, index) => index + 1),
			"sequences are dense",
		);
		const keys = rows.map((row) => row.key).filter((key) => key?.startsWith("checkpoint-"));
		assert.equal(keys.length, count, `${runId} has every checkpoint`);
		assert.equal(new Set(keys).size, count, `${runId} has no checkpoint twice`);
		assert.equal(rows.at(-1)?.key, "finished");
	} finally {
		database.close();
	}
}

function assertIntact(path: string): void {
	const database = new DatabaseSync(path, { readOnly: true });
	assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
	database.close();
}

/** Opens the store in this process and returns the shard a fresh root is placed on. */
async function shardFor(runId: string): Promise<string> {
	const journal = await ShardedRunJournal.open({ directory: store, openShard: (path) => openSqlRunJournal(path) });
	try {
		await journal.journalFor(runId);
		return journal.shardOf(runId)!.path;
	} finally {
		await journal.close();
	}
}

async function openSqlRunJournal(path: string): Promise<SqlRunJournal> {
	const database = await openNodeSqliteDatabase(path);
	return closingWith(await SqlRunJournal.open(database), database);
}

function closingWith(journal: SqlRunJournal, database: SqliteDatabase): SqlRunJournal {
	const close = journal.close.bind(journal);
	journal.close = async () => {
		await close();
		await database.close();
	};
	return journal;
}

test(
	"many writer processes on one shard and across shards lose no checkpoint, write none twice and keep every file intact (#4325)",
	async () => {
		const shared = await shardFor(testRunId("chaos-anchor"));
		const onShard = Array.from({ length: 6 }, (_, index) => testRunId(`chaos-shared-${index}`));
		const acrossShards = Array.from({ length: 6 }, (_, index) => testRunId(`chaos-root-${index}`));
		const barrier = { directory: join(directory, "barrier"), peers: onShard.length + acrossShards.length };
		mkdirSync(barrier.directory);
		const writers = [
			...onShard.map((runId) => startWriter("shard", shared, runId, barrier)),
			...acrossShards.map((runId) => startWriter("router", store, runId, barrier)),
		];
		const summaries = await Promise.all(writers.map(finished));
		for (const summary of summaries) assert.deepEqual([summary.appended, summary.existed], [CHECKPOINTS, 0]);
		for (const runId of onShard) assertRunIntact(shared, runId);
		const catalog = await JournalCatalog.open(store);
		try {
			const shards = new Set<string>();
			for (const runId of acrossShards) {
				const located = await catalog.locate(runId);
				assert.ok(located);
				shards.add(located.shard.path);
				assertRunIntact(located.shard.path, runId);
			}
			assert.equal(shards.size, acrossShards.length, "concurrent roots each got a shard of their own");
			assert.ok(!shards.has(shared));
		} finally {
			await catalog.close();
		}
		assertIntact(join(store, "catalog.sqlite"));
	},
	CHAOS_SCENARIO_TIMEOUT_MS,
);

test(
	"SIGKILL of a process holding a shard's write lock rolls it back, stalls no other shard, and killed writers resume exactly once (#4325)",
	async () => {
		const anchor = testRunId("chaos-kill-anchor");
		const shared = await shardFor(anchor);
		const seed = await openSqlRunJournal(shared);
		await seed.createRun({ runId: anchor, name: "anchor", cwd: directory, createdAt: 1, status: "running" });
		await seed.close();
		const holder = await holdLock("shard", shared, anchor);
		const blocked = [0, 1, 2].map((index) => startWriter("shard", shared, testRunId(`chaos-blocked-${index}`)));
		const elsewhere = [0, 1].map((index) => startWriter("router", store, testRunId(`chaos-free-${index}`)));
		const free = await Promise.all(elsewhere.map(finished));
		assert.deepEqual(
			free.map((summary) => summary.appended),
			[CHECKPOINTS, CHECKPOINTS],
			"writers on other shards finish while this shard's lock is held",
		);
		holder.kill("SIGKILL");
		await holder.exited;
		const victim = startWriter("shard", shared, testRunId("chaos-victim"));
		await victim.reached(CHECKPOINTS / 2);
		victim.child.kill("SIGKILL");
		await victim.child.exited;
		const restarted = await finished(startWriter("shard", shared, testRunId("chaos-victim")));
		assert.equal(restarted.appended + restarted.existed, CHECKPOINTS);
		assert.ok(restarted.existed >= CHECKPOINTS / 2, "checkpoints written before the kill are found, not rewritten");
		for (const summary of await Promise.all(blocked.map(finished))) assert.equal(summary.appended, CHECKPOINTS);
		for (const index of [0, 1, 2]) assertRunIntact(shared, testRunId(`chaos-blocked-${index}`));
		assertRunIntact(shared, testRunId("chaos-victim"));
		const database = new DatabaseSync(shared, { readOnly: true });
		assert.equal(
			database.prepare("SELECT count(*) AS n FROM wf_events WHERE key = 'uncommitted'").get()?.n,
			0,
			"the killed holder's transaction rolled back",
		);
		database.close();
	},
	CHAOS_SCENARIO_TIMEOUT_MS,
);

test(
	"a catalog writer killed mid-transaction leaves no half-placed run or shard, and placement continues (#4325)",
	async () => {
		await shardFor(testRunId("chaos-catalog-first"));
		const catalogPath = join(store, "catalog.sqlite");
		const holder = await holdLock("catalog", catalogPath);
		const waiting = startWriter("router", store, testRunId("chaos-catalog-waiter"));
		holder.kill("SIGKILL");
		await holder.exited;
		const summary = await finished(waiting);
		assert.equal(summary.appended, CHECKPOINTS);
		assertIntact(catalogPath);
		const catalog = await JournalCatalog.open(store);
		try {
			assert.equal(await catalog.locate("killed-placement"), undefined);
			const shards = await catalog.shards();
			assert.deepEqual(
				shards.map((shard) => shard.id),
				shards.map((_, index) => index + 1),
				"shard ids stay dense: the killed placement's shard never existed",
			);
			const located = await catalog.locate(testRunId("chaos-catalog-waiter"));
			assert.ok(located);
			assertRunIntact(located.shard.path, testRunId("chaos-catalog-waiter"));
		} finally {
			await catalog.close();
		}
	},
	CHAOS_SCENARIO_TIMEOUT_MS,
);

test(
	"a catalog placement waits out a catalog writer stalled past a connection's lock wait, and completes once it is killed (#4325)",
	async () => {
		const catalog = await JournalCatalog.open(store);
		try {
			const holder = await holdLock("catalog", join(store, "catalog.sqlite"));
			const started = Date.now();
			const placing = catalog.place({ runId: testRunId("chaos-catalog-patient"), status: "running" }).then(
				(placed) => ({ placed, at: Date.now() }),
				(error: Error) => error,
			);
			await sleep(STALLED_CATALOG_HOLDER_MS);
			holder.kill("SIGKILL");
			await holder.exited;
			const outcome = await placing;
			assert.ok(!(outcome instanceof Error), String(outcome));
			assert.equal(outcome.placed.placed, true);
			assert.ok(outcome.at - started >= STALLED_CATALOG_HOLDER_MS, "the placement waited for the stalled writer");
			assert.equal(
				await catalog.locate("killed-placement"),
				undefined,
				"the stalled writer's placement rolled back",
			);
		} finally {
			await catalog.close();
		}
		assertIntact(join(store, "catalog.sqlite"));
	},
	STALLED_CATALOG_TIMEOUT_MS,
);

test(
	"a shard file deleted before concurrent roots are created takes none of them, loses nothing else and fails its own run typed (#4325)",
	async () => {
		const seeded = testRunId("chaos-lost-seed");
		await finished(startWriter("router", store, seeded));
		const catalog = await JournalCatalog.open(store);
		const lost = (await catalog.locate(seeded))!.shard;
		await catalog.close();
		rmSync(lost.path);
		const roots = Array.from({ length: 4 }, (_, index) => testRunId(`chaos-lost-new-${index}`));
		const barrier = { directory: join(directory, "barrier"), peers: roots.length };
		mkdirSync(barrier.directory);
		const summaries = await Promise.all(
			roots.map((runId) => startWriter("router", store, runId, barrier)).map(finished),
		);
		for (const summary of summaries) assert.deepEqual([summary.appended, summary.existed], [CHECKPOINTS, 0]);
		const reopened = await JournalCatalog.open(store);
		try {
			for (const runId of roots) {
				const located = await reopened.locate(runId);
				assert.ok(located);
				assert.notEqual(located.shard.id, lost.id, `${runId} was not placed on the lost shard`);
				assertRunIntact(located.shard.path, runId);
			}
			assert.equal((await reopened.locate(seeded))?.shard.id, lost.id, "the lost shard's run stays registered");
			assert.equal((await reopened.shards()).find((shard) => shard.id === lost.id)?.acceptsNewRoots, false);
		} finally {
			await reopened.close();
		}
		assertIntact(join(store, "catalog.sqlite"));
		assert.equal(existsSync(lost.path), false, "no empty file was created in its place");
	},
	CHAOS_SCENARIO_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a lock holder stopped with SIGSTOP delays only its shard's writers, which finish once it continues (#4325)",
	async () => {
		const anchor = testRunId("chaos-stop-anchor");
		const shared = await shardFor(anchor);
		const seed = await openSqlRunJournal(shared);
		await seed.createRun({ runId: anchor, name: "anchor", cwd: directory, createdAt: 1, status: "running" });
		await seed.close();
		const holder = await holdLock("shard", shared, anchor);
		holder.kill("SIGSTOP");
		const blocked = startWriter("shard", shared, testRunId("chaos-stopped-0"));
		const free = await finished(startWriter("router", store, testRunId("chaos-unstopped")));
		assert.equal(free.appended, CHECKPOINTS);
		holder.kill("SIGCONT");
		holder.stdin?.end();
		assert.equal(await holder.exited, 0);
		assert.equal((await finished(blocked)).appended, CHECKPOINTS);
		assertRunIntact(shared, testRunId("chaos-stopped-0"));
	},
	CHAOS_SCENARIO_TIMEOUT_MS,
);

test("a full disk fails shard appends and catalog placements with typed errors, writes nothing partial, and completes exactly once after space returns (#4325)", async () => {
	const shardDatabases = new Map<string, SqliteDatabase>();
	const journal = await ShardedRunJournal.open({
		directory: store,
		openShard: async (path) => {
			const database = await openNodeSqliteDatabase(path);
			shardDatabases.set(path, database);
			return closingWith(await SqlRunJournal.open(database), database);
		},
	});
	try {
		const runId = testRunId("chaos-full");
		await journal.createRun({ runId, name: "full", cwd: directory, createdAt: 1, status: "running" });
		const outcome = await journal.acquire(runId, "writer");
		assert.equal(outcome.status, "acquired");
		if (outcome.status !== "acquired") return;
		const shard = shardDatabases.get(journal.shardOf(runId)!.path)!;
		const pages = Number((await shard.get("PRAGMA page_count"))?.page_count);
		await shard.exec(`PRAGMA max_page_count = ${pages}`);
		const payload = "x".repeat(2_000);
		let written = 0;
		let full: unknown;
		for (let index = 0; index < 200 && full === undefined; index++) {
			try {
				await journal.append(
					outcome.lease,
					{ type: "CheckpointRecorded", payload: { kind: "tool", payload } },
					{ key: `checkpoint-${index}` },
				);
				written++;
			} catch (error) {
				full = error;
			}
		}
		assert.ok(full instanceof StorageError, String(full));
		assert.ok(sqliteCodes(full).includes(SQLITE_FULL), `a full database, not ${String(full)}`);
		const readBack = async () => {
			const keys: string[] = [];
			for await (const entry of journal.read(runId)) if (entry.key !== undefined) keys.push(entry.key);
			return keys;
		};
		assert.equal((await readBack()).length, written, "the failed append wrote nothing");
		await shard.exec("PRAGMA max_page_count = 1073741823");
		let existed = 0;
		for (let index = 0; index <= written; index++) {
			const result = await journal.append(
				outcome.lease,
				{ type: "CheckpointRecorded", payload: { kind: "tool", payload } },
				{ key: `checkpoint-${index}` },
			);
			if (result.status === "exists") existed++;
		}
		assert.equal(existed, written, "every checkpoint written before the disk filled is found, not rewritten");
		assert.equal(new Set(await readBack()).size, written + 1);

		const catalog = Reflect.get(Reflect.get(journal, "catalog"), "database") as SqliteDatabase;
		const catalogPages = Number((await catalog.get("PRAGMA page_count"))?.page_count);
		await catalog.exec(`PRAGMA max_page_count = ${catalogPages}`);
		let placementFailure: unknown;
		for (let index = 0; index < 500 && placementFailure === undefined; index++) {
			try {
				await journal.journalFor(testRunId(`chaos-full-placement-${index}`));
			} catch (error) {
				placementFailure = error;
			}
		}
		assert.ok(isJournalCatalogError(placementFailure), String(placementFailure));
		assert.deepEqual([placementFailure.code, placementFailure.phase], ["write-failed", "placing-run"]);
		assert.ok(String(placementFailure.fields.detail).includes("full"));
		await catalog.exec("PRAGMA max_page_count = 1073741823");
		assert.equal((await journal.getRun(runId))?.runId, runId, "runs placed before the catalog filled still resolve");
	} finally {
		await journal.close();
	}
	for (const path of shardDatabases.keys()) assertIntact(path);
	assertIntact(join(store, "catalog.sqlite"));
});

test("lease fencing holds under clock skew: a lagging renewer is taken over and fenced, a leading one is never taken over (#4325)", async () => {
	const open = () => ShardedRunJournal.open({ directory: store, openShard: (path) => openSqlRunJournal(path) });
	const owner = await open();
	const successor = await open();
	try {
		const runId = testRunId("chaos-skew");
		await owner.createRun({ runId, name: "skew", cwd: directory, createdAt: 1, status: "running" });
		const held = await owner.acquire(runId, "owner");
		assert.equal(held.status, "acquired");
		if (held.status !== "acquired") return;
		await owner.append(held.lease, { type: "RunStarted", payload: null }, { key: "start" });
		await owner.renew(held.lease);
		const shard = new DatabaseSync(owner.shardOf(runId)!.path);
		const skew = (ms: number) =>
			shard.prepare("UPDATE wf_leases SET renewed_at = renewed_at + ? WHERE run_id = ?").run(ms, runId);
		skew(10 * 60_000);
		assert.equal(
			(await successor.takeoverExpired(runId, "successor", 30_000)).status,
			"held",
			"a clock ahead never looks stale",
		);
		skew(-20 * 60_000);
		const taken = await successor.takeoverExpired(runId, "successor", 30_000);
		assert.equal(taken.status, "acquired", "a renewal stamped by a clock that lags looks stale");
		if (taken.status !== "acquired") return;
		assert.equal(taken.lease.epoch, held.lease.epoch + 1);
		await assert.rejects(
			owner.append(held.lease, { type: "SummaryRecorded", payload: "late" }, { key: "late" }),
			StaleLeaseError,
		);
		await assert.rejects(owner.renew(held.lease), StaleLeaseError);
		await successor.append(taken.lease, { type: "SummaryRecorded", payload: "successor" }, { key: "next" });
		const keys = (
			shard.prepare("SELECT key, epoch FROM wf_events WHERE run_id = ? ORDER BY seq").all(runId) as {
				key: string;
				epoch: number;
			}[]
		).map((row) => [row.key, row.epoch]);
		assert.deepEqual(keys, [
			["start", held.lease.epoch],
			["next", taken.lease.epoch],
		]);
		shard.close();
	} finally {
		await owner.close();
		await successor.close();
	}
});
