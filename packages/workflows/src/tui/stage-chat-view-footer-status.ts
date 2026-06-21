import type { AgentSession } from "@bastani/atomic";
import { Box, Text } from "@earendil-works/pi-tui";
import { RESET, hexToAnsi } from "./color-utils.js";
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
import type { StageSnapshot } from "../shared/store-types.js";
import { truncateToWidth, visibleWidth } from "./text-helpers.js";

export function renderHeader(
  ctx: StageChatViewContext,
  width: number,
  stage: StageSnapshot | undefined,
): string[] {
  const t = ctx.theme;
  const stageName = stage?.name ?? "stage";
  const left =
    paint("   ", t.mauve, { bold: true }) +
    paint("STAGE", t.textMuted, { bold: true }) +
    "  " +
    paint(ctx.workflowName, t.textMuted) +
    paint(" / ", t.dim) +
    paint(stageName, t.text, { bold: true });
  const meta = headerMeta(ctx, stage);
  const right = meta ? paint(meta, t.dim) + " " : "";
  const leftW =
    visibleWidth(ctx.workflowName) +
    visibleWidth(stageName) +
    visibleWidth("  STAGE   /  ") +
    1;
  const rightW = visibleWidth(meta) + (meta ? 1 : 0);
  const gap = Math.max(1, width - leftW - rightW);
  return [left + " ".repeat(gap) + right];
}

function headerMeta(
  ctx: StageChatViewContext,
  stage: StageSnapshot | undefined,
): string {
  const parts: string[] = [];
  const sid = ctx.handle?.sessionId ?? stage?.sessionId;
  if (sid) parts.push(`session ${shortenId(sid)}`);
  return parts.join(" · ");
}

function shortenId(id: string): string {
  return id.length > 10 ? id.slice(0, 8) : id;
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
  lines[lastIndex] = mergeOrchestratorReturnHintIntoLine(
    ctx,
    lines[lastIndex] ?? "",
    width,
  );
  return lines;
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
  lines[targetIndex] = mergeOrchestratorReturnHintIntoLine(
    ctx,
    lines[targetIndex] ?? "",
    width,
    { preserveTrailingBorder: true, rightMargin: 2 },
  );
  return lines;
}

function mergeOrchestratorReturnHintIntoLine(
  ctx: StageChatViewContext,
  line: string,
  width: number,
  options: { preserveTrailingBorder?: boolean; rightMargin?: number } = {},
): string {
  const plain = "ctrl+d returns to orchestrator panel";
  const styled =
    paint("ctrl+d", ctx.theme.text, { bold: true }) +
    paint(" returns to orchestrator panel", ctx.theme.textMuted);
  const trailingBorder = options.preserveTrailingBorder === true
    ? trailingWidgetBorderChar(line)
    : "";
  const suffixWidth = visibleWidth(trailingBorder);
  const hintWidth = visibleWidth(plain);
  const requestedRightMargin = Math.max(0, Math.floor(options.rightMargin ?? 0));
  const rightMargin = Math.min(
    requestedRightMargin,
    Math.max(0, width - suffixWidth - hintWidth),
  );
  const hintStart = Math.max(0, width - suffixWidth - rightMargin - hintWidth);
  const prefix = truncateToWidth(line, hintStart, "", true);
  const gap = Math.max(0, hintStart - visibleWidth(prefix));
  return prefix + " ".repeat(gap) + styled + " ".repeat(rightMargin) + trailingBorder;
}

export function banner(
  ctx: StageChatViewContext,
  kind: "warning" | "success" | "error" | "info",
  glyph: string,
  label: string,
  meta: string,
): Box {
  const t = ctx.theme;
  const fg =
    kind === "warning"
      ? t.warning
      : kind === "success"
        ? t.success
        : kind === "info"
          ? t.info
          : t.error;
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
    case "off":
    default:
      return ctx.theme.border;
  }
}
