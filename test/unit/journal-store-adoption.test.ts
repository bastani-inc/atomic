import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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
	JOURNAL_COPIED_ALL_MARKER,
	JOURNAL_DISCOVERY_LIMIT,
	JournalCatalog,
	JournalCatalogError,
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
	const modeBlocksReads = process.platform !== "win32" && process.getuid?.() !== 0;
	if (modeBlocksReads) {
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
	raw(
		legacy,
		"CREATE TABLE runs(run_id TEXT PRIMARY KEY, name TEXT, cwd TEXT, created_at INTEGER, status TEXT, header_json TEXT)",
	);
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
			report.runs.map((run) => [run.runId, run.outcome, run.reason]),
			[["raced", "skipped", "changed"]],
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
	rmSync(destination.path);
	mkdirSync(destination.path);
	const report = await consolidateJournalStore(fresh);
	assert.deepEqual([report.runs[0]?.outcome, report.runs[0]?.reason], ["skipped", "shard-unavailable"]);
	assert.ok(isJournalShardUnavailableError(report.runs[0]?.error));
	assert.equal(report.runs[0].error.code, "shard-open-failed");
	const stuck = new DatabaseSync(blocked, { readOnly: true });
	assert.equal(stuck.prepare("SELECT holder_id FROM wf_leases").get()?.holder_id, null);
	stuck.close();
});

test("inspection tells a plain file from a broken database, and leaves a rollback-journal file as it is (#4325)", async () => {
	writeFileSync(join(root, "plain.sqlite"), "this is not a database, only text that is long enough");
	const plain = await inspectJournalFile(join(root, "plain.sqlite")).catch((error: Error) => error);
	assert.ok(isJournalAdoptError(plain));
	assert.deepEqual([plain.code, plain.reason, plain.cause], ["not-a-journal", "not-sqlite", undefined]);
	const rollback = join(root, "rollback.sqlite");
	raw(rollback, "PRAGMA journal_mode = DELETE");
	raw(rollback, "CREATE TABLE wf_meta(schema_version INTEGER NOT NULL)");
	raw(
		rollback,
		"CREATE TABLE wf_runs(run_id TEXT PRIMARY KEY, name TEXT, cwd TEXT, created_at INTEGER, status TEXT, header_json TEXT)",
	);
	raw(rollback, "INSERT INTO wf_meta VALUES (1)");
	await inspectJournalFile(rollback);
	const after = new DatabaseSync(rollback, { readOnly: true });
	assert.equal(
		after.prepare("PRAGMA journal_mode").get()?.journal_mode,
		"delete",
		"inspection never switches the journal mode",
	);
	after.close();
});

test("inspection needs a journal's meta and runs tables, or all three legacy tables (#4325)", async () => {
	const half = join(root, "half.sqlite");
	raw(half, "CREATE TABLE wf_meta(schema_version INTEGER NOT NULL)");
	raw(half, "INSERT INTO wf_meta VALUES (1)");
	const noRuns = await inspectJournalFile(half).catch((error: Error) => error);
	assert.ok(isJournalAdoptError(noRuns));
	assert.deepEqual([noRuns.code, noRuns.reason], ["not-a-journal", "no-journal-tables"]);
	const legacyHalf = join(root, "legacy-half.sqlite");
	raw(legacyHalf, "CREATE TABLE meta(schema_version INTEGER NOT NULL)");
	raw(
		legacyHalf,
		"CREATE TABLE runs(run_id TEXT PRIMARY KEY, name TEXT, cwd TEXT, created_at INTEGER, status TEXT, header_json TEXT)",
	);
	raw(legacyHalf, "INSERT INTO meta VALUES (1)");
	const noEvents = await inspectJournalFile(legacyHalf).catch((error: Error) => error);
	assert.ok(isJournalAdoptError(noEvents));
	assert.deepEqual([noEvents.code, noEvents.reason], ["not-a-journal", "no-journal-tables"]);
	const twice = await journal(join(root, "twice", "journal.sqlite"), []);
	raw(twice, "INSERT INTO wf_meta VALUES (1)");
	const duplicate = await inspectJournalFile(twice).catch((error: Error) => error);
	assert.ok(
		isJournalAdoptError(duplicate) && duplicate.code === "schema-version",
		"two valid version rows are not one",
	);
	const blob = await journal(join(root, "blob", "journal.sqlite"), []);
	raw(blob, "UPDATE wf_meta SET schema_version = X'01'");
	const binary = await inspectJournalFile(blob).catch((error: Error) => error);
	assert.ok(isJournalAdoptError(binary));
	assert.deepEqual([binary.code, binary.fields.found], ["schema-version", "1"]);
});

test("discovery considers a journal referenced twice once, and legacy discovery records each file it skips (#4325)", async () => {
	const missing = join(root, "missing", "journal.sqlite");
	const one = await journal(join(root, "one", "journal.sqlite"), [{ runId: "one", references: missing }]);
	const two = await journal(join(root, "two", "journal.sqlite"), [{ runId: "two", references: missing }]);
	const report = await adoptJournals(store, [one, two]);
	assert.deepEqual(
		report.discovered.map((record) => [record.path, record.reason]),
		[[missing, "path-not-found"]],
	);
	await withCatalog(async (catalog) => {
		const first = join(root, "first.sqlite");
		const second = join(root, "second.sqlite");
		raw(first, "CREATE TABLE notes(id TEXT)");
		raw(second, "CREATE TABLE notes(id TEXT)");
		assert.deepEqual(await discoverLegacyJournal(catalog, first), { adopted: [], discovered: [] });
		await discoverLegacyJournal(catalog, second);
		const skipped = (await catalog.discoveries())
			.filter((record) => record.outcome === "skipped")
			.map((record) => record.path);
		assert.deepEqual(skipped.sort(), [first, missing, second].sort());
		const legacy = await journal(join(root, "legacy.sqlite"), [{ runId: "legacy" }]);
		const adopted = await discoverLegacyJournal(catalog, legacy);
		assert.deepEqual(
			adopted.adopted.map((outcome) => outcome.status),
			["adopted"],
			"other registered shards do not hide it",
		);
	});
});

