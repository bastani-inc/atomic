import { tmpdir } from "node:os";
import {
	type Component,
	getKeybindings,
	isKeyRelease,
	ScrollView,
	setKeybindings,
	setKittyProtocolActive,
	Text,
	TUI_KEYBINDINGS,
	TuiAltScreen,
	KeybindingsManager as TuiKeybindingsManager,
	VStack,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { KEYBINDINGS, type KeybindingsConfig, KeybindingsManager } from "../src/core/keybindings.ts";
import { shouldHandleFullscreenViewportInput } from "../src/modes/interactive/interactive-mode-base.ts";
import { createFullscreenTui, createInteractiveTui } from "../src/modes/interactive/interactive-tui.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";

const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const HOME = "\x1b[H";
const ESCAPE = "\x1b";
/** Legacy `alt+enter`: ESC and CR reassembled into one sequence by `StdinBuffer`. */
const ALT_ENTER = "\x1b\r";
/** SGR wheel reports at row 2, column 10. */
const WHEEL_UP = "\x1b[<64;10;2M";
const CTRL_Y = "\x19";
/** Default `app.thinking.toggle`. */
const CTRL_T = "\x14";
/** A remapped `app.thinking.toggle`, bound to nothing pi-tui's `Input` claims. */
const ALT_T = "\x1bt";
/** Kitty-protocol `ctrl+shift+f`, pi-tui 0.84.2's default `tui.altScreen.search` key. */
const CTRL_SHIFT_F = "\x1b[102;6u";
/** pi-tui's `PAGE_SCROLL_OVERLAP`: a page moves `viewportHeight` minus this. */
const PAGE_SCROLL_OVERLAP = 4;
const TRANSCRIPT_LINES = 120;
/** Atomic ships the search actions unbound; a user binding is how the find box opens today. */
const SEARCH_BINDING: KeybindingsConfig = { "tui.altScreen.search": "ctrl+shift+f" };
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
/** pi-tui's zero-width hardware-cursor marker (`dist/tui.js:21`). */
const CURSOR_MARKER = "\x1b_pi:c\x07";

const initialKeybindings = getKeybindings();

beforeAll(() => {
	initTheme("dark");
});

afterEach(() => {
	setKeybindings(initialKeybindings);
});

/** An overlay that takes focus and records every key it is offered. */
class RecordingOverlay implements Component {
	readonly handledInputs: string[] = [];
	/** Whether the overlay claims the input, the way a dialog claims its selection keys. */
	consumes = false;

	render(): string[] {
		return ["dialog"];
	}

	handleInput(data: string): boolean {
		this.handledInputs.push(data);
		return this.consumes;
	}

	invalidate(): void {}
}

interface Fixture {
	tui: TuiAltScreen;
	terminal: RecordingTerminal;
	transcript: ScrollView;
	overlay: RecordingOverlay;
	editor: Text;
	/** Input the gated route handed to the host thinking action, in order. */
	thinkingToggles: string[];
	stop: () => void;
}

interface FixtureOptions {
	/** Whether the focused overlay consumes what it is offered. Default: declines. */
	consumes?: boolean;
	/** User keybindings, applied to both the global manager and the gate's manager. */
	userBindings?: KeybindingsConfig;
	/** Default true. When false the editor keeps focus and no overlay is mounted. */
	mountOverlay?: boolean;
}

function createFixture(options: FixtureOptions = {}): Fixture {
	const userBindings = options.userBindings ?? {};
	// pi-tui reads the global manager inside `handleViewportInput`; Atomic's gate
	// reads the one handed to `shouldHandleFullscreenViewportInput`. Both must
	// see the same bindings or the two halves of the routing disagree.
	setKeybindings(new KeybindingsManager(userBindings));
	const keybindings = new KeybindingsManager(userBindings);
	const terminal = new RecordingTerminal();
	terminal.columns = 100;
	terminal.rows = 40;

	const editor = new Text("editor", 0, 0);
	const thinkingToggles: string[] = [];
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
		// Mirrors `InteractiveModeBase.handleOverlayUnhandledInput`: the host
		// thinking action, dispatched only on the gated route.
		onOverlayUnhandledInput: (data) => {
			if (isKeyRelease(data) || !keybindings.matches(data, "app.thinking.toggle")) return false;
			thinkingToggles.push(data);
			return true;
		},
	});

	const transcript = new ScrollView(
		new Text(Array.from({ length: TRANSCRIPT_LINES }, (_, index) => `transcript line ${index + 1}`).join("\n"), 0, 0),
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

	const overlay = new RecordingOverlay();
	overlay.consumes = options.consumes === true;
	if (options.mountOverlay !== false) {
		tui.showOverlay(overlay, { anchor: "bottom-center", width: "100%" });
		tui.renderNow();
		expect(tui.getFocusedComponent()).toBe(overlay);
	} else {
		expect(tui.getFocusedComponent()).toBe(editor);
	}

	return { tui, terminal, transcript, overlay, editor, thinkingToggles, stop: () => tui.stop() };
}

