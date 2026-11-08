// @ts-nocheck

/**
 * The user is told when compaction had to remove protected blocks to fit the context window (#4568),
 * in the interactive UI and in a workflow stage's chat host.
 */

import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import {
	type Component,
	Container,
	type EditorTheme,
	getKeybindings,
	setKeybindings,
	Text,
} from "@earendil-works/pi-tui";
import { afterAll, beforeAll, test } from "vitest";
import { droppedProtectedWarning } from "../../packages/coding-agent/src/core/compaction/protected-overflow.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { applyChatSessionAgentEvent } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host-events.ts";
import { ChatSessionHostState } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host-state.ts";
import { ProgramStatusReporter } from "../../packages/coding-agent/src/modes/interactive/program-status-reporter.js";
import "../../packages/coding-agent/src/modes/interactive/interactive-agent-events.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-editor-actions.ts";
import { InteractiveModeBase } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import { setThemeInstance } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { loadTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme-loading.ts";

const previousKeybindings = getKeybindings();

beforeAll(() => {
	setThemeInstance(loadTheme("dark", "truecolor"));
	setKeybindings(new KeybindingsManager());
});
afterAll(() => setKeybindings(previousKeybindings));

const DROPPED = {
	count: 2,
	lines: 9,
	ranges: [
		{ start: 3, end: 6 },
		{ start: 10, end: 14 },
	],
};

function result(extra = {}) {
	return {
		compactedText: "[User]: retained",
		firstKeptEntryId: null,
		tokensBefore: 100,
		parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "task" },
		promptVersion: 6,
		rung: "fresh",
		stats: {
			linesBefore: 4,
			linesDeleted: 1,
			linesKept: 3,
			rangeCount: 1,
			tokensBefore: 100,
			tokensAfter: 50,
			percentReduction: 50,
		},
		...extra,
	};
}

function interactiveMode() {
	const chatContainer = new Container();
	const ui = { requestRender() {}, terminal: { setProgress() {} } };
	const mode = {
		isInitialized: true,
		footer: { invalidate() {} },
		programStatus: new ProgramStatusReporter(
			() => ({ setProgramStatus() {} }) as never,
			() => undefined,
		),
		ui,
		autoCompactionLoader: undefined,
		autoCompactionEscapeHandlerSaved: false,
		defaultEditor: { onEscape() {} },
		statusContainer: new Container(),
		chatContainer,
		pendingTools: new Map(),
		compactionQueuedMessages: [],
		settingsManager: {
			getShowTerminalProgress: () => false,
			getClearOnShrink: () => false,
			getShowCacheMissNotices: () => false,
		},
		session: { abortCompaction() {}, compactionReason: undefined },
		rebuildChatFromMessages() {},
		addCompactionBoundaryToChat() {},
		addCompactionCostNotice() {},
		flushCompactionQueue: () => Promise.resolve(),
		checkShutdownRequested: () => Promise.resolve(),
		showStatus() {},
		showError() {},
		showWarning: InteractiveModeBase.prototype.showWarning,
	};
	return { mode, rendered: () => stripVTControlCharacters(chatContainer.render(200).join("\n")) };
}

async function endInteractive(compactionResult) {
	const harness = interactiveMode();
	await InteractiveModeBase.prototype.handleEvent.call(harness.mode, {
		type: "compaction_end",
		reason: "overflow",
		aborted: false,
		willRetry: false,
		result: compactionResult,
	});
	return harness.rendered();
}

test("the interactive UI warns when compaction removed protected blocks (#4568)", async () => {
	const rendered = await endInteractive(result({ droppedProtected: DROPPED }));
	assert.ok(rendered.includes(`Warning: ${droppedProtectedWarning(DROPPED)}`), rendered);
	assert.match(rendered, /2 protected blocks \(9 lines\)/);
});

test("the interactive UI stays quiet when no protected block was removed (#4568)", async () => {
	assert.doesNotMatch(await endInteractive(result()), /protected/);
});

const identity = (text: string): string => text;

function chatState(warnings: string[]) {
	const editorTheme: EditorTheme = {
		borderColor: identity,
		selectList: {
			selectedPrefix: identity,
			selectedText: identity,
			description: identity,
			scrollInfo: identity,
			noMatch: identity,
		},
	};
	return new ChatSessionHostState(
		{
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
			editorTheme,
			isStreaming: () => false,
			showWarning: (message: string) => warnings.push(message),
		},
		{ renderEntry: (): Component => new Text("", 0, 0), transcriptCacheKey: () => "" },
	);
}

test("a workflow stage chat warns when compaction removed protected blocks (#4568)", () => {
	const warnings: string[] = [];
	applyChatSessionAgentEvent(chatState(warnings), {
		type: "compaction_end",
		reason: "overflow",
		aborted: false,
		willRetry: false,
		result: result({ droppedProtected: DROPPED }),
	});
	assert.deepEqual(warnings, [droppedProtectedWarning(DROPPED)]);
});

test("a workflow stage chat stays quiet when no protected block was removed (#4568)", () => {
	const warnings: string[] = [];
	applyChatSessionAgentEvent(chatState(warnings), {
		type: "compaction_end",
		reason: "overflow",
		aborted: false,
		willRetry: false,
		result: result(),
	});
	assert.deepEqual(warnings, []);
});
