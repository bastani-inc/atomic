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
import { withLaunchForkPoint } from "../../packages/workflows/src/durable/stage-fork-point.js";
import { createDurableTaskPrimitive } from "../../packages/workflows/src/durable/stage-primitive.js";
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
		const backend = await createMemoryTestBackend();
		const run = "parallel-fork-point-run";
		await backend.commitWorkflowRegistration({
			workflowId: run,
			name: run,
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		const source = await sourceWithOpenCall();
		registerLiveStageSession(source);
		const leafAtLaunch = source.getLeafId();
		const forkedAt = new Map<string, string | undefined>();
		let keys = 0;
		const task = createDurableTaskPrimitive({
			workflowId: run,
			backend,
			nextReplayKey: (name) => `${name}#${keys++}`,
			task: async (name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult> => {
				forkedAt.set(name, options.forkFromEntryId);
				// The source keeps going while each step runs, before the next step gets the slot.
				await source.appendMessage(sourceTurn([{ type: "text", text: `LATER_SOURCE_TURN after ${name}` }]));
				return { stageName: name, text: `${name} done` };
			},
		});
		const runtime = {
			runId: run,
			exit: { throwIfWorkflowExitSelected: () => undefined, exitScope: undefined },
			tracker: { currentParents: () => [] },
			activeStore: { run: () => undefined },
		} as unknown as EngineRuntime;
		const parallel = createParallelPrimitive({ runtime, task });

		await parallel(
			[
				{ name: "a", prompt: "A" },
				{ name: "b", prompt: "B" },
				{ name: "c", prompt: "C" },
			],
			{ concurrency: 1, context: "fork", forkFromSessionId: source.getSessionId() },
		);

		assert.deepEqual(
			["a", "b", "c"].map((name) => forkedAt.get(name)),
			[leafAtLaunch, leafAtLaunch, leafAtLaunch],
		);
	});
});
