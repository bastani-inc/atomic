import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import type { StageSessionCheckpointOptions } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE } from "../../packages/workflows/src/runs/foreground/stage-runner-controller.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { STAGE_SESSION_HEARTBEAT_INTERVAL_MS } from "../../packages/workflows/src/runs/foreground/stage-session-heartbeat.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowDefinition, WorkflowRunContext } from "../../packages/workflows/src/shared/types.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { createStore, mockSession, run, workflow } from "./executor-shared.js";

useTemporaryAgentDir();

const CONFIG = {
	defaultConcurrency: 2,
	maxDepth: 10,
	persistRuns: false,
	statusFile: false,
	resumeInFlight: "never",
} as const;

afterEach(() => {
	vi.useRealTimers();
});

type Outcome = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

function outcome(promise: Promise<unknown>): Promise<Outcome> {
	return promise.then(
		(): Outcome => ({ ok: true }),
		(error: unknown): Outcome => ({ ok: false, error }),
	);
}

/** Stage "a" at one moment: its status, whether it ended, how often it ended, and whether its generation closed. */
interface StageMoment {
	readonly status: StageSnapshot["status"] | undefined;
	readonly ended: boolean;
	readonly ends: number;
	readonly closed: boolean;
}

const RUNNING: StageMoment = { status: "running", ended: false, ends: 0, closed: false };

/**
 * Stage "a" whose messages each wait for their own gate in its session, then succeed or throw their planned error.
 * With `handOff`, a message hands the stage's message admission on as soon as it starts, as a session does at
 * `agent_start`, so the next message enters before it ends and the two can finish in either order. Without it, the
 * next message enters the session only once the one before it returned.
 */
function gatedStage(plans: readonly (Error | undefined)[], options: { readonly handOff: boolean }) {
	const entered = plans.map(() => Promise.withResolvers<void>());
	const gates = plans.map(() => Promise.withResolvers<void>());
	const extensionState = new Map<string, object>();
	let next = 0;
	const deliver = async (started?: () => void): Promise<void> => {
		const index = next++;
		started?.();
		entered[index]?.resolve();
		await gates[index]?.promise;
		const failure = plans[index];
		if (failure !== undefined) throw failure;
	};
	const adapters: StageAdapters = {
		sessionStore: new MemorySessionStore(),
		agentSession: {
			async create(sessionOptions) {
				// As AgentSession does for a workflow stage: one admission, and one extension state, per generation.
				const orchestration = sessionOptions.orchestrationContext;
				if (orchestration !== undefined && orchestration.messageAdmission === undefined)
					Object.assign(orchestration, {
						messageAdmission: {
							boundary: new WorkflowStageAdmissionBoundary(),
							extensionState,
							isOpen: () => true,
						},
					});
				const session = {
					...mockSession(sessionOptions.sessionManager as SessionManager),
					prompt: () => deliver(),
					// Read as an AgentSession, so the stage runner shares its orchestration context across the generation.
					modelRuntime: {},
					state: { messages: [] },
					sessionManager: sessionOptions.sessionManager,
					getContextUsage: () => undefined,
					orchestrationContext: orchestration,
				};
				if (!options.handOff) return session;
				return {
					...session,
					sendUserMessage: (_content, messageOptions) =>
						deliver(messageOptions?.__workflowDelivery?.promptStarted),
				};
			},
		},
	};
	return {
		adapters,
		entered,
		gates,
		/** Whether the stage's generation closed for good, which ends the subagent children of its turns. */
		closed: () => extensionState.has(WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE),
	};
}

function observeStage(store: ReturnType<typeof createStore>, a: ReturnType<typeof gatedStage>) {
	const ends: StageSnapshot[] = [];
	const record = (): StageSnapshot | undefined => store.runs()[0]?.stages.find((stage) => stage.name === "a");
	return {
		onStageEnd: (_runId: string, snapshot: StageSnapshot): void => {
			if (snapshot.name === "a") ends.push({ ...snapshot });
		},
		ends,
		record,
		moment: (): StageMoment => ({
			status: record()?.status,
			ended: record()?.endedAt !== undefined,
			ends: ends.length,
			closed: a.closed(),
		}),
	};
}

