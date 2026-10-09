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
import Ajv2020 from "ajv/dist/2020";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { getThemesDir } from "../src/config.ts";
import { type KeybindingsConfig, KeybindingsManager } from "../src/core/keybindings.ts";
import {
	isFullscreenTranscriptScrollAction,
	isFullscreenViewportAction,
	shouldHandleFullscreenViewportInput,
} from "../src/modes/interactive/interactive-mode-base.ts";
import { createFullscreenTui } from "../src/modes/interactive/interactive-tui.ts";
import { initTheme, loadThemeFromContent } from "../src/modes/interactive/theme/theme.ts";
import { validateThemeJson } from "../src/modes/interactive/theme/theme-schema.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";

/** Kitty-protocol `ctrl+shift+f`: pi-tui still ships this, Atomic unbinds it. */
const CTRL_SHIFT_F = "\x1b[102;6u";
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
const NEW_VIEWPORT_ACTIONS = ["tui.altScreen.lineUp", "tui.altScreen.lineDown"] as const;

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

function loadDarkThemeJson(): { name: string; colors: Record<string, string | number> } {
	return JSON.parse(readFileSync(join(getThemesDir(), "dark.json"), "utf8")) as {
		name: string;
		colors: Record<string, string | number>;
	};
}

/**
 * Atomic keeps the two single-line scroll steps and unbinds transcript search.
 */
describe("fullscreen transcript search is disabled", () => {
	test("7913-fullscreen-line-scroll-actions-routed", () => {
		const fixture = createFixture();
		try {
			fixture.transcript.scrollToEnd();
			fixture.tui.renderNow();
			const anchored = fixture.transcript.scrollTop;

			fixture.terminal.input(CTRL_Y);
			fixture.tui.renderNow();
			expect(fixture.transcript.scrollTop).toBe(anchored - 1);
			fixture.terminal.input(CTRL_U);
			fixture.tui.renderNow();
			expect(fixture.transcript.scrollTop).toBe(anchored);
			expect(fixture.overlay.handledInputs).toEqual([CTRL_Y, CTRL_U]);
		} finally {
			fixture.stop();
		}
	});

	test("ctrl+shift+f does not open a transcript search", () => {
		const fixture = createFixture({ mountOverlay: false });
		try {
			fixture.terminal.input(CTRL_SHIFT_F);
			fixture.tui.renderNow();
			expect(activeSearch(fixture)).toBeUndefined();
			expect(new KeybindingsManager().matches(CTRL_SHIFT_F, "tui.altScreen.search")).toBe(false);
		} finally {
			fixture.stop();
		}
	});

	test("every remaining new action is gated, so a focused overlay is offered it first", () => {
		const keybindings = new KeybindingsManager(LINE_BINDINGS);
		const editor = new Text("editor", 0, 0);
		const overlay = new DecliningOverlay();
		const keys: Record<(typeof NEW_VIEWPORT_ACTIONS)[number], string> = {
			"tui.altScreen.lineUp": CTRL_Y,
			"tui.altScreen.lineDown": CTRL_U,
		};

		for (const action of NEW_VIEWPORT_ACTIONS) {
			const data = keys[action];
			expect(keybindings.matches(data, action), `${action} does not match its key`).toBe(true);
			expect(isFullscreenViewportAction(data, keybindings), `${action} is outside the gate`).toBe(true);
			expect(
				shouldHandleFullscreenViewportInput(overlay, editor, data, false, true, keybindings),
				`${action} skips the focused overlay`,
			).toBe(false);
			expect(shouldHandleFullscreenViewportInput(editor, editor, data, false, false, keybindings)).toBe(true);
		}
	});

	test("a reserving overlay releases scrolling and does not treat search keys as viewport actions", () => {
		const keybindings = new KeybindingsManager(LINE_BINDINGS);

		for (const data of [CTRL_Y, CTRL_U]) {
			expect(isFullscreenTranscriptScrollAction(data, keybindings)).toBe(true);
			expect(isFullscreenViewportAction(data, keybindings)).toBe(true);
		}
		expect(isFullscreenTranscriptScrollAction(CTRL_SHIFT_F, keybindings)).toBe(false);
		expect(isFullscreenViewportAction(CTRL_SHIFT_F, keybindings)).toBe(false);
	});
});

/**
 * `searchMatchBg` and `searchMatchText` remain optional leftover tokens so older
 * theme files keep validating.
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
		const schema = JSON.parse(
			readFileSync(new URL("../schemas/theme.schema.json", import.meta.url), "utf8"),
		) as object;
		const validateJsonSchema = new Ajv2020({ allErrors: true }).compile(schema);

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