test("consolidation fences with an epoch above the run's, moves runs without a lease, and finishes a move it crashed in (#4325)", async () => {
	const path = await journal(join(root, "old", "journal.sqlite"), [{ runId: "fenced" }]);
	const noLease = new DatabaseSync(path);
	noLease
		.prepare("INSERT INTO wf_runs VALUES ('no-lease', 'wf', '/p', 1, 'completed', ?)")
		.run(JSON.stringify({ runId: "no-lease" }));
	noLease.prepare("UPDATE wf_leases SET epoch = 4 WHERE run_id = 'fenced'").run();
	noLease.close();
	await adoptJournals(store, [path]);
	await withCatalog(async (catalog) => {
		const moveRun = catalog.moveRun.bind(catalog);
		Reflect.set(catalog, "moveRun", async () => {
			throw new Error("crashed after the copy");
		});
		await assert.rejects(consolidateJournalStore(catalog), /crashed after the copy/);
		const source = new DatabaseSync(path, { readOnly: true });
		const lease = source.prepare("SELECT holder_id, epoch FROM wf_leases WHERE run_id = 'fenced'").get();
		source.close();
		assert.equal(lease?.epoch, 5, "the fence is one epoch above the run's lease");
		assert.ok(String(lease?.holder_id).startsWith(JOURNAL_CONSOLIDATION_HOLDER_PREFIX));
		Reflect.set(catalog, "moveRun", moveRun);
		const report = await consolidateJournalStore(catalog);
		assert.deepEqual(
			report.runs.map((run) => [run.runId, run.outcome]),
			[
				["fenced", "moved"],
				["no-lease", "moved"],
			],
		);
	});
	const { openSelectedRunJournal } = await import("../../packages/workflows/src/durable/journal/resolution.js");
	const reopened = await openSelectedRunJournal({ kind: "sharded", dir: store }, root);
	try {
		assert.deepEqual(
			(await reopened.listRuns()).map((run) => run.runId),
			["fenced", "no-lease"],
		);
		assert.equal(
			(await reopened.acquire("fenced", "resumer")).status,
			"acquired",
			"a moved run resumes on its new shard",
		);
	} finally {
		await reopened.close();
	}
});

test("consolidation never deletes a fenced run the catalog does not list (#4325)", async () => {
	const path = await journal(join(root, "old", "journal.sqlite"), [{ runId: "listed" }]);
	await adoptJournals(store, [path]);
	const seed = await openSqlRunJournal(path);
	await seed.createRun({ runId: "unlisted", name: "wf", cwd: "/p", createdAt: 1, status: "failed" });
	await seed.close();
	raw(path, "INSERT INTO wf_leases VALUES ('unlisted', ?, 2, 0)", `${JOURNAL_CONSOLIDATION_HOLDER_PREFIX}other`);
	await consolidateJournalStore(store);
	const source = new DatabaseSync(path, { readOnly: true });
	assert.deepEqual(
		source
			.prepare("SELECT run_id FROM wf_runs")
			.all()
			.map((row) => row.run_id),
		["unlisted"],
	);
	source.close();
});

for (const [label, change] of [
	["header", "UPDATE wf_runs SET header_json = '{\"other\":true}'"],
	["payload", "UPDATE wf_events SET payload = '\"other\"'"],
	["key", "UPDATE wf_events SET key = 'other'"],
	["type", "UPDATE wf_events SET type = 'SummaryRecorded'"],
	["epoch", "UPDATE wf_events SET epoch = epoch + 1"],
	["time", "UPDATE wf_events SET at = at + 1"],
	["seq", "UPDATE wf_events SET seq = seq + 10"],
] as const)
	test(`consolidation treats a destination copy with another ${label} as a conflict (#4325)`, async () => {
		const path = await journal(join(root, "old", "journal.sqlite"), [{ runId: "copy" }]);
		await adoptJournals(store, [path]);
		const target = await withCatalog((catalog) => catalog.homeShard("copy"));
		await journal(target.path, []);
		const copy = new DatabaseSync(target.path);
		copy.exec(`ATTACH DATABASE '${path}' AS source`);
		for (const table of ["wf_runs", "wf_events"])
			copy.exec(`INSERT INTO main.${table} SELECT * FROM source.${table}`);
		copy.exec(change);
		copy.close();
		const report = await consolidateJournalStore(store);
		assert.deepEqual(
			report.runs.map((run) => [run.outcome, run.reason]),
			[["skipped", "conflict"]],
		);
		const source = new DatabaseSync(path, { readOnly: true });
		const lease = source.prepare("SELECT holder_id, epoch FROM wf_leases").get();
		assert.deepEqual([lease?.holder_id, lease?.epoch], [null, 2], "the fence was lifted and its epoch kept");
		source.close();
	});

/** Appends one more event to each run of the journal at `path`. */
async function appendEvent(path: string, runIds: readonly string[]): Promise<void> {
	const sql = await openSqlRunJournal(path);
	try {
		for (const runId of runIds) {
			const held = await sql.acquire(runId, "writer");
			assert.equal(held.status, "acquired");
			if (held.status !== "acquired") continue;
			await sql.append(held.lease, { type: "SummaryRecorded", payload: { runId } }, { key: "second" });
			await sql.release(held.lease);
		}
	} finally {
		await sql.close();
	}
}

test("inspection refuses a file holding only the SQLite header text without its terminator, without opening it (#4325)", async () => {
	writeFileSync(join(root, "header.sqlite"), "SQLite format 3");
	const refused = await inspectJournalFile(join(root, "header.sqlite")).catch((error: Error) => error);
	assert.ok(isJournalAdoptError(refused));
	assert.deepEqual([refused.code, refused.reason, refused.cause], ["not-a-journal", "not-sqlite", undefined]);
});

test("inspection does not take a meta and an events table without a runs table for a legacy journal (#4325)", async () => {
	const partial = join(root, "partial.sqlite");
	raw(partial, "CREATE TABLE meta(schema_version INTEGER NOT NULL)");
	raw(partial, "CREATE TABLE events(run_id TEXT)");
	raw(partial, "INSERT INTO meta VALUES (1)");
	const refused = await inspectJournalFile(partial).catch((error: Error) => error);
	assert.ok(isJournalAdoptError(refused));
	assert.deepEqual([refused.code, refused.reason], ["not-a-journal", "no-journal-tables"]);
});

