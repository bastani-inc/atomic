import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	adoptJournals,
	consolidateJournalStore,
	defaultJournalStoreDirectory,
	discoverLegacyJournal,
	inspectJournalFile,
	isJournalAdoptError,
	isJournalShardUnavailableError,
	JOURNAL_CONSOLIDATION_HOLDER_PREFIX,
	JOURNAL_DISCOVERY_LIMIT,
	JournalCatalog,
	legacyDefaultJournalPath,
} from "@bastani/atomic/storage";
import { afterEach, beforeEach, test } from "vitest";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

let root: string;
let store: string;
beforeEach(() => {
	root = makeTempDirectory("journal-store-adoption-");
	store = join(root, "workflows", "journal");
});
afterEach(() => removeTempDirectory(root));

/** A journal at `path` with one run per entry; `references` sets the journal file its header says it was written to. */
async function journal(
	path: string,
	runs: readonly { readonly runId: string; readonly status?: string; readonly references?: string }[],
): Promise<string> {
	mkdirSync(join(path, ".."), { recursive: true });
	const sql = await openSqlRunJournal(path);
	try {
		for (const run of runs) {
			await sql.createRun({
				runId: run.runId,
				name: "wf",
				cwd: "/p",
				createdAt: 1,
				status: run.status ?? "failed",
				...(run.references === undefined ? {} : { storage: { adapter: "node-sqlite", location: run.references } }),
			});
			const held = await sql.acquire(run.runId, "writer");
			if (held.status === "acquired") {
				await sql.append(held.lease, { type: "RunStarted", payload: { id: run.runId } }, { key: "start" });
				await sql.release(held.lease);
			}
		}
	} finally {
		await sql.close();
	}
	return path;
}

function raw(path: string, sql: string, ...params: (string | number | null)[]): void {
	const database = new DatabaseSync(path);
	try {
		database.prepare(sql).run(...params);
	} finally {
		database.close();
	}
}

async function withCatalog<T>(body: (catalog: JournalCatalog) => Promise<T>): Promise<T> {
	const catalog = await JournalCatalog.open(store);
	try {
		return await body(catalog);
	} finally {
		await catalog.close();
	}
}

test("the store's paths derive from the agent directory (#4325)", () => {
	assert.equal(defaultJournalStoreDirectory(join(root, "agent")), join(root, "workflows", "journal"));
	assert.equal(legacyDefaultJournalPath(store), join(root, "workflows", "journal.sqlite"));
});

test("inspection reads runs and follows only node-sqlite references to other files (#4325)", async () => {
	const path = join(root, "a", "journal.sqlite");
	await journal(path, [
		{ runId: "self", references: path },
		{ runId: "other", references: join(root, "b", "journal.sqlite") },
		{ runId: "relative", references: "c/journal.sqlite" },
		{ runId: "memory", references: ":memory:" },
		{ runId: "empty", references: "" },
		{ runId: "none" },
	]);
	raw(path, "INSERT INTO wf_runs VALUES ('bad-json', 'wf', '/p', 1, 'failed', 'not json')");
	raw(
		path,
		"INSERT INTO wf_runs VALUES ('libsql', 'wf', '/p', 1, 'failed', ?)",
		JSON.stringify({ runId: "libsql", storage: { adapter: "libsql", location: "/x/journal.sqlite" } }),
	);
	raw(
		path,
		"INSERT INTO wf_runs VALUES ('numeric', 'wf', '/p', 1, 'failed', ?)",
		JSON.stringify({ runId: "numeric", storage: { adapter: "node-sqlite", location: 5 } }),
	);
	const inspection = await inspectJournalFile(path);
	assert.equal(inspection.path, path);
	assert.deepEqual(
		inspection.runs.map((run) => run.runId),
		["bad-json", "empty", "libsql", "memory", "none", "numeric", "other", "relative", "self"],
	);
	assert.deepEqual(inspection.runs[0], { runId: "bad-json", name: "wf", cwd: "/p", status: "failed" });
	assert.deepEqual(
		[...inspection.references].sort(),
		[join(process.cwd(), "c/journal.sqlite"), join(root, "b", "journal.sqlite")].sort(),
	);
});