/**
 * Blocks the first durable checkpoint of stage "a" after it is armed, and lets it through once released: holds a
 * call at the checkpoint after its turn, or the one that ends the stage.
 */
function checkpointGate() {
	let armed = false;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	return {
		arm: (): void => {
			armed = true;
		},
		entered: entered.promise,
		release: (): void => release.resolve(),
		onStageSession: async (
			_runId: string,
			snapshot: StageSnapshot,
			checkpoint?: StageSessionCheckpointOptions,
		): Promise<void> => {
			if (!armed || snapshot.name !== "a" || checkpoint?.awaitDurable !== true) return;
			armed = false;
			entered.resolve();
			await release.promise;
		},
	};
}

function stageWorkflow(name: string, body: (ctx: WorkflowRunContext) => Promise<object>): WorkflowDefinition {
	return workflow({ name, description: "", inputs: {}, outputs: {}, run: body });
}

/**
 * Messages to stage "a", all in flight before the first is delivered. Each is let through in turn once the one before
 * it settled; `whileNextRan` holds the stage as it was after each settled, while the next one ran. `atEnd` runs in the
 * workflow once the last settled.
 */
async function sendInOrder(
	plans: readonly (Error | undefined)[],
	atEnd?: (stage: ReturnType<typeof observeStage>) => void,
) {
	const a = gatedStage(plans, { handOff: false });
	const store = createStore();
	const stage = observeStage(store, a);
	const outcomes: Outcome[] = [];
	const whileNextRan: StageMoment[] = [];
	const result = await run(
		stageWorkflow("overlap-in-order", async (ctx) => {
			const a0 = ctx.stage("a");
			const calls = [outcome(a0.sendUserMessage("message 0"))];
			await a.entered[0]!.promise;
			for (let index = 1; index < plans.length; index++) calls.push(outcome(a0.sendUserMessage(`message ${index}`)));
			for (let index = 0; index < plans.length; index++) {
				a.gates[index]!.resolve();
				outcomes.push(await calls[index]!);
				if (index + 1 === plans.length) break;
				await a.entered[index + 1]!.promise;
				whileNextRan.push(stage.moment());
			}
			atEnd?.(stage);
			return {};
		}),
		{},
		{ store, adapters: a.adapters, config: CONFIG, onStageEnd: stage.onStageEnd },
	);
	return { result, outcomes, whileNextRan, stage };
}

test("a message that finishes first leaves its accepted peer running, and the stage ends once after the last (#4450)", async () => {
	const { result, outcomes, whileNextRan, stage } = await sendInOrder([undefined, undefined]);

	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(outcomes, [{ ok: true }, { ok: true }]);
	assert.deepEqual(whileNextRan, [RUNNING]);
	assert.deepEqual(
		stage.ends.map((end) => end.status),
		["completed"],
	);
	assert.deepEqual(stage.moment(), { status: "completed", ended: true, ends: 1, closed: true });
});

test("a message that finishes second, after its peer, keeps its own result and the stage ends after the first (#4450)", async () => {
	const a = gatedStage([undefined, undefined], { handOff: true });
	const store = createStore();
	const stage = observeStage(store, a);
	let first: Outcome | undefined;
	let second: Outcome | undefined;
	let whileFirstRan: StageMoment | undefined;
	const result = await run(
		stageWorkflow("overlap-second-finishes-first", async (ctx) => {
			const a0 = ctx.stage("a");
			const firstCall = outcome(a0.sendUserMessage("first"));
			await a.entered[0]!.promise;
			const secondCall = outcome(a0.sendUserMessage("second"));
			await a.entered[1]!.promise;
			a.gates[1]!.resolve();
			second = await secondCall;
			whileFirstRan = stage.moment();
			a.gates[0]!.resolve();
			first = await firstCall;
			return {};
		}),
		{},
		{ store, adapters: a.adapters, config: CONFIG, onStageEnd: stage.onStageEnd },
	);

	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(second, { ok: true });
	assert.deepEqual(whileFirstRan, RUNNING);
	assert.deepEqual(first, { ok: true });
	assert.deepEqual(stage.moment(), { status: "completed", ended: true, ends: 1, closed: true });
});

