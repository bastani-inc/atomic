import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captureWorktreeSnapshot, formatWorktreeRestoreNotice, formatWorktreeRestoreWarning } from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	completedWorkflowRunSnapshots,
	durableWorkflowRunSnapshots,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { listWorkflowSnapshotBoundaries } from "../../packages/workflows/src/durable/worktree-snapshots.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { openSqlSnapshotJournalBackend } from "../helpers/workflow-snapshot-journal.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
let priorAgentDir: string | undefined;
beforeEach(() => {
	sandbox = new GitSandbox();
	priorAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = sandbox.path("agent");
});
afterEach(() => {
	vi.restoreAllMocks();
	if (priorAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = priorAgentDir;
	sandbox.dispose();
});

/** A workflow whose first execution writes `result.txt` (and a denied file) in one tool and then fails. */
function interruptedWorkflow(observed: { cwd?: string; calls: number }) {
	let attempt = 0;
	return workflow({
		name: "interrupted",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("write", {}, async () => {
				observed.calls++;
				sandbox.write(join(ctx.cwd!, "result.txt"), "correct\n");
				sandbox.write(join(ctx.cwd!, ".env.local"), "secret\n");
				return "done";
			});
			if (attempt++ === 0) throw new Error("interrupted");
			observed.cwd = ctx.cwd;
			return {};
		},
	});
}

test("a rerun that restores a drifted worktree announces it through the run's notices, not the console (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const observed = { calls: 0 } as { cwd?: string; calls: number };
	const definition = interruptedWorkflow(observed);
	const first = await run(definition, {}, { cwd: clone, durableBackend: fixture.backend, store: createStore() });
	assert.equal(first.status, "failed");
	sandbox.write(join(clone, "result.txt"), "drift\n");
	const info = vi.spyOn(console, "info");
	const warn = vi.spyOn(console, "warn");
	const store = createStore();
	const second = await run(definition, {}, { runId: first.runId, cwd: clone, durableBackend: fixture.backend, store });
	assert.equal(second.status, "completed");
	assert.equal(observed.calls, 1, "the completed tool is replayed, not run again");
	const mapping = fixture.backend.getWorkflow(first.runId)?.worktreeRootMappings?.at(-1);
	assert.ok(mapping);
	assert.equal(observed.cwd, mapping.to);
	assert.equal(readFileSync(join(mapping.to, "result.txt"), "utf8"), "correct\n");
	const snapshot = (await listWorkflowSnapshotBoundaries(fixture.journal, first.runId)).at(-1)!.snapshot;
	assert.equal(mapping.snapshotId, snapshot.id);
	const notices = store.notices().filter((notice) => notice.runId === first.runId);
	assert.deepEqual(
		notices.map(({ id, level, message }) => ({ id, level, message })),
		[
			{
				id: `workflow-worktree-restore:${first.runId}:${snapshot.id}:${mapping.restoredAt}`,
				level: "info",
				message: formatWorktreeRestoreNotice(mapping),
			},
			{
				id: `workflow-worktree-restore-warning:${first.runId}:${snapshot.id}:${mapping.restoredAt}:0`,
				level: "warning",
				message: formatWorktreeRestoreWarning({ code: "omitted-content", omitted: snapshot.omitted }),
			},
		],
	);
	assert.ok(notices.every((notice) => typeof notice.createdAt === "number" && notice.createdAt > 0));
	assert.deepEqual(
		[...info.mock.calls, ...warn.mock.calls].filter((call) => /worktree/i.test(String(call[0]))),
		[],
	);
	await fixture.close();
});

