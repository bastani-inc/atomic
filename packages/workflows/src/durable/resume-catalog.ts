/**
 * Cross-session resume catalog.
 *
 * Builds the list of resumable workflows for the `/workflow resume` selector by
 * scanning session JSONL files for `workflow.durable.checkpoint` entries. This
 * is the session-file cache described by the issue — it lets a new session
 * discover workflows started in prior sessions without requiring a live DBOS
 * system database connection.
 *
 * The catalog reads session files lazily and caches results per scan. DBOS
 * remains the checkpoint source of truth; this catalog provides the discovery
 * index for the selector UI.
 *
 * cross-ref: issue #1498 — "/workflow resume should show a selector for
 * resumable workflow sessions, analogous to the /resume session selector."
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DurableCheckpointEntry, DurableWorkflowStatus, ResumableWorkflowEntry } from "./types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import type { WorkflowSerializableValue } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Session file scanning
// ---------------------------------------------------------------------------

/**
 * Scan a session directory for `workflow.durable.checkpoint` entries and build
 * a list of resumable workflows.
 *
 * @param sessionDir Directory containing session JSONL files.
 * @returns Resumable workflow entries, most recently updated first.
 */
export function scanResumableWorkflows(sessionDir: string): readonly ResumableWorkflowEntry[] {
  if (!existsSync(sessionDir)) return [];
  const entries = new Map<string, ResumableWorkflowEntry>();
  let files: string[];
  try {
    files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  for (const file of files) {
    const filePath = join(sessionDir, file);
    const fileEntries = readDurableEntriesFromFile(filePath);
    const sessionFile = filePath;
    for (const entry of fileEntries) {
      const existing = entries.get(entry.workflowId);
      if (!existing || entry.ts > existing.updatedAt) {
        entries.set(entry.workflowId, entryToResumable(entry, sessionFile));
      }
    }
  }
  return [...entries.values()].filter((e) => isResumableStatus(e.status)).sort((a, b) => b.updatedAt - a.updatedAt);
}

function readDurableEntriesFromFile(filePath: string): readonly DurableCheckpointEntry[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const results: DurableCheckpointEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed && parsed["type"] === "workflow.durable.checkpoint") {
        const entry = parseDurableEntry(parsed);
        if (entry) results.push(entry);
      }
    } catch {
      // Skip malformed lines.
    }
  }
  return results;
}

function parseDurableEntry(raw: Record<string, unknown>): DurableCheckpointEntry | undefined {
  const workflowId = raw["workflowId"];
  const name = raw["name"];
  const inputs = raw["inputs"];
  const status = raw["status"];
  const ts = raw["ts"];
  if (typeof workflowId !== "string" || typeof name !== "string" || typeof status !== "string" || typeof ts !== "number") return undefined;
  if (!isWorkflowSerializableObject(inputs)) return undefined;
  return {
    type: "workflow.durable.checkpoint",
    workflowId,
    name,
    inputs,
    status: status as DurableWorkflowStatus,
    completedCheckpoints: typeof raw["completedCheckpoints"] === "number" ? raw["completedCheckpoints"] : 0,
    pendingPrompts: typeof raw["pendingPrompts"] === "number" ? raw["pendingPrompts"] : 0,
    ...(typeof raw["label"] === "string" ? { label: raw["label"] } : {}),
    ts,
  };
}

function isWorkflowSerializableObject(value: unknown): value is Readonly<Record<string, WorkflowSerializableValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!isSerializableValue(obj[key])) return false;
  }
  return true;
}

function isSerializableValue(value: unknown): value is WorkflowSerializableValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isSerializableValue);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj).every((k) => isSerializableValue(obj[k]));
  }
  return false;
}

function entryToResumable(entry: DurableCheckpointEntry, sessionFile: string): ResumableWorkflowEntry {
  return {
    workflowId: entry.workflowId,
    name: entry.name,
    status: entry.status,
    completedCheckpoints: entry.completedCheckpoints,
    pendingPrompts: entry.pendingPrompts,
    sessionFile,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    createdAt: entry.ts,
    updatedAt: entry.ts,
  };
}

function isResumableStatus(status: DurableWorkflowStatus): boolean {
  return status === "running" || status === "paused" || status === "failed" || status === "blocked";
}

// ---------------------------------------------------------------------------
// Backend-backed catalog
// ---------------------------------------------------------------------------

/**
 * List resumable workflows from a durable backend (in-memory or file-backed).
 * Used when the session file scan is not available (e.g. same-process resume).
 */
export function listResumableFromBackend(backend: DurableWorkflowBackend): readonly ResumableWorkflowEntry[] {
  return backend.listResumableWorkflows();
}

/**
 * Append a durable checkpoint entry to a session JSONL persistence port.
 * This caches the top-level workflow metadata so a future session can discover
 * it via {@link scanResumableWorkflows}.
 */
export function persistDurableCacheEntry(
  persistence: { appendEntry?: (type: string, payload: Record<string, unknown>) => string | undefined },
  entry: DurableCheckpointEntry,
): void {
  if (typeof persistence.appendEntry !== "function") return;
  persistence.appendEntry("workflow.durable.checkpoint", {
    workflowId: entry.workflowId,
    name: entry.name,
    inputs: entry.inputs as Record<string, unknown>,
    status: entry.status,
    completedCheckpoints: entry.completedCheckpoints,
    pendingPrompts: entry.pendingPrompts,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    ts: entry.ts,
  });
}

/**
 * Format the resumable workflow list for display in the selector.
 */
export function formatResumableWorkflowList(entries: readonly ResumableWorkflowEntry[]): string {
  if (entries.length === 0) return "No resumable workflows found.";
  const lines = entries.map((e, i) => {
    const id = e.workflowId.slice(0, 8);
    const status = e.status.padEnd(8);
    const checkpoints = `${e.completedCheckpoints} checkpoint${e.completedCheckpoints === 1 ? "" : "s"}`;
    const label = e.label ? ` "${e.label}"` : "";
    return `  ${i + 1}. ${id}  ${status}  ${e.name}${label}  (${checkpoints})`;
  });
  return `Resumable workflows:\n${lines.join("\n")}`;
}
