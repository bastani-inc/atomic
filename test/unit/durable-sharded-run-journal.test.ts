import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	adoptJournals,
	isJournalCatalogError,
	isJournalShardUnavailableError,
	JournalCatalog,
	SHARED_STORAGE_JOIN_HINT,
} from "@bastani/atomic/storage";
import { afterEach, beforeEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import { registerRunJournalConformance } from "../../packages/workflows/src/durable/journal/conformance.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSelectedRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import {
	existingRootRunJournal,
	isShardedRunJournal,
	rootRunJournal,
	ShardedRunJournal,
} from "../../packages/workflows/src/durable/journal/sharded-run-journal.js";
import {
	openSqlRunJournal,
	type SqlRunJournal,
} from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { Lease, RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import { inspectTargetedDurableWorkflow } from "../../packages/workflows/src/durable/targeted-inspection.js";
import { isLocalPoolJournal } from "../../packages/workflows/src/workers/pool-journal.js";
import { observeJournalRead } from "../helpers/journal-read-observation.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const conformanceShards = new WeakMap<RunJournal, Map<string, SqlRunJournal>>();
registerRunJournalConformance(
	test,
	"journal store",
	async () => {
		const directory = makeTempDirectory("journal-store-conformance-");
		const opened = new Map<string, SqlRunJournal>();
		const journal = await ShardedRunJournal.open({
			directory: join(directory, "journal"),
			openShard: async (path) => {
				const shard = await openSqlRunJournal(path);
				opened.set(path, shard);
				return shard;
			},
		});
		conformanceShards.set(journal, opened);
		const close = journal.close.bind(journal);
		journal.close = async () => {
			await close();
			removeTempDirectory(directory);
		};
		return journal;
	},
	(journal) => {
		const shards = [...(conformanceShards.get(journal)?.values() ?? [])];
		assert.equal(shards.length, 1, "the conformance run lives on one shard");
		return observeJournalRead(shards[0]!);
	},
);

let root: string;
let agentDir: string;
let store: string;
const closing: (() => Promise<void>)[] = [];
beforeEach(() => {
	root = makeTempDirectory("journal-store-router-");
	agentDir = join(root, "agent");
	store = join(root, "workflows", "journal");
	mkdirSync(agentDir, { recursive: true });
});
afterEach(async () => {
	for (const close of closing.splice(0).reverse()) await close();
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

async function openStore(): Promise<ShardedRunJournal> {
	const journal = await openSelectedRunJournal({ kind: "sharded", dir: store }, agentDir);
	assert.ok(isShardedRunJournal(journal));
	closing.push(() => journal.close());
	return journal;
}

async function startRoot(journal: RunJournal, runId: string, holder = "owner"): Promise<Lease> {
	assert.equal(
		await journal.createRun({ runId, name: "wf", cwd: "/project", createdAt: 1, status: "running" }),
		"created",
	);
	const outcome = await journal.acquire(runId, holder);
	assert.equal(outcome.status, "acquired");
	if (outcome.status !== "acquired") throw new Error("not acquired");
	return outcome.lease;
}

/** A backend-written journal file at `path` with one root per id, each with `checkpoints` tool checkpoints. */
async function backendJournal(path: string, ids: readonly string[], checkpoints = 2): Promise<void> {
	mkdirSync(join(path, ".."), { recursive: true });
	const backend = await JournalDurableBackend.open(await openSqlRunJournal(path));
	try {
		for (const workflowId of ids) {
			await backend.commitWorkflowRegistration({
				workflowId,
				name: "legacy",
				inputs: {},
				createdAt: 1,
				status: "running",
			});
			for (let index = 0; index < checkpoints; index++)
				await backend.commitCheckpoint({
					kind: "tool",
					workflowId,
					checkpointId: `c${index}`,
					name: "tool",
					argsHash: `a${index}`,
					output: index,
					completedAt: 2 + index,
				});
			await backend.commitWorkflowRegistration({
				workflowId,
				name: "legacy",
				inputs: {},
				createdAt: 1,
				status: "failed",
			});
		}
	} finally {
		await backend.close();
	}
}

test("three roots started together land on three shards, each shard holding only its root (#4325)", async () => {
	const journal = await openStore();
	const ids = ["campaign-a", "campaign-b", "campaign-c"];
	await Promise.all(ids.map((id) => startRoot(journal, id)));
	const shards = ids.map((id) => journal.shardOf(id)!);
	assert.equal(new Set(shards.map((shard) => shard.id)).size, 3);
	for (const [index, shard] of shards.entries()) {
		const database = new DatabaseSync(shard.path, { readOnly: true });
		assert.deepEqual(
			database
				.prepare("SELECT run_id FROM wf_runs")
				.all()
				.map((row) => row.run_id),
			[ids[index]],
		);
		database.close();
	}
});

test("any run ID resolves through the catalog from a fresh store, across shards and adopted journals", async () => {
	const legacy = join(root, "campaign-journal-1", "journal.sqlite");
	await backendJournal(legacy, ["legacy-root"]);
	const first = await openStore();
	const leases = await Promise.all(["root-1", "root-2"].map((id) => startRoot(first, id)));
	for (const lease of leases) {
		await first.append(
			lease,
			{ type: "CheckpointRecorded", payload: { kind: "tool", completedAt: 3 } },
			{ key: "k" },
		);
		await first.append(lease, { type: "StatusChanged", payload: { status: "completed" } });
		await first.release(lease);
	}
	await adoptJournals(store, [join(root, "campaign-journal-1")]);

	const fresh = await openStore();
	assert.deepEqual(
		(await fresh.listRuns()).map((run) => run.runId),
		["legacy-root", "root-1", "root-2"],
	);
	assert.deepEqual([...(await fresh.runVersions()).keys()].sort(), ["legacy-root", "root-1", "root-2"]);
	for (const id of ["root-1", "root-2", "legacy-root"]) {
		assert.equal((await fresh.getRun(id))?.runId, id);
		const events: number[] = [];
		for await (const entry of fresh.read(id)) events.push(entry.seq);
		assert.ok(events.length >= 2, `${id} reads its events`);
		assert.ok((await fresh.snapshotTail(id)) !== undefined);
	}
	assert.equal((await fresh.readKey("root-1", "k"))?.seq, 1);
	assert.equal((await fresh.getRun("root-1"))?.status, "completed");
	assert.equal(fresh.shardOf("legacy-root")?.kind, "adopted");
	assert.equal(fresh.shardOf("legacy-root")?.path, legacy);

	const resumed = await fresh.acquire("legacy-root", "resumer");
	assert.equal(resumed.status, "acquired", "an adopted run resumes in place");
	const before = await fresh.changeToken();
	if (resumed.status === "acquired")
		await fresh.append(resumed.lease, { type: "SummaryRecorded", payload: "resumed in place" });
	assert.notEqual(await fresh.changeToken(), before);
	const file = new DatabaseSync(legacy, { readOnly: true });
	assert.equal(
		file
			.prepare("SELECT count(*) AS n FROM wf_events WHERE run_id = 'legacy-root' AND type = 'SummaryRecorded'")
			.get()?.n,
		1,
	);
	file.close();
});

test("status, the resume catalog and fork reach roots on every shard and in adopted journals through one backend (#4325)", async () => {
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
	// Forks take full run ids (#4321).
	const LEGACY_ROOT = testRunId("legacy-root");
	const legacy = join(root, "campaign-journal-7", "journal.sqlite");
	await backendJournal(legacy, [LEGACY_ROOT]);
	const writer = await JournalDurableBackend.open(await openStore(), { ownsJournal: false });
	for (const workflowId of ["shard-root-a", "shard-root-b"]) {
		await writer.commitWorkflowRegistration({
			workflowId,
			name: "native",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		await writer.commitCheckpoint({
			kind: "tool",
			workflowId,
			checkpointId: "c0",
			name: "tool",
			argsHash: "a0",
			output: 0,
			completedAt: 2,
		});
	}
	await writer.close();
	await adoptJournals(store, [legacy]);

	const journal = await openStore();
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false, runs: [] });
	closing.push(() => backend.close());
	await backend.hydrateResumableWorkflows();
	const catalog = await backend.prepareWorkflowCatalog();
	assert.deepEqual([...(catalog.inspectableIds ?? [])].sort(), [LEGACY_ROOT, "shard-root-a", "shard-root-b"]);
	assert.deepEqual(
		[LEGACY_ROOT, "shard-root-a", "shard-root-b"].map((id) => journal.shardOf(id)?.kind),
		["adopted", "native", "native"],
	);
	assert.notEqual(journal.shardOf("shard-root-a")?.id, journal.shardOf("shard-root-b")?.id);
	for (const id of [LEGACY_ROOT, "shard-root-a"]) {
		await backend.hydrateWorkflow(id);
		assert.ok(backend.listCheckpoints(id).length >= 1, `${id} folds its checkpoints from its shard`);
	}
	const { runId: forked } = await forkDurableRun(backend, {
		source: "sdk",
		runId: LEGACY_ROOT,
		cwd: root,
		carryMessages: "all",
		definition: workflow({ name: "legacy", description: "", inputs: {}, outputs: {}, run: async () => ({}) }),
	});
	assert.equal(journal.shardOf(forked)?.kind, "native", "a fork of an adopted run is a new root on a native shard");
	assert.equal(backend.listCheckpoints(forked).length, backend.listCheckpoints(LEGACY_ROOT).length);
	const fresh = await JournalDurableBackend.open(await openStore(), { ownsJournal: false, runs: [] });
	closing.push(() => fresh.close());
	await fresh.hydrateResumableWorkflows();
	assert.ok((await fresh.prepareWorkflowCatalog()).inspectableIds?.includes(forked));
});

test("a run written into an adopted journal after adoption is found and indexed", async () => {
	const legacy = join(root, "live", "journal.sqlite");
	await backendJournal(legacy, ["before"]);
	await adoptJournals(store, [legacy]);
	await backendJournal(legacy, ["after"]);
	const journal = await openStore();
	assert.deepEqual(
		(await journal.listRuns()).map((run) => run.runId),
		["after", "before"],
	);
	assert.equal((await journal.getRun("after"))?.runId, "after");
	const catalog = await JournalCatalog.open(store);
	assert.equal((await catalog.locate("after"))?.shard.path, legacy);
	await catalog.close();
});

test("the store adopts the legacy default journal beside it and the journals its runs reference (#4325)", async () => {
	const legacyDefault = join(root, "workflows", "journal.sqlite");
	const referenced = join(root, "legacy-copy-2", "journal.sqlite");
	const missing = join(root, "legacy-copy-3", "journal.sqlite");
	await backendJournal(referenced, ["referenced-root"]);
	const sql = await openSqlRunJournal(legacyDefault);
	for (const [runId, location] of [
		["points-at-copy-2", referenced],
		["points-at-missing", missing],
	] as const)
		await sql.createRun({
			runId,
			name: "wf",
			cwd: "/p",
			createdAt: 1,
			status: "failed",
			storage: { adapter: "node-sqlite", location },
		});
	await sql.close();

	const journal = await openStore();
	assert.deepEqual(
		(await journal.listRuns()).map((run) => run.runId),
		["points-at-copy-2", "points-at-missing", "referenced-root"],
	);
	const catalog = await JournalCatalog.open(store);
	try {
		assert.deepEqual(
			(await catalog.shards()).map((shard) => [shard.path, shard.kind, shard.acceptsNewRoots]),
			[
				[legacyDefault, "adopted", false],
				[referenced, "adopted", false],
			],
		);
		assert.deepEqual(
			(await catalog.discoveries()).map((record) => [
				record.path,
				record.outcome,
				record.reason,
				record.referencedBy,
			]),
			[
				[referenced, "adopted", undefined, legacyDefault],
				[missing, "skipped", "path-not-found", legacyDefault],
				[legacyDefault, "adopted", undefined, undefined],
			],
		);
	} finally {
		await catalog.close();
	}
	const placed = await startRoot(journal, "new-root");
	assert.equal(journal.shardOf(placed.runId)?.kind, "native", "new roots never go to an adopted journal");
});

test("a sessions-only legacy file is recorded once as skipped and never adopted", async () => {
	mkdirSync(join(root, "workflows"), { recursive: true });
	const sessions = new DatabaseSync(join(root, "workflows", "journal.sqlite"));
	sessions.exec("CREATE TABLE session_entries(id TEXT)");
	sessions.close();
	await (await openStore()).close();
	await (await openStore()).close();
	const catalog = await JournalCatalog.open(store);
	assert.deepEqual(
		(await catalog.discoveries()).map((record) => [record.outcome, record.reason]),
		[["skipped", "not-a-journal"]],
	);
	assert.deepEqual(await catalog.shards(), []);
	await catalog.close();
});

test("a pool reserves its root's shard first, and the root is then created on exactly that shard", async () => {
	const journal = await openStore();
	await startRoot(journal, "busy");
	const poolJournal = await rootRunJournal(journal, "pooled-root");
	assert.ok(isLocalPoolJournal(poolJournal), "the pool shares the root's own SQLite shard as a local pool journal");
	const reserved = journal.shardOf("pooled-root")!;
	assert.equal(poolJournal.path, reserved.path);
	assert.notEqual(reserved.id, journal.shardOf("busy")!.id);
	await startRoot(journal, "pooled-root");
	assert.equal(journal.shardOf("pooled-root")!.id, reserved.id);
	assert.equal(await existingRootRunJournal(journal, "pooled-root"), poolJournal);
	assert.equal(await existingRootRunJournal(journal, "unknown-root"), journal, "a reader never reserves a shard");
	const sql = await openSqlRunJournal(join(root, "single.sqlite"));
	closing.push(() => sql.close());
	assert.equal(await rootRunJournal(sql, "any"), sql);
});

test("a status the catalog cannot record leaves the checkpoint committed, is reported, and is retried (#4325)", async () => {
	const journal = await openStore();
	const lease = await startRoot(journal, "root");
	const catalog = new DatabaseSync(join(store, "catalog.sqlite"));
	catalog.exec(
		"CREATE TRIGGER refuse BEFORE UPDATE OF status ON catalog_runs BEGIN SELECT RAISE(ABORT, 'catalog full'); END",
	);
	const outcome = await journal.append(lease, { type: "StatusChanged", payload: { status: "paused" } });
	assert.equal(outcome.status, "appended");
	assert.equal((await journal.getRun("root"))?.status, "paused");
	const backlog = journal.catalogBacklog();
	assert.equal(backlog.pending, 1);
	assert.ok(isJournalCatalogError(backlog.failure));
	assert.deepEqual(
		[backlog.failure.code, backlog.failure.phase, backlog.failure.runId],
		["write-failed", "recording-status", "root"],
	);
	catalog.exec("DROP TRIGGER refuse");
	catalog.close();
	await journal.append(lease, { type: "StatusChanged", payload: { status: "completed" } });
	assert.deepEqual(journal.catalogBacklog(), { pending: 0 });
	const reader = await JournalCatalog.open(store);
	assert.equal((await reader.locate("root"))?.run.status, "completed");
	await reader.close();
});

test("JournalShardUnavailableError: an adopted journal that is gone or unreadable fails its runs, typed, and listings skip it", async () => {
	const gone = join(root, "gone", "journal.sqlite");
	const broken = join(root, "broken", "journal.sqlite");
	await backendJournal(gone, ["gone-root"]);
	await backendJournal(broken, ["broken-root"]);
	await adoptJournals(store, [gone, broken]);
	rmSync(join(root, "gone"), { recursive: true, force: true });
	rmSync(broken, { force: true });
	rmSync(`${broken}-wal`, { force: true });
	rmSync(`${broken}-shm`, { force: true });
	writeFileSync(broken, "not a database ".repeat(400));
	const journal = await openStore();
	const missing = await journal.getRun("gone-root").catch((caught: Error) => caught);
	assert.ok(isJournalShardUnavailableError(missing));
	assert.deepEqual([missing.code, missing.shardPath, missing.runId], ["shard-missing", gone, "gone-root"]);
	const unreadable = await journal.getRun("broken-root").catch((caught: Error) => caught);
	assert.ok(isJournalShardUnavailableError(unreadable));
	assert.deepEqual([unreadable.code, unreadable.shardPath], ["shard-open-failed", broken]);
	assert.ok(unreadable.cause instanceof Error);
	assert.deepEqual(await journal.listRuns(), []);
	assert.deepEqual(
		journal
			.unavailableShards()
			.map((error) => error.code)
			.sort(),
		["shard-missing", "shard-open-failed"],
	);
});

test("a run this machine's local store does not hold fails fast with run-not-found and the join command (#4325)", async () => {
	const journal = await openStore();
	await startRoot(journal, "present");
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	closing.push(() => backend.close());
	let operations = 0;
	for (const method of [
		"getRun",
		"listRuns",
		"read",
		"snapshotTail",
		"runVersions",
		"changeToken",
		"acquire",
	] as const) {
		const original = (journal[method] as (...args: never[]) => unknown).bind(journal);
		Reflect.set(journal, method, (...args: never[]) => {
			operations++;
			return original(...args);
		});
	}
	const missingId = "0f1e2d3c-4b5a-4968-8776-655443322110";
	const inspection = await inspectTargetedDurableWorkflow(backend, missingId);
	assert.equal(inspection.kind, "absent");
	if (inspection.kind !== "absent") return;
	assert.ok(isJournalCatalogError(inspection.error));
	assert.equal(inspection.error.code, "run-not-found");
	assert.equal(inspection.error.runId, missingId);
	assert.equal(inspection.error.fields.localOnly, true);
	assert.equal(inspection.error.fields.selection, `journal store ${store}`);
	assert.ok(inspection.error.hint?.includes(SHARED_STORAGE_JOIN_HINT));
	assert.equal(inspection.message, `${inspection.error.message}\n${inspection.error.hint}`);
	assert.ok(operations <= 3, `failed after ${operations} journal operations`);
});
