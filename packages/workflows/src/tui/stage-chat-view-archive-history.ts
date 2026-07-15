import { Box, Text } from "@earendil-works/pi-tui";
import type { PendingPrompt, StageSnapshot } from "../shared/store-types.js";
import { renderPromptCard } from "./prompt-card.js";
import { renderRoundedBoxLines } from "./chat-surface.js";
import { bannerLines, embedOrchestratorReturnHintInWidget } from "./stage-chat-view-footer-status.js";
import {
  blankLine,
  paint,
  renderHintsForPrompt,
  setEditorBorderColor,
  setEditorFocused,
} from "./stage-chat-view-render-helpers.js";
import type { StageChatViewContext } from "./stage-chat-view-types.js";
import { hexToAnsi, RESET } from "./color-utils.js";

function postMortemUnavailableMessage(reason: StageChatViewContext["postMortemUnavailableReason"]): string | undefined {
  switch (reason) {
    case "no_adapter":
      return "Post-mortem chat is unavailable because no agent session adapter is configured.";
    case "not_terminal":
      return "Post-mortem chat is available only after the stage completes.";
    case "no_session":
      return "No retained agent session is available for this stage.";
    case "invalid_session":
      return "The retained session is missing, unreadable, or invalid. Check that the session file still exists and is readable.";
    case undefined:
      return undefined;
  }
}

export function renderReadOnlyArchiveBody(
  ctx: StageChatViewContext,
  width: number,
  budget: number,
  stage: StageSnapshot | undefined,
): string[] {
  if (stage?.promptFootprint) {
    return renderReadOnlyPromptArchiveBody(ctx, width, budget, stage);
  }

  const t = ctx.theme;
  const unavailableMessage = postMortemUnavailableMessage(ctx.postMortemUnavailableReason);
  const callout: string[] = [];
  callout.push(blankLine(width));
  callout.push(
    ...bannerLines(
      ctx,
      width,
      unavailableMessage === undefined ? "info" : "warning",
      unavailableMessage === undefined ? "◌" : "!",
      unavailableMessage === undefined ? "READ-ONLY SESSION" : "SESSION UNAVAILABLE",
      unavailableMessage === undefined
        ? stage?.sessionFile ? "archived transcript" : "no live chat session"
        : "post-mortem chat cannot be reopened",
    ),
  );
  callout.push(
    ...new Text(
      paint(
        unavailableMessage ?? "This node is no longer attached to a live chat session.",
        t.textMuted,
      ),
      2,
      0,
    ).render(width),
  );
  const transcriptBudget = Math.max(0, budget - callout.length);
  const lines = transcriptBudget > 0 ? ctx.chatHost.renderBody(width, transcriptBudget) : [];
  lines.push(...callout);
  while (lines.length < budget) lines.push(blankLine(width));
  if (lines.length > budget) lines.length = budget;
  return lines;
}

function renderReadOnlyPromptArchiveBody(
  ctx: StageChatViewContext,
  width: number,
  budget: number,
  stage: StageSnapshot,
): string[] {
  const t = ctx.theme;
  const prompt = stage.promptFootprint;
  if (!prompt) return fitBodyLines(width, budget, []);

  const innerWidth = Math.max(2, width - 2);
  const bodyLines: string[] = [];
  const messageBox = new Box(2, 1);
  messageBox.addChild(new Text(paint(prompt.message, t.text), 0, 0));
  bodyLines.push(...messageBox.render(innerWidth));
  bodyLines.push(
    ...new Text(
      paint("prompt type", t.textMuted, { bold: true }) + paint(`  ${prompt.kind}`, t.text),
      2,
      0,
    ).render(innerWidth),
  );

  if (prompt.kind === "select" && prompt.choices && prompt.choices.length > 0) {
    bodyLines.push(...new Text(paint("choices", t.textMuted, { bold: true }), 2, 0).render(innerWidth));
    for (const choice of prompt.choices) {
      bodyLines.push(...new Text(paint("• ", t.dim) + paint(choice, t.text), 4, 0).render(innerWidth));
    }
  } else if (prompt.kind === "confirm") {
    bodyLines.push(
      ...new Text(
        paint("choices", t.textMuted, { bold: true }) + paint("  yes / no", t.text),
        2,
        0,
      ).render(innerWidth),
    );
  }

  if ((prompt.kind === "input" || prompt.kind === "editor") && prompt.initial && prompt.initial.length > 0) {
    bodyLines.push(...new Text(paint("initial value shown", t.textMuted, { bold: true }), 2, 0).render(innerWidth));
    bodyLines.push(...new Text(paint(prompt.initial, t.dim), 4, 0).render(innerWidth));
  }

  const answer = readOnlyPromptAnswer(ctx, stage, prompt);
  bodyLines.push("");
  bodyLines.push(...new Text(paint("your response", t.textMuted, { bold: true }), 2, 0).render(innerWidth));
  bodyLines.push(...new Text(paint(answer, answer.startsWith("(") ? t.dim : t.text), 4, 0).render(innerWidth));
  bodyLines.push("");

  const title = stage.status === "skipped" ? "QUESTION SKIPPED" : "QUESTION ASKED";
  const cardLines = renderRoundedBoxLines({
    title,
    bodyLines,
    width,
    theme: t,
    accent: t.border,
  });
  return fitPromptBodyLines(ctx, cardLines, width, budget);
}

