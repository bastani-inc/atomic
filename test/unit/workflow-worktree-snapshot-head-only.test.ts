import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { captureWorktreeSnapshot, isWorkspaceDriftError, verifyWorktree, type WorktreeSnapshot } from "@bastani/atomic";
import { afterEach, beforeEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { RUN_EVENT_TYPES, type RunEvent } from "../../packages/workflows/src/durable/journal/types.js";
import { resolveWorkflowSnapshotFrontier } from "../../packages/workflows/src/durable/worktree-snapshots.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import {
	closeSnapshotJournals,
	openSqlSnapshotJournal,
	openSqlSnapshotJournalBackend,
} from "../helpers/workflow-snapshot-journal.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
let priorAgentDir: string | undefined;
beforeEach(() => {
	sandbox = new GitSandbox();
	priorAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = sandbox.path("agent");
});
afterEach(async () => {
	await closeSnapshotJournals();
	if (priorAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = priorAgentDir;
	sandbox.dispose();
});

const worktrees = (storeDir: string): string[] => {
	const dir = join(storeDir, "worktrees");
	return existsSync(dir) ? readdirSync(dir) : [];
};

test("verifyWorktree stays strict: a commit that only moves HEAD is still tree-drift with equal trees (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "x.txt"), "recorded\n");
	const capture = await captureWorktreeSnapshot(clone);
	assert.equal(capture.status, "captured");
	if (capture.status !== "captured") return;
	await sandbox.commitAll(clone, "commit the recorded edits");
	await assert.rejects(verifyWorktree(capture.snapshot, clone), (error: unknown) => {
		assert.ok(isWorkspaceDriftError(error));
		assert.equal(error.code, "tree-drift");
		assert.equal(error.expectedTree, error.actualTree);
		assert.notEqual(error.actualHead, error.expectedHead);
		return true;
	});
});

async function recordedFrontier(clone: string) {
	const fixture = await openSqlSnapshotJournal(sandbox.path("journal.sqlite"));
	const { journal } = fixture;
	await journal.createRun({ runId: "run", name: "run", cwd: clone, status: "running", createdAt: 1 });
	const acquired = await journal.acquire("run", "holder");
	if (acquired.status !== "acquired") throw new Error("lease not acquired");
	sandbox.write(join(clone, "state.txt"), "recorded\n");
	const capture = await captureWorktreeSnapshot(clone, { blobs: journal.snapshotBlobs });
	if (capture.status !== "captured") throw new Error("capture failed");
	await journal.append(acquired.lease, {
		type: RUN_EVENT_TYPES.checkpointRecorded,
		payload: { kind: "tool", checkpointId: "T1", worktreeSnapshots: [capture.snapshot] },
	} as unknown as RunEvent);
	return { fixture, snapshot: capture.snapshot as WorktreeSnapshot };
}

test("the frontier continues in place when the recorded edits were committed: no restore, no mapping, no new worktree (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const { fixture, snapshot } = await recordedFrontier(clone);
	await sandbox.commitAll(clone, "commit the recorded edits");
	const storeDir = sandbox.path("host");
	const mappings = await resolveWorkflowSnapshotFrontier(fixture.journal, "run", { storeDir });
	assert.deepEqual(mappings, []);
	assert.deepEqual(worktrees(storeDir), []);
	assert.equal(snapshot.tree, await sandbox.git(clone, "rev-parse", "HEAD^{tree}"));
	await fixture.close();
});

test("a real content edit after the capture still restores, even when HEAD also moved (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const { fixture } = await recordedFrontier(clone);
	await sandbox.commitAll(clone, "commit the recorded edits");
	sandbox.write(join(clone, "state.txt"), "edited after the commit\n");
	const storeDir = sandbox.path("host");
	const mappings = await resolveWorkflowSnapshotFrontier(fixture.journal, "run", { storeDir });
	assert.equal(mappings.length, 1);
	assert.equal(readFileSync(join(mappings[0]!.to, "state.txt"), "utf8"), "recorded\n");
	assert.equal(worktrees(storeDir).length, 1);
	await fixture.close();
});

test("the same tree on a commit that does not descend from the recorded HEAD is drift and restores (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const { fixture, snapshot } = await recordedFrontier(clone);
	await sandbox.git(clone, "add", "-A");
	const unrelated = await sandbox.git(clone, "commit-tree", snapshot.tree, "-m", "same tree, unrelated history");
	await sandbox.git(clone, "reset", "-q", "--hard", unrelated);
	const storeDir = sandbox.path("host");
	const mappings = await resolveWorkflowSnapshotFrontier(fixture.journal, "run", { storeDir });
	assert.equal(mappings.length, 1);
	assert.equal(await sandbox.git(mappings[0]!.to, "rev-parse", "HEAD"), snapshot.head);
	await fixture.close();
});

test("a resumed run whose recorded edits were committed continues in the user's checkout with no mapping (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	let attempt = 0;
	const observed: { cwd?: string } = {};
	const definition = workflow({
		name: "committed-edits",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("write", {}, async () => {
				sandbox.write(join(ctx.cwd!, "result.txt"), "correct\n");
				return "done";
			});
			if (attempt++ === 0) throw new Error("interrupted");
			observed.cwd = ctx.cwd;
			return {};
		},
	});
	const first = await run(definition, {}, { cwd: clone, durableBackend: fixture.backend, store: createStore() });
	assert.equal(first.status, "failed");
	await sandbox.commitAll(clone, "commit the recorded edits");
	const store = createStore();
	const second = await run(definition, {}, { runId: first.runId, cwd: clone, durableBackend: fixture.backend, store });
	assert.equal(second.status, "completed", second.error);
	assert.equal(observed.cwd, clone);
	assert.equal("worktreeRootMappings" in fixture.backend.getWorkflow(first.runId)!, false);
	assert.deepEqual(store.notices(), []);
	await fixture.close();
});