test("a rerun verifies with the settings the run started with, and a clean rerun records no mapping (#4245)", async () => {
	for (const [index, rerunSnapshots] of [undefined, { includeUntracked: true }].entries()) {
		const { clone } = await sandbox.remoteWithClone(`repo-${index}`);
		sandbox.write(join(clone, "scratch.txt"), "untracked and excluded\n");
		const fixture = await openSqlSnapshotJournalBackend(sandbox.path(`journal-${index}.sqlite`));
		const observed = { calls: 0 } as { cwd?: string; calls: number };
		const definition = interruptedWorkflow(observed);
		const first = await run(
			definition,
			{},
			{
				cwd: clone,
				durableBackend: fixture.backend,
				store: createStore(),
				snapshots: { includeUntracked: false },
			},
		);
		assert.equal(first.status, "failed");
		const store = createStore();
		const second = await run(
			definition,
			{},
			{ runId: first.runId, cwd: clone, durableBackend: fixture.backend, store, snapshots: rerunSnapshots },
		);
		assert.equal(second.status, "completed");
		assert.equal(observed.cwd, clone, "the checkout still matches what the run recorded, so it continues in place");
		const persisted = rerunSnapshots ?? { includeUntracked: false };
		const handle = fixture.backend.getWorkflow(first.runId)!;
		assert.deepEqual(
			handle.snapshots,
			persisted,
			"a rerun without settings keeps the run's; one with settings replaces them",
		);
		assert.equal("worktreeRootMappings" in handle, false);
		const metadata = fixture.backend.toMetadata(first.runId)!;
		assert.deepEqual(metadata.snapshots, persisted);
		assert.equal("worktreeRootMappings" in metadata, false);
		const snapshot = store.run(first.runId)!;
		assert.equal("worktreeRootMappings" in snapshot, false);
		assert.deepEqual(store.notices(), []);
		await fixture.close();
	}
});

test("a restore is recorded on the run's handle, metadata and live snapshot, and the rerun continues from the original working directory's counterpart (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const otherCheckout = (await sandbox.remoteWithClone("other")).clone;
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const observed = { calls: 0 } as { cwd?: string; calls: number };
	const definition = interruptedWorkflow(observed);
	const first = await run(definition, {}, { cwd: clone, durableBackend: fixture.backend, store: createStore() });
	sandbox.write(join(clone, "result.txt"), "drift\n");
	const store = createStore();
	const second = await run(
		definition,
		{},
		{ runId: first.runId, cwd: otherCheckout, durableBackend: fixture.backend, store },
	);
	assert.equal(second.status, "completed");
	const handle = fixture.backend.getWorkflow(first.runId)!;
	const mappings = handle.worktreeRootMappings!;
	assert.equal(mappings.length, 1);
	assert.equal(mappings[0]!.from, clone);
	assert.equal(observed.cwd, mappings[0]!.to, "the run's own recorded directory, restored, replaces the caller's");
	assert.deepEqual(fixture.backend.toMetadata(first.runId)!.worktreeRootMappings, mappings);
	assert.equal(
		"snapshots" in fixture.backend.toMetadata(first.runId)!,
		false,
		"a run started without settings records none",
	);
	assert.deepEqual(store.run(first.runId)!.worktreeRootMappings, mappings);
	await fixture.close();
});

test("a second restore of the same checkout extends the recorded mappings and the run follows the newest (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	let attempt = 0;
	let finalCwd = "";
	const definition = workflow({
		name: "twice",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("write", {}, async () => {
				sandbox.write(join(ctx.cwd!, "result.txt"), "correct\n");
				return "done";
			});
			if (attempt++ < 2) throw new Error("interrupted");
			finalCwd = ctx.cwd!;
			return {};
		},
	});
	const first = await run(definition, {}, { cwd: clone, durableBackend: fixture.backend, store: createStore() });
	sandbox.write(join(clone, "result.txt"), "drift\n");
	const second = await run(
		definition,
		{},
		{ runId: first.runId, cwd: clone, durableBackend: fixture.backend, store: createStore() },
	);
	assert.equal(second.status, "failed");
	const firstMapping = fixture.backend.getWorkflow(first.runId)!.worktreeRootMappings!.at(-1)!;
	sandbox.write(join(firstMapping.to, "result.txt"), "drift again\n");
	const third = await run(
		definition,
		{},
		{ runId: first.runId, cwd: clone, durableBackend: fixture.backend, store: createStore() },
	);
	assert.equal(third.status, "completed");
	const mappings = fixture.backend.getWorkflow(first.runId)!.worktreeRootMappings!;
	assert.equal(mappings.length, 2);
	assert.deepEqual(mappings[0], firstMapping);
	assert.equal(mappings[1]!.from, clone, "a root restored again keeps the original root as its source");
	assert.notEqual(mappings[1]!.to, firstMapping.to);
	assert.equal(finalCwd, mappings[1]!.to);
	await fixture.close();
});

