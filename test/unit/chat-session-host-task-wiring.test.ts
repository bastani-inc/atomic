import assert from "node:assert/strict";
import { resolve } from "node:path";
import { getKeybindings, setKeybindings, stripTerminalSequences } from "@bastani/atomic-tui";
import { afterEach, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { createVerbatimCompactionMessage } from "../../packages/coding-agent/src/core/messages.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { TaskMessageError } from "../../packages/coding-agent/src/core/tasks/message-error.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import type { ChatBoxSession } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import type { ChatSessionHostOpts } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host-types.ts";
import { SCROLLBAR_HIDE_DELAY_MS } from "../../packages/coding-agent/src/modes/interactive/components/chat-transcript.js";
import {
	FooterComponent,
	formatCwdForFooter,
} from "../../packages/coding-agent/src/modes/interactive/components/footer.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture } from "../helpers/task-projection.js";

const identity = (text: string): string => text;
const PAGE_UP = "\x1b[5~";

function hostOptions(overrides: Partial<ChatSessionHostOpts> = {}): ChatSessionHostOpts {
	return {
		style: {
			dim: identity,
			text: identity,
			textMuted: identity,
			accent: identity,
			accentBold: identity,
			rule: (_hex, text) => text,
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

const flush = async () => {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const text = (rows: readonly string[]) => stripTerminalSequences(rows.join("\n"));

const longConversation = Array.from({ length: 60 }, (_, i) => ({
	role: "user" as const,
	content: `LINE-${i}`,
	timestamp: i,
}));

afterEach(() => {
	vi.useRealTimers();
});

test("a chat host opens a task's transcript as a chat of its own and hands back only what the inspector declines (#4521)", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture();
	const transcript = SessionManager.inMemory();
	await transcript.appendMessage({ role: "user", content: "HOST-WIRED-MESSAGE", timestamp: 0 });
	const source = ownerTaskViewSource(fixture.store);
	const host = new ChatSessionHost(hostOptions({ getTaskSource: () => source }));
	try {
		await fixture.start("Wired transcript");
		fixture.runners[0]!.context.bindTranscript(transcript);
		assert.equal(host.handleTaskInput("\r"), false, "without an open inspector nothing takes the key");
		assert.equal(host.openTasks(), true);
		assert.equal(host.hasTaskInspector, true);
		assert.equal(host.handleTaskInput("\x14"), false, "Ctrl+T goes back to the chat");
		assert.equal(host.handleTaskInput("q"), true, "other keys stay with the inspector");
		host.handleTaskInput("\r");
		await flush();
		host.handleTaskInput("\r");
		await flush();
		const page = text(host.renderBody(80, 24));
		assert.match(page, /HOST-WIRED-MESSAGE/, "the transcript is a chat the host built");
		assert.doesNotMatch(page, /unavailable/);
		host.closeTasks();
		assert.equal(host.hasTaskInspector, false);
		assert.equal(host.handleTaskInput("\r"), false);
	} finally {
		host.dispose();
		await fixture.dispose();
		setKeybindings(previous);
	}
});

test("a chat host without a repaint hook takes earlier and replaced history (#4521)", () => {
	initTheme("dark");
	const host = new ChatSessionHost(hostOptions());
	try {
		host.replaceMessages([{ role: "user", content: "LATEST", timestamp: 2 }]);
		host.prependMessages([{ role: "user", content: "EARLIER", timestamp: 1 }]);
		const body = text(host.renderBody(80, 20));
		assert.ok(body.indexOf("EARLIER") >= 0 && body.indexOf("EARLIER") < body.indexOf("LATEST"));
	} finally {
		host.dispose();
	}
});

test("prepending or replacing history repaints the host (#4521)", () => {
	initTheme("dark");
	let renders = 0;
	const host = new ChatSessionHost(hostOptions({ requestRender: () => renders++ }));
	try {
		const before = renders;
		host.prependMessages([{ role: "user", content: "EARLIER", timestamp: 1 }]);
		assert.equal(renders, before + 1);
		host.replaceMessages([{ role: "user", content: "LATEST", timestamp: 2 }]);
		assert.equal(renders, before + 2);
	} finally {
		host.dispose();
	}
});

test("the jump-to-latest row names the host's own bottom key, or the global one (#4521)", () => {
	initTheme("dark");
	for (const [keybindings, label] of [
		[new KeybindingsManager({ "tui.altScreen.bottom": "ctrl+g" }), /jump to bottom · ctrl\+g/],
		[undefined, /jump to bottom · ctrl\+end/],
	] as const) {
		const host = new ChatSessionHost(hostOptions(keybindings === undefined ? {} : { keybindings }));
		try {
			host.replaceMessages(longConversation);
			host.renderBody(80, 10);
			host.handleInput(PAGE_UP);
			const rows = host.renderBody(80, 10);
			assert.match(text(rows.slice(-1)), label);
		} finally {
			host.dispose();
		}
	}
});

test("a scrolled chat counts new transcript entries instead of status components (#5243)", () => {
	initTheme("dark");
	const host = new ChatSessionHost(hostOptions());
	try {
		host.replaceMessages(longConversation);
		host.renderBody(80, 10);
		host.handleInput(PAGE_UP);
		assert.match(text(host.renderBody(80, 10).slice(-1)), /jump to bottom/);
		host.showWarning("A temporary status");
		assert.match(text(host.renderBody(80, 10).slice(-1)), /jump to bottom/);
		host.appendMessages([{ role: "user", content: "NEW-ARRIVAL", timestamp: 100 }]);
		assert.match(text(host.renderBody(80, 10).slice(-1)), /1 new message ·/);
		host.handleInput("\x1b[1;5F");
		host.renderBody(80, 10);
		host.handleInput(PAGE_UP);
		assert.match(text(host.renderBody(80, 10).slice(-1)), /jump to bottom/);
	} finally {
		host.dispose();
	}
});

test("loading earlier history preserves only actual unread arrivals (#5243)", () => {
	initTheme("dark");
	const host = new ChatSessionHost(hostOptions());
	try {
		host.replaceMessages(longConversation);
		host.renderBody(80, 10);
		host.handleInput(PAGE_UP);
		host.renderBody(80, 10);
		host.prependMessages([{ role: "user", content: "EARLIER-HISTORY", timestamp: -1 }]);
		assert.match(text(host.renderBody(80, 10).slice(-1)), /jump to bottom/);
		host.appendMessages([{ role: "user", content: "NEW-ARRIVAL", timestamp: 100 }]);
		assert.match(text(host.renderBody(80, 10).slice(-1)), /1 new message ·/);
		host.prependMessages([{ role: "user", content: "EVEN-EARLIER-HISTORY", timestamp: -2 }]);
		assert.match(text(host.renderBody(80, 10).slice(-1)), /1 new message ·/);
		host.replaceMessages(longConversation);
		assert.doesNotMatch(text(host.renderBody(80, 10)), /new message/);
		host.handleInput(PAGE_UP);
		assert.match(text(host.renderBody(80, 10).slice(-1)), /jump to bottom/);
	} finally {
		host.dispose();
	}
});

test("same-conversation snapshots retain arrivals that have not painted yet (#5350)", () => {
	initTheme("dark", false);
	const host = new ChatSessionHost(hostOptions());
	try {
		host.replaceMessages(longConversation);
		host.renderBody(80, 10);
		host.handleInput(PAGE_UP);
		host.renderBody(80, 10);
		const arrival = { role: "user" as const, content: "NEW-SNAPSHOT-ARRIVAL", timestamp: 100 };
		host.appendMessages([arrival]);
		host.replaceMessages([...longConversation, arrival], { preserveUnread: true });
		assert.match(text(host.renderBody(80, 10).slice(-1)), /1 new message/);
		host.replaceMessages(longConversation);
		assert.doesNotMatch(text(host.renderBody(80, 10)), /new message/);
	} finally {
		host.dispose();
	}
});

test("compaction refresh while scrolled up preserves counted arrivals in a chat host (#5243)", () => {
	initTheme("dark");
	let compactedMessages: Array<Parameters<ChatSessionHost["replaceMessages"]>[0][number]> = [...longConversation];
	const host = new ChatSessionHost(
		hostOptions({
			getSessionMessages: () => compactedMessages,
		}),
	);
	try {
		host.replaceMessages(longConversation);
		host.renderBody(80, 10);
		host.handleInput("\x1b[1;5H");
		assert.match(text(host.renderBody(80, 10).slice(-1)), /jump to bottom/);

		host.appendMessages([
			{ role: "user", content: "ARRIVAL-1", timestamp: 101 },
			{ role: "user", content: "ARRIVAL-2", timestamp: 102 },
		]);
		assert.match(text(host.renderBody(80, 10).slice(-1)), /2 new messages ·/);

		const stats = {
			linesBefore: 50,
			linesDeleted: 45,
			linesKept: 5,
			rangeCount: 1,
			tokensBefore: 4000,
			tokensAfter: 500,
			percentReduction: 87.5,
		};
		const parameters = {
			compression_ratio: 0.5,
			preserve_recent: 2,
			query: "",
		};
		const compactionResult = {
			compactedText: "Compacted earlier context",
			firstKeptEntryId: null,
			tokensBefore: 4000,
			form: "cleared" as const,
			promptVersion: 7 as const,
			parameters,
			stats,
		};
		compactedMessages = [
			createVerbatimCompactionMessage("Compacted earlier context", 4000, new Date(103).toISOString(), {
				strategy: "verbatim-lines",
				promptVersion: 7,
				parameters,
				form: "cleared",
				stats,
			}),
			...longConversation.slice(-15),
		];
		host.applyAgentEvent({
			type: "compaction_end",
			reason: "threshold",
			aborted: false,
			willRetry: false,
			result: compactionResult,
		});
		assert.match(text(host.renderBody(80, 10).slice(-1)), /2 new messages ·/);

		host.appendMessages([{ role: "user", content: "ARRIVAL-3", timestamp: 104 }]);
		assert.match(text(host.renderBody(80, 10).slice(-1)), /3 new messages ·/);
	} finally {
		host.dispose();
	}
});

test("compaction_end in the same frame as unpainted arrivals preserves the unread count (#5243)", () => {
	initTheme("dark");
	const stats = {
		linesBefore: 50,
		linesDeleted: 45,
		linesKept: 5,
		rangeCount: 1,
		tokensBefore: 4000,
		tokensAfter: 500,
		percentReduction: 87.5,
	};
	const parameters = {
		compression_ratio: 0.5,
		preserve_recent: 2,
		query: "",
	};
	const compactionResult = {
		compactedText: "Compacted earlier context",
		firstKeptEntryId: null,
		tokensBefore: 4000,
		form: "cleared" as const,
		promptVersion: 7 as const,
		parameters,
		stats,
	};
	const compactedSnapshot = [
		createVerbatimCompactionMessage("Compacted earlier context", 4000, new Date(103).toISOString(), {
			strategy: "verbatim-lines",
			promptVersion: 7,
			parameters,
			form: "cleared",
			stats,
		}),
		...longConversation.slice(-15),
	];

	for (const mode of ["agentSession", "sessionMessages"] as const) {
		let compactedMessages: Array<Parameters<ChatSessionHost["replaceMessages"]>[0][number]> = [...longConversation];
		const host = new ChatSessionHost(
			hostOptions(
				mode === "agentSession"
					? {
							getCwd: () => BOX_CWD,
							getAgentSession: () => ({ messages: compactedMessages }) as never,
						}
					: { getSessionMessages: () => compactedMessages },
			),
		);
		try {
			host.replaceMessages(longConversation);
			host.renderBody(80, 10);
			host.handleInput("\x1b[1;5H");
			assert.match(text(host.renderBody(80, 10).slice(-1)), /jump to bottom/);

			host.appendMessages([
				{ role: "user", content: "SAME-FRAME-1", timestamp: 101 },
				{ role: "user", content: "SAME-FRAME-2", timestamp: 102 },
			]);
			compactedMessages = compactedSnapshot;
			host.applyAgentEvent({
				type: "compaction_end",
				reason: "threshold",
				aborted: false,
				willRetry: false,
				result: compactionResult,
			});

			assert.match(text(host.renderBody(80, 10).slice(-1)), /2 new messages ·/);
		} finally {
			host.dispose();
		}
	}
});

test("compaction_end that refreshes to a longer transcript while scrolled up does not count history as new (#5243)", () => {
	initTheme("dark");
	const stats = {
		linesBefore: 50,
		linesDeleted: 45,
		linesKept: 5,
		rangeCount: 1,
		tokensBefore: 4000,
		tokensAfter: 500,
		percentReduction: 87.5,
	};
	const parameters = { compression_ratio: 0.5, preserve_recent: 2, query: "" };
	const compactionResult = {
		compactedText: "Compacted earlier context",
		firstKeptEntryId: null,
		tokensBefore: 4000,
		form: "cleared" as const,
		promptVersion: 7 as const,
		parameters,
		stats,
	};
	const shown = longConversation.slice(0, 20);
	const compactedSnapshot = [
		createVerbatimCompactionMessage("Compacted earlier context", 4000, new Date(103).toISOString(), {
			strategy: "verbatim-lines",
			promptVersion: 7,
			parameters,
			form: "cleared",
			stats,
		}),
		...longConversation,
	];

	for (const mode of ["agentSession", "sessionMessages"] as const) {
		let compactedMessages: Array<Parameters<ChatSessionHost["replaceMessages"]>[0][number]> = [...shown];
		const host = new ChatSessionHost(
			hostOptions(
				mode === "agentSession"
					? {
							getCwd: () => BOX_CWD,
							getAgentSession: () => ({ messages: compactedMessages }) as never,
						}
					: { getSessionMessages: () => compactedMessages },
			),
		);
		try {
			host.replaceMessages(shown);
			host.renderBody(80, 10);
			host.handleInput("\x1b[1;5H");
			assert.match(text(host.renderBody(80, 10).slice(-1)), /jump to bottom/, mode);

			compactedMessages = compactedSnapshot;
			host.applyAgentEvent({
				type: "compaction_end",
				reason: "threshold",
				aborted: false,
				willRetry: false,
				result: compactionResult,
			});

			const rows = text(host.renderBody(80, 10));
			assert.match(rows.split("\n").at(-1) ?? "", /jump to bottom/, mode);
			assert.doesNotMatch(rows, /new message/, mode);
		} finally {
			host.dispose();
		}
	}
});

test("replaceMessages with a longer transcript while scrolled up does not count replaced history as new arrivals (#5243)", () => {
	initTheme("dark");
	const host = new ChatSessionHost(hostOptions());
	try {
		host.replaceMessages(longConversation);
		host.renderBody(80, 10);
		host.handleInput(PAGE_UP);
		assert.match(text(host.renderBody(80, 10).slice(-1)), /jump to bottom/);

		const longerTranscript = [
			...longConversation,
			...Array.from({ length: 5 }, (_, i) => ({
				role: "user" as const,
				content: `REPLACED-EXTRA-${i}`,
				timestamp: 200 + i,
			})),
		];
		host.replaceMessages(longerTranscript);
		assert.match(text(host.renderBody(80, 10).slice(-1)), /jump to bottom/);
		assert.doesNotMatch(text(host.renderBody(80, 10)), /new message/);

		host.appendMessages([{ role: "user", content: "LIVE-ARRIVAL", timestamp: 300 }]);
		assert.match(text(host.renderBody(80, 10).slice(-1)), /1 new message ·/);
	} finally {
		host.dispose();
	}
});

test("transient task rows attaching and detaching while scrolled up do not count as unread messages (#5243)", async () => {
	initTheme("dark");
	const fixture = taskFixture();
	const source = ownerTaskViewSource(fixture.store);
	let activeSource: ReturnType<typeof ownerTaskViewSource> | undefined;
	const host = new ChatSessionHost(hostOptions({ getTaskSource: () => activeSource }));
	try {
		host.replaceMessages(longConversation);
		host.renderBody(80, 10);
		host.handleInput(PAGE_UP);
		assert.match(text(host.renderBody(80, 10).slice(-1)), /jump to bottom/);

		await fixture.start("Transient background task");
		activeSource = source;
		host.refreshTaskStore();
		assert.equal(
			host.entries().some((entry) => "kind" in entry && entry.kind === "task"),
			true,
		);
		assert.match(text(host.renderBody(80, 10).slice(-1)), /jump to bottom/);

		activeSource = undefined;
		host.refreshTaskStore();
		assert.equal(
			host.entries().some((entry) => "kind" in entry && entry.kind === "task"),
			false,
		);
		assert.match(text(host.renderBody(80, 10).slice(-1)), /jump to bottom/);

		host.appendMessages([{ role: "user", content: "REAL-ARRIVAL", timestamp: 100 }]);
		assert.match(text(host.renderBody(80, 10).slice(-1)), /1 new message ·/);
	} finally {
		host.dispose();
		await fixture.dispose();
	}
});

test("an auto scrollbar hides again through the host's repaint hook (#4521)", () => {
	vi.useFakeTimers();
	initTheme("dark");
	let renders = 0;
	const host = new ChatSessionHost(
		hostOptions({
			requestRender: () => renders++,
			getChatRenderSettings: () => ({ hideThinkingBlock: false, fullscreenScrollbar: "auto" }),
		}),
	);
	try {
		host.replaceMessages(longConversation);
		host.renderBody(80, 10);
		host.handleInput(PAGE_UP);
		host.renderBody(80, 10);
		const before = renders;
		vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS);
		assert.equal(renders, before + 1, "the hide timer asks the host to repaint");
	} finally {
		host.dispose();
	}
});

test("a task message that fails after the chat closed /tasks shows its reason in the chat (#4521)", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture();
	const transcript = SessionManager.inMemory();
	await transcript.appendMessage({ role: "user", content: "Waiting for guidance", timestamp: 0 });
	const answer = Promise.withResolvers<void>();
	const owner = ownerTaskViewSource(fixture.store);
	const source = Object.assign(Object.create(owner) as typeof owner, { sendTaskMessage: () => answer.promise });
	const host = new ChatSessionHost(hostOptions({ getTaskSource: () => source }));
	try {
		await fixture.start("Wired transcript");
		fixture.runners[0]!.context.bindTranscript(transcript);
		host.openTasks();
		host.handleTaskInput("\r");
		await flush();
		host.handleTaskInput("\r");
		await flush();
		for (const ch of "late note") host.handleTaskInput(ch);
		host.handleTaskInput("\r");
		await flush();
		host.closeTasks();
		answer.reject(new TaskMessageError("delivery-refused", { taskId: "task" as TaskId, target: "worker-1" }));
		await flush();
		assert.match(host.statusText(), /The agent did not take the message: worker-1 \(delivery-refused\)/);
	} finally {
		host.dispose();
		await fixture.dispose();
		setKeybindings(previous);
	}
});

test("a chat that shows task rows adds and repaints them as its tasks change (#4640)", async () => {
	initTheme("dark");
	const fixture = taskFixture();
	const host = new ChatSessionHost(hostOptions({ getTaskSource: () => ownerTaskViewSource(fixture.store) }));
	const rows = () =>
		host
			.renderBody(30, 30)
			.map(stripTerminalSequences)
			.filter((row) => row.includes("worker"));
	try {
		assert.deepEqual(rows(), []);
		await fixture.start("Investigate the parser failure in module alpha");
		assert.equal(rows().length, 1);
		assert.doesNotMatch(rows()[0] ?? "", /\[/, "a row with a label of its own has no task id");
		await fixture.start("Investigate the parser failure in module beta");
		const both = rows();
		assert.equal(both.length, 2);
		for (const row of both) assert.match(row, /\[[0-9a-f]{6}\]/, "rows whose labels read alike name their task ids");
	} finally {
		host.dispose();
		await fixture.dispose();
	}
});

const FOOTER_DATA = {
	getGitBranch: () => null,
	getExtensionStatuses: () => new Map<string, string>(),
	getAvailableProviderCount: () => 1,
	onBranchChange: () => () => {},
};

const BOX_CWD = resolve("/work");
const BOX_FOOTER_CWD = formatCwdForFooter(BOX_CWD, process.env.HOME || process.env.USERPROFILE);

function boxSession(modelId: string): ChatBoxSession {
	const model = { provider: "faux", id: modelId, reasoning: false, contextWindow: 1000 };
	return {
		state: { model, thinkingLevel: "off" },
		model,
		sessionManager: SessionManager.inMemory(BOX_CWD),
		getContextUsage: () => undefined,
		modelRuntime: { isUsingOAuth: () => false },
		isStreaming: false,
	} as unknown as ChatBoxSession;
}

test("a chat with no session of any kind shows no usage meter and no session footer (#4640)", () => {
	initTheme("dark");
	const host = new ChatSessionHost(hostOptions({ footerData: FOOTER_DATA }));
	assert.deepEqual(host.renderUsage(80), []);
	assert.deepEqual(host.renderFooter(80), []);
	host.dispose();
});

test("a chat's footer follows the session it is given, and counts the tasks of its own source (#4640)", async () => {
	initTheme("dark");
	const fixture = taskFixture();
	await fixture.start("Footer count");
	let current = boxSession("first-model");
	const withSource = new ChatSessionHost(
		hostOptions({
			footerData: FOOTER_DATA,
			getChatBoxSession: () => current,
			getTaskSource: () => ownerTaskViewSource(fixture.store),
		}),
	);
	const bare = new ChatSessionHost(hostOptions({ footerData: FOOTER_DATA, getChatBoxSession: () => current }));
	const empty = new ChatSessionHost(
		hostOptions({ footerData: FOOTER_DATA, getChatBoxSession: () => current, getTaskSource: () => undefined }),
	);
	try {
		// A chat lists its own active tasks below its footer as agent-panel rows (#5224).
		const rows = (footer: string) => footer.split("\n").map((line) => line.replace(/ {2,}/g, "  ").trimEnd());
		assert.deepEqual(rows(text(withSource.renderFooter(80))), [
			`first-model • ${BOX_FOOTER_CWD}`,
			"  ◯ worker  Footer count  running",
		]);
		for (const host of [bare, empty])
			assert.deepEqual(text(host.renderFooter(80)).split("\n"), [`first-model • ${BOX_FOOTER_CWD}`]);
		current = boxSession("second-model");
		assert.deepEqual(rows(text(withSource.renderFooter(80))), [
			`second-model • ${BOX_FOOTER_CWD}`,
			"  ◯ worker  Footer count  running",
		]);
	} finally {
		withSource.dispose();
		bare.dispose();
		empty.dispose();
		await fixture.dispose();
	}
});

test("a chat that has an agent session counts the tasks of that session's own store, not its task source (#4640)", async () => {
	initTheme("dark");
	const owned = taskFixture();
	await owned.start("Owned by the session");
	const shown = taskFixture();
	const session = boxSession("agent-model");
	bindOwnerTaskStore(session, owned.store);
	const host = new ChatSessionHost(
		hostOptions({
			footerData: FOOTER_DATA,
			getAgentSession: () => session as never,
			getTaskSource: () => ownerTaskViewSource(shown.store),
		}),
	);
	try {
		assert.match(text(host.renderFooter(80)), /◯ worker {2}Owned by the session/);
	} finally {
		host.dispose();
		await owned.dispose();
		await shown.dispose();
	}
});

test("a footer without a task list of its own counts nothing for a session that has no task store (#4640)", () => {
	initTheme("dark");
	const footer = new FooterComponent(boxSession("lone-model"), FOOTER_DATA);
	assert.deepEqual(text(footer.render(80)).split("\n"), [`lone-model • ${BOX_FOOTER_CWD}`]);
	footer.dispose();
});

test("a chat that does not own its running session never offers to interrupt it, and shows its model once idle (#4640, #4690)", () => {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	let session = { ...boxSession("busy-model"), isStreaming: true } as ChatBoxSession;
	const borrowed = new ChatSessionHost(hostOptions({ footerData: FOOTER_DATA, getChatBoxSession: () => session }));
	const owned = new ChatSessionHost(hostOptions({ footerData: FOOTER_DATA, getAgentSession: () => session as never }));
	try {
		assert.deepEqual(borrowed.renderFooter(80), []);
		assert.match(text(owned.renderFooter(80)), /esc to interrupt/);
		session = boxSession("busy-model");
		assert.deepEqual(text(borrowed.renderFooter(80)).split("\n"), [`busy-model • ${BOX_FOOTER_CWD}`]);
		assert.deepEqual(text(owned.renderFooter(80)).split("\n"), [`busy-model • ${BOX_FOOTER_CWD}`]);
	} finally {
		borrowed.dispose();
		owned.dispose();
		setKeybindings(previous);
	}
});
