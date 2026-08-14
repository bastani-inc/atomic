import { tmpdir } from "node:os";
import {
	type Component,
	getKeybindings,
	ScrollView,
	setKeybindings,
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
/** SGR wheel reports at row 2, column 10. */
const WHEEL_UP = "\x1b[<64;10;2M";
const CTRL_Y = "\x19";
/** Kitty-protocol `ctrl+shift+f`, pi-tui 0.84.2's default `tui.altScreen.search` key. */
const CTRL_SHIFT_F = "\x1b[102;6u";
/** pi-tui's `PAGE_SCROLL_OVERLAP`: a page moves `viewportHeight` minus this. */
const PAGE_SCROLL_OVERLAP = 4;
const TRANSCRIPT_LINES = 120;

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
	let tui!: TuiAltScreen;
	tui = createFullscreenTui({
		showHardwareCursor: false,
		logDirectory: tmpdir(),
		terminal,
		shouldHandleViewportInput: (data, isMouseInput, focusedIsOverlay) =>
			shouldHandleFullscreenViewportInput(
				tui.getFocusedComponent(),
				editor,
				data,
				isMouseInput,
				focusedIsOverlay,
				keybindings,
			),
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

	return { tui, terminal, transcript, overlay, editor, stop: () => tui.stop() };
}

/** Scroll to the bottom and report the resulting `scrollTop` plus a page's worth of rows. */
function anchorAtEnd(fixture: Fixture): { top: number; page: number } {
	fixture.transcript.scrollToEnd();
	fixture.tui.renderNow();
	const page = Math.max(1, fixture.transcript.viewportHeight - PAGE_SCROLL_OVERLAP);
	expect(page).toBeGreaterThan(1);
	return { top: fixture.transcript.scrollTop, page };
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