test("a run recorded without a working directory resumes with its mappings and no directory to translate (#4245)", async () => {
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const mapping = {
		from: sandbox.path("gone"),
		to: sandbox.path("restored"),
		snapshotId: "snapshot",
		tree: "tree",
		restoredAt: "2026-01-01T00:00:00.000Z",
	};
	await fixture.backend.commitWorkflowRegistration({
		workflowId: "recorded-elsewhere",
		name: "elsewhere",
		inputs: {},
		createdAt: 1,
		status: "failed",
		resumable: true,
		worktreeRootMappings: [mapping],
	});
	const store = createStore();
	const result = await run(
		workflow({
			name: "elsewhere",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("noop", {}, async () => "ok");
				return {};
			},
		}),
		{},
		{ runId: "recorded-elsewhere", durableBackend: fixture.backend, store, snapshots: { enabled: false } },
	);
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(store.run("recorded-elsewhere")!.worktreeRootMappings, [mapping]);
	await fixture.close();
});

test("after a restore, stages, tasks, chains and parallel steps authored against the old root run in the restored one (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone("repo", { "sub/a.txt": "a\n" });
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	let attempt = 0;
	const cwds = new Map<string, string | undefined>();
	const definition = workflow({
		name: "authored-against-old-root",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("write", {}, async () => {
				sandbox.write(join(ctx.cwd!, "result.txt"), "correct\n");
				return "done";
			});
			if (attempt++ === 0) throw new Error("interrupted");
			const sub = join(clone, "sub");
			await ctx.stage("plain", { cwd: sub }).prompt("p");
			await ctx.stage("default").prompt("p");
			await ctx.task("task", { prompt: "t", cwd: sub });
			await ctx.chain([{ name: "chained", prompt: "c", cwd: sub }]);
			await ctx.parallel([{ name: "parallel", prompt: "p", cwd: sub }]);
			return {};
		},
	});
	const adapters = {
		prompt: {
			prompt: async (_text: string, meta?: { stageName?: string; stageOptions?: { cwd?: string } }) => {
				cwds.set(meta!.stageName!, meta?.stageOptions?.cwd);
				return "done";
			},
		},
	};
	const first = await run(
		definition,
		{},
		{ cwd: clone, durableBackend: fixture.backend, store: createStore(), adapters },
	);
	sandbox.write(join(clone, "result.txt"), "drift\n");
	const rerunStore = createStore();
	const second = await run(
		definition,
		{},
		{ runId: first.runId, cwd: clone, durableBackend: fixture.backend, store: rerunStore, adapters },
	);
	assert.equal(second.status, "completed", second.error);
	assert.equal(
		rerunStore.run(first.runId)?.snapshotUnavailable,
		undefined,
		"a stage with no cwd adds no directory to capture",
	);
	const restored = fixture.backend.getWorkflow(first.runId)!.worktreeRootMappings!.at(-1)!.to;
	assert.deepEqual(Object.fromEntries(cwds), {
		plain: join(restored, "sub"),
		default: undefined,
		task: join(restored, "sub"),
		chained: join(restored, "sub"),
		parallel: join(restored, "sub"),
	});
	await fixture.close();
});

const stageAdapters = {
	prompt: {
		prompt: async (text: string, meta?: { stageName?: string; stageOptions?: { cwd?: string } }) => {
			if (text === "fail") throw new Error("the stage fails");
			if (meta?.stageOptions?.cwd !== undefined)
				sandbox.write(join(meta.stageOptions.cwd, `${meta.stageName}.txt`), "x\n");
			return "done";
		},
	},
};

