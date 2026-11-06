import assert from "node:assert/strict";
import type { DetachedToolResult } from "@bastani/atomic";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
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
const INTERRUPTED_TEXT = "A message that arrived just before its owner died.";

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
			"result of ci-1",
			"read the replayed delivery",
			"call ci-2",
		]);
	},
	LIVE_CHILD_TIMEOUT_MS,
);

test(
	"a child resumed on a new prompt reads the delivery its recovery replays first, as any reopened session does (#4488)",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const store = new MemorySessionStore();
		const child = await SessionManager.create(store, env.root);
		env.faux.setResponses([fauxAssistantMessage("Started.")]);
		const finished = await runSingleInProcess(env.root, agent, "start", {
			...env.options("crash-prompt", { sessionManager: child, resumeSession: true }),
		});
		assert.equal(finished.status, "ok");
		await interruptDelivery(store, child.getSessionId());
		env.faux.setResponses([fauxAssistantMessage("Read the message."), fauxAssistantMessage("Continued.")]);

		const resumed = await runSingleInProcess(env.root, agent, "Continue", {
			...env.options("crash-prompt", {
				sessionManager: await SessionManager.open(store, child.getSessionId()),
				resumeSession: true,
			}),
		});

		assert.equal(resumed.status, "ok");
		assert.deepEqual(await transcriptAfterLaunch(store, child.getSessionId()), [
			"read the replayed delivery",
			"assistant reply",
			"user prompt",
			"assistant reply",
		]);
	},
	LIVE_CHILD_TIMEOUT_MS,
);
