import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Text } from "@bastani/atomic-tui";
import { afterEach, test, vi } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import type {
	TaskTranscriptView,
	TaskViewResult,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import type { ChatSessionHostOpts } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host-types.js";
import { stripAnsi } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host-utils.ts";
import type { ChatTranscriptEntryLike } from "../../packages/coding-agent/src/modes/interactive/components/chat-transcript.js";
import { TaskAgentTranscriptPage } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";

type NoticeEntry = { role: "notice"; text: string };

import { taskTranscriptEnvironment, transcriptOnlySource } from "../helpers/task-transcript-environment.js";

const identity = (value: string): string => value;
const PAGE_UP = "\x1b[5~";

function hostOptions<TExtraEntry extends ChatTranscriptEntryLike = never>(
	overrides: Partial<ChatSessionHostOpts<TExtraEntry>> = {},
): ChatSessionHostOpts<TExtraEntry> {
	return {
		style: {
			dim: identity,
			text: identity,
			textMuted: identity,
			accent: identity,
			accentBold: identity,
			rule: (_hex, value) => value,
			cursor: () => "",
			blank: (width) => " ".repeat(width),
			editorRuleColor: () => "#ffffff",
		},
		editorTheme: {
			borderColor: identity,
			selectList: {
				selectedPrefix: identity,
				selectedText: identity,
				description: identity,
				scrollInfo: identity,
				noMatch: identity,
			},
		},
		...overrides,
	};
}

const plain = (rows: readonly string[]): string => stripVTControlCharacters(rows.join("\n"));

function makeNoticeEntry(index: number): NoticeEntry {
	return { role: "notice", text: `Notice ${index}` };
}

afterEach(() => {
	vi.useRealTimers();
});

test("loadSession excludes hydrated session history from the scrolled-up new-message count (#5243)", async () => {
	initTheme("dark");
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	for (let i = 0; i < 5; i++) {
		await manager.appendMessage({ role: "user", content: `SAVED-${i}`, timestamp: i + 1 });
	}
	const host = new ChatSessionHost<NoticeEntry>(
		hostOptions<NoticeEntry>({
			renderExtraEntry: (entry) => new Text(entry.text, 0, 0),
		}),
	);
	try {
		for (let i = 0; i < 20; i++) {
			host.appendExtraEntry(makeNoticeEntry(i));
		}
		host.renderBody(80, 6);
		host.handleInput(PAGE_UP);
		assert.match(plain(host.renderBody(80, 6).slice(-1)), /jump to bottom/);

		assert.equal(await host.loadSession(store, manager.getSessionId()), true);
		assert.match(plain(host.renderBody(80, 6).slice(-1)), /jump to bottom/);
		assert.doesNotMatch(plain(host.renderBody(80, 6)), /new message/);

		host.appendMessages([{ role: "user", content: "LIVE-ARRIVAL", timestamp: 100 }]);
		assert.match(plain(host.renderBody(80, 6).slice(-1)), /1 new message ·/);
	} finally {
		host.dispose();
		await store.close();
	}
});

test("a saved chat reopens with the same failed attempts and warning as the live chat (#5613)", async () => {
	initTheme("dark");
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const live = new ChatSessionHost(hostOptions());
	const reopened = new ChatSessionHost(hostOptions());
	try {
		const failure = fauxAssistantMessage([], { stopReason: "error", errorMessage: "529 · 暂时不可用" });
		const warning = {
			role: "custom" as const,
			customType: "warning",
			content: "retrying request",
			display: true,
			timestamp: 2,
		};
		for (const message of [failure, warning, failure]) {
			live.applyAgentEvent({ type: "message_start", message });
			live.applyAgentEvent({ type: "message_end", message });
			const id =
				message.role === "custom"
					? await manager.appendCustomMessageEntry(message.customType, message.content, message.display)
					: await manager.appendMessage(message);
			await manager.appendContextEdit(id, null);
		}
		assert.deepEqual(manager.buildSessionContext().messages, [], "the next request must not repeat these attempts");
		const expected = plain(live.renderBody(80, 18));
		assert.equal(expected.match(/529/g)?.length, 2);
		assert.match(expected, /retrying request/);
		assert.equal(await reopened.loadSession(store, manager.getSessionId()), true);
		assert.equal(plain(reopened.renderBody(80, 18)), expected);
	} finally {
		live.dispose();
		reopened.dispose();
		await store.close();
	}
});

test("a compaction redraw keeps a failed attempt outside the compacted region (#5613)", async () => {
	initTheme("dark");
	const manager = SessionManager.inMemory();
	const prior = await manager.appendMessage({ role: "user", content: "older request", timestamp: 1 });
	const failure = fauxAssistantMessage([], { stopReason: "error", errorMessage: "529 after boundary" });
	const failedId = await manager.appendMessage(failure);
	await manager.appendContextEdit(failedId, null);
	const result = {
		compactedText: "earlier conversation",
		tokensBefore: 100,
		firstKeptEntryId: null,
		form: "cleared" as const,
		promptVersion: 7 as const,
		parameters: { query: "" },
		stats: {
			linesBefore: 2,
			linesDeleted: 1,
			linesKept: 1,
			rangeCount: 1,
			tokensBefore: 100,
			tokensAfter: 50,
			percentReduction: 50,
		},
	};
	await manager.appendCompaction(
		result.compactedText,
		null,
		result.tokensBefore,
		{ ...result, strategy: "verbatim-lines" },
		undefined,
		prior,
	);
	const host = new ChatSessionHost(
		hostOptions({
			getCwd: () => manager.getCwd(),
			getAgentSession: () =>
				({ sessionManager: manager, messages: manager.buildSessionContext().messages }) as never,
		}),
	);
	try {
		host.applyAgentEvent({ type: "compaction_end", reason: "threshold", result, aborted: false, willRetry: false });
		assert.match(plain(host.renderBody(80, 20)), /529 after boundary/);
	} finally {
		host.dispose();
	}
});

test("a compaction redraw shows a call saved without its result as interrupted, as the session does (#5613)", async () => {
	initTheme("dark");
	const harness = await createHarness();
	const session = harness.session;
	const host = new ChatSessionHost(
		hostOptions({ getCwd: () => session.sessionManager.getCwd(), getAgentSession: () => session }),
	);
	try {
		const manager = session.sessionManager;
		const prior = await manager.appendMessage({ role: "user", content: "older request", timestamp: 1 });
		const result = {
			compactedText: "earlier conversation",
			tokensBefore: 100,
			firstKeptEntryId: null,
			form: "cleared" as const,
			promptVersion: 7 as const,
			parameters: { query: "" },
			stats: {
				linesBefore: 2,
				linesDeleted: 1,
				linesKept: 1,
				rangeCount: 1,
				tokensBefore: 100,
				tokensAfter: 50,
				percentReduction: 50,
			},
		};
		const details = { ...result, strategy: "verbatim-lines" as const };
		await manager.appendCompaction(result.compactedText, null, result.tokensBefore, details, undefined, prior);
		const call = fauxToolCall("bash", { command: "echo lost" }, { id: "call-without-result" });
		await manager.appendMessage(fauxAssistantMessage([call], { stopReason: "toolUse" }));
		session.refreshContext();
		host.applyAgentEvent({ type: "compaction_end", reason: "threshold", result, aborted: false, willRetry: false });
		assert.match(plain(host.renderBody(80, 20)), /interrupted after it started/);
	} finally {
		host.dispose();
		await harness.cleanup();
	}
});

test("a host can exclude extra entries from its new-message count while scrolled up (#5243)", () => {
	initTheme("dark");
	const host = new ChatSessionHost<NoticeEntry>(
		hostOptions<NoticeEntry>({
			renderExtraEntry: (entry) => new Text(entry.text, 0, 0),
			countsAsMessage: (entry) => entry.role !== "notice",
		}),
	);
	try {
		host.replaceMessages(
			Array.from({ length: 20 }, (_, i) => ({
				role: "user" as const,
				content: `INITIAL-${i}`,
				timestamp: i,
			})),
		);
		host.renderBody(80, 6);
		host.handleInput(PAGE_UP);
		assert.match(plain(host.renderBody(80, 6).slice(-1)), /jump to bottom/);

		for (let i = 0; i < 9; i++) {
			host.appendExtraEntry(makeNoticeEntry(i));
			assert.match(plain(host.renderBody(80, 6).slice(-1)), /jump to bottom/);
		}

		host.appendMessages([{ role: "user", content: "REAL-MESSAGE", timestamp: 999 }]);
		assert.match(plain(host.renderBody(80, 6).slice(-1)), /1 new message ·/);
	} finally {
		host.dispose();
	}
});

function createFollowedSession(initialRunning = false): {
	session: TaskTranscriptSource;
	emit(event: AgentSessionEvent): void;
	setRunning(running: boolean): void;
} {
	let running = initialRunning;
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	return {
		session: {
			getSessionId: () => "session",
			getEntries: () => [],
			isRunning: () => running,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		emit(event: AgentSessionEvent) {
			for (const listener of listeners) listener(event);
		},
		setRunning(next: boolean) {
			running = next;
		},
	};
}

test("switching the followed session in /tasks resets unread messages and stops the previous run's meter (#5243)", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000);
	initTheme("dark");
	const taskId = "task-follow-switch" as TaskId;
	const sessionA = createFollowedSession(true);
	const sessionB = createFollowedSession(true);
	let activeSession: TaskTranscriptSource = sessionA.session;
	let transcriptMessages = Array.from({ length: 20 }, (_, i) => ({
		role: "user" as const,
		content: `A-LINE-${i}`,
		timestamp: i,
	}));

	const source = transcriptOnlySource({
		readTaskTranscript: (): TaskViewResult<TaskTranscriptView> => ({
			ok: true,
			value: { messages: transcriptMessages },
		}),
		followTaskTranscript: () => ({ session: activeSession, historyOnly: false }),
	});

	const page = new TaskAgentTranscriptPage(
		source,
		taskId,
		taskTranscriptEnvironment({ keybindings: new KeybindingsManager() }),
		() => {},
	);
	try {
		await page.load();
		page.render(100, 14);
		page.handleInput(PAGE_UP);
		assert.match(plain(page.render(100, 14)), /jump to bottom/);

		sessionA.emit({ type: "agent_start" });
		sessionA.emit({
			type: "message_start",
			message: { role: "user", content: "A-NEW-1", timestamp: 100 },
		} as unknown as AgentSessionEvent);
		sessionA.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400) },
			message: { role: "assistant", content: [{ type: "text", text: "x".repeat(400) }] },
		} as unknown as AgentSessionEvent);
		vi.setSystemTime(3_000);

		const duringA = plain(page.render(100, 14));
		assert.match(duringA, /2 new messages ·/);
		assert.match(duringA, /2s · ↓ 100 tokens/);

		activeSession = sessionB.session;
		transcriptMessages = Array.from({ length: 30 }, (_, i) => ({
			role: "user" as const,
			content: `B-LINE-${i}`,
			timestamp: i,
		}));
		await page.load();

		const afterSwitchToB = plain(page.render(100, 14));
		assert.doesNotMatch(afterSwitchToB, /2s · ↓ 100 tokens/);
		assert.doesNotMatch(afterSwitchToB, /new message/);
		assert.match(afterSwitchToB, /jump to bottom/);
	} finally {
		page.dispose();
	}
});