/** Scroll to the bottom and report the resulting `scrollTop` plus a page's worth of rows. */
function anchorAtEnd(fixture: Fixture): { top: number; page: number } {
	fixture.transcript.scrollToEnd();
	fixture.tui.renderNow();
	const page = Math.max(1, fixture.transcript.viewportHeight - PAGE_SCROLL_OVERLAP);
	expect(page).toBeGreaterThan(1);
	return { top: fixture.transcript.scrollTop, page };
}

/** pi-tui keeps its find box private (tui-alt-screen.d.ts:50, alt-screen-search.d.ts:12). */
interface AltScreenSearchInternals {
	activeSearch?: { component: Component; overlay?: { isFocused(): boolean } };
}

function activeSearch(fixture: Fixture): { component: Component; overlay?: { isFocused(): boolean } } | undefined {
	return (fixture.tui as unknown as AltScreenSearchInternals).activeSearch;
}

/** Open pi-tui's find box the way a user with the action bound does, and confirm it took focus. */
function openTranscriptSearch(fixture: Fixture): void {
	fixture.terminal.input(CTRL_SHIFT_F);
	fixture.tui.renderNow();
	const search = activeSearch(fixture);
	expect(search, "ctrl+shift+f opened no search").toBeDefined();
	expect(search?.overlay?.isFocused()).toBe(true);
	expect(fixture.tui.getFocusedComponent()).toBe(search?.component);
}

/** The find box's query, read off its own frame: the input field is private. */
function searchQuery(fixture: Fixture): string {
	const search = activeSearch(fixture);
	if (!search) throw new Error("no active transcript search");
	const rows = search.component.render(40);
	const field = rows[rows.length - 1] ?? "";
	return field.replaceAll(CURSOR_MARKER, "").replaceAll(ANSI, "").replace(/^> /, "").trimEnd();
}

function type(fixture: Fixture, text: string): void {
	for (const character of text) fixture.terminal.input(character);
	fixture.tui.renderNow();
}

/**
 * Record what the find box is offered, without changing what it does.
 * `AltScreenSearchComponent.handleInput` returns `void`, so a key it silently
 * swallowed is invisible in the transcript's scroll position alone.
 */
function recordSearchInput(fixture: Fixture): string[] {
	const search = activeSearch(fixture);
	if (!search) throw new Error("no active transcript search");
	const { component } = search;
	const offered: string[] = [];
	const handleInput = component.handleInput?.bind(component);
	component.handleInput = (data: string): void => {
		offered.push(data);
		handleInput?.(data);
	};
	return offered;
}

/**
 * pi-tui 0.84.2 added `shouldDeferViewportInputToOverlay()` (upstream #7894),
 * which drops viewport keys and wheel reports whenever an overlay holds focus.
 * Atomic decided the opposite in issue #2378 / PR #2381: the focused overlay is
 * offered the input first, and whatever it declines still scrolls the
 * transcript. The bump put pi-tui's answer on top of Atomic's, so the replay
 * Atomic performs after a decline was deferred a second time and discarded.
 *
 * The suppression is scoped to that replay. Everything the gate does not route
 * through the overlay keeps pi-tui's own routing, which `docs/keybindings.md`
 * promises for custom `tui.altScreen.*` bindings.
 */
