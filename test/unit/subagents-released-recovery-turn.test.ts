import assert from "node:assert/strict";
import type { DetachedToolResult } from "@bastani/atomic";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import { SUBAGENT_STILL_RUNNING_RESULT } from "../../packages/subagents/src/runs/foreground/released-children.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

/** A live child loads its real resources; that load is the structural cost of these tests. */
const LIVE_CHILD_TIMEOUT_MS = 120_000;
const RECONCILIATION = "atomic:protected-streaming-reconciliation";
const REPLAY_NOTICE = "session-recovery-replay";
const INTERRUPTED_TEXT = "A message that arrived just before its owner died.";
const RESUMED_COMPLETION_TIMEOUT_MS = 20_000;

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

const agent: AgentConfig = {
	name: "waiter",
	description: "waits on CI",
	systemPrompt: "",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "user",
	filePath: "/tmp/waiter.md",
};

const waitCall = (id: string) =>
	fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: id }, { id })], { stopReason: "toolUse" });

const stillRunning: DetachedToolResult = {
	toolCallId: "ci-1",
	toolName: "wait_for_ci",
	result: { content: [{ type: "text", text: SUBAGENT_STILL_RUNNING_RESULT }], details: undefined },
	isError: false,
};

/** Save a message as Intercom does when it arrives for a busy session, as a card whose turn has not been taken yet. */
async function interruptDelivery(store: MemorySessionStore, sessionId: string): Promise<void> {
	const saved = await SessionManager.open(store, sessionId);
	await saved.appendCustomMessageEntry(
		"intercom_message",
		INTERRUPTED_TEXT,
		true,
		{ message: { id: "interrupted-1" } },
		true,
		{ delivery: "steer" },
	);
}

/**
 * A child released on `ci-1`, then woken, whose owner's process died after Intercom saved a message for it and
 * before it read that message: its session ends on the unanswered call and the saved delivery (#4488).
 */
async function crashedWhileWoken(env: Awaited<ReturnType<typeof liveChildEnvironment>>, runId: string) {
	const store = new MemorySessionStore();
	const child = await SessionManager.create(store, env.root);
	env.faux.setResponses([waitCall("ci-1")]);
	const released = await runSingleInProcess(env.root, agent, "watch CI", {
		...env.options(runId, { sessionManager: child, resumeSession: true, releaseWhenWaiting: { afterMs: 0 } }),
	});
	assert.deepEqual(
		released.released?.waitingOn.map((call) => call.toolCallId),
		["ci-1"],
	);
	await interruptDelivery(store, child.getSessionId());
	return { store, sessionId: child.getSessionId() };
}

/** The saved transcript after the launch: tool results, assistant calls, user prompts and the replayed delivery. */
async function transcriptAfterLaunch(store: MemorySessionStore, sessionId: string): Promise<string[]> {
	const entries = (await SessionManager.open(store, sessionId)).getEntries();
	const firstCall = entries.findIndex((entry) => entry.type === "message" && entry.message.role === "assistant");
	return entries.slice(firstCall + 1).flatMap((entry) => {
		if (entry.type === "custom_message" && entry.customType === RECONCILIATION) return ["read the replayed delivery"];
		if (entry.type === "custom_message" && entry.customType === REPLAY_NOTICE)
			return [`replayed on ${(entry.details as { readonly reason?: string }).reason}`];
		if (entry.type !== "message") return [];
		const { message } = entry;
		if (message.role === "toolResult") return [`result of ${message.toolCallId}`];
		if (message.role === "user") return ["user prompt"];
		if (message.role !== "assistant") return [];
		const calls = message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []));
		return [calls.length > 0 ? `call ${calls.join(",")}` : "assistant reply"];
	});
}

