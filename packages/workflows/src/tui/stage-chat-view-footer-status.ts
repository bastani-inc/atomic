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
import { STAGE_CHAT_MOUSE_SCROLL_TOGGLE_LABEL, type StageChatViewContext } from "./stage-chat-view-types.js";
import { truncateToWidth, visibleWidth } from "./text-helpers.js";

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
	const lastIndex = lines.length - 1;
	lines[lastIndex] = mergeOrchestratorReturnHintIntoLine(ctx, lines[lastIndex] ?? "", width);
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
	const copyModeState = ctx.mouseScrollCaptureEnabled ? "off" : "on";
	const fullHint = {
		plain: `ctrl+x return to graph · ${STAGE_CHAT_MOUSE_SCROLL_TOGGLE_LABEL} copy mode ${copyModeState}`,
		styled:
			paint("ctrl+x", ctx.theme.text, { bold: true }) +
			paint(" return to graph · ", ctx.theme.textMuted) +
			paint(STAGE_CHAT_MOUSE_SCROLL_TOGGLE_LABEL, ctx.theme.text, { bold: true }) +
			paint(` copy mode ${copyModeState}`, ctx.theme.textMuted),
	};
	const compactHint = {
		plain: `ctrl+x graph · ${STAGE_CHAT_MOUSE_SCROLL_TOGGLE_LABEL} ${copyModeState}`,
		styled:
			paint("ctrl+x", ctx.theme.text, { bold: true }) +
			paint(" graph · ", ctx.theme.textMuted) +
			paint(STAGE_CHAT_MOUSE_SCROLL_TOGGLE_LABEL, ctx.theme.text, { bold: true }) +
			paint(` ${copyModeState}`, ctx.theme.textMuted),
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
