import type { WorkflowInputEntry } from "../extension/render-result.js";
import { sanitizeToolDisplayText, sanitizeToolTitleText } from "../shared/tool-payload-bounds.js";
import { paint } from "./color-utils.js";
import type { GraphTheme } from "./graph-theme.js";
import { renderCompactBandHeader } from "./header.js";
import { clampGraphemeOffset, headToWidth, layoutEditableText, tailToWidth } from "./inputs-picker-editing.js";
import type { InputsPickerRenderOpts, InputsPickerState } from "./inputs-picker-types.js";
import { computeInvalid, invalidForField, parseBooleanInput } from "./inputs-picker-types.js";
import { renderAskChoiceRows, renderSubmitControls } from "./submit-pane.js";
import { graphemes, truncateToWidth, visibleWidth, wrapPlainText } from "./text-helpers.js";

function renderInlineText(
	value: string,
	focused: boolean,
	cursorOn: boolean,
	usable: number,
	theme: GraphTheme,
	placeholder: string | undefined,
	isEmpty: boolean,
	caret?: number,
): string {
	const showCursor = focused && cursorOn;
	if (isEmpty) {
		const ph = placeholder ?? "";
		if (ph === "") {
			return padLine(showCursor ? paint("▋", theme.accent) : " ", usable);
		}
		const [first = "", ...rest] = graphemes(ph);
		const head = showCursor ? paint(first, theme.bg, { bg: theme.accent }) : paint(first, theme.dim);
		return padLine(head + paint(rest.join(""), theme.dim), usable);
	}
	const safe = clampGraphemeOffset(value, caret ?? value.length);
	const beforeFull = value.slice(0, safe);
	const afterFull = value.slice(safe);
	const [at = ""] = graphemes(afterFull);
	const afterRest = at === "" ? "" : afterFull.slice(at.length);
	const cursorPlain = showCursor ? (at !== "" ? at : "▋") : at;
	const cursorWidth = Math.max(1, visibleWidth(cursorPlain));
	const totalWidth =
		visibleWidth(beforeFull) + cursorWidth + visibleWidth(showCursor ? afterRest : afterFull.slice(at.length));
	let before = beforeFull;
	let after = showCursor ? afterRest : afterFull.slice(at.length);
	if (totalWidth > usable) {
		before = tailToWidth(beforeFull, Math.max(0, usable - cursorWidth));
		after = headToWidth(
			showCursor ? afterRest : afterFull.slice(at.length),
			Math.max(0, usable - visibleWidth(before) - cursorWidth),
		);
	}
	const cursorCell = showCursor
		? at !== ""
			? paint(at, theme.bg, { bg: theme.accent })
			: paint("▋", theme.accent)
		: paint(at, theme.text);
	return padLine(paint(before, theme.text) + cursorCell + paint(after, theme.text), usable);
}

function padLine(s: string, usable: number): string {
	// The caller appends `│` immediately after this string, so the row must
	// fill exactly `usable` cells of visible width — otherwise the right
	// border slides leftward and the field card looks broken-narrow under a
	// full-width top/bottom border. Pad short content; clip overflow with `…`.
	// visibleWidth/truncateToWidth are width-correct for CJK/emoji glyphs.
	const len = visibleWidth(s);
	if (len === usable) return s;
	if (len < usable) return s + " ".repeat(usable - len);
	return truncateToWidth(s, usable, "…");
}

function fitLine(line: string, width: number): string {
	return truncateToWidth(line, Math.max(0, width), "…");
}

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

function renderInputField(
	field: WorkflowInputEntry,
	raw: string,
	caret: number,
	cursorOn: boolean,
	invalid: string | null,
	focused: boolean,
	theme: GraphTheme,
	width: number,
): string[] {
	const boxWidth = Math.max(4, width);
	const contentWidth = Math.max(1, boxWidth - 2);
	const borderColor = focused ? theme.accent : theme.borderDim;
	const rows = renderAskStyleInputBody(
		field,
		raw,
		focused ? caret : raw.length,
		cursorOn,
		focused,
		theme,
		contentWidth,
	);
	const top = renderFieldTop(field.name, invalid, boxWidth, borderColor, focused, theme);
	const errorLines =
		invalid !== null && !top.reasonShown
			? wrapPlainText(`✗ ${sanitizeToolTitleText(invalid)}`, width).map((line) => paint(line, theme.error))
			: [];
	const lines = [
		top.line,
		...rows.map((row) => renderFieldRow(row, contentWidth, borderColor, theme)),
		renderFieldBottom(boxWidth, borderColor),
		...errorLines,
		...renderFieldMeta(field, theme, width),
	];
	return lines;
}

