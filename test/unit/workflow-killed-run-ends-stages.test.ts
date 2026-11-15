import assert from "node:assert/strict";
import type { AgentSession } from "@bastani/atomic";
import { afterEach, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { summarizeRunSnapshot } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { killRun, pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type {
	StageSessionCreateOptions,
	StageSessionRuntime,
} from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { _buildStageSnapshots } from "../../packages/workflows/src/shared/persistence-restore-helpers.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowDefinition, WorkflowPersistencePort } from "../../packages/workflows/src/shared/types.js";
import {
	closeMemoryTestBackends,
	createMemoryTestBackend,
	type MemoryJournalBackend,
} from "../helpers/workflow-journal.js";

afterEach(async () => {
	setDurableBackend(undefined);
	await closeMemoryTestBackends();
});

/** Stage sessions whose prompts wait until released or aborted; `started(name)` resolves once a stage prompts. */
function waitingSessions() {
	const started = new Map<string, PromiseWithResolvers<void>>();
	const released = new Map<string, PromiseWithResolvers<void>>();
	const slot = (map: Map<string, PromiseWithResolvers<void>>, name: string) => {
		let found = map.get(name);
		if (found === undefined) {
			found = Promise.withResolvers<void>();
			map.set(name, found);
		}
		return found;
	};
	const create = async (options: StageSessionCreateOptions): Promise<StageSessionRuntime> => {
		const orchestration = options.orchestrationContext;
		assert.ok(orchestration?.kind === "workflow-stage");
		const name = orchestration.workflowStageName;
		let rejectPrompt: ((reason: Error) => void) | undefined;
		let streaming = false;
		const session: StageSessionRuntime = {
			async prompt() {
				streaming = true;
				slot(started, name).resolve();
				try {
					await new Promise<void>((resolve, reject) => {
						rejectPrompt = reject;
						void slot(released, name).promise.then(resolve);
					});
				} finally {
					streaming = false;
				}
			},
			async steer() {},
			async followUp() {},
			subscribe: () => () => {},
			sessionFile: undefined,
			sessionId: `stage-${name}`,
			async setModel() {},
			setThinkingLevel() {},
			cycleModel: async () => undefined,
			cycleThinkingLevel: async () => undefined,
			agent: undefined as unknown as AgentSession["agent"],
			model: undefined,
			thinkingLevel: "medium",
			messages: [] as AgentSession["messages"],
			get isStreaming() {
				return streaming;
			},
			navigateTree: async () => ({ cancelled: false }),
			compact: (async () => ({})) as unknown as StageSessionRuntime["compact"],
			abortCompaction() {},
			async abort() {
				rejectPrompt?.(new Error("AbortError"));
			},
			dispose() {},
			getLastAssistantText: () => "done",
		};
		return Object.assign(session, {
			modelRuntime: {},
			state: { messages: [] },
			sessionManager: {},
			getContextUsage: () => undefined,
			orchestrationContext: orchestration,
		});
	};
	return {
		create,
		started: (name: string) => slot(started, name).promise,
		release: (name: string) => slot(released, name).resolve(),
	};
}

function recordingPersistence(): WorkflowPersistencePort & {
	readonly entries: Array<{ type: string; payload: Record<string, unknown> }>;
} {
	const entries: Array<{ type: string; payload: Record<string, unknown> }> = [];
	return {
		entries,
		appendEntry(type, payload) {
			entries.push({ type, payload: payload as Record<string, unknown> });
			return `entry-${entries.length}`;
		},
	};
}

const child = workflow({
	name: "killed-run-child",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await Promise.all([ctx.stage("C1").prompt("work"), ctx.stage("C2").prompt("work")]);
		return {};
	},
}) as WorkflowDefinition;

const parallelWithChild = workflow({
	name: "killed-run-parent",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await Promise.all([ctx.stage("A").prompt("work"), ctx.stage("B").prompt("work"), ctx.workflow(child, {})]);
		return {};
	},
}) as WorkflowDefinition;

const finishedThenRunning = workflow({
	name: "killed-run-finished-then-running",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.stage("first").prompt("work");
		await ctx.stage("second").prompt("work");
		return {};
	},
}) as WorkflowDefinition;

