import assert from "node:assert/strict";
import { setKeybindings, stripTerminalSequences, TuiMainScreen } from "@bastani/atomic-tui";
import { beforeAll, beforeEach, describe, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionMessageEntry } from "../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import type { TaskId, TaskRecord } from "../src/core/tasks/contracts.ts";
import type { TaskTranscriptSource } from "../src/core/tasks/supervisor.ts";
import type { TaskViewSource } from "../src/core/tasks/task-view-source.ts";
import { ChatSessionHost } from "../src/modes/interactive/components/chat-session-host.ts";
import type { ChatSessionHostStyle } from "../src/modes/interactive/components/chat-session-host-types.ts";
import { TaskInspector } from "../src/modes/interactive/components/task-inspector.ts";
import { themedChatHostStyle } from "../src/modes/interactive/components/task-transcript-page.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";

const identity = (text: string): string => text;
const flush = async () => {
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const style: ChatSessionHostStyle = {
	dim: identity,
	text: identity,
	textMuted: identity,
	accent: identity,
	accentBold: identity,
	rule: (_hex, text) => text,
	cursor: () => "",
	blank: (width) => " ".repeat(width),
	editorRuleColor: () => "#ffffff",
};

const agentTaskRecord = (taskId: TaskId): TaskRecord => ({
	ref: {
		owner: { kind: "session", sessionId: "session-1", generation: 1 },
		taskId,
	},
	kind: "agent",
	title: "Audit menus",
	agentName: "debugger",
	createdAtMs: 1,
	updatedAtMs: 1,
	admission: { kind: "background", reason: "explicit" },
	execution: { kind: "running", startedAtMs: 1 },
	attention: { kind: "none" },
	cleanup: { kind: "none" },
	output: { byteCount: "0", truncated: false },
});

function userSessionEntry(id: string, content: string, timestamp: number): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "user", content, timestamp },
	};
}

function openSubagentInspector(options: {
	entries?: SessionMessageEntry[];
	messages?: Array<{ role: "user"; content: string; timestamp: number }>;
	running?: boolean;
	readOnly?: boolean;
	onSend?: (text: string) => void;
	onInterrupt?: () => void;
}) {
	const taskId = "task-1-0-1" as TaskId;
	const terminal = new RecordingTerminal();
	terminal.columns = 100;
	terminal.rows = 30;
	const tui = new TuiMainScreen(terminal);
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const entries: SessionMessageEntry[] =
		options.entries ??
		(options.messages ?? []).map((message, index) =>
			userSessionEntry(`u-${index}`, message.content, message.timestamp),
		);
	const transcriptMessages =
		options.messages ??
		entries.flatMap((entry) =>
			entry.message.role === "user" && typeof entry.message.content === "string"
				? [{ role: "user" as const, content: entry.message.content, timestamp: entry.message.timestamp }]
				: [],
		);
	let isRunning = options.running ?? false;
	const session: TaskTranscriptSource = {
		getSessionId: () => "child-session",
		getEntries: () => entries,
		subscribe: () => () => {},
		isRunning: () => isRunning,
		async interruptTurn() {
			options.onInterrupt?.();
			isRunning = false;
		},
	};
	const task = agentTaskRecord(taskId);
	const skillSourceInfo = createSyntheticSourceInfo("<test:review>", { source: "local", scope: "project" });
	const source: TaskViewSource = {
		tasks: [task],
		backgroundTasks: [task],
		settlementOrder: new Map(),
		recentActivity: () => [],
		activityOmitted: () => false,
		subscribe: () => () => {},
		cancelTask: async () => ({ ok: true, value: undefined }),
		stdinAvailable: () => false,
		writeTaskInput: async () => ({ ok: true, value: { acceptedBytes: 0 } }),
		readTaskOutput: async () => ({ ok: true, value: { text: "", omitted: false } }),
		taskDetailText: () => ({}),
		readTaskTranscript: () => ({ ok: true, value: { messages: transcriptMessages } }),
		followTaskTranscript: () => ({ historyOnly: false, session }),
		extensionStatuses: () => new Map(),
		watchExtensionStatuses: () => () => {},
		taskCommands: () => ({
			cwd: process.cwd(),
			skillCommands: [{ name: "review", description: "Review changes", sourceInfo: skillSourceInfo }],
		}),
		...(options.readOnly
			? {}
			: {
					sendTaskMessage: async (_id, text) => {
						options.onSend?.(text);
					},
				}),
		interruptTask: async () => {
			await session.interruptTurn?.();
			return { ok: true, value: undefined };
		},
	};
	let closed = 0;
	const inspector = new TaskInspector(
		source,
		() => {},
		() => {
			closed++;
		},
		undefined,
		() => ({
			createChat: (opts) => new ChatSessionHost(opts),
			tui,
			keybindings,
			editorTheme: getEditorTheme(),
			style: themedChatHostStyle(),
		}),
	);
	// Enter on the subagent's row of /tasks opens its chat (a host without the single screen).
	inspector.open(taskId);
	inspector.handleInput("\r");
	const screen = () =>
		inspector
			.renderViewport(100, 30)
			.map((line) => stripTerminalSequences(line).replace(/\s+$/, ""))
			.join("\n");
	return { inspector, screen, closed: () => closed };
}

