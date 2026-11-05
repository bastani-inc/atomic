import assert from "node:assert/strict";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	isFinishedJournalStatus,
	isJournalCatalogError,
	JOURNAL_RESERVATION_TTL_MS,
	JOURNAL_SHARD_LIMIT,
	JournalCatalog,
	nativeShardFile,
} from "@bastani/atomic/storage";
import { afterEach, beforeEach, test } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

let root: string;
let store: string;
beforeEach(() => {
	root = makeTempDirectory("journal-catalog-edges-");
	store = join(root, "journal");
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

function raw(sql: string, ...params: (string | number | null)[]): void {
	const database = new DatabaseSync(join(store, "catalog.sqlite"), { enableForeignKeyConstraints: false });
	try {
		database.prepare(sql).run(...params);
	} finally {
		database.close();
	}
}

test("native shard files are numbered with four digits at least, and finished statuses are fixed (#4325)", () => {
	assert.deepEqual([1, 42, 12345].map(nativeShardFile), [
		"shard-0001.sqlite",
		"shard-0042.sqlite",
		"shard-12345.sqlite",
	]);
	assert.deepEqual(
		["completed", "failed", "cancelled", "running", "paused", "blocked", undefined].map(isFinishedJournalStatus),
		[true, true, true, false, false, false, false],
	);
});

test("shard records carry their id, absolute path, kind, creation time and whether they take new roots (#4325)", async () => {
	await withCatalog(async (catalog) => {
		const before = Date.now();
		const { shard } = await catalog.place({ runId: "r", status: "running" });
		assert.deepEqual(await catalog.shard(shard.id), shard);
		assert.equal(await catalog.shard(99), undefined);
		assert.deepEqual(
			[shard.path, shard.kind, shard.acceptsNewRoots],
			[join(store, "shard-0001.sqlite"), "native", true],
		);
		assert.ok(shard.createdAt >= before - 1000 && shard.createdAt <= Date.now() + 1000);
		const adopted = await catalog.registerAdopted(join(root, "old.sqlite"), [{ runId: "old" }]);
		assert.deepEqual(
			[adopted.status, adopted.shard.kind, adopted.shard.acceptsNewRoots, adopted.shard.path],
			["adopted", "adopted", false, join(root, "old.sqlite")],
		);
		assert.deepEqual(await catalog.locate("old"), {
			run: {
				runId: "old",
				shard: adopted.shard.id,
				rootRunId: "old",
				updatedAt: (await catalog.locate("old"))!.run.updatedAt,
			},
			shard: adopted.shard,
		});
		assert.deepEqual(
			(await catalog.runs({ shard: adopted.shard.id })).map((run) => run.runId),
			["old"],
		);
		assert.deepEqual(
			new Map(await catalog.owners()),
			new Map([
				["old", adopted.shard.id],
				["r", shard.id],
			]),
		);
	});
});

test("index keeps the first shard that indexed a run, and records what it knows (#4325)", async () => {
	await withCatalog(async (catalog) => {
		const first = await catalog.registerAdopted(join(root, "a.sqlite"), []);
		const second = await catalog.registerAdopted(join(root, "b.sqlite"), []);
		assert.equal(
			await catalog.index(first.shard.id, { runId: "x", name: "wf", cwd: "/p", status: "failed" }),
			first.shard.id,
		);
		assert.equal(await catalog.index(second.shard.id, { runId: "x" }), first.shard.id);
		assert.equal(await catalog.index(second.shard.id, { runId: "y" }), second.shard.id);
		const x = (await catalog.locate("x"))!.run;
		assert.deepEqual([x.cwd, x.workflow, x.status], ["/p", "wf", "failed"]);
		const y = (await catalog.locate("y"))!.run;
		assert.deepEqual(["cwd" in y, "workflow" in y, "status" in y], [false, false, false]);
	});
});

test("a reservation younger than its time to live holds its shard; an older one does not (#4325)", async () => {
	await withCatalog(async (catalog) => {
		await catalog.place({ runId: "a", status: "running" });
		await catalog.place({ runId: "b", status: "running" });
	});
	raw(
		"UPDATE catalog_runs SET status = NULL, updated_at = ? WHERE run_id = 'a'",
		Date.now() - JOURNAL_RESERVATION_TTL_MS + 60_000,
	);
	raw(
		"UPDATE catalog_runs SET status = NULL, updated_at = ? WHERE run_id = 'b'",
		Date.now() - JOURNAL_RESERVATION_TTL_MS - 60_000,
	);
	await withCatalog(async (catalog) => {
		const placed = await catalog.place({ runId: "c", status: "running" });
		assert.equal(placed.shard.id, 2, "the fresh reservation still holds shard 1; the stale one frees shard 2");
	});
});

test("past the shard limit a root goes to a least busy shard, never a busier one (#4325)", async () => {
	await withCatalog(async (catalog) => {
		for (let index = 0; index < JOURNAL_SHARD_LIMIT; index++)
			await catalog.place({ runId: `busy-${index}`, status: "running" });
		const crowded = await catalog.place({ runId: "extra-1", status: "running" });
		for (let index = 0; index < 8; index++) {
			const next = await catalog.place({ runId: `extra-more-${index}`, status: "running" });
			assert.notEqual(
				next.shard.id,
				crowded.shard.id,
				"the shard holding two roots is never chosen while others hold one",
			);
		}
		assert.equal((await catalog.shards()).length, JOURNAL_SHARD_LIMIT);
	});
});

test("a run naming a shard the catalog does not register is reported as a corrupt catalog (#4325)", async () => {
	await withCatalog(async () => {});
	raw("INSERT INTO catalog_runs VALUES ('orphan', 7, 'orphan', NULL, NULL, 'running', 0)");
	await withCatalog(async (catalog) => {
		const error = await catalog.place({ runId: "orphan", status: "running" }).catch((caught: Error) => caught);
		assert.ok(isJournalCatalogError(error));
		assert.equal(error.code, "corrupt");
		assert.deepEqual([error.fields.runId, error.fields.shardId], ["orphan", 7]);
		assert.equal(error.fields.rule, "run orphan names shard 7, which is not registered");
	});
});

test("a catalog whose schema cannot be written fails to open as unavailable, and a closed one refuses reads (#4325)", async () => {
	await withCatalog(async () => {});
	raw("DELETE FROM catalog_meta");
	raw("CREATE TRIGGER refuse BEFORE INSERT ON catalog_meta BEGIN SELECT RAISE(ABORT, 'read-only volume'); END");
	const error = await JournalCatalog.open(store).catch((caught: Error) => caught);
	assert.ok(isJournalCatalogError(error));
	assert.deepEqual([error.code, error.phase], ["catalog-unavailable", "opening"]);
	assert.ok(String(error.fields.detail).includes("read-only volume"));
	raw("DROP TRIGGER refuse");
	const catalog = await JournalCatalog.open(store);
	const closing = catalog.close();
	assert.equal(catalog.close(), closing);
	await closing;
	const closed = await catalog.shards().catch((caught: Error) => caught);
	assert.ok(isJournalCatalogError(closed));
	assert.equal(closed.code, "catalog-unavailable");
	const write = await catalog.setStatus("x", "done").catch((caught: Error) => caught);
	assert.ok(isJournalCatalogError(write));
	assert.deepEqual([write.code, write.phase, write.runId], ["write-failed", "recording-status", "x"]);
	const remove = await catalog.remove("x").catch((caught: Error) => caught);
	assert.ok(isJournalCatalogError(remove) && remove.phase === "removing-run");
	const move = await catalog.moveRun("x", 1, 2).catch((caught: Error) => caught);
	assert.ok(isJournalCatalogError(move) && move.phase === "moving-run");
	const home = await catalog.homeShard("x").catch((caught: Error) => caught);
	assert.ok(isJournalCatalogError(home) && home.phase === "moving-run");
	const index = await catalog.index(1, { runId: "x" }).catch((caught: Error) => caught);
	assert.ok(isJournalCatalogError(index) && index.phase === "registering-shard");
	const adopt = await catalog.registerAdopted("/x.sqlite", []).catch((caught: Error) => caught);
	assert.ok(isJournalCatalogError(adopt) && adopt.phase === "registering-shard");
	const discovery = await catalog.recordDiscovery({ path: "/x", outcome: "skipped" }).catch((caught: Error) => caught);
	assert.ok(isJournalCatalogError(discovery) && discovery.phase === "registering-shard");
});

test("discovery records keep where a journal was referenced from when a later record does not say (#4325)", async () => {
	await withCatalog(async (catalog) => {
		await catalog.recordDiscovery({
			path: join(root, "j.sqlite"),
			outcome: "skipped",
			reason: "path-not-found",
			referencedBy: "/from",
		});
		await catalog.recordDiscovery({ path: join(root, "j.sqlite"), outcome: "adopted" });
		const [record] = await catalog.discoveries();
		assert.deepEqual(
			[record?.path, record?.outcome, record?.reason, record?.referencedBy],
			[join(root, "j.sqlite"), "adopted", undefined, "/from"],
		);
	});
});

test("a fresh reservation holds its shard against a new root; a store's catalog reports odd schema versions as found (#4325)", async () => {
	await withCatalog(async (catalog) => {
		await catalog.place({ runId: "reserved" });
		const next = await catalog.place({ runId: "next", status: "running" });
		assert.equal(next.shard.id, 2, "a reservation a second old still holds shard 1");
	});
	raw("UPDATE catalog_meta SET schema_version = X'02'");
	const blob = await JournalCatalog.open(store).catch((error: Error) => error);
	assert.ok(isJournalCatalogError(blob));
	assert.deepEqual([blob.code, blob.fields.found], ["schema-version", "2"]);
	raw("UPDATE catalog_meta SET schema_version = 'one'");
	const text = await JournalCatalog.open(store).catch((error: Error) => error);
	assert.ok(isJournalCatalogError(text));
	assert.equal(text.fields.found, "one");
});

test("a catalog row created by a reservation takes the root's details when the root is created, and only then (#4325)", async () => {
	await withCatalog(async (catalog) => {
		await catalog.place({ runId: "r" });
		await catalog.place({ runId: "r" });
		assert.equal(
			(await catalog.locate("r"))!.run.status,
			undefined,
			"placing again without a status keeps the reservation",
		);
		await catalog.place({ runId: "r", name: "wf", cwd: "/p", status: "running" });
		await catalog.place({ runId: "r", name: "other", cwd: "/q", status: "paused" });
		const run = (await catalog.locate("r"))!.run;
		assert.deepEqual(
			[run.workflow, run.cwd, run.status],
			["wf", "/p", "running"],
			"a created root's row is not overwritten",
		);
	});
});

test("a new native shard's file is prepared before the catalog registers it, and a failed preparation registers nothing (#4325)", async () => {
	const prepared: string[] = [];
	const catalog = await JournalCatalog.open(join(root, "prepared"), {
		prepareShard: async (path) => {
			prepared.push(path);
			writeFileSync(path, "");
		},
	});
	try {
		const placed = await catalog.place({ runId: "first", status: "running" });
		assert.deepEqual(prepared, [placed.shard.path]);
	} finally {
		await catalog.close();
	}
	const refusing = await JournalCatalog.open(join(root, "refusing"), {
		prepareShard: async () => {
			throw new Error("cannot prepare");
		},
	});
	try {
		const refused = await refusing.place({ runId: "first", status: "running" }).catch((error: Error) => error);
		assert.ok(isJournalCatalogError(refused));
		assert.deepEqual([refused.code, refused.fields.phase], ["write-failed", "placing-run"]);
		assert.deepEqual(await refusing.shards(), []);
		assert.equal(await refusing.locate("first"), undefined);
	} finally {
		await refusing.close();
	}
	const plain = await JournalCatalog.open(join(root, "plain"));
	try {
		const placed = await plain.place({ runId: "first", status: "running" });
		assert.equal(statSync(placed.shard.path).size, 0, "by default the file is created empty");
	} finally {
		await plain.close();
	}
});