const sequential = workflow({
	name: "killed-run-sequential",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.stage("only").prompt("work");
		return {};
	},
}) as WorkflowDefinition;

/** The run and every run nested below it, as the store holds them. */
function runTree(store: Store, rootRunId: string): RunSnapshot[] {
	const tree = [store.run(rootRunId)].filter((snapshot) => snapshot !== undefined);
	for (let index = 0; index < tree.length; index++) tree.push(...store.childRuns(tree[index]!.id));
	return tree;
}

function stillRunningStages(store: Store, rootRunId: string): string[] {
	return runTree(store, rootRunId).flatMap((snapshot) =>
		snapshot.stages
			.filter((stage) => stage.status === "running" || stage.status === "awaiting_input")
			.map((stage) => `${snapshot.name}/${stage.name}`),
	);
}

/** Stage statuses a session restore rebuilds from the journaled entries of one run, by stage name. */
function replayedStageStatuses(
	persistence: ReturnType<typeof recordingPersistence>,
	snapshot: RunSnapshot,
): Record<string, string> {
	const entries = persistence.entries.map((entry, index) => ({
		id: `entry-${index}`,
		type: entry.type,
		payload: entry.payload as Parameters<typeof _buildStageSnapshots>[0][number]["payload"],
	}));
	return Object.fromEntries(
		_buildStageSnapshots(entries, snapshot.id).map((stage) => [stage.name, `${stage.status}: ${stage.error}`]),
	);
}

/** Terminal status the durable journal recorded for each stage of the root run, by stage name. */
function durableStageStatuses(backend: MemoryJournalBackend, runId: string): Record<string, string | undefined> {
	return Object.fromEntries(
		backend
			.listCheckpoints(runId)
			.flatMap((checkpoint) =>
				checkpoint.kind === "stage" ? [[checkpoint.name, checkpoint.topology?.status]] : [],
			),
	);
}

async function startDetached(def: WorkflowDefinition) {
	const backend = await createMemoryTestBackend();
	setDurableBackend(backend);
	const store = createStore();
	const cancellation = createCancellationRegistry();
	const jobs = createJobTracker();
	const stageControlRegistry = createStageControlRegistry();
	const persistence = recordingPersistence();
	const sessions = waitingSessions();
	const accepted = runDetached(
		def,
		{},
		{
			store,
			cancellation,
			jobs,
			stageControlRegistry,
			persistence,
			durableBackend: backend,
			adapters: { agentSession: { create: sessions.create } },
		},
	);
	const settled = async () => {
		await jobs.get(accepted.runId)?.promise.catch(() => {});
	};
	return { backend, store, cancellation, stageControlRegistry, persistence, sessions, runId: accepted.runId, settled };
}