test("only live completed stages are captured; a failed stage and a replayed one record no snapshot (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	let attempt = 0;
	const definition = workflow({
		name: "stages",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("done", { cwd: clone }).prompt("ok");
			await ctx
				.stage("bad", { cwd: clone })
				.prompt("fail")
				.catch(() => undefined);
			await ctx.tool("after", {}, async () => "ok");
			if (attempt++ === 0) throw new Error("interrupted");
			return {};
		},
	});
	const first = await run(
		definition,
		{},
		{ cwd: clone, durableBackend: fixture.backend, store: createStore(), adapters: stageAdapters },
	);
	const stageBoundaries = async () =>
		(await listWorkflowSnapshotBoundaries(fixture.journal, first.runId)).filter(
			(boundary) => boundary.kind === "stage",
		);
	const recorded = await stageBoundaries();
	assert.equal(recorded.length, 1, "one live completed stage, one snapshot");
	assert.ok(recorded[0]!.checkpointId.includes("done"));
	const done = first.stages.find((stage) => stage.name === "done");
	assert.equal(done?.snapshot?.tree, recorded[0]!.snapshot.tree);
	assert.equal(done?.snapshot?.id, recorded[0]!.snapshot.id);
	assert.equal(first.stages.find((stage) => stage.name === "bad")?.snapshot, undefined);

	const store = createStore();
	const second = await run(
		definition,
		{},
		{ runId: first.runId, cwd: clone, durableBackend: fixture.backend, store, adapters: stageAdapters },
	);
	assert.equal(second.status, "completed", second.error);
	assert.equal(
		(await stageBoundaries()).length,
		1,
		"the replayed stage is not captured again, the failed one still is not",
	);
	const replayed = second.stages.find((stage) => stage.name === "done");
	assert.equal(replayed?.replayed, true);
	assert.deepEqual(replayed?.snapshot, done?.snapshot, "a replayed stage keeps the snapshot it was recorded with");
	assert.equal("snapshot" in (second.stages.find((stage) => stage.name === "bad") ?? {}), false);
	await fixture.close();
});

test("a stage outside any repository completes without a snapshot (#4245)", async () => {
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const definition = workflow({
		name: "outside",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("outside").prompt("ok");
			return {};
		},
	});
	const result = await run(
		definition,
		{},
		{ cwd: sandbox.root, durableBackend: fixture.backend, store: createStore(), adapters: stageAdapters },
	);
	assert.equal(result.status, "completed", result.error);
	assert.equal(result.stages[0]?.snapshot, undefined);
	await fixture.close();
});

test("a completed task is captured in its own checkout as well as the workflow's, and records its topology (#4245)", async () => {
	const workflowRepo = await sandbox.remoteWithClone("workflow");
	const taskRepo = await sandbox.remoteWithClone("task");
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const definition = workflow({
		name: "tasks",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("remote", { prompt: "go", cwd: taskRepo.clone });
			await ctx.task("local", { prompt: "go" });
			return {};
		},
	});
	const result = await run(
		definition,
		{},
		{ cwd: workflowRepo.clone, durableBackend: fixture.backend, store: createStore(), adapters: stageAdapters },
	);
	assert.equal(result.status, "completed", result.error);
	const boundaries = (await listWorkflowSnapshotBoundaries(fixture.journal, result.runId)).filter(
		(boundary) => boundary.kind === "stage",
	);
	const roots = (name: string) =>
		boundaries
			.filter((boundary) => boundary.checkpointId.startsWith("task:") && boundary.checkpointId.includes(name))
			.map((boundary) => boundary.root)
			.sort();
	assert.deepEqual(roots("remote"), [taskRepo.clone, workflowRepo.clone].sort());
	assert.deepEqual(roots("local"), [workflowRepo.clone]);
	const checkpoints = fixture.backend.listCheckpoints(result.runId);
	for (const name of ["remote", "local"]) {
		const task = checkpoints.find(
			(checkpoint) =>
				checkpoint.kind === "stage" && checkpoint.checkpointId.includes(`task:`) && checkpoint.name === name,
		);
		assert.ok(task && task.kind === "stage", `task checkpoint for ${name}`);
		assert.ok(task.topology?.stageId, `${name} keeps the topology of the stage that ran it`);
	}
	await fixture.close();
});

