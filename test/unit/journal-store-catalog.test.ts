import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	adoptJournals,
	consolidateJournalStore,
	findJournalStoreError,
	isJournalAdoptError,
	isJournalCatalogError,
	isJournalShardUnavailableError,
	isJournalStoreError,
	isRetryableJournalStoreError,
	JOURNAL_ADOPT_ERROR_CODES,
	JOURNAL_CATALOG_ERROR_CODES,
	JOURNAL_CATALOG_SCHEMA_VERSION,
	JOURNAL_RESERVATION_TTL_MS,
	JOURNAL_SHARD_LIMIT,
	JOURNAL_SHARD_UNAVAILABLE_ERROR_CODES,
	JournalAdoptError,
	JournalCatalog,
	JournalCatalogError,
	JournalShardUnavailableError,
	JournalStoreError,
	journalShardHash,
	nativeShardFile,
	RUN_JOURNAL_SCHEMA_VERSION,
	rehydrateJournalStoreError,
	SHARED_STORAGE_JOIN_HINT,
	StorageError,
	serializeJournalStoreError,
} from "@bastani/atomic/storage";
import { afterEach, beforeEach, test } from "vitest";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

let root: string;
let store: string;
beforeEach(() => {
	root = makeTempDirectory("journal-store-");
	store = join(root, "workflows", "journal");
});
afterEach(() => removeTempDirectory(root));

async function withCatalog<T>(body: (catalog: JournalCatalog) => Promise<T>): Promise<T> {
	const catalog = await JournalCatalog.open(store);
	try {
		return await body(catalog);
	} finally {
		await catalog.close();
	}
}

/** A legacy single-file journal holding `runs`, each finished or running, written through the SQL run journal. */
async function legacyJournal(
	path: string,
	runs: readonly { readonly runId: string; readonly status?: string; readonly events?: number }[],
): Promise<void> {
	mkdirSync(join(path, ".."), { recursive: true });
	const journal = await openSqlRunJournal(path);
	try {
		for (const run of runs) {
			await journal.createRun({ runId: run.runId, name: "wf", cwd: "/project", createdAt: 1, status: "running" });
			const acquired = await journal.acquire(run.runId, "writer");
			assert.equal(acquired.status, "acquired");
			if (acquired.status !== "acquired") return;
			for (let index = 0; index < (run.events ?? 2); index++)
				await journal.append(
					acquired.lease,
					{ type: "CheckpointRecorded", payload: { kind: "tool", index } },
					{ key: `k${index}` },
				);
			if (run.status !== undefined)
				await journal.append(acquired.lease, { type: "StatusChanged", payload: { status: run.status } });
			await journal.release(acquired.lease);
		}
	} finally {
		await journal.close();
	}
}

test("a new root takes an idle shard, a busy store adds one, and runs never move", async () => {
	await withCatalog(async (catalog) => {
		const first = await catalog.place({ runId: "root-a", status: "running" });
		const second = await catalog.place({ runId: "root-b", status: "running" });
		const third = await catalog.place({ runId: "root-c", status: "running" });
		assert.deepEqual(
			[first, second, third].map((placement) => [placement.placed, placement.shard.id, placement.shard.kind]),
			[
				[true, 1, "native"],
				[true, 2, "native"],
				[true, 3, "native"],
			],
		);
		assert.equal(first.shard.path, join(store, nativeShardFile(1)));
		await catalog.setStatus("root-b", "completed");
		const fourth = await catalog.place({ runId: "root-d", status: "running" });
		assert.equal(fourth.shard.id, 2, "the shard whose root finished is idle again");
		const again = await catalog.place({ runId: "root-a", status: "running" });
		assert.deepEqual([again.placed, again.shard.id], [false, 1]);
		assert.equal((await catalog.shards()).length, 3);
		assert.deepEqual(
			(await catalog.runs()).map((run) => [run.runId, run.shard, run.rootRunId, run.status]),
			[
				["root-a", 1, "root-a", "running"],
				["root-b", 2, "root-b", "completed"],
				["root-c", 3, "root-c", "running"],
				["root-d", 2, "root-d", "running"],
			],
		);
	});
});