describe("pi-tui 0.84.2 overlay viewport deferral", () => {
	test("a focused overlay that declines PAGE_UP still pages the transcript", () => {
		const fixture = createFixture();
		try {
			const { top, page } = anchorAtEnd(fixture);

			fixture.terminal.input(PAGE_UP);
			fixture.tui.renderNow();
			expect(top - fixture.transcript.scrollTop).toBe(page);
			// The overlay is still offered the key it declined; the gate does not
			// hide input from it.
			expect(fixture.overlay.handledInputs).toContain(PAGE_UP);

			fixture.terminal.input(PAGE_DOWN);
			fixture.tui.renderNow();
			expect(fixture.transcript.scrollTop).toBe(top);
		} finally {
			fixture.stop();
		}
	});

	test("a focused overlay that declines a wheel report still scrolls the transcript", () => {
		const fixture = createFixture();
		try {
			const { top } = anchorAtEnd(fixture);

			fixture.terminal.input(WHEEL_UP);
			fixture.tui.renderNow();
			expect(fixture.transcript.scrollTop).toBe(top - 1);
		} finally {
			fixture.stop();
		}
	});

	test("a focused overlay that consumes PAGE_UP leaves the transcript alone", () => {
		const fixture = createFixture({ consumes: true });
		try {
			const { top } = anchorAtEnd(fixture);

			fixture.terminal.input(PAGE_UP);
			fixture.tui.renderNow();
			expect(fixture.overlay.handledInputs).toEqual([PAGE_UP]);
			expect(fixture.transcript.scrollTop).toBe(top);
		} finally {
			fixture.stop();
		}
	});

	test("a focused overlay that consumes a wheel report leaves the transcript alone", () => {
		const fixture = createFixture({ consumes: true });
		try {
			const { top } = anchorAtEnd(fixture);

			fixture.terminal.input(WHEEL_UP);
			fixture.tui.renderNow();
			expect(fixture.overlay.handledInputs).toEqual([WHEEL_UP]);
			expect(fixture.transcript.scrollTop).toBe(top);
		} finally {
			fixture.stop();
		}
	});

	/**
	 * `tui.altScreen.lineUp` is deliberately absent from
	 * `FULLSCREEN_VIEWPORT_ACTIONS`, so Atomic's gate never offers it to the
	 * overlay and never replays it. pi-tui's native deferral therefore decides,
	 * and a focused component sees the key first — what `docs/keybindings.md`
	 * documents for a custom `tui.altScreen.*` binding.
	 */
	test("a viewport action outside Atomic's gate reaches a consuming focused overlay", () => {
		const fixture = createFixture({ consumes: true, userBindings: { "tui.altScreen.lineUp": "ctrl+y" } });
		try {
			const { top } = anchorAtEnd(fixture);

			fixture.terminal.input(CTRL_Y);
			fixture.tui.renderNow();
			expect(fixture.overlay.handledInputs).toEqual([CTRL_Y]);
			expect(fixture.transcript.scrollTop).toBe(top);
		} finally {
			fixture.stop();
		}
	});

	test("the same binding scrolls the transcript when no overlay is focused", () => {
		const fixture = createFixture({ mountOverlay: false, userBindings: { "tui.altScreen.lineUp": "ctrl+y" } });
		try {
			const { top } = anchorAtEnd(fixture);

			fixture.terminal.input(CTRL_Y);
			fixture.tui.renderNow();
			expect(fixture.transcript.scrollTop).toBe(top - 1);
			expect(fixture.overlay.handledInputs).toEqual([]);
		} finally {
			fixture.stop();
		}
	});
});

/**
 * pi-tui 0.84.2 binds transcript search by default and matches
 * `tui.altScreen.search` *before* it defers input to a focused overlay. Atomic's
 * gate does not list the search actions and nothing themes or scopes them yet,
 * so an inherited default would open an unthemed search over the main transcript
 * from inside a focused overlay and take its focus.
 */
