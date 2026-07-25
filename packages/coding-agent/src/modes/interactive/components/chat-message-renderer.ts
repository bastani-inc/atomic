import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container, Text, type Component, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { MessageRenderer, ToolDefinition } from "../../../core/extensions/types.ts";
import { isVerbatimCompactionMessage, type BashExecutionMessage, type BranchSummaryMessage, type CustomMessage } from "../../../core/messages.ts";
import { parseSkillBlock } from "../../../core/agent-session.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { AssistantMessageComponent } from "./assistant-message.ts";
import { BashExecutionComponent } from "./bash-execution.ts";
import { BranchSummaryMessageComponent } from "./branch-summary-message.ts";
import { compactionBoundaryFromMessage } from "./compaction-boundary-message.ts";
import { CustomMessageComponent } from "./custom-message.ts";
import { SkillInvocationMessageComponent } from "./skill-invocation-message.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";
import { UserMessageComponent } from "./user-message.ts";
import { extractMessageText } from "./chat-session-host-utils.ts";
export type ChatMessageEntry =
  | { role: "assistant"; kind: "assistant"; message: AssistantMessage }
  | { role: "tool"; kind: "tool"; toolName: string; toolCallId: string; args: unknown; result?: ToolResultMessage; isPartial?: boolean }
  | { role: "tool"; kind: "bashExecution"; message: BashExecutionMessage; isPartial?: boolean }
  | { role: "user"; kind: "user"; text: string }
  | { role: "custom"; kind: "custom"; message: CustomMessage<unknown> }
  | { role: "summary"; kind: "branchSummary"; message: BranchSummaryMessage }
  | { role: "system"; kind: "system"; text: string };
