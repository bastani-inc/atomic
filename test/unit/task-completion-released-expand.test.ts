import assert from "node:assert/strict";
import { setKeybindings } from "@bastani/atomic-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { taskCompletionNotice } from "../../packages/coding-agent/src/core/tasks/completion.js";
import type { OperationId, Sequence, TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { readTaskCompletionHistory } from "../../packages/coding-agent/src/core/tasks/task-completion-history.js";
import { TaskCompletionMessage } from "../../packages/coding-agent/src/modes/interactive/components/task-completion-message.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantCalls(
	calls: Array<{ id: string; name: string; arguments: Record<string, string> }>,
	timestamp: number,
) {
	return {
		role: "assistant" as const,
		content: calls.map((call) => ({ type: "toolCall" as const, ...call })),
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason: "toolUse" as const,
		timestamp,
	};
}

/**
 * A subagent woken after a release continues its turn with no new prompt: its attempt's own history starts after
 * everything the earlier attempts saved, and holds only calls. Released again while one of them runs, its card says it
 * waits on that call.
 */
async function releasedWokenAttempt(title = "Run the load test") {
	const store = new MemorySessionStore();
	const child = await SessionManager.create(store, process.cwd());
	await child.appendMessage({ role: "user", content: "Run the load test", timestamp: 1 });
	await child.appendMessage(assistantCalls([{ id: "call-0", name: "read", arguments: { path: "README.md" } }], 2));
	await child.appendMessage({
		role: "toolResult",
		toolCallId: "call-0",
		toolName: "read",
		content: [{ type: "text", text: "# Load test\n" }],
		isError: false,
		timestamp: 3,
	});
	const earlierAttempts = [...child.getEntries()];
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: "released-card" }, authorizeLaunch() {} });
	const started = await host.startAgentTask(
		{ kind: "agent", agent: "worker", task: "Run the load test", cwd: process.cwd() },
		"op-released-card" as OperationId,
		(context) => {
			context.bindTranscript({ getSessionId: () => child.getSessionId(), getEntries: () => earlierAttempts });
			return {
				result: (async () => {
					await child.appendMessage({
						role: "toolResult",
						toolCallId: "call-0",
						toolName: "read",
						content: [{ type: "text", text: "# Load test\n" }],
						isError: false,
						timestamp: 4,
					});
					await child.appendMessage(
						assistantCalls([{ id: "call-1", name: "bash", arguments: { command: "npm run loadtest" } }], 5),
					);
					const saved = [...child.getEntries()];
					context.bindTranscript({
						getSessionId: () => child.getSessionId(),
						getEntries: () => [],
						loadHistory: async () => ({ entries: saved }),
					});
					return {
						kind: "completed" as const,
						output: {
							ownerId: context.ref.ownerId,
							taskId: context.ref.taskId,
							artifactId: `output:${context.ref.taskId}`,
							byteCount: "0",
							omittedRanges: [],
						},
					};
				})(),
				cleanup: Promise.resolve({ kind: "reaped" as const }),
			};
		},
	);
	assert.equal(started.ok, true);
	if (!started.ok) throw new Error("the task did not start");
	await host.waitForTask(started.value.taskId);
	const record = host.taskRecords(new Set([started.value.taskId]))[0]!;
	const notice = taskCompletionNotice(
		{
			completionId: "released-card",
			ownerId: record.ref.ownerId,
			taskId: started.value.taskId,
			terminalSequence: "3" as Sequence,
			result: {
				kind: "cancelled",
				cause: "pause",
				released: { waitingOn: [{ toolCallId: "call-1", toolName: "bash" }] },
			},
			display: false,
		},
		{
			kind: "agent",
			title,
			agentName: "worker",
			model: undefined,
			thinking: undefined,
			metrics: { elapsedMs: 79_000 },
		},
	);
	return { host, notice };
}

async function expandedRows(card: TaskCompletionMessage, rendered: { count: number }): Promise<string[]> {
	card.setExpanded(true);
	card.render(100);
	for (let i = 0; i < 40 && rendered.count === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
	return card.render(100).map((row) => stripVTControlCharacters(row).trimEnd());
}

test("a subagent released while it waits shows its tool calls when expanded, the waited call marked waiting", async () => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	const { host, notice } = await releasedWokenAttempt();
	const rendered = { count: 0 };
	const card = new TaskCompletionMessage(notice, false, {
		loadTranscript: async (taskId: TaskId) => {
			const lease = host.resolveTask(taskId);
			return lease.ok ? readTaskCompletionHistory(lease.value) : undefined;
		},
		requestRender: () => {
			rendered.count += 1;
		},
	});

	assert.deepEqual(
		card.render(100).map((row) => stripVTControlCharacters(row)),
		[" ◌ worker is waiting on bash (call-1) · 1m 19s", "   ⎿  (ctrl+o for prompt, tool calls and full result)"],
	);

	const expanded = await expandedRows(card, rendered);
	assert.equal(expanded[0], " ◌ worker is waiting on bash (call-1) · 1m 19s");
	const body = expanded.slice(1).join("\n");
	assert.match(
		body,
		/^ {3}⎿ {2}Prompt\n {6}Run the load test$/m,
		"the task's title stands for the prompt it was launched with",
	);
	assert.doesNotMatch(body, /\(none\)/);
	assert.match(body, /Tool calls[\s\S]*◌ Bash\b[^\n]*npm run loadtest/);
	assert.match(body, /Result[\s\S]*\(no output\)/);
	assert.doesNotMatch(body, /README\.md/, "earlier attempts' calls stay out of this attempt's card");
});

test("a woken run whose task names no prompt leaves the Prompt section out", async () => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	const { host, notice } = await releasedWokenAttempt("");
	const rendered = { count: 0 };
	const card = new TaskCompletionMessage(notice, false, {
		loadTranscript: async (taskId: TaskId) => {
			const lease = host.resolveTask(taskId);
			return lease.ok ? readTaskCompletionHistory(lease.value) : undefined;
		},
		requestRender: () => {
			rendered.count += 1;
		},
	});
	const body = (await expandedRows(card, rendered)).slice(1).join("\n");
	assert.doesNotMatch(body, /Prompt|\(none\)/);
	assert.match(body, /^ {3}⎿ {2}Tool calls\n {6}◌ Bash\(npm run loadtest\)$/m);
});

test("a released subagent with nothing of its own to show does not promise more when folded again", async () => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	const { notice } = await releasedWokenAttempt();
	const rendered = { count: 0 };
	const card = new TaskCompletionMessage(notice, false, {
		hasTranscript: () => true,
		loadTranscript: async () => ({ kind: "task-completion-history" as const, prompt: "", toolCalls: [] }),
		requestRender: () => {
			rendered.count += 1;
		},
	});
	assert.match(
		stripVTControlCharacters(card.render(100).join("\n")),
		/ctrl\+o for prompt, tool calls and full result/,
	);
	assert.deepEqual(await expandedRows(card, rendered), [" ◌ worker is waiting on bash (call-1) · 1m 19s"]);
	card.setExpanded(false);
	assert.deepEqual(
		card.render(100).map((row) => stripVTControlCharacters(row)),
		[" ◌ worker is waiting on bash (call-1) · 1m 19s"],
	);
});