test("a failed message rejects with its own error, its peer still completes, and the stage fails with it (#4450)", async () => {
	const boom = new Error("first message failed");
	const { outcomes, whileNextRan, stage } = await sendInOrder([boom, undefined]);

	assert.deepEqual(outcomes, [{ ok: false, error: boom }, { ok: true }]);
	assert.deepEqual(whileNextRan, [RUNNING]);
	assert.deepEqual(
		stage.ends.map((end) => [end.status, end.failureMessage]),
		[["failed", boom.message]],
	);
});

test("a message that fails after its peer completed is not lost: it rejects with its own error and fails the stage (#4450)", async () => {
	const boom = new Error("second message failed");
	const { outcomes, whileNextRan, stage } = await sendInOrder([undefined, boom]);

	assert.deepEqual(outcomes, [{ ok: true }, { ok: false, error: boom }]);
	assert.deepEqual(whileNextRan, [RUNNING]);
	assert.deepEqual(
		stage.ends.map((end) => [end.status, end.failureMessage]),
		[["failed", boom.message]],
	);
});

test("failed messages each reject with their own error, and the stage records the first of them (#4450)", async () => {
	const booms = [new Error("message 0 failed"), new Error("message 1 failed"), new Error("message 2 failed")];
	const { outcomes, whileNextRan, stage } = await sendInOrder(booms);

	assert.deepEqual(
		outcomes,
		booms.map((error) => ({ ok: false, error })),
	);
	assert.deepEqual(whileNextRan, [RUNNING, RUNNING]);
	assert.deepEqual(
		stage.ends.map((end) => [end.status, end.failureMessage]),
		[["failed", booms[0]!.message]],
	);
});

test("a message that fails recoverably blocks the stage resumably, even when a peer ends it (#4450)", async () => {
	const limited = new Error("HTTP 429 rate limit exceeded");
	let afterBoth: StageMoment | undefined;
	let disposition: StageSnapshot["failureDisposition"];
	const { outcomes, stage } = await sendInOrder([limited, undefined], (ended) => {
		afterBoth = ended.moment();
		disposition = ended.record()?.failureDisposition;
	});

	assert.deepEqual(outcomes, [{ ok: false, error: limited }, { ok: true }]);
	assert.equal(disposition, "active_blocked");
	assert.equal(afterBoth?.ends, 1);
	assert.equal(afterBoth?.closed, false, "a resumably blocked stage keeps its generation open");
	assert.equal(stage.moment().closed, true, "the generation closes for good once the run ends");
});

test("messages sent after an overlapping message blocked the stage resumably run as after the stage ended (#4450)", async () => {
	const limited = new Error("HTTP 429 rate limit exceeded");
	const lateFailure = new Error("late message failed");
	const a = gatedStage([limited, undefined, lateFailure, undefined], { handOff: false });
	const store = createStore();
	const stage = observeStage(store, a);
	const outcomes: Outcome[] = [];
	const moments: StageMoment[] = [];
	await run(
		stageWorkflow("overlap-late-after-block", async (ctx) => {
			const a0 = ctx.stage("a");
			const firstCall = outcome(a0.sendUserMessage("first"));
			await a.entered[0]!.promise;
			const secondCall = outcome(a0.sendUserMessage("second"));
			a.gates[0]!.resolve();
			a.gates[1]!.resolve();
			outcomes.push(await firstCall, await secondCall);
			moments.push(stage.moment());
			a.gates[2]!.resolve();
			outcomes.push(await outcome(a0.sendUserMessage("late failure")));
			moments.push(stage.moment());
			a.gates[3]!.resolve();
			outcomes.push(await outcome(a0.sendUserMessage("late success")));
			moments.push(stage.moment());
			return {};
		}),
		{},
		{ store, adapters: a.adapters, config: CONFIG, onStageEnd: stage.onStageEnd },
	);

	assert.deepEqual(outcomes, [
		{ ok: false, error: limited },
		{ ok: true },
		{ ok: false, error: lateFailure },
		{ ok: true },
	]);
	const blocked: StageMoment = { status: "failed", ended: true, ends: 1, closed: false };
	assert.deepEqual(moments, [blocked, blocked, { ...blocked, closed: true }]);
	assert.equal(stage.record()?.failureMessage, limited.message);
});

