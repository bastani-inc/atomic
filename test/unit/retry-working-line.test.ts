import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage, UserMessage } from "@bastani/atomic-ai/compat";
import { Container, getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { themedChatHostStyle } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { WorkingRunMeter } from "../../packages/coding-agent/src/modes/interactive/components/working-run-meter.js";
import "../../packages/coding-agent/src/modes/interactive/interactive-agent-events.js";
import "../../packages/coding-agent/src/modes/interactive/interactive-prompt-turn.js";
import "../../packages/coding-agent/src/modes/interactive/interactive-extension-runtime.js";
import { InteractiveModeBase } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.js";
import { ProgramStatusReporter } from "../../packages/coding-agent/src/modes/interactive/program-status-reporter.js";
import {
	getEditorTheme,
	getMarkdownTheme,
	initTheme,
} from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";
import { makeTestTui } from "../support/fake-tui.js";

const plain = (lines: readonly string[]): string[] => lines.map((line) => stripVTControlCharacters(line).trimEnd());

function assistant(text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
		timestamp: 0,
	};
}

let now = 0;
let previousKeybindings: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeybindings = getKeybindings();
	setKeybindings(new KeybindingsManager());
	now = 0;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
	setKeybindings(previousKeybindings);
	vi.restoreAllMocks();
});

/** The main chat's event handling, rendering its status row. */
function mainChat(prepare?: (mode: InteractiveModeBase) => void) {
	const statusContainer = new Container();
	const settingsManager = {
		getShowTerminalProgress: () => false,
		getClearOnShrink: () => false,
		getShowCacheMissNotices: () => false,
		getLatexRenderingEnabled: () => true,
	};
	const session = {
		isStreaming: true,
		isCompacting: false,
		compactionReason: undefined,
		pendingMessageCount: 0,
		settingsManager,
		sessionManager: SessionManager.inMemory(),
		modelRuntime: {},
		agent: { waitForIdle: async () => {} },
		abortRetry() {},
	};
	const mode = Object.assign(Object.create(InteractiveModeBase.prototype), {
		isInitialized: true,
		ui: { requestRender() {}, terminal: { setProgress() {} } },
		footer: { invalidate() {} },
		programStatus: new ProgramStatusReporter(
			() => ({ setProgramStatus() {} }) as never,
			() => undefined,
		),
		runtimeHost: { session },
		statusContainer,
		chatContainer: new Container(),
		pendingMessagesContainer: new Container(),
		pendingTools: new Map(),
		compactionQueuedMessages: [],
		workingRunMeter: new WorkingRunMeter(),
		defaultEditor: { onEscape: undefined as (() => void) | undefined, setWorkingStatusIndicator() {} },
		setEditorWorkingStatusIndicator: undefined,
		workingVisible: true,
		workingMessage: undefined,
		defaultWorkingMessage: "Working…",
		defaultHiddenThinkingLabel: "Thinking...",
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 1,
		toolOutputExpanded: false,
		getMarkdownThemeWithSettings: getMarkdownTheme,
		getMarkdownTransformers: () => [],
		maybeShowAssistantDiagnostics() {},
		maybeShowInstallChangeWarning: () => false,
		checkShutdownRequested: async () => {},
		updatePendingMessagesDisplay() {},
		showError() {},
	}) as InteractiveModeBase;
	prepare?.(mode);
	return {
		emit: (event: AgentSessionEvent) => mode.handleEvent(event),
		status: () => plain(statusContainer.render(100)).filter((line) => line.trim().length > 0),
		dispose: () => mode.stopWorkingLoader(),
	};
}

/** The chat host every subagent and workflow stage chat draws on. */
function attachedChat() {
	const host = new ChatSessionHost({ style: themedChatHostStyle(), editorTheme: getEditorTheme() });
	return {
		emit: async (event: AgentSessionEvent) => {
			host.applyAgentEvent(event);
		},
		status: () => plain(host.renderWorkingStatus(100)).filter((line) => line.trim().length > 0),
		dispose: () => host.dispose(),
	};
}

type Chat = ReturnType<typeof mainChat>;

const RETRY_START = {
	type: "auto_retry_start",
	attempt: 1,
	maxAttempts: 3,
	delayMs: 4_800,
	errorMessage: "529 overloaded_error: Overloaded",
} as AgentSessionEvent;
const RETRY_END = { type: "auto_retry_end", success: true, attempt: 1 } as AgentSessionEvent;
const FALLBACK_START = {
	type: "model_fallback_start",
	from: "anthropic/claude-haiku-4-5",
	to: "openai/gpt-5.4",
	reason: "529 overloaded_error: Overloaded",
	attempt: 1,
} as AgentSessionEvent;
// A session settles its fallback after the turn on the fallback model ends.
const FALLBACK_END = { type: "model_fallback_end", success: true, from: "openai/gpt-5.4" } as AgentSessionEvent;

