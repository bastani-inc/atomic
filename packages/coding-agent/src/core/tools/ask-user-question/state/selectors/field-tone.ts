import type { Theme, ThemeColor } from "../../../../../modes/interactive/theme/theme.js";

/**
 * Display state of a text part of the dialog — the "Type something." answer, the
 * "Chat about this" row, the notes field — and of the rows that hold an answer.
 *
 * - `editing`: the field has focus and takes keystrokes.
 * - `answered`: the field holds text (or the row holds the chosen answer) but has no focus.
 * - `placeholder`: the field is empty and unfocused, so it shows its prompt.
 *
 * Every renderer asks this module for both the tone and its color, so a field's color is a
 * pure function of the state it is rendered from. Arriving at a question forward, with
 * ←/Shift+Tab, or from the review tab cannot leave a stale color behind (#4741).
 */
export type FieldTone = "editing" | "answered" | "placeholder";

/** Theme token per tone. `editing` is also bold: bold marks the focused selection. */
export const FIELD_TONE_COLOR: Readonly<Record<FieldTone, ThemeColor>> = {
	editing: "accent",
	answered: "text",
	placeholder: "muted",
};

/** Tone of a text field: focused wins, then whether it holds non-blank text. */
export function fieldTone(focused: boolean, value: string): FieldTone {
	if (focused) return "editing";
	return value.trim().length > 0 ? "answered" : "placeholder";
}

/**
 * Tone of an option row. A row is not a text field, so an unfocused row that holds no
 * answer has no tone and keeps the ordinary text style.
 */
export function rowTone(focused: boolean, answered: boolean): FieldTone | undefined {
	if (focused) return "editing";
	return answered ? "answered" : undefined;
}

/** Paint `text` in `tone`'s color. */
export function styleFieldTone(theme: Theme, tone: FieldTone, text: string): string {
	const color = FIELD_TONE_COLOR[tone];
	return theme.fg(color, tone === "editing" ? theme.bold(text) : text);
}