test("a message that starts while an earlier one has finished and another still runs counts for the stage (#4450)", async () => {
	const boom = new Error("third message failed");
	const a = gatedStage([undefined, undefined, boom], { handOff: false });
	const store = createStore();
	const stage = observeStage(store, a);
	const outcomes: Outcome[] = [];
	await run(
		stageWorkflow("overlap-joins-running-peer", async (ctx) => {
			const a0 = ctx.stage("a");
			const firstCall = outcome(a0.sendUserMessage("first"));
			await a.entered[0]!.promise;
			const secondCall = outcome(a0.sendUserMessage("second"));
			a.gates[0]!.resolve();
			outcomes.push(await firstCall);
			await a.entered[1]!.promise;
			const thirdCall = outcome(a0.sendUserMessage("third"));
			a.gates[2]!.resolve();
			a.gates[1]!.resolve();
			outcomes.push(await secondCall, await thirdCall);
			return {};
		}),
		{},
		{ store, adapters: a.adapters, config: CONFIG, onStageEnd: stage.onStageEnd },
	);

	assert.deepEqual(outcomes, [{ ok: true }, { ok: true }, { ok: false, error: boom }]);
	assert.deepEqual(
		stage.ends.map((end) => [end.status, end.failureMessage]),
		[["failed", boom.message]],
	);
});

test("a message sent after the overlapping messages ended the stage is accepted and does not end it again (#4450)", async () => {
	const a = gatedStage([undefined, undefined, undefined], { handOff: false });
	const store = createStore();
	const stage = observeStage(store, a);
	let late: Outcome | undefined;
	const result = await run(
		stageWorkflow("overlap-late-message", async (ctx) => {
			const a0 = ctx.stage("a");
			const firstCall = outcome(a0.sendUserMessage("first"));
			await a.entered[0]!.promise;
			const secondCall = outcome(a0.sendUserMessage("second"));
			a.gates[0]!.resolve();
			a.gates[1]!.resolve();
			await Promise.all([firstCall, secondCall]);
			a.gates[2]!.resolve();
			late = await outcome(a0.sendUserMessage("late"));
			return {};
		}),
		{},
		{ store, adapters: a.adapters, config: CONFIG, onStageEnd: stage.onStageEnd },
	);

	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(late, { ok: true });
	assert.deepEqual(
		stage.ends.map((end) => end.status),
		["completed"],
	);
});

/**
 * Stage "a" ends after one message, held at a durable checkpoint once its turn settled; a second message is sent while
 * it is held there, and fails. `plan` is the first message's outcome.
 */
async function messageWhileStageEnds(plan: Error | undefined) {
	const late = new Error("message sent while the stage ended failed");
	const a = gatedStage([plan, late], { handOff: false });
	const checkpoint = checkpointGate();
	const store = createStore();
	const stage = observeStage(store, a);
	let first: Outcome | undefined;
	let second: Outcome | undefined;
	let whileEnding: StageMoment | undefined;
	await run(
		stageWorkflow("overlap-message-while-ending", async (ctx) => {
			const a0 = ctx.stage("a");
			const firstCall = outcome(a0.sendUserMessage("first"));
			await a.entered[0]!.promise;
			checkpoint.arm();
			a.gates[0]!.resolve();
			await checkpoint.entered;
			whileEnding = stage.moment();
			a.gates[1]!.resolve();
			second = await outcome(a0.sendUserMessage("second"));
			checkpoint.release();
			first = await firstCall;
			return {};
		}),
		{},
		{
			store,
			adapters: a.adapters,
			config: CONFIG,
			onStageEnd: stage.onStageEnd,
			onStageSession: checkpoint.onStageSession,
		},
	);
	return { first, second, late, whileEnding, stage };
}

test("a message sent while a completed stage ends is its own: its failure leaves the stage completed (#4450)", async () => {
	const { first, second, late, whileEnding, stage } = await messageWhileStageEnds(undefined);

	assert.deepEqual(whileEnding, { status: "running", ended: false, ends: 0, closed: true });
	assert.deepEqual(second, { ok: false, error: late });
	assert.deepEqual(first, { ok: true });
	assert.deepEqual(
		stage.ends.map((end) => end.status),
		["completed"],
	);
});