function readOnlyPromptAnswer(
  ctx: StageChatViewContext,
  stage: StageSnapshot,
  prompt: PendingPrompt,
): string {
  const answer = ctx.store.getStagePromptAnswer(ctx.runId, stage.id);
  if (answer && answer.promptId === prompt.id) {
    return formatReadOnlyPromptAnswer(answer.value, prompt.kind);
  }
  switch (stage.promptAnswerState) {
    case "ambiguous":
      return "(response replay is ambiguous)";
    case "unavailable":
      return "(response unavailable)";
    case "available":
      return "(response no longer in live memory)";
    default:
      return "(no response saved)";
  }
}

function formatReadOnlyPromptAnswer(value: unknown, kind: PendingPrompt["kind"]): string {
  if (kind === "confirm") return value === true ? "yes" : "no";
  if (typeof value === "string") return value.length > 0 ? value : "(empty response)";
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  try {
    const encoded = JSON.stringify(value);
    return encoded ?? String(value);
  } catch {
    return String(value);
  }
}

export function renderPausedBody(
  ctx: StageChatViewContext,
  width: number,
  budget: number,
): string[] {
  const t = ctx.theme;
  const callout: string[] = [];
  callout.push(blankLine(width));
  callout.push(
    ...bannerLines(ctx, width, "warning", "❚❚", "PAUSED", "enter resumes · ctrl+d graph"),
  );
  callout.push(
    ...new Text(
      paint(
        "This workflow stage is paused. Type a message below and press Enter to resume.",
        t.textMuted,
      ),
      2,
      0,
    ).render(width),
  );

  const calloutRows = Math.min(callout.length, Math.max(0, budget - 1));
  const transcriptBudget = Math.max(1, budget - calloutRows);
  const lines = ctx.chatHost.renderBody(width, transcriptBudget);
  lines.push(...callout.slice(0, calloutRows));
  while (lines.length < budget) lines.push(blankLine(width));
  if (lines.length > budget) lines.length = budget;
  return lines;
}

export function renderBlockedBody(
  ctx: StageChatViewContext,
  width: number,
  budget: number,
  stage: StageSnapshot | undefined,
): string[] {
  const t = ctx.theme;
  const upstream = stage?.blockedByStageId ?? "upstream stage";
  const lines: string[] = [];
  lines.push(...bannerLines(ctx, width, "warning", "↑", "BLOCKED", `waiting on ${upstream}`));
  lines.push(blankLine(width));
  lines.push(
    ...new Text(
      paint("This stage is waiting for the upstream stage to resume.", t.textMuted),
      2,
      0,
    ).render(width),
  );
  lines.push(
    ...new Text(
      paint("ctrl+d", t.accent, { bold: true }) + paint(" return to graph", t.textMuted),
      2,
      0,
    ).render(width),
  );
  while (lines.length < budget) lines.push(blankLine(width));
  if (lines.length > budget) lines.length = budget;
  return lines;
}

export function renderPromptBody(
  ctx: StageChatViewContext,
  width: number,
  budget: number,
): string[] {
  const primitiveLines = renderPrimitivePromptBody(ctx, width);
  if (primitiveLines) {
    return fitPromptBodyLines(
      ctx,
      embedOrchestratorReturnHintInWidget(ctx, primitiveLines, width),
      width,
      budget,
    );
  }

  const state = ctx.promptState;
  const lines = state
    ? renderPromptCard({
      state,
      theme: ctx.theme,
      width,
      cursorOn: ctx.focused,
    })
    : [];
  return fitPromptBodyLines(
    ctx,
    embedOrchestratorReturnHintInWidget(ctx, lines, width),
    width,
    budget,
  );
}

function renderPrimitivePromptBody(
  ctx: StageChatViewContext,
  width: number,
): string[] | null {
  const state = ctx.promptState;
  const editor = ctx.promptEditor;
  if (!state || !editor) return null;
  setEditorFocused(editor, ctx.focused);
  setEditorBorderColor(editor, (text) => hexToAnsi(ctx.theme.accent) + text + RESET);

  const innerWidth = Math.max(2, width - 2);
  const bodyLines: string[] = [];
  const messageBox = new Box(2, 1);
  messageBox.addChild(new Text(paint(state.prompt.message, ctx.theme.text), 0, 0));
  bodyLines.push(...messageBox.render(innerWidth));
  bodyLines.push(
    ...new Text(paint("response", ctx.theme.textMuted, { bold: true }), 2, 0).render(innerWidth),
  );
  for (const line of editor.render(Math.max(20, innerWidth - 4))) {
    bodyLines.push("  " + line);
  }
  bodyLines.push("");
  bodyLines.push(...new Text(renderHintsForPrompt(state.prompt.kind, ctx.theme), 2, 0).render(innerWidth));

  return renderRoundedBoxLines({
    title: "AWAITING INPUT",
    bodyLines,
    width,
    theme: ctx.theme,
    accent: ctx.theme.border,
  });
}

export function fitPromptBodyLines(
  ctx: StageChatViewContext,
  lines: readonly string[],
  width: number,
  budget: number,
): string[] {
  ctx.promptMaxScroll = Math.max(0, lines.length - budget);
  ctx.promptScrollOffset = Math.max(0, Math.min(ctx.promptScrollOffset, ctx.promptMaxScroll));
  const framed = lines.slice(ctx.promptScrollOffset, ctx.promptScrollOffset + budget);
  while (framed.length < budget) framed.push(blankLine(width));
  return framed;
}

function fitBodyLines(width: number, budget: number, lines: readonly string[]): string[] {
  const framed = lines.slice(0, budget);
  while (framed.length < budget) framed.push(blankLine(width));
  return framed;
}