function stageAndToolWorkflow(options: { cwd: string; attempts: { count: number } }) {
	return workflow({
		name: "history",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("done", { cwd: options.cwd }).prompt("ok");
			await ctx.tool("write", {}, async () => {
				sandbox.write(join(ctx.cwd!, "result.txt"), "correct\n");
				return "done";
			});
			if (options.attempts.count++ === 0) throw new Error("interrupted");
			return {};
		},
	});
}

test("historical views carry each stage's snapshot and the run's restore mappings (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const definition = stageAndToolWorkflow({ cwd: clone, attempts: { count: 0 } });
	const first = await run(
		definition,
		{},
		{ cwd: clone, durableBackend: fixture.backend, store: createStore(), adapters: stageAdapters },
	);
	sandbox.write(join(clone, "result.txt"), "drift\n");
	const second = await run(
		definition,
		{},
		{
			runId: first.runId,
			cwd: clone,
			durableBackend: fixture.backend,
			store: createStore(),
			adapters: stageAdapters,
		},
	);
	assert.equal(second.status, "completed", second.error);
	const handle = fixture.backend.getWorkflow(first.runId)!;
	const stageBoundary = (await listWorkflowSnapshotBoundaries(fixture.journal, first.runId)).find(
		(boundary) => boundary.kind === "stage",
	)!;
	const entry = fixture.backend.listCompletedWorkflows().find((candidate) => candidate.workflowId === first.runId)!;
	const completed = (await completedWorkflowRunSnapshots(fixture.backend, entry))[0]!;
	const durable = durableWorkflowRunSnapshots(fixture.backend, handle)[0]!;
	for (const view of [completed, durable]) {
		assert.deepEqual(view.worktreeRootMappings, handle.worktreeRootMappings);
		assert.equal(view.stages.find((stage) => stage.name === "done")?.snapshot?.tree, stageBoundary.snapshot.tree);
	}
	await fixture.close();
});

test("historical views of a run without snapshots show neither stage snapshots nor mappings (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const definition = stageAndToolWorkflow({ cwd: clone, attempts: { count: 1 } });
	const result = await run(
		definition,
		{},
		{
			cwd: clone,
			durableBackend: fixture.backend,
			store: createStore(),
			adapters: stageAdapters,
			snapshots: { enabled: false },
		},
	);
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(await listWorkflowSnapshotBoundaries(fixture.journal, result.runId), []);
	const handle = fixture.backend.getWorkflow(result.runId)!;
	const entry = fixture.backend.listCompletedWorkflows().find((candidate) => candidate.workflowId === result.runId)!;
	const completed = (await completedWorkflowRunSnapshots(fixture.backend, entry))[0]!;
	const durable = durableWorkflowRunSnapshots(fixture.backend, handle)[0]!;
	for (const view of [completed, durable]) {
		assert.equal("worktreeRootMappings" in view, false);
		const stage = view.stages.find((candidate) => candidate.name === "done")!;
		assert.equal("snapshot" in stage, false);
	}
	await fixture.close();
});

test("a rerun on a backend with no snapshot journal continues without checking a checkout (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const observed = { calls: 0 } as { cwd?: string; calls: number };
	const definition = interruptedWorkflow(observed);
	const first = await run(definition, {}, { cwd: clone, durableBackend: fixture.backend, store: createStore() });
	sandbox.write(join(clone, "result.txt"), "drift\n");
	const withoutJournal = new Proxy(fixture.backend, {
		get(target, key) {
			if (key === "snapshotJournal") return undefined;
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as typeof fixture.backend;
	const second = await run(
		definition,
		{},
		{ runId: first.runId, cwd: clone, durableBackend: withoutJournal, store: createStore() },
	);
	assert.equal(second.status, "completed", second.error);
	assert.equal(observed.cwd, clone, "nothing could be compared, so the run continues where it is");
	await fixture.close();
});

test("a root run holds its journal lease while it executes and releases it afterwards (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const runId = "d3b07384-d9a0-4c3f-a4e0-2b1c7a5f8e11";
	let duringRun: Awaited<ReturnType<typeof fixture.journal.leaseState>>;
	const definition = workflow({
		name: "leased",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("inspect", {}, async () => {
				duringRun = await fixture.journal.leaseState(runId);
				return "ok";
			});
			return {};
		},
	});
	const result = await run(
		definition,
		{},
		{ runId, cwd: clone, durableBackend: fixture.backend, store: createStore() },
	);
	assert.equal(result.status, "completed", result.error);
	assert.ok(duringRun?.holderId, "the lease is held while the workflow's code runs");
	assert.equal(await fixture.journal.leaseState(runId), undefined);
	await fixture.close();
});

