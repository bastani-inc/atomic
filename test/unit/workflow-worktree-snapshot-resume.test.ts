import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { Type } from "typebox";
import { afterEach, beforeEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { listWorkflowSnapshotBoundaries } from "../../packages/workflows/src/durable/worktree-snapshots.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { closeSnapshotJournals, openSqlSnapshotJournalBackend } from "../helpers/workflow-snapshot-journal.js";
import { GitSandbox, loseSnapshotBlobs } from "../helpers/worktree-snapshot.js";

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

test("resuming a workflow restores its latest tree and runs live work in the mapped cwd (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const { journal, backend } = fixture;
	const store = createStore();
	const jobs = createJobTracker();
	let attempt = 0;
	let callbacks = 0;
	let resumedCwd = "";
	let contents = "";
	const definition = workflow({
		name: "workspace-resume",
		description: "",
		inputs: {},
		outputs: { ok: Type.Boolean() },
		run: async (ctx) => {
			for (const value of ["T1", "T2", "T3"]) {
				await ctx.tool(value, {}, async () => {
					callbacks++;
					sandbox.write(join(ctx.cwd!, "state.txt"), `${value}\n`);
					return value;
				});
			}
			if (attempt++ === 0) throw new Error("stop after checkpoints");
			resumedCwd = ctx.cwd!;
			contents = readFileSync(join(ctx.cwd!, "state.txt"), "utf8");
			return { ok: true };
		},
	});
	const first = await run(definition, {}, { cwd: clone, durableBackend: backend, store });
	assert.equal(first.status, "failed");
	assert.equal(callbacks, 3);
	sandbox.write(join(clone, "state.txt"), "drift\n");
	const resumed = await resumeDurableWorkflow(first.runId, {
		registry: createRegistry().register(definition),
		durableBackend: backend,
		baseRunOpts: { cwd: clone, store, durableBackend: backend },
		jobs,
	});
	assert.equal(resumed.ok, true);
	await jobs.get(first.runId)?.promise;
	assert.equal(callbacks, 3);
	assert.notEqual(resumedCwd, clone);
	assert.equal(contents, "T3\n");
	assert.equal(readFileSync(join(clone, "state.txt"), "utf8"), "drift\n");
	const mapping = backend.getWorkflow(first.runId)?.worktreeRootMappings?.at(-1);
	assert.equal(mapping?.from, clone);
	assert.equal(mapping?.tree, (await listWorkflowSnapshotBoundaries(journal, first.runId)).at(-1)?.snapshot.tree);
	assert.equal(mapping?.to, resumedCwd);
	await fixture.close();
});

test("another host resumes a workflow from shared journal blobs after the source checkout is removed (#4245)", async () => {
	const { clone, remote } = await sandbox.remoteWithClone("source", { "tracked.txt": "base\n" });
	const secondClone = sandbox.path("second");
	await sandbox.git(sandbox.root, "clone", "-q", remote, secondClone);
	sandbox.write(join(clone, "committed.txt"), "not pushed\n");
	await sandbox.commitAll(clone, "unpushed");
	const databasePath = sandbox.path("shared.sqlite");
	let database = await openNodeSqliteDatabase(databasePath);
	let journal = await SqlRunJournal.open(database);
	let backend = await JournalDurableBackend.open(journal, { runs: [] });
	const store = createStore();
	let runNumber = 0;
	let calls = 0;
	let restoredCwd = "";
	let restoredBytes: Buffer | undefined;
	const definition = workflow({
		name: "cross-host-snapshot",
		description: "",
		inputs: {},
		outputs: { ok: Type.Boolean() },
		run: async (ctx) => {
			await ctx.tool("write", {}, async () => {
				calls++;
				sandbox.write(join(ctx.cwd!, "tracked.txt"), "staged and unstaged\n");
				sandbox.write(join(ctx.cwd!, "binary.dat"), new Uint8Array([0, 3, 255, 7]));
				return "done";
			});
			if (runNumber++ === 0) throw new Error("interrupted");
			restoredCwd = ctx.cwd!;
			restoredBytes = readFileSync(join(ctx.cwd!, "binary.dat"));
			assert.equal(readFileSync(join(ctx.cwd!, "tracked.txt"), "utf8"), "staged and unstaged\n");
			assert.equal(readFileSync(join(ctx.cwd!, "committed.txt"), "utf8"), "not pushed\n");
			return { ok: true };
		},
	});
	const first = await run(definition, {}, { cwd: clone, durableBackend: backend, store });
	assert.equal(first.status, "failed");
	const boundary = (await listWorkflowSnapshotBoundaries(journal, first.runId)).at(-1)!;
	assert.ok(boundary.snapshot.bundle);
	const expectedBytes = readFileSync(join(clone, "binary.dat"));
	await backend.close();
	await database.close();
	rmSync(clone, { recursive: true, force: true });
	database = await openNodeSqliteDatabase(databasePath);
	journal = await SqlRunJournal.open(database);
	backend = await JournalDurableBackend.open(journal, { runs: [first.runId] });
	const jobs = createJobTracker();
	const resumed = await resumeDurableWorkflow(first.runId, {
		registry: createRegistry().register(definition),
		durableBackend: backend,
		baseRunOpts: { cwd: secondClone, store: createStore(), durableBackend: backend },
		jobs,
	});
	assert.equal(resumed.ok, true);
	await jobs.get(first.runId)?.promise;
	assert.equal(calls, 1);
	assert.deepEqual(restoredBytes, expectedBytes);
	assert.notEqual(restoredCwd, clone);
	assert.notEqual(restoredCwd, secondClone);
	assert.equal((await backend.getWorkflow(first.runId))?.worktreeRootMappings?.at(-1)?.tree, boundary.snapshot.tree);
	await backend.close();
	await database.close();
});

