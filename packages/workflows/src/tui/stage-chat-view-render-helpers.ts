import { renderAutocompleteHintLine } from "@bastani/atomic";
import {
	type Component,
	clickableKeysHint,
	type EditorComponent,
	type EditorTheme,
	type Focusable,
	getKeybindings,
	type KeyId,
} from "@bastani/atomic-tui";
import type { PendingPrompt } from "../shared/store-types.js";
import { boldOn, hexBg, hexToAnsi, lerpColor, RESET, textStyle } from "./color-utils.js";
import type { GraphTheme } from "./graph-theme.js";
import type { PaintOpts } from "./stage-chat-view-types.js";

const ITALIC = "\x1b[3m";
const FG_RESET = "\x1b[39m";
const WEIGHT_RESET = "\x1b[22m";
const ITALIC_RESET = "\x1b[23m";

export function blankLine(width: number): string {
	return " ".repeat(width);
}

export function cursorBlock(): string {
	return "\x1b[7m \x1b[0m";
}

export function setComponentFocused(component: Component, focused: boolean): void {
	const candidate = component as Component & Partial<Focusable>;
	if ("focused" in candidate) candidate.focused = focused;
}

export function setEditorFocused(editor: EditorComponent, focused: boolean): void {
	setComponentFocused(editor, focused);
}

export function setEditorPlaceholder(editor: EditorComponent, placeholder: string | undefined): void {
	const candidate = editor as EditorComponent & {
		setPlaceholder?: (value: string | undefined) => void;
	};
	candidate.setPlaceholder?.(placeholder);
}

export function setEditorBorderColor(editor: EditorComponent, borderColor: (text: string) => string): void {
	const candidate = editor as EditorComponent & {
		borderColor?: (text: string) => string;
	};
	if ("borderColor" in candidate) candidate.borderColor = borderColor;
}

export function bgFn(hex: string): (text: string) => string {
	const open = hexBg(hex);
	return (text: string) => open + text + RESET;
}

export function editorThemeFromGraphTheme(t: GraphTheme): EditorTheme {
	const selected = (text: string): string => hexToAnsi(t.accent) + text + RESET;
	const normal = (text: string): string => hexToAnsi(t.text) + text + RESET;
	return {
		borderColor: (text: string) => hexToAnsi(t.border) + text + RESET,
		selectList: {
			selectedPrefix: selected,
			selectedText: selected,
			description: (text: string) => hexToAnsi(t.dim) + text + RESET,
			scrollInfo: (text: string) => hexToAnsi(t.dim) + text + RESET,
			noMatch: (text: string) => hexToAnsi(t.warning) + text + RESET,
			normal,
		},
		autocompleteHint: (entries, width) =>
			renderAutocompleteHintLine(entries, width, getKeybindings(), {
				dim: (text: string) => hexToAnsi(t.dim) + text + RESET,
				text: normal,
				muted: (text: string) => hexToAnsi(t.dim) + text + RESET,
				border: (text: string) => hexToAnsi(t.border) + text + RESET,
				bold: (text: string) => boldOn() + text + RESET,
			}),
	} as EditorTheme;
}

export function takeRows(lines: readonly string[], rows: number): string[] {
	return lines.slice(0, rows);
}

export function widgetHintTargetLineIndex(lines: readonly string[]): number {
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (!isWidgetBottomBorderLine(lines[index] ?? "")) return index;
	}
	return Math.max(0, lines.length - 1);
}

function isWidgetBottomBorderLine(line: string): boolean {
	const plain = stripAnsi(line).trim();
	const chars = Array.from(plain);
	if (chars.length < 2) return false;
	const first = chars[0] ?? "";
	const last = chars.at(-1) ?? "";
	if (!"╰└+".includes(first) || !"╯┘+".includes(last)) return false;
	return chars.slice(1, -1).every((char) => "─═- ".includes(char));
}

export function trailingWidgetBorderChar(line: string): string {
	const plain = stripAnsi(line).trimEnd();
	const last = Array.from(plain).at(-1) ?? "";
	return "╯┘┤┴│|+".includes(last) ? last : "";
}

export function paint(text: string, fg: string, opts: PaintOpts = {}): string {
	if (!text) return "";
	let out = hexToAnsi(fg);
	if (opts.bold) out += boldOn();
	if (opts.italic) out += textStyle(ITALIC);
	if (opts.bg) out = hexBg(opts.bg) + out;
	return out + text + RESET;
}

/**
 * Foreground styling for text that will be wrapped by a `Box` background.
 * A normal `RESET` would also clear the parent background, so close only the
 * inline foreground/weight/italic state and let `bgFn()` reset the row at end.
 */
export function paintOnFill(text: string, fg: string, opts: PaintOpts = {}): string {
	if (!text) return "";
	let out = hexToAnsi(fg);
	if (opts.bold) out += boldOn();
	if (opts.italic) out += textStyle(ITALIC);
	let close = FG_RESET;
	if (opts.bold) close += textStyle(WEIGHT_RESET);
	if (opts.italic) close += textStyle(ITALIC_RESET);
	return out + text + close;
}

/** `s` without its CSI styling; APC markers, such as a clickable key hint's, stay. */
export function stripStyles(s: string): string {
	return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

/** `s` without CSI sequences and APC markers, such as a clickable key hint's. */
export function stripAnsi(s: string): string {
	return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]|\x1B_[^\x07\x1B]*(?:\x07|\x1B\\)/g, "");
}

/**
 * Approximate a tinted background by mixing the base canvas with a saturated
 * hue at low alpha. Used for status pills and tool-bar tints. Returns a hex
 * colour the renderer can feed to `hexBg`.
 */
export function blendBg(baseHex: string, tintHex: string, alpha: number): string {
	return lerpColor(baseHex, tintHex, Math.max(0, Math.min(1, alpha)));
}

export function workingIndicatorPalette(theme: GraphTheme) {
	const { selection: dark, accent, text: peak } = theme;
	return {
		dark,
		lift: lerpColor(dark, accent, 0.25),
		muted: lerpColor(dark, accent, 0.6),
		accent,
		bright: lerpColor(accent, peak, 0.55),
		peak,
	};
}

export function renderHintsForPrompt(kind: PendingPrompt["kind"], theme: GraphTheme): string {
	const hint = (keyText: string, key: KeyId, label: string) =>
		clickableKeysHint([{ text: paint(keyText, theme.textMuted, { bold: true }), key }], ` ${label}`);
	if (kind === "input" || kind === "editor") {
		return `${hint("enter", "enter", "Submit")} · ${hint("ctrl+c", "ctrl+c", "Skip")}`;
	}
	if (kind === "custom") {
		return hint("ctrl+c", "ctrl+c", "Close");
	}
	return `${hint("enter", "enter", "Select")} · ${hint("esc", "escape", "Close")} · ${hint("ctrl+c", "ctrl+c", "Skip")}`;
}
