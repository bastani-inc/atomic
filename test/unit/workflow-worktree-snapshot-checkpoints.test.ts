import assert from "node:assert/strict";
import { join } from "node:path";
import {
	captureWorktreeSnapshot,
	isGitUnavailableError,
	isWorkspaceConfigError,
	isWorkspaceSnapshotError,
	rehydrateWorkspaceError,
	setWorktreeSnapshotGit,
} from "@bastani/atomic";
import { Type } from "typebox";
import { afterEach, beforeEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { durableWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
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

test("completed workflow tool checkpoints carry their captured workspace and durable blobs (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const journal = new MemoryRunJournal();
	const backend = await JournalDurableBackend.open(journal, { runs: [] });
	const definition = workflow({
		name: "snapshot-tools",
		description: "",
		inputs: {},
		outputs: { ok: Type.Boolean() },
		run: async (ctx) => {
			await ctx.tool("write", {}, async () => {
				sandbox.write(join(ctx.cwd!, "a.txt"), "first\n");
				return "done";
			});
			await ctx.tool("edit", {}, async () => {
				sandbox.write(join(ctx.cwd!, "a.txt"), "second\n");
				return "done";
			});
			return { ok: true };
		},
	});
	const result = await run(definition, {}, { cwd: clone, durableBackend: backend, store: createStore() });
	assert.equal(result.status, "completed");
	const boundaries = await listWorkflowSnapshotBoundaries(journal, result.runId);
	assert.equal(boundaries.length, 2);
	assert.equal(boundaries[0]!.kind, "tool");
	assert.notEqual(boundaries[0]!.snapshot.tree, boundaries[1]!.snapshot.tree);
	assert.equal(boundaries[1]!.snapshot.delta.base, boundaries[0]!.snapshot.id);
	for (const boundary of boundaries) {
		for (const link of boundary.snapshot.chain) {
			if (link.patch) assert.ok(await journal.snapshotBlobs.getBlob(link.patch));
		}
	}
	await backend.close();
});

test("completed stages capture their own cwd as well as the workflow cwd (#4245)", async () => {
	const workflowRepo = await sandbox.remoteWithClone("workflow");
	const stageRepo = await sandbox.remoteWithClone("stage");
	const journal = new MemoryRunJournal();
	const backend = await JournalDurableBackend.open(journal, { runs: [] });
	const definition = workflow({
		name: "snapshot-stage",
		description: "",
		inputs: {},
		outputs: { ok: Type.Boolean() },
		run: async (ctx) => {
			await ctx.stage("edit", { cwd: stageRepo.clone }).prompt("edit");
			return { ok: true };
		},
	});
	const result = await run(
		definition,
		{},
		{
			cwd: workflowRepo.clone,
			durableBackend: backend,
			store: createStore(),
			adapters: {
				prompt: {
					prompt: async () => {
						sandbox.write(join(stageRepo.clone, "stage.txt"), "changed\n");
						return "done";
					},
				},
			},
		},
	);
	assert.equal(result.status, "completed");
	const boundaries = await listWorkflowSnapshotBoundaries(journal, result.runId);
	assert.deepEqual(
		new Set(boundaries.filter((boundary) => boundary.kind === "stage").map((boundary) => boundary.root)),
		new Set([workflowRepo.clone, stageRepo.clone]),
	);
	assert.equal(result.stages[0]?.snapshot?.root, stageRepo.clone);
	assert.equal(
		result.stages[0]?.snapshot?.tree,
		boundaries.find((boundary) => boundary.root === stageRepo.clone)?.snapshot.tree,
	);
	const handle = backend.getWorkflow(result.runId);
	assert.ok(handle);
	const historical = durableWorkflowRunSnapshots(backend, handle);
	assert.equal(historical[0]?.stages[0]?.snapshot?.tree, result.stages[0]?.snapshot?.tree);
	assert.equal(result.stages[0]?.snapshot?.omittedCount, 0);
	await backend.close();
});

test("missing Git degrades once without preventing completed tools (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const journal = new MemoryRunJournal();
	const backend = await JournalDurableBackend.open(journal, { runs: [] });
	const store = createStore();
	let resolutions = 0;
	setWorktreeSnapshotGit(async () => {
		resolutions++;
		return { path: sandbox.path("missing-git"), env: {} };
	});
	const definition = workflow({
		name: "missing-git",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("one", {}, async () => "done");
			await ctx.tool("two", {}, async () => "done");
			return {};
		},
	});
	const result = await run(definition, {}, { cwd: clone, durableBackend: backend, store });
	assert.equal(result.status, "completed");
	assert.equal(resolutions, 1);
	const reason = store.run(result.runId)?.snapshotUnavailable;
	assert.ok(reason);
	const error = rehydrateWorkspaceError(reason);
	assert.ok(isGitUnavailableError(error));
	assert.equal(error.code, "not-installed");
	assert.equal(error.executable, sandbox.path("missing-git"));
	assert.deepEqual(await listWorkflowSnapshotBoundaries(journal, result.runId), []);
	await backend.close();
});