test(
	"a child woken onto the turn it waits on answers that turn before it reads the delivery its recovery replays, and is released again (#4488)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const { store, sessionId } = await crashedWhileWoken(env, "crash-woken");
		env.faux.setResponses([waitCall("ci-2")]);

		const woken = await runSingleInProcess(env.root, agent, "Resume", {
			...env.options("crash-woken", {
				sessionManager: await SessionManager.open(store, sessionId),
				resumeSession: true,
				releaseWhenWaiting: { afterMs: 0 },
				resumeToolResults: [stillRunning],
				skipTaskPrompt: true,
			}),
		});

		assert.equal(woken.error, undefined);
		assert.deepEqual(
			woken.released?.waitingOn.map((call) => call.toolCallId),
			["ci-2"],
			"released again on the call of its next turn",
		);
		assert.deepEqual(await transcriptAfterLaunch(store, sessionId), [
			"replayed on resume",
			"result of ci-1",
			"read the replayed delivery",
			"call ci-2",
		]);
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a child restored by running the call it waits on again leaves the delivery its recovery replays for after that call, and is released again (#4488)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const { store, sessionId } = await crashedWhileWoken(env, "crash-redispatch");
		// A model request before the call's result would answer with a new call.
		env.faux.setResponses([waitCall("ci-2")]);

		const restored = await runSingleInProcess(env.root, agent, "Resume", {
			...env.options("crash-redispatch", {
				sessionManager: await SessionManager.open(store, sessionId),
				resumeSession: true,
				releaseWhenWaiting: { afterMs: 0 },
				redispatchDetachedCalls: true,
				skipTaskPrompt: true,
			}),
		});

		assert.equal(restored.error, undefined);
		assert.deepEqual(
			restored.released?.waitingOn.map((call) => call.toolCallId),
			["ci-1"],
			"released again on the call it runs again",
		);
		assert.equal(
			env.faux.getPendingResponseCount(),
			1,
			"no model request starts on top of the call it still waits on",
		);
		const transcript = await transcriptAfterLaunch(store, sessionId);
		assert.equal(transcript[0], "replayed on resume");
		assert.deepEqual(
			transcript.filter((entry) => entry.startsWith("call ") || entry === "assistant reply"),
			[],
			"nor any reply",
		);
	},
	LIVE_CHILD_TIMEOUT_MS,
);

/** A session that ran once and was then left holding a delivery saved while it was busy, which nothing read. */
async function finishedWithInterruptedDelivery(env: Awaited<ReturnType<typeof liveChildEnvironment>>, runId: string) {
	const store = new MemorySessionStore();
	const child = await SessionManager.create(store, env.root);
	env.faux.setResponses([fauxAssistantMessage("Started.")]);
	const finished = await runSingleInProcess(env.root, agent, "start", {
		...env.options(runId, { sessionManager: child, resumeSession: true }),
	});
	assert.equal(finished.status, "ok");
	await interruptDelivery(store, child.getSessionId());
	return { store, sessionId: child.getSessionId() };
}

test(
	"a child resumed on a new prompt reads the delivery its recovery replays first, as any reopened session does (#4488)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const { store, sessionId } = await finishedWithInterruptedDelivery(env, "crash-prompt");
		env.faux.setResponses([fauxAssistantMessage("Read the message."), fauxAssistantMessage("Continued.")]);

		const resumed = await runSingleInProcess(env.root, agent, "Continue", {
			...env.options("crash-prompt", {
				sessionManager: await SessionManager.open(store, sessionId),
				resumeSession: true,
			}),
		});

		assert.equal(resumed.status, "ok");
		assert.deepEqual(await transcriptAfterLaunch(store, sessionId), [
			"replayed on resume",
			"read the replayed delivery",
			"assistant reply",
			"user prompt",
			"assistant reply",
		]);
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a child started on a session it does not resume, as a fork is, never replays that session's interrupted deliveries (#4488)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const { store, sessionId } = await finishedWithInterruptedDelivery(env, "crash-fork");
		env.faux.setResponses([fauxAssistantMessage("Forked.")]);

		const forked = await runSingleInProcess(env.root, agent, "Work from here", {
			...env.options("crash-fork", { sessionManager: await SessionManager.open(store, sessionId) }),
		});

		assert.equal(forked.status, "ok");
		assert.deepEqual(await transcriptAfterLaunch(store, sessionId), ["user prompt", "assistant reply"]);
	},
	LIVE_CHILD_TIMEOUT_MS,
);

