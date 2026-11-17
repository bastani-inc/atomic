import assert from "node:assert/strict";
import { setKeybindings, stripTerminalSequences, TuiMainScreen } from "@bastani/atomic-tui";
import { beforeAll, beforeEach, describe, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ChatSessionHost } from "../src/modes/interactive/components/chat-session-host.ts";
import type { ChatSessionHostStyle } from "../src/modes/interactive/components/chat-session-host-types.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";

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
		assert.ok(open.some((line) => line.includes("❯ summarize the failing gate") && line.endsWith("6m ago")));
		assert.equal(open.at(-2)?.trim(), "enter use · type to search · esc cancel");
		chat.handleInput("\r");
		assert.equal(chat.inputText(), "summarize the failing gate");
		assert.ok(!plain(chat.renderEditor(100)).some((line) => line.includes("Search prompts")));
	});

	it("esc closes the search and leaves the draft alone", () => {
		const chat = host();
		chat.setInputText("draft");
		chat.handleInput("\x12");
		chat.handleInput("\x1b");
		assert.equal(chat.inputText(), "draft");
		assert.ok(!plain(chat.renderEditor(100)).some((line) => line.includes("Search prompts")));
	});
});
