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
/**
 * A printable `app.thinking.toggle` remap. `docs/keybindings.md` binds any
 * action to a bare letter, and pi-tui's `Input` inserts this one into the find
 * box query instead of rejecting it.
 */
const PLAIN_T = "t";
/** Kitty-protocol `ctrl+shift+f`, pi-tui 0.84.2's default `tui.altScreen.search` key. */
const CTRL_SHIFT_F = "\x1b[102;6u";
/** pi-tui's `PAGE_SCROLL_OVERLAP`: a page moves `viewportHeight` minus this. */
const PAGE_SCROLL_OVERLAP = 4;
const TRANSCRIPT_LINES = 120;
/** Pinned explicitly so these fixtures do not silently follow a change in pi-tui's default. */
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

/**
 * A focused overlay that only renders. `handleInput` is optional on a
 * component — `ExtensionCustomComponent` declares `handleInput?` and
 * `docs/tui.md` documents it as optional — so a notice, a spinner, or a
 * progress panel is a supported shape rather than a malformed one. It declines
 * every key by construction.
 */
class HandlerlessOverlay implements Component {
	render(): string[] {
		return ["notice"];
	}

	invalidate(): void {}
}

/** An overlay whose handler settles later, the way an async extension component does. */
class AsyncOverlay implements Component {
	readonly handledInputs: string[] = [];
	/** What the returned promise settles to. `undefined` is a documented decline. */
	settlesTo: boolean | undefined = undefined;
	/** When set, the handler rejects instead of resolving. */
	rejects = false;
	/** Runs synchronously inside the handler, before the promise settles. */
	onHandleInput?: () => void;

	render(): string[] {
		return ["async dialog"];
	}