/** A turn whose first request fails at once and is retried after a wait: its second attempt starts at 5 s. */
async function failFirstAttempt(chat: Chat, retry: AgentSessionEvent = RETRY_START): Promise<void> {
	await chat.emit({ type: "agent_start" } as AgentSessionEvent);
	await chat.emit({ type: "turn_start" } as AgentSessionEvent);
	now = 200;
	const failed = assistant("", "error", "529 overloaded_error: Overloaded");
	await chat.emit({ type: "message_start", message: failed } as AgentSessionEvent);
	await chat.emit({ type: "message_end", message: failed } as AgentSessionEvent);
	await chat.emit({ type: "turn_end", message: failed, toolResults: [] } as unknown as AgentSessionEvent);
	await chat.emit({ type: "agent_end", messages: [failed] } as AgentSessionEvent);
	await chat.emit(retry);
}

async function answerSecondAttempt(
	chat: Chat,
	end: AgentSessionEvent = RETRY_END,
): Promise<{ working: string[]; worked: string[] }> {
	now = 5_000;
	await chat.emit({ type: "agent_start" } as AgentSessionEvent);
	await chat.emit({ type: "turn_start" } as AgentSessionEvent);
	await chat.emit({ type: "message_start", message: assistant("", "stop") } as AgentSessionEvent);
	now = 7_000;
	const answer = assistant("Fixed the picker.", "stop");
	await chat.emit({
		type: "message_update",
		message: answer,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Fixed the picker." },
	} as unknown as AgentSessionEvent);
	const working = chat.status();
	now = 8_000;
	await chat.emit({ type: "message_end", message: answer } as AgentSessionEvent);
	await chat.emit({ type: "turn_end", message: answer, toolResults: [] } as unknown as AgentSessionEvent);
	await chat.emit({ type: "agent_end", messages: [answer] } as AgentSessionEvent);
	await chat.emit(end);
	return { working, worked: chat.status() };
}

