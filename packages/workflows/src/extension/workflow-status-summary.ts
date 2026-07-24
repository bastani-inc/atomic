/**
 * Concise per-run summaries for the workflow tool `status` listing.
 *
 * `workflow({ action: "status" })` without a `runId` lists every top-level
 * run in the session. Each run is reduced to an agent-friendly summary that
 * carries status, timing, active stages, and awaiting-input/pending-prompt
 * information plus the identifiers needed to feed `pause`/`resume`/
 * `interrupt`/`quit`/`send` directly.
 *
 * cross-ref:
 *  - src/extension/workflow-tool.ts        `case "status"` (listing path)
 *  - src/extension/workflow-tool-content.ts agent-visible text rendering
 *  - src/extension/workflow-targets.ts      topLevelExpandedSnapshots()
 */

import type {
  PendingPrompt,
  RunSnapshot,
  RunStatus,
  StageInputRequest,
  StageSnapshot,
  StageStatus,
  ToolNodeStatus,
} from "../shared/store-types.js";
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import { elapsedRunMs } from "../shared/timing.js";

/**
 * Status filter accepted by the `status` run listing (and the `stages`
 * action). Run-level statuses match runs directly; `awaiting_input` selects
 * runs with at least one stage awaiting input or pending human prompt;
 * `all` (the default) includes everything.
 */
export type WorkflowRunStatusFilter = StageStatus | RunStatus | "all";

const RUN_ID_PREFIX_LEN = 8;

/** A currently active (running or awaiting-input) stage within a run. */
export interface WorkflowStatusActiveStage {
  /** Expanded-graph stage id; valid for stage-scoped send/pause/resume. */
  readonly stageId: string;
  readonly name: string;
  readonly status: StageStatus;
}

/** One stage (or run-level) pending human-input descriptor. */
export interface WorkflowStatusAwaitingInput {
  /** Absent for a run-level HIL prompt. */
  readonly stageId?: string;
  readonly stageName?: string;
  /** Pending prompt id; pass as `promptId` to `send` when answering. */
  readonly promptId?: string;
  readonly promptKind?: string;
  readonly message?: string;
}

/** Non-chat durable tool-node status included additively in run summaries. */
export interface WorkflowStatusToolNode {
  readonly id: string;
  readonly name: string;
  readonly status: ToolNodeStatus;
  readonly ordinal: number;
  readonly executionOrder?: number;
  readonly parentIds: readonly string[];
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly replayed?: boolean;
  readonly resultSummary?: string;
  readonly error?: string;
  readonly attachable: false;
}

/**
 * Concise, JSON-stable summary of one top-level run for the `status`
 * listing. `runId` feeds pause/resume/interrupt/quit/send directly;
 * `awaitingInput` entries carry the stage/prompt ids that `send` accepts.
 */
export interface WorkflowRunStatusSummary {
  readonly runId: string;
  /** Abbreviated run id as printed by status surfaces; a valid prefix input. */
  readonly runIdPrefix: string;
  /** Workflow/run name. */
  readonly name: string;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  /** Pause-adjusted elapsed milliseconds (prior sessions included). */
  readonly elapsedMs: number;
  readonly activeStages: readonly WorkflowStatusActiveStage[];
  /** Durable, non-attachable ctx.tool graph nodes in authored order. */
  readonly tools?: readonly WorkflowStatusToolNode[];
  readonly awaitingInputCount: number;
  readonly awaitingInput: readonly WorkflowStatusAwaitingInput[];
  readonly exitReason?: string;
  readonly error?: string;
}

/** Filtered, ordered status listing: `runs[i]` summarizes `snapshots[i]`. */
export interface WorkflowStatusListing {
  readonly filter: WorkflowRunStatusFilter;
  readonly runs: WorkflowRunStatusSummary[];
  readonly snapshots: RunSnapshot[];
}

function stageIsActive(stage: StageSnapshot): boolean {
  return stage.status === "running" || stage.status === "awaiting_input";
}

