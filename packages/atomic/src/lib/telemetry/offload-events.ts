/**
 * Telemetry event-name constants and payload shapes for the workflow
 * offload & resume feature (RFC: specs/2026-05-08-workflow-pane-offload-and-resume.md,
 * § 7.2 Observability Strategy).
 *
 * No emit call sites live here — this module is a pure registry.
 * Consumers wire these constants into their telemetry emit calls.
 */

import type { AgentType } from "@bastani/atomic-sdk";

/**
 * Alias for AgentType scoped to telemetry payloads.
 * Matches the agent-kind vocabulary used in offload RFC (§ 7.2).
 */
export type AgentKind = AgentType;

// ─── Event-name constants ────────────────────────────────────────────────────

/** Fired once per workflow run when panes are scheduled for offload. */
export const WORKFLOW_OFFLOAD_SCHEDULED = "workflow.offload.scheduled" as const;

/** Fired per pane when the underlying agent process has been killed and tmux
 *  window reaped successfully. */
export const WORKFLOW_OFFLOAD_COMPLETED = "workflow.offload.completed" as const;

/** Fired when the user navigates to an offloaded pane and resume is attempted. */
export const WORKFLOW_OFFLOAD_RESUME_ATTEMPTED =
  "workflow.offload.resume.attempted" as const;

/** Fired when the agent process has re-spawned and the pane is ready. */
export const WORKFLOW_OFFLOAD_RESUME_SUCCEEDED =
  "workflow.offload.resume.succeeded" as const;

/** Fired when the resume attempt fails (e.g., missing session ID, spawn error). */
export const WORKFLOW_OFFLOAD_RESUME_FAILED =
  "workflow.offload.resume.failed" as const;

/** Fired with the measured latency (ms) from focus event → pane ready. */
export const WORKFLOW_OFFLOAD_RESUME_LATENCY_MS =
  "workflow.offload.resume.latency_ms" as const;

// ─── Payload interfaces ──────────────────────────────────────────────────────

/** Payload for {@link WORKFLOW_OFFLOAD_SCHEDULED}. */
export interface WorkflowOffloadScheduledPayload {
  /** Unique identifier for the workflow run. */
  runId: string;
  /** Number of panes scheduled for offload in this run. */
  count: number;
}

/** Payload for {@link WORKFLOW_OFFLOAD_COMPLETED}. */
export interface WorkflowOffloadCompletedPayload {
  /** Unique identifier for the workflow run. */
  runId: string;
  /** Stage name that was offloaded. */
  name: string;
  /** Agent provider that was running in the pane. */
  agent: AgentKind;
}

/** Payload for {@link WORKFLOW_OFFLOAD_RESUME_ATTEMPTED}. */
export interface WorkflowOffloadResumeAttemptedPayload {
  /** Unique identifier for the workflow run. */
  runId: string;
  /** Stage name being resumed. */
  name: string;
  /** Agent provider being re-spawned. */
  agent: AgentKind;
}

/** Payload for {@link WORKFLOW_OFFLOAD_RESUME_SUCCEEDED}. */
export interface WorkflowOffloadResumeSucceededPayload {
  /** Unique identifier for the workflow run. */
  runId: string;
  /** Stage name that was successfully resumed. */
  name: string;
  /** Agent provider that was re-spawned. */
  agent: AgentKind;
}

/** Payload for {@link WORKFLOW_OFFLOAD_RESUME_FAILED}. */
export interface WorkflowOffloadResumeFailedPayload {
  /** Unique identifier for the workflow run. */
  runId: string;
  /** Stage name for which resume failed. */
  name: string;
  /** Agent provider that failed to re-spawn. */
  agent: AgentKind;
  /** Machine-readable error code (e.g., "MISSING_SESSION_ID", "SPAWN_ERROR"). */
  errorCode: string;
}

/** Payload for {@link WORKFLOW_OFFLOAD_RESUME_LATENCY_MS}. */
export interface WorkflowOffloadResumeLatencyPayload {
  /** Unique identifier for the workflow run. */
  runId: string;
  /** Stage name that was resumed. */
  name: string;
  /** Agent provider that was re-spawned. */
  agent: AgentKind;
  /** Elapsed time in milliseconds from focus event to pane-ready. */
  latencyMs: number;
}