test("a discovered journal the catalog fails to register fails the adoption with the catalog's error, not a skip (#4325)", async () => {
	const referenced = await journal(join(root, "referenced", "journal.sqlite"), [{ runId: "referenced" }]);
	const start = await journal(join(root, "start", "journal.sqlite"), [{ runId: "start", references: referenced }]);
	await withCatalog(async (catalog) => {
		const registerAdopted = catalog.registerAdopted.bind(catalog);
		const failure = new JournalCatalogError({
			code: "write-failed",
			catalogPath: catalog.path,
			phase: "registering-shard",
		});
		Reflect.set(catalog, "registerAdopted", async (path: string, runs: Parameters<typeof registerAdopted>[1]) => {
			if (path === referenced) throw failure;
			return registerAdopted(path, runs);
		});
		await assert.rejects(adoptJournals(catalog, [start]), (error: Error) => error === failure);
		assert.equal(
			(await catalog.discoveries()).some((record) => record.path === referenced),
			false,
			"the failure is not recorded as a skip",
		);
	});
});

test("legacy discovery records a new skip reason when the file changed (#4325)", async () => {
	await withCatalog(async (catalog) => {
		const legacy = join(root, "legacy.sqlite");
		writeFileSync(legacy, "plain text, not a database");
		await discoverLegacyJournal(catalog, legacy);
		assert.deepEqual(
			(await catalog.discoveries()).map((record) => [record.path, record.reason]),
			[[legacy, "not-a-journal"]],
		);
		rmSync(legacy);
		await journal(legacy, []);
		raw(legacy, "UPDATE wf_meta SET schema_version = 99");
		await discoverLegacyJournal(catalog, legacy);
		assert.deepEqual(
			(await catalog.discoveries()).map((record) => [record.path, record.reason]),
			[[legacy, "schema-version"]],
		);
	});
});

test("consolidation into a new shard records its schema version once (#4325)", async () => {
	const path = await journal(join(root, "old", "journal.sqlite"), [{ runId: "first" }, { runId: "second" }]);
	await adoptJournals(store, [path]);
	const report = await consolidateJournalStore(store);
	assert.deepEqual(
		report.runs.map((run) => run.outcome),
		["moved", "moved"],
	);
	const located = await withCatalog((catalog) => catalog.locate("first"));
	assert.equal(located?.shard.kind, "native");
	const target = new DatabaseSync(located!.shard.path, { readOnly: true });
	try {
		assert.deepEqual(
			target
				.prepare("SELECT schema_version FROM wf_meta")
				.all()
				.map((row) => row.schema_version),
			[1],
		);
	} finally {
		target.close();
	}
});

for (const [label, change] of [
	["another second event", "UPDATE wf_events SET payload = '\"other\"' WHERE key = 'second'"],
] as const)
	test(`consolidation treats a destination copy with ${label} after a matching first one as a conflict (#4325)`, async () => {
		const path = await journal(join(root, "old", "journal.sqlite"), [{ runId: "copy" }]);
		await appendEvent(path, ["copy"]);
		await adoptJournals(store, [path]);
		const target = await withCatalog((catalog) => catalog.homeShard("copy"));
		await journal(target.path, []);
		const copy = new DatabaseSync(target.path);
		copy.exec(`ATTACH DATABASE '${path}' AS source`);
		for (const table of ["wf_runs", "wf_events"])
			copy.exec(`INSERT INTO main.${table} SELECT * FROM source.${table}`);
		copy.exec(change);
		copy.close();
		const report = await consolidateJournalStore(store);
		assert.deepEqual(
			report.runs.map((run) => [run.outcome, run.reason]),
			[["skipped", "conflict"]],
		);
	});

for (const [label, takeover, outcome] of [
	["took over", "UPDATE wf_leases SET holder_id = 'resumer' WHERE run_id = 'run'", ["run", "skipped"]],
	["removed", "DELETE FROM wf_leases WHERE run_id = 'run'", ["run", "moved"]],
] as const)
	test(`consolidation never deletes a source copy whose fence another process ${label} while it moved (#4325)`, async () => {
		const path = await journal(join(root, "old", "journal.sqlite"), [{ runId: "run" }]);
		await adoptJournals(store, [path]);
		await withCatalog(async (catalog) => {
			const moveRun = catalog.moveRun.bind(catalog);
			Reflect.set(catalog, "moveRun", async (runId: string, from: number, to: number) => {
				raw(path, takeover);
				return moveRun(runId, from, to);
			});
			const report = await consolidateJournalStore(catalog);
			assert.deepEqual(
				report.runs.map((run) => [run.runId, run.outcome]),
				[outcome],
			);
			assert.equal(
				(await catalog.locate("run"))?.shard.path === path,
				label === "took over",
				"a live resume keeps the run on the file it holds the lease in",
			);
		});
		const source = new DatabaseSync(path, { readOnly: true });
		try {
			assert.deepEqual(
				source
					.prepare("SELECT run_id FROM wf_runs")
					.all()
					.map((row) => row.run_id),
				["run"],
			);
		} finally {
			source.close();
		}
	});

test.skipIf(process.platform === "win32")(
	"inspection, adoption and consolidation close every file and database they open (#4325)",
	async () => {
		const descriptors = () => readdirSync(existsSync("/proc/self/fd") ? "/proc/self/fd" : "/dev/fd").length;
		const cycle = async (label: string) => {
			const files: string[] = [];
			for (const index of [0, 1])
				files.push(
					await journal(join(root, label, `journal-${index}`, "journal.sqlite"), [
						{ runId: `${label}-${index}-a` },
						{ runId: `${label}-${index}-b` },
					]),
				);
			await inspectJournalFile(files[0]!);
			await adoptJournals(store, files);
			const report = await consolidateJournalStore(store);
			assert.equal(report.moved, 4);
		};
		await cycle("warm");
		const before = descriptors();
		await cycle("measured");
		assert.equal(descriptors(), before);
	},
);

test("a run another consolidation moved to the same shard first keeps that copy, and loses its old one (#4325)", async () => {
	const path = await journal(join(root, "old", "journal.sqlite"), [{ runId: "raced" }]);
	await adoptJournals(store, [path]);
	await withCatalog(async (catalog) => {
		const moveRun = catalog.moveRun.bind(catalog);
		Reflect.set(catalog, "moveRun", async (runId: string, from: number, to: number) => {
			await moveRun(runId, from, to);
			return false;
		});
		const report = await consolidateJournalStore(catalog);
		assert.deepEqual(
			report.runs.map((run) => [run.runId, run.outcome, run.reason]),
			[["raced", "skipped", "changed"]],
		);
		const located = await catalog.locate("raced");
		assert.equal(located?.shard.kind, "native");
		const destination = new DatabaseSync(located!.shard.path, { readOnly: true });
		try {
			assert.equal(destination.prepare("SELECT count(*) AS n FROM wf_events WHERE run_id = 'raced'").get()?.n, 1);
			assert.equal(
				destination.prepare("SELECT holder_id FROM wf_leases WHERE run_id = 'raced'").get()?.holder_id,
				null,
			);
		} finally {
			destination.close();
		}
	});
	const source = new DatabaseSync(path, { readOnly: true });
	try {
		assert.equal(source.prepare("SELECT count(*) AS n FROM wf_runs").get()?.n, 0, "the old copy is gone");
	} finally {
		source.close();
	}
});