test("inspection refuses a short file, an unreadable one and a corrupt one as not SQLite (#4325)", async () => {
	writeFileSync(join(root, "short.sqlite"), "SQLite");
	const short = await inspectJournalFile(join(root, "short.sqlite")).catch((error: Error) => error);
	assert.ok(isJournalAdoptError(short));
	assert.deepEqual([short.code, short.reason], ["not-a-journal", "not-sqlite"]);
	const corrupt = join(root, "corrupt.sqlite");
	writeFileSync(corrupt, Buffer.concat([Buffer.from("SQLite format 3\u0000"), Buffer.alloc(4096, 0xff)]));
	const broken = await inspectJournalFile(corrupt).catch((error: Error) => error);
	assert.ok(isJournalAdoptError(broken));
	assert.deepEqual([broken.code, broken.reason], ["not-a-journal", "not-sqlite"]);
	assert.ok(broken.cause instanceof Error);
	if (process.getuid?.() !== 0) {
		const locked = await journal(join(root, "locked", "journal.sqlite"), []);
		chmodSync(locked, 0o000);
		const unreadable = await inspectJournalFile(locked).catch((error: Error) => error);
		chmodSync(locked, 0o644);
		assert.ok(isJournalAdoptError(unreadable));
		assert.deepEqual([unreadable.code, unreadable.reason], ["not-a-journal", "not-sqlite"]);
		assert.ok(unreadable.cause instanceof Error);
	}
});

test("inspection reads the schema version of a current or legacy journal and refuses others (#4325)", async () => {
	const legacy = join(root, "legacy.sqlite");
	raw(legacy, "CREATE TABLE meta(schema_version INTEGER NOT NULL)");
	raw(legacy, "CREATE TABLE runs(run_id TEXT)");
	raw(legacy, "CREATE TABLE events(run_id TEXT)");
	raw(legacy, "INSERT INTO meta VALUES (1)");
	assert.deepEqual(
		(await inspectJournalFile(legacy)).runs,
		[],
		"a pre-0.9.38 journal is adoptable; its runs are found later",
	);
	const empty = await journal(join(root, "empty", "journal.sqlite"), []);
	raw(empty, "DELETE FROM wf_meta");
	const none = await inspectJournalFile(empty).catch((error: Error) => error);
	assert.ok(isJournalAdoptError(none));
	assert.deepEqual([none.code, none.fields.found], ["schema-version", null]);
	raw(empty, "INSERT INTO wf_meta VALUES ('one')");
	const text = await inspectJournalFile(empty).catch((error: Error) => error);
	assert.ok(isJournalAdoptError(text));
	assert.deepEqual([text.code, text.fields.found, text.fields.supported], ["schema-version", "one", 1]);
	raw(empty, "INSERT INTO wf_meta VALUES (1)");
	const two = await inspectJournalFile(empty).catch((error: Error) => error);
	assert.ok(isJournalAdoptError(two) && two.code === "schema-version");
});

test("adoption takes each path once, recognises the store's own shards, and leaves a given catalog open (#4325)", async () => {
	const path = await journal(join(root, "a", "journal.sqlite"), [{ runId: "a1" }]);
	await withCatalog(async (catalog) => {
		const report = await adoptJournals(catalog, [path, join(root, "a")]);
		assert.deepEqual(report.adopted, [{ path, status: "adopted", shardId: 1, runs: 1 }]);
		const native = await catalog.place({ runId: "native-root", status: "running" });
		await journal(native.shard.path, []);
		const again = await adoptJournals(catalog, [native.shard.path], { discover: false });
		assert.deepEqual(again.adopted, [
			{ path: native.shard.path, status: "already-registered", shardId: native.shard.id, runs: 0 },
		]);
		assert.equal((await catalog.shards()).length, 2, "the catalog the caller passed is still open");
	});
});

