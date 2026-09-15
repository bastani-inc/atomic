import { RESET } from "./color-utils.js";
import { paint, stripAnsi } from "./stage-chat-view-render-helpers.js";
import { truncateToWidth, visibleWidth } from "./text-helpers.js";

/** Supported terminal floor for injecting `[stage: name]` into an input rule. */
export const STAGE_INPUT_LABEL_MIN_COLUMNS = 40;

const STAGE_LABEL_MARKER = "[stage:";
const EDITOR_PREFIX = "[stage: ";
const EDITOR_SUFFIX = "] ";
const WIDGET_PREFIX = "[stage: ";
const WIDGET_SUFFIX = "]";
const AWAITING_PREFIX = " [stage: ";
const AWAITING_SUFFIX = "] ";
const BOX_OPEN_CHARS = "╭┌+";
const BOX_CLOSE_CHARS = "╮┐+";

export interface StageInputLabelTheme {
	readonly textMuted: string;
	readonly text: string;
}

function resolvedStageName(stageName: string | undefined): string | undefined {
	if (stageName === undefined || stageName.length === 0) return undefined;
	return stageName;
}

function lineHasStageLabel(line: string): boolean {
	return stripAnsi(line).includes(STAGE_LABEL_MARKER);
}

function leadingAnsi(line: string): string {
	return line.match(/^(\x1b\[[0-9;]*m)/)?.[1] ?? "";
}

function buildStageInputLabel(
	theme: StageInputLabelTheme,
	stageName: string,
	maxNameWidth: number,
	prefix: string,
	suffix: string,
): { plain: string; styled: string } | undefined {
	if (maxNameWidth < 1) return undefined;
	const truncatedName = truncateToWidth(stageName, maxNameWidth, "…");
	if (truncatedName.length === 0) return undefined;
	const plain = prefix + truncatedName + suffix;
	return {
		plain,
		styled:
			paint(prefix, theme.textMuted) +
			paint(truncatedName, theme.text, { bold: true }) +
			paint(suffix, theme.textMuted),
	};
}

/**
 * Inject `[stage: name]` into the first all-dash editor rule. Later dash rules
 * (the bottom border) are never selected, including on repeated transforms.
 */
export function applyStageLabelToEditorTopRule(
	theme: StageInputLabelTheme,
	stageName: string | undefined,
	editorLines: readonly string[],
): string[] {
	const name = resolvedStageName(stageName);
	if (!name || editorLines.length === 0) return [...editorLines];
	if (editorLines.some(lineHasStageLabel)) return [...editorLines];

	for (let i = 0; i < editorLines.length; i++) {
		const line = editorLines[i] ?? "";
		const plain = stripAnsi(line).trim();
		if (!/^─+$/.test(plain)) continue;
		const width = visibleWidth(plain);
		if (width < STAGE_INPUT_LABEL_MIN_COLUMNS) return [...editorLines];
		const maxNameWidth = Math.max(1, width - visibleWidth(EDITOR_PREFIX) - visibleWidth(EDITOR_SUFFIX) - 2);
		const label = buildStageInputLabel(theme, name, maxNameWidth, EDITOR_PREFIX, EDITOR_SUFFIX);
		if (!label || visibleWidth(label.plain) >= width) return [...editorLines];
		const openColor = leadingAnsi(line);
		const fillWidth = Math.max(0, width - visibleWidth(label.plain));
		const result = [...editorLines];
		result[i] = openColor + RESET + label.styled + openColor + "─".repeat(fillWidth) + RESET;
		return result;
	}
	return [...editorLines];
}

type WidgetTopRule =
	| { kind: "pure"; width: number }
	| { kind: "boxed"; open: string; close: string; width: number }
	| { kind: "other" };

function classifyWidgetTopRule(plain: string): WidgetTopRule {
	const chars = Array.from(plain);
	const width = visibleWidth(plain);
	if (chars.length === 0) return { kind: "other" };
	if (/^─+$/.test(plain)) return { kind: "pure", width };
	const open = chars[0] ?? "";
	const close = chars.at(-1) ?? "";
	if (chars.length >= 3 && BOX_OPEN_CHARS.includes(open) && BOX_CLOSE_CHARS.includes(close)) {
		const inner = chars.slice(1, -1);
		if (inner.length > 0 && inner.every((char) => char === "─")) {
			return { kind: "boxed", open, close, width };
		}
	}
	return { kind: "other" };
}

/**
 * Inject `[stage: name]` into a widget top rule. Accepts a pure `─` DynamicBorder
 * and empty boxed fill (`╭──╮`). Titled boxes, unrelated first rows, and rules
 * below the 40-column floor are left unchanged. Geometry follows the original
 * border width rather than the caller-supplied viewport.
 */
export function applyStageLabelToWidgetTopRule(
	theme: StageInputLabelTheme,
	stageName: string | undefined,
	widgetLines: readonly string[],
	width: number,
): string[] {
	const name = resolvedStageName(stageName);
	if (!name || widgetLines.length === 0 || width < STAGE_INPUT_LABEL_MIN_COLUMNS) {
		return [...widgetLines];
	}

	const topLine = widgetLines[0] ?? "";
	if (lineHasStageLabel(topLine)) return [...widgetLines];
	const plain = stripAnsi(topLine);
	const rule = classifyWidgetTopRule(plain);
	if (rule.kind === "other") return [...widgetLines];
	if (rule.width < STAGE_INPUT_LABEL_MIN_COLUMNS) return [...widgetLines];

	const openWidth = rule.kind === "boxed" ? visibleWidth(rule.open) : 0;
	const closeWidth = rule.kind === "boxed" ? visibleWidth(rule.close) : 0;
	const maxNameWidth =
		rule.width - openWidth - visibleWidth(WIDGET_PREFIX) - visibleWidth(WIDGET_SUFFIX) - closeWidth - 2;
	const label = buildStageInputLabel(theme, name, maxNameWidth, WIDGET_PREFIX, WIDGET_SUFFIX);
	if (!label) return [...widgetLines];
	const labelWidth = visibleWidth(label.plain);
	if (openWidth + labelWidth + closeWidth >= rule.width) return [...widgetLines];
	const fillWidth = Math.max(0, rule.width - openWidth - labelWidth - closeWidth);
	const openColor = leadingAnsi(topLine);
	const newTopLine =
		rule.kind === "pure"
			? openColor + RESET + label.styled + openColor + "─".repeat(fillWidth) + RESET
			: openColor + rule.open + RESET + label.styled + openColor + "─".repeat(fillWidth) + rule.close + RESET;
	return [newTopLine, ...widgetLines.slice(1)];
}

/**
 * Append `[stage: name]` to the first unlabeled `AWAITING INPUT` top border.
 * Already-labeled identity banners are left alone so compact unlabeled boxes
 * can still receive the stage name without extra rows.
 */
export function applyStageLabelToAwaitingInputTopRule(
	theme: StageInputLabelTheme,
	stageName: string | undefined,
	lines: readonly string[],
): string[] {
	const name = resolvedStageName(stageName);
	if (!name || lines.length === 0) return [...lines];

	let unlabeledIndex = -1;
	for (let i = 0; i < lines.length; i++) {
		const plain = stripAnsi(lines[i] ?? "");
		if (!plain.startsWith("╭") || !plain.endsWith("╮") || !plain.includes("AWAITING INPUT")) continue;
		if (plain.includes(STAGE_LABEL_MARKER)) return [...lines];
		if (unlabeledIndex < 0) unlabeledIndex = i;
	}
	if (unlabeledIndex < 0) return [...lines];

	const line = lines[unlabeledIndex] ?? "";
	const plain = stripAnsi(line);
	const width = visibleWidth(plain);
	const innerWidth = Math.max(0, width - 2);
	const inner = plain.slice(1, -1);
	const fillStart = inner.indexOf("─");
	const title = fillStart < 0 ? inner : inner.slice(0, fillStart);
	const maxNameWidth =
		innerWidth - visibleWidth(title) - visibleWidth(AWAITING_PREFIX) - visibleWidth(AWAITING_SUFFIX);
	const label = buildStageInputLabel(theme, name, maxNameWidth, AWAITING_PREFIX, AWAITING_SUFFIX);
	if (!label) return [...lines];
	const titleStyled = paint(title, theme.textMuted, { bold: true });
	const combined = titleStyled + label.styled;
	if (visibleWidth(combined) > innerWidth) return [...lines];
	const fillLen = Math.max(0, innerWidth - visibleWidth(combined));
	const openColor = leadingAnsi(line);
	const result = [...lines];
	result[unlabeledIndex] = `${openColor}╭${RESET}${combined}${openColor}${"─".repeat(fillLen)}╮${RESET}`;
	return result;
}
