import assert from "node:assert/strict";
import { join } from "node:path";
import type { WorktreeRootMapping } from "@bastani/atomic";
import { afterEach, beforeEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { releaseDurableBackendsHeldBy } from "../../packages/workflows/src/durable/backend-process-owner.js";
import { recordCachedStageIntoStore } from "../../packages/workflows/src/durable/stage-primitive.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { createWorkflowSnapshotRecorder } from "../../packages/workflows/src/durable/worktree-snapshot-recorder.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
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
	if (priorAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = priorAgentDir;
	sandbox.dispose();
});

const mappingOf = (from: string, to: string): WorktreeRootMapping => ({
	from,
	to,
	snapshotId: "snap",
	tree: "tree",
	restoredAt: "2026-01-01T00:00:00Z",
});

test("a workflow registration lists restore mappings only when it has some, and a later registration keeps them (#4245)", async () => {
	const backend = await JournalTestBackend.create();
	const registration = { workflowId: "wf", name: "wf", inputs: {}, createdAt: 1, status: "running" as const };
	await backend.commitWorkflowRegistration(registration);
	assert.equal("worktreeRootMappings" in backend.getWorkflow("wf")!, false, "no mappings, no field");

	const mappings = [mappingOf("/old", "/new")];
	await backend.commitWorkflowRegistration({ ...registration, worktreeRootMappings: mappings });
	assert.deepEqual(backend.getWorkflow("wf")!.worktreeRootMappings, mappings);

	await backend.commitWorkflowRegistration({ ...registration, status: "completed" });
	assert.equal(backend.getWorkflow("wf")!.status, "completed");
	assert.deepEqual(
		backend.getWorkflow("wf")!.worktreeRootMappings,
		mappings,
		"a registration that does not mention mappings keeps the recorded ones",
	);

	const replaced = [mappingOf("/old", "/newer")];
	await backend.commitWorkflowRegistration({ ...registration, worktreeRootMappings: replaced });
	assert.deepEqual(backend.getWorkflow("wf")!.worktreeRootMappings, replaced);
});

test("a replayed stage with no recorded checkpoint appears without a snapshot (#4245)", () => {
	const store = createStore();
	store.recordRunStart({
		id: "run",
		name: "wf",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: Date.now(),
	});
	recordCachedStageIntoStore(store, "run", "replayed", "stage:replayed:1", "output", new Map());
	const stage = store.runs().find((candidate) => candidate.id === "run")!.stages[0]!;
	assert.equal(stage.name, "replayed");
	assert.equal(stage.replayed, true);
	assert.equal("snapshot" in stage, false);
});

const toolCheckpoint = (id: string): DurableToolCheckpoint => ({
	kind: "tool",
	workflowId: "run",
	checkpointId: id,
	name: id,
	argsHash: "hash",
	output: "ok",
	completedAt: 1,
});

test("a disabled run's checkpoints are not held up behind another recorder's capture of the same run (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const rootBackend = { snapshotJournal: fixture.journal } as unknown as DurableWorkflowBackend;
	let releaseEnabledCommit!: () => void;
	const enabledCommitGate = new Promise<void>((resolve) => {
		releaseEnabledCommit = resolve;
	});
	const committed: string[] = [];
	let enabledCommitStarted!: () => void;
	const enabledStarted = new Promise<void>((resolve) => {
		enabledCommitStarted = resolve;
	});
	const recorder = (settings: { enabled: boolean }, onCommit: (id: string) => Promise<void>) =>
		createWorkflowSnapshotRecorder({
			backend: {
				commitCheckpoint: async (checkpoint: DurableToolCheckpoint) => {
					await onCommit(checkpoint.checkpointId);
				},
			} as unknown as DurableWorkflowBackend,
			rootBackend,
			rootRunId: "shared-run",
			cwd: () => clone,
			settings,
			run: {} as RunSnapshot,
		});
	const enabled = recorder({ enabled: true }, async (id) => {
		enabledCommitStarted();
		await enabledCommitGate;
		committed.push(id);
	});
	const disabled = recorder({ enabled: false }, async (id) => {
		committed.push(id);
	});

	const slow = enabled(toolCheckpoint("enabled"));
	await enabledStarted;
	const quick = disabled(toolCheckpoint("disabled"));
	for (let turn = 0; turn < 20; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(
		committed,
		["disabled"],
		"the disabled checkpoint committed while the other capture was still open",
	);
	releaseEnabledCommit();
	assert.deepEqual(await quick, []);
	assert.equal((await slow).length, 1);
	assert.deepEqual(committed, ["disabled", "enabled"]);
	await fixture.close();
});

test("the extension runtime opens its journal once, however often the catalog is prepared (#4245)", async () => {
	let openings = 0;
	const store = createStore();
	try {
		const runtime = createExtensionRuntime({
			store,
			registry: createRegistry([]),
			journal: { memory: true },
			resolveStorageAgentDir: () => {
				openings++;
				return sandbox.path("agent");
			},
		});
		await runtime.prepareDurableCatalog!();
		await runtime.prepareDurableCatalog!();
		await runtime.prepareDurableCatalog!();
		assert.equal(openings, 1);
	} finally {
		await releaseDurableBackendsHeldBy(store);
	}
});

