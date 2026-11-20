import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { TranscriptContext } from "@bastani/atomic-ai";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Container, getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, test } from "vitest";
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
import "../../packages/coding-agent/src/modes/interactive/interactive-agent-events.js";
import { InteractiveModeBase } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.js";
import "../../packages/coding-agent/src/modes/interactive/interactive-render-chat.js";
import { getMarkdownTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { LIVE_CHILD_START_WAIT_MS, liveChildEnvironment } from "../helpers/live-child-environment.js";
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

/** The rows the main chat draws for a user message its session delivers. */
function mainChatUserRows(text: string, width: number): string[] {
	const chatContainer = new Container();
	const main = {
		chatContainer,
		outputPad: 1,
		toolOutputExpanded: false,
		settingsManager: { getLatexRenderingEnabled: () => true },
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getMarkdownTransformers: () => [],
		getUserMessageText: InteractiveModeBase.prototype.getUserMessageText,
	};
	InteractiveModeBase.prototype.addMessageToChat.call(main as unknown as InteractiveModeBase, {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 4,
	});
	return chatContainer.render(width);
}

/**
 * `text` is drawn once, with the rows the main chat draws for a message its session delivered, between the rows that
 * contain `after` and `before`, and never as an Intercom message.
 */
function assertDrawnAsDelivered(rows: readonly string[], text: string, at: { after: string; before: string }): void {
	const userRows = mainChatUserRows(text, WIDTH);
	const starts = rows.flatMap((_, index) =>
		userRows.every((row, offset) => rows[index + offset] === row) ? [index] : [],
	);
	assert.equal(starts.length, 1, "one user row, drawn with the main chat's rows for a delivered message");
	const start = starts[0]!;
	const after = rows.findIndex((row) => plain(row).includes(at.after));
	const before = rows.findIndex((row) => plain(row).includes(at.before));
	assert.ok(after !== -1 && after < start, "after the results of the turn it was delivered after");
	assert.ok(before > start + userRows.length - 1, "before the reply to it");
	const shown = rows.map(plain).join("\n");
	assert.equal(shown.split(text).length - 1, 1, `${text} is drawn once`);
	assert.doesNotMatch(shown, /Message from|📨/);
}

/** Opens a subagent's chat from the agent panel, as Enter on its row does. */
async function openSubagentChat(source: TaskTranscriptSource, prompt: string) {
	initTheme("dark");
	const previous = getKeybindings();
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const fixture = taskFixture();
	const environment = taskTranscriptEnvironment({ tui: makeTestTui(HEIGHT), keybindings: keys });
	await fixture.start(prompt);
	fixture.runners[0]!.context.bindTranscript(source);
	const open = async (): Promise<TaskInspector> => {
		const opened = new TaskInspector(
			ownerTaskViewSource(fixture.store),
			() => {},
			() => {},
			undefined,
			() => environment,
		);
		opened.openChat(fixture.store.tasks[0]!.ref.taskId);
		await flush();
		return opened;
	};
	let inspector = await open();
	const frame = () => inspector.renderViewport(WIDTH, HEIGHT);
	return {
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
		/** Leaves the chat and opens it again, which reads the subagent's saved transcript. */
		async reopen(): Promise<void> {
			inspector.dispose();
			inspector = await open();
		},
		async dispose(): Promise<void> {
			inspector.dispose();
			await fixture.dispose();
			setKeybindings(previous);
		},
	};
}

test("a steer typed into a running subagent's chat is drawn where the subagent receives it, exactly as the main chat draws a delivered steer", async () => {
	const subagent = await runningSubagent("run the checks");
	const chat = await openSubagentChat(subagent.source, "run the checks");
	try {
		await subagent.startTool("call-1", "sleep 7");
		await chat.send("steer one");

		const waiting = chat.transcript().map(plain).join("\n");
		assert.doesNotMatch(waiting, /Message from|📨/, "a chat's message is no Intercom message from another agent");
		assert.doesNotMatch(waiting, /steer one/, "nothing is drawn in the transcript before the subagent receives it");
		assert.deepEqual(subagent.intercomSent, []);
		assert.deepEqual(
			subagent.queued(),
			{ steering: ["steer one"], followUp: [] },
			"the subagent's own queue holds the typed text, unwrapped, until its next turn boundary",
		);

		await subagent.deliverAtTurnBoundary("round1", "ack steer");
		await flush();

		assertDrawnAsDelivered(chat.transcript(), "steer one", { after: "⎿  round1", before: "ack steer" });
		assert.doesNotMatch(chat.frame().map(plain).join("\n"), /Steering:/, "the delivered steer has left the queue");

		await chat.reopen();
		assertDrawnAsDelivered(chat.transcript(), "steer one", { after: "⎿  round1", before: "ack steer" });
	} finally {
		await chat.dispose();
	}
});

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

test("a running subagent's chat words its Esc hint as the main chat's footer does, naming the pause its Esc makes", async () => {
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
			// The same words; Esc in a subagent's chat pauses it, where the main chat's interrupts its turn.
			[esc.replace("interrupt", "pause")],
			`the chat's hint line: ${hint}`,
		);
	} finally {
		await chat.dispose();
	}
});

