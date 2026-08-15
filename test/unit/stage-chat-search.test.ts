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
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { getKeybindings, ScrollView, setKeybindings, Text, type TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { describe, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import {
	isFullscreenViewportAction,
	shouldHandleFullscreenViewportInput,
} from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import { createFullscreenTui } from "../../packages/coding-agent/src/modes/interactive/interactive-tui.ts";
import type { Theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme-class.ts";
import { loadThemeFromContent } from "../../packages/coding-agent/src/modes/interactive/theme/theme-loading.ts";
import { RecordingTerminal } from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.ts";
import type { PiCustomComponent } from "../../packages/workflows/src/extension/ui-surface.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { searchMatchColors } from "../../packages/workflows/src/tui/graph-theme.js";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";
import {
	type AgentSessionEvent,
	assistantTextMessage,
	createStore,
	deriveGraphTheme,
	flush,
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
/** Not bound to anything here until a test rebinds `searchNext` onto it. */
const CTRL_N = "\x0e";
const PAGE_UP = "\x1b[5~";
const HOME = "\x1b[H";
const WIDTH = 80;
const VIEWPORT_ROWS = 24;
const FILLER_MESSAGES = 80;
/** Filler messages painted before the needle, so it never sits on row 0. */
const LEAD_MESSAGES = 12;
/** Appears once, far above any window this chat shows. */
const NEEDLE = "buried needle";
/**
 * The needle *in the transcript*. The query line of the find bar shows the
 * needle too, so a bare match on the frame proves only that the reader typed
 * it; the trailing words are what pin it to a body row.
 */
const needlePattern = new RegExp(`${NEEDLE} is here`);
/** Comfortably past `tailStreamingText`'s 240-line window. */
const STREAM_LINES = 300;
/** pi-tui's zero-width hardware-cursor marker, which occupies no column. */
const CURSOR_MARKER = /\x1b_pi:c\x07/g;

interface ChatFixture {
	view: StageChatView;
	store: ReturnType<typeof createStore>;
	broker: StageUiBroker;
	handle: ReturnType<typeof makeHandle>["handle"];
	emit: (event: AgentSessionEvent) => void;
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
function makeSearchableChat(
	options: {
		streaming?: boolean;
		piTheme?: unknown;
		piKeybindings?: unknown;
		leadMessages?: number;
		messages?: string[];
	} = {},
): ChatFixture {
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const leadMessages = options.leadMessages ?? LEAD_MESSAGES;
	const texts = options.messages ?? [
		...Array.from({ length: leadMessages }, (_, index) => `lead line ${index + 1}`),
		`the ${NEEDLE} is here`,
		...Array.from({ length: FILLER_MESSAGES }, (_, index) => `filler line ${index + 1}`),
	];
	const messages = texts.map((text) => assistantTextMessage(text));
	const { handle, emit } = makeHandle(
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
	const broker = new StageUiBroker(store);
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
		piKeybindings: options.piKeybindings ?? new KeybindingsManager({}),
		stageUiBroker: broker,
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
		store,
		broker,
		handle,
		emit,
		closes: () => closes,
		interrupts: () => interrupts,
		detaches: () => detaches,
		render,
		// Strip line by line: the follow indicator's OSC 8 link would otherwise
		// let a strip of the joined frame swallow the rows after it.
		visible: () => render().map(plain).join("\n"),
	};
}

/** Start an assistant turn and stream `lines` into it as one delta. */
function streamAssistantText(chat: ChatFixture, lines: readonly string[]): void {
	chat.emit({ type: "message_start", message: { role: "assistant", content: [] } } as unknown as AgentSessionEvent);
	chat.emit({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: lines.join("\n") },
	} as unknown as AgentSessionEvent);
}

/** Every row of the body, on screen or not — the corpus a search reads. */
function bodyCorpus(chat: ChatFixture): string {
	const host = (
		chat.view as unknown as {
			chatHost: {
				bodyRowCount(width: number): number;
				renderBodyRows(width: number, startRow: number, endRow: number): string[];
			};
		}
	).chatHost;
	return host.renderBodyRows(WIDTH, 0, host.bodyRowCount(WIDTH)).map(plain).join("\n");
}

/**
 * Mount a stage custom UI over the chat, the way a stage that asks for one
 * does. `consumes: false` is the shape that matters here: a custom UI that
 * declines a key hands it back, and what happens next is the whole question.
 */
async function mountCustomUi(chat: ChatFixture, consumes: boolean): Promise<AbortController> {
	const abort = new AbortController();
	const pending = chat.broker.requestCustomUi(
		"run-1",
		"stage-a",
		(): PiCustomComponent => ({
			render: () => ["stage question"],
			handleInput: () => consumes,
			invalidate: () => {},
		}),
		undefined,
		abort.signal,
	);
	pending.catch(() => {});
	await flush();
	chat.render();
	return abort;
}

interface FullscreenProbe {
	press: (data: string) => void;
	mainSearchOpened: () => boolean;
	stop: () => void;
}

/**
 * The stage chat mounted as the focused overlay of a *real* fullscreen
 * renderer: Atomic's viewport gate, pi-tui's transcript, and pi-tui's own find
 * box, wired exactly as `InteractiveModeBase` wires them.
 *
 * This is the only place the misrouting is visible. A stage chat that returns
 * `false` looks harmless on its own; it is `AtomicTuiAltScreen` replaying that
 * declined key into pi-tui that opens a find box on the main transcript behind
 * the overlay.
 */
function mountInFullscreenRoute(view: StageChatView): FullscreenProbe {
	const previousKeybindings = getKeybindings();
	const keybindings = new KeybindingsManager({});
	// pi-tui reads the global manager; Atomic's gate reads the one below. Both
	// must see the same bindings or the two halves disagree.
	setKeybindings(new KeybindingsManager({}));
	const terminal = new RecordingTerminal();
	terminal.columns = WIDTH;
	terminal.rows = VIEWPORT_ROWS;
	const editor = new Text("editor", 0, 0);
	let tui!: TuiAltScreen;
	tui = createFullscreenTui({
		showHardwareCursor: false,
		logDirectory: tmpdir(),
		terminal,
		shouldHandleViewportInput: (data, isMouseInput, focusedIsOverlay, focusedIsViewportSearch) =>
			shouldHandleFullscreenViewportInput(
				tui.getFocusedComponent(),
				editor,
				data,
				isMouseInput,
				focusedIsOverlay,
				keybindings,
				focusedIsViewportSearch,
			),
	});
	const transcript = new ScrollView(
		new Text(Array.from({ length: 120 }, (_, index) => `transcript line ${index + 1}`).join("\n"), 0, 0),
		{ follow: "end", primary: true },
	);
	tui.setLayoutRoot(
		new VStack([
			{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: editor, basis: 1, shrink: 0 },
		]),
	);
	tui.setFocus(editor);
	tui.start();
	tui.renderNow();
	tui.showOverlay(view, { anchor: "bottom-center", width: "100%" });
	tui.renderNow();
	assert.equal(tui.getFocusedComponent(), view, "the stage chat must be the focused overlay");
	return {
		press: (data: string) => {
			terminal.input(data);
			tui.renderNow();
		},
		// pi-tui keeps its find box private (`tui-alt-screen.d.ts`).
		mainSearchOpened: () => (tui as unknown as { activeSearch?: unknown }).activeSearch !== undefined,
		stop: () => {
			tui.stop();
			setKeybindings(previousKeybindings);
		},
	};
}

/** The shipped dark theme with the two search tokens pinned to known colors. */
function themeWithSearchColors(searchMatchBg: string, searchMatchText: string): Theme {
	const source = new URL("../../packages/coding-agent/src/modes/interactive/theme/dark.json", import.meta.url);
	const json = JSON.parse(readFileSync(source, "utf8")) as { colors: Record<string, string> };
	json.colors.searchMatchBg = searchMatchBg;
	json.colors.searchMatchText = searchMatchText;
	return loadThemeFromContent("stage-chat-search-test.json", JSON.stringify(json), "truecolor");
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
	 *
	 * The last half is the one a gate test cannot see: a declined key is
	 * *replayed* into pi-tui, so a stage chat that answers `false` reopens the
	 * hole the gate closed. That state is real — a mounted stage custom UI that
	 * does not claim the key — and it is exercised here through the whole
	 * fullscreen route rather than simulated.
	 */
	test("stage-chat-search-does-not-reach-transcript", async () => {
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

		// A mounted stage custom UI that declines the key, on the real route.
		const declining = makeSearchableChat({ piTheme: {} });
		const abort = await mountCustomUi(declining, false);
		const probe = mountInFullscreenRoute(declining.view);
		try {
			assert.match(declining.visible(), /stage question/, "the declining custom UI must actually be mounted");
			assert.equal(
				declining.view.handleInput(CTRL_SHIFT_F),
				true,
				"a stage chat whose custom UI declines the key must still consume it",
			);
			probe.press(CTRL_SHIFT_F);
			assert.equal(
				probe.mainSearchOpened(),
				false,
				"ctrl+shift+f reached the main transcript behind the focused stage chat",
			);
		} finally {
			probe.stop();
			abort.abort();
			declining.view.dispose();
		}
	});

	test("the matcher covers rows the viewport window does not hold", () => {
		const chat = makeSearchableChat();
		const beforeSearch = chat.visible();
		assert.doesNotMatch(beforeSearch, needlePattern, "fixture is wrong: the needle starts on screen");
		assert.match(beforeSearch, /filler line 80/);

		chat.view.handleInput(CTRL_SHIFT_F);
		type(chat.view, NEEDLE);

		const searching = chat.visible();
		assert.match(searching, /1\/1/, "the only match sits far above the window and must still be counted");
		assert.match(searching, needlePattern, "the selected match must be scrolled into view");
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

	/**
	 * The colors have to survive a real `Theme`, whose accessors read instance
	 * state through `this` (`theme-class.ts:158-171`). Passing them around as
	 * detached functions throws on every call, and that throw reads exactly like
	 * "this theme has no such token" — a silent, perfect-looking fallback for
	 * every host that actually defines the two colors.
	 */
	test("a real host Theme supplies the search-match colors", () => {
		const piTheme = themeWithSearchColors("#141516", "#111213");
		assert.deepEqual(
			searchMatchColors(piTheme, deriveGraphTheme({})),
			{ bg: "#141516", text: "#111213" },
			"a real Theme must reach the highlight, not the overlay fallback",
		);

		const chat = makeSearchableChat({ piTheme });
		chat.view.handleInput(CTRL_SHIFT_F);
		type(chat.view, NEEDLE);
		const highlighted = chat.render().find((line) => plain(line).includes("buried"));

		assert.ok(highlighted, "the revealed match must be on screen");
		assert.match(highlighted, /\x1b\[48;2;20;21;22m\x1b\[38;2;17;18;19m\x1b\[1mburied/);
	});

	/**
	 * A streaming stage rewrites rows it already has: the row count, the width
	 * and the query all stay put while the text underneath them changes. An
	 * open search that keys on those three answers with the transcript as it
	 * was, which is the one thing a live search may not do.
	 */
	test("the query is re-run against text streamed into a row the transcript already had", () => {
		const chat = makeSearchableChat({ streaming: true, messages: ["alpha"] });
		const host = (chat.view as unknown as { chatHost: { bodyRowCount(width: number): number } }).chatHost;
		chat.emit({
			type: "message_start",
			message: { role: "assistant", content: [] },
		} as unknown as AgentSessionEvent);
		chat.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "beta" },
		} as unknown as AgentSessionEvent);

		chat.view.handleInput(CTRL_SHIFT_F);
		type(chat.view, "needle");
		assert.match(chat.visible(), /No matches/);
		const rowsBefore = host.bodyRowCount(WIDTH);

		chat.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " needle" },
		} as unknown as AgentSessionEvent);
		const searching = chat.visible();

		assert.equal(host.bodyRowCount(WIDTH), rowsBefore, "fixture is wrong: the streamed row changed the row count");
		assert.match(searching, /1\/1/, "an open search must answer against the transcript as it is now");
		assert.match(searching, /beta needle/);
	});

	/**
	 * The top of the transcript is the boundary the reveal arithmetic can walk
	 * off: the scroll target sits above row zero and clamps. The match still has
	 * to end up on screen rather than one row above it.
	 */
	test("a match at the top of the transcript is revealed, not only counted", () => {
		const chat = makeSearchableChat({ leadMessages: 0 });
		assert.doesNotMatch(chat.visible(), needlePattern, "fixture is wrong: the needle starts on screen");

		chat.view.handleInput(CTRL_SHIFT_F);
		type(chat.view, NEEDLE);

		const searching = chat.visible();
		assert.match(searching, /1\/1/);
		assert.match(searching, needlePattern, "the first transcript row must be shown, not just counted");
	});

	/**
	 * The follow indicator takes a row from the body whenever the reader is
	 * scrolled up. It used to take it off the top of the *painted* body, so the
	 * row the viewport reported as first was not the row the reader saw and
	 * absolute row zero could not be shown at all. Reserving the row up front
	 * keeps the two in agreement, which is what the reveal arithmetic assumes.
	 */
	test("the body starts on the row the viewport parks it on", () => {
		const chat = makeSearchableChat({ leadMessages: 0 });
		const host = (
			chat.view as unknown as {
				chatHost: {
					bodyMaxScroll(): number;
					bodyScrollFromBottom(): number;
					renderBodyRows(width: number, startRow: number, endRow: number): string[];
				};
			}
		).chatHost;
		chat.render();
		// Scroll up first: the indicator appears and the body settles at the
		// height it keeps for the rest of this test.
		chat.view.handleInput(PAGE_UP);
		chat.render();
		chat.view.handleInput(HOME);
		const frame = chat.render();

		assert.equal(host.bodyMaxScroll() - host.bodyScrollFromBottom(), 0, "home must park the body on row 0");
		const topRows = host.renderBodyRows(WIDTH, 0, 3);
		const start = frame.findIndex((_, index) => topRows.every((row, offset) => frame[index + offset] === row));
		assert.ok(start >= 0, "the first transcript row was clipped off the top of the body");
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

	/**
	 * The stage can be blocked between the frame that painted the find bar and
	 * the keystroke that answers it. The reader still sees a find box, so
	 * Escape still means "close it" — it may not fall through and interrupt the
	 * stage on the way past.
	 */
	test("escape closes the search on the frame the stage becomes blocked", async () => {
		const chat = makeSearchableChat({ streaming: true });
		chat.view.handleInput(CTRL_SHIFT_F);
		type(chat.view, "filler");
		assert.match(chat.visible(), /Find in stage chat/);

		chat.store.recordStageBlocked("run-1", "stage-a", "review-a");

		assert.equal(chat.view.handleInput(ESCAPE), true);
		await flush();
		assert.equal(chat.interrupts(), 0, "escape must not abort the stage while the find box is open");
		assert.equal(chat.closes(), 0, "escape must not close the pane while the find box is open");

		// The block took the transcript out of the body, so the bar goes too.
		const blocked = chat.visible();
		assert.match(blocked, /BLOCKED/);
		assert.doesNotMatch(blocked, /Find in stage chat/);
	});

	test("a body that no longer shows the transcript drops the find bar", async () => {
		const chat = makeSearchableChat({ piTheme: {} });
		chat.view.handleInput(CTRL_SHIFT_F);
		type(chat.view, "filler");
		assert.match(chat.visible(), /Find in stage chat/);

		const abort = await mountCustomUi(chat, true);
		try {
			const mounted = chat.visible();
			assert.match(mounted, /stage question/);
			assert.doesNotMatch(mounted, /Find in stage chat/);
		} finally {
			abort.abort();
			chat.view.dispose();
		}
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

	/**
	 * A sticky-bottom body renders a live assistant entry as its last 240 lines
	 * (`tailStreamingText`), and those were the rows the search measured. The
	 * corpus is supposed to be the *whole* stage transcript, so the first half
	 * of a long answer reported `No matches` for text the reader had scrolled
	 * past a moment earlier.
	 */
	test("a live stream longer than its tail window is searched whole", () => {
		const chat = makeSearchableChat({ streaming: true, messages: ["settled line"] });
		streamAssistantText(chat, [
			`the ${NEEDLE} is here`,
			...Array.from({ length: STREAM_LINES }, (_, index) => `stream line ${index + 1}`),
		]);
		chat.render();

		const corpus = bodyCorpus(chat);
		assert.match(corpus, /earlier streaming output hidden/, "fixture is wrong: the tail window did not engage");
		assert.doesNotMatch(corpus, needlePattern, "fixture is wrong: the tail window kept the head of the stream");

		chat.view.handleInput(CTRL_SHIFT_F);
		type(chat.view, NEEDLE);

		const searching = chat.visible();
		assert.match(searching, /1\/1/, "the head of a live stream is part of the transcript this search covers");
		assert.match(searching, needlePattern, "the match must be revealed, not only counted");
	});

	/**
	 * The search measures the rows this frame is about to paint, then scrolls
	 * to the selected match. Both halves used to be answered with the previous
	 * frame's layout: a match inside rows appended since the last paint was
	 * judged visible when it was not, and the absolute scroll clamped against a
	 * smaller `maxScroll` — leaving the body at the new bottom with `1/1` in
	 * the bar and nothing highlighted anywhere.
	 */
	test("a match in rows that arrived since the last paint is revealed, not only counted", () => {
		const chat = makeSearchableChat({
			streaming: true,
			messages: Array.from({ length: 100 }, (_, index) => `settled line ${index + 1}`),
		});
		const painted = chat.visible();
		assert.match(painted, /settled line 100/, "fixture is wrong: the chat did not paint its live end");
		assert.doesNotMatch(painted, needlePattern);

		streamAssistantText(chat, [
			`the ${NEEDLE} is here`,
			...Array.from({ length: 40 }, (_, index) => `appended line ${index + 1}`),
		]);

		chat.view.handleInput(CTRL_SHIFT_F);
		type(chat.view, NEEDLE);

		const searching = chat.visible();
		assert.match(searching, /1\/1/);
		assert.match(searching, needlePattern, "the reported match must be on screen, not only in the query box");
	});

	/**
	 * A paused stage keeps its chat rows on screen under the PAUSED callout, so
	 * it accepts the search key — and used to answer every query with `No
	 * matches`, because only the live branch ever ran the matcher.
	 */
	test("a paused stage chat searches the transcript it is showing", () => {
		const chat = makeSearchableChat();
		chat.render();
		assert.equal(chat.store.recordStagePaused("run-1", "stage-a"), true);
		assert.match(chat.visible(), /PAUSED/);

		assert.equal(chat.view.handleInput(CTRL_SHIFT_F), true);
		type(chat.view, NEEDLE);

		const searching = chat.visible();
		assert.match(searching, /Find in stage chat/);
		assert.match(searching, /1\/1/, "a paused chat must search the rows it is painting");
		assert.match(searching, needlePattern);
	});

	/**
	 * A read-only archive paints its transcript above the READ-ONLY callout,
	 * and it too accepted `ctrl+shift+f`. The find box was then closed by the
	 * next render, which treated every archive as hidden chat chrome.
	 */
	test("a read-only archive searches the transcript it is showing", () => {
		const chat = makeSearchableChat();
		chat.render();
		const stage = chat.store.runs()[0]?.stages[0];
		assert.ok(stage);
		chat.store.recordStageEnd("run-1", { ...stage, status: "completed", endedAt: Date.now() });
		Object.defineProperty(chat.handle, "isDisposed", { value: true });
		assert.match(chat.visible(), /READ-ONLY SESSION/);

		assert.equal(chat.view.handleInput(CTRL_SHIFT_F), true);
		type(chat.view, NEEDLE);

		const searching = chat.visible();
		assert.match(searching, /Find in stage chat/, "the archive accepted the key, so it must show the box");
		assert.match(searching, /1\/1/);
		assert.match(searching, needlePattern);
	});

	/**
	 * A custom UI mounts through the broker, which is not a render: until the
	 * next paint the chat holds both an open find box and a mounted UI. Escape
	 * belongs to the box on that frame, and only to it — the mounted UI used to
	 * receive the same keystroke and could act on it.
	 */
	test("escape closes an open search before a newly mounted custom UI sees it", async () => {
		const chat = makeSearchableChat({ piTheme: {} });
		chat.view.handleInput(CTRL_SHIFT_F);
		type(chat.view, "filler");
		assert.match(chat.visible(), /Find in stage chat/);

		const keys: string[] = [];
		const abort = new AbortController();
		const pending = chat.broker.requestCustomUi(
			"run-1",
			"stage-a",
			(): PiCustomComponent => ({
				render: () => ["stage question"],
				handleInput: (data: string) => {
					keys.push(data);
					return true;
				},
				invalidate: () => {},
			}),
			undefined,
			abort.signal,
		);
		pending.catch(() => {});
		// Deliberately no render between mounting and the keystroke: that window
		// is the whole state under test.
		await flush();

		try {
			assert.equal(chat.view.handleInput(ESCAPE), true);
			assert.deepEqual(keys, [], "the mounted custom UI must not see the escape that closed the search");
			assert.equal(chat.interrupts(), 0);
			assert.equal(chat.closes(), 0);
			assert.doesNotMatch(chat.visible(), /Find in stage chat/);
		} finally {
			abort.abort();
			chat.view.dispose();
		}
	});

	/**
	 * pi-tui routes its transcript search through the four `tui.altScreen.*`
	 * actions and nothing else. A reader who moves `searchNext` onto another
	 * key has unbound Enter, and Enter must then be query text here too —
	 * otherwise the stage chat keeps a shortcut the keybindings manager says
	 * does not exist.
	 */
	test("a remapped searchNext governs stage-chat navigation", () => {
		const keybindings = new KeybindingsManager({ "tui.altScreen.searchNext": "ctrl+n" });
		assert.equal(
			keybindings.matches(ENTER, "tui.altScreen.searchNext"),
			false,
			"fixture is wrong: enter is still bound to searchNext",
		);
		assert.equal(keybindings.matches(CTRL_N, "tui.altScreen.searchNext"), true);

		const chat = makeSearchableChat({ piKeybindings: keybindings });
		chat.view.handleInput(CTRL_SHIFT_F);
		type(chat.view, "filler line 1");
		assert.match(chat.visible(), /1\/\d+/);

		chat.view.handleInput(ENTER);
		assert.match(chat.visible(), /1\/\d+/, "an unbound enter must not walk the matches");

		chat.view.handleInput(CTRL_N);
		assert.match(chat.visible(), /2\/\d+/, "the bound searchNext must walk them");
	});
});
