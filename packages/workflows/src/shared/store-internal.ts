import type { PromptAnswerRecord, RunEndMetadata } from "./store-public-types.js";
import type {
  PendingPrompt,
  RunSnapshot,
  RunStatus,
  StageSnapshot,
  StageStatus,
  StoreSnapshot,
  WorkflowNotice,
} from "./store-types.js";

/**
 * Statuses that represent a terminal run state — cannot be overwritten.
 *
 * Note on `"blocked"`: here it is an author-selected `ctx.exit({ status: "blocked" })`
 * outcome — terminal and non-resumable. This is deliberately distinct from retry-blocking,
 * which does NOT use this run status: `recordRunBlocked()` keeps `run.status = "running"`
 * and records the block via `blockedAt` / `failureDisposition: "active_blocked"` (resumable).
 * The two never collide despite the shared word.
 */
export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "killed",
  "skipped",
  "cancelled",
  "blocked",
]);

export interface ResolverEntry {
  readonly promptId: string;
  readonly resolve: (response: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

export interface StoreState {
  readonly runs: RunSnapshot[];
  readonly notices: WorkflowNotice[];
  readonly listeners: Set<(snap: StoreSnapshot) => void>;
  readonly resolvers: Map<string, ResolverEntry>;
  readonly stagePromptAnswers: Map<string, PromptAnswerRecord>;
  readonly stagePromptDrafts: Map<string, string>;
  version: number;
}

export interface StoreContext {
  readonly state: StoreState;
  snapshot(): StoreSnapshot;
  notify(): void;
  bumpAndNotify(): void;
  findRun(runId: string): RunSnapshot | undefined;
  findStage(run: RunSnapshot, stageId: string): StageSnapshot | undefined;
  rejectPrompt(promptId: string, reason: string): void;
  rejectStagePrompt(runId: string, stage: StageSnapshot, reason: string): void;
  rejectAllStagePrompts(runId: string, run: RunSnapshot, reason: string): void;
  stagePromptAnswerKey(runId: string, stageId: string): string;
  stagePromptDraftKey(runId: string, stageId: string, promptId: string): string;
  stageHasActiveTextPrompt(
    runId: string,
    stageId: string,
    promptId: string,
  ): { prompt: PendingPrompt } | undefined;
}

export function isTerminalStageStatus(status: StageStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

export function cannotAwaitInput(status: StageStatus): boolean {
  return isTerminalStageStatus(status) || status === "paused" || status === "blocked";
}

export function cannotBlock(status: StageStatus): boolean {
  return isTerminalStageStatus(status) || status === "paused";
}

export function cannotPause(status: StageStatus): boolean {
  return isTerminalStageStatus(status) || status === "paused" || status === "blocked";
}

export function clearRunFailureMetadata(run: RunSnapshot): void {
  delete run.error;
  delete run.failureKind;
  delete run.failureCode;
  delete run.failureRecoverability;
  delete run.failureDisposition;
  delete run.failureMessage;
  delete run.failedStageId;
  delete run.failedToolNodeId;
  delete run.resumable;
  delete run.retryAfterMs;
  delete run.blockedAt;
  delete run.exited;
  delete run.exitReason;
}

export function clearStaleBlockedRunMetadata(run: RunSnapshot, metadata: RunEndMetadata | undefined): void {
  if (metadata?.failureKind === undefined) delete run.failureKind;
  if (metadata?.failureCode === undefined) delete run.failureCode;
  if (metadata?.failureRecoverability === undefined) delete run.failureRecoverability;
  if (metadata?.failureDisposition === undefined) delete run.failureDisposition;
  if (metadata?.failureMessage === undefined) delete run.failureMessage;
  if (metadata?.failedStageId === undefined) delete run.failedStageId;
  if (metadata?.failedToolNodeId === undefined) delete run.failedToolNodeId;
  if (metadata?.resumable === undefined) delete run.resumable;
  if (metadata?.retryAfterMs === undefined) delete run.retryAfterMs;
  if (metadata?.exited === undefined) delete run.exited;
  if (metadata?.exitReason === undefined) delete run.exitReason;
}

export function applyRunEndMetadata(run: RunSnapshot, metadata: RunEndMetadata): void {
  if (metadata.failureKind !== undefined) run.failureKind = metadata.failureKind;
  if (metadata.failureCode !== undefined) run.failureCode = metadata.failureCode;
  if (metadata.failureRecoverability !== undefined) run.failureRecoverability = metadata.failureRecoverability;
  if (metadata.failureDisposition !== undefined) run.failureDisposition = metadata.failureDisposition;
  if (metadata.retryAfterMs !== undefined) run.retryAfterMs = metadata.retryAfterMs;
  if (metadata.failureMessage !== undefined) run.failureMessage = metadata.failureMessage;
  if (metadata.failedStageId !== undefined) run.failedStageId = metadata.failedStageId;
  if (metadata.failedToolNodeId !== undefined) run.failedToolNodeId = metadata.failedToolNodeId;
  if (metadata.resumable !== undefined) run.resumable = metadata.resumable;
  if (metadata.exited !== undefined) run.exited = metadata.exited;
  if (metadata.exitReason !== undefined) run.exitReason = metadata.exitReason;
}

export function createStoreState(): StoreState {
  return {
    runs: [],
    notices: [],
    listeners: new Set(),
    resolvers: new Map(),
    stagePromptAnswers: new Map(),
    stagePromptDrafts: new Map(),
    version: 0,
  };
}

export function createStoreContext(state: StoreState = createStoreState()): StoreContext {
  function snapshot(): StoreSnapshot {
    return JSON.parse(
      JSON.stringify({ runs: state.runs, notices: state.notices, version: state.version }),
    ) as StoreSnapshot;
  }

  function notify(): void {
    const snap = snapshot();
    for (const fn of state.listeners) {
      fn(snap);
    }
  }

  function bumpAndNotify(): void {
    state.version++;
    notify();
  }

  function findRun(runId: string): RunSnapshot | undefined {
    return state.runs.find((r) => r.id === runId);
  }

  function findStage(run: RunSnapshot, stageId: string): StageSnapshot | undefined {
    return run.stages.find((s) => s.id === stageId);
  }

  function rejectPrompt(promptId: string, reason: string): void {
    const entry = state.resolvers.get(promptId);
    if (!entry) return;
    state.resolvers.delete(promptId);
    entry.reject(new Error(reason));
  }

  function stagePromptAnswerKey(runId: string, stageId: string): string {
    return JSON.stringify([runId, stageId]);
  }

  function stagePromptDraftKey(runId: string, stageId: string, promptId: string): string {
    return JSON.stringify([runId, stageId, promptId]);
  }

  function stageHasActiveTextPrompt(
    runId: string,
    stageId: string,
    promptId: string,
  ): { prompt: PendingPrompt } | undefined {
    const run = findRun(runId);
    if (!run || TERMINAL_STATUSES.has(run.status)) return undefined;
    const stage = findStage(run, stageId);
    if (!stage || isTerminalStageStatus(stage.status)) return undefined;
    const prompt = stage.pendingPrompt;
    if (!prompt || prompt.id !== promptId) return undefined;
    if (prompt.kind !== "input" && prompt.kind !== "editor") return undefined;
    return { prompt };
  }

  function rejectStagePrompt(runId: string, stage: StageSnapshot, reason: string): void {
    const prompt = stage.pendingPrompt;
    if (!prompt) return;
    stage.pendingPrompt = undefined;
    state.stagePromptDrafts.delete(stagePromptDraftKey(runId, stage.id, prompt.id));
    rejectPrompt(prompt.id, reason);
  }

  function rejectAllStagePrompts(runId: string, run: RunSnapshot, reason: string): void {
    for (const stage of run.stages) {
      rejectStagePrompt(runId, stage, reason);
    }
  }

  return {
    state,
    snapshot,
    notify,
    bumpAndNotify,
    findRun,
    findStage,
    rejectPrompt,
    rejectStagePrompt,
    rejectAllStagePrompts,
    stagePromptAnswerKey,
    stagePromptDraftKey,
    stageHasActiveTextPrompt,
  };
}