test("among idle shards the root ID's hash chooses, the same in every process", async () => {
	await withCatalog(async (catalog) => {
		for (const id of ["a", "b", "c"]) await catalog.place({ runId: id, status: "running" });
		for (const id of ["a", "b", "c"]) await catalog.setStatus(id, "completed");
		const runId = "fresh-root";
		const placed = await catalog.place({ runId, status: "running" });
		assert.equal(placed.shard.id, [1, 2, 3][journalShardHash(runId) % 3]);
	});
	assert.equal(journalShardHash("fresh-root"), journalShardHash("fresh-root"));
	assert.notEqual(journalShardHash("fresh-root"), journalShardHash("fresh-rooT"));
});

test("past the shard limit a root shares the least busy shard", async () => {
	await withCatalog(async (catalog) => {
		for (let index = 0; index < JOURNAL_SHARD_LIMIT; index++)
			await catalog.place({ runId: `busy-${index}`, status: "running" });
		assert.equal((await catalog.shards()).length, JOURNAL_SHARD_LIMIT);
		await catalog.place({ runId: "extra-1", status: "running" });
		assert.equal((await catalog.shards()).length, JOURNAL_SHARD_LIMIT, "no shard past the limit");
		await catalog.setStatus("busy-5", "failed");
		const placed = await catalog.place({ runId: "extra-2", status: "running" });
		assert.equal(placed.shard.id, (await catalog.locate("busy-5"))!.shard.id);
	});
});

test("a reservation holds its shard until the root is created or its time runs out", async () => {
	await withCatalog(async (catalog) => {
		const reserved = await catalog.place({ runId: "reserved" });
		assert.equal((await catalog.locate("reserved"))!.run.status, undefined);
		await new Promise((resolve) => setTimeout(resolve, 25));
		const other = await catalog.place({ runId: "other", status: "running" });
		assert.notEqual(other.shard.id, reserved.shard.id);
		const created = await catalog.place({ runId: "reserved", name: "wf", cwd: "/p", status: "running" });
		assert.deepEqual([created.placed, created.shard.id], [false, reserved.shard.id]);
		assert.deepEqual(
			{ ...(await catalog.locate("reserved"))!.run, updatedAt: 0 },
			{
				runId: "reserved",
				shard: reserved.shard.id,
				rootRunId: "reserved",
				cwd: "/p",
				workflow: "wf",
				status: "running",
				updatedAt: 0,
			},
		);
		await catalog.setStatus("reserved", "completed");
		await catalog.setStatus("other", "completed");
	});
	const database = new DatabaseSync(join(store, "catalog.sqlite"));
	database
		.prepare("INSERT INTO catalog_runs VALUES ('stale', 1, 'stale', NULL, NULL, NULL, ?)")
		.run(Date.now() - JOURNAL_RESERVATION_TTL_MS - 1_000);
	database.close();
	await withCatalog(async (catalog) => {
		const placed = await catalog.place({ runId: "after-stale", status: "running" });
		assert.equal(placed.shard.id, [1, 2][journalShardHash("after-stale") % 2], "a stale reservation holds nothing");
	});
});

test("moveRun moves a run only from the shard it is still on", async () => {
	await withCatalog(async (catalog) => {
		await catalog.place({ runId: "a", status: "running" });
		await catalog.place({ runId: "b", status: "running" });
		assert.equal(await catalog.moveRun("a", 2, 1), false);
		assert.equal(await catalog.moveRun("a", 1, 2), true);
		assert.equal((await catalog.locate("a"))!.shard.id, 2);
		await catalog.remove("a");
		assert.equal(await catalog.locate("a"), undefined);
	});
});