test("discovery follows references transitively, once each, up to its limit, and records what it skips (#4325)", async () => {
	const files = Array.from({ length: JOURNAL_DISCOVERY_LIMIT + 3 }, (_, index) =>
		join(root, `chain-${index}`, "journal.sqlite"),
	);
	for (const [index, file] of files.entries())
		await journal(file, [{ runId: `chain-${index}`, references: files[index + 1] ?? files[0] }]);
	const loop = await journal(join(root, "loop-a", "journal.sqlite"), [
		{ runId: "loop-a", references: join(root, "loop-b", "journal.sqlite") },
	]);
	await journal(join(root, "loop-b", "journal.sqlite"), [{ runId: "loop-b", references: loop }]);
	const report = await adoptJournals(store, [files[0]!]);
	assert.equal(report.discovered.length, JOURNAL_DISCOVERY_LIMIT);
	assert.deepEqual(
		report.discovered.slice(0, 2).map((record) => [record.path, record.outcome, record.referencedBy]),
		[
			[files[1], "adopted", files[0]],
			[files[2], "adopted", files[1]],
		],
	);
	const loops = await adoptJournals(store, [loop]);
	assert.deepEqual(
		loops.discovered.map((record) => [record.path, record.outcome]),
		[[join(root, "loop-b", "journal.sqlite"), "adopted"]],
	);
	const registered = await adoptJournals(store, [files[2]!]);
	assert.deepEqual(
		registered.adopted.map((outcome) => outcome.status),
		["already-registered"],
	);
	assert.deepEqual(registered.discovered, [], "references already registered are not considered again");
	const notJournal = join(root, "notes.sqlite");
	writeFileSync(notJournal, "plain");
	const pointing = await journal(join(root, "pointing", "journal.sqlite"), [{ runId: "p", references: notJournal }]);
	const skipped = await adoptJournals(store, [pointing]);
	assert.deepEqual(
		skipped.discovered.map((record) => [record.path, record.outcome, record.reason]),
		[[notJournal, "skipped", "not-a-journal"]],
	);
});

test("the legacy default journal is adopted once, and a file that is not a journal is recorded once (#4325)", async () => {
	await withCatalog(async (catalog) => {
		assert.deepEqual(await discoverLegacyJournal(catalog, join(root, "absent.sqlite")), {
			adopted: [],
			discovered: [],
		});
		const sessions = join(root, "sessions.sqlite");
		raw(sessions, "CREATE TABLE session_entries(id TEXT)");
		await discoverLegacyJournal(catalog, sessions);
		const first = (await catalog.discoveries())[0]!;
		await new Promise((resolve) => setTimeout(resolve, 5));
		await discoverLegacyJournal(catalog, sessions);
		assert.deepEqual(await catalog.discoveries(), [first], "the same skip is not written again");
		const legacy = await journal(join(root, "legacy.sqlite"), [
			{ runId: "old", references: join(root, "ref", "journal.sqlite") },
		]);
		await journal(join(root, "ref", "journal.sqlite"), [{ runId: "ref" }]);
		const report = await discoverLegacyJournal(catalog, legacy);
		assert.deepEqual(
			report.adopted.map((outcome) => [outcome.path, outcome.status]),
			[[legacy, "adopted"]],
		);
		assert.deepEqual(
			report.discovered.map((record) => record.path),
			[join(root, "ref", "journal.sqlite")],
		);
		assert.deepEqual(await discoverLegacyJournal(catalog, legacy), { adopted: [], discovered: [] });
	});
});

test("consolidation leaves runs it must not move, each with its reason, and nothing about them changes (#4325)", async () => {
	const path = await journal(join(root, "old", "journal.sqlite"), [
		{ runId: "running", status: "running" },
		{ runId: "leased" },
		{ runId: "pooled" },
		{ runId: "converted" },
		{ runId: "done" },
	]);
	raw(path, "UPDATE wf_leases SET holder_id = 'live-process' WHERE run_id = 'leased'");
	raw(path, "CREATE TABLE wf_runs_pool_roots(root TEXT PRIMARY KEY)");
	raw(path, "INSERT INTO wf_runs_pool_roots VALUES ('pooled')");
	raw(path, "CREATE TABLE runs(run_id TEXT PRIMARY KEY)");
	raw(path, "INSERT INTO runs VALUES ('converted')");
	await adoptJournals(store, [path]);
	await withCatalog((catalog) => catalog.index(1, { runId: "vanished" }));
	const report = await consolidateJournalStore(store);
	assert.deepEqual(
		report.runs.map((run) => [run.runId, run.outcome, run.reason ?? null]),
		[
			["converted", "skipped", "legacy-format"],
			["done", "moved", null],
			["leased", "skipped", "leased"],
			["pooled", "skipped", "pooled"],
			["running", "skipped", "unfinished"],
			["vanished", "skipped", "legacy-format"],
		],
	);
	assert.deepEqual([report.moved, report.skipped], [1, 5]);
	const source = new DatabaseSync(path, { readOnly: true });
	assert.deepEqual(
		source
			.prepare("SELECT run_id, holder_id FROM wf_leases ORDER BY run_id")
			.all()
			.map((row) => [row.run_id, row.holder_id]),
		[
			["converted", null],
			["leased", "live-process"],
			["pooled", null],
			["running", null],
		],
	);
	source.close();
});

