import assert from "node:assert/strict";
import type { AgentSession } from "@bastani/atomic";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import type { DurableWorkflowStatus } from "../../packages/workflows/src/durable/types.js";
import {
	createToolControlRegistry,
	TOOL_QUIT_SETTLEMENT_TIMEOUT_MS,
} from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { quitAllRuns, quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import {
	createStageControlRegistry,
	type StageControlHandle,
	type StageControlStatus,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

function stageHandle(input: {
	runId: string;
	stageId: string;
	pause: () => Promise<void>;
	resume?: () => Promise<undefined>;
	status: () => StageControlStatus;
}): StageControlHandle {
	return {
		runId: input.runId,
		stageId: input.stageId,
		stageName: input.stageId,
		get status() {
			return input.status();
		},
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: false,
		messages: [] as AgentSession["messages"],
		async ensureAttached() {},
		async prompt() {},
		async steer() {},
		async followUp() {},
		pause: input.pause,
		resume: input.resume ?? (async () => undefined),
		subscribe: () => () => {},
	};
}

function productionSession(overrides: Partial<StageSessionRuntime>): StageSessionRuntime {
	return {
		async prompt() {},
		async steer() {},
		async followUp() {},
		subscribe: () => () => {},
		sessionFile: "/tmp/background-quit-production.jsonl",
		sessionId: "background-quit-production",
		async setModel() {},
		setThinkingLevel() {},
		cycleModel: async () => undefined,
		cycleThinkingLevel: () => undefined,
		agent: undefined as unknown as AgentSession["agent"],
		model: undefined as AgentSession["model"],
		thinkingLevel: "medium",
		messages: [] as AgentSession["messages"],
		isStreaming: false,
		navigateTree: async () => ({ cancelled: false }),
		compact: async () => ({}),
		abortCompaction() {},
		async abort() {},
		dispose() {},
		getLastAssistantText: () => "done",
		...overrides,
	} as StageSessionRuntime;
}

afterEach(() => setDurableBackend(undefined));

describe("graceful workflow quit acknowledgement", () => {
	test("between stages reports no controllable stage instead of claiming resumable pause", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const betweenStages = Promise.withResolvers<void>();
		const releaseWorkflow = Promise.withResolvers<void>();
		const runId = "quit-between-stages";
		const definition = workflow({
			name: "quit-between-stages",
			description: "",
			inputs: {},
			outputs: { done: Type.Boolean() },
			run: async (ctx) => {
				await ctx.stage("first").prompt("first");
				betweenStages.resolve();
				await releaseWorkflow.promise;
				await ctx.stage("second").prompt("second");
				return { done: true };
			},
		});

		const execution = run(
			definition,
			{},
			{
				runId,
				store,
				stageControlRegistry: registry,
				durableBackend: backend,
				adapters: { prompt: { prompt: async (text) => `done:${text}` } },
			},
		);
		await betweenStages.promise;
		assert.equal(registry.run(runId).stages().length, 0);

		const result = await quitRun(runId, { store, stageControlRegistry: registry });

		assert.deepEqual(result, { ok: false, runId, reason: "no_active_stages" });
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "running");
		assert.equal(backend.getWorkflow(runId)?.status, "running");

		releaseWorkflow.resolve();
		assert.equal((await execution).status, "completed");
	});

	test("same-run quit settles every stage pause and aggregates stage-specific failures", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const secondAcknowledgement = Promise.withResolvers<void>();
		const runId = "quit-rejected-pause";
		let secondPauseCalls = 0;
		let secondPauseSettled = false;
		store.recordRunStart({ id: runId, name: "reject", inputs: {}, status: "running", stages: [], startedAt: 1 });
		for (const stageId of ["stage-reject", "stage-late"]) {
			store.recordStageStart(runId, {
				id: stageId,
				name: stageId,
				status: "running",
				parentIds: [],
				toolEvents: [],
			});
		}
		backend.registerWorkflow({ workflowId: runId, name: "reject", inputs: {}, createdAt: 1, status: "running" });
		registry.register(
			stageHandle({
				runId,
				stageId: "stage-reject",
				status: () => "running",
				pause: async () => {
					throw new Error("first pause rejected");
				},
			}),
		);
		registry.register(
			stageHandle({
				runId,
				stageId: "stage-late",
				status: () => "running",
				pause: async () => {
					secondPauseCalls += 1;
					await secondAcknowledgement.promise;
					secondPauseSettled = true;
				},
			}),
		);

		let quitSettled = false;
		const quitting = quitRun(runId, { store, stageControlRegistry: registry })
			.then(
				() => undefined,
				(error: unknown) => error,
			)
			.finally(() => {
				quitSettled = true;
			});
		await Promise.resolve();
		await Promise.resolve();
		const settledBeforeSecondAcknowledgement = quitSettled;
		const secondPauseCallsBeforeAcknowledgement = secondPauseCalls;
		secondAcknowledgement.resolve();
		const failure = await quitting;

		assert.equal(settledBeforeSecondAcknowledgement, false, "quit must await every same-run stage");
		assert.equal(secondPauseCallsBeforeAcknowledgement, 1, "quit must attempt the sibling after a rejection");
		assert.equal(secondPauseSettled, true);
		assert.match(failure instanceof Error ? failure.message : String(failure), /stage-reject.*first pause rejected/);
		const run = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(run?.status, "running");
		assert.equal(run?.exitReason, undefined);
		assert.equal(run?.resumable, undefined);
		assert.equal(backend.getWorkflow(runId)?.status, "running");
	});

	test("successful quit waits for pause acknowledgement and remains resumable", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const pauseAcknowledged = Promise.withResolvers<void>();
		const runId = "quit-acknowledged";
		let status: StageControlStatus = "running";
		store.recordRunStart({ id: runId, name: "ack", inputs: {}, status: "running", stages: [], startedAt: 1 });
		store.recordStageStart(runId, { id: "stage-1", name: "stage", status: "running", parentIds: [], toolEvents: [] });
		backend.registerWorkflow({ workflowId: runId, name: "ack", inputs: {}, createdAt: 1, status: "running" });
		registry.register(
			stageHandle({
				runId,
				stageId: "stage-1",
				status: () => status,
				pause: async () => {
					await pauseAcknowledged.promise;
					status = "paused";
				},
				resume: async () => {
					status = "running";
					return undefined;
				},
			}),
		);

		let settled = false;
		const quitting = quitRun(runId, { store, stageControlRegistry: registry }).finally(() => {
			settled = true;
		});
		await Promise.resolve();
		assert.equal(settled, false);
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "running");
		assert.equal(backend.getWorkflow(runId)?.status, "running");

		pauseAcknowledged.resolve();
		const result = await quitting;
		assert.equal(result.ok, true);
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "paused");
		assert.equal(backend.getWorkflow(runId)?.status, "paused");

		const resumed = await resumeRun(runId, { store, stageControlRegistry: registry });
		assert.equal(resumed.ok, true);
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "running");
	});

	test("bulk quit settles fast rejection and late acknowledgement with per-run reasons", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const lateAcknowledgement = Promise.withResolvers<void>();
		let lateStatus: StageControlStatus = "running";
		for (const runId of ["quit-reject-fast", "quit-ack-late"]) {
			store.recordRunStart({ id: runId, name: runId, inputs: {}, status: "running", stages: [], startedAt: 1 });
			store.recordStageStart(runId, {
				id: `${runId}-stage`,
				name: "stage",
				status: "running",
				parentIds: [],
				toolEvents: [],
			});
			backend.registerWorkflow({ workflowId: runId, name: runId, inputs: {}, createdAt: 1, status: "running" });
		}
		registry.register(
			stageHandle({
				runId: "quit-reject-fast",
				stageId: "quit-reject-fast-stage",
				status: () => "running",
				pause: async () => {
					throw new Error("pause failed fast");
				},
			}),
		);
		registry.register(
			stageHandle({
				runId: "quit-ack-late",
				stageId: "quit-ack-late-stage",
				status: () => lateStatus,
				pause: async () => {
					await lateAcknowledgement.promise;
					lateStatus = "paused";
				},
			}),
		);

		let settled = false;
		const quitting = quitAllRuns({ store, stageControlRegistry: registry }).finally(() => {
			settled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		const settledBeforeLateAcknowledgement = settled;
		lateAcknowledgement.resolve();

		let results: Awaited<ReturnType<typeof quitAllRuns>> | undefined;
		let failure: unknown;
		try {
			results = await quitting;
		} catch (error) {
			failure = error;
		}

		assert.equal(settledBeforeLateAcknowledgement, false, "bulk quit must await every run");
		assert.equal(failure, undefined, "bulk quit must return settled failures instead of fail-fast rejecting");
		assert.deepEqual(
			results?.map((result) => (result.ok ? [result.runId, "ok"] : [result.runId, result.reason])),
			[
				["quit-reject-fast", "pause_failed"],
				["quit-ack-late", "ok"],
			],
		);
		const rejected = results?.find((result) => !result.ok && result.runId === "quit-reject-fast");
		assert.match(rejected !== undefined && "message" in rejected ? rejected.message : "", /pause failed fast/);
		assert.equal(store.runs().find((run) => run.id === "quit-reject-fast")?.status, "running");
		assert.equal(store.runs().find((run) => run.id === "quit-ack-late")?.status, "paused");
	});

	test("production pause rejection leaves stage, run, and durability running", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const promptStarted = Promise.withResolvers<void>();
		const finishPrompt = Promise.withResolvers<void>();
		let streaming = false;
		const session = productionSession({
			async prompt() {
				streaming = true;
				promptStarted.resolve();
				await finishPrompt.promise;
				streaming = false;
			},
			get isStreaming() {
				return streaming;
			},
			async abort() {
				throw new Error("production pause acknowledgement failed");
			},
		});
		const definition = workflow({
			name: "production-pause-rejection",
			description: "",
			inputs: {},
			outputs: { done: Type.Boolean() },
			run: async (ctx) => {
				await ctx.stage("live-stage").prompt("work");
				return { done: true };
			},
		});
		const execution = run(
			definition,
			{},
			{
				runId: "production-pause-rejection",
				store,
				stageControlRegistry: registry,
				durableBackend: backend,
				adapters: { agentSession: { create: async () => session } },
			},
		);
		await promptStarted.promise;
		const handle = registry.run("production-pause-rejection").stages()[0];
		assert.ok(handle);

		const pauseFailure = await quitRun("production-pause-rejection", { store, stageControlRegistry: registry }).then(
			() => undefined,
			(error: unknown) => error,
		);
		const stateAfterRejectedPause = structuredClone(
			store.runs().find((run) => run.id === "production-pause-rejection"),
		);
		const durableAfterRejectedPause = backend.getWorkflow("production-pause-rejection")?.status;

		await handle.resume();
		finishPrompt.resolve();
		await execution;

		assert.match(
			pauseFailure instanceof Error ? pauseFailure.message : String(pauseFailure),
			/production pause acknowledgement failed/,
		);
		assert.equal(stateAfterRejectedPause?.status, "running");
		assert.equal(stateAfterRejectedPause?.stages[0]?.status, "running");
		assert.equal(durableAfterRejectedPause, "running");
	});

	test("production quit then acknowledged resume keeps store, stage, and durable state coherent", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const firstPromptStarted = Promise.withResolvers<void>();
		const secondPromptStarted = Promise.withResolvers<void>();
		const finishSecondPrompt = Promise.withResolvers<void>();
		let rejectCurrentPrompt: ((reason: Error) => void) | undefined;
		let promptCalls = 0;
		let streaming = false;
		const session = productionSession({
			async prompt() {
				promptCalls += 1;
				streaming = true;
				if (promptCalls === 1) firstPromptStarted.resolve();
				else secondPromptStarted.resolve();
				await new Promise<void>((resolve, reject) => {
					rejectCurrentPrompt = reject;
					if (promptCalls > 1) void finishSecondPrompt.promise.then(resolve);
				});
				streaming = false;
			},
			get isStreaming() {
				return streaming;
			},
			async abort() {
				streaming = false;
				rejectCurrentPrompt?.(new Error("AbortError"));
			},
		});
		const definition = workflow({
			name: "production-quit-resume",
			description: "",
			inputs: {},
			outputs: { done: Type.Boolean() },
			run: async (ctx) => {
				await ctx.stage("live-stage").prompt("work");
				return { done: true };
			},
		});
		const runId = "production-quit-resume";
		const execution = run(
			definition,
			{},
			{
				runId,
				store,
				stageControlRegistry: registry,
				durableBackend: backend,
				adapters: { agentSession: { create: async () => session } },
			},
		);
		await firstPromptStarted.promise;

		assert.equal((await quitRun(runId, { store, stageControlRegistry: registry })).ok, true);
		assert.equal(store.runs().find((run) => run.id === runId)?.status, "paused");
		assert.equal(store.runs().find((run) => run.id === runId)?.stages[0]?.status, "paused");
		assert.equal(backend.getWorkflow(runId)?.status, "paused");

		const resumed = await resumeRun(runId, {
			store,
			stageControlRegistry: registry,
			message: "continue",
		});
		assert.equal(resumed.ok, true);
		assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
		assert.equal(store.runs().find((run) => run.id === runId)?.stages[0]?.status, "running");
		assert.equal(registry.get(runId, store.runs().find((run) => run.id === runId)!.stages[0]!.id)?.status, "running");
		assert.equal(backend.getWorkflow(runId)?.status, "running");

		await secondPromptStarted.promise;
		finishSecondPrompt.resolve();
		assert.equal((await execution).status, "completed");
	});
	test("durable transition failure propagates instead of claiming a resumable pause", async () => {
		class TransitionFailingBackend extends InMemoryDurableBackend {
			override async transitionWorkflowStatus(): Promise<boolean> {
				throw new Error("durable transition write failed");
			}
		}
		const backend = new TransitionFailingBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const runId = "quit-durable-transition-fails";
		let status: StageControlStatus = "running";
		store.recordRunStart({ id: runId, name: "durable", inputs: {}, status: "running", stages: [], startedAt: 1 });
		store.recordStageStart(runId, { id: "stage-1", name: "stage", status: "running", parentIds: [], toolEvents: [] });
		backend.registerWorkflow({ workflowId: runId, name: "durable", inputs: {}, createdAt: 1, status: "running" });
		registry.register(
			stageHandle({
				runId,
				stageId: "stage-1",
				status: () => status,
				pause: async () => {
					status = "paused";
				},
			}),
		);

		const failure = await quitRun(runId, { store, stageControlRegistry: registry }).then(
			(result) => result,
			(error: unknown) => error,
		);

		assert.match(failure instanceof Error ? failure.message : String(failure), /durable transition write failed/);
		const run = store.runs().find((candidate) => candidate.id === runId);
		assert.notEqual(run?.exitReason, "quit");
		assert.notEqual(run?.resumable, true);
		assert.equal(backend.getWorkflow(runId)?.status, "running");
	});

	test("durable flush failure propagates instead of claiming a resumable pause", async () => {
		class FlushFailingBackend extends InMemoryDurableBackend {
			async flush(): Promise<void> {
				throw new Error("durable flush failed");
			}
		}
		const backend = new FlushFailingBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const runId = "quit-durable-flush-fails";
		let status: StageControlStatus = "running";
		store.recordRunStart({ id: runId, name: "durable", inputs: {}, status: "running", stages: [], startedAt: 1 });
		store.recordStageStart(runId, { id: "stage-1", name: "stage", status: "running", parentIds: [], toolEvents: [] });
		backend.registerWorkflow({ workflowId: runId, name: "durable", inputs: {}, createdAt: 1, status: "running" });
		registry.register(
			stageHandle({
				runId,
				stageId: "stage-1",
				status: () => status,
				pause: async () => {
					status = "paused";
				},
			}),
		);

		const failure = await quitRun(runId, { store, stageControlRegistry: registry }).then(
			(result) => result,
			(error: unknown) => error,
		);

		assert.match(failure instanceof Error ? failure.message : String(failure), /durable flush failed/);
		const run = store.runs().find((candidate) => candidate.id === runId);
		assert.notEqual(run?.exitReason, "quit");
		assert.notEqual(run?.resumable, true);
	});
});