/** A live child loads its real resources; that load is the structural cost of this test. */
const LIVE_CHILD_TIMEOUT_MS = 120_000;
const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

async function until(what: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!predicate() && performance.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 5));
	assert.ok(predicate(), `waited for ${what}`);
}

/** What the model received since it last spoke, as `role:text`. */
function requestTail(context: TranscriptContext): string[] {
	const messages = context.messages;
	let last = messages.length - 1;
	while (last >= 0 && messages[last]!.role !== "assistant") last--;
	return messages.slice(last + 1).flatMap((message) => {
		if (message.role === "system") return [];
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: content.map((part) => (part.type === "text" ? part.text : "")).join("");
		return [`${message.role === "toolResult" ? "tool" : message.role}:${text}`];
	});
}

test(
	"a live subagent's chat draws a steer where its model receives it, as the main chat draws it",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const requests: TranscriptContext[] = [];
		env.faux.setResponses(
			[
				fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "one" }, { id: "wait-1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("ack steer"),
			].map((response) => (context: TranscriptContext) => {
				requests.push(structuredClone(context));
				return response;
			}),
		);
		let source: TaskTranscriptSource | undefined;
		const stop = new AbortController();
		cleanups.push(() => stop.abort("user"));
		const worker: AgentConfig = {
			name: "worker",
			description: "worker agent",
			systemPrompt: "",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "user",
			filePath: "/tmp/worker.md",
		};
		const result = runSingleInProcess(env.root, worker, "run the checks", {
			...env.options("delivered-steer-row", {
				signal: stop.signal,
				taskExecution: {
					signal: stop.signal,
					reportActivity() {},
					bindTranscript(bound) {
						source = bound;
					},
					onExecution() {},
				},
			}),
		});
		await until("the subagent's command to run", () => env.answers.length === 1, LIVE_CHILD_START_WAIT_MS);
		const chat = await openSubagentChat(source!, "run the checks");
		try {
			await chat.send("steer one");
			await until(
				"the steer to wait in the subagent's own queue",
				() => source!.getQueuedMessages?.().steering.includes("steer one") === true,
			);
			assert.doesNotMatch(chat.transcript().map(plain).join("\n"), /steer one|Message from|📨/);

			env.answers[0]!({ content: [{ type: "text", text: "round1" }], details: undefined });
			assert.equal((await result).status, "ok");
			assert.deepEqual(requestTail(requests[1]!), ["tool:round1", "user:steer one"], "the model receives it raw");
			await until("the reply to the steer", () => chat.transcript().some((row) => plain(row).includes("ack steer")));
			assertDrawnAsDelivered(chat.transcript(), "steer one", { after: "round1", before: "ack steer" });
		} finally {
			await chat.dispose();
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);