test("a non-repository or journal without blob storage records a typed reason and keeps running (#4245)", async () => {
	for (const missingStorage of [false, true]) {
		const actual = new MemoryRunJournal();
		const journal = missingStorage
			? new Proxy(actual, {
					get(target, key) {
						if (key === "snapshotBlobs") return undefined;
						const value = Reflect.get(target, key, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				})
			: actual;
		const backend = await JournalDurableBackend.open(journal, { runs: [] });
		const store = createStore();
		const definition = workflow({
			name: "degrade",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("one", {}, async () => "done");
				return {};
			},
		});
		const result = await run(definition, {}, { cwd: sandbox.root, durableBackend: backend, store });
		assert.equal(result.status, "completed");
		const reason = store.run(result.runId)?.snapshotUnavailable;
		assert.ok(reason);
		const error = rehydrateWorkspaceError(reason);
		assert.ok(isWorkspaceSnapshotError(error));
		assert.equal(error.code, missingStorage ? "blob-store-unsupported" : "not-a-repository");
		await backend.close();
	}
});

test("parallel stages sharing a worktree select the last journal boundary (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const journal = new MemoryRunJournal();
	const backend = await JournalDurableBackend.open(journal, { runs: [] });
	const definition = workflow({
		name: "parallel-snapshots",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const first = ctx.stage("first");
			const second = ctx.stage("second");
			await Promise.all([first.prompt("a"), second.prompt("b")]);
			return {};
		},
	});
	const result = await run(
		definition,
		{},
		{
			cwd: clone,
			durableBackend: backend,
			store: createStore(),
			adapters: {
				prompt: {
					prompt: async (_text, meta) => {
						sandbox.write(join(clone, `${meta!.stageName}.txt`), `${meta!.stageName}\n`);
						return "done";
					},
				},
			},
		},
	);
	assert.equal(result.status, "completed");
	const boundaries = (await listWorkflowSnapshotBoundaries(journal, result.runId)).filter(
		(boundary) => boundary.kind === "stage",
	);
	assert.equal(boundaries.length, 2);
	assert.ok(boundaries[1]!.seq > boundaries[0]!.seq);
	const current = await captureWorktreeSnapshot(clone, { previous: boundaries[1]!.snapshot });
	assert.equal(current.status, "unchanged");
	await backend.close();
});

test("disabled snapshots and invalid RunOpts perform no Git work (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const journal = new MemoryRunJournal();
	const backend = await JournalDurableBackend.open(journal, { runs: [] });
	let resolutions = 0;
	setWorktreeSnapshotGit(async () => {
		resolutions++;
		return sandbox.executable;
	});
	const definition = workflow({
		name: "snapshot-setting",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("one", {}, async () => "done");
			return {};
		},
	});
	await assert.rejects(
		run(
			definition,
			{},
			{
				cwd: clone,
				durableBackend: backend,
				snapshots: { fullEvery: 0 },
			},
		),
		(error: unknown) =>
			isWorkspaceConfigError(error) &&
			error.code === "invalid-setting" &&
			error.source === "sdk" &&
			error.field === "snapshots.fullEvery",
	);
	assert.deepEqual(await journal.listRuns(), []);
	const result = await run(
		definition,
		{},
		{
			cwd: clone,
			durableBackend: backend,
			store: createStore(),
			snapshots: { enabled: false },
		},
	);
	assert.equal(result.status, "completed");
	assert.equal(resolutions, 0);
	assert.deepEqual(await listWorkflowSnapshotBoundaries(journal, result.runId), []);
	await backend.close();
});

test("a stage's allocated Git worktree is captured at completion (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const journal = new MemoryRunJournal();
	const backend = await JournalDurableBackend.open(journal, { runs: [] });
	let effectiveCwd = "";
	const definition = workflow({
		name: "snapshot-allocated-worktree",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("work", { gitWorktreeDir: sandbox.path("allocated") }).prompt("edit");
			return {};
		},
	});
	const result = await run(
		definition,
		{},
		{
			cwd: clone,
			durableBackend: backend,
			store: createStore(),
			adapters: {
				prompt: {
					prompt: async (_text, meta) => {
						effectiveCwd = meta?.stageOptions?.cwd ?? "";
						assert.ok(effectiveCwd);
						sandbox.write(join(effectiveCwd, "allocated.txt"), "worktree change\n");
						return "done";
					},
				},
			},
		},
	);
	assert.equal(result.status, "completed", result.error);
	const boundaries = await listWorkflowSnapshotBoundaries(journal, result.runId);
	assert.ok(boundaries.some((boundary) => boundary.root === effectiveCwd));
	assert.equal(result.stages[0]?.snapshot?.root, effectiveCwd);
	await backend.close();
});
