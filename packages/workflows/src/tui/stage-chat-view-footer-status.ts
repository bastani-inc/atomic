import type { AgentSession } from "@bastani/atomic";
import { Box, Text } from "@earendil-works/pi-tui";
import type { StageSnapshot } from "../shared/store-types.js";
import { hexToAnsi, RESET } from "./color-utils.js";
import { wrapIdentifierLines } from "./run-identity-rows.js";
import {
	bgFn,
	blendBg,
	paint,
	paintOnFill,
	stripAnsi,
	trailingWidgetBorderChar,
	widgetHintTargetLineIndex,
} from "./stage-chat-view-render-helpers.js";
import type { StageChatViewContext } from "./stage-chat-view-types.js";
import { truncateToWidth, visibleWidth } from "./text-helpers.js";

/**
 * Pass-through rule callback for chatHostStyle (Case 1 of issue #2886).
 *
 * Label injection for the editor top rule happens AFTER CustomEditor has
 * finished wrapping — see injectStageLabelIntoEditorTopRule(). Injecting
 * inside the rule() callback breaks CustomEditor.isEditorBorderLine(), which
 * uses a pattern match to detect borders and would incorrectly treat a
 * label-decorated line as content, prepending ❯ instead of extending the
 * border.
 */
export function stageLabelRule(
	_ctx: StageChatViewContext,
	_stageName: string | undefined,
	hex: string,
	text: string,
): string {
	return hexToAnsi(hex) + text + RESET;
}

/**
 * Post-process rendered editor lines to inject `[stage: name]` into the top
 * rule line (Case 1 of issue #2886).
 *
 * Finds the first line whose stripped content is all `─` characters (the
 * editor top border), replaces leading dashes with the styled label, and
 * returns a new lines array. Runs AFTER CustomEditor.render() has completed
 * so ❯ is correctly on the content line and isEditorBorderLine checks are done.
 *
 * Styling: `[stage: ` in textMuted, name in bold text, 40-column minimum floor.
 */