test("consolidation leaves the runs of a journal with only the pre-0.9.38 tables where they are, and moves the rest (#4325)", async () => {
	const legacy = join(root, "legacy.sqlite");
	raw(legacy, "CREATE TABLE meta(schema_version INTEGER NOT NULL)");
	raw(
		legacy,
		"CREATE TABLE runs(run_id TEXT PRIMARY KEY, name TEXT, cwd TEXT, created_at INTEGER, status TEXT, header_json TEXT)",
	);
	raw(legacy, "CREATE TABLE events(run_id TEXT)");
	raw(legacy, "INSERT INTO meta VALUES (1)");
	const current = await journal(join(root, "current", "journal.sqlite"), [{ runId: "current" }]);
	await adoptJournals(store, [legacy, current]);
	await withCatalog(async (catalog) => {
		const shard = (await catalog.shards()).find((record) => record.path === legacy)!;
		await catalog.index(shard.id, { runId: "old" });
	});
	const report = await consolidateJournalStore(store);
	assert.deepEqual(
		report.runs.map((run) => [run.runId, run.outcome, run.reason ?? null]),
		[
			["old", "skipped", "legacy-format"],
			["current", "moved", null],
		],
	);
	const untouched = new DatabaseSync(legacy, { readOnly: true });
	try {
		assert.deepEqual(
			untouched
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all()
				.map((row) => row.name),
			["events", "meta", "runs"],
		);
	} finally {
		untouched.close();
	}
});

test("adopting several files registers none of them when one has a run the store already holds (#4325)", async () => {
	const first = await journal(join(root, "first", "journal.sqlite"), [{ runId: "shared" }]);
	await adoptJournals(store, [first]);
	const fresh = await journal(join(root, "fresh", "journal.sqlite"), [{ runId: "fresh" }]);
	const copy = await journal(join(root, "copy", "journal.sqlite"), [{ runId: "shared" }]);
	const refused = await adoptJournals(store, [fresh, copy]).catch((error: Error) => error);
	assert.ok(isJournalAdoptError(refused));
	assert.deepEqual(
		[refused.code, refused.fields.runId, refused.fields.existingPath],
		["run-conflict", "shared", first],
	);
	await withCatalog(async (catalog) => {
		assert.deepEqual(
			(await catalog.shards()).map((shard) => shard.path),
			[first],
		);
		assert.equal(await catalog.locate("fresh"), undefined);
	});
});

test("consolidation leaves the runs of a journal missing its lease or event tables where they are (#4325)", async () => {
	const partial = join(root, "partial.sqlite");
	raw(partial, "CREATE TABLE wf_meta(schema_version INTEGER NOT NULL)");
	raw(
		partial,
		"CREATE TABLE wf_runs(run_id TEXT PRIMARY KEY, name TEXT, cwd TEXT, created_at INTEGER, status TEXT, header_json TEXT)",
	);
	raw(partial, "INSERT INTO wf_meta VALUES (1)");
	raw(partial, "INSERT INTO wf_runs VALUES ('partial', 'wf', '/p', 1, 'completed', '{}')");
	await adoptJournals(store, [partial]);
	const report = await consolidateJournalStore(store);
	assert.deepEqual(
		report.runs.map((run) => [run.runId, run.outcome, run.reason]),
		[["partial", "skipped", "legacy-format"]],
	);
});

test("a run the catalog dropped while it moved loses its destination copy and keeps its source (#4325)", async () => {
	const path = await journal(join(root, "old", "journal.sqlite"), [{ runId: "dropped" }]);
	await adoptJournals(store, [path]);
	await withCatalog(async (catalog) => {
		Reflect.set(catalog, "moveRun", async (runId: string) => {
			await catalog.remove(runId);
			return false;
		});
		const report = await consolidateJournalStore(catalog);
		assert.deepEqual(
			report.runs.map((run) => [run.runId, run.outcome, run.reason]),
			[["dropped", "skipped", "changed"]],
		);
		const destination = new DatabaseSync((await catalog.homeShard("dropped")).path, { readOnly: true });
		try {
			assert.equal(destination.prepare("SELECT count(*) AS n FROM wf_runs").get()?.n, 0);
		} finally {
			destination.close();
		}
	});
	const source = new DatabaseSync(path, { readOnly: true });
	try {
		assert.deepEqual(
			[
				source.prepare("SELECT count(*) AS n FROM wf_runs").get()?.n,
				source.prepare("SELECT holder_id FROM wf_leases").get()?.holder_id,
			],
			[1, null],
		);
	} finally {
		source.close();
	}
});

test("a batch with a registered journal and a copy of a run written to it since adoption is refused, not split (#4325)", async () => {
	const original = await journal(join(root, "original", "journal.sqlite"), [{ runId: "early" }]);
	await adoptJournals(store, [original]);
	await journal(original, [{ runId: "late" }]);
	const copy = await journal(join(root, "copy", "journal.sqlite"), [{ runId: "late" }]);
	const refused = await adoptJournals(store, [original, copy]).catch((error: Error) => error);
	assert.ok(isJournalAdoptError(refused));
	assert.deepEqual(
		[refused.code, refused.fields.runId, refused.fields.path, refused.fields.existingPath],
		["run-conflict", "late", copy, original],
	);
	await withCatalog(async (catalog) => {
		assert.deepEqual(
			(await catalog.shards()).map((shard) => shard.path),
			[original],
		);
		assert.equal(await catalog.locate("late"), undefined, "the copy did not claim the run");
	});
});

/** Runs a consolidation whose process "crashes" right after the copy, or after it repointed the catalog. */
async function crashDuring(moment: "copy" | "repoint"): Promise<void> {
	await withCatalog(async (catalog) => {
		const moveRun = catalog.moveRun.bind(catalog);
		Reflect.set(catalog, "moveRun", async (runId: string, from: number, to: number) => {
			if (moment === "repoint") await moveRun(runId, from, to);
			throw new Error("crashed");
		});
		await assert.rejects(consolidateJournalStore(catalog), /crashed/);
	});
}