describe("pi-tui 0.84.2 transcript search defaults", () => {
	test("Atomic ships the four transcript-search actions unbound", () => {
		for (const action of [
			"tui.altScreen.search",
			"tui.altScreen.searchNext",
			"tui.altScreen.searchPrevious",
			"tui.altScreen.searchClose",
		] as const) {
			expect(TUI_KEYBINDINGS[action].defaultKeys, `pi-tui still binds ${action}`).not.toEqual([]);
			expect(KEYBINDINGS[action].defaultKeys, `${action} is bound by default`).toEqual([]);
			expect(KEYBINDINGS[action].description).toBe(TUI_KEYBINDINGS[action].description);
		}

		// The same byte sequence matches under pi-tui's defaults, which is what
		// proves the assertion above is about Atomic's suppression rather than an
		// unrecognized key.
		expect(new TuiKeybindingsManager(TUI_KEYBINDINGS, {}).matches(CTRL_SHIFT_F, "tui.altScreen.search")).toBe(true);
		expect(new KeybindingsManager().matches(CTRL_SHIFT_F, "tui.altScreen.search")).toBe(false);
	});

	test("ctrl+shift+f reaches the focused overlay instead of opening a transcript search", () => {
		const fixture = createFixture({ consumes: true });
		try {
			const { top } = anchorAtEnd(fixture);

			fixture.terminal.input(CTRL_SHIFT_F);
			fixture.tui.renderNow();

			expect(fixture.overlay.handledInputs).toEqual([CTRL_SHIFT_F]);
			expect(fixture.tui.getFocusedComponent()).toBe(fixture.overlay);
			expect(fixture.transcript.scrollTop).toBe(top);
			expect((fixture.tui as unknown as { activeSearch?: unknown }).activeSearch).toBeUndefined();
		} finally {
			fixture.stop();
		}
	});

	test("ctrl+shift+f opens no search over the main transcript either", () => {
		const fixture = createFixture({ mountOverlay: false });
		try {
			fixture.terminal.input(CTRL_SHIFT_F);
			fixture.tui.renderNow();
			expect((fixture.tui as unknown as { activeSearch?: unknown }).activeSearch).toBeUndefined();
		} finally {
			fixture.stop();
		}
	});
});

/**
 * The one overlay Atomic's gate does not own. pi-tui mounts its find box as an
 * overlay and then exempts it from `shouldDeferViewportInputToOverlay()`
 * (`dist/tui-alt-screen.js:379`) so the transcript keeps scrolling while a
 * search is open. Atomic's gate had no such exemption: it offered every
 * viewport action and every mouse report to the find box first, which let
 * pi-tui's `Input` claim `home`/`end` as cursor motion — silently, since
 * `AltScreenSearchComponent.handleInput` returns `void` — while the same key
 * also scrolled the transcript through the replay.
 *
 * Atomic's own overlays keep Atomic's policy; this exemption is scoped to the
 * find box while it holds focus.
 */
