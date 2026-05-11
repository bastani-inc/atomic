/**
 * Types for live run/stage snapshots.
 * cross-ref: spec §5.5
 */

export type RunStatus = "pending" | "running" | "completed" | "failed" | "killed";
export type StageStatus = "pending" | "running" | "completed" | "failed";

export interface ToolEvent {
  name: string;
  input?: Record<string, unknown>;
  output?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface StageSnapshot {
  readonly id: string;
  readonly name: string;
  status: StageStatus;
  readonly parentIds: readonly string[];
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  result?: string;
  error?: string;
  readonly toolEvents: ToolEvent[];
}

export interface RunSnapshot {
  readonly id: string;
  readonly name: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  status: RunStatus;
  readonly stages: StageSnapshot[];
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  result?: Record<string, unknown>;
  error?: string;
}

export interface StoreSnapshot {
  readonly runs: readonly RunSnapshot[];
  readonly notices: readonly WorkflowNotice[];
  readonly version: number;
}

/** Lightweight notice attached to a run or stage. */
export type NoticeLevel = "info" | "warning" | "error";

export interface WorkflowNotice {
  readonly id: string;
  readonly runId?: string;
  readonly stageId?: string;
  readonly level: NoticeLevel;
  message: string;
  readonly createdAt: number;
  readonly requiresAck?: boolean;
  /** Set once acknowledged. */
  ackedAt?: number;
}

/**
 * Adapter for displaying run progress / status in a UI layer.
 * Implemented by the TUI widget or a test spy; injected via RunOpts.overlay.
 */
export interface WorkflowOverlayAdapter {
  /** Show or update the overlay with the given notice. */
  show(notice: WorkflowNotice): void;
  /** Hide the overlay (called when the run completes or is cancelled). */
  hide(): void;
}
