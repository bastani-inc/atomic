import type { StageSnapshot, StageStatus, ToolEvent } from "../shared/store-types.js";
import type { WorkflowToolResult } from "./render-result.js";
import type { WorkflowToolArgs } from "./public-types.js";

export type WorkflowStageSummary = {
  id: string;
  name: string;
  status: StageStatus;
  sessionId?: string;
  sessionFile?: string;
  transcriptPath?: string;
  error?: string;
  skippedReason?: string;
  awaitingInputSince?: number;
  pendingPrompt?: StageSnapshot["pendingPrompt"];
  inputRequest?: StageSnapshot["inputRequest"];
  promptFootprint?: StageSnapshot["promptFootprint"];
};

export type WorkflowTranscriptEntry = {
  role: string;
  text?: string;
  toolName?: string;
  output?: string;
  timestamp?: number;
};

type MessageContentBlock = { readonly type?: string; readonly text?: string };

export type MessageLike = {
  readonly role?: string;
  readonly content?: string | readonly MessageContentBlock[];
  readonly name?: string;
  readonly toolName?: string;
  readonly timestamp?: number;
  readonly createdAt?: number;
};

export function cloneStage(stage: StageSnapshot): StageSnapshot & { transcriptPath?: string } {
  const cloned = structuredClone(stage) as StageSnapshot & { transcriptPath?: string };
  if (cloned.sessionFile !== undefined) cloned.transcriptPath = cloned.sessionFile;
  return cloned;
}

export function summarizeStage(stage: StageSnapshot): WorkflowStageSummary {
  return {
    id: stage.id,
    name: stage.name,
    status: stage.status,
    sessionId: stage.sessionId,
    sessionFile: stage.sessionFile,
    transcriptPath: stage.sessionFile,
    error: stage.error,
    skippedReason: stage.skippedReason,
    awaitingInputSince: stage.awaitingInputSince,
    pendingPrompt: stage.pendingPrompt === undefined
      ? undefined
      : structuredClone(stage.pendingPrompt),
    inputRequest: stage.inputRequest === undefined
      ? undefined
      : structuredClone(stage.inputRequest),
    promptFootprint: stage.promptFootprint === undefined
      ? undefined
      : structuredClone(stage.promptFootprint),
  };
}

const DEFAULT_TRANSCRIPT_LIMIT = 5;

type TranscriptEntrySelection = {
  entries: WorkflowTranscriptEntry[];
  truncated: boolean;
  entryCount: number;
  entryLimit?: number;
};

type WorkflowTranscriptResult = Extract<WorkflowToolResult, { action: "transcript" }>;

function isTranscriptPreviewExplicit(args: WorkflowToolArgs): boolean {
  return args.tail !== undefined || args.limit !== undefined;
}

export function shouldIncludeSnapshotToolOutput(args: WorkflowToolArgs, sessionFile?: string): boolean {
  return args.includeToolOutput === true && (
    isTranscriptPreviewExplicit(args) || sessionFile === undefined
  );
}

