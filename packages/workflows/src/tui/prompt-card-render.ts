import { keyHint, keyText, rawKeyHint } from "@bastani/atomic";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { PendingPrompt } from "../shared/store-types.js";
import { BOLD, hexBg, hexToAnsi, paint, RESET } from "./color-utils.js";
import type { GraphTheme } from "./graph-theme.js";
import { createPromptSelectList } from "./prompt-card-select.js";
import type { PromptCardState } from "./prompt-card-state.js";
import { graphemeParts } from "./prompt-card-text.js";
import { renderRunIdentityRows } from "./run-identity-rows.js";
import { statusColor, statusIcon } from "./status-helpers.js";

export interface PromptCardIdentity {
	readonly runId: string;
	readonly name: string;
	readonly meta?: string;
}

export interface PromptCardRenderOpts {
	readonly state: PromptCardState;
	readonly theme: GraphTheme;
	readonly width: number;
	readonly cursorOn: boolean;
	/** Optional run attribution; absent preserves the legacy prompt card. */
	readonly identity?: PromptCardIdentity;
	/** Maximum complete rows to emit. Below the six-row minimum, emits nothing. */
	readonly maxRows?: number;
}

const MIN_COMPLETE_PROMPT_ROWS = 6;
const LEGACY_PROMPT_ROWS = 10;

/**
 * Render the prompt surface as an optional attribution banner followed by
 * the existing prompt UI. The banner contains identity only; the prompt
 * question, response field, and hints remain in their existing box.
 */
export function renderPromptCard(opts: PromptCardRenderOpts): string[] {
	const { state, theme, width } = opts;
	const innerWidth = Math.max(20, width - 2);
	const borderColor = theme.border;
	const bg = "";
	const maxRows = opts.maxRows === undefined ? undefined : Math.max(0, Math.floor(opts.maxRows));
	if (maxRows !== undefined && maxRows < MIN_COMPLETE_PROMPT_ROWS) return [];
	if (opts.identity === undefined) {
		return renderPromptBodyBlock(state, theme, innerWidth, opts.cursorOn, borderColor, bg, maxRows);
	}

	const identityRows = renderRunIdentityRows({
		runId: opts.identity.runId,
		name: opts.identity.name,
		meta: opts.identity.meta,
		glyph: statusIcon("awaiting_input"),
		glyphColor: statusColor("awaiting_input", theme),
		theme,
		width: innerWidth,
		idIndent: 1,
		idGap: 1,
		nameIndent: 4,
	});
	const banner = [
		makeBorderTop(borderColor, " AWAITING INPUT ", theme, innerWidth, bg),
		...identityRows.map((row) => makePaddedRow(bg, borderColor, innerWidth, row)),
		makeBorderBottom(borderColor, innerWidth, bg),
	];

	// Attribution is supplementary. Keep it only when the remaining budget can
	// still hold the normally spaced prompt; otherwise devote every row to the
	// complete interactive surface.
	if (maxRows !== undefined && maxRows < banner.length + LEGACY_PROMPT_ROWS) {
		return renderPromptBodyBlock(state, theme, innerWidth, opts.cursorOn, borderColor, bg, maxRows);
	}
	const promptBudget = maxRows === undefined ? undefined : maxRows - banner.length;
	const promptLines = renderPromptBodyBlock(state, theme, innerWidth, opts.cursorOn, borderColor, bg, promptBudget);
	return [
		...banner,
		...promptLines.map((line, index) => (index === 0 ? makeBorderTop(borderColor, "", theme, innerWidth, bg) : line)),
	];
}

