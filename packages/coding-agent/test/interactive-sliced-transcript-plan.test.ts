import assert from "node:assert/strict";
import { Text } from "@bastani/atomic-tui";
import { describe, test } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.js";
import type {
	AnchoredChatRecord,
	ChatRecordOwner,
	SessionChatRecords,
} from "../src/core/storage/session/chat-records.js";
import type { ChatMessageEntry } from "../src/modes/interactive/components/chat-message-renderer.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { clearChatForRerender } from "../src/modes/interactive/interactive-render-chat.js";
import {
	chatHistoryBuilt,
	finishChatHistory,
	StartupChatContainer,
} from "../src/modes/interactive/interactive-startup-chat-container.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

const usage = {
	input: 10,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 20,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeTurns(turns: number): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let parentId: string | null = null;
	let seq = 0;
	const push = (body: Omit<SessionEntry, "id" | "parentId" | "timestamp">): SessionEntry => {
		const id = `e-${seq++}`;
		const entry = {
			id,
			parentId,
			timestamp: new Date(1_700_000_000_000 + seq * 1_000).toISOString(),
			...body,
		} as SessionEntry;
		entries.push(entry);
		parentId = id;
		return entry;
	};
	for (let t = 0; t < turns; t++) {
		const callId = `call-${t}`;
		push({
			type: "message",
			message: { role: "user", content: [{ type: "text", text: `Turn ${t}: prompt` }], timestamp: seq },
		});
		push({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: `echo ${t}` } }],
				api: "openai-completions",
				provider: "test",
				model: "test",
				usage,
				stopReason: "toolUse",
				timestamp: seq,
			},
		});
		push({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: callId,
				toolName: "bash",
				content: [{ type: "text", text: `out-${t}` }],
				isError: false,
				timestamp: seq,
			},
		});
		push({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `Reply ${t}` }],
				api: "openai-completions",
				provider: "test",
				model: "test",
				usage,
				stopReason: "stop",
				timestamp: seq,
			},
		});
	}
	return entries;
}