function requestedTranscriptEntryLimit(args: WorkflowToolArgs): number {
  const raw = args.tail ?? args.limit;
  if (raw === undefined) return DEFAULT_TRANSCRIPT_LIMIT;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

function selectTranscriptEntries(
  entries: readonly WorkflowTranscriptEntry[],
  args: WorkflowToolArgs,
): TranscriptEntrySelection {
  const count = requestedTranscriptEntryLimit(args);
  const entryCount = entries.length;
  if (count === 0) return { entries: [], truncated: false, entryCount, entryLimit: count };
  if (entries.length <= count) {
    return { entries: [...entries], truncated: false, entryCount, entryLimit: count };
  }
  return {
    entries: entries.slice(entries.length - count),
    truncated: true,
    entryCount,
    entryLimit: count,
  };
}

function transcriptLazyReadPrompt(path: string): string {
  return `Transcript not inlined to protect context. Read it lazily from ${path} with your file read tools (read small ranges; rg/grep for targeted lookups).`;
}

function transcriptFallbackNote(limit: number): string {
  return `No transcript file path is available for this stage; falling back to a bounded inline preview of up to ${limit} recent ${limit === 1 ? "entry" : "entries"}.`;
}

export function shapeTranscriptResult(input: {
  runId: string;
  stageId: string;
  source: "live" | "snapshot";
  entryCount: number;
  buildEntries: () => readonly WorkflowTranscriptEntry[];
  args: WorkflowToolArgs;
  sessionId?: string | undefined;
  sessionFile?: string | undefined;
  transcriptPath?: string | undefined;
}): WorkflowTranscriptResult {
  const transcriptPath = input.transcriptPath ?? input.sessionFile;
  if (transcriptPath !== undefined && !isTranscriptPreviewExplicit(input.args)) {
    const result: WorkflowTranscriptResult = {
      action: "transcript",
      runId: input.runId,
      stageId: input.stageId,
      source: input.source,
      entries: [],
      truncated: input.entryCount > 0,
      entryCount: input.entryCount,
      entryLimit: 0,
      lazyReadPrompt: transcriptLazyReadPrompt(transcriptPath),
      inlineMode: "path_only",
    };
    if (input.sessionId !== undefined) result.sessionId = input.sessionId;
    if (input.sessionFile !== undefined) result.sessionFile = input.sessionFile;
    result.transcriptPath = transcriptPath;
    return result;
  }

  const limited = selectTranscriptEntries(input.buildEntries(), input.args);
  const result: WorkflowTranscriptResult = {
    action: "transcript",
    runId: input.runId,
    stageId: input.stageId,
    source: input.source,
    entries: limited.entries,
    truncated: limited.truncated,
    entryCount: limited.entryCount,
    entryLimit: limited.entryLimit,
    inlineMode: transcriptPath === undefined ? "fallback_preview" : "preview",
  };
  if (input.sessionId !== undefined) result.sessionId = input.sessionId;
  if (input.sessionFile !== undefined) result.sessionFile = input.sessionFile;
  if (transcriptPath !== undefined) result.transcriptPath = transcriptPath;
  if (transcriptPath === undefined) {
    result.fallbackNote = transcriptFallbackNote(limited.entryLimit ?? DEFAULT_TRANSCRIPT_LIMIT);
  }
  return result;
}

function messageText(content: MessageLike["content"]): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  let sawTextBlock = false;
  const text = content
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        sawTextBlock = true;
        return block.text;
      }
      return "";
    })
    .join("");
  return sawTextBlock ? text : undefined;
}

export function transcriptEntryFromMessage(message: MessageLike): WorkflowTranscriptEntry {
  const entry: WorkflowTranscriptEntry = { role: message.role ?? "unknown" };
  const text = messageText(message.content);
  if (text !== undefined) entry.text = text;
  const toolName = message.toolName ?? message.name;
  if (toolName !== undefined) entry.toolName = toolName;
  const timestamp = message.timestamp ?? message.createdAt;
  if (timestamp !== undefined) entry.timestamp = timestamp;
  return entry;
}

function transcriptEntriesFromToolEvents(
  events: readonly ToolEvent[],
  includeOutput: boolean,
): WorkflowTranscriptEntry[] {
  return events.map((event) => ({
    role: "tool",
    toolName: event.name,
    output: includeOutput ? event.output : undefined,
    timestamp: event.endedAt ?? event.startedAt,
  }));
}

function sortTranscriptEntriesChronologically(
  entries: readonly WorkflowTranscriptEntry[],
): WorkflowTranscriptEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const aTimestamp = a.entry.timestamp;
      const bTimestamp = b.entry.timestamp;
      if (
        typeof aTimestamp === "number" &&
        typeof bTimestamp === "number" &&
        aTimestamp !== bTimestamp
      ) {
        return aTimestamp - bTimestamp;
      }
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

function terminalTranscriptEntry(
  role: "assistant" | "notice",
  text: string,
  endedAt: number | undefined,
): WorkflowTranscriptEntry {
  const entry: WorkflowTranscriptEntry = { role, text };
  if (endedAt !== undefined) entry.timestamp = endedAt;
  return entry;
}

export function snapshotTranscriptEntries(
  snapshot: StageSnapshot | undefined,
  includeOutput: boolean,
): WorkflowTranscriptEntry[] {
  if (snapshot === undefined) return [];
  const entries: WorkflowTranscriptEntry[] = [
    ...transcriptEntriesFromToolEvents(snapshot.toolEvents ?? [], includeOutput),
  ];
  if (snapshot.result !== undefined) {
    entries.push(terminalTranscriptEntry("assistant", snapshot.result, snapshot.endedAt));
  }
  if (snapshot.error !== undefined) {
    entries.push(terminalTranscriptEntry("notice", snapshot.error, snapshot.endedAt));
  }
  return sortTranscriptEntriesChronologically(entries);
}

export function snapshotTranscriptEntryCount(snapshot: StageSnapshot | undefined): number {
  return (snapshot?.toolEvents?.length ?? 0)
    + (snapshot?.result !== undefined ? 1 : 0)
    + (snapshot?.error !== undefined ? 1 : 0);
}
