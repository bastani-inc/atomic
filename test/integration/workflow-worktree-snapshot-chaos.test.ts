import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteDatabase, SqlSnapshotBlobStore } from "@bastani/atomic/storage";
import { Type } from "typebox";
import { test } from "vitest";
import { snapshotBlob, snapshotBlobHashes } from "../../packages/coding-agent/src/core/worktree-snapshot/index.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { listWorkflowSnapshotBoundaries } from "../../packages/workflows/src/durable/worktree-snapshots.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { bunExecutable, spawnProcess } from "../helpers/runtime.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

const REAL_PROCESS_TIMEOUT_MS = 120_000;

const CAPTURE_CHILD = `
import { openNodeSqliteDatabase } from "./packages/coding-agent/src/core/storage/node-sqlite.ts";
import { SqlSnapshotBlobStore } from "./packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import { captureWorktreeSnapshot } from "./packages/coding-agent/src/core/worktree-snapshot/capture.ts";
import { setWorktreeSnapshotGit } from "./packages/coding-agent/src/core/worktree-snapshot/git.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
setWorktreeSnapshotGit(async () => ({ path: "git", env: { GIT_CONFIG_GLOBAL: process.env.FIXTURE_GIT_CONFIG, GIT_CONFIG_NOSYSTEM: "1" } }));
const database = await openNodeSqliteDatabase(process.env.FIXTURE_DATABASE);
const blobs = await SqlSnapshotBlobStore.open(database);
writeFileSync(join(process.env.FIXTURE_REPO, "changed.txt"), "T2\\n");
await captureWorktreeSnapshot(process.env.FIXTURE_REPO, {
  previous: JSON.parse(process.env.FIXTURE_PREVIOUS),
  blobs: {
    getBlob: blobs.getBlob.bind(blobs),
    listBlobHashes: blobs.listBlobHashes.bind(blobs),
    deleteBlobs: blobs.deleteBlobs.bind(blobs),
    async putBlobs(values) {
      await blobs.putBlobs(values);
      process.stdout.write("BLOBS_STORED\\n");
      await new Promise(() => {});
    },
  },
});
`;

test(
	"SIGKILL between blob write and checkpoint publication leaves only resumable references (#4245)",
	async () => {
		const sandbox = new GitSandbox();
		const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
		process.env.ATOMIC_CODING_AGENT_DIR = sandbox.path("agent");
		let child: ReturnType<typeof spawnProcess> | undefined;
		let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>> | undefined;
		let backend: JournalDurableBackend | undefined;
		try {
			const { clone } = await sandbox.remoteWithClone();
			const databasePath = sandbox.path("shared.sqlite");
			database = await openNodeSqliteDatabase(databasePath);
			let journal = await SqlRunJournal.open(database);
			backend = await JournalDurableBackend.open(journal, { runs: [] });
			let attempt = 0;
			let calls = 0;
			let resumedCwd = "";
			const definition = workflow({
				name: "capture-crash",
				description: "",
				inputs: {},
				outputs: { ok: Type.Boolean() },
				run: async (ctx) => {
					await ctx.tool("write", {}, async () => {
						calls++;
						sandbox.write(join(ctx.cwd!, "changed.txt"), "T1\n");
						return "done";
					});
					if (attempt++ === 0) throw new Error("interrupted");
					resumedCwd = ctx.cwd!;
					assert.equal(readFileSync(join(ctx.cwd!, "changed.txt"), "utf8"), "T1\n");
					return { ok: true };
				},
			});
			const first = await run(definition, {}, { cwd: clone, durableBackend: backend, store: createStore() });
			assert.equal(first.status, "failed");
			const before = await listWorkflowSnapshotBoundaries(journal, first.runId);
			assert.equal(before.length, 1);
			await backend.close();
			backend = undefined;
			await database.close();
			database = undefined;
			child = spawnProcess([bunExecutable(), "-e", CAPTURE_CHILD], {
				cwd: process.cwd(),
				env: {
					...process.env,
					FIXTURE_GIT_CONFIG: sandbox.globalConfig,
					FIXTURE_DATABASE: databasePath,
					FIXTURE_REPO: clone,
					FIXTURE_PREVIOUS: JSON.stringify(before[0]!.snapshot),
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			assert.ok(child.stdout);
			const read = child.stdout.getReader();
			const message = await read.read();
			assert.equal(new TextDecoder().decode(message.value), "BLOBS_STORED\n");
			child.kill("SIGKILL");
			await child.exited;
			assert.equal(child.signalCode, "SIGKILL");
			child = undefined;
			database = await openNodeSqliteDatabase(databasePath);
			journal = await SqlRunJournal.open(database);
			backend = await JournalDurableBackend.open(journal, { runs: [first.runId] });
			const after = await listWorkflowSnapshotBoundaries(journal, first.runId);
			assert.equal(after.length, 1);
			assert.equal(after[0]!.checkpointId, before[0]!.checkpointId);
			for (const boundary of after) {
				for (const hash of snapshotBlobHashes(boundary.snapshot))
					assert.ok(await journal.snapshotBlobs.getBlob(hash));
			}
			const resumed = await run(
				definition,
				{},
				{ runId: first.runId, cwd: clone, durableBackend: backend, store: createStore() },
			);
			assert.equal(resumed.status, "completed");
			assert.equal(calls, 1);
			assert.notEqual(resumedCwd, clone);
			assert.equal(readFileSync(join(clone, "changed.txt"), "utf8"), "T2\n");
		} finally {
			if (child) {
				child.kill("SIGKILL");
				await child.exited;
			}
			await backend?.close();
			await database?.close();
			if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
			else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
			sandbox.dispose();
		}
	},
	REAL_PROCESS_TIMEOUT_MS,
);

test(
	"sixteen concurrent journal connections deduplicate overlapping snapshot blobs (#4245)",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "workflow-snapshot-contention-"));
		const connections = await Promise.all(
			Array.from({ length: 16 }, () => openNodeSqliteDatabase(join(directory, "shared.sqlite"))),
		);
		try {
			const stores = await Promise.all(connections.map((database) => SqlSnapshotBlobStore.open(database)));
			const blobs = Array.from({ length: 24 }, (_, index) =>
				snapshotBlob(new TextEncoder().encode(`blob-${index}`)),
			);
			await Promise.all(stores.map((store, index) => store.putBlobs(blobs.filter((_, n) => n % 2 === index % 2))));
			const hashes = await stores[0]!.listBlobHashes();
			assert.equal(hashes.length, blobs.length);
			assert.equal(new Set(hashes).size, blobs.length);
			for (const blob of blobs) assert.deepEqual(await stores[0]!.getBlob(blob.hash), blob.data);
		} finally {
			await Promise.all(connections.map((database) => database.close()));
			await rm(directory, { recursive: true, force: true });
		}
	},
	REAL_PROCESS_TIMEOUT_MS,
);