function renderPromptBodyBlock(
	state: PromptCardState,
	theme: GraphTheme,
	innerWidth: number,
	cursorOn: boolean,
	borderColor: string,
	bg: string,
	maxRows?: number,
): string[] {
	if (maxRows !== undefined && maxRows < MIN_COMPLETE_PROMPT_ROWS) return [];
	const messageRows = wrapText(state.prompt.message, innerWidth - 4);
	const desiredResponseRows = responseRowCount(state);
	const minimumResponseRows = minimumResponseRowCount(state);
	const normallySpaced = maxRows === undefined || maxRows >= LEGACY_PROMPT_ROWS;
	let messageCount = messageRows.length;
	let responseCount = desiredResponseRows;
	if (maxRows !== undefined) {
		// Five non-variable rows keep both boxes closed: outer top/bottom +
		// response top/bottom + hints. Normally spaced cards add three blanks.
		const fixedRows = 5 + (normallySpaced ? 3 : 0);
		const variableBudget = Math.max(1, maxRows - fixedRows);
		// A scrolling select needs one choice plus SelectList's scroll-info row.
		// If both cannot fit, emit no card rather than a box with missing content.
		if (variableBudget < minimumResponseRows) return [];
		messageCount = variableBudget >= minimumResponseRows + 1 ? 1 : 0;
		responseCount = minimumResponseRows;
		let remaining = variableBudget - messageCount - responseCount;
		const responseExtra = Math.min(remaining, Math.max(0, desiredResponseRows - responseCount));
		responseCount += responseExtra;
		remaining -= responseExtra;
		messageCount += Math.min(remaining, Math.max(0, messageRows.length - messageCount));
	}

	const lines: string[] = [];
	lines.push(makeBorderTop(borderColor, " AWAITING INPUT ", theme, innerWidth, bg));
	if (normallySpaced) lines.push(makePaddedRow(bg, borderColor, innerWidth, ""));
	for (const messageLine of messageRows.slice(0, messageCount)) {
		lines.push(makePaddedRow(bg, borderColor, innerWidth, `  ${paint(messageLine, theme.text)}`));
	}
	if (normallySpaced) lines.push(makePaddedRow(bg, borderColor, innerWidth, ""));

	const fieldLines = renderResponseFieldBox(state, theme, innerWidth - 4, cursorOn, responseCount);
	for (const fl of fieldLines) {
		lines.push(makePaddedRow(bg, borderColor, innerWidth, `  ${fl}`));
	}

	if (normallySpaced) lines.push(makePaddedRow(bg, borderColor, innerWidth, ""));
	lines.push(makePaddedRow(bg, borderColor, innerWidth, `  ${renderHints(state.prompt.kind, theme)}`));
	lines.push(makeBorderBottom(borderColor, innerWidth, bg));
	return lines;
}

function makeBorderTop(color: string, label: string, theme: GraphTheme, innerWidth: number, bg: string): string {
	const labelText = paint(label, theme.textMuted, { bold: true });
	const labelW = visibleWidth(labelText);
	const fillLen = Math.max(0, innerWidth - labelW);
	return bg + paint("╭", color) + labelText + paint(`${"─".repeat(fillLen)}╮`, color) + RESET;
}

function makeBorderBottom(color: string, innerWidth: number, bg: string): string {
	return bg + paint(`╰${"─".repeat(innerWidth)}╯`, color) + RESET;
}

function makePaddedRow(bg: string, borderColor: string, innerWidth: number, content: string): string {
	const contentW = visibleWidth(content);
	const pad = Math.max(0, innerWidth - contentW);
	const padded = content + " ".repeat(pad);
	const clipped = truncateToWidth(padded, innerWidth, "", true);
	return bg + paint("│", borderColor) + clipped + paint("│", borderColor) + RESET;
}

function wrapText(text: string, width: number): string[] {
	if (width <= 0) return [text];
	return wrapTextWithAnsi(text, width);
}

function responseRowCount(state: PromptCardState): number {
	switch (state.prompt.kind) {
		case "select": {
			const choiceCount = state.prompt.choices?.length ?? 0;
			const visibleChoices = Math.max(1, Math.min(5, choiceCount));
			return visibleChoices + (choiceCount > visibleChoices ? 1 : 0);
		}
		case "editor":
			return 6;
		default:
			return 1;
	}
}

function minimumResponseRowCount(state: PromptCardState): number {
	return state.prompt.kind === "select" && (state.prompt.choices?.length ?? 0) > 1 ? 2 : 1;
}

function renderResponseFieldBox(
	state: PromptCardState,
	theme: GraphTheme,
	usable: number,
	cursorOn: boolean,
	maxContentRows: number,
): string[] {
	const boxWidth = Math.max(4, usable);
	const contentWidth = Math.max(1, boxWidth - 2);
	const borderColor = theme.accent;
	const label = " response ";
	const labelText = paint(label, theme.textMuted, { bold: true });
	const labelW = visibleWidth(labelText);
	const topFill = Math.max(0, boxWidth - labelW - 2);
	const rows = renderResponseField(state, theme, contentWidth, cursorOn, maxContentRows);
	return [
		paint("╭", borderColor) + labelText + paint(`${"─".repeat(topFill)}╮`, borderColor),
		...rows.map((row) => makeFieldRow(row, contentWidth, borderColor)),
		paint(`╰${"─".repeat(Math.max(0, boxWidth - 2))}╯`, borderColor),
	];
}

function makeFieldRow(content: string, width: number, borderColor: string): string {
	const clipped = truncateToWidth(content, width, "", true);
	const padded = clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	return paint("│", borderColor) + padded + paint("│", borderColor);
}