function removeDatabaseFiles(path: string): void {
	for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

function scalar(path: string, sql: string): unknown {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		return Object.values(database.prepare(sql).get() ?? {})[0];
	} finally {
		database.close();
	}
}

const EVENTS = "SELECT count(*) FROM wf_events WHERE run_id = 'r'";
const HOLDER = "SELECT holder_id FROM wf_leases WHERE run_id = 'r'";

async function interrupted(moment: "copy" | "repoint") {
	const path = await journal(join(root, "old", "journal.sqlite"), [{ runId: "r" }]);
	await adoptJournals(store, [path]);
	await crashDuring(moment);
	const destination = (await withCatalog((catalog) => catalog.homeShard("r"))).path;
	return { path, destination, events: Number(scalar(path, EVENTS)) };
}

test("recovery keeps the source copy while the destination file is missing, reports it, and finishes once it is back (#4325)", async () => {
	const { path, destination, events } = await interrupted("repoint");
	const backup = join(root, "destination.backup");
	copyFileSync(destination, backup);
	removeDatabaseFiles(destination);
	const report = await consolidateJournalStore(store);
	assert.deepEqual(
		report.runs.map((run) => [run.runId, run.outcome, run.reason]),
		[["r", "skipped", "shard-unavailable"]],
	);
	assert.ok(isJournalShardUnavailableError(report.runs[0]?.error));
	assert.equal(report.runs[0].error.code, "shard-missing");
	assert.equal(scalar(path, EVENTS), events, "the only copy is still in the source");
	copyFileSync(backup, destination);
	assert.deepEqual((await consolidateJournalStore(store)).runs, []);
	assert.equal(
		scalar(path, "SELECT count(*) FROM wf_runs"),
		0,
		"the source copy is gone once the destination is checked",
	);
	assert.deepEqual([scalar(destination, EVENTS), scalar(destination, HOLDER)], [events, null]);
});

test("recovery copies the run again when its destination lost it, and keeps what a resume added there (#4325)", async () => {
	const lost = await interrupted("repoint");
	removeDatabaseFiles(lost.destination);
	await journal(lost.destination, []);
	await consolidateJournalStore(store);
	assert.equal(scalar(lost.path, "SELECT count(*) FROM wf_runs"), 0);
	assert.deepEqual([scalar(lost.destination, EVENTS), scalar(lost.destination, HOLDER)], [lost.events, null]);
});

test("recovery keeps a resume's events and lease on the destination and deletes the source (#4325)", async () => {
	const { path, destination, events } = await interrupted("repoint");
	raw(destination, "UPDATE wf_leases SET holder_id = 'resumer', epoch = 9 WHERE run_id = 'r'");
	raw(
		destination,
		"INSERT INTO wf_events(run_id, seq, epoch, key, type, payload, at) VALUES ('r', ?, 9, 'resumed', 'SummaryRecorded', 'null', 0)",
		events + 1,
	);
	assert.deepEqual((await consolidateJournalStore(store)).runs, []);
	assert.equal(scalar(path, "SELECT count(*) FROM wf_runs"), 0);
	assert.deepEqual(
		[scalar(destination, EVENTS), scalar(destination, HOLDER), scalar(destination, "SELECT epoch FROM wf_leases")],
		[events + 1, "resumer", 9],
	);
});

test("recovery reports a conflict and keeps the source when the destination's copy differs (#4325)", async () => {
	const { path, destination, events } = await interrupted("repoint");
	raw(destination, "UPDATE wf_events SET payload = '\"other\"' WHERE run_id = 'r'");
	const report = await consolidateJournalStore(store);
	assert.deepEqual(
		report.runs.map((run) => [run.runId, run.outcome, run.reason]),
		[["r", "skipped", "conflict"]],
	);
	assert.equal(scalar(path, EVENTS), events, "the source copy stays");
});

test("a second consolidation of a run whose destination copy a resume already leased never overwrites that lease (#4325)", async () => {
	const { path, destination, events } = await interrupted("copy");
	raw(destination, "UPDATE wf_leases SET holder_id = 'resumer', epoch = 3 WHERE run_id = 'r'");
	const report = await consolidateJournalStore(store);
	assert.deepEqual(
		report.runs.map((run) => [run.runId, run.outcome]),
		[["r", "moved"]],
	);
	assert.equal(scalar(path, "SELECT count(*) FROM wf_runs"), 0);
	assert.deepEqual(
		[scalar(destination, EVENTS), scalar(destination, HOLDER), scalar(destination, "SELECT epoch FROM wf_leases")],
		[events, "resumer", 3],
	);
});

test("a resume that takes over the fence during a move and adds events is not lost: the move is undone (#4325)", async () => {
	const path = await journal(join(root, "old", "journal.sqlite"), [{ runId: "r" }]);
	await adoptJournals(store, [path]);
	const events = Number(scalar(path, EVENTS));
	await withCatalog(async (catalog) => {
		const moveRun = catalog.moveRun.bind(catalog);
		let tookOver = false;
		Reflect.set(catalog, "moveRun", async (runId: string, from: number, to: number) => {
			if (!tookOver) {
				tookOver = true;
				raw(path, "UPDATE wf_leases SET holder_id = 'resumer', epoch = epoch + 1 WHERE run_id = ?", runId);
				raw(
					path,
					"INSERT INTO wf_events(run_id, seq, epoch, key, type, payload, at) VALUES (?, ?, 9, 'resumed', 'SummaryRecorded', 'null', 0)",
					runId,
					events + 1,
				);
			}
			return moveRun(runId, from, to);
		});
		const report = await consolidateJournalStore(catalog);
		assert.deepEqual(
			report.runs.map((run) => [run.runId, run.outcome, run.reason]),
			[["r", "skipped", "leased"]],
		);
		assert.equal(
			(await catalog.locate("r"))?.shard.path,
			path,
			"the catalog names the file that holds the resume's events",
		);
		const destination = (await catalog.homeShard("r")).path;
		assert.equal(scalar(destination, "SELECT count(*) FROM wf_runs"), 0, "the stale destination copy is gone");
	});
	assert.deepEqual([scalar(path, EVENTS), scalar(path, HOLDER)], [events + 1, "resumer"]);
});