describe("focused transcript search keeps the viewport", () => {
	test("transcript-scrolls-while-search-focused", () => {
		const fixture = createFixture({ mountOverlay: false, userBindings: SEARCH_BINDING });
		try {
			const { top, page } = anchorAtEnd(fixture);
			openTranscriptSearch(fixture);
			const offered = recordSearchInput(fixture);

			fixture.terminal.input(PAGE_UP);
			fixture.tui.renderNow();
			expect(top - fixture.transcript.scrollTop).toBe(page);

			fixture.terminal.input(WHEEL_UP);
			fixture.tui.renderNow();
			expect(top - fixture.transcript.scrollTop).toBe(page + 1);

			fixture.terminal.input(PAGE_DOWN);
			fixture.tui.renderNow();
			expect(top - fixture.transcript.scrollTop).toBe(1);

			// The viewport owns these outright: the find box is never offered them,
			// so it cannot swallow one silently.
			expect(offered).toEqual([]);
			// Scrolling never cost the find box its focus or its query.
			expect(activeSearch(fixture)?.overlay?.isFocused()).toBe(true);
			expect(searchQuery(fixture)).toBe("");
		} finally {
			fixture.stop();
		}
	});

	test("home scrolls the transcript instead of moving the query cursor", () => {
		const fixture = createFixture({ mountOverlay: false, userBindings: SEARCH_BINDING });
		try {
			anchorAtEnd(fixture);
			openTranscriptSearch(fixture);
			type(fixture, "line");
			expect(searchQuery(fixture)).toBe("line");

			// `home` is `tui.altScreen.top` and `tui.editor.cursorLineStart` at once.
			// Fullscreen gives it to the viewport, so the caret stays at the end.
			fixture.terminal.input(HOME);
			fixture.tui.renderNow();
			expect(fixture.transcript.scrollTop).toBe(0);

			type(fixture, "s");
			expect(searchQuery(fixture)).toBe("lines");
		} finally {
			fixture.stop();
		}
	});

	test("the find box still receives every key the viewport does not claim", () => {
		const fixture = createFixture({ mountOverlay: false, userBindings: SEARCH_BINDING });
		try {
			anchorAtEnd(fixture);
			openTranscriptSearch(fixture);
			const offered = recordSearchInput(fixture);

			type(fixture, "line 7");
			expect(offered).toEqual(["l", "i", "n", "e", " ", "7"]);
			expect(searchQuery(fixture)).toBe("line 7");
			// The query drives pi-tui's matcher, which is the point of typing at all.
			expect(activeSearch(fixture)).toMatchObject({ query: "line 7" });
		} finally {
			fixture.stop();
		}
	});

	test("an Atomic overlay focused above an open search keeps Atomic's policy", () => {
		const fixture = createFixture({ consumes: true, mountOverlay: false, userBindings: SEARCH_BINDING });
		try {
			const { top } = anchorAtEnd(fixture);
			openTranscriptSearch(fixture);

			fixture.tui.showOverlay(fixture.overlay, { anchor: "bottom-center", width: "100%" });
			fixture.tui.renderNow();
			expect(fixture.tui.getFocusedComponent()).toBe(fixture.overlay);
			expect(activeSearch(fixture)?.overlay?.isFocused()).toBe(false);

			fixture.terminal.input(PAGE_UP);
			fixture.tui.renderNow();
			expect(fixture.overlay.handledInputs).toEqual([PAGE_UP]);
			expect(fixture.transcript.scrollTop).toBe(top);
		} finally {
			fixture.stop();
		}
	});

	/**
	 * The exemption covers viewport keys, not host actions.
	 * `app.thinking.toggle` is documented and remappable, and it is dispatched
	 * from `onOverlayUnhandledInput`, which only the gated route runs — so an
	 * exemption checked first would silently drop the toggle for as long as the
	 * find box held focus.
	 */
	test("the default thinking toggle still runs while the find box has focus", () => {
		const fixture = createFixture({ mountOverlay: false, userBindings: SEARCH_BINDING });
		try {
			anchorAtEnd(fixture);
			openTranscriptSearch(fixture);
			type(fixture, "line");
			const scrollTop = fixture.transcript.scrollTop;
			const offered = recordSearchInput(fixture);

			fixture.terminal.input(CTRL_T);
			fixture.tui.renderNow();

			expect(fixture.thinkingToggles).toEqual([CTRL_T]);
			// The find box is offered the key and declines it; that decline is what
			// hands it to the host action.
			expect(offered).toEqual([CTRL_T]);
			// Routing it through the find box costs nothing: pi-tui's `Input`
			// rejects control sequences, and the viewport never saw the key.
			expect(searchQuery(fixture)).toBe("line");
			expect(activeSearch(fixture)?.overlay?.isFocused()).toBe(true);
			expect(fixture.transcript.scrollTop).toBe(scrollTop);
		} finally {
			fixture.stop();
		}
	});

	test("a remapped thinking toggle still runs while the find box has focus", () => {
		const fixture = createFixture({
			mountOverlay: false,
			userBindings: { ...SEARCH_BINDING, "app.thinking.toggle": "alt+t" },
		});
		try {
			anchorAtEnd(fixture);
			openTranscriptSearch(fixture);
			const offered = recordSearchInput(fixture);

			// The default key binds nothing once the action moves.
			fixture.terminal.input(CTRL_T);
			fixture.tui.renderNow();
			expect(fixture.thinkingToggles).toEqual([]);

			fixture.terminal.input(ALT_T);
			fixture.tui.renderNow();
			expect(fixture.thinkingToggles).toEqual([ALT_T]);
			expect(offered).toEqual([CTRL_T, ALT_T]);
			expect(searchQuery(fixture)).toBe("");
			expect(activeSearch(fixture)?.overlay?.isFocused()).toBe(true);
		} finally {
			fixture.stop();
		}
	});

	test("the find box still owns page and wheel scrolling with the toggle rule ahead of it", () => {
		const fixture = createFixture({ mountOverlay: false, userBindings: SEARCH_BINDING });
		try {
			const { top, page } = anchorAtEnd(fixture);
			openTranscriptSearch(fixture);
			const offered = recordSearchInput(fixture);

			fixture.terminal.input(PAGE_UP);
			fixture.terminal.input(WHEEL_UP);
			fixture.tui.renderNow();

			expect(top - fixture.transcript.scrollTop).toBe(page + 1);
			expect(offered).toEqual([]);
			expect(fixture.thinkingToggles).toEqual([]);
		} finally {
			fixture.stop();
		}
	});
});