function createModeHarness(options: {
	mode: "fullscreen" | "regular";
	entries: SessionEntry[];
	chatRecords?: {
		present: boolean;
		byAnchor?: Map<string, readonly AnchoredChatRecord[]>;
		orders?: readonly { anchor: string; promptId: string }[];
	};
}) {
	initTheme("dark");
	const chatContainer = new StartupChatContainer();
	chatContainer.releaseStartupOutput();
	const seqById = new Map(options.entries.map((e, i) => [e.id, i + 1]));
	let getEntrySeqCalls = 0;
	const history: string[] = [];
	let addToHistoryCalls = 0;
	const renderedEntries: ChatMessageEntry[] = [];

	let chatRecordScope: (() => { store: SessionChatRecords; owner: ChatRecordOwner } | undefined) | undefined;
	if (options.chatRecords) {
		const cfg = options.chatRecords;
		const store: SessionChatRecords = {
			has: async () => cfg.present,
			read: async (_owner, anchors) => {
				const out: AnchoredChatRecord[] = [];
				for (const anchor of anchors) {
					for (const rec of cfg.byAnchor?.get(anchor) ?? []) out.push(rec);
				}
				return out;
			},
			readOrders: async (_owner, promptIds) => {
				const set = new Set(promptIds);
				return (cfg.orders ?? []).filter((o) => set.has(o.promptId));
			},
		};
		const owner: ChatRecordOwner = { id: "s1", epoch: 1 };
		chatRecordScope = () => ({ store, owner });
	}

	const mode = {
		resetTranscriptSelection: () => undefined,
		pendingTools: new Map(),
		deferredRenderedUserInputs: [],
		deferredRenderedUserInputComponents: new Map(),
		chatContainer,
		footer: { invalidate: () => undefined },
		updateEditorBorderColor: () => undefined,
		editor: {
			addToHistory: (text: string) => {
				addToHistoryCalls++;
				const trimmed = text.trim();
				if (!trimmed) return;
				if (history.length > 0 && history[0] === trimmed) return;
				history.unshift(trimmed);
				if (history.length > 100) history.pop();
			},
			getHistory: () => [...history],
		},
		settingsManager: { getShowCacheMissNotices: () => false },
		sessionManager: {
			getSessionId: () => "s1",
			getEntrySeq: (id: string) => {
				getEntrySeqCalls++;
				return seqById.get(id);
			},
			getBranch: () => options.entries,
			getSessionRecoveryState: () => undefined,
			...(chatRecordScope ? { chatRecordScope } : {}),
		},
		session: {
			modelRuntime: { getModel: () => undefined },
			extensionRunner: { getEntryRenderer: () => undefined },
		},
		ui: { mode: options.mode, requestRender: () => undefined },
		addRenderedChatEntry: (chatEntry: ChatMessageEntry) => {
			renderedEntries.push(chatEntry);
			const label =
				chatEntry.kind === "user"
					? `U:${chatEntry.text}`
					: chatEntry.kind === "tool"
						? `T:${chatEntry.toolCallId}:${chatEntry.isPartial ? "partial" : "done"}:${JSON.stringify(chatEntry.args)}:${chatEntry.result?.isError ? "err" : "ok"}`
						: chatEntry.kind === "assistant"
							? `A:${chatEntry.message.content.map((c) => (c.type === "text" ? c.text : c.type)).join(",")}`
							: chatEntry.kind;
			const component = new Text(label, 0, 0);
			mode.chatContainer.addChild(component);
			return component;
		},
		addCustomEntryToChat: () => undefined,
		renderDeferredUserInput: () => undefined,
	};

	const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
		this: typeof mode,
		entries: SessionEntry[],
		opts?: { populateHistory?: boolean; updateFooter?: boolean },
	) => void;

	return {
		mode,
		chatContainer,
		renderedEntries,
		getEntrySeqCalls: () => getEntrySeqCalls,
		addToHistoryCalls: () => addToHistoryCalls,
		render: (entries: SessionEntry[], opts?: { populateHistory?: boolean; updateFooter?: boolean }) =>
			renderSessionEntries.call(mode, entries, opts),
		lines: () =>
			chatContainer
				.render(200)
				.map((l) => stripAnsi(l).trim())
				.filter(Boolean),
	};
}

