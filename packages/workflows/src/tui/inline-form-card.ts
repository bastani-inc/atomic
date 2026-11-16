/**
 * Renderer for the inline chat-history workflow form.
 *
 * Identity mirrors the multi ask_user_question dialog:
 *   - Top/bottom dynamic border rules wrap the live form.
 *   - A compact tab row shows each input (`■` valid / `□` missing) plus Submit,
 *     matching the multi-question tab bar affordance.
 *   - Every declared input is rendered on one page as a question block.
 *   - The focused field owns the ask-style pointer/caret.
 *   - Footer hints sit below the bottom rule, like ask_user_question hints.
 *
 *   ───────────────────────────────────────────────────────────────────
 *    ←  □ prompt   ■ iters   ✓ Submit  →
 *
 *   task prompt
 *
 *   ❯ 1. build me a TUI for arg-pickers
 *
 *   ───────────────────────────────────────────────────────────────────
 *   Enter to select · ↑/↓ to navigate · Tab to switch input fields · Esc to cancel
 *
 * Submitted forms become a single-line ledger entry in scrollback. Cancelled
 * forms render no rows so cancellation leaves no chat artefact.
 *
 * The card never owns keystrokes — keystrokes are routed by the editor.
 * `renderInlineCard` is a pure function of `state + theme + width`.
 *
 * cross-ref:
 *  - packages/coding-agent/src/core/tools/ask-user-question/view/dialog-builder.ts
 *  - src/tui/node-card.ts (centred title-in-border pattern)
 *  - src/tui/graph-view.ts (statusline + chrome band composition)
 */

import type { WorkflowInputEntry } from "../extension/render-result.js";
import { sanitizeToolDisplayText, sanitizeToolTitleText } from "../shared/tool-payload-bounds.js";
import { paint } from "./color-utils.js";
import type { GraphTheme } from "./graph-theme.js";
import { renderCompactBandHeader } from "./header.js";
import type { InlineFormState } from "./inline-form-store.js";
import { coerceValues, computeInvalid, invalidForField } from "./inputs-picker.js";
import { parseBooleanInput } from "./inputs-picker-types.js";
import { renderAskChoiceRows, renderSubmitControls } from "./submit-pane.js";
import { truncateToWidth, visibleWidth, wrapPlainText } from "./text-helpers.js";

export interface InlineCardOpts {
	width: number;
	state: InlineFormState;
	theme: GraphTheme;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
	return Array.from(graphemeSegmenter.segment(text), (s) => s.segment);
}

function clampGraphemeOffset(text: string, caret: number): number {
	const c = Math.max(0, Math.min(caret, text.length));
	if (c === text.length) return c;
	for (const s of graphemeSegmenter.segment(text)) {
		if (s.index === c) return c;
		if (s.index > c) break;
	}
	let prev = 0;
	for (const s of graphemeSegmenter.segment(text)) {
		if (s.index >= c) break;
		prev = s.index;
	}
	return prev;
}

function headToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	let out = "";
	let used = 0;
	for (const g of graphemes(text)) {
		const w = visibleWidth(g);
		if (used + w > width) break;
		out += g;
		used += w;
	}
	return out;
}

function tailToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	let out = "";
	let used = 0;
	const gs = graphemes(text);
	for (let i = gs.length - 1; i >= 0; i--) {
		const g = gs[i]!;
		const w = visibleWidth(g);
		if (used + w > width) break;
		out = g + out;
		used += w;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Public renderer
// ---------------------------------------------------------------------------

export function renderInlineCard(opts: InlineCardOpts): string[] {
	const { state, theme, width } = opts;
	if (state.status === "submitted") return [fitLine(renderSubmittedLine(state, theme), width)];
	if (state.status === "cancelled") return [];
	return renderEditingCard(opts).map((line) => fitLine(line, width));
}

function renderEditingCard(opts: InlineCardOpts): string[] {
	const { state, theme, width } = opts;
	const lines: string[] = [];

	lines.push(...renderWorkflowHeader(state.workflowName, state.fields.length, state.focusedIdx, theme, width));
	lines.push("");

	for (let i = 0; i < state.fields.length; i += 1) {
		const field = state.fields[i]!;
		const raw = state.rawText[field.name] ?? "";
		lines.push(...renderField(field, raw, state.caret, state.focusedIdx === i, theme, width));
		lines.push("");
	}

	lines.push(...renderFooterBand(state, theme, width));
	return lines;
}

// ---------------------------------------------------------------------------
// Header / footer chrome bands
// ---------------------------------------------------------------------------

function renderWorkflowHeader(
	workflowName: string,
	fieldCount: number,
	focusedIdx: number,
	theme: GraphTheme,
	width: number,
): string[] {
	const current = Math.min(fieldCount, Math.max(1, focusedIdx + 1));
	return renderCompactBandHeader({
		label: "WORKFLOW",
		subtitle: sanitizeToolTitleText(workflowName),
		badges: fieldCount > 0 ? [{ text: `${current} / ${fieldCount}`, fg: theme.dim }] : [],
		width,
		theme,
	});
}

function renderFooterBand(state: InlineFormState, theme: GraphTheme, width: number): string[] {
	return renderInlineSubmitControls(state, theme, width);
}

// ---------------------------------------------------------------------------
// Field body (ask_user_question-style list/input rows)
// ---------------------------------------------------------------------------

function renderField(
	field: WorkflowInputEntry,
	raw: string,
	caret: number,
	focused: boolean,
	theme: GraphTheme,
	width: number,
): string[] {
	const boxWidth = Math.max(4, width);
	const contentWidth = Math.max(1, boxWidth - 2);
	const borderColor = focused ? theme.accent : theme.borderDim;
	const rows = renderAskStyleFieldBody(field, raw, focused ? caret : raw.length, focused, theme, contentWidth);
	const invalid = invalidForField(field, raw, 0);
	const top = renderFieldTop(
		field.name,
		invalid,
		boxWidth,
		borderColor,
		focused,
		theme,
		field.validationDeferred === true,
	);
	const errorLines =
		invalid !== null && !top.reasonShown
			? wrapPlainText(`✗ ${sanitizeToolTitleText(invalid)}`, width).map((line) => paint(line, theme.error))
			: [];
	return [
		top.line,
		...rows.map((row) => renderFieldRow(row, contentWidth, borderColor)),
		renderFieldBottom(boxWidth, borderColor),
		...errorLines,
		...renderFieldMeta(field, theme, width),
	];
}

function renderAskStyleFieldBody(
	field: WorkflowInputEntry,
	raw: string,
	caret: number,
	focused: boolean,
	theme: GraphTheme,
	width: number,
): string[] {
	if (field.type === "select" && field.choices && field.choices.length > 0) {
		const selected = field.choices.indexOf(raw);
		return field.choices.flatMap((choice, i) => {
			const safeChoice = sanitizeToolTitleText(choice);
			return renderAskChoiceRows(
				i + 1,
				focused || i !== selected ? safeChoice : `✓ ${safeChoice}`,
				focused && i === selected,
				theme,
				width,
			);
		});
	}

	if (field.type === "boolean") {
		const parsed = parseBooleanInput(raw);
		return [
			...renderAskChoiceRows(
				1,
				focused || parsed !== true ? "on" : "✓ on",
				focused && parsed === true,
				theme,
				width,
			),
			...renderAskChoiceRows(
				2,
				focused || parsed !== false ? "off" : "✓ off",
				focused && parsed === false,
				theme,
				width,
			),
		];
	}

	return renderAskInputRows(field, raw, caret, focused, field.placeholder, theme, width);
}

function renderInlineSubmitControls(state: InlineFormState, theme: GraphTheme, width: number): string[] {
	const invalid = computeInvalid(state.fields, state.rawText);
	return renderSubmitControls({
		invalidFieldNames: invalid.map((i) => sanitizeToolTitleText(state.fields[i]!.name)),
		submitFocused: state.focusedIdx === state.fields.length,
		theme,
		width,
	});
}

function renderFieldTop(
	title: string,
	invalid: string | null,
	width: number,
	borderColor: string,
	focused: boolean,
	theme: GraphTheme,
	validationDeferred = false,
): { line: string; reasonShown: boolean } {
	const safeTitle = sanitizeToolTitleText(title);
	const room = Math.max(0, width - 2);
	const minTitleCols = Math.min(visibleWidth(safeTitle), 4);
	if (invalid === null) {
		const statusPlain = validationDeferred ? "? " : "✓ ";
		const titleBudget = Math.max(1, room - visibleWidth(statusPlain) - 2);
		const titleShown = truncateToWidth(safeTitle, titleBudget, "…");
		const labelText = paint(` ${titleShown} `, focused ? theme.accent : theme.textMuted, { bold: focused });
		const status = paint(statusPlain, validationDeferred ? theme.textMuted : theme.success);
		const head = truncateToWidth(labelText + status, room, "…");
		const fill = Math.max(0, room - visibleWidth(head));
		return {
			line: paint("╭", borderColor) + head + paint(`${"─".repeat(fill)}╮`, borderColor),
			reasonShown: true,
		};
	}
	const safeInvalid = sanitizeToolTitleText(invalid);
	const fullStatusPlain = `✗ ${safeInvalid} `;
	const reasonShown = minTitleCols + 2 + visibleWidth(fullStatusPlain) <= room;
	const statusPlain = reasonShown ? fullStatusPlain : "✗ ";
	const titleBudget = Math.max(1, room - visibleWidth(statusPlain) - 2);
	const titleShown = truncateToWidth(safeTitle, titleBudget, "…");
	const labelText = paint(` ${titleShown} `, focused ? theme.accent : theme.textMuted, { bold: focused });
	const status = paint(statusPlain, theme.error);
	const head = truncateToWidth(labelText + status, room, "…");
	const fill = Math.max(0, room - visibleWidth(head));
	return {
		line: paint("╭", borderColor) + head + paint(`${"─".repeat(fill)}╮`, borderColor),
		reasonShown,
	};
}

function renderFieldRow(row: string, contentWidth: number, borderColor: string): string {
	const clipped = truncateToWidth(row, contentWidth, "");
	const padded = clipped + " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
	return paint("│", borderColor) + padded + paint("│", borderColor);
}

function renderFieldBottom(width: number, borderColor: string): string {
	return paint(`╰${"─".repeat(Math.max(0, width - 2))}╯`, borderColor);
}

function renderFieldMeta(field: WorkflowInputEntry, theme: GraphTheme, width: number): string[] {
	const required = field.required ? "required" : "optional";
	const safeDescription = field.description ? sanitizeToolTitleText(field.description) : "";
	const text =
		safeDescription.length > 0 ? `${field.type} · ${required} · ${safeDescription}` : `${field.type} · ${required}`;
	return wrapPlainText(text, width).map((line) => paintRequiredMetaLine(line, field.required === true, theme));
}

function paintRequiredMetaLine(line: string, required: boolean, theme: GraphTheme): string {
	if (!required) return paint(line, theme.textMuted);
	return line
		.split(/(\brequired\b)/g)
		.map((part) => (part === "required" ? paint(part, theme.warning) : paint(part, theme.textMuted)))
		.join("");
}

function renderAskInputRows(
	field: WorkflowInputEntry,
	raw: string,
	caret: number,
	focused: boolean,
	placeholder: string | undefined,
	theme: GraphTheme,
	width: number,
): string[] {
	const usable = Math.max(1, width);
	const safePlaceholder = placeholder ? sanitizeToolTitleText(placeholder) : "";
	if (raw === "") {
		const value =
			safePlaceholder.length > 0
				? paint(safePlaceholder, theme.dim) + (focused ? cursorBlock() : "")
				: focused
					? cursorBlock()
					: "";
		return [truncateToWidth(value, usable, "…")];
	}

	const clampedRawCaret = Math.max(0, Math.min(caret, raw.length));
	const safeRaw = field.type === "text" ? sanitizeToolDisplayText(raw) : sanitizeToolTitleText(raw);
	const safeCaret =
		field.type === "text"
			? sanitizeToolDisplayText(raw.slice(0, clampedRawCaret)).length
			: sanitizeToolTitleText(raw.slice(0, clampedRawCaret)).length;
	const layout = layoutTextField(safeRaw, usable, safeCaret);
	return layout.lines.map((line, row) =>
		focused && row === layout.cursorRow
			? renderCaretLine(line, layout.cursorOffset ?? line.length, usable, theme, theme.text)
			: truncateToWidth(paint(line, theme.text), usable, "…"),
	);
}

function renderCaretLine(raw: string, caret: number, usable: number, _theme: GraphTheme, color: string): string {
	const safe = clampGraphemeOffset(raw, caret);
	const beforeFull = raw.slice(0, safe);
	const afterFull = raw.slice(safe);
	const [at = ""] = graphemes(afterFull);
	const afterRest = at === "" ? "" : afterFull.slice(at.length);
	const cursorPlain = at !== "" ? at : " ";
	const cursorWidth = Math.max(1, visibleWidth(cursorPlain));
	let before = beforeFull;
	let after = afterRest;
	if (visibleWidth(beforeFull) + cursorWidth + visibleWidth(afterRest) > usable) {
		before = tailToWidth(beforeFull, Math.max(0, usable - cursorWidth));
		after = headToWidth(afterRest, Math.max(0, usable - visibleWidth(before) - cursorWidth));
	}
	return clip(paint(before, color) + cursorBlock(cursorPlain) + paint(after, color), usable);
}

// ---------------------------------------------------------------------------
// Frozen states
// ---------------------------------------------------------------------------

function renderSubmittedLine(state: InlineFormState, theme: GraphTheme): string {
	return (
		paint("✓ submitted", theme.success, { bold: true }) +
		paint("  ·  ", theme.dim) +
		paint(composeCommand(state), theme.dim)
	);
}

function composeCommand(state: InlineFormState): string {
	const parts: string[] = [`/workflow ${sanitizeToolTitleText(state.workflowName)}`];
	for (const [name, value] of Object.entries(coerceValues(state.fields, state.rawText))) {
		const safeName = sanitizeToolTitleText(name);
		let formattedValue = JSON.stringify(value).replace(
			/[\x7f-\x9f\u2028\u2029]/g,
			(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
		);
		if (typeof value === "string" && value !== "" && !/[\s\x00-\x1f\x7f-\x9f"'=\\]/.test(value)) {
			try {
				JSON.parse(value);
			} catch {
				formattedValue = value;
			}
		}
		parts.push(`${safeName}=${formattedValue}`);
	}
	return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

function fitLine(ansi: string, width: number): string {
	return truncateToWidth(ansi, Math.max(0, width), "…");
}

function clip(ansi: string, budget: number): string {
	return truncateToWidth(ansi, Math.max(0, budget), "…");
}

function cursorBlock(text = " "): string {
	return `\x1b[7m${text}\x1b[0m`;
}

/**
 * Lay out a multi-line text field into visual rows while tracking where the
 * caret should appear on screen. Newlines (`\n`) always start a new visual
 * row; logical lines that exceed `usable` cells wrap at the character
 * boundary (a deliberately simple rule — word-wrap would also be fine but
 * adds noise for prompt-style inputs where every character is signal).
 *
 * Caret semantics:
 *   - `caret` is the byte offset into `raw`.
 *   - The returned `cursorRow`/`cursorCol` point to the visual cell where
 *     the cursor glyph should render — the cell currently occupied by the
 *     character AT `caret` (so the cursor visually sits BEFORE that
 *     character). When `caret === raw.length`, the cursor lands at the
 *     end of the last visual row.
 *   - When `caret` falls on a wrap boundary, the cursor lands on the start
 *     of the next visual row, matching how Pi's own editor positions the
 *     caret after the last character that fit.
 *
 * cross-ref: pi-tui dist/components/editor.js `layoutText`/`wordWrapLine`.
 */
export function layoutTextField(
	raw: string,
	usable: number,
	caret: number,
): { lines: string[]; cursorRow: number; cursorCol: number; cursorOffset?: number } {
	const width = Math.max(1, Math.floor(usable));
	const safeCaret = clampGraphemeOffset(raw, caret);
	const visualLines: string[] = [];
	const lineStarts: number[] = [];
	const lineEnds: number[] = [];
	let curLine = "";
	let curWidth = 0;
	let lineStart = 0;

	const pushLine = (end: number): void => {
		visualLines.push(curLine);
		lineStarts.push(lineStart);
		lineEnds.push(end);
		curLine = "";
		curWidth = 0;
		lineStart = end;
	};

	for (const s of graphemeSegmenter.segment(raw)) {
		const offset = s.index;
		const g = s.segment;
		if (g === "\n") {
			pushLine(offset);
			lineStart = offset + g.length;
			continue;
		}
		const w = visibleWidth(g);
		if (curLine !== "" && curWidth + w > width) {
			pushLine(offset);
		}
		curLine += g;
		curWidth += w;
		if (curWidth >= width) {
			pushLine(offset + g.length);
		}
	}
	visualLines.push(curLine);
	lineStarts.push(lineStart);
	lineEnds.push(raw.length);

	let cursorRow = visualLines.length - 1;
	for (let i = 0; i < visualLines.length; i++) {
		const start = lineStarts[i]!;
		const end = lineEnds[i]!;
		const nextStart = lineStarts[i + 1];
		if (safeCaret >= start && safeCaret < end) {
			cursorRow = i;
			break;
		}
		if (safeCaret === end) {
			cursorRow = nextStart === safeCaret ? i + 1 : i;
		}
	}
	cursorRow = Math.max(0, Math.min(cursorRow, visualLines.length - 1));
	const line = visualLines[cursorRow] ?? "";
	const cursorOffset = Math.max(0, Math.min(safeCaret - (lineStarts[cursorRow] ?? 0), line.length));
	const cursorCol = visibleWidth(line.slice(0, cursorOffset));
	return { lines: visualLines, cursorRow, cursorCol, cursorOffset };
}
