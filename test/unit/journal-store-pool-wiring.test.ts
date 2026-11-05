import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JournalShardUnavailableError } from "@bastani/atomic/storage";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { ShardedRunJournal } from "../../packages/workflows/src/durable/journal/sharded-run-journal.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import { postMortemDepsForRun } from "../../packages/workflows/src/extension/postmortem-deps.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { admitWorkflowSessions } from "../../packages/workflows/src/workers/admission-binding.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { closeCoordinationJournals } from "../../packages/workflows/src/workers/pool-journal.js";
import { poolSessionStore } from "../../packages/workflows/src/workers/pool-session-store.js";
import { activatePublicPool } from "../../packages/workflows/src/workers/public-pool.js";
import { SqlResourceAdmission } from "../../packages/workflows/src/workers/resource-admission.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { configureTestStoreBackend } from "../helpers/store-backend.js";

type PoolOptions = ConstructorParameters<typeof LocalWorkerPool>[1];

const constructed = vi.hoisted(() => [] as PoolOptions[]);
vi.mock("../../packages/workflows/src/workers/local-pool.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../packages/workflows/src/workers/local-pool.js")>();
	class RecordingPool extends original.LocalWorkerPool {
		constructor(...args: ConstructorParameters<typeof original.LocalWorkerPool>) {
			constructed.push(args[1]);
			super(...args);
		}
	}
	return { ...original, LocalWorkerPool: RecordingPool };
});

const childPath = fileURLToPath(new URL("../fixtures/pool-child.ts", import.meta.url));

let directory: string;
let journal: ShardedRunJournal;
let backend: JournalDurableBackend;
beforeEach(async () => {
	directory = makeTempDirectory("journal-store-pool-wiring-");
	journal = await ShardedRunJournal.open({
		directory: join(directory, "journal"),
		openShard: (path) => openSqlRunJournal(path),
	});
	backend = await JournalDurableBackend.open(journal);
	constructed.length = 0;
});
afterEach(async () => {
	vi.restoreAllMocks();
	await backend.close();
	await closeCoordinationJournals();
	removeTempDirectory(directory);
});

async function root(runId: string): Promise<void> {
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: runId,
		inputs: {},
		createdAt: 0,
		status: "running",
	});
}

/** A running root whose pool already ran, so preparing a pool for it starts the pool's coordinator. */
async function pooledRoot(runId: string) {
	await root(runId);
	const owned = (await journal.leaseState(runId))!;
	const queue = await openSqlPoolQueue(await journal.journalFor(runId));
	await queue.initialize({ runId, holderId: owned.holderId!, epoch: owned.epoch }, 90_000);
	return journal.shardOf(runId)!;
}

function inProcessPool(options: Omit<PoolOptions, "workers" | "definitions" | "coordinator">): LocalWorkerPool {
	return new LocalWorkerPool(backend, { ...options, workers: 1, definitions: [], coordinator: "in-process" });
}

test.skipIf(process.platform === "win32")(
	"a pool whose root shard is gone fails with the coordinator's typed error, and no empty shard is created (#4325)",
	async () => {
		const shard = await pooledRoot("root");
		const pool = inProcessPool({ journalPath: shard.path, journalShard: shard.id });
		try {
			rmSync(shard.path);
			await assert.rejects(pool.prepare("root"), (error: Error) => {
				assert.ok(error instanceof JournalShardUnavailableError, String(error));
				assert.deepEqual(
					[error.code, error.shardId, error.shardPath, error.fields.runId],
					["shard-missing", shard.id, shard.path, "root"],
				);
				return true;
			});
			assert.equal(existsSync(shard.path), false);
		} finally {
			await pool.close();
		}
	},
);

test("a pool on its root's shard prepares, whether or not it names the shard (#4325)", async () => {
	const shard = await pooledRoot("root");
	for (const journalShard of [shard.id, undefined]) {
		const pool = inProcessPool({ journalPath: shard.path, ...(journalShard === undefined ? {} : { journalShard }) });
		try {
			await pool.prepare("root");
		} finally {
			await pool.close();
		}
	}
});

test.skipIf(process.platform === "win32")(
	"local workers on the journal store get their root's shard and its id; on a single file, no shard id (#4325)",
	async () => {
		const localWorkers = { count: 1, definitions: [{ path: childPath, exportName: "child" }] };
		const pool = await activatePublicPool(backend, { runId: "root", cwd: directory, localWorkers });
		await pool?.close();
		const shard = journal.shardOf("root")!;
		assert.deepEqual([constructed[0]?.journalPath, constructed[0]?.journalShard], [shard.path, shard.id]);

		const single = await JournalDurableBackend.open(
			await resolveRunJournal({ journal: { path: join(directory, "single.sqlite") } }),
		);
		try {
			const other = await activatePublicPool(single, { runId: "root", cwd: directory, localWorkers });
			await other?.close();
		} finally {
			await single.close();
		}
		assert.equal(constructed[1]?.journalPath, join(directory, "single.sqlite"));
		assert.equal("journalShard" in constructed[1]!, false);
	},
);

test("pooled stage sessions are read from the root's shard, for the root and for a child of it (#4325)", async () => {
	await pooledRoot("root-a");
	await root("root-b");
	assert.notEqual(journal.shardOf("root-a")!.id, journal.shardOf("root-b")!.id);
	const sessions = await poolSessionStore(backend, "root-a");
	assert.ok(sessions, "the root's shard holds its pool's session tables");
	await sessions.close();
	assert.equal(await poolSessionStore(backend, "root-b"), undefined, "another root's shard has none");
	assert.equal(await poolSessionStore({} as DurableWorkflowBackend, "root-a"), undefined, "no journal, no sessions");

	const runs = createStore();
	const viewing = {
		journal,
		getWorkflow: (runId: string) => (runId === "child" ? { rootWorkflowId: "root-a" } : undefined),
	} as unknown as DurableWorkflowBackend;
	configureTestStoreBackend(runs, viewing);
	const pooled = (runId: string) =>
		postMortemDepsForRun(runId, {
			adapters: {} as never,
			resolveDefaultStageSessionDir: () => undefined,
			store: runs,
		}).pooledSessionStore?.();
	const child = await pooled("child");
	assert.ok(child, "a child's post-mortem reads its root's shard");
	await child.close();
	assert.equal(await pooled("stranger"), undefined, "a run the store does not know has no pooled sessions");
});

test("resource admission for a root and for its child opens the root's shard under the root's id (#4325)", async () => {
	await root("root");
	const opened: { readonly journal: RunJournal; readonly root: string }[] = [];
	const captured = new Error("admission captured");
	vi.spyOn(SqlResourceAdmission, "open").mockImplementation(async (admissionJournal, options) => {
		opened.push({ journal: admissionJournal, root: options.root });
		throw captured;
	});
	for (const run of [{ runId: "root" }, { runId: "child", parentRun: { rootRunId: "root" } }])
		await assert.rejects(
			admitWorkflowSessions(backend, { ...run, admission: {} } as never, async () => assert.fail("admitted")),
			(error: Error) => error === captured,
		);
	const shard = await journal.journalFor("root");
	assert.deepEqual(
		opened.map((entry) => [entry.root, entry.journal === shard]),
		[
			["root", true],
			["root", true],
		],
	);
});
