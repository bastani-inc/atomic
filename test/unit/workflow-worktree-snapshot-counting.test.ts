import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { restoreWorktreeSnapshot, setWorktreeSnapshotGit } from "@bastani/atomic";
import { Type } from "typebox";
import { afterEach, beforeEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { listWorkflowSnapshotBoundaries } from "../../packages/workflows/src/durable/worktree-snapshots.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

test("eight workflow boundaries share one base fetch and store deltas instead of eight bases (#4245)", async () => {
	const baseSize = 128 * 1024;
	const { clone } = await sandbox.remoteWithClone("repo", { "base.bin": Buffer.alloc(baseSize, 42) });
	const actual = new MemoryRunJournal();
	let ancestryReads = 0;
	let readsBeforeFirstCheckpoint = 0;
	const journal = new Proxy(actual, {
		get(target, key) {
			if (key === "read")
				return (runId: string, fromSeq?: number) => {
					if (fromSeq === undefined) ancestryReads++;
					return target.read(runId, fromSeq);
				};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const backend = await JournalDurableBackend.open(journal, { runs: [] });
	const definition = workflow({
		name: "count-deltas",
		description: "",
		inputs: {},
		outputs: { ok: Type.Boolean() },
		run: async (ctx) => {
			for (let index = 0; index < 8; index++) {
				await ctx.tool(`edit-${index}`, {}, async () => {
					if (index === 0) readsBeforeFirstCheckpoint = ancestryReads;
					sandbox.write(join(ctx.cwd!, "small.txt"), `change ${index}\n`);
					return index;
				});
			}
			return { ok: true };
		},
	});
	const result = await run(definition, {}, { cwd: clone, durableBackend: backend, store: createStore() });
	assert.equal(result.status, "completed");
	const captureReads = ancestryReads - readsBeforeFirstCheckpoint;
	assert.ok(captureReads <= 1, `snapshot ancestry read the root journal ${captureReads} times for eight checkpoints`);
	const boundaries = await listWorkflowSnapshotBoundaries(journal, result.runId);
	assert.equal(boundaries.length, 8);
	const hashes = await journal.snapshotBlobs.listBlobHashes();
	const totalBytes = (await Promise.all(hashes.map((hash) => journal.snapshotBlobs.getBlob(hash)))).reduce<number>(
		(sum, blob) => sum + (blob?.byteLength ?? 0),
		0,
	);
	assert.equal(hashes.length, 8);
	assert.ok(totalBytes < baseSize, `delta bytes ${totalBytes} should be smaller than one ${baseSize}-byte base`);
	const trace = sandbox.path("git-trace.jsonl");
	setWorktreeSnapshotGit(async () => ({
		...sandbox.executable,
		env: { ...sandbox.executable.env, GIT_TRACE2_EVENT: trace },
	}));
	for (const boundary of boundaries) {
		const restored = await restoreWorktreeSnapshot(boundary.snapshot, {
			blobs: journal.snapshotBlobs,
			storeDir: sandbox.path("host"),
		});
		assert.equal(readFileSync(join(restored, "small.txt"), "utf8"), `change ${boundaries.indexOf(boundary)}\n`);
	}
	const fetches = readFileSync(trace, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { event: string; argv?: string[] })
		.filter((event) => event.event === "start" && event.argv?.includes("fetch"));
	assert.equal(fetches.length, 1);
	await backend.close();
});