test("a child workflow's tool checkpoints are captured into the root run's journal, and no other run's history is read (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const reads = new Set<string>();
	const real = fixture.journal;
	const counting = new Proxy(real, {
		get(target, key) {
			if (key === "read")
				return (runId: string, fromSeq?: number) => {
					reads.add(runId);
					return target.read(runId, fromSeq);
				};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const countingBackend = await JournalDurableBackend.open(counting, { runs: [] });
	const child = workflow({
		name: "child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("child-write", {}, async () => {
				sandbox.write(join(ctx.cwd!, "child.txt"), "child\n");
				return "done";
			});
			return {};
		},
	});
	const parent = workflow({
		name: "parent",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.workflow(child, {});
			return {};
		},
	});
	const result = await run(parent, {}, { cwd: clone, durableBackend: countingBackend, store: createStore() });
	assert.equal(result.status, "completed", result.error);
	const boundaries = await listWorkflowSnapshotBoundaries(real, result.runId);
	assert.ok(boundaries.some((boundary) => boundary.checkpointId.includes("child-write") || boundary.kind === "tool"));
	assert.deepEqual(
		[...reads].filter((runId) => runId !== result.runId),
		[],
	);
	await countingBackend.close();
	await fixture.database.close();
});

test("a finished run releases its snapshot chain, so a later run on the same journal starts from what the journal recorded (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	let attempt = 0;
	const definition = workflow({
		name: "chained",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool(`write-${attempt}`, {}, async () => {
				sandbox.write(join(ctx.cwd!, "state.txt"), attempt === 0 ? "attempt 0\n" : "rerun\n");
				return "done";
			});
			if (attempt++ === 0) throw new Error("interrupted");
			return {};
		},
	});
	const first = await run(definition, {}, { cwd: clone, durableBackend: fixture.backend, store: createStore() });
	const [recorded] = (await listWorkflowSnapshotBoundaries(fixture.journal, first.runId)).map(
		(entry) => entry.snapshot,
	);
	const external = await captureWorktreeSnapshot(clone, { blobs: fixture.journal.snapshotBlobs, previous: recorded });
	sandbox.write(join(clone, "state.txt"), "attempt 1\n");
	const elsewhere = await captureWorktreeSnapshot(clone, { blobs: fixture.journal.snapshotBlobs, previous: recorded });
	assert.equal(external.status === "unchanged" || external.status === "captured", true);
	assert.equal(elsewhere.status, "captured");
	if (elsewhere.status !== "captured") return;
	const acquired = await fixture.journal.acquire(first.runId, "elsewhere");
	assert.equal(acquired.status, "acquired");
	if (acquired.status !== "acquired") return;
	await fixture.journal.append(acquired.lease, {
		type: "CheckpointRecorded",
		payload: { kind: "tool", checkpointId: "recorded-elsewhere", worktreeSnapshots: [elsewhere.snapshot] },
	} as never);
	await fixture.journal.release(acquired.lease);
	const second = await run(
		definition,
		{},
		{ runId: first.runId, cwd: clone, durableBackend: fixture.backend, store: createStore() },
	);
	assert.equal(second.status, "completed", second.error);
	const boundaries = await listWorkflowSnapshotBoundaries(fixture.journal, first.runId);
	const resumed = boundaries.at(-1)!;
	assert.equal(resumed.snapshot.delta.base, elsewhere.snapshot.id);
	await fixture.close();
});