test("a nested run keeps the working directory it was given, and the root run alone applies recorded restore mappings (#4245)", async () => {
	const nested = await sandbox.remoteWithClone("nested");
	const elsewhere = await sandbox.remoteWithClone("elsewhere");
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const childId = "nested-run";
	await fixture.backend.commitWorkflowRegistration({
		workflowId: childId,
		name: "child",
		inputs: {},
		createdAt: 1,
		status: "running",
		worktreeRootMappings: [mappingOf(nested.clone, elsewhere.clone)],
	});
	let observedCwd: string | undefined;
	const child = workflow({
		name: "child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("observe", {}, async () => {
				observedCwd = ctx.cwd;
				return "ok";
			});
			return {};
		},
	});
	const result = await run(
		child,
		{},
		{
			runId: childId,
			cwd: nested.clone,
			durableBackend: fixture.backend,
			store: createStore(),
			parentRun: { runId: "root", stageId: "stage", rootRunId: "root" },
		},
	);
	assert.equal(result.status, "completed", result.error);
	assert.equal(observedCwd, nested.clone);
	await fixture.close();
});

test("a nested run does not release the lease held for its run id: only a root run's own execution does (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const childId = "nested-run";
	await fixture.backend.commitWorkflowRegistration({
		workflowId: childId,
		name: "child",
		inputs: {},
		createdAt: 1,
		status: "running",
	});
	const heldBefore = await fixture.journal.leaseState(childId);
	assert.ok(heldBefore?.holderId, "registering the run id takes its lease");
	const child = workflow({
		name: "child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("write", {}, async () => "ok");
			return {};
		},
	});
	const result = await run(
		child,
		{},
		{
			runId: childId,
			cwd: clone,
			durableBackend: fixture.backend,
			store: createStore(),
			parentRun: { runId: "root", stageId: "stage", rootRunId: "root" },
		},
	);
	assert.equal(result.status, "completed", result.error);
	assert.equal((await fixture.journal.leaseState(childId))?.holderId, heldBefore.holderId);
	await fixture.close();
});

test("a root run on a backend that is not a journal backend runs without a workflow lease (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	const foreign = new Proxy(fixture.backend, {
		getPrototypeOf: () => Object.prototype,
		get(target, key) {
			if (key === "withWorkflowLease") return undefined;
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as unknown as DurableWorkflowBackend;
	const definition = workflow({
		name: "foreign",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("write", {}, async () => {
				sandbox.write(join(ctx.cwd!, "state.txt"), "x\n");
				return "ok";
			});
			return {};
		},
	});
	const result = await run(definition, {}, { cwd: clone, durableBackend: foreign, store: createStore() });
	assert.equal(result.status, "completed", result.error);
	await fixture.close();
});

test("a stage's gitWorktreeDir naming the replaced checkout follows the restored worktree, so it cannot reuse the invoking checkout (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const fixture = await openSqlSnapshotJournalBackend(sandbox.path("journal.sqlite"));
	let attempt = 0;
	const stageErrors: string[] = [];
	const stagesRunIn: Array<string | undefined> = [];
	const definition = workflow({
		name: "reuses-checkout",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("write", {}, async () => {
				sandbox.write(join(ctx.cwd!, "result.txt"), "correct\n");
				return "done";
			});
			if (attempt++ === 0) throw new Error("interrupted");
			try {
				await ctx.stage("reuse", { gitWorktreeDir: clone }).prompt("go");
			} catch (error) {
				stageErrors.push((error as Error).message);
			}
			return {};
		},
	});
	const adapters = {
		prompt: {
			prompt: async (_text: string, meta?: { stageOptions?: { cwd?: string } }) => {
				stagesRunIn.push(meta?.stageOptions?.cwd);
				return "done";
			},
		},
	};
	const first = await run(
		definition,
		{},
		{ cwd: clone, durableBackend: fixture.backend, store: createStore(), adapters },
	);
	assert.equal(first.status, "failed");
	sandbox.write(join(clone, "result.txt"), "drift\n");
	const second = await run(
		definition,
		{},
		{ runId: first.runId, cwd: clone, durableBackend: fixture.backend, store: createStore(), adapters },
	);
	assert.equal(second.status, "completed", second.error);
	const restored = fixture.backend.getWorkflow(first.runId)!.worktreeRootMappings!.at(-1)!.to;
	assert.notEqual(restored, clone);
	assert.equal(stageErrors.length, 1);
	assert.match(stageErrors[0]!, /gitWorktreeDir must not resolve to the invoking checkout/);
	assert.deepEqual(stagesRunIn, [], "no stage ran, in the drifted checkout or anywhere else");
	await fixture.close();
});
