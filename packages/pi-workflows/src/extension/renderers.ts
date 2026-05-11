/**
 * Stub message renderers for workflow lifecycle events.
 * Registered via pi.registerMessageRenderer for each event type.
 *
 * Renderers return compact strings suitable for inline chat display.
 * Full TUI graph engine integration is a later phase (§5.4).
 *
 * cross-ref: spec §5.6 Persistence renderers (registration only)
 */

// ---------------------------------------------------------------------------
// Entry payload shapes (matches pi.appendEntry call signatures from §5.6)
// ---------------------------------------------------------------------------

export interface RunStartPayload {
  runId: string;
  name: string;
  inputs?: Record<string, unknown>;
  ts?: number;
}

export interface StageStartPayload {
  runId: string;
  stageId: string;
  name: string;
  parentIds?: string[];
  model?: string;
  ts?: number;
}

export interface StageProgressPayload {
  runId: string;
  stageId: string;
  kind: string;
  payload?: unknown;
}

export interface StageEndPayload {
  runId: string;
  stageId: string;
  status: "ok" | "error" | "killed" | string;
  durationMs?: number;
  summary?: string;
}

export interface RunEndPayload {
  runId: string;
  status: "ok" | "error" | "killed" | string;
  result?: Record<string, unknown>;
  ts?: number;
}

// ---------------------------------------------------------------------------
// Renderer functions (stub — full TUI graph engine is Phase C/D)
// ---------------------------------------------------------------------------

/** Render workflow.run.start entry. */
export function renderRunBanner(payload: RunStartPayload): string {
  const inputCount = payload.inputs ? Object.keys(payload.inputs).length : 0;
  const inputNote = inputCount > 0 ? ` (${inputCount} input${inputCount !== 1 ? "s" : ""})` : "";
  return `▶ workflow "${payload.name}" started [${payload.runId}]${inputNote}`;
}

/** Render workflow.stage.start entry. */
export function renderStageChip(payload: StageStartPayload): string {
  const model = payload.model ? ` via ${payload.model}` : "";
  return `  ○ stage "${payload.name}"${model} started`;
}

/** Render workflow.stage.progress entry. */
export function renderStageProgress(payload: StageProgressPayload): string {
  return `  … stage progress [${payload.stageId}] ${payload.kind}`;
}

/** Render workflow.stage.end entry. */
export function renderStageResult(payload: StageEndPayload): string {
  const icon = payload.status === "ok" ? "✓" : "✗";
  const dur = payload.durationMs !== undefined ? ` (${payload.durationMs}ms)` : "";
  const summary = payload.summary ? `: ${payload.summary}` : "";
  return `  ${icon} stage [${payload.stageId}] ${payload.status}${dur}${summary}`;
}

/** Render workflow.run.end entry. */
export function renderRunSummary(payload: RunEndPayload): string {
  const icon = payload.status === "ok" ? "✅" : "❌";
  return `${icon} workflow [${payload.runId}] ${payload.status}`;
}