function abortObserved(signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

describe("graceful workflow quit of in-flight ctx.tool nodes", () => {
	test("tool-only run pauses as resumable instead of reporting no controllable stages", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const runId = "quit-tool-only";
		const entered = Promise.withResolvers<void>();
		let observedAbort = false;
		const definition = workflow({
			name: "quit-tool-only",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("hang", {}, async ({ signal }) => {
					entered.resolve();
					await abortObserved(signal);
					observedAbort = true;
					return "late";
				});
				return {};
			},
		});

		const execution = run(
			definition,
			{},
			{
				runId,
				store,
				stageControlRegistry: registry,
				toolControlRegistry: toolControls,
				durableBackend: backend,
			},
		);
		await entered.promise;
		assert.equal(registry.run(runId).stages().length, 0, "the only in-flight work is a tool node");

		const result = await quitRun(runId, {
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
		});

		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(
				result.cancelledTools.map((entry) => [entry.node.name, entry.node.status]),
				[["hang", "cancelled"]],
			);
			assert.deepEqual(result.abandonedTools, []);
		}
		assert.equal(observedAbort, true, "the callback must unblock on its abort signal");
		const quitRunSnapshot = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(quitRunSnapshot?.status, "paused");
		assert.equal(quitRunSnapshot?.exitReason, "quit");
		assert.equal(quitRunSnapshot?.resumable, true);
		assert.equal(quitRunSnapshot?.toolNodes?.[0]?.status, "cancelled");
		assert.equal(backend.getWorkflow(runId)?.status, "paused");
		assert.equal(
			backend.listCheckpoints(runId).some((entry) => entry.kind === "tool" && entry.name === "hang"),
			false,
			"a cancelled call must leave no replayable checkpoint",
		);

		const finished = await execution;
		assert.equal(finished.status, "paused");
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.endedAt, undefined);
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "paused");
	});

	test("durable paused transition waits for the aborted callback to settle", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const runId = "quit-tool-settlement-order";
		const entered = Promise.withResolvers<void>();
		const sawAbort = Promise.withResolvers<void>();
		const releaseSettlement = Promise.withResolvers<void>();
		const definition = workflow({
			name: "quit-tool-settlement-order",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("slow-teardown", {}, async ({ signal }) => {
					entered.resolve();
					await abortObserved(signal);
					sawAbort.resolve();
					await releaseSettlement.promise;
					return "torn-down";
				});
				return {};
			},
		});

		const execution = run(
			definition,
			{},
			{ runId, store, stageControlRegistry: registry, toolControlRegistry: toolControls, durableBackend: backend },
		);
		await entered.promise;
		let quitSettled = false;
		const quitting = quitRun(runId, {
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
		}).finally(() => {
			quitSettled = true;
		});
		await sawAbort.promise;
		await Promise.resolve();

		assert.equal(quitSettled, false, "quit must not settle while the callback is still tearing down");
		assert.equal(backend.getWorkflow(runId)?.status, "running", "durable pause must follow tool settlement");
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "running");

		releaseSettlement.resolve();
		const result = await quitting;
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(result.abandonedTools, []);
		assert.equal(backend.getWorkflow(runId)?.status, "paused");
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.toolNodes?.[0]?.status, "cancelled");
		assert.equal((await execution).status, "paused");
	});

	test("a callback that ignores its signal is abandoned after the bounded wait and reported", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const runId = "quit-tool-abandoned";
		const entered = Promise.withResolvers<void>();
		const neverReleasedUntilTeardown = Promise.withResolvers<void>();
		const definition = workflow({
			name: "quit-tool-abandoned",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("ignores-signal", {}, async () => {
					entered.resolve();
					await neverReleasedUntilTeardown.promise;
					return "late";
				});
				return {};
			},
		});

		const execution = run(
			definition,
			{},
			{ runId, store, stageControlRegistry: registry, toolControlRegistry: toolControls, durableBackend: backend },
		);
		await entered.promise;
		const quitting = quitRun(runId, {
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
		});
		await new Promise((resolve) => setTimeout(resolve, TOOL_QUIT_SETTLEMENT_TIMEOUT_MS / 5));
		assert.equal(
			backend.getWorkflow(runId)?.status,
			"running",
			"durable pause must not be recorded while the bounded wait is still running",
		);

		const result = await quitting;
		assert.equal(result.ok, true);
		const nodeId = store.runs().find((candidate) => candidate.id === runId)?.toolNodes?.[0]?.id;
		assert.ok(nodeId);
		if (result.ok) {
			assert.deepEqual(result.abandonedTools, [{ runId, nodeId }]);
			assert.deepEqual(
				result.cancelledTools.map((entry) => [entry.runId, entry.node.name, entry.node.status]),
				[[runId, "ignores-signal", "cancelled"]],
			);
		}
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.toolNodes?.[0]?.status, "cancelled");
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "paused");
		assert.equal(backend.getWorkflow(runId)?.status, "paused");

		neverReleasedUntilTeardown.resolve();
		assert.equal((await execution).status, "paused");
		assert.equal(
			backend.listCheckpoints(runId).some((entry) => entry.kind === "tool" && entry.name === "ignores-signal"),
			false,
			"an abandoned callback that returns late must not become a replayable checkpoint",
		);
	});

	test("mixed run pauses its stage and aborts its tool before the durable transition", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const runId = "quit-tool-mixed";
		const entered = Promise.withResolvers<void>();
		const stagePauseAcknowledged = Promise.withResolvers<void>();
		const sawAbort = Promise.withResolvers<void>();
		const releaseSettlement = Promise.withResolvers<void>();
		let stageStatus: StageControlStatus = "running";
		const definition = workflow({
			name: "quit-tool-mixed",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("mixed-hang", {}, async ({ signal }) => {
					entered.resolve();
					await abortObserved(signal);
					sawAbort.resolve();
					await releaseSettlement.promise;
					return "late";
				});
				return {};
			},
		});

		const execution = run(
			definition,
			{},
			{ runId, store, stageControlRegistry: registry, toolControlRegistry: toolControls, durableBackend: backend },
		);
		await entered.promise;
		store.recordStageStart(runId, {
			id: "sibling-stage",
			name: "sibling",
			status: "running",
			parentIds: [],
			toolEvents: [],
		});
		registry.register(
			stageHandle({
				runId,
				stageId: "sibling-stage",
				status: () => stageStatus,
				pause: async () => {
					await stagePauseAcknowledged.promise;
					stageStatus = "paused";
				},
			}),
		);

		const quitting = quitRun(runId, {
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
		});
		await Promise.resolve();
		assert.equal(backend.getWorkflow(runId)?.status, "running", "stage pause must precede the durable transition");
		stagePauseAcknowledged.resolve();
		await sawAbort.promise;
		assert.equal(backend.getWorkflow(runId)?.status, "running", "tool abort must precede the durable transition");
		releaseSettlement.resolve();

		const result = await quitting;
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(
				result.paused.map((stage) => stage.id),
				["sibling-stage"],
			);
			assert.deepEqual(
				result.cancelledTools.map((entry) => entry.node.name),
				["mixed-hang"],
			);
			assert.deepEqual(result.abandonedTools, []);
		}
		assert.equal(backend.getWorkflow(runId)?.status, "paused");
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "paused");
		assert.equal((await execution).status, "paused");
	});

	test("aborts a nested child run's tool node and suspends the whole boundary", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const runId = "quit-tool-nested";
		const entered = Promise.withResolvers<void>();
		const child = workflow({
			name: "quit-tool-nested-child",
			description: "",
			inputs: {},
			outputs: { ok: Type.Boolean() },
			run: async (ctx) => {
				await ctx.tool("child-hang", {}, async ({ signal }) => {
					entered.resolve();
					await abortObserved(signal);
					throw new Error("child-hang observed cancellation");
				});
				return { ok: true };
			},
		});
		const parent = workflow({
			name: "quit-tool-nested-parent",
			description: "",
			inputs: {},
			outputs: { ok: Type.Boolean() },
			run: async (ctx) => {
				await ctx.workflow(child, {});
				return { ok: true };
			},
		});

		const execution = run(
			parent,
			{},
			{ runId, store, stageControlRegistry: registry, toolControlRegistry: toolControls, durableBackend: backend },
		);
		await entered.promise;

		const result = await quitRun(runId, {
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
		});

		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(
				result.cancelledTools.map((entry) => [entry.node.name, entry.node.status]),
				[["child-hang", "cancelled"]],
			);
			assert.deepEqual(result.abandonedTools, []);
		}
		assert.equal((await execution).status, "paused");
		const root = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(root?.status, "paused");
		assert.equal(root?.endedAt, undefined, "a suspended boundary must not record a terminal child failure");
		assert.equal(root?.resumable, true);
		const childRun = store.runs().find((candidate) => candidate.parentRunId === runId);
		assert.equal(childRun?.status, "paused");
		assert.equal(childRun?.toolNodes?.[0]?.status, "cancelled");
		assert.equal(backend.getWorkflow(runId)?.status, "paused");
	});

	test("a tool admitted while a stage pause is pending is included in quit", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const runId = "quit-tool-late-admission";
		const pauseEntered = Promise.withResolvers<void>();
		const pauseAcknowledged = Promise.withResolvers<void>();
		const releaseWorkflowToTool = Promise.withResolvers<void>();
		const lateToolStarted = Promise.withResolvers<void>();
		const cleanupRelease = Promise.withResolvers<void>();
		let lateSignal: AbortSignal | undefined;
		let lateObservedAbort = false;
		let stageStatus: StageControlStatus = "running";
		const definition = workflow({
			name: "quit-tool-late-admission",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				// The call is admitted only after quit has started and is waiting on
				// the stage pause acknowledgement.
				await releaseWorkflowToTool.promise;
				await ctx.tool("late-admission", {}, async ({ signal }) => {
					lateSignal = signal;
					lateToolStarted.resolve();
					await Promise.race([abortObserved(signal), cleanupRelease.promise]);
					lateObservedAbort = signal.aborted;
					return "late";
				});
				return {};
			},
		});

		const execution = run(
			definition,
			{},
			{ runId, store, stageControlRegistry: registry, toolControlRegistry: toolControls, durableBackend: backend },
		);
		await Promise.resolve();
		store.recordStageStart(runId, {
			id: "slow-pause-stage",
			name: "slow-pause",
			status: "running",
			parentIds: [],
			toolEvents: [],
		});
		registry.register(
			stageHandle({
				runId,
				stageId: "slow-pause-stage",
				status: () => stageStatus,
				pause: async () => {
					pauseEntered.resolve();
					await pauseAcknowledged.promise;
					stageStatus = "paused";
				},
			}),
		);

		try {
			const quitting = quitRun(runId, {
				store,
				stageControlRegistry: registry,
				toolControlRegistry: toolControls,
			});
			await pauseEntered.promise;
			releaseWorkflowToTool.resolve();
			await lateToolStarted.promise;
			assert.equal(lateSignal?.aborted, false, "the late callback starts before quit can abort it");
			assert.equal(
				backend.getWorkflow(runId)?.status,
				"running",
				"durable pause must not be recorded while a stage pause is still pending",
			);

			pauseAcknowledged.resolve();
			const result = await quitting;

			assert.equal(result.ok, true);
			assert.equal(lateObservedAbort, true, "quit must abort a tool admitted during the stage-pause wait");
			const nodeId = store.runs().find((candidate) => candidate.id === runId)?.toolNodes?.[0]?.id;
			assert.ok(nodeId);
			if (result.ok) {
				assert.deepEqual(
					result.cancelledTools.map((entry) => [entry.runId, entry.nodeId, entry.node.status]),
					[[runId, nodeId, "cancelled"]],
				);
				assert.deepEqual(result.abandonedTools, []);
			}
			assert.equal(store.runs().find((candidate) => candidate.id === runId)?.toolNodes?.[0]?.status, "cancelled");
			assert.equal(backend.getWorkflow(runId)?.status, "paused");
			assert.equal((await execution).status, "paused");
		} finally {
			cleanupRelease.resolve();
		}
	});

	test("refuses a ctx.tool call admitted after quit closed admission", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const runId = "c3d4e5f6-a1b2-4c3d-9e0f-1a2b3c4d5e6f";
		const entered = Promise.withResolvers<void>();
		let secondCallStarted = false;
		let secondCallRejection: unknown;
		const definition = workflow({
			name: "quit-tool-post-close",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				try {
					await ctx.tool("first", {}, async ({ signal }) => {
						entered.resolve();
						await abortObserved(signal);
						throw new Error("first observed cancellation");
					});
				} catch {
					// Author code that swallows cancellation must still not be able to
					// start new durable work after quit closed admission.
				}
				try {
					await ctx.tool("second", {}, async () => {
						secondCallStarted = true;
						return "should never run";
					});
				} catch (error) {
					secondCallRejection = error;
					throw error;
				}
				return {};
			},
		});

		const execution = run(
			definition,
			{},
			{ runId, store, stageControlRegistry: registry, toolControlRegistry: toolControls, durableBackend: backend },
		);
		await entered.promise;
		const result = await quitRun(runId, {
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
		});

		assert.equal(result.ok, true);
		assert.equal((await execution).status, "paused");
		assert.equal(secondCallStarted, false, "a post-close ctx.tool callback must never run");
		assert.equal(secondCallRejection instanceof Error, true);
		assert.match(String(secondCallRejection), /suspended by workflow quit/);
		assert.ok(String(secondCallRejection).includes(runId));
		assert.deepEqual(
			store
				.runs()
				.find((candidate) => candidate.id === runId)
				?.toolNodes?.map((node) => node.name),
			["first"],
			"a refused call creates no graph node",
		);
		assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "paused");
		assert.equal(backend.getWorkflow(runId)?.status, "paused");
	});

	test("keeps nested abandoned identities distinct when children share a local node id", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const runId = "quit-tool-nested-identity";
		const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		let startedCount = 0;
		const cleanupRelease = Promise.withResolvers<void>();
		const child = workflow({
			name: "quit-tool-nested-identity-child",
			description: "",
			inputs: {},
			outputs: { ok: Type.Boolean() },
			run: async (ctx) => {
				// Identical name and args in both children, so each child produces the
				// same local `tool:<argsHash>` node id.
				await ctx.tool("shared", { slot: 1 }, async () => {
					started[startedCount++]?.resolve();
					await cleanupRelease.promise;
					return "late";
				});
				return { ok: true };
			},
		});
		const parent = workflow({
			name: "quit-tool-nested-identity-parent",
			description: "",
			inputs: {},
			outputs: { ok: Type.Boolean() },
			run: async (ctx) => {
				await Promise.allSettled([ctx.workflow(child, {}), ctx.workflow(child, {})]);
				return { ok: true };
			},
		});

		const execution = run(
			parent,
			{},
			{ runId, store, stageControlRegistry: registry, toolControlRegistry: toolControls, durableBackend: backend },
		);
		try {
			await Promise.all(started.map((resolver) => resolver.promise));

			const result = await quitRun(runId, {
				store,
				stageControlRegistry: registry,
				toolControlRegistry: toolControls,
			});

			assert.equal(result.ok, true);
			if (result.ok) {
				assert.equal(result.abandonedTools.length, 2);
				assert.equal(new Set(result.abandonedTools.map((id) => `${id.runId}/${id.nodeId}`)).size, 2);
				assert.equal(
					new Set(result.abandonedTools.map((id) => id.nodeId)).size,
					1,
					"nested children legitimately share one local node id",
				);
				assert.equal(result.cancelledTools.length, 2);
				assert.equal(new Set(result.cancelledTools.map((entry) => entry.runId)).size, 2);
				for (const entry of result.cancelledTools) assert.equal(entry.node.status, "cancelled");
			}
		} finally {
			cleanupRelease.resolve();
			await execution;
		}
	});

	test("author catch cannot overwrite a tool-only quit pause", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const runId = "quit-tool-caught-cancellation";
		const entered = Promise.withResolvers<void>();
		let authorCatchRan = false;
		const definition = workflow({
			name: "quit-tool-caught-cancellation",
			description: "",
			inputs: {},
			outputs: { done: Type.Boolean() },
			run: async (ctx) => {
				try {
					await ctx.tool("caught", {}, async ({ signal }) => {
						entered.resolve();
						await abortObserved(signal);
						throw new Error("caught observed cancellation");
					});
				} catch {
					// Cleanup only: a catch is not an opt-out from a whole-run quit.
					authorCatchRan = true;
				}
				return { done: true };
			},
		});

		const execution = run(
			definition,
			{},
			{ runId, store, stageControlRegistry: registry, toolControlRegistry: toolControls, durableBackend: backend },
		);
		await entered.promise;

		const quit = await quitRun(runId, {
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
		});
		const executionResult = await execution;

		assert.equal(quit.ok, true);
		assert.equal(authorCatchRan, true, "the author catch must still run");
		assert.equal(executionResult.status, "paused", "a caught quit cancellation cannot report completion");
		assert.equal(executionResult.result, undefined, "no declared output is published for a quit run");
		const snapshot = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(snapshot?.status, "paused");
		assert.equal(snapshot?.endedAt, undefined, "quit must not be overwritten by a terminal run end");
		assert.equal(snapshot?.exitReason, "quit");
		assert.equal(snapshot?.resumable, true);
		assert.equal(snapshot?.result, undefined);
		assert.equal(snapshot?.toolNodes?.[0]?.status, "cancelled");
		assert.equal(backend.getWorkflow(runId)?.status, "paused");
		assert.equal(backend.getWorkflow(runId)?.resumable, true);
	});

	test("a stage-only quit that is resumed still completes normally", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const runId = "quit-stage-only-resumed";
		let status: StageControlStatus = "running";
		const releaseStage = Promise.withResolvers<void>();
		store.recordRunStart({ id: runId, name: "stage-only", inputs: {}, status: "running", stages: [], startedAt: 1 });
		store.recordStageStart(runId, { id: "stage-1", name: "stage", status: "running", parentIds: [], toolEvents: [] });
		backend.registerWorkflow({ workflowId: runId, name: "stage-only", inputs: {}, createdAt: 1, status: "running" });
		registry.register(
			stageHandle({
				runId,
				stageId: "stage-1",
				status: () => status,
				pause: async () => {
					status = "paused";
				},
				resume: async () => {
					status = "running";
					releaseStage.resolve();
					return undefined;
				},
			}),
		);

		const quit = await quitRun(runId, {
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
		});
		assert.equal(quit.ok, true);
		if (quit.ok) assert.deepEqual(quit.cancelledTools, [], "no tool work was aborted by this quit");

		const resumed = await resumeRun(runId, { store, stageControlRegistry: registry });
		assert.equal(resumed.ok, true);
		await releaseStage.promise;
		assert.equal(
			store.runs().find((candidate) => candidate.id === runId)?.status,
			"running",
			"a quit that only paused stages stays completable after resume",
		);
	});

	/**
	 * Aborting an in-flight callback is not undoable: the executor observed a
	 * whole-run quit and suspends without writing any terminal record, so the
	 * local paused publication is the only thing left that can report the run as
	 * stopped. These three cover the durable outcomes that used to skip it.
	 */
	test("a durable transition failure after the tool abort still reports the suspended run as paused", async () => {
		class TransitionFailingBackend extends InMemoryDurableBackend {
			override async transitionWorkflowStatus(): Promise<boolean> {
				throw new Error("durable transition write failed");
			}
		}
		const backend = new TransitionFailingBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const runId = "quit-tool-durable-transition-fails";
		const entered = Promise.withResolvers<void>();
		const definition = workflow({
			name: "quit-tool-durable-transition-fails",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("hang", {}, async ({ signal }) => {
					entered.resolve();
					await abortObserved(signal);
					return "late";
				});
				return {};
			},
		});

		const execution = run(
			definition,
			{},
			{ runId, store, stageControlRegistry: registry, toolControlRegistry: toolControls, durableBackend: backend },
		);
		await entered.promise;

		const failure = await quitRun(runId, {
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
		}).then(
			(result) => result,
			(error: unknown) => error,
		);

		const message = failure instanceof Error ? failure.message : String(failure);
		assert.match(message, /durable transition write failed/, "the underlying durable failure must still surface");
		assert.match(message, /paused locally and is not resumable/, "and it must say what it left behind");
		assert.equal((await execution).status, "paused", "the aborted call really did suspend the executor");
		const snapshot = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(snapshot?.status, "paused", "a run nothing is running must never stay reported as running");
		assert.equal(snapshot?.exitReason, "quit");
		assert.equal(snapshot?.resumable, false, "no durable record backs this pause, so nothing promises a resume");
		assert.equal(snapshot?.endedAt, undefined);
		assert.equal(snapshot?.toolNodes?.[0]?.status, "cancelled");
	});

	test("quit retried after a durable failure upgrades the pause to resumable", async () => {
		class FlakyTransitionBackend extends InMemoryDurableBackend {
			attempts = 0;
			override async transitionWorkflowStatus(
				workflowId: string,
				expected: readonly DurableWorkflowStatus[],
				status: DurableWorkflowStatus,
				pendingPrompts?: number,
				resumable?: boolean,
			): Promise<boolean> {
				this.attempts += 1;
				if (this.attempts === 1) throw new Error("durable transition write failed");
				return await super.transitionWorkflowStatus(workflowId, expected, status, pendingPrompts, resumable);
			}
		}
		const backend = new FlakyTransitionBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const runId = "quit-tool-durable-retry";
		const entered = Promise.withResolvers<void>();
		const definition = workflow({
			name: "quit-tool-durable-retry",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("hang", {}, async ({ signal }) => {
					entered.resolve();
					await abortObserved(signal);
					return "late";
				});
				return {};
			},
		});

		const execution = run(
			definition,
			{},
			{ runId, store, stageControlRegistry: registry, toolControlRegistry: toolControls, durableBackend: backend },
		);
		await entered.promise;
		await quitRun(runId, { store, stageControlRegistry: registry, toolControlRegistry: toolControls }).catch(
			() => undefined,
		);
		await execution;

		// The failed attempt left a run the operator can still act on: paused, so
		// the retry finds it instead of answering "no controllable stages".
		const retry = await quitRun(runId, {
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
		});

		assert.equal(retry.ok, true);
		const snapshot = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(snapshot?.status, "paused");
		assert.equal(snapshot?.resumable, true);
		assert.equal(backend.getWorkflow(runId)?.status, "paused");
	});

	test("a refused durable transition after the tool abort does not leave the run reported as running", async () => {
		class RefusingBackend extends InMemoryDurableBackend {
			override async transitionWorkflowStatus(): Promise<boolean> {
				return false;
			}
		}
		const backend = new RefusingBackend();
		setDurableBackend(backend);
		const store = createStore();
		const registry = createStageControlRegistry();
		const toolControls = createToolControlRegistry();
		const runId = "quit-tool-durable-refused";
		const entered = Promise.withResolvers<void>();
		const definition = workflow({
			name: "quit-tool-durable-refused",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("hang", {}, async ({ signal }) => {
					entered.resolve();
					await abortObserved(signal);
					return "late";
				});
				return {};
			},
		});

		const execution = run(
			definition,
			{},
			{ runId, store, stageControlRegistry: registry, toolControlRegistry: toolControls, durableBackend: backend },
		);
		await entered.promise;

		const result = await quitRun(runId, {
			store,
			stageControlRegistry: registry,
			toolControlRegistry: toolControls,
		});

		assert.deepEqual(result, { ok: false, runId, reason: "already_ended" });
		assert.equal((await execution).status, "paused");
		const snapshot = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(snapshot?.status, "paused", "the refused transition must not leave a zombie running run");
		assert.equal(snapshot?.exitReason, "quit");
		assert.equal(snapshot?.resumable, false);
		assert.equal(snapshot?.toolNodes?.[0]?.status, "cancelled");
	});
});