test("the catalog token moves with every catalog commit and only then", async () => {
	await withCatalog(async (catalog) => {
		const empty = await catalog.changeToken();
		assert.equal(await catalog.changeToken(), empty);
		await catalog.place({ runId: "a", status: "running" });
		const placed = await catalog.changeToken();
		assert.notEqual(placed, empty);
		await catalog.setStatus("a", "completed");
		assert.notEqual(await catalog.changeToken(), placed);
	});
});

test("JournalCatalogError catalog-unavailable: the store directory cannot be created", async () => {
	writeFileSync(join(root, "blocked"), "a file");
	const error = await JournalCatalog.open(join(root, "blocked", "journal")).catch((caught: Error) => caught);
	assert.ok(isJournalCatalogError(error));
	assert.ok(
		error instanceof JournalCatalogError && error instanceof JournalStoreError && error instanceof StorageError,
	);
	assert.equal(error.code, "catalog-unavailable");
	assert.equal(error.catalogPath, join(root, "blocked", "journal", "catalog.sqlite"));
	assert.equal(error.phase, "opening");
	assert.equal(error.retryable, false);
	assert.ok(error.cause instanceof Error);
});

test("JournalCatalogError schema-version and corrupt: a catalog this Atomic cannot read", async () => {
	await withCatalog(async () => {});
	const database = new DatabaseSync(join(store, "catalog.sqlite"));
	database.exec(`UPDATE catalog_meta SET schema_version = ${JOURNAL_CATALOG_SCHEMA_VERSION + 1}`);
	const newer = await JournalCatalog.open(store).catch((caught: Error) => caught);
	assert.ok(isJournalCatalogError(newer));
	assert.equal(newer.code, "schema-version");
	assert.deepEqual(
		[newer.fields.found, newer.fields.supported],
		[JOURNAL_CATALOG_SCHEMA_VERSION + 1, JOURNAL_CATALOG_SCHEMA_VERSION],
	);
	database.exec(
		`UPDATE catalog_meta SET schema_version = ${JOURNAL_CATALOG_SCHEMA_VERSION}; INSERT INTO catalog_meta VALUES (1)`,
	);
	database.close();
	const corrupt = await JournalCatalog.open(store).catch((caught: Error) => caught);
	assert.ok(isJournalCatalogError(corrupt));
	assert.equal(corrupt.code, "corrupt");
	assert.equal(corrupt.fields.rule, "catalog_meta has 2 rows");
	assert.ok(corrupt.hint?.includes("atomic storage adopt"));
});

test("JournalCatalogError write-failed: a refused catalog write names its phase and run and keeps its cause", async () => {
	await withCatalog(async () => {});
	const database = new DatabaseSync(join(store, "catalog.sqlite"));
	database.exec(
		"CREATE TRIGGER refuse BEFORE INSERT ON catalog_runs BEGIN SELECT RAISE(ABORT, 'refused by test'); END",
	);
	database.close();
	await withCatalog(async (catalog) => {
		const error = await catalog.place({ runId: "root", status: "running" }).catch((caught: Error) => caught);
		assert.ok(isJournalCatalogError(error));
		assert.equal(error.code, "write-failed");
		assert.equal(error.phase, "placing-run");
		assert.equal(error.runId, "root");
		assert.equal(error.retryable, false);
		assert.ok(String(error.fields.detail).includes("refused by test"));
		assert.equal(await catalog.locate("root"), undefined, "nothing was placed");
		assert.equal((await catalog.shards()).length, 0, "the shard added in that transaction rolled back");
	});
});

test("JournalCatalogError renders what failed, the subject, the code and what to do (UX contract)", () => {
	const error = new JournalCatalogError({
		code: "run-not-found",
		catalogPath: "/home/u/.atomic/workflows/journal/catalog.sqlite",
		runId: "0a1b",
		selection: "journal store /home/u/.atomic/workflows/journal",
		localOnly: true,
	});
	assert.equal(
		error.message,
		"Workflow run not found: 0a1b in journal store /home/u/.atomic/workflows/journal (run-not-found).",
	);
	assert.equal(
		error.hint,
		`This machine uses local-only storage and is not joined to shared storage. If the run started on another machine, join its storage with \`${SHARED_STORAGE_JOIN_HINT}\`; if it is in an older journal file, adopt it with \`atomic storage adopt <path>\`.`,
	);
	assert.equal(SHARED_STORAGE_JOIN_HINT, "atomic storage join <url> --token-file <path>");
});