function stageAwaitingInput(stage: StageSnapshot): boolean {
  return (
    stage.status === "awaiting_input" ||
    stage.awaitingInputSince !== undefined ||
    stage.pendingPrompt !== undefined ||
    stage.inputRequest !== undefined
  );
}

function promptMessage(
  prompt: PendingPrompt | undefined,
  request: StageInputRequest | undefined,
): string | undefined {
  if (prompt !== undefined) return prompt.message;
  return request?.questions[0]?.question;
}

function awaitingInputEntries(run: RunSnapshot): WorkflowStatusAwaitingInput[] {
  const entries: WorkflowStatusAwaitingInput[] = [];
  if (run.pendingPrompt !== undefined) {
    entries.push({
      promptId: run.pendingPrompt.id,
      promptKind: run.pendingPrompt.kind,
      message: run.pendingPrompt.message,
    });
  }
  for (const stage of run.stages) {
    if (!stageAwaitingInput(stage)) continue;
    const entry: WorkflowStatusAwaitingInput = {
      stageId: stage.id,
      stageName: stage.name,
      promptId: stage.pendingPrompt?.id ?? stage.inputRequest?.id,
      promptKind: stage.pendingPrompt?.kind ?? stage.inputRequest?.kind,
      message: promptMessage(stage.pendingPrompt, stage.inputRequest),
    };
    entries.push(entry);
  }
  return entries;
}

/** Reduce one run snapshot to its concise status summary. */
export function summarizeRunSnapshot(
  run: RunSnapshot,
  now = Date.now(),
): WorkflowRunStatusSummary {
  const awaitingInput = awaitingInputEntries(run);
  return {
    runId: run.id,
    runIdPrefix: run.id.slice(0, RUN_ID_PREFIX_LEN),
    name: run.name,
    status: effectiveRunStatus(run),
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    elapsedMs: elapsedRunMs(run, now),
    activeStages: run.stages.filter(stageIsActive).map((stage) => ({
      stageId: stage.id,
      name: stage.name,
      status: stage.status,
    })),
    tools: (run.toolNodes ?? []).map((tool) => ({
      id: tool.id,
      name: tool.name,
      status: tool.status,
      ordinal: tool.ordinal,
      executionOrder: tool.executionOrder,
      parentIds: [...tool.parentIds],
      startedAt: tool.startedAt,
      endedAt: tool.endedAt,
      replayed: tool.replayed,
      resultSummary: tool.resultSummary,
      error: tool.error,
      attachable: false,
    })),
    awaitingInputCount: awaitingInput.length,
    awaitingInput,
    exitReason: run.exitReason,
    error: run.error,
  };
}

/** True when the summarized run passes the status filter. */
export function runMatchesStatusFilter(
  summary: WorkflowRunStatusSummary,
  filter: WorkflowRunStatusFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "awaiting_input") return summary.awaitingInputCount > 0;
  return summary.status === filter;
}

/**
 * Build the filtered `status` run listing: summaries and their matching
 * snapshots, in-flight runs first, then each bucket by startedAt descending.
 */
export function buildWorkflowStatusListing(
  snapshots: readonly RunSnapshot[],
  filter: WorkflowRunStatusFilter = "all",
  now = Date.now(),
): WorkflowStatusListing {
  const paired = snapshots
    .map((snapshot) => ({ snapshot, summary: summarizeRunSnapshot(snapshot, now) }))
    .filter(({ summary }) => runMatchesStatusFilter(summary, filter));
  paired.sort((a, b) => {
    const aEnded = a.snapshot.endedAt === undefined ? 0 : 1;
    const bEnded = b.snapshot.endedAt === undefined ? 0 : 1;
    if (aEnded !== bEnded) return aEnded - bEnded;
    return b.snapshot.startedAt - a.snapshot.startedAt;
  });
  return {
    filter,
    runs: paired.map((pair) => pair.summary),
    snapshots: paired.map((pair) => pair.snapshot),
  };
}
