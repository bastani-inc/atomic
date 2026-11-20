import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { test } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type {
	ChatBoxSession,
	TaskMessageLane,
	TaskTranscriptSource,
} from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { FooterComponent } from "../../packages/coding-agent/src/modes/interactive/components/footer.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";
import { makeTestTui } from "../support/fake-tui.js";

const WIDTH = 100;
const HEIGHT = 40;
/** The editor's cursor marker; it is not printable text. */
const APPLICATION_COMMAND = /\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const plain = (line: string): string => stripVTControlCharacters(line.replace(APPLICATION_COMMAND, "")).trimEnd();
/** The attached composer's top rule ends the transcript body. */
const isComposerTopRule = (row: string): boolean => /^─+ .+ ─$/.test(plain(row));

const flush = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") =>
	({
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	}) as AssistantMessage;

/**
 * A running subagent's session as its chat sees it: its saved entries, the events it emits, its own steering and
 * follow-up queue, and the Intercom path that delivers messages from other agents. Intercom writes a message into
 * the transcript as soon as the subagent accepts it, wrapped for the model; the queue keeps a message until the next
 * turn boundary, where the subagent receives it as the user's own message, as the main chat's session does.
 */
async function runningSubagent(prompt: string) {
	const session = SessionManager.inMemory("/repo");
	await session.appendMessage({ role: "user", content: prompt, timestamp: 0 });
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const emit = (event: AgentSessionEvent): void => {
		for (const listener of listeners) listener(event);
	};
	const record = async (message: AgentMessage): Promise<void> => {
		emit({ type: "message_start", message } as AgentSessionEvent);
		if (message.role === "custom")
			await session.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		else await session.appendMessage(message as Parameters<typeof session.appendMessage>[0]);
		emit({ type: "message_end", message } as AgentSessionEvent);
	};
	const queue = { steering: [] as string[], followUp: [] as string[] };
	const queueUpdate = () =>
		emit({ type: "queue_update", steering: [...queue.steering], followUp: [...queue.followUp] } as AgentSessionEvent);
	const intercomSent: string[] = [];
	let tool: { id: string; command: string } | undefined;
	const source: TaskTranscriptSource = Object.assign(session, {
		subscribe(listener: (event: AgentSessionEvent) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		isRunning: () => true,
		getQueuedMessages: () => ({ steering: [...queue.steering], followUp: [...queue.followUp] }),
		async queueMessage(text: string, lane: TaskMessageLane) {
			(lane === "followUp" ? queue.followUp : queue.steering).push(text);
			queueUpdate();
			return { delivered: true } as const;
		},
		completionSource: { runId: "run-1", intercomTarget: "worker-1" },
		async sendMessage(text: string) {
			intercomSent.push(text);
			await record({
				role: "custom",
				customType: "intercom_message",
				content: `**📨 From subagent-chat-01a1e951** (/repo)\n\n${text}`,
				display: true,
				details: {
					from: { id: "01a1e951", name: "subagent-chat-01a1e951", cwd: "/repo" },
					message: { id: "m-1", timestamp: 2, content: { text } },
					bodyText: text,
				},
				timestamp: 2,
			} as AgentMessage);
			return { delivered: true } as const;
		},
	});
	return {
		source,
		intercomSent,
		queued: () => ({ steering: [...queue.steering], followUp: [...queue.followUp] }),
		/** The subagent's reply asks for a command, which runs until {@link deliverAtTurnBoundary}. */
		async startTool(id: string, command: string): Promise<void> {
			emit({ type: "agent_start" } as AgentSessionEvent);
			emit({ type: "turn_start" } as AgentSessionEvent);
			await record(assistant([{ type: "toolCall", id, name: "bash", arguments: { command } }], "toolUse"));
			emit({
				type: "tool_execution_start",
				toolCallId: id,
				toolName: "bash",
				args: { command },
			} as AgentSessionEvent);
			tool = { id, command };
		},
		/**
		 * The command ends and its turn with it; at that boundary the subagent takes the first queued steer, as its own
		 * user message, and answers it.
		 */
		async deliverAtTurnBoundary(output: string, reply: string): Promise<void> {
			assert.ok(tool, "a command is running");
			const result = { content: [{ type: "text" as const, text: output }], details: undefined };
			emit({
				type: "tool_execution_end",
				toolCallId: tool.id,
				toolName: "bash",
				result,
				isError: false,
			} as AgentSessionEvent);
			await record({
				role: "toolResult",
				toolCallId: tool.id,
				toolName: "bash",
				content: result.content,
				isError: false,
				timestamp: 3,
			} as AgentMessage);
			emit({ type: "turn_end" } as AgentSessionEvent);
			tool = undefined;
			const steer = queue.steering.shift();
			assert.ok(steer !== undefined, "a steer waits for this boundary");
			queueUpdate();
			emit({ type: "turn_start" } as AgentSessionEvent);
			await record({ role: "user", content: [{ type: "text", text: steer }], timestamp: 4 });
			await record(assistant([{ type: "text", text: reply }]));
		},
	};
}

/** Opens a subagent's chat from the agent panel, as Enter on its row does. */
async function openSubagentChat(source: TaskTranscriptSource, prompt: string) {
	initTheme("dark");
	const previous = getKeybindings();
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const fixture = taskFixture();
	const environment = taskTranscriptEnvironment({ tui: makeTestTui(HEIGHT), keybindings: keys });
	const inspector = new TaskInspector(
		ownerTaskViewSource(fixture.store),
		() => {},
		() => {},
		undefined,
		() => environment,
	);
	await fixture.start(prompt);
	fixture.runners[0]!.context.bindTranscript(source);
	inspector.openChat(fixture.store.tasks[0]!.ref.taskId);
	await flush();
	const frame = () => inspector.renderViewport(WIDTH, HEIGHT);
	return {
		inspector,
		frame,
		/** The transcript above the composer, without the rows of messages still waiting in the queue. */
		transcript(): string[] {
			const rows = frame();
			const end = rows.findIndex(isComposerTopRule);
			return rows
				.slice(0, end === -1 ? rows.length : end)
				.filter((row) => !/^\s*(?:Steering|Follow-up):|to edit all queued messages/.test(plain(row)));
		},
		async send(text: string): Promise<void> {
			for (const ch of text) inspector.handleInput(ch);
			inspector.handleInput("\r");
			await flush();
		},
		async dispose(): Promise<void> {
			inspector.dispose();
			await fixture.dispose();
			setKeybindings(previous);
		},
	};
}

/** The first segment of the main chat's footer while its agent works: what Esc does, in the main chat's words. */
function mainChatEscHint(): string {
	const model = { provider: "faux", id: "model", reasoning: false, contextWindow: 1000 };
	const session = {
		state: { model, thinkingLevel: "off" },
		model,
		sessionManager: SessionManager.inMemory("/repo"),
		getContextUsage: () => undefined,
		modelRuntime: { isUsingOAuth: () => false },
		isStreaming: true,
		isCompacting: false,
		isRetrying: false,
		isBashRunning: false,
	} as unknown as ChatBoxSession;
	const footer = new FooterComponent(session, {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	});
	try {
		return plain(footer.render(WIDTH)[0] ?? "").split(" · ")[0]!;
	} finally {
		footer.dispose();
	}
}

test("a running subagent's chat words its Esc hint as the main chat's footer does", async () => {
	const subagent = await runningSubagent("run the checks");
	const chat = await openSubagentChat(subagent.source, "run the checks");
	try {
		const esc = mainChatEscHint();
		assert.equal(esc, "esc to interrupt");
		const hint = plain(chat.frame().at(-1) ?? "");
		assert.deepEqual(
			hint
				.trim()
				.split(" · ")
				.filter((segment) => segment.startsWith("esc")),
			[esc],
			`the chat's hint line: ${hint}`,
		);
	} finally {
		await chat.dispose();
	}
});