test("SDK runId reuse validates once and automatically restores before live code (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const { backend } = fixture;
	let calls = 0;
	let attempt = 0;
	let resumed = "";
	const definition = workflow({
		name: "direct-reuse",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("write", {}, async () => {
				calls++;
				sandbox.write(join(ctx.cwd!, "result.txt"), "correct\n");
				return "done";
			});
			if (attempt++ === 0) throw new Error("interrupted");
			resumed = ctx.cwd!;
			assert.equal(readFileSync(join(resumed, "result.txt"), "utf8"), "correct\n");
			return {};
		},
	});
	const first = await run(definition, {}, { cwd: clone, durableBackend: backend, store: createStore() });
	assert.equal(first.status, "failed");
	sandbox.write(join(clone, "result.txt"), "drift\n");
	const second = await run(
		definition,
		{},
		{ runId: first.runId, cwd: clone, durableBackend: backend, store: createStore() },
	);
	assert.equal(second.status, "completed");
	assert.equal(calls, 1);
	assert.notEqual(resumed, clone);
	assert.equal(backend.getWorkflow(first.runId)?.worktreeRootMappings?.at(-1)?.to, resumed);
	await fixture.close();
});

test("a resume whose change set is lost runs live code at the recorded commit without it (#4245, #4738)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const { journal, backend } = fixture;
	const store = createStore();
	let attempts = 0;
	const definition = workflow({
		name: "cannot-restore",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("write", {}, async () => {
				sandbox.write(join(ctx.cwd!, "changed.txt"), "expected\n");
				return "done";
			});
			attempts++;
			throw new Error("interrupted");
		},
	});
	const first = await run(definition, {}, { cwd: clone, durableBackend: backend, store });
	assert.equal(first.status, "failed");
	const snapshot = (await listWorkflowSnapshotBoundaries(journal, first.runId))[0]!.snapshot;
	const hash = snapshot.chain[0]!.patch!;
	await loseSnapshotBlobs(journal.snapshotBlobs, [hash]);
	sandbox.write(join(clone, "changed.txt"), "drift\n");
	const jobs = createJobTracker();
	const resumed = await resumeDurableWorkflow(first.runId, {
		registry: createRegistry().register(definition),
		durableBackend: backend,
		baseRunOpts: { cwd: clone, store, durableBackend: backend },
		jobs,
	});
	assert.equal(resumed.ok, true, resumed.ok ? "" : resumed.message);
	await jobs.get(first.runId)?.promise.catch(() => {});
	const mapping = backend.getWorkflow(first.runId)?.worktreeRootMappings?.at(-1);
	assert.equal(mapping?.degraded?.stage, "partial-changes");
	assert.equal(mapping?.degraded?.cause, "blob-missing");
	assert.equal(existsSync(join(mapping!.to, "changed.txt")), false);
	assert.equal(readFileSync(join(clone, "changed.txt"), "utf8"), "drift\n", "the checkout is never written to");
	assert.equal(attempts, 2, "live code ran again in the partly restored worktree");
	await fixture.close();
});
