import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Component,
	getKeybindings,
	isKeyRelease,
	ScrollView,
	setKeybindings,
	Text,
	type TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import Ajv from "ajv";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { getThemesDir } from "../src/config.ts";
import { type KeybindingsConfig, KeybindingsManager } from "../src/core/keybindings.ts";
import {
	isFullscreenTranscriptScrollAction,
	isFullscreenViewportAction,
	shouldHandleFullscreenViewportInput,
} from "../src/modes/interactive/interactive-mode-base.ts";
import { createFullscreenTui } from "../src/modes/interactive/interactive-tui.ts";
import { initTheme, loadThemeFromContent, theme } from "../src/modes/interactive/theme/theme.ts";
import { validateThemeJson } from "../src/modes/interactive/theme/theme-schema.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";

/** Kitty-protocol `ctrl+shift+f`: pi-tui's default `tui.altScreen.search`. */
const CTRL_SHIFT_F = "\x1b[102;6u";
/** `tui.altScreen.searchNext`, one of its two defaults. */
const CTRL_G = "\x07";
/** `tui.altScreen.searchPrevious`, in kitty form. */
const CTRL_SHIFT_G = "\x1b[103;6u";
/** `tui.altScreen.searchClose`, and `app.interrupt` outside a search. */
const ESCAPE = "\x1b";
/** Bound below to `tui.altScreen.lineUp`; pi-tui ships that action unbound. */
const CTRL_Y = "\x19";
/** Bound below to `tui.altScreen.lineDown`. */
const CTRL_U = "\x15";
const TRANSCRIPT_LINES = 120;
/** The two single-line actions have no default key, so the fixture supplies one. */
const LINE_BINDINGS: KeybindingsConfig = {
	"tui.altScreen.lineUp": "ctrl+y",
	"tui.altScreen.lineDown": "ctrl+u",
};
/** Every `tui.altScreen.*` action this layer added to Atomic's gate. */
const NEW_VIEWPORT_ACTIONS = [
	"tui.altScreen.lineUp",
	"tui.altScreen.lineDown",
	"tui.altScreen.search",
	"tui.altScreen.searchNext",
	"tui.altScreen.searchPrevious",
	"tui.altScreen.searchClose",
] as const;

const initialKeybindings = getKeybindings();

beforeAll(() => {
	initTheme("dark");
});

afterEach(() => {
	setKeybindings(initialKeybindings);
	initTheme("dark");
});

/** A focused overlay that declines everything, the way a notice or progress panel does. */
class DecliningOverlay implements Component {
	readonly handledInputs: string[] = [];

	render(): string[] {
		return ["dialog"];
	}

	handleInput(data: string): boolean {
		this.handledInputs.push(data);
		return false;
	}

	invalidate(): void {}
}

/** pi-tui keeps its find box and its match styles private (tui-alt-screen.d.ts:50,55). */
interface AltScreenSearchInternals {
	activeSearch?: {
		query: string;
		selectedIndex: number;
		matches: unknown[];
		overlay?: { isFocused(): boolean };
	};
	searchMatchStyle: (text: string) => string;
	searchCurrentMatchStyle: (text: string) => string;
}

interface Fixture {
	tui: TuiAltScreen;
	terminal: RecordingTerminal;
	transcript: ScrollView;
	editor: Text;
	overlay: DecliningOverlay;
	stop: () => void;
}

function internals(fixture: Fixture): AltScreenSearchInternals {
	return fixture.tui as unknown as AltScreenSearchInternals;
}

function activeSearch(fixture: Fixture): AltScreenSearchInternals["activeSearch"] {
	return internals(fixture).activeSearch;
}

/**
 * Build the fullscreen renderer with Atomic's real gate, the way
 * `InteractiveModeBase` wires it. `mountOverlay` focuses a declining overlay,
 * which is the route that proves the gate rather than pi-tui's own routing:
 * with the editor focused every key reaches the viewport regardless of the
 * allowlist.
 */
