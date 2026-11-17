import assert from "node:assert/strict";
import { type SessionStore, StorageProvider } from "@bastani/atomic/storage";
import { afterEach, test } from "vitest";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import type { PoolMutation } from "../../packages/workflows/src/durable/journal/pool-mutations.js";
import type { Store } from "../../packages/workflows/src/shared/store.js";
import { workerSessionStore } from "../../packages/workflows/src/workers/session-store.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/**
 * A pooled stage's session on a host that ships its checkpoints (#4768): the host acknowledges the stage's session
 * writes from its local journal, and the pool's session tables hold them only once they ship. The worker reads its own
 * writes from the tables, so a read of a session it wrote asks the pool to ship them first.
 */

useTemporaryAgentDir();

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

const RUN = { id: "child", name: "child", rootRunId: "root", parentRunId: "root", parentStageId: "boundary" };
const STAGE = { id: "stage", name: "agent", replayKey: "agent", parentIds: [], status: "running" };

/** The pool as the worker sees it: writes kept "locally" until `sync` ships them into the shared session tables. */
async function shippingPool() {
	const shared = await new StorageProvider().openSessionStore(
		{ kind: "database", database: await memoryDatabase(), prefix: "wf_runs_pool_" },
		{ agentDir: "", domain: "sessions" },
	);
	closers.push(() => shared.close());
	const held: PoolMutation[] = [];
	const syncs: (string | undefined)[] = [];
	/** Holds the next ship until the test lets it go. */
	const gate: { promise?: Promise<void> } = {};
	const lastSeqs = new Map<string, number>();
	const apply = async (mutation: PoolMutation) => {
		if (mutation.kind === "session-create") await shared.create(mutation.header, mutation.entries);
		else if (mutation.kind === "session-append")
			await shared.append(mutation.sessionId, mutation.entries, { expectSeq: mutation.expectSeq });
		else if (mutation.kind === "session-replace")
			await shared.replace(mutation.checkpoint.sessionId!, mutation.header, mutation.entries, {
				expectSeq: mutation.expectSeq,
			});
	};
	const worker = workerSessionStore({
		reader: shared,
		backend: {
			listCheckpoints: () => [
				{
					kind: "stage",
					checkpointId: "boundary-start:scope",
					topology: { boundary: { child: { runId: RUN.id }, replayScope: "scope" } },
				},
			],
			workflowAttempt: () => 0,
		} as unknown as DurableWorkflowBackend,
		store: { run: () => ({ ...RUN, stages: [STAGE] }) } as unknown as Store,
		root: "root",
		commit: async (mutation) => {
			held.push(mutation);
			if (mutation.kind === "checkpoint") return { at: 1, local: true };
			const id = mutation.kind === "session-append" ? mutation.sessionId : mutation.checkpoint.sessionId!;
			const entries = mutation.entries;
			const lastSeq = mutation.kind === "session-append" ? (lastSeqs.get(id) ?? 0) + entries.length : entries.length;
			lastSeqs.set(id, lastSeq);
			return { at: 1, local: true, lastSeq };
		},
		sync: async (sessionId) => {
			syncs.push(sessionId);
			await gate.promise;
			for (const mutation of held.splice(0)) await apply(mutation);
		},
	});
	return { shared, worker, held, syncs, gate };
}

async function memoryDatabase() {
	const { openNodeSqliteDatabase } = await import("@bastani/atomic/storage");
	const database = await openNodeSqliteDatabase(":memory:");
	closers.push(() => database.close());
	return database;
}

const header = (id: string) => ({
	id,
	version: 4 as const,
	createdAt: new Date(0).toISOString(),
	cwd: "/work",
	workflow: { runId: RUN.id, stageId: STAGE.id, stageName: STAGE.name },
});

