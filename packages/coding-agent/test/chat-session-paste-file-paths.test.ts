import assert from "node:assert/strict";
import type { Component, EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { createChatSessionEditor } from "../src/modes/interactive/components/chat-session-host-editor.ts";
import { ChatSessionHostState } from "../src/modes/interactive/components/chat-session-host-state.ts";
import type { ChatSessionHostStyle } from "../src/modes/interactive/components/chat-session-host-types.ts";

const mocks = vi.hoisted(() => ({
	readClipboardFilePaths: vi.fn<() => Promise<string[] | null>>(),
}));

vi.mock("../src/utils/clipboard.ts", () => ({
	readClipboardFilePaths: mocks.readClipboardFilePaths,
	readClipboardText: async () => null,
}));

const identity = (text: string): string => text;

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

type PasteEditor = EditorComponent & {
	onPasteImage?: () => void;
	getCursor(): { line: number; col: number };
};

test("chat-session paste separates Finder file paths from adjacent text", async () => {
	mocks.readClipboardFilePaths.mockResolvedValue(["/tmp/photo.png"]);
	const inserted: string[] = [];
	const editor: PasteEditor = {
		render: () => [],
		invalidate: () => {},
		getText: () => "seeafter",
		setText: () => {},
		handleInput: () => {},
		insertTextAtCursor: (text) => inserted.push(text),
		getCursor: () => ({ line: 0, col: 3 }),
	};
	const state = new ChatSessionHostState(
		{ style, editorTheme, isStreaming: () => false },
		{
			renderEntry: (): Component => ({ render: () => [], invalidate: () => {} }),
			transcriptCacheKey: () => "",
		},
	);
	state.inputBuffer = "seeafter";
	state.editor = createChatSessionEditor(state, {} as TUI, {}, editorTheme, () => editor, {
		submit: () => {},
		restoreQueuedMessagesToEditor: () => {},
		abortCompaction: () => {},
		interrupt: async () => {},
		abortBash: () => {},
	});

	editor.onPasteImage?.();

	await expect.poll(() => inserted.length).toBe(1);
	assert.deepEqual(inserted, [" /tmp/photo.png "]);
});