test("a message sent while a failed stage ends is its own: the stage keeps the failure that ended it (#4450)", async () => {
	const boom = new Error("the only message failed");
	const { first, second, late, whileEnding, stage } = await messageWhileStageEnds(boom);

	assert.deepEqual(whileEnding, { status: "running", ended: false, ends: 0, closed: true });
	assert.deepEqual(second, { ok: false, error: late });
	assert.deepEqual(first, { ok: false, error: boom });
	assert.deepEqual(
		stage.ends.map((end) => [end.status, end.failureMessage]),
		[["failed", boom.message]],
	);
});

test("the stage keeps its durable heartbeat while a later overlapping message still runs (#4450)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const a = gatedStage([undefined, undefined], { handOff: false });
	const store = createStore();
	let checkpoints = 0;
	let heartbeatsWhileSecondRan: number | undefined;
	const result = await run(
		stageWorkflow("overlap-heartbeat", async (ctx) => {
			const a0 = ctx.stage("a");
			const firstCall = outcome(a0.sendUserMessage("first"));
			await a.entered[0]!.promise;
			const secondCall = outcome(a0.sendUserMessage("second"));
			a.gates[0]!.resolve();
			await firstCall;
			await a.entered[1]!.promise;
			const before = checkpoints;
			await vi.advanceTimersByTimeAsync(STAGE_SESSION_HEARTBEAT_INTERVAL_MS);
			heartbeatsWhileSecondRan = checkpoints - before;
			a.gates[1]!.resolve();
			await secondCall;
			return {};
		}),
		{},
		{
			store,
			adapters: a.adapters,
			config: CONFIG,
			onStageSession: (_runId, snapshot) => {
				if (snapshot.name === "a") checkpoints += 1;
			},
		},
	);

	assert.equal(result.status, "completed", result.error);
	assert.equal(heartbeatsWhileSecondRan, 1);
});

test("the message that ends the stage still reports a durable heartbeat failure that came after its turn (#4450)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const a = gatedStage([undefined], { handOff: false });
	const checkpoint = checkpointGate();
	const heartbeatFailure = new Error("the stage's durable heartbeat checkpoint failed");
	let failNextCheckpoint = false;
	const store = createStore();
	const stage = observeStage(store, a);
	let only: Outcome | undefined;
	await run(
		stageWorkflow("overlap-heartbeat-failure", async (ctx) => {
			const a0 = ctx.stage("a");
			const onlyCall = outcome(a0.sendUserMessage("only"));
			await a.entered[0]!.promise;
			checkpoint.arm();
			a.gates[0]!.resolve();
			await checkpoint.entered;
			failNextCheckpoint = true;
			await vi.advanceTimersByTimeAsync(STAGE_SESSION_HEARTBEAT_INTERVAL_MS);
			checkpoint.release();
			only = await onlyCall;
			return {};
		}),
		{},
		{
			store,
			adapters: a.adapters,
			config: CONFIG,
			onStageEnd: stage.onStageEnd,
			onStageSession: async (runId, snapshot, options) => {
				if (failNextCheckpoint && snapshot.name === "a") {
					failNextCheckpoint = false;
					throw heartbeatFailure;
				}
				await checkpoint.onStageSession(runId, snapshot, options);
			},
		},
	);

	assert.deepEqual(only, { ok: false, error: heartbeatFailure });
	assert.deepEqual(
		stage.ends.map((end) => [end.status, end.failureMessage]),
		[["failed", heartbeatFailure.message]],
	);
});