test("switching the followed session in /tasks or hydrating idle compaction status clears manualCompactionTakeoverPending (#5243)", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(5_000);
	initTheme("dark");
	const taskId = "task-takeover-switch" as TaskId;
	const sessionA = createFollowedSession(false);
	const sessionB = createFollowedSession(false);
	let activeSession: TaskTranscriptSource = sessionA.session;

	const source = transcriptOnlySource({
		readTaskTranscript: (): TaskViewResult<TaskTranscriptView> => ({
			ok: true,
			value: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
		}),
		followTaskTranscript: () => ({ session: activeSession, historyOnly: false }),
	});

	const page = new TaskAgentTranscriptPage(
		source,
		taskId,
		taskTranscriptEnvironment({ keybindings: new KeybindingsManager() }),
		() => {},
	);
	try {
		await page.load();
		sessionA.emit({ type: "compaction_start", reason: "threshold" });
		sessionA.emit({
			type: "compaction_end",
			reason: "threshold",
			result: undefined,
			aborted: false,
			willRetry: false,
			manualTakeoverPending: true,
		});
		assert.match(plain(page.render(100, 14)), /Auto-compacting\.\.\./);

		activeSession = sessionB.session;
		await page.load();

		sessionB.emit({ type: "agent_start" });
		sessionB.emit({ type: "agent_end", messages: [] });

		const afterBRun = plain(page.render(100, 14));
		assert.doesNotMatch(afterBRun, /Auto-compacting\.\.\.|Compacting context\.\.\./);

		const host = new ChatSessionHost(hostOptions());
		try {
			host.applyAgentEvent({ type: "compaction_start", reason: "threshold" });
			host.applyAgentEvent({
				type: "compaction_end",
				reason: "threshold",
				result: undefined,
				aborted: false,
				willRetry: false,
				manualTakeoverPending: true,
			});
			host.hydrateCompactionStatus(undefined);
			host.applyAgentEvent({ type: "agent_start" });
			host.applyAgentEvent({ type: "agent_end", messages: [] });
			assert.equal(host.isCompacting(), false);
			assert.deepEqual(host.renderWorkingStatus(80).map(stripAnsi), ["", " ∀ Worked for 0s".padEnd(80)]);
		} finally {
			host.dispose();
		}
	} finally {
		page.dispose();
	}
});