test("a destination copy that holds the source's events and more, as after a resume, is kept and the source deleted (#4325)", async () => {
	const path = await journal(join(root, "old", "journal.sqlite"), [{ runId: "copy" }]);
	await appendEvent(path, ["copy"]);
	await adoptJournals(store, [path]);
	const target = await withCatalog((catalog) => catalog.homeShard("copy"));
	await journal(target.path, []);
	const copy = new DatabaseSync(target.path);
	copy.exec(`ATTACH DATABASE '${path}' AS source`);
	for (const table of ["wf_runs", "wf_events"]) copy.exec(`INSERT INTO main.${table} SELECT * FROM source.${table}`);
	copy.exec(
		"INSERT INTO wf_events SELECT run_id, seq + 10, epoch, 'third', type, payload, at FROM wf_events WHERE key = 'second'",
	);
	copy.close();
	const events = Number(scalar(target.path, "SELECT count(*) FROM wf_events WHERE run_id = 'copy'"));
	const report = await consolidateJournalStore(store);
	assert.deepEqual(
		report.runs.map((run) => [run.outcome, run.to]),
		[["moved", target.id]],
	);
	assert.equal(scalar(path, "SELECT count(*) FROM wf_runs"), 0);
	assert.equal(scalar(target.path, "SELECT count(*) FROM wf_events WHERE run_id = 'copy'"), events);
});

test("recovery copies the run again into a destination file that has no journal tables at all (#4325)", async () => {
	const { path, destination, events } = await interrupted("repoint");
	const epoch = scalar(path, "SELECT epoch FROM wf_leases WHERE run_id = 'r'");
	removeDatabaseFiles(destination);
	new DatabaseSync(destination).close();
	assert.deepEqual((await consolidateJournalStore(store)).runs, []);
	assert.equal(scalar(path, "SELECT count(*) FROM wf_runs"), 0);
	assert.deepEqual(
		[scalar(destination, EVENTS), scalar(destination, HOLDER), scalar(destination, "SELECT epoch FROM wf_leases")],
		[events, null, epoch],
		"the new copy's lease keeps the epoch the source's fence had",
	);
});

test("a copy a consolidation inserts gets a lease above one the destination kept for the run (#4325)", async () => {
	const path = await journal(join(root, "old", "journal.sqlite"), [{ runId: "r" }]);
	await adoptJournals(store, [path]);
	const destination = (await withCatalog((catalog) => catalog.homeShard("r"))).path;
	await journal(destination, []);
	raw(destination, "INSERT INTO wf_leases VALUES ('r', NULL, 7, 0)");
	await consolidateJournalStore(store);
	assert.equal(scalar(destination, "SELECT epoch FROM wf_leases WHERE run_id = 'r'"), 8);
});

test("a consolidation whose run another consolidation finished meanwhile reports it changed and loses nothing (#4325)", async () => {
	const path = await journal(join(root, "old", "journal.sqlite"), [{ runId: "r" }]);
	await adoptJournals(store, [path]);
	const events = Number(scalar(path, EVENTS));
	let nested: Awaited<ReturnType<typeof consolidateJournalStore>> | undefined;
	const report = await withCatalog(async (catalog) => {
		const moveRun = catalog.moveRun.bind(catalog);
		Reflect.set(catalog, "moveRun", async (runId: string, from: number, to: number) => {
			nested = await consolidateJournalStore(store);
			return moveRun(runId, from, to);
		});
		return consolidateJournalStore(catalog);
	});
	assert.deepEqual(
		nested?.runs.map((run) => [run.runId, run.outcome]),
		[["r", "moved"]],
	);
	assert.deepEqual(
		report.runs.map((run) => [run.runId, run.outcome, run.reason]),
		[["r", "skipped", "changed"]],
	);
	const destination = (await withCatalog((catalog) => catalog.locate("r")))!.shard.path;
	assert.equal(scalar(path, "SELECT count(*) FROM wf_runs"), 0);
	assert.deepEqual([scalar(destination, EVENTS), scalar(destination, HOLDER)], [events, null]);
});

test("a move whose source fence another consolidation holds leaves that consolidation to remove the source (#4325)", async () => {
	const path = await journal(join(root, "old", "journal.sqlite"), [{ runId: "r" }]);
	await adoptJournals(store, [path]);
	const events = Number(scalar(path, EVENTS));
	const report = await withCatalog(async (catalog) => {
		const moveRun = catalog.moveRun.bind(catalog);
		Reflect.set(catalog, "moveRun", async (runId: string, from: number, to: number) => {
			raw(
				path,
				`UPDATE wf_leases SET holder_id = '${JOURNAL_CONSOLIDATION_HOLDER_PREFIX}other' WHERE run_id = ?`,
				runId,
			);
			return moveRun(runId, from, to);
		});
		return consolidateJournalStore(catalog);
	});
	assert.deepEqual(
		report.runs.map((run) => [run.runId, run.outcome]),
		[["r", "moved"]],
	);
	const destination = (await withCatalog((catalog) => catalog.locate("r")))!.shard.path;
	assert.deepEqual([scalar(destination, EVENTS), scalar(destination, HOLDER)], [events, null]);
	assert.equal(scalar(path, EVENTS), events, "the other consolidation's fenced source copy is left for it to remove");
});

const FILE_EVENTS = "SELECT count(*) FROM wf_events";

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("an adopted journal living at a shard file name is never opened as a new shard, and consolidating it loses nothing (#4325)", async () => {
	mkdirSync(store, { recursive: true });
	const lived = await journal(join(store, "shard-0002.sqlite"), [{ runId: "r" }]);
	raw(
		lived,
		"INSERT INTO wf_events(run_id, seq, epoch, key, type, payload, at) VALUES ('r', 2, 1, 'k2', 'SummaryRecorded', 'null', 0)",
	);
	const events = Number(scalar(lived, FILE_EVENTS));
	await adoptJournals(store, [lived]);
	const report = await consolidateJournalStore(store);
	const catalog = await withCatalog(async (opened) => ({
		shards: await opened.shards(),
		located: (await opened.locate("r"))!.shard,
	}));
	assert.equal(new Set(catalog.shards.map((shard) => shard.path)).size, catalog.shards.length);
	assert.notEqual(catalog.located.path, lived, "the run moved to a file of its own");
	assert.deepEqual(
		report.runs.map((run) => [run.runId, run.outcome, run.from !== run.to]),
		[["r", "moved", true]],
	);
	assert.equal(scalar(catalog.located.path, FILE_EVENTS), events, "every event is in the new shard");
	assert.equal(scalar(lived, "SELECT count(*) FROM wf_runs"), 0);
});

