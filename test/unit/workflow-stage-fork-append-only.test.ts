import assert from "node:assert/strict";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import {
	type AssistantMessage,
	type FetchFunction,
	getModel,
	type Message,
	type Model,
	streamSimple,
} from "@bastani/atomic-ai/compat";
import { afterEach, describe, test } from "vitest";
import { convertToLlm } from "../../packages/coding-agent/src/core/messages.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { createFanOutForkPoints, withLaunchForkPoint } from "../../packages/workflows/src/durable/stage-fork-point.js";
import {
	createDurableTaskPrimitive,
	createStageReplayKeyGenerator,
} from "../../packages/workflows/src/durable/stage-primitive.js";
import { createParallelPrimitive } from "../../packages/workflows/src/engine/primitives/parallel.js";
import type { EngineRuntime } from "../../packages/workflows/src/engine/runtime.js";
import { registerLiveStageSession } from "../../packages/workflows/src/shared/live-stage-sessions.js";
import { forkStageSession, STAGE_FORK_TOOL_RESULT } from "../../packages/workflows/src/shared/stage-session-store.js";
import type {
	StageOptions,
	WorkflowTaskOptions,
	WorkflowTaskResult,
} from "../../packages/workflows/src/shared/types.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";

const model = getModel("github-copilot", "claude-opus-5.5") as Model<"anthropic-messages">;
const RUN = "fork-point-run";

afterEach(async () => {
	await closeMemoryTestBackends();
});