test("consolidation finishes a move it was interrupted in, before or after the catalog moved the run (#4325)", async () => {
	const path = await journal(join(root, "old", "journal.sqlite"), [{ runId: "copied" }, { runId: "repointed" }]);
	await adoptJournals(store, [path]);
	const target = await withCatalog((catalog) => catalog.homeShard("copied"));
	const holder = `${JOURNAL_CONSOLIDATION_HOLDER_PREFIX}crashed`;
	raw(path, "UPDATE wf_leases SET holder_id = ?, epoch = epoch + 1", holder);
	await journal(target.path, []);
	const copy = new DatabaseSync(target.path);
	copy.exec(`ATTACH DATABASE '${path}' AS source`);
	for (const table of ["wf_runs", "wf_events", "wf_leases"])
		copy.exec(`INSERT INTO main.${table} SELECT * FROM source.${table}`);
	copy.close();
	await withCatalog((catalog) => catalog.moveRun("repointed", 1, target.id));
	const report = await consolidateJournalStore(store);
	assert.deepEqual(
		report.runs.map((run) => [run.runId, run.outcome, run.to]),
		[["copied", "moved", target.id]],
	);
	const source = new DatabaseSync(path, { readOnly: true });
	assert.deepEqual(source.prepare("SELECT run_id FROM wf_runs").all(), [], "both source copies are gone");
	source.close();
	const moved = new DatabaseSync(target.path, { readOnly: true });
	assert.deepEqual(
		moved
			.prepare("SELECT run_id, holder_id FROM wf_leases ORDER BY run_id")
			.all()
			.map((row) => [row.run_id, row.holder_id]),
		[
			["copied", null],
			["repointed", null],
		],
	);
	assert.equal(moved.prepare("SELECT count(*) AS n FROM wf_events").get()?.n, 2);
	moved.close();
});

test("consolidation leaves a run in place when the catalog moved it meanwhile or its destination cannot open (#4325)", async () => {
	const path = await journal(join(root, "old", "journal.sqlite"), [{ runId: "raced" }]);
	await adoptJournals(store, [path]);
	await withCatalog(async (catalog) => {
		Reflect.set(catalog, "moveRun", async () => false);
		const report = await consolidateJournalStore(catalog);
		assert.deepEqual(
			report.runs.map((run) => [run.runId, run.reason]),
			[["raced", "changed"]],
		);
		const target = await catalog.homeShard("raced");
		const copy = new DatabaseSync(target.path, { readOnly: true });
		assert.equal(copy.prepare("SELECT count(*) AS n FROM wf_runs").get()?.n, 0, "the destination copy was removed");
		copy.close();
	});
	const source = new DatabaseSync(path, { readOnly: true });
	assert.equal(source.prepare("SELECT holder_id FROM wf_leases").get()?.holder_id, null, "the fence was lifted");
	source.close();

	const blocked = await journal(join(root, "blocked", "journal.sqlite"), [{ runId: "stuck" }]);
	const fresh = join(root, "fresh-store");
	await adoptJournals(fresh, [blocked]);
	const catalog = await JournalCatalog.open(fresh);
	const destination = await catalog.homeShard("stuck");
	await catalog.close();
	mkdirSync(destination.path, { recursive: true });
	const report = await consolidateJournalStore(fresh);
	assert.equal(report.runs[0]?.reason, "shard-unavailable");
	assert.ok(isJournalShardUnavailableError(report.runs[0]?.error));
	assert.equal(report.runs[0].error.code, "shard-open-failed");
	const stuck = new DatabaseSync(blocked, { readOnly: true });
	assert.equal(stuck.prepare("SELECT holder_id FROM wf_leases").get()?.holder_id, null);
	stuck.close();
});
