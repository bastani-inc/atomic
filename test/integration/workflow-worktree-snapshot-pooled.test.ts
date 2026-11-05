import assert from "node:assert/strict";
import { snapshotBlobHashes } from "@bastani/atomic";
import { test } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { listWorkflowSnapshotBoundaries } from "../../packages/workflows/src/durable/worktree-snapshots.js";
import { createStore, loadWorkerWorkflow, run, workflow } from "../../packages/workflows/src/index.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

const REAL_WORKER_PROCESS_TIMEOUT_MS = 120_000;

const CHILD_DEFINITION = `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflow } from "@bastani/atomic/workflows";
export const child = workflow({
  name: "snapshot-pooled-child", description: "", inputs: {}, outputs: {},
  async run(ctx) {
    await ctx.tool("write-from-worker", {}, async () => {
      await writeFile(join(ctx.cwd, "worker-created.txt"), "worker content\\n");
      return "done";
    });
    return {};
  },
});
`;

test(
	process.platform === "win32"
		? "on Windows, local worker containment is refused, so pooled snapshots can't run (#4245)"
		: "pooled child persists its snapshot and blobs into the root journal (#4245)",
	async () => {
		const sandbox = new GitSandbox();
		let backend: JournalDurableBackend | undefined;
		try {
			const { clone } = await sandbox.remoteWithClone();
			const childPath = sandbox.path("child.ts");
			sandbox.write(childPath, CHILD_DEFINITION);
			const journalPath = sandbox.path("journal.sqlite");
			const journal = await resolveRunJournal({ journal: { path: journalPath } });
			backend = await JournalDurableBackend.open(journal, { runs: [] });
			const child = await loadWorkerWorkflow(childPath, "child");
			const parent = workflow({
				name: "snapshot-pooled-root",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					const result = await ctx.workflow(child);
					assert.equal(result.status, "completed");
					return {};
				},
			});
			const execute = () =>
				run(
					parent,
					{},
					{
						cwd: clone,
						durableBackend: backend,
						store: createStore(),
						localWorkers: { count: 1, definitions: [{ path: childPath, exportName: "child" }] },
						admission: { limits: { session: 1, process: 1 } },
					},
				);
			if (process.platform === "win32") {
				await assert.rejects(execute(), /Local worker containment is unavailable on Windows/);
				return;
			}
			const result = await execute();
			assert.equal(result.status, "completed", result.error);
			const boundaries = await listWorkflowSnapshotBoundaries(journal, result.runId);
			const worker = boundaries.find(
				(boundary) => boundary.kind === "tool" && boundary.checkpointId.includes("write"),
			);
			const workerBoundary = worker ?? boundaries.find((boundary) => boundary.kind === "tool");
			assert.ok(workerBoundary, "the worker's tool checkpoint has a snapshot");
			assert.equal(workerBoundary.root, clone);
			assert.notEqual(workerBoundary.checkpointId.indexOf("workflow:"), -1);
			assert.ok(journal.snapshotBlobs);
			for (const hash of snapshotBlobHashes(workerBoundary.snapshot)) {
				assert.ok(await journal.snapshotBlobs.getBlob(hash), `root journal blob ${hash} exists`);
			}
		} finally {
			await backend?.close();
			sandbox.dispose();
		}
	},
	REAL_WORKER_PROCESS_TIMEOUT_MS,
);