function sourceTurn(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

function toolResult(toolCallId: string, text: string): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

async function requestMessages(messages: AgentMessage[]): Promise<unknown[]> {
	let payload: { messages: unknown[] } | undefined;
	await streamSimple(
		{ ...model, baseUrl: "http://127.0.0.1:9" },
		{ messages: convertToLlm(messages) },
		{
			apiKey: "credential-free-test-key",
			reasoning: "xhigh",
			fetch: (async () => {
				throw new Error("payload captured");
			}) as unknown as FetchFunction,
			onPayload: (body) => {
				payload = body as { messages: unknown[] };
			},
		},
	).result();
	if (!payload) throw new Error("no payload was built");
	return payload.messages;
}

/** A source session whose newest turn has signed thinking and a tool call it has not answered yet. */
async function sourceWithOpenCall(): Promise<SessionManager> {
	const source = SessionManager.inMemory();
	await source.appendMessage({ role: "user", content: "Investigate the failure.", timestamp: Date.now() });
	await source.appendMessage(
		sourceTurn([
			{ type: "thinking", thinking: "Read the log first.", thinkingSignature: "sig-log" },
			{ type: "toolCall", id: "toolu_log", name: "bash", arguments: { command: "cat log" } },
		]),
	);
	return source;
}

function fork(source: SessionManager, entryId?: string): Promise<SessionManager> {
	return forkStageSession(source.getSessionStore(), source.getSessionId(), source.getCwd(), {}, undefined, entryId);
}

describe("forked workflow stages copy their source append-only (#5481)", () => {
	test("a forked stage replays its source's last turn unchanged and answers its open tool call (#5481)", async () => {
		const source = await sourceWithOpenCall();
		const inherited = source.buildSessionContext().messages;
		const stage = await fork(source);

		const copied = stage.buildSessionContext().messages;
		assert.deepEqual(copied.slice(0, inherited.length), inherited);
		assert.deepEqual(
			copied.slice(inherited.length).map((message) => {
				assert.equal(message.role, "toolResult");
				return { id: message.toolCallId, text: message.content };
			}),
			[{ id: "toolu_log", text: [{ type: "text", text: STAGE_FORK_TOOL_RESULT }] }],
		);
		// The stage's first request starts with what the source itself would send next.
		await source.appendMessage(toolResult("toolu_log", "the source's own result"));
		const sourceRequest = await requestMessages(source.buildSessionContext().messages);
		const stageRequest = await requestMessages([
			...copied,
			{ role: "user", content: "The stage's prompt.", timestamp: Date.now() },
		]);
		assert.deepEqual(stageRequest.slice(0, 2), sourceRequest.slice(0, 2));
	});

	test("stages launched from one point share the entry captured at launch, also after a resume (#5481)", async () => {
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: RUN,
			name: RUN,
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		const source = await sourceWithOpenCall();
		registerLiveStageSession(source);
		const options: StageOptions = { context: "fork", forkFromSessionId: source.getSessionId() };
		const launch = (replayKey: string) =>
			withLaunchForkPoint({
				backend,
				workflowId: RUN,
				replayKey,
				options,
				resuming: false,
			});
		const launched = [launch("stage:a"), launch("stage:b")];
		const atLaunch = source.buildSessionContext().messages;
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The source keeps going before either stage starts.
		await source.appendMessage(toolResult("toolu_log", "the source's own result"));
		await source.appendMessage(sourceTurn([{ type: "text", text: "LATER_SOURCE_TURN" }]));

		const stages = await Promise.all(launched.map((options) => fork(source, options?.forkFromEntryId)));
		for (const stage of stages) {
			const messages = stage.buildSessionContext().messages;
			// Each stage holds the source as it was at launch, then answers the call that was open then.
			assert.deepEqual(messages.slice(0, atLaunch.length), atLaunch);
			assert.deepEqual(
				messages.slice(atLaunch.length).map((message) => {
					assert.equal(message.role, "toolResult");
					return { id: message.toolCallId, text: message.content };
				}),
				[{ id: "toolu_log", text: [{ type: "text", text: STAGE_FORK_TOOL_RESULT }] }],
			);
			assert.doesNotMatch(JSON.stringify(messages), /LATER_SOURCE_TURN|the source's own result/);
		}

		// A resumed run launches the stage again; it forks where the first launch did, not where the source is now.
		assert.equal(launch("stage:a")?.forkFromEntryId, launched[0]?.forkFromEntryId);
		assert.notEqual(launched[0]?.forkFromEntryId, source.getLeafId());
	});

	test("parallel steps that wait for a concurrency slot fork where their source was when the parallel was launched (#5481)", async () => {
		const { source, runner } = await durableParallelRun("parallel-fork-point-run");
		const leafAtLaunch = source.getLeafId();
		const { parallel, forkedAt } = runner();

		await parallel(STEPS, { concurrency: 1, context: "fork", forkFromSessionId: source.getSessionId() });

		assert.deepEqual(
			forkedAt.map(({ name, entry }) => [name, entry]),
			[
				["a", leafAtLaunch],
				["b", leafAtLaunch],
				["c", leafAtLaunch],
			],
		);
	});

	test("parallel steps still queued when the run stops fork at the parallel's launch point after a resume (#5481)", async () => {
		const { source, backend, run, runner } = await durableParallelRun("parallel-fork-point-resume");
		const leafAtLaunch = source.getLeafId();
		const options = { concurrency: 1, context: "fork" as const, forkFromSessionId: source.getSessionId() };
		const stopped = new Error("the run stops after the first step's result is recorded");
		const first = runner({
			afterLiveResult: async () => {
				throw stopped;
			},
		});
		await assert.rejects(first.parallel(STEPS, options), (error) => error === stopped);
		assert.ok(backend.getStageOutput(run, "stage:task:a:1"), "the first step's result is recorded");

		// The resumed run replays `a` from its record and starts the steps that were waiting for a slot.
		const resumed = runner();
		await resumed.parallel(STEPS, options);

		assert.deepEqual(
			[...first.forkedAt, ...resumed.forkedAt].map(({ name, entry }) => [name, entry]),
			[
				["a", leafAtLaunch],
				["b", leafAtLaunch],
				["c", leafAtLaunch],
			],
		);
	});

	test("a retried parallel forks its queued steps at the first launch's point, like the retried step (#5481)", async () => {
		const { source, runner } = await durableParallelRun("parallel-fork-point-retry");
		const leafAtLaunch = source.getLeafId();
		const options = { concurrency: 1, context: "fork" as const, forkFromSessionId: source.getSessionId() };
		const failed = new Error("the first step fails before it has a result");
		const first = runner({ failWith: failed });
		await assert.rejects(first.parallel(STEPS.slice(0, 2), options), (error) => error === failed);

		const retried = runner();
		await retried.parallel(STEPS.slice(0, 2), options);

		assert.deepEqual(
			[...first.forkedAt, ...retried.forkedAt].map(({ name, entry }) => [name, entry]),
			[
				["a", leafAtLaunch],
				["a", leafAtLaunch],
				["b", leafAtLaunch],
			],
		);
	});

	test("a parallel launched later forks at its own launch point, also when it is replayed (#5481)", async () => {
		const { source, runner } = await durableParallelRun("parallel-fork-point-per-launch");
		const options = { concurrency: 1, context: "fork" as const, forkFromSessionId: source.getSessionId() };
		const firstLaunch = source.getLeafId();
		const first = runner();
		await first.parallel(STEPS.slice(0, 1), options);
		// The source moved on while the first parallel ran; the same parallel launched again forks where it is now.
		const secondLaunch = source.getLeafId();
		await first.parallel(STEPS.slice(0, 1), options);
		assert.notEqual(secondLaunch, firstLaunch);
		assert.deepEqual(
			first.forkedAt.map(({ entry }) => entry),
			[firstLaunch, secondLaunch],
		);
	});
});

const STEPS = [
	{ name: "a", prompt: "A" },
	{ name: "b", prompt: "B" },
	{ name: "c", prompt: "C" },
];

/**
 * A run whose `ctx.parallel` steps fork a live stage session that makes a turn while each step runs. `runner()` builds
 * the run's durable task and parallel primitives the way the engine does; calling it again is the run resumed in a new
 * process, with the same journal.
 */
async function durableParallelRun(run: string) {
	const backend = await createMemoryTestBackend();
	await backend.commitWorkflowRegistration({
		workflowId: run,
		name: run,
		inputs: {},
		createdAt: 1,
		status: "running",
	});
	const source = await sourceWithOpenCall();
	registerLiveStageSession(source);
	const runtime = {
		runId: run,
		exit: { throwIfWorkflowExitSelected: () => undefined, exitScope: undefined },
		tracker: { currentParents: () => [] },
		activeStore: { run: () => undefined },
	} as unknown as EngineRuntime;
	const runner = (hooks: { afterLiveResult?: () => Promise<void>; failWith?: Error } = {}) => {
		const forkedAt: { name: string; entry: string | undefined }[] = [];
		const nextReplayKey = createStageReplayKeyGenerator(run);
		const task = createDurableTaskPrimitive({
			workflowId: run,
			backend,
			nextReplayKey,
			task: async (name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult> => {
				forkedAt.push({ name, entry: options.forkFromEntryId });
				await source.appendMessage(sourceTurn([{ type: "text", text: `LATER_SOURCE_TURN after ${name}` }]));
				if (hooks.failWith) throw hooks.failWith;
				return { stageName: name, text: `${name} done` };
			},
			...(hooks.afterLiveResult ? { afterLiveResult: hooks.afterLiveResult } : {}),
		});
		const forkPoints = createFanOutForkPoints({ backend, workflowId: run, nextReplayKey });
		return { forkedAt, parallel: createParallelPrimitive({ runtime, task, forkPoints }) };
	};
	return { backend, run, source, runner };
}
