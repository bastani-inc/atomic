import type { ChatSessionHostEntry } from "./chat-session-host-types.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.ts";

type ToolEntry = Extract<ChatSessionHostEntry<ChatTranscriptEntryLike>, { kind: "tool" }>;
type ToolResult = NonNullable<ToolEntry["result"]>;
type ObjectRecord = Record<string, unknown>;

export function finalizeTerminalWorkflowToolEntries<
  TExtraEntry extends ChatTranscriptEntryLike,
>(entries: ChatSessionHostEntry<TExtraEntry>[]): boolean {
  let changed = false;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!isToolEntry(entry)) continue;
    const finalized = finalizeToolEntry(entry);
    if (finalized !== entry) {
      entries[i] = finalized as ChatSessionHostEntry<TExtraEntry>;
      changed = true;
    }
  }
  return changed;
}

function finalizeToolEntry(entry: ToolEntry): ToolEntry {
  const result = entry.result ? finalizeToolResult(entry.result) : undefined;
  const resultChanged = result !== entry.result;
  if (entry.isPartial === false && !resultChanged) return entry;
  return {
    ...entry,
    ...(result ? { result } : {}),
    isPartial: false,
  };
}

function finalizeToolResult(result: ToolResult): ToolResult {
  const details = finalizeDetails(result.details);
  if (details === result.details) return result;
  return { ...result, details };
}

function finalizeDetails(details: unknown): unknown {
  if (!isRecord(details)) return details;
  let changed = false;
  const next: ObjectRecord = { ...details };
  const progress = finalizeProgressArray(next.progress);
  if (progress !== next.progress) {
    next.progress = progress;
    changed = true;
  }
  if (Array.isArray(next.results)) {
    const results = next.results.map((item) => finalizeResultEntry(item));
    if (results.some((item, index) => item !== (next.results as unknown[])[index])) {
      next.results = results;
      changed = true;
    }
  }
  const workflowGraph = finalizeWorkflowGraph(next.workflowGraph);
  if (workflowGraph !== next.workflowGraph) {
    next.workflowGraph = workflowGraph;
    changed = true;
  }
  return changed ? next : details;
}

function finalizeResultEntry(entry: unknown): unknown {
  if (!isRecord(entry)) return entry;
  const progress = finalizeProgress(entry.progress);
  if (progress === entry.progress) return entry;
  return { ...entry, progress };
}

function finalizeProgressArray(progress: unknown): unknown {
  if (!Array.isArray(progress)) return progress;
  let changed = false;
  const next = progress.map((entry) => {
    const finalized = finalizeProgress(entry);
    if (finalized !== entry) changed = true;
    return finalized;
  });
  return changed ? next : progress;
}

function finalizeProgress(progress: unknown): unknown {
  if (!isRecord(progress) || progress.status !== "running") return progress;
  return {
    ...progress,
    status: "detached",
    activityState: undefined,
    currentTool: undefined,
    currentToolArgs: undefined,
    currentToolStartedAt: undefined,
  };
}

function finalizeWorkflowGraph(graph: unknown): unknown {
  if (!isRecord(graph)) return graph;
  const nodes = finalizeWorkflowGraphNodes(graph.nodes);
  const shouldClearCurrent = graph.currentNodeId !== undefined;
  if (nodes === graph.nodes && !shouldClearCurrent) return graph;
  return { ...graph, nodes, currentNodeId: undefined };
}

function finalizeWorkflowGraphNodes(nodes: unknown): unknown {
  if (!Array.isArray(nodes)) return nodes;
  let changed = false;
  const next = nodes.map((node) => {
    const finalized = finalizeWorkflowGraphNode(node);
    if (finalized !== node) changed = true;
    return finalized;
  });
  return changed ? next : nodes;
}

function finalizeWorkflowGraphNode(node: unknown): unknown {
  if (!isRecord(node)) return node;
  let changed = false;
  const next: ObjectRecord = { ...node };
  if (next.status === "running") {
    next.status = "detached";
    changed = true;
  }
  const children = finalizeWorkflowGraphNodes(next.children);
  if (children !== next.children) {
    next.children = children;
    changed = true;
  }
  return changed ? next : node;
}

function isToolEntry(entry: ChatSessionHostEntry<ChatTranscriptEntryLike>): entry is ToolEntry {
  return entry.role === "tool" && "kind" in entry && entry.kind === "tool";
}

function isRecord(value: unknown): value is ObjectRecord {
  return value !== null && typeof value === "object";
}