function renderAskStyleInputBody(
	field: WorkflowInputEntry,
	raw: string,
	caret: number,
	cursorOn: boolean,
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

	return renderAskInputRows(field, raw, caret, cursorOn, focused, theme, width);
}

function renderAskInputRows(
	field: WorkflowInputEntry,
	raw: string,
	caret: number,
	cursorOn: boolean,
	focused: boolean,
	theme: GraphTheme,
	width: number,
): string[] {
	const usable = Math.max(1, width);
	const safePlaceholder = field.placeholder !== undefined ? sanitizeToolTitleText(field.placeholder) : undefined;
	const clampedRawCaret = Math.max(0, Math.min(caret, raw.length));

	if (field.type !== "text") {
		const safeRaw = sanitizeToolTitleText(raw);
		const safeCaret = sanitizeToolTitleText(raw.slice(0, clampedRawCaret)).length;
		return [renderInlineText(safeRaw, focused, cursorOn, usable, theme, safePlaceholder, raw === "", safeCaret)];
	}

	const ROWS = 3;
	if (raw === "") {
		return [
			renderInlineText("", focused, cursorOn, usable, theme, safePlaceholder, true),
			...Array.from({ length: ROWS - 1 }, () => padLine("", usable)),
		];
	}

	const safeRaw = sanitizeToolDisplayText(raw);
	const mappedCaret = sanitizeToolDisplayText(raw.slice(0, clampedRawCaret)).length;
	const layout = layoutEditableText(safeRaw, usable);
	const safeCaret = clampGraphemeOffset(safeRaw, mappedCaret);
	let cursorRow = layout.length - 1;
	for (let i = 0; i < layout.length; i++) {
		const line = layout[i]!;
		const next = layout[i + 1];
		if (safeCaret >= line.start && safeCaret < line.end) {
			cursorRow = i;
			break;
		}
		if (safeCaret === line.end) {
			cursorRow = next?.start === safeCaret ? i + 1 : i;
		}
	}
	cursorRow = Math.max(0, Math.min(cursorRow, layout.length - 1));
	const start = Math.max(0, Math.min(cursorRow - ROWS + 1, layout.length - ROWS));
	const rows: string[] = [];
	for (let i = 0; i < ROWS; i++) {
		const rowIdx = start + i;
		const line = layout[rowIdx];
		if (!line) {
			rows.push(padLine("", usable));
			continue;
		}
		const lineCaret = safeCaret >= line.start && safeCaret <= line.end ? safeCaret - line.start : line.text.length;
		rows.push(
			renderInlineText(
				line.text,
				focused && rowIdx === cursorRow,
				cursorOn,
				usable,
				theme,
				safePlaceholder,
				false,
				lineCaret,
			),
		);
	}
	return rows;
}

export function renderInputsPicker(opts: InputsPickerRenderOpts): string[] {
	const { theme, workflowName, fields, state, width, cursorOn } = opts;
	const lines: string[] = [];

	lines.push(...renderWorkflowHeader(workflowName, fields.length, state.focusedIdx, theme, width));
	lines.push("");

	for (let i = 0; i < fields.length; i += 1) {
		const field = fields[i]!;
		const raw = state.rawText[field.name] ?? "";
		const invalid = invalidForField(field, raw, i);
		lines.push(...renderInputField(field, raw, state.caret, cursorOn, invalid, state.focusedIdx === i, theme, width));
		lines.push("");
	}

	lines.push(...renderPickerSubmitControls(fields, state, theme, width));

	return lines.map((line) => fitLine(line, width));
}

function renderFieldTop(
	title: string,
	invalid: string | null,
	width: number,
	borderColor: string,
	focused: boolean,
	theme: GraphTheme,
): { line: string; reasonShown: boolean } {
	const safeTitle = sanitizeToolTitleText(title);
	const room = Math.max(0, width - 2);
	const minTitleCols = Math.min(visibleWidth(safeTitle), 4);
	if (invalid === null) {
		const statusPlain = "✓ ";
		const titleBudget = Math.max(1, room - visibleWidth(statusPlain) - 2);
		const titleShown = truncateToWidth(safeTitle, titleBudget, "…");
		const labelText = paint(` ${titleShown} `, focused ? theme.accent : theme.textMuted, { bold: focused });
		const status = paint(statusPlain, theme.success);
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

function renderFieldRow(row: string, contentWidth: number, borderColor: string, _theme: GraphTheme): string {
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

function renderPickerSubmitControls(
	fields: readonly WorkflowInputEntry[],
	state: InputsPickerState,
	theme: GraphTheme,
	width: number,
): string[] {
	const invalid = computeInvalid(fields, state.rawText);
	return renderSubmitControls({
		invalidFieldNames: invalid.map((i) => sanitizeToolTitleText(fields[i]!.name)),
		submitFocused: state.focusedIdx === fields.length,
		theme,
		width,
	});
}