export interface ChatMessageRenderOptions {
  ui: Pick<TUI, "requestRender">; cwd: string; markdownTheme?: MarkdownTheme;
  hideThinkingBlock?: boolean; hiddenThinkingLabel?: string; toolOutputExpanded?: boolean;
  showImages?: boolean; imageWidthCells?: number; outputPad?: number; getToolDefinition?: (toolName: string) => ToolDefinition<TSchema, unknown> | undefined;
  getCustomMessageRenderer?: (customType: string) => MessageRenderer | undefined;
  createToolComponent?: (entry: Extract<ChatMessageEntry, { kind: "tool" }>) => Component;
  createCustomMessageComponent?: (message: CustomMessage<unknown>) => Component;
}
export function chatEntriesFromAgentMessages(
  messages: readonly AgentMessage[],
): ChatMessageEntry[] {
  const entries: ChatMessageEntry[] = [];
  const pendingTools = new Map<string, Extract<ChatMessageEntry, { kind: "tool" }>>();
  for (const message of messages) {
    if (isLegacyCompactionSummaryMessage(message)) continue;
    switch (message.role) {
      case "assistant": {
        entries.push({ role: "assistant", kind: "assistant", message });
        for (const content of message.content) {
          if (content.type !== "toolCall") continue;
          const toolEntry: ChatMessageEntry = {
            role: "tool",
            kind: "tool",
            toolName: content.name,
            toolCallId: content.id,
            args: content.arguments,
            isPartial: true,
          };
          entries.push(toolEntry);
          pendingTools.set(content.id, toolEntry);
        }
        if (message.stopReason === "aborted" || message.stopReason === "error") {
          const errorText = message.stopReason === "aborted"
            ? message.errorMessage || "Operation aborted"
            : message.errorMessage || "Unknown error";
          for (const toolEntry of pendingTools.values()) {
            toolEntry.result = {
              role: "toolResult",
              toolCallId: toolEntry.toolCallId,
              toolName: toolEntry.toolName,
              content: [{ type: "text", text: errorText }],
              isError: true,
              timestamp: message.timestamp,
            };
            toolEntry.isPartial = false;
          }
          pendingTools.clear();
        }
        break;
      }
      case "toolResult": {
        const toolEntry = pendingTools.get(message.toolCallId);
        if (toolEntry) {
          toolEntry.result = message;
          toolEntry.isPartial = false;
          pendingTools.delete(message.toolCallId);
        } else {
          entries.push({
            role: "tool",
            kind: "tool",
            toolName: message.toolName,
            toolCallId: message.toolCallId,
            args: {},
            result: message,
            isPartial: false,
          });
        }
        break;
      }
      case "user": {
        const text = getMessageText(message);
        if (text) entries.push({ role: "user", kind: "user", text });
        break;
      }
      case "bashExecution":
        entries.push({ role: "tool", kind: "bashExecution", message });
        break;
      case "custom":
        if (message.display) entries.push({ role: "custom", kind: "custom", message });
        break;
      case "branchSummary":
        entries.push({ role: "summary", kind: "branchSummary", message });
        break;
      default: {
        const role = (message as { role: string }).role;
        entries.push({ role: "system", kind: "system", text: role });
        break;
      }
    }
  }
  return entries;
}
function isLegacyCompactionSummaryMessage(message: AgentMessage): boolean {
  return message.role === "compaction" + "Summary";
}
export function renderChatMessageEntry(
  entry: ChatMessageEntry,
  options: ChatMessageRenderOptions,
): Component {
  const messageEntry = entry as ChatMessageEntry;
  const markdownTheme = options.markdownTheme ?? getMarkdownTheme();
  switch (messageEntry.kind) {
    case "assistant":
      return new AssistantMessageComponent(
        messageEntry.message,
        options.hideThinkingBlock ?? false,
        markdownTheme,
        options.hiddenThinkingLabel ?? "Thinking...",
        options.outputPad ?? 1,
      );
    case "tool": {
      if (options.createToolComponent) return options.createToolComponent(messageEntry);
      const component = new ToolExecutionComponent(
        messageEntry.toolName,
        messageEntry.toolCallId,
        messageEntry.args,
        {
          showImages: options.showImages ?? true,
          imageWidthCells: options.imageWidthCells,
        },
        options.getToolDefinition?.(messageEntry.toolName),
        options.ui as TUI,
        options.cwd,
      );
      component.setExpanded(options.toolOutputExpanded ?? false);
      if (messageEntry.result) component.updateResult(messageEntry.result, messageEntry.isPartial ?? false);
      return component;
    }
    case "bashExecution": {
      const component = new BashExecutionComponent(
        messageEntry.message.command,
        options.ui as TUI,
        messageEntry.message.excludeFromContext,
      );
      if (messageEntry.message.output) component.appendOutput(messageEntry.message.output);
      if (messageEntry.isPartial !== true) {
        component.setComplete(
          messageEntry.message.exitCode,
          messageEntry.message.cancelled,
          messageEntry.message.truncated
            ? ({ truncated: true } as Parameters<BashExecutionComponent["setComplete"]>[2])
            : undefined,
          messageEntry.message.fullOutputPath,
        );
      }
      return component;
    }
    case "user":
      return userMessageComponent(messageEntry.text, markdownTheme, options.toolOutputExpanded ?? false, options.outputPad ?? 1);
    case "custom": {
      if (isVerbatimCompactionMessage(messageEntry.message)) {
        return compactionBoundaryFromMessage(messageEntry.message, options.toolOutputExpanded ?? false);
      }
      if (options.createCustomMessageComponent) return options.createCustomMessageComponent(messageEntry.message);
      const component = new CustomMessageComponent(messageEntry.message, options.getCustomMessageRenderer?.(messageEntry.message.customType), markdownTheme);
      component.setExpanded(options.toolOutputExpanded ?? false);
      return component;
    }
    case "branchSummary": {
      const component = new BranchSummaryMessageComponent(messageEntry.message, markdownTheme);
      component.setExpanded(options.toolOutputExpanded ?? false);
      return component;
    }
    case "system":
      return new Text(theme.fg("dim", messageEntry.text), 1, 0);
  }
}
function userMessageComponent(text: string, markdownTheme: MarkdownTheme, expanded: boolean, outputPad = 1): Component {
  const skillBlock = parseSkillBlock(text);
  if (!skillBlock) return new UserMessageComponent(text, markdownTheme, outputPad);
  const container = new Container();
  const skillComponent = new SkillInvocationMessageComponent(skillBlock, markdownTheme);
  skillComponent.setExpanded(expanded);
  container.addChild(skillComponent);
  if (skillBlock.userMessage) {
    container.addChild(new UserMessageComponent(skillBlock.userMessage, markdownTheme, outputPad));
  }
  return container;
}
function getMessageText(message: Extract<AgentMessage, { role: "user" }>): string {
  return extractMessageText(message.content).trim();
}