	handleInput(data: string): Promise<boolean | undefined> {
		this.handledInputs.push(data);
		this.onHandleInput?.();
		return this.rejects ? Promise.reject(new Error("handler failed")) : Promise.resolve(this.settlesTo);
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

/** Mount a component as a focused overlay, the way `createFixture` mounts its own. */
function mountFocusedOverlay<T extends Component>(fixture: Fixture, component: T): T {
	fixture.tui.showOverlay(component, { anchor: "bottom-center", width: "100%" });
	fixture.tui.renderNow();
	expect(fixture.tui.getFocusedComponent()).toBe(component);
	return component;
}

/** Let a handler's promise settle, along with the replay its settlement schedules. */
async function settle(fixture: Fixture): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	fixture.tui.renderNow();
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
	 * `tui.altScreen.lineUp` is listed in `FULLSCREEN_VIEWPORT_ACTIONS` like
	 * every other `tui.altScreen.*` action, so the focused overlay is offered it
	 * first — what `docs/keybindings.md` documents for a custom
	 * `tui.altScreen.*` binding — and a consuming overlay keeps it.
	 */
	test("a single-line scroll binding reaches a consuming focused overlay", () => {
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

	/**
	 * The find-box rule below dispatches a host action before the focused
	 * component sees it. That rule is scoped to pi-tui's own chrome: an Atomic
	 * overlay keeps first refusal on every key, host action included, so a
	 * dialog can still bind a letter the host also binds.
	 */
	test("an application overlay keeps first refusal on a printable thinking toggle", () => {
		const fixture = createFixture({ consumes: true, userBindings: { "app.thinking.toggle": "t" } });
		try {
			fixture.terminal.input(PLAIN_T);
			fixture.tui.renderNow();
			expect(fixture.overlay.handledInputs).toEqual([PLAIN_T]);
			expect(fixture.thinkingToggles).toEqual([]);
		} finally {
			fixture.stop();
		}
	});

	test("an application overlay that declines a printable thinking toggle hands it to the host", () => {
		const fixture = createFixture({ userBindings: { "app.thinking.toggle": "t" } });
		try {
			const { top } = anchorAtEnd(fixture);

			fixture.terminal.input(PLAIN_T);
			fixture.tui.renderNow();
			expect(fixture.overlay.handledInputs).toEqual([PLAIN_T]);
			expect(fixture.thinkingToggles).toEqual([PLAIN_T]);
			expect(fixture.transcript.scrollTop).toBe(top);
		} finally {
			fixture.stop();
		}
	});
});

/**
 * A focused overlay with no `handleInput` at all. pi-tui's
 * `shouldDeferViewportInputToOverlay()` asks only whether an overlay holds
 * focus (`dist/tui-alt-screen.js:378`), so answering "the viewport owns it" in
 * Atomic's gate hands the key to pi-tui, which then drops it — the transcript
 * freezes behind a component that never asked for the key, and Atomic's
 * overlay-first / replay-on-decline policy is contradicted by the one overlay
 * shape that cannot decline anything explicitly. Such an overlay takes the
 * replay route instead.
 */
describe("a focused overlay with no input handler", () => {
	test("a handler-less focused overlay still pages the transcript", () => {
		const fixture = createFixture({ mountOverlay: false });
		try {
			mountFocusedOverlay(fixture, new HandlerlessOverlay());
			const { top, page } = anchorAtEnd(fixture);

			fixture.terminal.input(PAGE_UP);
			fixture.tui.renderNow();
			expect(top - fixture.transcript.scrollTop).toBe(page);

			fixture.terminal.input(PAGE_DOWN);
			fixture.tui.renderNow();
			expect(fixture.transcript.scrollTop).toBe(top);
		} finally {
			fixture.stop();
		}
	});

	test("a handler-less focused overlay still scrolls the transcript on a wheel report", () => {
		const fixture = createFixture({ mountOverlay: false });
		try {
			mountFocusedOverlay(fixture, new HandlerlessOverlay());
			const { top } = anchorAtEnd(fixture);

			fixture.terminal.input(WHEEL_UP);
			fixture.tui.renderNow();
			expect(fixture.transcript.scrollTop).toBe(top - 1);
		} finally {
			fixture.stop();
		}
	});

	test("the thinking toggle still runs under a handler-less focused overlay", () => {
		const fixture = createFixture({ mountOverlay: false });
		try {
			mountFocusedOverlay(fixture, new HandlerlessOverlay());
			const { top } = anchorAtEnd(fixture);

			fixture.terminal.input(CTRL_T);
			fixture.tui.renderNow();
			expect(fixture.thinkingToggles).toEqual([CTRL_T]);
			expect(fixture.transcript.scrollTop).toBe(top);
		} finally {
			fixture.stop();
		}
	});

	/**
	 * The route is widened for overlays only. A focused *non*-overlay without a
	 * handler keeps pi-tui's own routing, because pi-tui defers nothing to it and
	 * the replay would skip its post-listener phase for no gain.
	 */
	test("only an overlay takes the replay route when it cannot handle input", () => {
		const keybindings = new KeybindingsManager();
		const editor = new Text("editor", 0, 0);
		const handlerless = new HandlerlessOverlay();

		expect(shouldHandleFullscreenViewportInput(handlerless, editor, PAGE_UP, false, true, keybindings)).toBe(false);
		expect(shouldHandleFullscreenViewportInput(handlerless, editor, WHEEL_UP, true, true, keybindings)).toBe(false);
		expect(shouldHandleFullscreenViewportInput(handlerless, editor, PAGE_UP, false, false, keybindings)).toBe(true);
		expect(shouldHandleFullscreenViewportInput(handlerless, editor, WHEEL_UP, true, false, keybindings)).toBe(true);
		// The find box is still exempt, handler or not, and the editor and an
		// unfocused tree keep the shortcut.
		expect(shouldHandleFullscreenViewportInput(handlerless, editor, PAGE_UP, false, true, keybindings, true)).toBe(
			true,
		);
		expect(shouldHandleFullscreenViewportInput(editor, editor, PAGE_UP, false, false, keybindings)).toBe(true);
		expect(shouldHandleFullscreenViewportInput(null, editor, PAGE_UP, false, false, keybindings)).toBe(true);
	});
});

/**
 * The component contract is `boolean | undefined | Promise<boolean |
 * undefined>` (`src/core/extensions/ui-types.ts`), and `docs/tui.md` plus
 * `docs/extensions.md` document `false` *and* `undefined` as viewport
 * fallthrough. So every settled result other than `true` is a decline: a
 * handler that resolved `undefined` — the value an `async` function returns
 * when it just falls off the end — must replay exactly like one that resolved
 * `false`, rather than consuming the key and freezing the transcript.
 */
describe("an asynchronous overlay handler", () => {
	test("a handler resolving undefined still pages the transcript", async () => {
		const fixture = createFixture({ mountOverlay: false });
		try {
			const overlay = mountFocusedOverlay(fixture, new AsyncOverlay());
			const { top, page } = anchorAtEnd(fixture);

			fixture.terminal.input(PAGE_UP);
			await settle(fixture);

			// Offered once and replayed once: the overlay is not asked twice.
			expect(overlay.handledInputs).toEqual([PAGE_UP]);
			expect(top - fixture.transcript.scrollTop).toBe(page);
		} finally {
			fixture.stop();
		}
	});

	test("a handler resolving undefined still scrolls the transcript on a wheel report", async () => {
		const fixture = createFixture({ mountOverlay: false });
		try {
			const overlay = mountFocusedOverlay(fixture, new AsyncOverlay());
			const { top } = anchorAtEnd(fixture);

			fixture.terminal.input(WHEEL_UP);
			await settle(fixture);

			expect(overlay.handledInputs).toEqual([WHEEL_UP]);
			expect(fixture.transcript.scrollTop).toBe(top - 1);
		} finally {
			fixture.stop();
		}
	});

	test("a handler resolving false still pages the transcript", async () => {
		const fixture = createFixture({ mountOverlay: false });
		try {
			const overlay = mountFocusedOverlay(fixture, new AsyncOverlay());
			overlay.settlesTo = false;
			const { top, page } = anchorAtEnd(fixture);

			fixture.terminal.input(PAGE_UP);
			await settle(fixture);
			expect(top - fixture.transcript.scrollTop).toBe(page);
		} finally {
			fixture.stop();
		}
	});

	test("a handler resolving true leaves the transcript alone", async () => {
		const fixture = createFixture({ mountOverlay: false });
		try {
			const overlay = mountFocusedOverlay(fixture, new AsyncOverlay());
			overlay.settlesTo = true;
			const { top } = anchorAtEnd(fixture);

			fixture.terminal.input(PAGE_UP);
			await settle(fixture);
			expect(overlay.handledInputs).toEqual([PAGE_UP]);
			expect(fixture.transcript.scrollTop).toBe(top);
		} finally {
			fixture.stop();
		}
	});

	test("a rejected handler still pages the transcript", async () => {
		const fixture = createFixture({ mountOverlay: false });
		try {
			const overlay = mountFocusedOverlay(fixture, new AsyncOverlay());
			overlay.rejects = true;
			const { top, page } = anchorAtEnd(fixture);

			fixture.terminal.input(PAGE_UP);
			await settle(fixture);
			expect(top - fixture.transcript.scrollTop).toBe(page);
		} finally {
			fixture.stop();
		}
	});

	test("a handler resolving undefined still hands the thinking toggle to the host", async () => {
		const fixture = createFixture({ mountOverlay: false });
		try {
			const overlay = mountFocusedOverlay(fixture, new AsyncOverlay());
			const { top } = anchorAtEnd(fixture);

			fixture.terminal.input(CTRL_T);
			await settle(fixture);

			expect(overlay.handledInputs).toEqual([CTRL_T]);
			expect(fixture.thinkingToggles).toEqual([CTRL_T]);
			expect(fixture.transcript.scrollTop).toBe(top);
		} finally {
			fixture.stop();
		}
	});

	/** The focus guard: a chunk that moved focus belongs to whoever holds it now. */
	test("a handler that moves focus before it settles leaves the transcript alone", async () => {
		const fixture = createFixture({ mountOverlay: false });
		try {
			const overlay = mountFocusedOverlay(fixture, new AsyncOverlay());
			overlay.onHandleInput = () => fixture.tui.setFocus(fixture.editor);
			const { top } = anchorAtEnd(fixture);

			fixture.terminal.input(PAGE_UP);
			await settle(fixture);

			expect(overlay.handledInputs).toEqual([PAGE_UP]);
			expect(fixture.transcript.scrollTop).toBe(top);
		} finally {
			fixture.stop();
		}
	});
});

/**
 * pi-tui 0.84.2 binds transcript search by default and matches
 * `tui.altScreen.search` *before* it defers input to a focused overlay. Atomic
 * inherits those defaults now that the actions are themed and listed in
 * `FULLSCREEN_VIEWPORT_ACTIONS`: the gate offers `ctrl+shift+f` to a focused
 * overlay first, so a search opens over the transcript the reader is actually
 * looking at rather than the one hidden behind an open dialog.
 */
describe("pi-tui 0.84.2 transcript search defaults", () => {
	test("Atomic inherits the four transcript-search bindings", () => {
		for (const action of [
			"tui.altScreen.search",
			"tui.altScreen.searchNext",
			"tui.altScreen.searchPrevious",
			"tui.altScreen.searchClose",
		] as const) {
			expect(TUI_KEYBINDINGS[action].defaultKeys, `pi-tui no longer binds ${action}`).not.toEqual([]);
			expect(KEYBINDINGS[action].defaultKeys, `${action} diverges from pi-tui`).toEqual(
				TUI_KEYBINDINGS[action].defaultKeys,
			);
			expect(KEYBINDINGS[action].description).toBe(TUI_KEYBINDINGS[action].description);
		}

		expect(new TuiKeybindingsManager(TUI_KEYBINDINGS, {}).matches(CTRL_SHIFT_F, "tui.altScreen.search")).toBe(true);
		expect(new KeybindingsManager().matches(CTRL_SHIFT_F, "tui.altScreen.search")).toBe(true);
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

	test("ctrl+shift+f opens a search over the main transcript from the editor", () => {
		const fixture = createFixture({ mountOverlay: false });
		try {
			fixture.terminal.input(CTRL_SHIFT_F);
			fixture.tui.renderNow();
			expect((fixture.tui as unknown as { activeSearch?: unknown }).activeSearch).toBeDefined();
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
	 * find box held focus. The gated route dispatches it before the find box
	 * sees it, so the query cannot be edited by a key the host claims.
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
			// The host action runs before the find box sees the key, so the query
			// cannot be edited by a chunk the host is about to claim.
			expect(offered).toEqual([]);
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
			// `ctrl+t` binds nothing now, so it reaches the find box through pi-tui's
			// own route; `alt+t` is claimed by the host before the query sees it.
			expect(offered).toEqual([CTRL_T]);
			expect(searchQuery(fixture)).toBe("");
			expect(activeSearch(fixture)?.overlay?.isFocused()).toBe(true);
		} finally {
			fixture.stop();
		}
	});

	/**
	 * The remap that made "offer it to the find box first" untenable.
	 * `docs/keybindings.md` accepts a bare letter for any action, so
	 * `"app.thinking.toggle": "t"` is a legal binding — and pi-tui's `Input`
	 * does not reject a printable character the way it rejects `ctrl+t`. Offered
	 * first, `t` was typed into the query and *then* toggled thinking: the key
	 * did two things, one of them silent, because `AltScreenSearchComponent`
	 * returns `void`.
	 */
	test("a printable thinking-toggle remap never reaches the find box query", () => {
		const fixture = createFixture({
			mountOverlay: false,
			userBindings: { ...SEARCH_BINDING, "app.thinking.toggle": "t" },
		});
		try {
			anchorAtEnd(fixture);
			openTranscriptSearch(fixture);
			type(fixture, "line");
			// Typing drives pi-tui's matcher, which scrolls to a match; read the
			// resulting position rather than the pre-search one.
			const scrollTop = fixture.transcript.scrollTop;
			const offered = recordSearchInput(fixture);

			fixture.terminal.input(PLAIN_T);
			fixture.tui.renderNow();

			// The query first: it is the corruption this test exists for, and it
			// reads `linet` when the find box is offered the key.
			expect(searchQuery(fixture)).toBe("line");
			expect(fixture.thinkingToggles).toEqual([PLAIN_T]);
			expect(offered).toEqual([]);
			expect(activeSearch(fixture)?.overlay?.isFocused()).toBe(true);
			expect(fixture.transcript.scrollTop).toBe(scrollTop);

			// Only the bound letter is claimed; every other printable key still
			// edits the query, so the find box is not muted by the rule.
			type(fixture, "s");
			expect(offered).toEqual(["s"]);
			expect(searchQuery(fixture)).toBe("lines");
			expect(fixture.thinkingToggles).toEqual([PLAIN_T]);
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