test("a new native shard skips a file name that exists and leaves that file untouched (#4325)", async () => {
	mkdirSync(store, { recursive: true });
	const existing = await journal(join(store, "shard-0001.sqlite"), [{ runId: "old" }]);
	const before = sha256(existing);
	const placed = await withCatalog((catalog) => catalog.place({ runId: "new", status: "running" }));
	assert.notEqual(placed.shard.path, existing);
	assert.equal(placed.shard.path, join(store, "shard-0002.sqlite"));
	assert.equal(sha256(existing), before);
});

test("a path that names a registered shard's file by another route is already registered (#4325)", async () => {
	const original = await journal(join(root, "a", "journal.sqlite"), [{ runId: "r" }]);
	await adoptJournals(store, [original]);
	const hardLink = join(root, "b", "journal.sqlite");
	mkdirSync(join(root, "b"), { recursive: true });
	linkSync(original, hardLink);
	const links = [hardLink];
	if (process.platform !== "win32") {
		const symlink = join(root, "c.sqlite");
		symlinkSync(original, symlink);
		links.push(symlink);
	}
	await adoptJournals(store, links);
	assert.deepEqual(
		(await withCatalog((catalog) => catalog.shards())).map((shard) => shard.path),
		[original],
	);
	const native = await withCatalog((catalog) => catalog.place({ runId: "n", status: "running" }));
	await (await openSqlRunJournal(native.shard.path)).close();
	const nativeLink = join(root, "native-link.sqlite");
	linkSync(native.shard.path, nativeLink);
	await adoptJournals(store, [nativeLink]);
	assert.equal((await withCatalog((catalog) => catalog.shards())).length, 2);
});

test("consolidation refuses to move a run into the file it is in, under another shard entry (#4325)", async () => {
	const adopted = await journal(join(root, "a", "journal.sqlite"), [{ runId: "r" }]);
	await adoptJournals(store, [adopted]);
	const alias = join(root, "alias.sqlite");
	linkSync(adopted, alias);
	raw(
		join(store, "catalog.sqlite"),
		"INSERT INTO catalog_shards(id, path, kind, created_at, accepts_new_roots) VALUES (2, ?, 'native', 0, 1)",
		alias,
	);
	const events = Number(scalar(adopted, FILE_EVENTS));
	const report = await consolidateJournalStore(store);
	assert.deepEqual(
		report.runs.map((run) => [run.runId, run.outcome, run.reason]),
		[["r", "skipped", "conflict"]],
	);
	const error = report.runs[0]?.error;
	assert.ok(error instanceof JournalCatalogError);
	assert.equal(error.code, "corrupt");
	assert.ok(String(error.fields.rule).includes("are the same file"));
	assert.equal(scalar(adopted, FILE_EVENTS), events, "the only copy is untouched");
	assert.equal(scalar(adopted, "SELECT count(*) FROM wf_runs"), 1);
	assert.equal(scalar(adopted, "SELECT holder_id FROM wf_leases WHERE run_id = 'r'"), null, "and not left fenced");
});

function legacyJournal(path: string, runIds: readonly string[]): string {
	mkdirSync(join(path, ".."), { recursive: true });
	raw(path, "CREATE TABLE meta(schema_version INTEGER NOT NULL)");
	raw(
		path,
		"CREATE TABLE runs(run_id TEXT PRIMARY KEY, name TEXT, cwd TEXT, created_at INTEGER, status TEXT, header_json TEXT)",
	);
	raw(
		path,
		"CREATE TABLE events(run_id TEXT, seq INTEGER, epoch INTEGER, key TEXT, type TEXT, payload TEXT, at INTEGER)",
	);
	raw(path, "INSERT INTO meta VALUES (1)");
	for (const runId of runIds) raw(path, "INSERT INTO runs VALUES (?, 'wf', '/p', 1, 'failed', '{}')", runId);
	return path;
}

test("a journal of only the pre-0.9.38 tables has its runs indexed and conflict-checked at adoption (#4325)", async () => {
	const first = legacyJournal(join(root, "a", "journal.sqlite"), ["old-1", "old-2"]);
	const copy = legacyJournal(join(root, "b", "journal.sqlite"), ["old-2"]);
	assert.deepEqual(
		(await inspectJournalFile(first)).runs.map((run) => run.runId),
		["old-1", "old-2"],
	);
	await adoptJournals(store, [first]);
	assert.equal((await withCatalog((catalog) => catalog.locate("old-2")))?.shard.path, first);
	const refused = await adoptJournals(store, [copy]).catch((error: Error) => error);
	assert.ok(isJournalAdoptError(refused));
	assert.deepEqual(
		[refused.code, refused.fields.runId, refused.fields.existingPath],
		["run-conflict", "old-2", first],
	);
});

test("a journal with current and pre-0.9.38 tables indexes only the legacy runs not converted or deleted (#4325)", async () => {
	const path = legacyJournal(join(root, "mixed", "journal.sqlite"), ["converted", "deleted", "aaa-pending"]);
	const current = await journal(join(root, "scratch", "journal.sqlite"), [
		{ runId: "converted" },
		{ runId: "zzz-current" },
	]);
	const database = new DatabaseSync(path);
	database.exec(`ATTACH DATABASE '${current}' AS source`);
	for (const table of ["wf_meta", "wf_runs", "wf_events", "wf_leases"])
		database.exec(`CREATE TABLE main.${table} AS SELECT * FROM source.${table}`);
	database.exec("CREATE TABLE wf_legacy_deleted(run_id TEXT PRIMARY KEY)");
	database.exec("INSERT INTO wf_legacy_deleted VALUES ('deleted')");
	database.close();
	assert.deepEqual((await inspectJournalFile(path)).runs.map((run) => run.runId).sort(), [
		"aaa-pending",
		"converted",
		"zzz-current",
	]);
});

test("recovery refuses to settle a move into the file the run is in, and deletes nothing (#4325)", async () => {
	const adopted = await journal(join(root, "a", "journal.sqlite"), [{ runId: "r" }]);
	await adoptJournals(store, [adopted]);
	const alias = join(root, "alias.sqlite");
	linkSync(adopted, alias);
	const catalogFile = join(store, "catalog.sqlite");
	raw(
		catalogFile,
		"INSERT INTO catalog_shards(id, path, kind, created_at, accepts_new_roots) VALUES (2, ?, 'native', 0, 1)",
		alias,
	);
	raw(catalogFile, "UPDATE catalog_runs SET shard = 2 WHERE run_id = 'r'");
	raw(
		adopted,
		"UPDATE wf_leases SET holder_id = ?, epoch = epoch + 1",
		`${JOURNAL_CONSOLIDATION_HOLDER_PREFIX}crashed`,
	);
	const events = Number(scalar(adopted, FILE_EVENTS));
	const report = await consolidateJournalStore(store);
	assert.deepEqual(
		report.runs.map((run) => [run.runId, run.outcome, run.reason]),
		[["r", "skipped", "conflict"]],
	);
	assert.ok(report.runs[0]?.error instanceof JournalCatalogError && report.runs[0].error.code === "corrupt");
	assert.equal(scalar(adopted, FILE_EVENTS), events);
	assert.equal(scalar(adopted, "SELECT count(*) FROM wf_runs"), 1);
});