function host(): ChatSessionHost {
	const terminal = new RecordingTerminal();
	terminal.columns = 100;
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	return new ChatSessionHost({
		style,
		editorTheme: getEditorTheme(),
		tui: new TuiMainScreen(terminal),
		keybindings,
		isStreaming: () => false,
		getAgentSession: () =>
			({
				sessionManager: {
					getEntries: () => [
						{
							type: "message",
							id: "u1",
							parentId: null,
							timestamp: new Date(Date.now() - 6 * 60_000).toISOString(),
							message: { role: "user", content: "summarize the failing gate" },
						},
					],
				},
			}) as never,
	});
}

const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).replace(/\s+$/, ""));

describe("ctrl+r in a subagent or stage chat behaves as in the main chat (#5224)", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("opens the same prompt search in place of the editor and puts the chosen prompt in the composer", () => {
		const chat = host();
		chat.setInputText("draft");
		chat.handleInput("\x12");
		const open = plain(chat.renderEditor(100));
		assert.ok(
			open.some((line) => line.trim() === "Search prompts"),
			open.join("\n"),
		);
		assert.ok(open.some((line) => line.includes("∀ summarize the failing gate") && line.endsWith("6m ago")));
		assert.equal(open.at(-2)?.trim(), "enter use · type to search · esc cancel");
		chat.handleInput("\r");
		assert.equal(chat.inputText(), "summarize the failing gate");
		assert.ok(!plain(chat.renderEditor(100)).some((line) => line.includes("Search prompts")));
	});

	it("keeps typed command metadata when searching a stage's messages without a local session (#5347)", () => {
		const keybindings = new KeybindingsManager();
		const chat = new ChatSessionHost({
			style,
			editorTheme: getEditorTheme(),
			tui: new TuiMainScreen(new RecordingTerminal()),
			keybindings,
			getSessionMessages: () => [
				{
					role: "user" as const,
					content: "Please fix the bug: stage menu",
					rawText: "/fixbug stage menu",
					timestamp: Date.now() - 3 * 60_000,
				},
			],
		});
		try {
			chat.handleInput("\x12");
			const rendered = plain(chat.renderEditor(100)).join("\n");
			assert.match(rendered, /\/fixbug stage menu.*3m ago/);
			assert.doesNotMatch(rendered, /Please fix the bug/);
		} finally {
			chat.dispose();
		}
	});

	it("esc closes the search and leaves the draft alone", () => {
		const chat = host();
		chat.setInputText("draft");
		chat.handleInput("\x12");
		chat.handleInput("\x1b");
		assert.equal(chat.inputText(), "draft");
		assert.ok(!plain(chat.renderEditor(100)).some((line) => line.includes("Search prompts")));
	});

	it("lists the subagent transcript's prompts, including a message sent from its view once its session records it", async () => {
		const sent: string[] = [];
		const sentAt = Date.now() - 7 * 60_000;
		const entries = [userSessionEntry("u1", "audit the menus hint line", sentAt)];
		const subagent = openSubagentInspector({
			entries,
			onSend: (text) => {
				sent.push(text);
				entries.push(userSessionEntry("u2", text, Date.now()));
			},
		});
		try {
			await flush();
			for (const ch of "check the settings path") subagent.inspector.handleInput(ch);
			subagent.inspector.handleInput("\r");
			await flush();
			assert.deepEqual(sent, ["check the settings path"]);
			subagent.inspector.handleInput("\x12");
			await flush();
			const open = subagent.screen();
			assert.match(open, /Search prompts/);
			assert.doesNotMatch(open, /No prompts yet/);
			assert.match(open, /check the settings path/);
			assert.match(open, /audit the menus hint line.*7m ago/);
		} finally {
			subagent.inspector.dispose();
		}
	});

	it("routes Esc, ←, ↓ and ? to an open prompt search or / menu in a running subagent view without interrupting or leaving", async () => {
		let interrupts = 0;
		const sentAt = Date.now() - 4 * 60_000;
		const subagent = openSubagentInspector({
			running: true,
			entries: [
				userSessionEntry("u1", "fix the picker", sentAt),
				userSessionEntry("u2", "inspect the older prompt", sentAt - 60_000),
			],
			onInterrupt: () => {
				interrupts++;
			},
		});
		try {
			await flush();
			subagent.inspector.handleInput("\x12");
			await flush();
			assert.match(subagent.screen(), /Search prompts/);
			assert.doesNotMatch(subagent.screen(), /esc to interrupt|← tasks/);
			subagent.inspector.handleInput("\x1b[B");
			await flush();
			assert.match(subagent.screen(), /∀ inspect the older prompt/);
			subagent.inspector.handleInput("?");
			subagent.inspector.handleInput("\x1b[D");
			await flush();
			assert.equal(subagent.closed(), 0, "← and ↓ inside prompt search must not leave the subagent view");
			assert.match(subagent.screen(), /Search prompts/, "? inside prompt search types into the filter");
			subagent.inspector.handleInput("\x1b");
			await flush();
			assert.equal(interrupts, 0, "first Esc clears the search filter without interrupting the subagent");
			assert.match(subagent.screen(), /Search prompts/);
			subagent.inspector.handleInput("\x1b");
			await flush();
			assert.equal(interrupts, 0, "second Esc closes the search without interrupting the subagent");
			assert.doesNotMatch(subagent.screen(), /Search prompts/);

			subagent.inspector.handleInput("/");
			await flush();
			assert.match(subagent.screen(), /esc close/);
			assert.doesNotMatch(subagent.screen(), /esc to interrupt|← tasks/);
			subagent.inspector.handleInput("\x1b");
			await flush();
			assert.equal(interrupts, 0, "Esc on an open / menu must not interrupt the running subagent");
			assert.doesNotMatch(subagent.screen(), /esc close/);
			subagent.inspector.handleInput("\x15");
			await flush();
			subagent.inspector.handleInput("\x1b[D");
			await flush();
			assert.equal(subagent.closed(), 0, "the subagent's chat goes back to /tasks, which stays open");
			assert.doesNotMatch(subagent.screen(), /pgup\/pgdn scroll/, "Left after closing the menu leaves the chat");
		} finally {
			subagent.inspector.dispose();
		}
	});

	it("does not open an invisible prompt search on a read-only subagent view or keep one open when disabled", async () => {
		const messages = Array.from({ length: 80 }, (_, index) => ({
			role: "user" as const,
			content: `M-${String(index).padStart(3, "0")}`,
			timestamp: index + 1,
		}));
		const readOnly = openSubagentInspector({ messages, readOnly: true });
		try {
			await flush();
			readOnly.inspector.handleInput("\x12");
			await flush();
			const beforeScroll = readOnly.screen();
			assert.doesNotMatch(beforeScroll, /Search prompts/);
			readOnly.inspector.handleInput("\x1b[5~");
			await flush();
			assert.notEqual(
				readOnly.screen(),
				beforeScroll,
				"PgUp still scrolls a read-only subagent transcript after Ctrl+R",
			);
		} finally {
			readOnly.inspector.dispose();
		}

		const terminal = new RecordingTerminal();
		terminal.columns = 100;
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		let disabled = false;
		const chat = new ChatSessionHost({
			style,
			editorTheme: getEditorTheme(),
			tui: new TuiMainScreen(terminal),
			keybindings,
			isStreaming: () => false,
			isDisabled: () => disabled,
			getAgentSession: () =>
				({
					sessionManager: {
						getEntries: () => [
							{
								type: "message",
								id: "u1",
								parentId: null,
								timestamp: new Date().toISOString(),
								message: { role: "user", content: "earlier prompt" },
							},
						],
					},
				}) as never,
		});
		chat.setInputText("draft");
		chat.handleInput("\x12");
		assert.ok(plain(chat.renderEditor(100)).some((line) => line.includes("Search prompts")));
		disabled = true;
		assert.ok(!plain(chat.renderEditor(100)).some((line) => line.includes("Search prompts")));
		for (const ch of "zz") chat.handleInput(ch);
		disabled = false;
		assert.ok(
			!plain(chat.renderEditor(100)).some((line) => line.includes("Search prompts")),
			"a search closed when the chat became disabled does not reappear with hidden input",
		);
	});
});
