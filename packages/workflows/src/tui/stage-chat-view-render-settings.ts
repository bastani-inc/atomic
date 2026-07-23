import type { ChatMessageRenderOptions, ChatSessionHostStyle } from "@bastani/atomic";
import { editorRuleColor } from "./stage-chat-view-footer-status.js";
import { blankLine, cursorBlock, paint, workingIndicatorPalette } from "./stage-chat-view-render-helpers.js";
import type { StageChatViewContext, StageChatViewOpts } from "./stage-chat-view-types.js";
import { hexToAnsi, RESET } from "./color-utils.js";

type StageChatRenderSettings = Partial<Omit<ChatMessageRenderOptions, "ui" | "cwd">>;

type MessageRendererHost = {
  extensionRunner?: {
    getMessageRenderer?: (customType: string) => ReturnType<NonNullable<StageChatRenderSettings["getCustomMessageRenderer"]>>;
  };
};

export function stageChatRenderSettings(
  ctx: StageChatViewContext,
  opts: StageChatViewOpts,
): StageChatRenderSettings | undefined {
  const inherited = opts.getChatRenderSettings?.();
  const stageSession = ctx.handle?.isDisposed === true ? undefined : ctx.handle?.agentSession;
  if (!stageSession) return inherited;
  const rendererHost = stageSession as MessageRendererHost;
  return {
    ...inherited,
    getToolDefinition: (toolName) =>
      stageSession.getToolDefinition(toolName) ?? inherited?.getToolDefinition?.(toolName),
    getCustomMessageRenderer: (customType) =>
      rendererHost.extensionRunner?.getMessageRenderer?.(customType) ?? inherited?.getCustomMessageRenderer?.(customType),
  };
}

export function chatHostStyle(ctx: StageChatViewContext): ChatSessionHostStyle {
  return {
    dim: (text) => paint(text, ctx.theme.dim),
    text: (text) => paint(text, ctx.theme.text),
    textMuted: (text) => paint(text, ctx.theme.textMuted),
    accent: (text) => paint(text, ctx.theme.accent),
    accentBold: (text) => paint(text, ctx.theme.accent, { bold: true }),
    workingIndicatorPalette: ctx.piTheme === undefined ? () => workingIndicatorPalette(ctx.theme) : undefined,
    workingIndicatorUseGlobalTheme: ctx.piTheme !== undefined,
    rule: (hex, text) => hexToAnsi(hex) + text + RESET,
    cursor: () => cursorBlock(),
    blank: (width) => blankLine(width),
    editorRuleColor: (disabled, agentSession, state) =>
      editorRuleColor(ctx, disabled, agentSession, state),
  };
}