function renderResponseField(
	state: PromptCardState,
	theme: GraphTheme,
	usable: number,
	cursorOn: boolean,
	maxRows: number,
): string[] {
	switch (state.prompt.kind) {
		case "confirm":
			return [renderConfirmRow(state, theme, usable)];
		case "select":
			return renderSelectRows(state, theme, usable, maxRows);
		case "input":
			return [renderInputRow(state, theme, usable, cursorOn)];
		case "editor":
			return renderEditorRows(state, theme, usable, cursorOn, maxRows);
		case "custom":
			return [padToUsable("", usable)];
	}
}

function renderConfirmRow(state: PromptCardState, theme: GraphTheme, usable: number): string {
	const yes = state.confirmValue;
	const onCell =
		paint(yes ? "●" : "○", yes ? theme.success : theme.dim) +
		" " +
		paint("yes", yes ? theme.text : theme.dim, { bold: yes });
	const offCell =
		paint(!yes ? "●" : "○", !yes ? theme.error : theme.dim) +
		" " +
		paint("no", !yes ? theme.text : theme.dim, { bold: !yes });
	const row = `${onCell}    ${offCell}`;
	return padToUsable(row, usable);
}

function renderSelectRows(state: PromptCardState, theme: GraphTheme, usable: number, maxRows: number): string[] {
	const choices = state.prompt.choices ?? [];
	if (choices.length === 0) {
		return [padToUsable(paint("(no choices)", theme.dim), usable)];
	}
	const rowBudget = Math.max(1, Math.floor(maxRows));
	const scrolls = choices.length > Math.min(5, rowBudget);
	const maxVisible = Math.max(1, Math.min(5, choices.length, rowBudget - (scrolls ? 1 : 0)));
	const list = createPromptSelectList(state, theme, maxVisible);
	return list.render(usable).map((line) => padToUsable(line, usable));
}

function renderInputRow(state: PromptCardState, theme: GraphTheme, usable: number, cursorOn: boolean): string {
	const value = state.rawText;
	const inner = usable - 2; // room for the "❯ " prompt prefix
	const visible = clipToCaretWindow(value, state.caret, inner);
	const withCursor = drawCursor(visible.text, visible.caret, cursorOn, theme);
	return padToUsable(paint("❯ ", theme.accent) + withCursor, usable);
}

function renderEditorRows(
	state: PromptCardState,
	theme: GraphTheme,
	usable: number,
	cursorOn: boolean,
	maxRows: number,
): string[] {
	const rowBudget = Math.max(1, Math.floor(maxRows));
	if (rowBudget === 1 && state.editorSubmitFocused) {
		return [padToUsable(renderEditorSubmitAction(true, theme), usable)];
	}
	const editorRows = rowBudget === 1 ? 1 : rowBudget - 1;
	const includeSubmit = rowBudget > 1;
	const allLines = state.rawText.split("\n");
	// Find the line + column the caret currently sits on.
	let acc = 0;
	let caretLine = 0;
	let caretCol = 0;
	for (let i = 0; i < allLines.length; i++) {
		const len = allLines[i]!.length;
		if (state.caret <= acc + len) {
			caretLine = i;
			caretCol = state.caret - acc;
			break;
		}
		acc += len + 1; // +1 for the newline
		caretLine = i + 1;
		caretCol = 0;
	}
	const start = Math.max(0, Math.min(caretLine - Math.floor(editorRows / 2), allLines.length - editorRows));
	const safeStart = Math.max(0, start);
	const rows: string[] = [];
	for (let i = 0; i < editorRows; i++) {
		const lineIdx = safeStart + i;
		const lineText = allLines[lineIdx] ?? "";
		const isCaretLine = !state.editorSubmitFocused && lineIdx === caretLine;
		const inner = usable - 2;
		const clipped = clipToCaretWindow(lineText, isCaretLine ? caretCol : Math.min(caretCol, lineText.length), inner);
		const withCursor = isCaretLine
			? drawCursor(clipped.text, clipped.caret, cursorOn, theme)
			: paint(clipped.text, theme.text);
		const prefix = paint(isCaretLine ? "❯ " : "  ", isCaretLine ? theme.accent : theme.dim);
		rows.push(padToUsable(prefix + withCursor, usable));
	}
	if (includeSubmit) rows.push(padToUsable(renderEditorSubmitAction(state.editorSubmitFocused, theme), usable));
	return rows;
}

function renderEditorSubmitAction(focused: boolean, theme: GraphTheme): string {
	const marker = focused ? "❯" : "○";
	return (
		paint(marker, focused ? theme.accent : theme.dim, { bold: focused }) +
		" " +
		paint("Submit response", focused ? theme.text : theme.textMuted, { bold: focused }) +
		paint("  ·  ", theme.dim) +
		graphKeyHint("tui.input.submit", "submit", theme)
	);
}

