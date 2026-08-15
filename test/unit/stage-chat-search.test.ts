/**
 * Find-in-stage-chat (spec §5.5).
 *
 * Three things have to be true for this feature to be honest:
 *  - `Ctrl+Shift+F` in a focused stage chat searches *that chat*, and the key
 *    never reaches the main transcript hidden behind it;
 *  - the corpus is the whole stage transcript, so a match hundreds of rows
 *    above the window is found and scrolled to rather than missed;
 *  - `Escape` closes the find box and does nothing else — the stage keeps
 *    running and the pane stays open.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import {
	isFullscreenViewportAction,
	shouldHandleFullscreenViewportInput,
} from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";
import {
	assistantTextMessage,
	createStore,
	deriveGraphTheme,
	makeHandle,
	makeTestTui,
	setupRun,
	stripAnsi,
} from "./stage-chat-view-helpers.js";

/** pi-tui's default `tui.altScreen.search`, in the kitty encoding. */
const CTRL_SHIFT_F = "\x1b[102;6u";
/** pi-tui's default `tui.altScreen.searchNext`. */
const ENTER = "\r";
/** pi-tui's default `tui.altScreen.searchClose`. */
const ESCAPE = "\x1b";
const WIDTH = 80;
const VIEWPORT_ROWS = 24;
const FILLER_MESSAGES = 80;
/** Filler messages painted before the needle, so it never sits on row 0. */
const LEAD_MESSAGES = 12;
/** Appears once, far above any window this chat shows. */
const NEEDLE = "buried needle";
/** pi-tui's zero-width hardware-cursor marker, which occupies no column. */
const CURSOR_MARKER = /\x1b_pi:c\x07/g;

interface ChatFixture {
	view: StageChatView;
	closes: () => number;
	interrupts: () => number;
	detaches: () => number;
	render: () => string[];
	visible: () => string;
}

/**
 * A stage chat whose needle is buried under enough filler to sit well outside
 * any rendered window, plus real keybindings so the search keys resolve exactly
 * as they do in a session.
 */
function makeSearchableChat(options: { streaming?: boolean; piTheme?: unknown } = {}): ChatFixture {
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const messages = [
		...Array.from({ length: LEAD_MESSAGES }, (_, index) => assistantTextMessage(`lead line ${index + 1}`)),
		assistantTextMessage(`the ${NEEDLE} is here`),
		...Array.from({ length: FILLER_MESSAGES }, (_, index) => assistantTextMessage(`filler line ${index + 1}`)),
	];
	const { handle } = makeHandle(
		{
			promptCalls: [],
			steerCalls: [],
			followUpCalls: [],
			pauseCalls: 0,
			resumeCalls: [],
			isStreaming: options.streaming === true,
		},
		messages,
	);
	let closes = 0;
	let detaches = 0;
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle,
		onDetach: () => {
			detaches += 1;
		},
		onClose: () => {
			closes += 1;
		},
		piTui: makeTestTui(VIEWPORT_ROWS),
		piTheme: options.piTheme,
		piKeybindings: new KeybindingsManager({}),
	});
	const chatHost = (view as unknown as { chatHost: { interrupt(options?: unknown): Promise<void> } }).chatHost;
	let interrupts = 0;
	const originalInterrupt = chatHost.interrupt.bind(chatHost);
	chatHost.interrupt = async (interruptOptions?: unknown) => {
		interrupts += 1;
		await originalInterrupt(interruptOptions);
	};
	const render = () => view.render(WIDTH);
	return {
		view,
		closes: () => closes,
		interrupts: () => interrupts,
		detaches: () => detaches,
		render,
		// Strip line by line: the follow indicator's OSC 8 link would otherwise
		// let a strip of the joined frame swallow the rows after it.
		visible: () => render().map(plain).join("\n"),
	};
}

/** One rendered row as the reader sees it: no escapes, no zero-width marker. */
function plain(line: string): string {
	return stripAnsi(line).replace(CURSOR_MARKER, "");
}