describe("the working line counts a turn from its start through its retries (#5535)", () => {
	test.each(["success", "cancel"])(
		"main chat keeps the final row after a retried prompt settles: %s (#5535)",
		async (outcome) => {
			let submit!: () => Promise<void>;
			const chat = mainChat((mode) => {
				// Every listener hears every event, as with a session.
				const observers = new Set<(event: AgentSessionEvent) => void>();
				Object.assign(mode.session, {
					isStreaming: false,
					subscribe(listener: (event: AgentSessionEvent) => void) {
						observers.add(listener);
						return () => {
							observers.delete(listener);
						};
					},
					resumeQueuedMessages: async () => {},
					async prompt() {
						const source = {
							...chat,
							emit: async (event: AgentSessionEvent) => {
								for (const observer of [...observers]) observer(event);
								await chat.emit(event);
							},
						};
						await failFirstAttempt(source);
						if (outcome === "success") await answerSecondAttempt(source);
						else {
							now = 8_000;
							await chat.emit({
								type: "auto_retry_end",
								success: false,
								attempt: 1,
								finalError: "Retry cancelled",
							});
						}
					},
				});
				submit = () => mode.runUserPromptTurn("Retry this turn");
			});
			try {
				await submit();
				assert.match(chat.status().join("\n"), / for 8s/);
			} finally {
				chat.dispose();
			}
		},
	);

	for (const [name, open] of [
		["main chat", mainChat],
		["subagent chat", attachedChat],
	] as const) {
		test(`${name}: the retried attempt and the finished turn count from the turn's start (#5535)`, async () => {
			const chat = open();
			try {
				await failFirstAttempt(chat);
				const { working, worked } = await answerSecondAttempt(chat);
				assert.ok(
					working.some((line) => / \(7s · /.test(line)),
					`the second attempt's working line counts from the turn's start: ${working.join(" | ")}`,
				);
				assert.ok(
					worked.some((line) => / for 8s/.test(line)),
					`the finished turn counts from its start: ${worked.join(" | ")}`,
				);
			} finally {
				chat.dispose();
			}
		});

		test(`${name}: a turn moved to a fallback model keeps its count, and its finished row stays (#5535)`, async () => {
			const chat = open();
			try {
				await failFirstAttempt(chat, FALLBACK_START);
				const { working, worked } = await answerSecondAttempt(chat, FALLBACK_END);
				assert.ok(
					working.some((line) => / \(7s · /.test(line)),
					`the fallback model's attempt counts from the turn's start: ${working.join(" | ")}`,
				);
				assert.ok(
					worked.some((line) => / for 8s/.test(line)),
					`the finished turn counts from its start: ${worked.join(" | ")}`,
				);
			} finally {
				chat.dispose();
			}
		});

		test(`${name}: a turn that runs out of fallback models keeps its row (#5535)`, async () => {
			const chat = open();
			try {
				await failFirstAttempt(chat, FALLBACK_START);
				now = 5_000;
				await chat.emit({ type: "agent_start" } as AgentSessionEvent);
				await chat.emit({ type: "turn_start" } as AgentSessionEvent);
				now = 8_000;
				const failed = assistant("", "error", "529 overloaded_error: Overloaded");
				await chat.emit({ type: "message_end", message: failed } as AgentSessionEvent);
				await chat.emit({ type: "agent_end", messages: [failed] } as AgentSessionEvent);
				await chat.emit({
					type: "model_fallback_end",
					success: false,
					from: "openai/gpt-5.4",
					finalError: "529 overloaded_error: Overloaded",
				} as AgentSessionEvent);
				const worked = chat.status();
				assert.ok(
					worked.some((line) => / for 8s/.test(line)),
					`the turn counts from its start until its last model failed: ${worked.join(" | ")}`,
				);
			} finally {
				chat.dispose();
			}
		});

		test(`${name}: a retry cancelled during its wait ends the turn's count at the cancellation (#5535)`, async () => {
			const chat = open();
			try {
				await failFirstAttempt(chat);
				now = 12_000;
				await chat.emit({
					type: "auto_retry_end",
					success: false,
					attempt: 1,
					finalError: "Retry cancelled",
				} as AgentSessionEvent);
				const worked = chat.status();
				assert.ok(
					worked.some((line) => / for 12s/.test(line)),
					`the turn counts until its retry was cancelled: ${worked.join(" | ")}`,
				);
			} finally {
				chat.dispose();
			}
		});

		test(`${name}: after a retry cancelled during its wait, a model switch before the next turn's first request leaves that turn its own count (#5535)`, async () => {
			const chat = open();
			try {
				await failFirstAttempt(chat);
				now = 6_000;
				await chat.emit({
					type: "auto_retry_end",
					success: false,
					attempt: 1,
					finalError: "Retry cancelled",
				} as AgentSessionEvent);
				now = 60_000;
				await chat.emit({ ...FALLBACK_START, reason: "No API key found for anthropic" } as AgentSessionEvent);
				await chat.emit({ type: "agent_start" } as AgentSessionEvent);
				await chat.emit({ type: "turn_start" } as AgentSessionEvent);
				await chat.emit({ type: "message_start", message: assistant("", "stop") } as AgentSessionEvent);
				now = 63_000;
				await chat.emit({
					type: "message_update",
					message: assistant("Next.", "stop"),
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Next." },
				} as unknown as AgentSessionEvent);
				const working = chat.status();
				assert.ok(
					working.some((line) => / \(3s · /.test(line)),
					`the new turn counts from its own start: ${working.join(" | ")}`,
				);
			} finally {
				chat.dispose();
			}
		});

		test(`${name}: a model switch before a turn's first request leaves the turn its own count (#5535)`, async () => {
			const chat = open();
			try {
				// A turn that finished at 2 s.
				await chat.emit({ type: "agent_start" } as AgentSessionEvent);
				await chat.emit({ type: "turn_start" } as AgentSessionEvent);
				now = 2_000;
				const done = assistant("Done.", "stop");
				await chat.emit({ type: "message_end", message: done } as AgentSessionEvent);
				await chat.emit({ type: "agent_end", messages: [done] } as AgentSessionEvent);
				// A minute later the next prompt finds no key for its model and starts on the fallback model.
				now = 60_000;
				await chat.emit({ ...FALLBACK_START, reason: "No API key found for anthropic" } as AgentSessionEvent);
				await chat.emit({ type: "agent_start" } as AgentSessionEvent);
				await chat.emit({ type: "turn_start" } as AgentSessionEvent);
				await chat.emit({ type: "message_start", message: assistant("", "stop") } as AgentSessionEvent);
				now = 63_000;
				await chat.emit({
					type: "message_update",
					message: assistant("Next.", "stop"),
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Next." },
				} as unknown as AgentSessionEvent);
				const working = chat.status();
				assert.ok(
					working.some((line) => / \(3s · /.test(line)),
					`the new turn counts from its own start: ${working.join(" | ")}`,
				);
			} finally {
				chat.dispose();
			}
		});
	}

	/** The next attempt of a turn whose first request, sent at 1 s, failed: the chat opened while it waited. */
	async function nextAttempt(emit: (event: AgentSessionEvent) => void, status: () => string[]) {
		now = 6_000;
		emit({ type: "agent_start" } as AgentSessionEvent);
		emit({ type: "turn_start" } as AgentSessionEvent);
		emit({ type: "message_start", message: assistant("", "stop") } as AgentSessionEvent);
		now = 8_000;
		emit({
			type: "message_update",
			message: assistant("Fixed the picker.", "stop"),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Fixed the picker." },
		} as unknown as AgentSessionEvent);
		return status();
	}

	const waitingTurn = (): Array<UserMessage | AssistantMessage> => [
		{ role: "user", content: "Fix the picker", timestamp: 1_000 },
		{ ...assistant("", "error", "529 overloaded_error: Overloaded"), timestamp: 1_200 },
	];

	/** A subagent's chat opened at 5 s while the subagent waits to retry the request it sent at 1 s. */
	async function subagentChatOpenedInRetryWait(switching = false) {
		now = 5_000;
		const history = SessionManager.inMemory();
		for (const message of waitingTurn()) await history.appendMessage(message);
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		const transcript: TaskTranscriptSource = Object.assign(history, {
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			isRunning: () => switching,
			chatSession: {
				...(switching ? { retryStatus: FALLBACK_START, turnStartedAt: 1_000 } : {}),
				retryAttempt: switching ? 0 : 1,
				isStreaming: switching,
				sessionManager: history,
				state: {},
				getContextUsage: () => undefined,
				modelRuntime: { isUsingOAuth: () => false },
			} as unknown as TaskTranscriptSource["chatSession"],
		});
		const fixture = taskFixture();
		await fixture.start("Fix the picker");
		fixture.runners[0]!.context.bindTranscript(transcript);
		const environment = taskTranscriptEnvironment({ tui: makeTestTui(30), keybindings: getKeybindings() });
		const inspector = new TaskInspector(
			ownerTaskViewSource(fixture.store),
			() => {},
			() => {},
			undefined,
			() => environment,
		);
		inspector.openChat(fixture.store.tasks[0]!.ref.taskId);
		for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
		return {
			emit(event: AgentSessionEvent) {
				for (const listener of listeners) listener(event);
			},
			rows: () => plain(inspector.renderViewport(100, 30)),
			async dispose() {
				inspector.dispose();
				await fixture.dispose();
			},
		};
	}

	test("subagent chat opened while the subagent waits to retry: the next attempt counts from the turn's start (#5535)", async () => {
		const chat = await subagentChatOpenedInRetryWait();
		try {
			assert.ok(chat.rows().some((row) => row.includes("Retrying…")));
			const rows = await nextAttempt(chat.emit, chat.rows);
			assert.ok(
				rows.some((row) => / \(7s · /.test(row)),
				`the next attempt counts from the turn's start: ${rows.filter((row) => row.includes("∀")).join(" | ")}`,
			);
		} finally {
			await chat.dispose();
		}
	});

	test("a subagent chat opened during the model switch retains the first request's time through the next attempt (#5535)", async () => {
		const chat = await subagentChatOpenedInRetryWait(true);
		try {
			assert.match(chat.rows().join("\n"), /Switching model/);
			const rows = await nextAttempt(chat.emit, chat.rows);
			assert.match(rows.join("\n"), /\(7s · /);
		} finally {
			await chat.dispose();
		}
	});

	test("subagent chat opened while the subagent waits to retry: a cancelled retry ends the turn's count then (#5535)", async () => {
		const chat = await subagentChatOpenedInRetryWait();
		try {
			now = 12_000;
			chat.emit({
				type: "auto_retry_end",
				success: false,
				attempt: 1,
				finalError: "Retry cancelled",
			} as AgentSessionEvent);
			const rows = chat.rows();
			assert.ok(
				rows.some((row) => / for 11s/.test(row)),
				`the turn counts from its start until the cancellation: ${rows.filter((row) => row.includes("∀")).join(" | ")}`,
			);
		} finally {
			await chat.dispose();
		}
	});
});