describe("sliced fullscreen transcript planning", () => {
	test("bounds initial synchronous planning and prompt history population on large resumed sessions, then converges to full parity", async () => {
		const entries = makeTurns(400);
		const full = createModeHarness({ mode: "fullscreen", entries });
		const ref = createModeHarness({ mode: "regular", entries });

		full.render(entries, { populateHistory: true, updateFooter: true });
		ref.render(entries, { populateHistory: true, updateFooter: true });

		// Initial synchronous tick must plan only a bounded tail (not all 1,600 entries)
		// and populate at most 100 prompt-history entries (the editor cap).
		assert.ok(
			full.getEntrySeqCalls() <= 256,
			`initial fullscreen render called getEntrySeq ${full.getEntrySeqCalls()} times (expected <= 256)`,
		);
		assert.ok(
			full.addToHistoryCalls() <= 100,
			`initial fullscreen render called addToHistory ${full.addToHistoryCalls()} times (expected <= 100)`,
		);
		assert.deepEqual(full.mode.editor.getHistory(), ref.mode.editor.getHistory());

		// After background slices settle, full rendered transcript matches single-pass regular mode identically.
		await chatHistoryBuilt(full.chatContainer);
		assert.deepEqual(full.lines(), ref.lines());
	});

	test("falls back safely when a tail toolResult references a toolCall from an earlier turn", async () => {
		const entries = makeTurns(200);
		// Inject an unanswered toolCall at turn 0 and resolve it at the very end.
		const earlyCallId = "call-cross-boundary";
		const firstAsst = entries[1]!;
		if (firstAsst.type === "message" && firstAsst.message.role === "assistant") {
			firstAsst.message.content.push({
				type: "toolCall",
				id: earlyCallId,
				name: "read",
				arguments: { path: "a.ts" },
			});
		}
		entries.push({
			type: "message",
			id: "e-late-result",
			parentId: entries.at(-1)!.id,
			timestamp: new Date(1_700_009_000_000).toISOString(),
			message: {
				role: "toolResult",
				toolCallId: earlyCallId,
				toolName: "read",
				content: [{ type: "text", text: "file body" }],
				isError: false,
				timestamp: 999999,
			},
		} as SessionEntry);

		const full = createModeHarness({ mode: "fullscreen", entries });
		const ref = createModeHarness({ mode: "regular", entries });
		full.render(entries);
		ref.render(entries);
		await chatHistoryBuilt(full.chatContainer);
		assert.deepEqual(full.lines(), ref.lines());
	});

	test("falls back safely when a tail aborted assistant settles an earlier unanswered toolCall", async () => {
		const entries = makeTurns(200);
		const openCallId = "call-unanswered-early";
		const firstAsst = entries[1]!;
		if (firstAsst.type === "message" && firstAsst.message.role === "assistant") {
			firstAsst.message.content.push({
				type: "toolCall",
				id: openCallId,
				name: "bash",
				arguments: { command: "sleep" },
			});
		}
		entries.push({
			type: "message",
			id: "e-tail-abort",
			parentId: entries.at(-1)!.id,
			timestamp: new Date(1_700_009_000_000).toISOString(),
			message: {
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "test",
				model: "test",
				usage,
				stopReason: "aborted",
				errorMessage: "cancelled",
				timestamp: 999999,
			},
		} as SessionEntry);

		const full = createModeHarness({ mode: "fullscreen", entries });
		const ref = createModeHarness({ mode: "regular", entries });
		full.render(entries);
		ref.render(entries);
		await chatHistoryBuilt(full.chatContainer);
		assert.deepEqual(full.lines(), ref.lines());
	});

	test("applies saved chat record decorations to both tail and sliced older turns when mount.present is true", async () => {
		const entries = makeTurns(200);
		const firstReplyId = entries[3]!.id;
		const lastReplyId = entries.at(-1)!.id;
		const byAnchor = new Map<string, readonly AnchoredChatRecord[]>([
			[
				firstReplyId,
				[{ anchor: firstReplyId, record: { kind: "line", id: "rec-0", level: "warning", text: "OLD-DECORATION" } }],
			],
			[
				lastReplyId,
				[
					{
						anchor: lastReplyId,
						record: { kind: "line", id: "rec-last", level: "warning", text: "TAIL-DECORATION" },
					},
				],
			],
		]);
		const full = createModeHarness({
			mode: "fullscreen",
			entries,
			chatRecords: { present: true, byAnchor },
		});
		full.render(entries);
		await chatHistoryBuilt(full.chatContainer);
		// Simulate viewport observing all rows (as WindowedContainer does as the user scrolls).
		full.chatContainer.render(200);
		for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
		const text = full.lines().join("\n");
		assert.ok(text.includes("OLD-DECORATION"), "older sliced turn decoration must be applied");
		assert.ok(text.includes("TAIL-DECORATION"), "tail turn decoration must be applied");
		assert.ok(
			text.indexOf("OLD-DECORATION") < text.indexOf("Turn 1:"),
			"older decoration must stay at Turn 0, not jump to tail",
		);
	});

	test("clearing chat mid-slice cancels pending slices without leaking stale entries into a replacement session", async () => {
		const entries = makeTurns(300);
		const harness = createModeHarness({ mode: "fullscreen", entries });
		harness.render(entries);
		clearChatForRerender(harness.mode as never);
		const replacement = makeTurns(2);
		harness.render(replacement);
		for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
		const text = harness.lines().join("\n");
		assert.ok(!text.includes("Turn 200:"), "stale entries from cleared session leaked after clear");
		assert.ok(text.includes("Turn 0: prompt") && text.includes("Turn 1: prompt"));
	});

	test("finishChatHistory synchronously completes all deferred slices", () => {
		const entries = makeTurns(200);
		const full = createModeHarness({ mode: "fullscreen", entries });
		const ref = createModeHarness({ mode: "regular", entries });
		full.render(entries);
		ref.render(entries);
		finishChatHistory(full.chatContainer);
		assert.deepEqual(full.lines(), ref.lines());
	});
});