test("an earlier message's recoverable failure is kept on the stage even if the ending message's final checkpoint fails (#4450)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const limited = new Error("HTTP 429 rate limit exceeded");
	const heartbeatFailure = new Error("the stage's durable heartbeat checkpoint failed");
	const a = gatedStage([limited, undefined], { handOff: false });
	const checkpoint = checkpointGate();
	let failNextCheckpoint = false;
	const store = createStore();
	const stage = observeStage(store, a);
	let first: Outcome | undefined;
	let second: Outcome | undefined;
	await run(
		stageWorkflow("overlap-peer-failure-beats-checkpoint-failure", async (ctx) => {
			const a0 = ctx.stage("a");
			const firstCall = outcome(a0.sendUserMessage("first"));
			await a.entered[0]!.promise;
			const secondCall = outcome(a0.sendUserMessage("second"));
			a.gates[0]!.resolve();
			first = await firstCall;
			await a.entered[1]!.promise;
			checkpoint.arm();
			a.gates[1]!.resolve();
			await checkpoint.entered;
			failNextCheckpoint = true;
			await vi.advanceTimersByTimeAsync(STAGE_SESSION_HEARTBEAT_INTERVAL_MS);
			checkpoint.release();
			second = await secondCall;
			return {};
		}),
		{},
		{
			store,
			adapters: a.adapters,
			config: CONFIG,
			onStageEnd: stage.onStageEnd,
			onStageSession: async (runId, snapshot, options) => {
				if (failNextCheckpoint && snapshot.name === "a") {
					failNextCheckpoint = false;
					throw heartbeatFailure;
				}
				await checkpoint.onStageSession(runId, snapshot, options);
			},
		},
	);

	assert.deepEqual(first, { ok: false, error: limited });
	assert.deepEqual(second, { ok: false, error: heartbeatFailure });
	assert.deepEqual(
		stage.ends.map((end) => [end.status, end.failureMessage, end.failureDisposition]),
		[["failed", limited.message, "active_blocked"]],
	);
});

test("a message whose turn finished when the workflow exits rejects with the exit, not a fail-fast error (#4450)", async () => {
	const a = gatedStage([undefined], { handOff: false });
	const checkpoint = checkpointGate();
	const store = createStore();
	const ends: StageSnapshot[] = [];
	let call: Promise<Outcome> | undefined;
	let exit: unknown;
	const result = await run(
		stageWorkflow("overlap-exit-after-turn", async (ctx) => {
			const a0 = ctx.stage("a");
			call = outcome(a0.sendUserMessage("only"));
			await a.entered[0]!.promise;
			checkpoint.arm();
			a.gates[0]!.resolve();
			await checkpoint.entered;
			try {
				return ctx.exit({ status: "skipped", reason: "stop here" });
			} catch (signal) {
				exit = signal;
				throw signal;
			}
		}),
		{},
		{
			store,
			adapters: a.adapters,
			config: CONFIG,
			onStageSession: checkpoint.onStageSession,
			onStageEnd: (_runId, snapshot) => {
				if (snapshot.name !== "a") return;
				ends.push({ ...snapshot });
				checkpoint.release();
			},
		},
	);

	assert.equal(result.status, "skipped");
	assert.notEqual(exit, undefined);
	assert.deepEqual(await call, { ok: false, error: exit });
	assert.deepEqual(
		ends.map((end) => [end.status, end.skippedReason]),
		[["skipped", "workflow-exit: stop here"]],
	);
});

test("overlapping messages a workflow exit interrupts both reject with the exit, and the stage is skipped (#4450)", async () => {
	const a = gatedStage([undefined, undefined], { handOff: true });
	const store = createStore();
	const stage = observeStage(store, a);
	const calls: Promise<Outcome>[] = [];
	let exit: unknown;
	const result = await run(
		stageWorkflow("overlap-exit", async (ctx) => {
			const a0 = ctx.stage("a");
			calls.push(outcome(a0.sendUserMessage("first")));
			await a.entered[0]!.promise;
			calls.push(outcome(a0.sendUserMessage("second")));
			await a.entered[1]!.promise;
			try {
				return ctx.exit({ status: "skipped", reason: "stop here" });
			} catch (signal) {
				exit = signal;
				throw signal;
			}
		}),
		{},
		{ store, adapters: a.adapters, config: CONFIG, onStageEnd: stage.onStageEnd },
	);

	assert.equal(result.status, "skipped");
	assert.notEqual(exit, undefined);
	assert.deepEqual(await Promise.all(calls), [
		{ ok: false, error: exit },
		{ ok: false, error: exit },
	]);
	assert.deepEqual(
		stage.ends.map((end) => [end.status, end.skippedReason]),
		[["skipped", "workflow-exit: stop here"]],
	);
});