export function injectStageLabelIntoEditorTopRule(
	ctx: StageChatViewContext,
	stageName: string | undefined,
	editorLines: readonly string[],
): string[] {
	if (!stageName || editorLines.length === 0) return [...editorLines];

	const PREFIX = "[stage: ";
	const SUFFIX = "] ";

	for (let i = 0; i < editorLines.length; i++) {
		const line = editorLines[i] ?? "";
		const plain = stripAnsi(line).trim();
		// Top rule: all dashes, at least 40 wide.
		if (plain.length < 40 || !/^─+$/.test(plain)) continue;

		const width = visibleWidth(plain);
		const maxNameWidth = Math.max(1, width - visibleWidth(PREFIX) - visibleWidth(SUFFIX) - 2);
		const truncatedName = truncateToWidth(stageName, maxNameWidth, "…");
		const labelPlain = PREFIX + truncatedName + SUFFIX;
		const labelWidth = visibleWidth(labelPlain);

		if (labelWidth >= width) break;

		const labelStyled =
			paint(PREFIX, ctx.theme.textMuted) +
			paint(truncatedName, ctx.theme.text, { bold: true }) +
			paint(SUFFIX, ctx.theme.textMuted);

		// Preserve the leading ANSI color from the original border line, inject
		// the label, then fill the remaining columns with ─ in the same color.
		const openColorMatch = line.match(/^(\x1b\[[0-9;]*m)/);
		const openColor = openColorMatch?.[1] ?? "";
		const fillWidth = Math.max(0, width - labelWidth);

		const result = [...editorLines];
		result[i] = openColor + RESET + labelStyled + openColor + "─".repeat(fillWidth) + RESET;
		return result;
	}

	return [...editorLines];
}

export function renderHeader(ctx: StageChatViewContext, width: number, stage: StageSnapshot | undefined): string[] {
	const t = ctx.theme;
	const stageName = stage?.name ?? "stage";
	const sid = ctx.handle?.sessionId ?? stage?.sessionId;
	const prefixWidth = visibleWidth("   STAGE  ");
	const separatorWidth = visibleWidth(" / ");
	const meta = sid ? `session ${sid}` : "";
	const rightWidth = meta ? visibleWidth(meta) + 1 : 0;
	const singleRowNameBudget = width - prefixWidth - separatorWidth - rightWidth - (meta ? 1 : 0);

	const fullNameWidth = visibleWidth(ctx.workflowName) + visibleWidth(stageName);
	if (!sid || singleRowNameBudget >= fullNameWidth) {
		const names = fitHeaderNames(ctx.workflowName, stageName, Math.max(2, singleRowNameBudget));
		const left = renderHeaderLeft(ctx, names.workflow, names.stage);
		const right = meta ? `${paint(meta, t.dim)} ` : "";
		const gap = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
		return [left + " ".repeat(gap) + right];
	}

	const names = fitHeaderNames(ctx.workflowName, stageName, Math.max(2, width - prefixWidth - separatorWidth));
	const left = renderHeaderLeft(ctx, names.workflow, names.stage);
	const lines = [left + " ".repeat(Math.max(0, width - visibleWidth(left)))];
	if (visibleWidth(meta) + 1 <= width) {
		lines.push(`${" ".repeat(Math.max(0, width - visibleWidth(meta) - 1))}${paint(meta, t.dim)} `);
		return lines;
	}
	for (const row of wrapIdentifierLines(sid, width, "   ", "   ")) {
		const value = `${row.prefix}${paint(row.chunk, t.dim)}`;
		lines.push(value + " ".repeat(Math.max(0, width - visibleWidth(value))));
	}
	return lines;
}

function renderHeaderLeft(ctx: StageChatViewContext, workflowName: string, stageName: string): string {
	const t = ctx.theme;
	return (
		paint("   ", t.mauve, { bold: true }) +
		paint("STAGE", t.textMuted, { bold: true }) +
		"  " +
		paint(workflowName, t.textMuted) +
		paint(" / ", t.dim) +
		paint(stageName, t.text, { bold: true })
	);
}

function fitHeaderNames(workflowName: string, stageName: string, budget: number): { workflow: string; stage: string } {
	const available = Math.max(2, budget);
	const workflowWidth = visibleWidth(workflowName);
	const stageWidth = visibleWidth(stageName);
	let workflowBudget = Math.min(workflowWidth, Math.max(1, Math.ceil(available / 2)));
	let stageBudget = Math.min(stageWidth, Math.max(1, available - workflowBudget));
	let remaining = available - workflowBudget - stageBudget;
	const workflowExtra = Math.min(remaining, Math.max(0, workflowWidth - workflowBudget));
	workflowBudget += workflowExtra;
	remaining -= workflowExtra;
	stageBudget += Math.min(remaining, Math.max(0, stageWidth - stageBudget));
	return {
		workflow: truncateToWidth(workflowName, workflowBudget, "…"),
		stage: truncateToWidth(stageName, stageBudget, "…"),
	};
}

export function sepRule(ctx: StageChatViewContext, width: number): string {
	return hexToAnsi(ctx.theme.borderDim) + "─".repeat(width) + RESET;
}

export function renderFooterWithOrchestratorReturnHint(
	ctx: StageChatViewContext,
	width: number,
	footerLines: readonly string[],
): string[] {
	if (footerLines.length === 0) {
		return [mergeOrchestratorReturnHintIntoLine(ctx, "", width)];
	}
	const lines = [...footerLines];
	const hasTasks = ctx.chatHost.renderTaskFooter(width).length > 0;
	// Never trade the task status or /tasks route for the graph shortcut.
	// With tasks, share the identity line instead and leave MCP intact.
	if (hasTasks && lines.length === 1) lines.unshift("");
	const hintIndex = hasTasks ? 0 : lines.length - 1;
	lines[hintIndex] = mergeOrchestratorReturnHintIntoLine(ctx, lines[hintIndex] ?? "", width);
	return lines;
}
export function renderReadOnlyArchiveFooter(ctx: StageChatViewContext, width: number): string[] {
	const closeHint = paint("esc", ctx.theme.text, { bold: true }) + paint(" to close", ctx.theme.textMuted);
	return [
		mergeOrchestratorReturnHintIntoLine(ctx, closeHint, width, {
			minimumPrefixWidth: visibleWidth(closeHint) + 1,
		}),
	];
}

/**
 * Inject `[stage: name]` into the top rule of a widget (line 0), immediately
 * after the opening border character (e.g. `╭`).
 *
 * Used for Case 2 of issue #2886: the ask_user_question widget hides the
 * editor, so the stage label moves to the widget's own top border line.
 * The ctrl+x hint is merged separately by embedOrchestratorReturnHintInWidget
 * and may land on a different line, so the two passes are independent.
 */
export function embedStageLabelInWidgetTopRule(
	ctx: StageChatViewContext,
	stageName: string | undefined,
	widgetLines: readonly string[],
	width: number,
): string[] {
	if (!stageName || widgetLines.length === 0 || width < 40) return [...widgetLines];

	const topLine = widgetLines[0] ?? "";
	const plain = stripAnsi(topLine);
	const chars = Array.from(plain);
	// Must start with a box-drawing open char and contain ─ fill to inject into.
	if (chars.length < 3 || !"╭┌+".includes(chars[0] ?? "")) return [...widgetLines];

	const PREFIX = "[stage: ";
	const SUFFIX = "]";
	// Budget: opening char (1) + 1 ─ minimum on each side.
	const maxNameWidth = width - 1 - visibleWidth(PREFIX) - visibleWidth(SUFFIX) - 2;
	if (maxNameWidth < 1) return [...widgetLines];

	const truncatedName = truncateToWidth(stageName, maxNameWidth, "…");
	const labelPlain = PREFIX + truncatedName + SUFFIX;
	const labelStyled =
		paint(PREFIX, ctx.theme.textMuted) +
		paint(truncatedName, ctx.theme.text, { bold: true }) +
		paint(SUFFIX, ctx.theme.textMuted);

	// Replace the top line: keep leading border char + color, insert label,
	// fill remaining columns with ─, keep the trailing border char if present.
	const trailingBorder = trailingWidgetBorderChar(topLine);
	const trailingWidth = visibleWidth(trailingBorder);
	const innerFillWidth = Math.max(0, width - 1 - visibleWidth(labelPlain) - trailingWidth);

	// Extract the color applied to the opening border char.
	const openColorMatch = topLine.match(/^(\x1b\[[0-9;]*m)/);
	const openColor = openColorMatch?.[1] ?? "";
	const openChar = chars[0] ?? "╭";

	const newTopLine =
		openColor +
		openChar +
		RESET +
		labelStyled +
		openColor +
		"─".repeat(innerFillWidth) +
		(trailingBorder ? trailingBorder : "") +
		RESET;

	return [newTopLine, ...widgetLines.slice(1)];
}

export function embedOrchestratorReturnHintInWidget(
	ctx: StageChatViewContext,
	widgetLines: readonly string[],
	width: number,
): string[] {
	if (widgetLines.length === 0) {
		return [mergeOrchestratorReturnHintIntoLine(ctx, "", width)];
	}
	const lines = [...widgetLines];
	const targetIndex = widgetHintTargetLineIndex(lines);
	const targetLine = lines[targetIndex] ?? "";
	const trailingBorder = trailingWidgetBorderChar(targetLine);
	const plainPrefix = stripAnsi(targetLine)
		.slice(0, trailingBorder.length > 0 ? -trailingBorder.length : undefined)
		.trimEnd();
	lines[targetIndex] = mergeOrchestratorReturnHintIntoLine(ctx, targetLine, width, {
		preserveTrailingBorder: true,
		rightMargin: 2,
		minimumPrefixWidth: visibleWidth(plainPrefix) + 1,
	});
	return lines;
}

function mergeOrchestratorReturnHintIntoLine(
	ctx: StageChatViewContext,
	line: string,
	width: number,
	options: {
		preserveTrailingBorder?: boolean;
		rightMargin?: number;
		minimumPrefixWidth?: number;
	} = {},
): string {
	const fullHint = {
		plain: "ctrl+x return to graph",
		styled: paint("ctrl+x", ctx.theme.text, { bold: true }) + paint(" return to graph", ctx.theme.textMuted),
	};
	const compactHint = {
		plain: "ctrl+x graph",
		styled: paint("ctrl+x", ctx.theme.text, { bold: true }) + paint(" graph", ctx.theme.textMuted),
	};
	const trailingBorder = options.preserveTrailingBorder === true ? trailingWidgetBorderChar(line) : "";
	const suffixWidth = visibleWidth(trailingBorder);
	const requestedRightMargin = Math.max(0, Math.floor(options.rightMargin ?? 0));
	const minimumPrefixWidth = Math.max(0, Math.floor(options.minimumPrefixWidth ?? 0));
	const fullRequiredWidth = suffixWidth + requestedRightMargin + minimumPrefixWidth + visibleWidth(fullHint.plain);
	const hint = fullRequiredWidth <= width ? fullHint : compactHint;
	const hintWidth = visibleWidth(hint.plain);
	const rightMargin = Math.min(requestedRightMargin, Math.max(0, width - suffixWidth - hintWidth));
	const hintStart = Math.max(0, width - suffixWidth - rightMargin - hintWidth);
	const prefixWidth = Math.max(0, hintStart - 1);
	const prefix = truncateToWidth(line, prefixWidth, "", true);
	const gap = Math.max(0, hintStart - visibleWidth(prefix));
	return prefix + " ".repeat(gap) + hint.styled + " ".repeat(rightMargin) + trailingBorder;
}

export function banner(
	ctx: StageChatViewContext,
	kind: "warning" | "success" | "error" | "info",
	glyph: string,
	label: string,
	meta: string,
): Box {
	const t = ctx.theme;
	const fg = kind === "warning" ? t.warning : kind === "success" ? t.success : kind === "info" ? t.info : t.error;
	const bg = blendBg(t.bg, fg, 0.1);
	const head =
		paintOnFill(glyph, fg, { bold: true }) +
		"  " +
		paintOnFill(label, fg, { bold: true }) +
		"  " +
		paintOnFill(stripAnsi(meta), t.dim);
	const box = new Box(2, 0, bgFn(bg));
	box.addChild(new Text(head, 0, 0));
	return box;
}

export function bannerLines(
	ctx: StageChatViewContext,
	width: number,
	kind: "warning" | "success" | "error" | "info",
	glyph: string,
	label: string,
	meta: string,
): string[] {
	return banner(ctx, kind, glyph, label, meta).render(width);
}

export function editorRuleColor(
	ctx: StageChatViewContext,
	disabled: boolean,
	agentSession: AgentSession | undefined,
	state?: { isBashMode: boolean },
): string {
	if (disabled) return ctx.theme.borderDim;
	if (state?.isBashMode) return ctx.theme.warning;
	const level = agentSession?.state.thinkingLevel ?? "off";
	switch (level) {
		case "minimal":
			return ctx.theme.borderDim;
		case "low":
			return ctx.theme.info;
		case "medium":
			return ctx.theme.accent;
		case "high":
			return ctx.theme.mauve;
		case "xhigh":
			return ctx.theme.error;
		case "max":
			return ctx.theme.error;
		default:
			return ctx.theme.border;
	}
}