/**
 * Probe for upstream `2a95ef70` (the `PI_TUI_ESC_TIMEOUT` window applies only
 * to a lone ESC) and `06ed8716` (an `Alt+Enter` split by SSH latency must not
 * read as Escape-then-Enter). Both fixes reassemble bytes inside
 * `StdinBuffer`/`ProcessTerminal`, upstream of every input listener, so the
 * open question for Atomic is the other direction: does the chunk-splitting
 * replay in `routeViewportInput` take a reassembled sequence apart again?
 *
 * It does not. `replayMouseInput` splits only a chunk whose every byte is a
 * mouse report; both sequences below survive a decline intact and still match
 * the action they are bound to. **Outcome: no breakage, no fix needed.**
 */
describe("pi 0.84.2 ESC-timeout and split Alt+Enter probes", () => {
	test("a lone ESC bound to a viewport action replays as one sequence", () => {
		const fixture = createFixture({ userBindings: { "tui.altScreen.pageUp": "escape" } });
		try {
			const { top, page } = anchorAtEnd(fixture);

			fixture.terminal.input(ESCAPE);
			fixture.tui.renderNow();
			expect(fixture.overlay.handledInputs).toEqual([ESCAPE]);
			expect(top - fixture.transcript.scrollTop).toBe(page);
		} finally {
			fixture.stop();
		}
	});

	test("a reassembled alt+enter replays as one sequence", () => {
		// `\x1b\r` is `alt+enter` only while the Kitty protocol is inactive, which
		// is the transport `06ed8716` is about.
		setKittyProtocolActive(false);
		const fixture = createFixture({ userBindings: { "tui.altScreen.pageUp": "alt+enter" } });
		try {
			const { top, page } = anchorAtEnd(fixture);
			expect(getKeybindings().matches(ALT_ENTER, "tui.altScreen.pageUp")).toBe(true);

			fixture.terminal.input(ALT_ENTER);
			fixture.tui.renderNow();
			// One chunk to the overlay, and one chunk to pi-tui after the decline:
			// a replay split into ESC and CR would match neither.
			expect(fixture.overlay.handledInputs).toEqual([ALT_ENTER]);
			expect(top - fixture.transcript.scrollTop).toBe(page);
		} finally {
			fixture.stop();
		}
	});
});

/**
 * `shouldUseFullscreenTui` returns the `TuiMainScreen` fallback under
 * `TERM=dumb` even when a terminal is injected, so a fixture that reaches
 * fullscreen through `createInteractiveTui` silently loses its layout, its
 * gate, and every assertion above whenever the suite runs in that environment.
 */
describe("fullscreen fixtures do not depend on TERM", () => {
	test("createFullscreenTui builds the alt-screen renderer while createInteractiveTui falls back", () => {
		const previousTerm = process.env.TERM;
		process.env.TERM = "dumb";
		try {
			const fullscreen = createFullscreenTui({
				showHardwareCursor: false,
				logDirectory: tmpdir(),
				terminal: new RecordingTerminal(),
			});
			try {
				expect(fullscreen).toBeInstanceOf(TuiAltScreen);
				expect(typeof (fullscreen as { setLayoutRoot?: unknown }).setLayoutRoot).toBe("function");
			} finally {
				fullscreen.stop();
			}

			const selected = createInteractiveTui({
				showHardwareCursor: false,
				logDirectory: tmpdir(),
				terminal: new RecordingTerminal(),
			});
			expect(selected).not.toBeInstanceOf(TuiAltScreen);
		} finally {
			if (previousTerm === undefined) delete process.env.TERM;
			else process.env.TERM = previousTerm;
		}
	});

	test("a focused overlay that declines PAGE_UP still pages the transcript under TERM=dumb", () => {
		const previousTerm = process.env.TERM;
		process.env.TERM = "dumb";
		try {
			const fixture = createFixture();
			try {
				const { top, page } = anchorAtEnd(fixture);

				fixture.terminal.input(PAGE_UP);
				fixture.tui.renderNow();
				expect(top - fixture.transcript.scrollTop).toBe(page);
			} finally {
				fixture.stop();
			}
		} finally {
			if (previousTerm === undefined) delete process.env.TERM;
			else process.env.TERM = previousTerm;
		}
	});
});
