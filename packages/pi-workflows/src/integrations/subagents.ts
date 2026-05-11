/**
 * pi-subagents cooperation helpers.
 *
 * Responsibilities:
 *  1. Inject PI_WORKFLOW_RUN_ID / PI_WORKFLOW_STAGE_ID env vars so child
 *     processes spawned by pi-subagents carry workflow context.
 *  2. Emit workflow.stage.start / workflow.stage.end events via pi.events so
 *     pi-subagents (and other extensions) can react.
 *  3. Expose a clear absent-dependency surface: `assertSubagentsPresent`
 *     throws a human-readable error if pi-subagents is not detected.
 *
 * cross-ref: pi-subagents src/extension/index.ts
 * cross-ref: spec §5.8 Integration with pi-subagents, §8.1 Phase G
 */

// ---------------------------------------------------------------------------
// Minimal structural types — no hard imports from pi-subagents
// ---------------------------------------------------------------------------

/** Minimal pi events bus surface used by this module. */
export interface PiEventBus {
  emit: (event: string, payload: Record<string, unknown>) => void;
  on?: (event: string, handler: (payload: unknown) => void) => void;
}

/** Minimal ExtensionAPI surface expected by subagents integration. */
export interface PiSubagentsExtensionAPI {
  events?: PiEventBus;
  /** Opaque subagents surface — used only for presence detection. */
  subagents?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Env injection — PI_WORKFLOW_RUN_ID / PI_WORKFLOW_STAGE_ID
// ---------------------------------------------------------------------------

export interface WorkflowEnvVars {
  PI_WORKFLOW_RUN_ID: string;
  PI_WORKFLOW_STAGE_ID: string;
}

/**
 * Returns env-var record to inject into child processes spawned by
 * pi-subagents so they carry the workflow context.
 *
 * Usage:
 *   const env = injectWorkflowEnv(runId, stageId);
 *   // merge into child process env before spawn
 */
export function injectWorkflowEnv(runId: string, stageId: string): WorkflowEnvVars {
  return {
    PI_WORKFLOW_RUN_ID: runId,
    PI_WORKFLOW_STAGE_ID: stageId,
  };
}

/**
 * Reads workflow context from the current process environment.
 * Returns undefined values when running outside a workflow child process.
 */
export function readWorkflowEnv(): Partial<WorkflowEnvVars> {
  return {
    PI_WORKFLOW_RUN_ID: process.env["PI_WORKFLOW_RUN_ID"],
    PI_WORKFLOW_STAGE_ID: process.env["PI_WORKFLOW_STAGE_ID"],
  };
}

// ---------------------------------------------------------------------------
// Event emission — workflow.stage.start / workflow.stage.end
// ---------------------------------------------------------------------------

export interface StageStartPayload {
  runId: string;
  stageId: string;
  stageName: string;
  startedAt: number;
}

export interface StageEndPayload {
  runId: string;
  stageId: string;
  stageName: string;
  status: "completed" | "failed" | "skipped";
  endedAt: number;
  durationMs?: number;
  error?: string;
}

/**
 * Emits `workflow.stage.start` on `pi.events` (no-op if events bus absent).
 */
export function emitStageStart(
  pi: PiSubagentsExtensionAPI,
  payload: StageStartPayload,
): void {
  pi.events?.emit("workflow.stage.start", payload as unknown as Record<string, unknown>);
}

/**
 * Emits `workflow.stage.end` on `pi.events` (no-op if events bus absent).
 */
export function emitStageEnd(
  pi: PiSubagentsExtensionAPI,
  payload: StageEndPayload,
): void {
  pi.events?.emit("workflow.stage.end", payload as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Dependency surface check
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the pi runtime exposes a pi-subagents-compatible surface.
 * Detection is purely structural: checks for `pi.subagents` presence.
 */
export function isSubagentsPresent(pi: PiSubagentsExtensionAPI): boolean {
  return pi.subagents !== undefined && pi.subagents !== null;
}

/**
 * Throws a clear, actionable error when pi-subagents is not installed.
 * Stage runners call this before attempting subagent delegation.
 */
export function assertSubagentsPresent(pi: PiSubagentsExtensionAPI): void {
  if (!isSubagentsPresent(pi)) {
    throw new Error(
      "pi-workflows: subagent delegation requires pi-subagents — install npm:pi-subagents and restart pi.",
    );
  }
}