test("a journal an earlier version copied in full has its legacy runs ignored, as the journal itself ignores them (#4325)", async () => {
	const path = legacyJournal(join(root, "marked", "journal.sqlite"), ["kept", "ghost"]);
	const current = await journal(join(root, "scratch", "journal.sqlite"), [{ runId: "kept" }]);
	const database = new DatabaseSync(path);
	database.exec(`ATTACH DATABASE '${current}' AS source`);
	for (const table of ["wf_meta", "wf_runs", "wf_events", "wf_leases"])
		database.exec(`CREATE TABLE main.${table} AS SELECT * FROM source.${table}`);
	database.exec("CREATE TABLE wf_migrations(name TEXT PRIMARY KEY, applied_at INTEGER)");
	database.exec(`INSERT INTO wf_migrations VALUES ('${JOURNAL_COPIED_ALL_MARKER}', 0)`);
	database.close();
	assert.deepEqual(
		(await inspectJournalFile(path)).runs.map((run) => run.runId),
		["kept"],
	);
	const other = legacyJournal(join(root, "other", "journal.sqlite"), ["ghost"]);
	await adoptJournals(store, [path, other]);
	assert.deepEqual((await withCatalog((catalog) => catalog.runs({}))).map((run) => run.runId).sort(), [
		"ghost",
		"kept",
	]);
	assert.equal((await withCatalog((catalog) => catalog.locate("ghost")))?.shard.path, other);
	const sql = await openSqlRunJournal(path);
	try {
		assert.deepEqual(
			(await sql.listRuns()).map((run) => run.runId),
			["kept"],
			"the catalog indexes what the journal itself lists",
		);
	} finally {
		await sql.close();
	}
});

test("a journal whose migrations hold only other markers still has its legacy runs indexed (#4325)", async () => {
	const path = legacyJournal(join(root, "other-marker", "journal.sqlite"), ["old"]);
	raw(path, "CREATE TABLE wf_migrations(name TEXT PRIMARY KEY, applied_at INTEGER)");
	raw(path, "INSERT INTO wf_migrations VALUES ('another-migration', 0)");
	raw(
		path,
		"UPDATE runs SET header_json = ?",
		JSON.stringify({ runId: "old", name: "wf", cwd: "/p", createdAt: 1, status: "failed" }),
	);
	assert.deepEqual(
		(await inspectJournalFile(path)).runs.map((run) => run.runId),
		["old"],
	);
	const sql = await openSqlRunJournal(path);
	try {
		assert.deepEqual(
			(await sql.listRuns()).map((run) => run.runId),
			["old"],
			"the journal itself still lists its legacy run, as the catalog does",
		);
	} finally {
		await sql.close();
	}
});

test("recovery follows where the catalog names a run when it settles, not where it named it when the consolidation began (#4325)", async () => {
	const path = await journal(join(root, "old", "journal.sqlite"), [{ runId: "r" }]);
	await adoptJournals(store, [path]);
	const target = await withCatalog((catalog) => catalog.homeShard("r"));
	raw(path, "UPDATE wf_leases SET holder_id = ?, epoch = epoch + 1", `${JOURNAL_CONSOLIDATION_HOLDER_PREFIX}crashed`);
	await journal(target.path, []);
	const copy = new DatabaseSync(target.path);
	copy.exec(`ATTACH DATABASE '${path}' AS source`);
	for (const table of ["wf_runs", "wf_events", "wf_leases"])
		copy.exec(`INSERT INTO main.${table} SELECT * FROM source.${table}`);
	copy.close();
	await withCatalog((catalog) => catalog.moveRun("r", 1, target.id));
	const events = Number(scalar(path, EVENTS));
	let interleaved = false;
	const report = await withCatalog(async (catalog) => {
		// Another consolidation undoes the move after this one began, a resume adds an event, and a third consolidation
		// fences the file again and stops: the world changes once, before this consolidation settles anything.
		const interleave = async () => {
			if (interleaved) return;
			interleaved = true;
			assert.equal(await catalog.moveRun("r", target.id, 1), true);
			for (const table of ["wf_events", "wf_leases", "wf_runs"])
				raw(target.path, `DELETE FROM ${table} WHERE run_id = 'r'`);
			raw(
				path,
				"INSERT INTO wf_events(run_id, seq, epoch, key, type, payload, at) VALUES ('r', ?, 9, 'resumed', 'SummaryRecorded', 'null', 0)",
				events + 1,
			);
			raw(
				path,
				"UPDATE wf_leases SET holder_id = ?, epoch = epoch + 1 WHERE run_id = 'r'",
				`${JOURNAL_CONSOLIDATION_HOLDER_PREFIX}other`,
			);
		};
		for (const method of ["shard", "locate"] as const) {
			const original = catalog[method].bind(catalog) as (...args: never[]) => Promise<unknown>;
			Reflect.set(catalog, method, async (...args: never[]) => {
				await interleave();
				return original(...args);
			});
		}
		let ownersTaken = 0;
		const owners = catalog.owners.bind(catalog);
		Reflect.set(catalog, "owners", async () => {
			ownersTaken++;
			const snapshot = await owners();
			await interleave();
			return snapshot;
		});
		const result = await consolidateJournalStore(catalog);
		assert.equal(ownersTaken, 0, "recovery asks the catalog where the run is, not for a map taken at the start");
		return result;
	});
	assert.equal(interleaved, true);
	assert.deepEqual(
		report.runs.map((run) => [run.runId, run.outcome]),
		[["r", "moved"]],
		"the run is moved, not reported as having no journal",
	);
	const located = (await withCatalog((catalog) => catalog.locate("r")))!.shard;
	assert.notEqual(located.path, path);
	assert.equal(
		scalar(located.path, EVENTS),
		events + 1,
		"every event, the resume's included, is in the shard the catalog names",
	);
	assert.equal(scalar(path, "SELECT count(*) FROM wf_runs"), 0);
});

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