function createFixture(options: { mountOverlay?: boolean; userBindings?: KeybindingsConfig } = {}): Fixture {
	const userBindings = options.userBindings ?? LINE_BINDINGS;
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
		onOverlayUnhandledInput: (data) => {
			if (isKeyRelease(data)) return false;
			return keybindings.matches(data, "app.thinking.toggle");
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

	const overlay = new DecliningOverlay();
	if (options.mountOverlay !== false) {
		tui.showOverlay(overlay, { anchor: "bottom-center", width: "100%" });
		tui.renderNow();
		expect(tui.getFocusedComponent()).toBe(overlay);
	}

	return { tui, terminal, transcript, editor, overlay, stop: () => tui.stop() };
}

function type(fixture: Fixture, text: string): void {
	for (const character of text) fixture.terminal.input(character);
	fixture.tui.renderNow();
}

function loadDarkThemeJson(): { name: string; colors: Record<string, string | number> } {
	return JSON.parse(readFileSync(join(getThemesDir(), "dark.json"), "utf8")) as {
		name: string;
		colors: Record<string, string | number>;
	};
}

/**
 * The six `tui.altScreen.*` actions pi 0.84.2 added to Atomic's surface: the two
 * single-line scroll steps from upstream `1279952d` and the four transcript
 * search actions from `00121ed9`. Upstream has no action allowlist, so there is
 * no hunk to copy — without these entries in `FULLSCREEN_VIEWPORT_ACTIONS` the
 * bindings never reach the viewport through Atomic's gate, and the feature
 * looks ported while doing nothing.
 */
describe("fullscreen transcript search routing", () => {
	test("7913-fullscreen-search-actions-routed", () => {
		const fixture = createFixture();
		try {
			fixture.transcript.scrollToEnd();
			fixture.tui.renderNow();
			const anchored = fixture.transcript.scrollTop;

			// 1 & 2 — the single-line steps reach the viewport after the focused
			// overlay declines them.
			fixture.terminal.input(CTRL_Y);
			fixture.tui.renderNow();
			expect(fixture.transcript.scrollTop).toBe(anchored - 1);
			fixture.terminal.input(CTRL_U);
			fixture.tui.renderNow();
			expect(fixture.transcript.scrollTop).toBe(anchored);
			expect(fixture.overlay.handledInputs).toEqual([CTRL_Y, CTRL_U]);

			// 3 — `search` opens pi-tui's find box over the transcript.
			fixture.terminal.input(CTRL_SHIFT_F);
			fixture.tui.renderNow();
			expect(activeSearch(fixture), "ctrl+shift+f opened no search").toBeDefined();
			expect(activeSearch(fixture)?.overlay?.isFocused()).toBe(true);

			type(fixture, "line 1");
			const matches = activeSearch(fixture)?.matches.length ?? 0;
			expect(matches).toBeGreaterThan(1);
			const first = activeSearch(fixture)?.selectedIndex ?? -1;
			expect(first).toBeGreaterThanOrEqual(0);

			// 4 — `searchNext` advances the selected match.
			fixture.terminal.input(CTRL_G);
			fixture.tui.renderNow();
			const next = activeSearch(fixture)?.selectedIndex ?? -1;
			expect(next).toBe((first + 1) % matches);

			// 5 — `searchPrevious` walks back to it.
			fixture.terminal.input(CTRL_SHIFT_G);
			fixture.tui.renderNow();
			expect(activeSearch(fixture)?.selectedIndex).toBe(first);

			// 6 — `searchClose` dismisses the find box.
			fixture.terminal.input(ESCAPE);
			fixture.tui.renderNow();
			expect(activeSearch(fixture)).toBeUndefined();
		} finally {
			fixture.stop();
		}
	});

	test("every new action is gated, so a focused overlay is offered it first", () => {
		const keybindings = new KeybindingsManager(LINE_BINDINGS);
		const editor = new Text("editor", 0, 0);
		const overlay = new DecliningOverlay();
		const keys: Record<(typeof NEW_VIEWPORT_ACTIONS)[number], string> = {
			"tui.altScreen.lineUp": CTRL_Y,
			"tui.altScreen.lineDown": CTRL_U,
			"tui.altScreen.search": CTRL_SHIFT_F,
			"tui.altScreen.searchNext": CTRL_G,
			"tui.altScreen.searchPrevious": CTRL_SHIFT_G,
			"tui.altScreen.searchClose": ESCAPE,
		};

		for (const action of NEW_VIEWPORT_ACTIONS) {
			const data = keys[action];
			expect(keybindings.matches(data, action), `${action} does not match its key`).toBe(true);
			expect(isFullscreenViewportAction(data, keybindings), `${action} is outside the gate`).toBe(true);
			// A focused overlay gets first refusal, which is what keeps a stage
			// chat's own search from opening over the main transcript behind it.
			expect(
				shouldHandleFullscreenViewportInput(overlay, editor, data, false, true, keybindings),
				`${action} skips the focused overlay`,
			).toBe(false);
			// The main editor keeps the shortcut.
			expect(shouldHandleFullscreenViewportInput(editor, editor, data, false, false, keybindings)).toBe(true);
		}
	});

	/**
	 * A reserving overlay — the `ask_user_question` dialog, or an extension
	 * component with `reserveTranscriptRows` — declines transcript scrolling so
	 * the strip above it still pages (#2378). The search actions must stay out of
	 * that release set: `enter`, `shift+enter`, `escape`, and `ctrl+g` are the
	 * dialog's own submit, cancel, and edit keys, and pi-tui drops all three
	 * navigation actions unless its find box has focus, which it cannot have
	 * while the dialog does.
	 */
	test("a reserving overlay releases scrolling but keeps the search keys", () => {
		const keybindings = new KeybindingsManager(LINE_BINDINGS);

		for (const data of [CTRL_Y, CTRL_U]) {
			expect(isFullscreenTranscriptScrollAction(data, keybindings)).toBe(true);
			expect(isFullscreenViewportAction(data, keybindings)).toBe(true);
		}
		for (const data of [CTRL_SHIFT_F, CTRL_G, CTRL_SHIFT_G, ESCAPE, "\r"]) {
			expect(isFullscreenTranscriptScrollAction(data, keybindings), `${JSON.stringify(data)} is released`).toBe(
				false,
			);
		}
		// The gate still owns them, which is the whole point of the split.
		for (const data of [CTRL_SHIFT_F, CTRL_G, CTRL_SHIFT_G, ESCAPE]) {
			expect(isFullscreenViewportAction(data, keybindings)).toBe(true);
		}
	});

	test("the transcript still scrolls while the find box has focus", () => {
		const fixture = createFixture({ mountOverlay: false });
		try {
			fixture.transcript.scrollToEnd();
			fixture.tui.renderNow();
			const anchored = fixture.transcript.scrollTop;

			fixture.terminal.input(CTRL_SHIFT_F);
			fixture.tui.renderNow();
			expect(activeSearch(fixture)?.overlay?.isFocused()).toBe(true);

			fixture.terminal.input(CTRL_Y);
			fixture.tui.renderNow();
			expect(fixture.transcript.scrollTop).toBe(anchored - 1);
			expect(activeSearch(fixture)?.query).toBe("");
		} finally {
			fixture.stop();
		}
	});
});

/**
 * The match styles the renderer hands pi-tui. They read the global theme on
 * every call rather than capturing colors at construction, so `/theme` repaints
 * an open search instead of leaving it in the previous palette.
 */
describe("fullscreen search match styling", () => {
	test("the renderer styles matches with the theme's search colors", () => {
		const fixture = createFixture({ mountOverlay: false });
		try {
			const { searchMatchStyle, searchCurrentMatchStyle } = internals(fixture);
			const painted = theme.bg("searchMatchBg", theme.fg("searchMatchText", "hit"));

			expect(searchMatchStyle("hit")).toBe(theme.underline(painted));
			expect(searchCurrentMatchStyle("hit")).toBe(theme.bold(theme.inverse(painted)));
			expect(searchMatchStyle("hit")).toContain(theme.getBgAnsi("searchMatchBg"));
			expect(searchMatchStyle("hit")).toContain(theme.getFgAnsi("searchMatchText"));
		} finally {
			fixture.stop();
		}
	});

	test("a theme change repaints later matches", () => {
		const fixture = createFixture({ mountOverlay: false });
		try {
			const { searchMatchStyle } = internals(fixture);
			const dark = searchMatchStyle("hit");

			initTheme("light");
			expect(searchMatchStyle("hit")).toBe(
				theme.underline(theme.bg("searchMatchBg", theme.fg("searchMatchText", "hit"))),
			);
			expect(searchMatchStyle("hit")).toContain(theme.getBgAnsi("searchMatchBg"));
			expect(searchMatchStyle("hit")).not.toBe(dark);
		} finally {
			fixture.stop();
		}
	});

	test("a rendered match carries the search background", () => {
		const fixture = createFixture({ mountOverlay: false });
		try {
			fixture.terminal.input(CTRL_SHIFT_F);
			fixture.tui.renderNow();
			fixture.terminal.writes.length = 0;
			type(fixture, "line 42");

			expect(activeSearch(fixture)?.matches.length).toBeGreaterThan(0);
			expect(fixture.terminal.writes.join("")).toContain(theme.getBgAnsi("searchMatchBg"));
		} finally {
			fixture.stop();
		}
	});
});

/**
 * `searchMatchBg` and `searchMatchText` are optional. Every Atomic theme written
 * before they existed — including a user's own file — must keep validating and
 * keep rendering, which is what the fallbacks to `selectedBg` and `text` buy.
 */
describe("search match theme colors", () => {
	test("a theme omitting both colors still resolves them", () => {
		const themeJson = loadDarkThemeJson();
		themeJson.name = "legacy-search-theme";
		delete themeJson.colors.searchMatchBg;
		delete themeJson.colors.searchMatchText;

		expect(validateThemeJson.Check(themeJson)).toBe(true);
		const loaded = loadThemeFromContent("legacy-search-theme.json", JSON.stringify(themeJson), "truecolor");
		expect(loaded.getBgAnsi("searchMatchBg")).toBe(loaded.getBgAnsi("selectedBg"));
		expect(loaded.getFgAnsi("searchMatchText")).toBe(loaded.getFgAnsi("text"));
	});

	test("a theme defining both colors keeps them", () => {
		const themeJson = loadDarkThemeJson();
		themeJson.name = "custom-search-theme";
		themeJson.colors.searchMatchBg = "#112233";
		themeJson.colors.searchMatchText = "#223344";

		const loaded = loadThemeFromContent("custom-search-theme.json", JSON.stringify(themeJson), "truecolor");
		expect(loaded.getBgAnsi("searchMatchBg")).toBe("\x1b[48;2;17;34;51m");
		expect(loaded.getFgAnsi("searchMatchText")).toBe("\x1b[38;2;34;51;68m");
	});

	test("both schema forms accept a theme with and without the colors", () => {
		const schema = JSON.parse(readFileSync(join(getThemesDir(), "theme-schema.json"), "utf8")) as object;
		const validateJsonSchema = new Ajv({ allErrors: true }).compile(schema);

		const withColors = loadDarkThemeJson();
		withColors.name = "schema-search-theme";
		withColors.colors.searchMatchBg = "#112233";
		withColors.colors.searchMatchText = "#223344";
		expect(validateJsonSchema(withColors), JSON.stringify(validateJsonSchema.errors)).toBe(true);
		expect(validateThemeJson.Check(withColors)).toBe(true);

		const without = loadDarkThemeJson();
		without.name = "schema-legacy-search-theme";
		delete without.colors.searchMatchBg;
		delete without.colors.searchMatchText;
		expect(validateJsonSchema(without), JSON.stringify(validateJsonSchema.errors)).toBe(true);
		expect(validateThemeJson.Check(without)).toBe(true);
	});

	test("the bundled themes define both colors", () => {
		for (const name of ["dark", "light"] as const) {
			const themeJson = JSON.parse(readFileSync(join(getThemesDir(), `${name}.json`), "utf8")) as {
				colors: Record<string, string | number>;
			};
			expect(themeJson.colors.searchMatchBg, `${name} omits searchMatchBg`).toBeDefined();
			expect(themeJson.colors.searchMatchText, `${name} omits searchMatchText`).toBeDefined();
		}
	});
});