describe("a run that ends killed ends its in-flight stages (#4875)", () => {
	test("killing a run ends its parallel stages and its nested child's stages, and status lists none active (#4875)", async () => {
		const h = await startDetached(parallelWithChild);
		await Promise.all(["A", "B", "C1", "C2"].map((name) => h.sessions.started(name)));

		assert.equal((await killRun(h.runId, { store: h.store, cancellation: h.cancellation })).ok, true);
		await h.settled();

		assert.equal(h.store.run(h.runId)?.status, "killed");
		const tree = runTree(h.store, h.runId);
		assert.equal(tree.length, 2, "the parent and its nested child");
		assert.deepEqual(stillRunningStages(h.store, h.runId), []);
		for (const snapshot of tree)
			for (const stage of snapshot.stages.filter((s) => ["A", "B", "C1", "C2"].includes(s.name)))
				assert.equal(stage.status, "failed", `${stage.name} ends failed`);
		for (const snapshot of tree) assert.deepEqual(summarizeRunSnapshot(snapshot).activeStages, []);
		const [parent, nested] = tree as [RunSnapshot, RunSnapshot];
		assert.deepEqual(
			{ ...replayedStageStatuses(h.persistence, parent), ...replayedStageStatuses(h.persistence, nested) },
			{
				A: "failed: workflow killed",
				B: "failed: workflow killed",
				"workflow:killed-run-child": "failed: workflow killed",
				C1: "failed: workflow killed",
				C2: "failed: workflow killed",
			},
		);
		const durable = durableStageStatuses(h.backend, h.runId);
		assert.equal(durable.A, "failed");
		assert.equal(durable.B, "failed");
	});

	test("killing a run keeps the stage it already finished completed and journals that end once (#4875)", async () => {
		const h = await startDetached(finishedThenRunning);
		h.sessions.release("first");
		await h.sessions.started("second");

		assert.equal((await killRun(h.runId, { store: h.store, cancellation: h.cancellation })).ok, true);
		await h.settled();

		const first = h.store.run(h.runId)?.stages.find((s) => s.name === "first");
		assert.equal(first?.status, "completed");
		assert.deepEqual(
			h.persistence.entries
				.filter((entry) => entry.type === "workflow.stage.end" && entry.payload.stageId === first?.id)
				.map((entry) => entry.payload.status),
			["completed"],
		);
		assert.deepEqual(replayedStageStatuses(h.persistence, h.store.run(h.runId)!), {
			first: "completed: undefined",
			second: "failed: workflow killed",
		});
	});

	test("killing a run with one sequential stage ends that stage and journals its end (#4875)", async () => {
		const h = await startDetached(sequential);
		await h.sessions.started("only");

		assert.equal((await killRun(h.runId, { store: h.store, cancellation: h.cancellation })).ok, true);
		await h.settled();

		const stage = h.store.run(h.runId)?.stages.find((s) => s.name === "only");
		assert.equal(stage?.status, "failed");
		assert.notEqual(stage?.endedAt, undefined);
		assert.deepEqual(replayedStageStatuses(h.persistence, h.store.run(h.runId)!), {
			only: "failed: workflow killed",
		});
		assert.equal(durableStageStatuses(h.backend, h.runId).only, "failed");
	});

	test("aborting the run() signal ends the in-flight stage (#4875)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		const store = createStore();
		const sessions = waitingSessions();
		const controller = new AbortController();
		const runId = `aborted-${crypto.randomUUID()}`;
		const persistence = recordingPersistence();
		const execution = run(
			sequential,
			{},
			{
				runId,
				store,
				persistence,
				signal: controller.signal,
				durableBackend: backend,
				adapters: { agentSession: { create: sessions.create } },
			},
		);
		await sessions.started("only");
		controller.abort(new Error("caller aborted"));
		const result = await execution;

		assert.equal(result.status, "killed");
		assert.deepEqual(stillRunningStages(store, runId), []);
		assert.equal(store.run(runId)?.stages[0]?.status, "failed");
		assert.deepEqual(replayedStageStatuses(persistence, store.run(runId)!), { only: "failed: workflow killed" });
		assert.equal(durableStageStatuses(backend, runId).only, "failed");
	});

	test("pausing a run leaves its stage resumable rather than ended (#4875)", async () => {
		const h = await startDetached(sequential);
		await h.sessions.started("only");

		assert.equal(
			(await pauseRun(h.runId, { store: h.store, stageControlRegistry: h.stageControlRegistry })).ok,
			true,
		);
		const paused = h.store.run(h.runId)?.stages.find((s) => s.name === "only");
		assert.notEqual(paused?.status, "failed");
		assert.equal(paused?.endedAt, undefined);

		assert.equal(
			(await resumeRun(h.runId, { store: h.store, stageControlRegistry: h.stageControlRegistry })).ok,
			true,
		);
		h.sessions.release("only");
		await h.settled();
		assert.equal(h.store.run(h.runId)?.status, "completed");
		assert.equal(h.store.run(h.runId)?.stages.find((s) => s.name === "only")?.status, "completed");
	});

	test("quitting a run keeps its stage resumable, and resume completes it (#4875)", async () => {
		const h = await startDetached(sequential);
		await h.sessions.started("only");

		assert.equal((await quitRun(h.runId, { store: h.store, stageControlRegistry: h.stageControlRegistry })).ok, true);
		assert.equal(h.store.run(h.runId)?.status, "paused");
		assert.notEqual(h.store.run(h.runId)?.stages.find((s) => s.name === "only")?.status, "failed");

		assert.equal(
			(await resumeRun(h.runId, { store: h.store, stageControlRegistry: h.stageControlRegistry })).ok,
			true,
		);
		h.sessions.release("only");
		await h.settled();
		assert.equal(h.store.run(h.runId)?.status, "completed");
	});
});