test("JournalAdoptError path-not-found, not-a-journal and schema-version are raised before anything is registered", async () => {
	const missing = await adoptJournals(store, [join(root, "absent.sqlite")]).catch((caught: Error) => caught);
	assert.ok(isJournalAdoptError(missing));
	assert.equal(missing.code, "path-not-found");
	assert.equal(missing.path, join(root, "absent.sqlite"));

	writeFileSync(join(root, "notes.sqlite"), "plain text, not a database");
	const text = await adoptJournals(store, [join(root, "notes.sqlite")]).catch((caught: Error) => caught);
	assert.ok(isJournalAdoptError(text));
	assert.deepEqual([text.code, text.reason], ["not-a-journal", "not-sqlite"]);

	const sessions = new DatabaseSync(join(root, "sessions.sqlite"));
	sessions.exec("CREATE TABLE session_entries(id TEXT)");
	sessions.close();
	const empty = await adoptJournals(store, [join(root, "sessions.sqlite")]).catch((caught: Error) => caught);
	assert.ok(isJournalAdoptError(empty));
	assert.deepEqual([empty.code, empty.reason], ["not-a-journal", "no-journal-tables"]);

	mkdirSync(join(root, "empty-dir"));
	const directory = await adoptJournals(store, [join(root, "empty-dir")]).catch((caught: Error) => caught);
	assert.ok(isJournalAdoptError(directory));
	assert.deepEqual([directory.code, directory.reason], ["not-a-journal", "directory"]);

	await withCatalog(async () => {});
	const catalog = await adoptJournals(store, [join(store, "catalog.sqlite")]).catch((caught: Error) => caught);
	assert.ok(isJournalAdoptError(catalog));
	assert.deepEqual([catalog.code, catalog.reason], ["not-a-journal", "store-catalog"]);

	await legacyJournal(join(root, "future", "journal.sqlite"), [{ runId: "x" }]);
	const future = new DatabaseSync(join(root, "future", "journal.sqlite"));
	future.exec(`UPDATE wf_meta SET schema_version = ${RUN_JOURNAL_SCHEMA_VERSION + 1}`);
	future.close();
	const newer = await adoptJournals(store, [join(root, "future")]).catch((caught: Error) => caught);
	assert.ok(isJournalAdoptError(newer));
	assert.equal(newer.code, "schema-version");
	assert.equal(newer.fields.found, RUN_JOURNAL_SCHEMA_VERSION + 1);

	await legacyJournal(join(root, "good", "journal.sqlite"), [{ runId: "g" }]);
	const mixed = await adoptJournals(store, [join(root, "good"), join(root, "absent")]).catch(
		(caught: Error) => caught,
	);
	assert.ok(isJournalAdoptError(mixed) && mixed.code === "path-not-found");
	await withCatalog(async (catalog) => assert.deepEqual(await catalog.shards(), [], "no path was registered"));
});

test("JournalAdoptError run-conflict: two copies of one journal, in one call or one after the other", async () => {
	await legacyJournal(join(root, "a", "journal.sqlite"), [{ runId: "shared" }]);
	await legacyJournal(join(root, "b", "journal.sqlite"), [{ runId: "shared" }]);
	const together = await adoptJournals(store, [join(root, "a"), join(root, "b")]).catch((caught: Error) => caught);
	assert.ok(isJournalAdoptError(together));
	assert.equal(together.code, "run-conflict");
	assert.equal(together.fields.runId, "shared");
	assert.equal(together.fields.existingPath, join(root, "a", "journal.sqlite"));
	await withCatalog(async (catalog) => assert.deepEqual(await catalog.shards(), []));

	await adoptJournals(store, [join(root, "a")]);
	const later = await adoptJournals(store, [join(root, "b")]).catch((caught: Error) => caught);
	assert.ok(isJournalAdoptError(later));
	assert.equal(later.code, "run-conflict");
	await withCatalog(async (catalog) => assert.equal((await catalog.shards()).length, 1));
});