function clipToCaretWindow(value: string, caret: number, windowWidth: number): { text: string; caret: number } {
	if (windowWidth <= 0) return { text: "", caret: 0 };
	if (visibleWidth(value) <= windowWidth) {
		return { text: value, caret: Math.max(0, Math.min(caret, value.length)) };
	}

	const parts = graphemeParts(value);
	const safeCaret = Math.max(0, Math.min(caret, value.length));
	const caretPartIndex = parts.findIndex((part) => part.end > safeCaret);
	const caretIndex = caretPartIndex === -1 ? parts.length : caretPartIndex;

	// Keep the caret visible and bias toward a few cells of look-ahead, matching
	// the old tail-biased input field while slicing on grapheme/cell boundaries.
	let start = caretIndex;
	let end = caretIndex;
	let cells = 0;
	const lookAheadCells = Math.min(4, windowWidth);
	while (end < parts.length && (cells < lookAheadCells || start === end)) {
		const width = Math.max(1, parts[end]!.width);
		if (cells > 0 && cells + width > windowWidth) break;
		cells += width;
		end += 1;
	}
	while (start > 0) {
		const width = Math.max(1, parts[start - 1]!.width);
		if (cells > 0 && cells + width > windowWidth) break;
		cells += width;
		start -= 1;
	}
	while (end < parts.length) {
		const width = Math.max(1, parts[end]!.width);
		if (cells > 0 && cells + width > windowWidth) break;
		cells += width;
		end += 1;
	}

	const textStart = parts[start]?.start ?? 0;
	const textEnd = parts[end - 1]?.end ?? textStart;
	return {
		text: value.slice(textStart, textEnd),
		caret: Math.max(0, Math.min(safeCaret - textStart, textEnd - textStart)),
	};
}

function drawCursor(text: string, caret: number, cursorOn: boolean, theme: GraphTheme): string {
	const parts = graphemeParts(text);
	const safeCaret = Math.max(0, Math.min(caret, text.length));
	const caretPartIndex = parts.findIndex((part) => part.end > safeCaret);
	const cursorPart = caretPartIndex === -1 ? undefined : parts[caretPartIndex];
	const cursorStart = cursorPart?.start ?? text.length;
	const cursorEnd = cursorPart?.end ?? text.length;
	const before = text.slice(0, cursorStart);
	const at = cursorPart?.text ?? " ";
	const after = text.slice(cursorEnd);
	const beforeFx = paint(before, theme.text);
	const afterFx = paint(after, theme.text);
	if (!cursorOn) return beforeFx + paint(at, theme.text) + afterFx;
	const cursorFg = hexToAnsi(theme.backgroundPanel);
	const cursorBg = hexBg(theme.accent);
	return beforeFx + cursorBg + cursorFg + BOLD + at + RESET + afterFx;
}

function padToUsable(content: string, usable: number): string {
	const w = visibleWidth(content);
	if (w >= usable) return truncateToWidth(content, usable, "", true);
	return content + " ".repeat(usable - w);
}

type CodingAgentKeybinding = Parameters<typeof keyHint>[0];

function graphKeyHint(keybinding: CodingAgentKeybinding, description: string, theme: GraphTheme): string {
	try {
		return keyHint(keybinding, description);
	} catch {
		return localKeyHint(keyText(keybinding), description, theme);
	}
}

function graphRawKeyHint(key: string, description: string, theme: GraphTheme): string {
	try {
		return rawKeyHint(key, description);
	} catch {
		return localKeyHint(key, description, theme);
	}
}

function localKeyHint(key: string, description: string, theme: GraphTheme): string {
	return paint(key, theme.text) + paint(` ${description}`, theme.textMuted);
}

function renderHints(kind: PendingPrompt["kind"], theme: GraphTheme): string {
	const sep = paint(" · ", theme.dim);
	if (kind === "editor") {
		return (
			graphRawKeyHint("tab", "Submit Action", theme) +
			sep +
			graphKeyHint("tui.input.submit", "Newline/Submit", theme) +
			sep +
			graphRawKeyHint("ctrl+c", "Skip", theme)
		);
	}
	if (kind === "confirm") {
		return (
			graphRawKeyHint("y", "Yes", theme) +
			sep +
			graphRawKeyHint("n", "No", theme) +
			sep +
			graphKeyHint("tui.select.confirm", "Submit", theme) +
			sep +
			graphRawKeyHint("ctrl+c", "Skip", theme)
		);
	}
	if (kind === "select") {
		return (
			graphRawKeyHint("↑↓", "Choose", theme) +
			sep +
			graphKeyHint("tui.select.confirm", "Submit", theme) +
			sep +
			graphRawKeyHint("ctrl+c", "Skip", theme)
		);
	}
	return graphKeyHint("tui.input.submit", "Submit", theme) + sep + graphRawKeyHint("ctrl+c", "Skip", theme);
}
