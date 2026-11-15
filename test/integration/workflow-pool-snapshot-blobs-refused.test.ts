import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { snapshotBlobHashes } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.js";
import { restoreWorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/restore.js";
import type { WorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/types.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

const BUDGET = poolTestBudgetMs(2);

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => {
	vi.restoreAllMocks();
	sandbox.dispose();
});

/**
 * Runs one pooled child, on a real worker process, that changes a file of the root's checkout in one tool. Each of the
 * first `collections` checkpoint commits that carry a worktree snapshot finds the snapshot's blobs collected with no
 * grace window, as a collection that ran between the worker's capture and the coordinator's write would leave them.
 */
async function pooledChildWithCollections(collections: number) {
	const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "committed\n" });
	const path = sandbox.path("journal.sqlite");
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	const childPath = fileURLToPath(new URL("../fixtures/pool-snapshot-child.ts", import.meta.url));
	const child = await loadWorkerDefinition({
		path: childPath,
		exportName: "snapshotChild",
		digest: await definitionDigest(childPath),
	});
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: 1,
		definitions: [{ definition: child, path: childPath, exportName: "snapshotChild" }],
		coordinator: "in-process",
	});
	const commit = SqlPoolQueue.prototype.commit;
	let left = collections;
	let snapshotCommits = 0;
	/** The snapshots of each `edit` tool checkpoint the pool wrote, one list per checkpoint. */
	const written: WorktreeSnapshot[][] = [];
	vi.spyOn(SqlPoolQueue.prototype, "commit").mockImplementation(async function (
		this: SqlPoolQueue,
		lease,
		token,
		operation,
		mutation,
	) {
		const snapshots =
			mutation.kind === "checkpoint"
				? ((mutation.checkpoint as { worktreeSnapshots?: WorktreeSnapshot[] }).worktreeSnapshots ?? [])
				: [];
		if (snapshots.length > 0) {
			snapshotCommits++;
			if (left-- > 0) await collectSnapshotGarbage(journal.snapshotBlobs, { graceSeconds: 0 });
		}
		const receipt = await commit.call(this, lease, token, operation, mutation);
		if (mutation.kind === "checkpoint" && mutation.checkpoint.kind === "tool" && mutation.checkpoint.name === "edit")
			written.push(snapshots);
		return receipt;
	});
	const outcomes: string[] = [];
	const parent = workflow({
		name: "pool-snapshot-blobs-root",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			outcomes.push((await ctx.workflow(child, { inputs: { content: "edited by the child\n" } })).status);
			return {};
		},
	});
	const runId = randomUUID();
	try {
		const result = await run(
			parent,
			{},
			{
				runId,
				cwd: clone,
				store: createStore(),
				durableBackend: backend,
				signal: AbortSignal.timeout(BUDGET.waitMs),
			},
		);
		vi.restoreAllMocks();
		return { result, outcomes, written, snapshotCommits };
	} finally {
		vi.restoreAllMocks();
		await pool.close();
		await backend.close();
		// The journal closes its read-only connection to the file, which Windows cannot delete while it is open.
		await journal.close();
		await database.close();
	}
}

test(
	"a pooled child's checkpoint whose snapshot blobs were collected before the pool wrote it is written again with them, through the worker's real IPC (#5077)",
	async () => {
		const { result, outcomes, written, snapshotCommits } = await pooledChildWithCollections(1);
		assert.equal(result.status, "completed", JSON.stringify(result.error));
		assert.deepEqual(outcomes, ["completed"]);
		assert.equal(snapshotCommits, 2, "the refused checkpoint is sent once more, its blobs stored again");
		assert.equal(written.length, 1, "the tool's checkpoint is written once");
		const [snapshot] = written[0]!;
		assert.ok(snapshot, "with its snapshot");
		const database = await openNodeSqliteDatabase(sandbox.path("journal.sqlite"));
		const reopened = await SqlRunJournal.open(database);
		try {
			const stored = new Set(await reopened.snapshotBlobs.listBlobHashes());
			for (const hash of snapshotBlobHashes(snapshot)) assert.ok(stored.has(hash), hash);
			const restored = await restoreWorktreeSnapshot(snapshot, {
				blobs: reopened.snapshotBlobs,
				storeDir: sandbox.path("restores"),
			});
			assert.equal(readFileSync(join(restored, "a.txt"), "utf8"), "edited by the child\n");
		} finally {
			await reopened.close();
			await database.close();
		}
	},
	BUDGET.timeoutMs,
);

test(
	"a pooled child's checkpoint whose snapshot blobs are collected every time is committed without the snapshot, and the stage completes (#5077)",
	async () => {
		const { result, outcomes, written, snapshotCommits } = await pooledChildWithCollections(Number.POSITIVE_INFINITY);
		assert.equal(result.status, "completed", JSON.stringify(result.error));
		assert.deepEqual(outcomes, ["completed"], "the child's tool and the child complete");
		assert.equal(snapshotCommits, 3, "sent, sent again with its blobs, then captured once more and sent");
		assert.deepEqual(
			written,
			[[]],
			"the tool's checkpoint is written once, without the snapshot whose blobs are gone",
		);
	},
	BUDGET.timeoutMs,
);