test("JournalShardUnavailableError shard-missing: consolidation leaves a missing adopted journal's runs, typed", async () => {
	await legacyJournal(join(root, "gone", "journal.sqlite"), [{ runId: "r", status: "completed" }]);
	await adoptJournals(store, [join(root, "gone")]);
	removeTempDirectory(join(root, "gone"));
	const report = await consolidateJournalStore(store);
	assert.equal(report.moved, 0);
	const [run] = report.runs;
	assert.equal(run?.reason, "shard-unavailable");
	assert.ok(isJournalShardUnavailableError(run?.error));
	assert.equal(run.error.code, "shard-missing");
	assert.equal(run.error.fields.shardPath, join(root, "gone", "journal.sqlite"));
	assert.equal(run.error.retryable, false);
});

test("JournalCatalogError run-conflict: consolidation leaves a run whose destination holds a different copy", async () => {
	await legacyJournal(join(root, "old", "journal.sqlite"), [{ runId: "dup", status: "completed" }]);
	await adoptJournals(store, [join(root, "old")]);
	const target = await withCatalog((catalog) => catalog.homeShard("dup"));
	await legacyJournal(target.path, [{ runId: "dup", status: "completed", events: 5 }]);
	const report = await consolidateJournalStore(store);
	const [run] = report.runs;
	assert.equal(run?.reason, "conflict");
	assert.ok(isJournalCatalogError(run?.error));
	assert.equal(run.error.code, "run-conflict");
	assert.equal(run.error.fields.shardPath, target.path);
	await withCatalog(async (catalog) => assert.equal((await catalog.locate("dup"))!.shard.kind, "adopted"));
	const source = new DatabaseSync(join(root, "old", "journal.sqlite"));
	assert.equal(source.prepare("SELECT holder_id FROM wf_leases WHERE run_id = 'dup'").get()?.holder_id, null);
	source.close();
});

test("every code of every journal store error survives serialize, JSON and rehydrate with its class, guard and fields", () => {
	const errors: JournalStoreError[] = [
		...JOURNAL_CATALOG_ERROR_CODES.map(
			(code) =>
				new JournalCatalogError({
					code,
					catalogPath: "/s/catalog.sqlite",
					phase: "placing-run",
					runId: "r",
					shardId: 2,
					shardPath: "/s/shard-0002.sqlite",
					found: 9,
					supported: 1,
					rule: "rule",
					selection: "journal store /s",
					localOnly: true,
					cause: Object.assign(new Error("database is locked", { cause: new Error("inner") }), { errcode: 5 }),
				}),
		),
		...JOURNAL_SHARD_UNAVAILABLE_ERROR_CODES.map(
			(code) =>
				new JournalShardUnavailableError({ code, shardId: 3, shardPath: "/s/shard-0003.sqlite", runId: "r" }),
		),
		...JOURNAL_ADOPT_ERROR_CODES.map(
			(code) =>
				new JournalAdoptError({
					code,
					path: "/old/journal.sqlite",
					reason: "not-sqlite",
					runId: "r",
					existingPath: "/other/journal.sqlite",
					found: 2,
					supported: 1,
				}),
		),
	];
	for (const error of errors) {
		const wire = JSON.parse(JSON.stringify(serializeJournalStoreError(error)));
		const back = rehydrateJournalStoreError(wire);
		assert.equal(back.constructor, error.constructor, `${error.name} ${error.code}`);
		assert.equal(back.name, error.name);
		assert.equal(back.code, error.code);
		assert.equal(back.message, error.message);
		assert.equal(back.hint, error.hint);
		assert.equal(back.retryable, error.retryable);
		assert.deepEqual(back.fields, error.fields);
		assert.ok(isJournalStoreError(back));
		assert.equal(isJournalCatalogError(back), error instanceof JournalCatalogError);
		assert.equal(isJournalShardUnavailableError(back), error instanceof JournalShardUnavailableError);
		assert.equal(isJournalAdoptError(back), error instanceof JournalAdoptError);
		assert.equal((back.cause as Error | undefined)?.message, (error.cause as Error | undefined)?.message);
	}
	const busy = errors.find((error) => error.code === "write-failed")!;
	assert.equal(busy.retryable, true, "a busy write lock is worth retrying");
	assert.equal(rehydrateJournalStoreError(serializeJournalStoreError(busy)).retryable, true);
});