function within<T>(work: Promise<T>, ms: number, failure: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(failure)), ms);
		work.finally(() => clearTimeout(timer)).then(resolve, reject);
	});
}

function resumeOnReplayAlone(
	env: Awaited<ReturnType<typeof liveChildEnvironment>>,
	store: MemorySessionStore,
	sessionId: string,
	runId: string,
) {
	const stop = new AbortController();
	const chat = Promise.withResolvers<TaskTranscriptSource>();
	const blocks = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	let bound = false;
	let blocked = 0;
	const run = SessionManager.open(store, sessionId).then((sessionManager) =>
		runSingleInProcess(env.root, agent, "Resume", {
			...env.options(runId, {
				signal: stop.signal,
				sessionManager,
				resumeSession: true,
				skipTaskPrompt: true,
				taskExecution: {
					signal: stop.signal,
					reportActivity() {},
					bindTranscript(source) {
						const session = source.chatSession as AgentSession | undefined;
						if (bound || session === undefined) return;
						bound = true;
						session.subscribe((event) => {
							if (event.type === "tool_execution_start" && event.toolName === "block")
								blocks[blocked++]?.resolve();
						});
						chat.resolve(source);
					},
					onExecution() {},
				},
			}),
		}),
	);
	return {
		run,
		chat: chat.promise,
		blockStarted: (index: number) => blocks[index]!.promise,
		stop: () => stop.abort("user"),
	};
}

test(
	"a child woken with nothing but the delivery its recovery replays reads it and completes (#5246)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const { store, sessionId } = await finishedWithInterruptedDelivery(env, "replay-alone");
		env.faux.setResponses([fauxAssistantMessage("Read the message.")]);
		const resumed = resumeOnReplayAlone(env, store, sessionId, "replay-alone");
		try {
			const result = await within(resumed.run, RESUMED_COMPLETION_TIMEOUT_MS, "the resumed child never completed");
			assert.equal(result.status, "ok");
			assert.deepEqual(await transcriptAfterLaunch(store, sessionId), [
				"replayed on resume",
				"read the replayed delivery",
				"assistant reply",
			]);
		} finally {
			resumed.stop();
			await resumed.run.catch(() => undefined);
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test.each([
	{ interrupts: 1, times: "once" },
	{ interrupts: 2, times: "twice" },
])(
	"a child interrupted $times while it reads the delivery its recovery replays answers its next message and completes (#5246)",
	async ({ interrupts }) => {
		const env = await liveChildEnvironment(cleanups);
		const runId = `replay-interrupted-${interrupts}`;
		const { store, sessionId } = await finishedWithInterruptedDelivery(env, runId);
		env.faux.setResponses([
			...Array.from({ length: interrupts }, (_, index) =>
				fauxAssistantMessage([fauxToolCall("block", {}, { id: `block-${index + 1}` })], { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("Finished after the interrupt."),
		]);
		const resumed = resumeOnReplayAlone(env, store, sessionId, runId);
		try {
			const chat = await within(
				resumed.chat,
				RESUMED_COMPLETION_TIMEOUT_MS,
				"the resumed child never opened its chat",
			);
			const session = chat.chatSession as AgentSession;
			for (let index = 0; index < interrupts; index++) {
				await within(
					resumed.blockStarted(index),
					RESUMED_COMPLETION_TIMEOUT_MS,
					`the resumed child never started turn ${index + 1}`,
				);
				await chat.interruptTurn!();
				await session.sendCustomMessage(
					{ customType: "intercom_message", content: `Message ${index + 1}`, display: true },
					{ triggerTurn: true },
				);
			}
			const result = await within(
				resumed.run,
				RESUMED_COMPLETION_TIMEOUT_MS,
				"the interrupted child never answered its next message",
			);
			assert.equal(result.status, "ok");
			assert.match(result.finalOutput ?? "", /Finished after the interrupt\./);
			assert.equal(env.faux.getPendingResponseCount(), 0, "every turn the messages started was answered");
		} finally {
			resumed.stop();
			await resumed.run.catch(() => undefined);
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);