test("a session the attempt wrote is read only after the pool ships its writes, and one it did not is read at once (#4768)", async () => {
	const pool = await shippingPool();
	await pool.shared.create({ ...header("earlier"), workflow: undefined } as never, []);
	await pool.worker.create(header("stage-session") as never, []);
	await pool.worker.append(
		"stage-session",
		[
			{
				type: "message",
				id: "prompt",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: { role: "user", content: "prompt", timestamp: 0 },
			},
		] as never,
		{ expectSeq: 0 },
	);
	assert.equal(await pool.shared.readHeader("stage-session"), undefined, "the pool's tables do not hold it yet");
	assert.equal((await pool.worker.readHeader("earlier"))?.id, "earlier");
	assert.deepEqual(pool.syncs, [], "a session the attempt did not write is read without shipping anything");
	const loaded = await pool.worker.load("stage-session");
	assert.deepEqual(
		loaded.entries.map((entry) => entry.id),
		["prompt"],
	);
	assert.deepEqual(pool.syncs, ["stage-session"]);
	await pool.worker.readHeader("stage-session");
	assert.deepEqual(pool.syncs, ["stage-session"], "once shipped, it is read without shipping again");
});

test("bounded history reads ship a pooled session's pending writes before reading its range (#5250)", async () => {
	const pool = await shippingPool();
	await pool.worker.create(header("stage-session"), []);
	await pool.worker.append(
		"stage-session",
		[
			{
				type: "message",
				id: "prompt",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: { role: "user", content: "prompt", timestamp: 0 },
			},
		],
		{ expectSeq: 0 },
	);
	const page = await pool.worker.readEntryRange!("stage-session", { fromSeq: 1, toSeq: 1 });
	assert.deepEqual(
		page.entries.map(({ entry }) => entry.id),
		["prompt"],
	);
	assert.deepEqual(pool.syncs, ["stage-session"]);
	await pool.worker.readEntryRange!("stage-session", { fromSeq: 1, toSeq: 1 });
	assert.deepEqual(pool.syncs, ["stage-session"], "a shipped session needs no second sync");
});

test("a blob of a session whose create the pool may not have shipped ships the create first, and only then (#4768)", async () => {
	const pool = await shippingPool();
	await pool.worker.create(header("stage-session") as never, []);
	const blob = await pool.worker.putBlob!("stage-session", new TextEncoder().encode("large output"));
	assert.deepEqual(pool.syncs, ["stage-session"], "the session's tables refuse a blob of a session they lack");
	assert.equal(new TextDecoder().decode((await pool.shared.getBlob!("stage-session", blob.hash))!), "large output");
	await pool.worker.append("stage-session", [], { expectSeq: 0 });
	await pool.worker.putBlob!("stage-session", new TextEncoder().encode("another"));
	assert.deepEqual(pool.syncs, ["stage-session"], "a session the tables hold takes blobs without shipping");
});

test("a write the pool acknowledges while a ship is in flight keeps its session marked for the next read (#4768)", async () => {
	const pool = await shippingPool();
	await pool.worker.create(header("stage-session") as never, []);
	const held = Promise.withResolvers<void>();
	pool.gate.promise = held.promise;
	const reading = pool.worker.load("stage-session");
	await pool.worker.append("stage-session", [], { expectSeq: 0 });
	held.resolve();
	await reading;
	pool.gate.promise = undefined;
	assert.equal(pool.syncs.length, 1);
	// The ship the read started may not have taken the append: the next read ships again.
	await pool.worker.load("stage-session");
	assert.equal(pool.syncs.length, 2);
	await pool.worker.load("stage-session");
	assert.equal(pool.syncs.length, 2, "and the one after it does not");
});

test("without a pool that ships, nothing is ever synced (#4768)", async () => {
	const shared = await new StorageProvider().openSessionStore(
		{ kind: "database", database: await memoryDatabase(), prefix: "wf_runs_pool_" },
		{ agentDir: "", domain: "sessions" },
	);
	closers.push(() => shared.close());
	const worker = workerSessionStore({
		reader: shared,
		backend: {} as DurableWorkflowBackend,
		store: {} as Store,
		root: "root",
		commit: async (mutation) => {
			assert.equal(mutation.kind, "session-append");
			return { at: 1, lastSeq: 1 };
		},
	});
	await shared.create({ ...header("s"), workflow: undefined } as never, []);
	await worker.append("s", [], { expectSeq: 0 });
	assert.equal((await worker.readHeader("s"))?.id, "s");
	void (worker satisfies SessionStore);
});
