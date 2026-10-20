import assert from "node:assert/strict";
import type { AgentSession, ExtensionContext, SessionEntry } from "@bastani/atomic";
import { afterEach, describe, test } from "vitest";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
	type SubagentChildRecordInput,
	type SubagentChildRecordSink,
	WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { quitAllRuns, quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { killRun, pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type {
	StageSessionCreateOptions,
	StageSessionRuntime,
} from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

type StageOrchestration = NonNullable<StageSessionCreateOptions["orchestrationContext"]>;

/** One stage session as the subagents extension in it sees it. */
interface StageProbe {
	readonly started: PromiseWithResolvers<void>;
	readonly released: PromiseWithResolvers<void>;
	readonly extensionState: Map<string, object>;
	/** The child records the stage session holds. */
	readonly entries: SessionEntry[];
	/** Children the stage launched and stopped before its prompt settles, recorded as its prompt starts. */
	children: readonly SubagentChildRecordInput[];
	/** The child-record sink a subagent launched in this stage records through. */
	sink?: SubagentChildRecordSink;
}

interface StageHarness {
	readonly store: ReturnType<typeof createStore>;
	readonly registry: ReturnType<typeof createStageControlRegistry>;
	readonly cancellation: ReturnType<typeof createCancellationRegistry>;
	readonly execution: ReturnType<typeof run>;
	readonly runId: string;
	stage(name: string): StageProbe;
}

afterEach(() => setDurableBackend(undefined));

/**
 * Prompts of stages in `failing` throw (the mapped error message, or `boom`); every other prompt waits until it is
 * released or the stage aborts it.
 */
async function startRun(
	define: WorkflowDefinition | ((stage: (name: string) => StageProbe) => WorkflowDefinition),
	failing: ReadonlySet<string> | ReadonlyMap<string, string> = new Set(),
): Promise<StageHarness> {
	const backend = await createMemoryTestBackend();
	setDurableBackend(backend);
	const store = createStore();
	const registry = createStageControlRegistry();
	const cancellation = createCancellationRegistry();
	const probes = new Map<string, StageProbe>();
	const probe = (name: string) => {
		let found = probes.get(name);
		if (!found) {
			found = {
				started: Promise.withResolvers<void>(),
				released: Promise.withResolvers<void>(),
				extensionState: new Map(),
				entries: [],
				children: [],
			};
			probes.set(name, found);
		}
		return found;
	};
	const create = async (options: StageSessionCreateOptions): Promise<StageSessionRuntime> => {
		const orchestration: StageOrchestration | undefined = options.orchestrationContext;
		assert.ok(orchestration?.kind === "workflow-stage");
		const name = orchestration.workflowStageName;
		const stage = probe(name);
		// As AgentSession does for a workflow stage: one admission, and one extension state, per stage generation.
		if (orchestration.messageAdmission === undefined)
			Object.assign(orchestration, {
				messageAdmission: {
					boundary: new WorkflowStageAdmissionBoundary(),
					extensionState: stage.extensionState,
					isOpen: () => true,
				},
			});
		const ctx: Pick<ExtensionContext, "sessionManager" | "orchestrationContext"> = {
			sessionManager: {
				getSessionId: () => `stage-${name}`,
				getEntries: () => stage.entries,
			} as unknown as ExtensionContext["sessionManager"],
			orchestrationContext: orchestration,
		};
		stage.sink = createSubagentChildRecordSink(
			{
				appendEntry: async (customType: string, data?: unknown) => {
					stage.entries.push({
						type: "custom",
						customType,
						data,
						id: crypto.randomUUID(),
						parentId: null,
						timestamp: new Date().toISOString(),
					} as SessionEntry);
				},
			},
			ctx,
		);
		const released = stage.released;
		let rejectPrompt: ((reason: Error) => void) | undefined;
		let streaming = false;
		const session: StageSessionRuntime = {
			async prompt() {
				streaming = true;
				for (const child of stage.children) stage.sink?.record(child);
				await stage.sink?.flushed?.();
				stage.started.resolve();
				try {
					if (failing.has(name)) throw new Error(failing instanceof Map ? (failing.get(name) ?? "boom") : "boom");
					await new Promise<void>((resolve, reject) => {
						rejectPrompt = reject;
						void released.promise.then(resolve);
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
		// The stage runner shares an AgentSession's orchestration context, and so its extension state, across the generation.
		return Object.assign(session, {
			modelRuntime: {},
			state: { messages: [] },
			sessionManager: {},
			getContextUsage: () => undefined,
			orchestrationContext: orchestration,
			// As AgentSession does: closing the generation closes its admission, which ends or keeps its children.
			closeWorkflowStageGeneration: () => orchestration.messageAdmission?.boundary.close(),
		});
	};
	const runId = `closed-for-good-${crypto.randomUUID()}`;
	const execution = run(
		typeof define === "function" ? define(probe) : define,
		{},
		{
			runId,
			store,
			stageControlRegistry: registry,
			cancellation,
			durableBackend: backend,
			adapters: { agentSession: { create } },
		},
	);
	return { store, registry, cancellation, execution, runId, stage: probe };
}

function singleStage(name: string): WorkflowDefinition {
	return workflow({
		name: `closed-for-good-${name}`,
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage(name).prompt("work");
			return {};
		},
	});
}

function closedForGood(stage: StageProbe): boolean {
	assert.ok(stage.sink, "the stage session was created");
	const ended = stage.sink.ownerEndedForGood?.() === true;
	assert.equal(
		ended,
		stage.extensionState.has(WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE),
		"the child-record sink reads the stage runner's shared extension state",
	);
	return ended;
}

describe("a workflow stage generation closing for good ends its subagent children (#3760)", () => {
	test("a finished stage closes for good", async () => {
		const h = await startRun(singleStage("done"));
		const stage = h.stage("done");
		await stage.started.promise;
		assert.equal(closedForGood(stage), false, "a running stage has not closed");
		stage.released.resolve();
		assert.equal((await h.execution).status, "completed");
		assert.equal(closedForGood(stage), true);
	});

	test("a failed stage closes for good", async () => {
		const h = await startRun(singleStage("broken"), new Set(["broken"]));
		assert.equal((await h.execution).status, "failed");
		assert.equal(closedForGood(h.stage("broken")), true);
	});

	test("a run ended by ctx.exit closes its live stage for good", async () => {
		const h = await startRun((stage) =>
			workflow({
				name: "closed-for-good-exit",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await Promise.all([
						ctx.stage("pending").prompt("work"),
						(async () => {
							await stage("pending").started.promise;
							return ctx.exit({ status: "skipped", reason: "done early" });
						})(),
					]);
					return {};
				},
			}),
		);
		assert.equal((await h.execution).status, "skipped");
		assert.equal(closedForGood(h.stage("pending")), true);
	});

	test("a parallel fail-fast skip closes the skipped stage for good", async () => {
		const h = await startRun(
			workflow({
				name: "closed-for-good-fail-fast",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.parallel(
						[
							{ name: "fast", prompt: "fail" },
							{ name: "hung", prompt: "hang" },
						],
						{ concurrency: 2 },
					);
					return {};
				},
			}),
			new Set(["fast"]),
		);
		assert.equal((await h.execution).status, "failed");
		const hung = h.store
			.runs()
			.find((snapshot) => snapshot.id === h.runId)
			?.stages.find((s) => s.name === "hung");
		assert.equal(hung?.skippedReason, "fail-fast");
		assert.equal(closedForGood(h.stage("hung")), true);
	});

	test("a killed run closes its live stage for good", async () => {
		const h = await startRun(singleStage("victim"));
		await h.stage("victim").started.promise;
		assert.equal((await killRun(h.runId, { store: h.store, cancellation: h.cancellation })).ok, true);
		assert.equal((await h.execution).status, "killed");
		assert.equal(closedForGood(h.stage("victim")), true);
	});

	test("a paused stage stays open, and closes for good only once it finishes after resume", async () => {
		const h = await startRun(singleStage("paused"));
		const stage = h.stage("paused");
		await stage.started.promise;
		assert.equal((await pauseRun(h.runId, { store: h.store, stageControlRegistry: h.registry })).ok, true);
		assert.equal(closedForGood(stage), false);
		assert.equal((await resumeRun(h.runId, { store: h.store, stageControlRegistry: h.registry })).ok, true);
		stage.released.resolve();
		assert.equal((await h.execution).status, "completed");
		assert.equal(closedForGood(stage), true);
	});

	test("a quit run leaves its stage open and resumable", async () => {
		const h = await startRun(singleStage("quit"));
		const stage = h.stage("quit");
		await stage.started.promise;
		assert.equal((await quitRun(h.runId, { store: h.store, stageControlRegistry: h.registry })).ok, true);
		assert.equal(closedForGood(stage), false);
		assert.equal((await resumeRun(h.runId, { store: h.store, stageControlRegistry: h.registry })).ok, true);
		stage.released.resolve();
		assert.equal((await h.execution).status, "completed");
	});

	test("an Atomic exit or session switch leaves the stage open and resumable", async () => {
		const h = await startRun(singleStage("exiting"));
		const stage = h.stage("exiting");
		await stage.started.promise;
		const handle = h.registry.run(h.runId).stages()[0];
		assert.ok(handle);
		// Atomic's session_shutdown and its /new, /resume and /fork switch handoff both quit every run, then clear control.
		const [quit] = await quitAllRuns({ store: h.store, stageControlRegistry: h.registry, awaitSettlement: true });
		assert.equal(quit?.ok, true);
		h.registry.clear();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(closedForGood(stage), false);
		assert.equal(h.store.runs().find((snapshot) => snapshot.id === h.runId)?.resumable, true);
		await handle.resume("continue");
		stage.released.resolve();
		assert.equal((await h.execution).status, "completed");
		await handle.dispose?.();
	});

	/** The latest terminal status of each child the stage recorded, by child id. */
	async function childStatuses(stage: StageProbe): Promise<Record<string, string | undefined>> {
		await new Promise<void>((resolve) => setImmediate(resolve));
		await stage.sink?.flushed?.();
		const latest = readSubagentChildRecords(stage.entries);
		return Object.fromEntries([...latest.values()].map((record) => [record.agent, record.terminalStatus]));
	}

	function stoppedChildren(): readonly SubagentChildRecordInput[] {
		const runId = `stage-child-${crypto.randomUUID().slice(0, 8)}`;
		return (["paused", "quit"] as const).map((status, index) => ({
			runId,
			index,
			agent: `${status}-child`,
			state: "terminal",
			cwd: "/tmp",
			terminalStatus: status,
		}));
	}

	test("a stage blocked by a recoverable failure keeps its paused and quit children resumable (#3784)", async () => {
		const h = await startRun(
			(stage) => {
				stage("limited").children = stoppedChildren();
				return singleStage("limited");
			},
			new Map([["limited", "HTTP 429 rate limit exceeded"]]),
		);
		await h.execution;
		const stored = h.store.runs().find((snapshot) => snapshot.id === h.runId);
		assert.equal(stored?.failureDisposition, "active_blocked", "the run stays blocked and resumable");
		assert.equal(stored?.resumable, true);
		const stage = h.stage("limited");
		assert.equal(closedForGood(stage), false);
		assert.deepEqual(await childStatuses(stage), { "paused-child": "paused", "quit-child": "quit" });
	});

	test("a stage that fails for good ends its paused and quit children (#3784)", async () => {
		const h = await startRun(
			(stage) => {
				stage("broken").children = stoppedChildren();
				return singleStage("broken");
			},
			new Set(["broken"]),
		);
		assert.equal((await h.execution).status, "failed");
		const stage = h.stage("broken");
		assert.equal(closedForGood(stage), true);
		assert.deepEqual(await childStatuses(stage), { "paused-child": "stage-closed", "quit-child": "stage-closed" });
	});
});
