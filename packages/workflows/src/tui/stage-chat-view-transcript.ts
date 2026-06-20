import type { ChatMessageEntry } from "@bastani/atomic";
import type { Component } from "@earendil-works/pi-tui";
import type { StageNotice } from "../shared/store-types.js";
import type { GraphTheme } from "./graph-theme.js";
import type {
  NoticeEntry,
  TranscriptDebugEntry,
  TranscriptEntry,
} from "./stage-chat-view-types.js";
import {
  renderWorkflowNoticeCard,
  type WorkflowNoticeTone,
} from "./workflow-notice-card.js";

export function noticeSummary(n: StageNotice): string {
  const base = `~ ${n.kind} → ${n.to}`;
  return n.from ? `${base} (was ${n.from})` : base;
}

export function noticeRow(entry: NoticeEntry, theme: GraphTheme): Component {
  return {
    render(width: number): string[] {
      return renderWorkflowNoticeCard({
        ...stageNoticeCard(entry),
        fallbackText: entry.text,
        width,
        theme,
      });
    },
    invalidate() {
      /* notice entries are immutable */
    },
  };
}

export function transcriptDebugEntries(
  entry: TranscriptEntry,
): TranscriptDebugEntry[] {
  if (isChatMessageEntry(entry) && entry.kind === "assistant") {
    const entries: TranscriptDebugEntry[] = [];
    const thinking = extractThinkingText(entry.message.content);
    const text = extractMessageText(entry.message.content);
    if (thinking) {
      entries.push({
        role: "thinking",
        text: thinking,
        toolCallId: "",
        state: "",
        output: "",
      });
    }
    if (text || entries.length === 0) {
      entries.push({ ...entry, text, toolCallId: "", state: "", output: "" });
    }
    return entries;
  }
  return [
    {
      ...entry,
      role: entry.role,
      text: transcriptDebugText(entry),
      toolCallId: transcriptDebugToolCallId(entry),
      state: transcriptDebugToolState(entry),
      output: transcriptDebugToolOutput(entry),
    },
  ];
}

function transcriptDebugText(entry: TranscriptEntry): string {
  if ("text" in entry && typeof entry.text === "string") return entry.text;
  if (isChatMessageEntry(entry)) {
    switch (entry.kind) {
      case "assistant":
        return extractMessageText(entry.message.content);
      case "tool":
        return entry.result
          ? extractToolResultText(entry.result)
          : `${entry.toolName} ${typeof entry.args === "string" ? entry.args : JSON.stringify(entry.args ?? {})}`;
      case "bashExecution":
        return entry.message.output || entry.message.command;
      case "user":
      case "system":
        return entry.text;
      case "custom":
        return extractMessageText(entry.message.content);
      case "branchSummary":
        return entry.message.summary;
    }
  }
  return "";
}

function transcriptDebugToolCallId(entry: TranscriptEntry): string {
  if (isChatMessageEntry(entry) && entry.kind === "tool") return entry.toolCallId;
  if ("toolCallId" in entry && typeof entry.toolCallId === "string") {
    return entry.toolCallId;
  }
  return "";
}

function transcriptDebugToolState(entry: TranscriptEntry): string {
  if (isChatMessageEntry(entry) && entry.kind === "tool") {
    if (entry.result?.isError) return "error";
    return entry.isPartial === false ? "success" : "pending";
  }
  if ("state" in entry && typeof entry.state === "string") return entry.state;
  return "";
}

function transcriptDebugToolOutput(entry: TranscriptEntry): string {
  if (isChatMessageEntry(entry) && entry.kind === "tool") {
    return entry.result ? extractToolResultText(entry.result) : "";
  }
  if ("output" in entry && typeof entry.output === "string") return entry.output;
  return "";
}

function isChatMessageEntry(entry: TranscriptEntry): entry is ChatMessageEntry {
  return "kind" in entry && entry.role !== "notice";
}

function extractThinkingText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item == null || typeof item !== "object") continue;
    const thinking = (item as { type?: unknown; thinking?: unknown }).thinking;
    if (
      (item as { type?: unknown }).type === "thinking" &&
      typeof thinking === "string"
    ) {
      parts.push(thinking);
    }
  }
  return parts.join("\n\n");
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item == null) continue;
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const obj = item as { type?: unknown; text?: unknown };
    if (typeof obj.text === "string") parts.push(obj.text);
    else if (obj.type === "text" && typeof obj.text === "string") {
      parts.push(obj.text);
    }
  }
  return parts.join("");
}

function extractToolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result == null || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  return extractMessageText(content);
}

function stageNoticeCard(entry: NoticeEntry): {
  title: string;
  glyph: string;
  headline: string;
  tone: WorkflowNoticeTone;
  fields: Array<{
    label: string;
    value: string | undefined;
    tone?: WorkflowNoticeTone | "text" | "muted";
  }>;
} {
  switch (entry.kind) {
    case "abort":
      return {
        title: "STAGE ABORTED",
        glyph: "✗",
        headline: "Stage received an abort notice",
        tone: "error",
        fields: stageNoticeFields(entry, "error"),
      };
    case "compaction":
      return {
        title: "STAGE COMPACTION",
        glyph: "✓",
        headline: "Stage context was compacted",
        tone: "success",
        fields: stageNoticeFields(entry, "muted"),
      };
    case "model":
      return {
        title: "STAGE MODEL",
        glyph: "→",
        headline: "Stage model changed",
        tone: "info",
        fields: stageNoticeFields(entry),
      };
    case "thinking":
      return {
        title: "STAGE THINKING",
        glyph: "→",
        headline: "Stage thinking level changed",
        tone: "mauve",
        fields: stageNoticeFields(entry),
      };
    case "tree":
      return {
        title: "STAGE TREE",
        glyph: "◆",
        headline: "Stage branch tree changed",
        tone: "info",
        fields: stageNoticeFields(entry, "muted"),
      };
    case "mcp":
    default:
      return {
        title: "STAGE NOTICE",
        glyph: "◆",
        headline: "Workflow stage notice",
        tone: "info",
        fields: stageNoticeFields(entry, "muted"),
      };
  }
}

function stageNoticeFields(
  entry: NoticeEntry,
  valueTone: WorkflowNoticeTone | "text" | "muted" = "text",
): Array<{
  label: string;
  value: string | undefined;
  tone?: WorkflowNoticeTone | "text" | "muted";
}> {
  return [
    { label: "kind", value: entry.kind, tone: "muted" },
    { label: "value", value: entry.value, tone: valueTone },
    { label: "from", value: entry.from, tone: "muted" },
    { label: "meta", value: entry.meta, tone: "muted" },
  ];
}