test("an unknown journal store error name rehydrates into the family base with its name and code", () => {
	const back = rehydrateJournalStoreError({
		name: "JournalShardFencedError",
		code: "fenced",
		message: "Journal shard fenced: /s (fenced).",
		hint: "Retry later.",
		retryable: true,
		fields: { shardId: 4 },
		cause: { name: "StaleLeaseError", message: "Stale lease for run r", code: "stale" },
	});
	assert.equal(back.constructor, JournalStoreError);
	assert.deepEqual(
		[back.name, back.code, back.hint, back.retryable],
		["JournalShardFencedError", "fenced", "Retry later.", true],
	);
	assert.deepEqual(back.fields, { shardId: 4 });
	assert.equal((back.cause as Error).name, "StaleLeaseError");
	assert.equal((back.cause as { code?: string }).code, "stale");
	assert.equal(isJournalCatalogError(back), false);
	assert.ok(isJournalStoreError(back));
});

test("guards match structurally across realms and walk a bounded cause chain", () => {
	const plain = { name: "JournalAdoptError", code: "run-conflict", fields: {}, retryable: false, message: "x" };
	assert.ok(isJournalAdoptError(plain));
	assert.equal(isJournalAdoptError({ ...plain, code: "unknown-code" }), false);
	assert.equal(isJournalCatalogError(plain), false);
	const retryable = new JournalShardUnavailableError({
		code: "shard-open-failed",
		shardId: 1,
		shardPath: "/s",
		cause: Object.assign(new Error("database is locked"), { errcode: 5 }),
	});
	assert.equal(retryable.retryable, true);
	const wrapped = new Error("outer", { cause: new Error("middle", { cause: retryable }) });
	assert.equal(findJournalStoreError(wrapped), retryable);
	assert.ok(isRetryableJournalStoreError(wrapped));
	let deep: Error = retryable;
	for (let depth = 0; depth < 8; depth++) deep = new Error(`level ${depth}`, { cause: deep });
	assert.equal(findJournalStoreError(deep), undefined, "the walk stops after eight causes");
	assert.equal(isRetryableJournalStoreError(deep), false);
	assert.equal(
		new JournalShardUnavailableError({
			code: "shard-missing",
			shardId: 1,
			shardPath: "/s",
			cause: retryable.cause as Error,
		}).retryable,
		false,
		"a missing file is never retryable",
	);
});

test("adoption registers in place: the journal file is never copied or rewritten", async () => {
	const path = join(root, "campaign", "journal.sqlite");
	await legacyJournal(path, [{ runId: "in-place", status: "completed" }]);
	const before = statSync(path);
	const report = await adoptJournals(store, [join(root, "campaign")]);
	assert.deepEqual(report.adopted, [{ path, status: "adopted", shardId: 1, runs: 1 }]);
	const after = statSync(path);
	assert.deepEqual([after.ino, after.size, after.mtimeMs], [before.ino, before.size, before.mtimeMs]);
	const again = await adoptJournals(store, [path]);
	assert.deepEqual(again.adopted, [{ path, status: "already-registered", shardId: 1, runs: 0 }]);
	await withCatalog(async (catalog) => {
		const [shard] = await catalog.shards();
		assert.deepEqual([shard?.kind, shard?.path, shard?.acceptsNewRoots], ["adopted", path, false]);
		assert.deepEqual((await catalog.locate("in-place"))!.run.status, "completed");
	});
});