/** Escape an ANSI sequence for use inside a regular expression. */
function escapeAnsi(sequence: string): string {
	return sequence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function type(view: StageChatView, text: string): void {
	for (const character of text) view.handleInput(character);
}

describe("stage chat search", () => {
	/**
	 * `TuiAltScreen.handleViewportInput` matches `tui.altScreen.search` before
	 * its own overlay guard, so upstream's answer to `Ctrl+Shift+F` over a stage
	 * chat is a find box on the main transcript underneath. Atomic's fullscreen
	 * action allowlist refuses the key to the viewport while a non-editor
	 * component holds focus, and the stage chat consumes it — both halves are
	 * asserted here, because either one alone leaves the misrouting possible.
	 */
	test("stage-chat-search-does-not-reach-transcript", () => {
		const keybindings = new KeybindingsManager({});
		const overlay = { render: () => ["stage chat"], handleInput: () => true, invalidate: () => {} };
		const editor = { render: () => ["editor"], invalidate: () => {} };

		assert.equal(
			isFullscreenViewportAction(CTRL_SHIFT_F, keybindings),
			true,
			"ctrl+shift+f must be a gated fullscreen action, or the gate never sees it",
		);
		assert.equal(
			shouldHandleFullscreenViewportInput(overlay, editor, CTRL_SHIFT_F, false, true, keybindings),
			false,
			"the fullscreen transcript must not claim ctrl+shift+f while a stage chat is focused",
		);

		const chat = makeSearchableChat();
		assert.doesNotMatch(chat.visible(), /Find in stage chat/);

		assert.equal(chat.view.handleInput(CTRL_SHIFT_F), true, "the stage chat must consume ctrl+shift+f");
		assert.match(chat.visible(), /Find in stage chat/);

		type(chat.view, "filler");
		const searching = chat.visible();
		assert.match(searching, /Find in stage chat/);
		// The query went to the find box, not to the composer behind it.
		assert.equal(chat.view._inputBuffer, "");
		assert.match(searching, /> filler/);
		assert.match(searching, /\d+\/\d+/);
	});

	test("the matcher covers rows the viewport window does not hold", () => {
		const chat = makeSearchableChat();
		const beforeSearch = chat.visible();
		assert.doesNotMatch(beforeSearch, new RegExp(NEEDLE), "fixture is wrong: the needle starts on screen");
		assert.match(beforeSearch, /filler line 80/);

		chat.view.handleInput(CTRL_SHIFT_F);
		type(chat.view, NEEDLE);

		const searching = chat.visible();
		assert.match(searching, /1\/1/, "the only match sits far above the window and must still be counted");
		assert.match(searching, new RegExp(NEEDLE), "the selected match must be scrolled into view");
	});

	/**
	 * The highlight is painted with the host theme's `searchMatchBg` /
	 * `searchMatchText` — the same two tokens the fullscreen transcript search
	 * uses (L8) — so the two surfaces look alike under any theme.
	 */
	test("a match is painted with the host theme's search-match colors", () => {
		const searchMatchBg = "\x1b[48;2;9;9;9m";
		const searchMatchText = "\x1b[38;2;1;2;3m";
		const piTheme = {
			getFgAnsi: (color: string) => (color === "searchMatchText" ? searchMatchText : ""),
			getBgAnsi: (color: string) => (color === "searchMatchBg" ? searchMatchBg : ""),
		};
		const chat = makeSearchableChat({ piTheme });

		chat.view.handleInput(CTRL_SHIFT_F);
		type(chat.view, NEEDLE);
		const highlighted = chat.render().find((line) => plain(line).includes("buried"));

		assert.ok(highlighted, "the revealed match must be on screen");
		assert.match(
			highlighted,
			new RegExp(`${escapeAnsi(searchMatchBg)}${escapeAnsi(searchMatchText)}\\x1b\\[1mburied`),
		);
		// Only the match is repainted; the rest of the row keeps its own colors.
		assert.equal(highlighted.split(searchMatchBg).length - 1, 2, "expected exactly the two segments of one match");
	});

	test("without a host theme the highlight falls back to the overlay palette", () => {
		const chat = makeSearchableChat();
		const fallbackBg = deriveGraphTheme({}).selection;

		chat.view.handleInput(CTRL_SHIFT_F);
		type(chat.view, NEEDLE);
		const highlighted = chat.render().find((line) => plain(line).includes("buried"));

		assert.ok(highlighted, "the revealed match must be on screen");
		assert.match(highlighted, /\x1b\[48;2;69;71;90m\x1b\[38;2;205;214;244m\x1b\[1mburied/);
		assert.equal(fallbackBg, "#45475a", "fixture pins the palette this assertion encodes");
	});

	test("enter walks the matches and the selection is reported", () => {
		const chat = makeSearchableChat();
		chat.view.handleInput(CTRL_SHIFT_F);
		type(chat.view, "filler line 1");

		const first = chat.visible();
		const total = Number(/(\d+)\/(\d+)/.exec(first)?.[2] ?? "0");
		assert.ok(total > 1, `expected several matches, got ${total}`);
		assert.match(first, /1\/\d+/);

		chat.view.handleInput(ENTER);
		assert.match(chat.visible(), /2\/\d+/);
		// Enter drove the search rather than submitting the composer.
		assert.equal(chat.view._inputBuffer, "");
	});

	test("escape closes the search without interrupting the stage or closing the pane", async () => {
		const chat = makeSearchableChat({ streaming: true });
		chat.view.handleInput(CTRL_SHIFT_F);
		type(chat.view, "filler");
		assert.match(chat.visible(), /Find in stage chat/);

		assert.equal(chat.view.handleInput(ESCAPE), true);
		await new Promise<void>((resolve) => queueMicrotask(resolve));

		assert.doesNotMatch(chat.visible(), /Find in stage chat/);
		assert.equal(chat.interrupts(), 0, "escape must not abort the stage while a search is open");
		assert.equal(chat.closes(), 0, "escape must not close the pane while a search is open");
		assert.equal(chat.detaches(), 0);

		// With the search gone, escape returns to the interrupt ladder.
		chat.view.handleInput(ESCAPE);
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		assert.equal(chat.interrupts(), 1);
	});

	test("the find bar takes its rows from the body and the frame keeps its height", () => {
		const chat = makeSearchableChat();
		const before = chat.render();
		assert.equal(before.length, VIEWPORT_ROWS);

		chat.view.handleInput(CTRL_SHIFT_F);
		const after = chat.render();

		assert.equal(after.length, VIEWPORT_ROWS, "opening the find box must not grow the frame");
		for (const line of after) {
			const row = plain(line);
			assert.ok(row.length <= WIDTH, `line exceeds width: ${JSON.stringify(row)}`);
		}
	});
});
