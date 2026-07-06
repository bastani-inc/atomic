import type { ChatMessageRenderOptions } from "@bastani/atomic";
import type { StageChatViewContext, StageChatViewOpts } from "./stage-chat-view-types.js";

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
