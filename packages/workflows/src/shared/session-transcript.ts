/**
 * Shared retained-session transcript validation.
 *
 * A stage snapshot's `sessionFile` is only reopenable as a post-mortem chat
 * when the referenced path is an existing, readable, regular file whose JSONL
 * contents parse into a genuine Atomic session with at least one usable
 * context-bearing message. This guards the completed-workflow catalog and the
 * post-mortem stage-chat resolver against blank / missing / truncated
 * transcripts, and prevents `SessionManager.open()` from turning a missing path
 * into an empty session.
 *
 * cross-ref:
 *   - src/durable/completed-catalog.ts (catalog eligibility)
 *   - src/runs/foreground/postmortem-stage-chat.ts (revival eligibility)
 */
import { readFileSync, statSync } from "node:fs";

interface SessionTranscriptEntry {
  readonly type?: string;
  readonly id?: string;
  readonly timestamp?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: string | object;
  };
}

/**
 * True when `path` points at a readable regular file containing a parseable
 * Atomic session header plus at least one usable context message.
 */
export function isReopenableSessionTranscript(path: string): boolean {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size === 0) return false;
    const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0);
    if (lines.length < 2) return false;
    const entries: SessionTranscriptEntry[] = [];
    for (const line of lines) {
      const parsed = JSON.parse(line) as object;
      if (typeof parsed !== "object" || parsed === null) return false;
      entries.push(parsed as SessionTranscriptEntry);
    }
    const header = entries[0];
    return header?.type === "session" && typeof header.id === "string" && entries.some(isUsableContextMessage);
  } catch {
    return false;
  }
}

function isUsableContextMessage(entry: SessionTranscriptEntry): boolean {
  return entry.type === "message"
    && typeof entry.id === "string"
    && typeof entry.timestamp === "string"
    && typeof entry.message?.role === "string"
    && hasUsableMessageContent(entry.message.content);
}

function hasUsableMessageContent(content: string | object | undefined): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  return Array.isArray(content) && content.some(hasUsableContentBlock);
}

function hasUsableContentBlock(block: object): boolean {
  if (typeof block !== "object" || block === null) return false;
  const contentBlock = block as {
    readonly text?: string;
    readonly thinking?: string;
    readonly data?: string;
    readonly name?: string;
  };
  return [contentBlock.text, contentBlock.thinking, contentBlock.data, contentBlock.name]
    .some((value) => typeof value === "string" && value.trim().length > 0);
}
