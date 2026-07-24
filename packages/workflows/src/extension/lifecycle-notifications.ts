import type {
  ExtensionAPI,
  PiMessageRenderComponent,
  PiMessageRenderer,
} from "./index.js";
import type { Store } from "../shared/store.js";
import type {
  PendingPrompt,
  PromptKind,
  RunSnapshot,
  RunStatus,
  StageInputKind,
  StageSnapshot,
  StageStatus,
  StoreSnapshot,
} from "../shared/store-types.js";
import { isTopLevelWorkflowRun } from "../shared/run-visibility.js";
import {
  actionableReturnedStatusText,
  effectiveRunStatus,
  isReturnedBlockedWorkflowStatus,
  normalizeReturnedWorkflowStatus,
  structuredRecoverableWorkflowFailureText,
} from "../shared/returned-run-status.js";
import { deriveGraphThemeFromPiTheme, type GraphTheme } from "../tui/graph-theme.js";
import { renderWorkflowNoticeCard, type WorkflowNoticeTone } from "../tui/workflow-notice-card.js";
import { createLifecycleNoticeDelivery } from "./lifecycle-notification-delivery.js";

export const LIFECYCLE_NOTICE_CUSTOM_TYPE = "workflows:lifecycle-notice";
export const LIFECYCLE_NOTICE_SNIPPET_LIMIT = 240;

export type WorkflowLifecycleNoticeKind = "completed" | "failed" | "blocked" | "awaiting_input";

export const WORKFLOW_LIFECYCLE_NOTICE_KINDS = [
  "completed",
  "failed",
  "blocked",
  "awaiting_input",
] as const satisfies readonly WorkflowLifecycleNoticeKind[];

export interface WorkflowLifecycleNotificationConfig {
  readonly enabled: boolean;
  readonly notifyOn: readonly WorkflowLifecycleNoticeKind[];
}

export interface WorkflowLifecycleNoticeDetails {
  readonly kind: WorkflowLifecycleNoticeKind;
  readonly scope: "run" | "stage";
  readonly runId: string;
  readonly workflowName: string;
  readonly status: RunStatus | StageStatus;
  readonly stageId?: string;
  readonly stageName?: string;
  readonly promptId?: string;
  readonly promptKind?: PromptKind | StageInputKind;
  readonly promptMessage?: string;
  readonly error?: string;
  readonly failedStageId?: string;
  readonly toolNodeId?: string;
  readonly toolName?: string;
  readonly durationMs?: number;
  readonly active?: boolean;
  readonly createdAt: number;
}

export interface WorkflowLifecycleNotificationState {
  readonly deliveredTerminalRuns: Set<string>;
  readonly retryableTerminalNotices: Map<string, WorkflowLifecycleNoticeDetails>;
  readonly pendingTerminalRuns: Map<string, symbol>;
  readonly retryableTerminalRuns: Set<string>;
  readonly retryObservers: Set<(key: string, details: WorkflowLifecycleNoticeDetails) => void>;
  readonly deliveredInputPrompts: Set<string>;
  suppressionDepth: number;
}

export interface WorkflowLifecycleNotificationOptions {
  readonly store: Store;
  readonly sendMessage?: ExtensionAPI["sendMessage"];
  readonly registerMessageRenderer?: ExtensionAPI["registerMessageRenderer"];
  readonly rendererHost?: object;
  readonly config: WorkflowLifecycleNotificationConfig;
  readonly state?: WorkflowLifecycleNotificationState;
  readonly seedExisting?: boolean;
}

type RawRenderer = PiMessageRenderer;
const rendererRegisteredHosts = new WeakSet<object>();
export function createWorkflowLifecycleNotificationState(): WorkflowLifecycleNotificationState {
  return {
    deliveredTerminalRuns: new Set<string>(),
    pendingTerminalRuns: new Map<string, symbol>(),
    retryableTerminalNotices: new Map<string, WorkflowLifecycleNoticeDetails>(),
    retryableTerminalRuns: new Set<string>(),
    retryObservers: new Set<(key: string, details: WorkflowLifecycleNoticeDetails) => void>(),
    deliveredInputPrompts: new Set<string>(),
    suppressionDepth: 0,
  };
}

/** Reset all prior-session lifecycle delivery and dedupe state. */
export function resetWorkflowLifecycleNotificationState(
  state: WorkflowLifecycleNotificationState,
): void {
  state.deliveredTerminalRuns.clear();
  state.pendingTerminalRuns.clear();
  state.retryableTerminalRuns.clear();
  state.retryableTerminalNotices.clear();
  state.retryObservers.clear();
  state.deliveredInputPrompts.clear();
  state.suppressionDepth = 0;
}

export function seedWorkflowLifecycleNotificationState(
  state: WorkflowLifecycleNotificationState,
  snapshot: StoreSnapshot,
): void {
  for (const run of snapshot.runs) {
    if (!isTopLevelWorkflowRun(run)) continue;
    const noticeKind = terminalNoticeKind(run);
    if (noticeKind !== undefined && lifecycleOccurrenceAt(run, noticeKind) !== undefined) {
      const key = terminalRunKey(noticeKind, run);
      if (!state.pendingTerminalRuns.has(key) && !state.retryableTerminalRuns.has(key)) {
        state.deliveredTerminalRuns.add(key);
      }
    }
    if (run.pendingPrompt !== undefined) {
      state.deliveredInputPrompts.add(runAwaitingInputKey(run.id, run.pendingPrompt));
    }
    for (const stage of run.stages) {
      if (stage.status === "awaiting_input") {
        state.deliveredInputPrompts.add(awaitingInputKey(run.id, stage));
      }
    }
  }
}

/**
 * Suppress lifecycle notice emission while still observing snapshot changes and
 * marking matching lifecycle states as delivered. This is intended for restore
 * or replay paths where historical workflow states should seed dedupe state
 * without notifying the current chat; it is not a generic temporary mute that
 * should emit the same notices later.
 */
export function withWorkflowLifecycleNotificationsSuppressed<T>(
  state: WorkflowLifecycleNotificationState,
  fn: () => T,
): T {
  state.suppressionDepth += 1;
  try {
    return fn();
  } finally {
    state.suppressionDepth -= 1;
  }
}

/**
 * Async-safe companion to {@link withWorkflowLifecycleNotificationsSuppressed}.
 * Keeps suppression active until the awaited operation settles, so terminal
 * store updates produced by background jobs cannot race an awaited headless
 * workflow dispatch and trigger an extra steer turn before the caller returns.
 */
export async function withWorkflowLifecycleNotificationsSuppressedAsync<T>(
  state: WorkflowLifecycleNotificationState,
  fn: () => Promise<T>,
): Promise<T> {
  state.suppressionDepth += 1;
  try {
    return await fn();
  } finally {
    state.suppressionDepth -= 1;
  }
}

export function installWorkflowLifecycleNotifications(
  options: WorkflowLifecycleNotificationOptions,
): () => void {
  registerLifecycleNoticeRenderer(options);

  if (!options.config.enabled) return () => undefined;
  const send = options.sendMessage;
  if (typeof send !== "function") return () => undefined;

  const notifyOn = new Set<WorkflowLifecycleNoticeKind>(options.config.notifyOn);
  const state = options.state ?? createWorkflowLifecycleNotificationState();
  let delivery!: ReturnType<typeof createLifecycleNoticeDelivery>;
  if (options.seedExisting !== false) seedWorkflowLifecycleNotificationState(state, options.store.snapshot());

  const emit = (details: WorkflowLifecycleNoticeDetails): boolean | Promise<boolean> => {
    try {
      const result = send({
        customType: LIFECYCLE_NOTICE_CUSTOM_TYPE,
        content: formatWorkflowLifecycleNoticeText(details),
        display: true,
        details,
      }, { triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true });
      if (result === undefined) return true;
      return Promise.resolve(result).then(() => true, (error: unknown) => {
        warnLifecycleSendFailure(error);
        return false;
      });
    } catch (error) {
      warnLifecycleSendFailure(error);
      return false;
    }
  };

  const emitTerminalNoticeOnce = (
    run: RunSnapshot,
    kind: "completed" | "failed" | "blocked",
  ): void => {
    const noticeKind = terminalNoticeKind(run);
    if (noticeKind !== kind || lifecycleOccurrenceAt(run, kind) === undefined || !notifyOn.has(kind)) {
      return;
    }

    const key = terminalRunKey(kind, run);
    if (state.deliveredTerminalRuns.has(key) || state.pendingTerminalRuns.has(key) || state.retryableTerminalRuns.has(key)) return;
    if (state.suppressionDepth > 0) {
      state.deliveredTerminalRuns.add(key);
      state.retryableTerminalRuns.delete(key);
      state.retryableTerminalNotices.delete(key);
      return;
    }
    delivery.deliver(key, makeTerminalNotice(run, kind));
  };

  const emitStageAwaitingInputNoticeOnce = (
    run: RunSnapshot,
    stage: StageSnapshot,
  ): void => {
    if (stage.status !== "awaiting_input") return;

    const key = awaitingInputKey(run.id, stage);
    if (state.deliveredInputPrompts.has(key)) return;

    state.deliveredInputPrompts.add(key);
    // Awaiting-input states are tracked for dedupe/restore, but must not enqueue
    // a main-chat steer turn. Waking the active agent with an actionable prompt
    // can let the model answer workflow HIL without a deliberate user action.
  };

  const emitRunAwaitingInputNoticeOnce = (run: RunSnapshot): void => {
    if (run.pendingPrompt === undefined) return;

    const key = runAwaitingInputKey(run.id, run.pendingPrompt);
    if (state.deliveredInputPrompts.has(key)) return;

    state.deliveredInputPrompts.add(key);
    // See stage-level awaiting-input handling above: prompt state remains visible
    // through workflow status/connect surfaces instead of the main chat context.
  };

  const inspect = (snapshot: StoreSnapshot): void => {
    for (const run of snapshot.runs) {
      if (!isTopLevelWorkflowRun(run)) continue;
      emitTerminalNoticeOnce(run, "completed");
      emitTerminalNoticeOnce(run, "failed");
      emitTerminalNoticeOnce(run, "blocked");

      if (!notifyOn.has("awaiting_input")) continue;
      emitRunAwaitingInputNoticeOnce(run);
      for (const stage of run.stages) {
        emitStageAwaitingInputNoticeOnce(run, stage);
      }
    }
  };
  delivery = createLifecycleNoticeDelivery({ state, emit, eligible: (details) => notifyOn.has(details.kind) });
  for (const [key, details] of state.retryableTerminalNotices) {
    if (notifyOn.has(details.kind)) delivery.deliver(key, details);
  }

  const unsubscribe = options.store.subscribe(inspect);
  inspect(options.store.snapshot());
  return () => {
    unsubscribe();
    delivery.dispose();
  };
}

export function registerLifecycleNoticeRenderer(
  options: Pick<WorkflowLifecycleNotificationOptions, "registerMessageRenderer" | "rendererHost">,
): void {
  const register = options.registerMessageRenderer;
  if (typeof register !== "function") return;

  const host = options.rendererHost ?? register;
  if (rendererRegisteredHosts.has(host)) return;

  const renderer: RawRenderer = (raw, _options, piTheme) => {
    const message = raw as { details?: WorkflowLifecycleNoticeDetails };
    if (!message.details) return undefined;
    return makeNoticeComponent(message.details, themeFromRenderer(piTheme));
  };

  register(LIFECYCLE_NOTICE_CUSTOM_TYPE, renderer);
  rendererRegisteredHosts.add(host);
}

export function formatWorkflowLifecycleNoticeText(details: WorkflowLifecycleNoticeDetails): string {
  const workflowName = escapeQuotedText(details.workflowName);
  if (details.kind === "completed") {
    return `✓ Workflow "${workflowName}" completed (run ${details.runId}). Inspect: /workflow status ${details.runId}`;
  }
  if (details.kind === "failed") {
    const stage = details.stageName ?? details.failedStageId ?? details.stageId;
    const tool = lifecycleToolOrigin(details);
    const originText = stage ? `, stage ${stage}` : tool !== undefined ? `, tool ${tool}` : "";
    const errorText = details.error ? `: ${details.error}` : "";
    return `✗ Workflow "${workflowName}" failed (run ${details.runId}${originText})${errorText}. Inspect: /workflow status ${details.runId}`;
  }
  if (details.kind === "blocked") {
    const errorText = details.error ? `: ${details.error}` : "";
    const stateText = details.active === true ? "is blocked" : "ended blocked";
    return `! Workflow "${workflowName}" ${stateText} (run ${details.runId})${errorText}. Inspect: /workflow status ${details.runId}`;
  }
  const prompt = details.promptMessage ? ` Prompt: ${details.promptMessage}` : "";
  if (details.scope === "run") {
    return `？ Workflow "${workflowName}" needs input (run ${details.runId}).${prompt} Respond: /workflow connect ${details.runId} to answer this run-level prompt.`;
  }
  const stage = details.stageName ?? details.stageId ?? "unknown";
  const responseHint = details.stageId && details.promptId
    ? `/workflow connect ${details.runId} or workflow({ action: "send", runId: ${jsonString(details.runId)}, stageId: ${jsonString(details.stageId)}, promptId: ${jsonString(details.promptId)}, response: ... })`
    : `/workflow connect ${details.runId}`;
  return `？ Workflow "${workflowName}" needs input (run ${details.runId}, stage ${stage}).${prompt} Respond: ${responseHint}.`;
}

function makeTerminalNotice(
  run: RunSnapshot,
  kind: "completed" | "failed" | "blocked",
): WorkflowLifecycleNoticeDetails {
  const failedStage = run.failedStageId
    ? run.stages.find((stage) => stage.id === run.failedStageId)
    : undefined;
  const failedTool = kind === "failed"
    ? [...(run.toolNodes ?? [])].reverse().find((node) => node.status === "failed" || node.status === "cancelled")
    : undefined;
  const activeBlocked = kind === "blocked" && isActiveRecoverableBlockedRun(run);
  const error = activeBlocked
    ? run.failureMessage ?? structuredRecoverableWorkflowFailureText(run) ?? run.error
    : run.error ?? returnedNoticeError(run, kind) ?? (kind === "blocked" ? run.exitReason : undefined);
  return {
    kind,
    scope: "run",
    runId: run.id,
    workflowName: run.name,
    status: effectiveRunStatus(run),
    ...(activeBlocked ? { active: true } : {}),
    ...(error ? { error: truncateSnippet(error) } : {}),
    ...(run.failedStageId ? { failedStageId: run.failedStageId } : {}),
    ...(failedStage ? { stageId: failedStage.id, stageName: failedStage.name } : {}),
    ...(failedTool ? { toolNodeId: failedTool.id, toolName: failedTool.name } : {}),
    ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
    createdAt: lifecycleOccurrenceAt(run, kind) ?? Date.now(),
  };
}

function warnLifecycleSendFailure(error: unknown): void {
  if (process.env.ATOMIC_WORKFLOW_DEBUG !== "1") return;
  const message = error instanceof Error ? error.message : String(error);
  console.warn("[workflows] workflow lifecycle notice send failed", message);
}

function escapeQuotedText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

function terminalNoticeKind(run: RunSnapshot): "completed" | "failed" | "blocked" | undefined {
  if (isActiveRecoverableBlockedRun(run)) return "blocked";
  const status = effectiveRunStatus(run);
  if (status === "failed" || status === "blocked") return status;
  if (status !== "completed") return undefined;
  return "completed";
}

function isActiveRecoverableBlockedRun(run: RunSnapshot): boolean {
  return run.blockedAt !== undefined && structuredRecoverableWorkflowFailureText(run) !== undefined;
}

function lifecycleOccurrenceAt(
  run: RunSnapshot,
  kind: "completed" | "failed" | "blocked",
): number | undefined {
  if (kind === "blocked" && isActiveRecoverableBlockedRun(run)) return run.blockedAt;
  return run.endedAt;
}

function returnedNoticeError(run: RunSnapshot, kind: "completed" | "failed" | "blocked"): string | undefined {
  const structuredFailureText = structuredRecoverableWorkflowFailureText(run);
  if (kind === "blocked" && structuredFailureText !== undefined) return structuredFailureText;
  const returnedStatus = normalizeReturnedWorkflowStatus(run.result?.["status"]);
  if (returnedStatus === undefined) return undefined;
  if (kind === "failed" && returnedStatus === "failed") return actionableReturnedStatusText(run.result);
  if (kind === "blocked" && isReturnedBlockedWorkflowStatus(returnedStatus)) return actionableReturnedStatusText(run.result);
  return undefined;
}

function terminalRunKey(kind: "completed" | "failed" | "blocked", run: RunSnapshot): string {
  const occurrence = kind === "blocked" ? run.blockedAt ?? lifecycleOccurrenceAt(run, kind) : "";
  return occurrence === undefined ? `${kind}:${run.id}` : `${kind}:${run.id}:${occurrence}`;
}

function awaitingInputKey(runId: string, stage: StageSnapshot): string {
  const promptId = stage.pendingPrompt?.id ?? stage.inputRequest?.id;
  if (promptId) return `awaiting_input:${runId}:stage:${stage.id}:${promptId}`;
  return `awaiting_input:${runId}:stage:${stage.id}:${stage.awaitingInputSince ?? "active"}`;
}

function runAwaitingInputKey(runId: string, prompt: PendingPrompt): string {
  return `awaiting_input:${runId}:run:${prompt.id}`;
}
function lifecycleToolOrigin(details: WorkflowLifecycleNoticeDetails): string | undefined {
  return details.toolName !== undefined && details.toolName.length > 0 ? details.toolName : details.toolNodeId;
}
function truncateSnippet(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= LIFECYCLE_NOTICE_SNIPPET_LIMIT) return normalized;
  return `${normalized.slice(0, LIFECYCLE_NOTICE_SNIPPET_LIMIT - 1)}…`;
}

function makeNoticeComponent(
  details: WorkflowLifecycleNoticeDetails,
  theme: GraphTheme | undefined,
): PiMessageRenderComponent {
  const text = formatWorkflowLifecycleNoticeText(details);
  return {
    render(width: number): string[] {
      // Width < 32 cannot carry rounded card chrome without exceeding the
      // terminal, so the card helper falls back to wrapped plain text there.
      return renderLifecycleNoticeCard(details, { width, theme, fallbackText: text });
    },
    invalidate() {
      /* stored lifecycle notices are immutable */
    },
  };
}

function renderLifecycleNoticeCard(
  details: WorkflowLifecycleNoticeDetails,
  opts: { width: number; theme?: GraphTheme; fallbackText: string },
): string[] {
  const tone: WorkflowNoticeTone = details.kind === "failed"
    ? "error"
    : details.kind === "awaiting_input" || details.kind === "blocked"
      ? "warning"
      : "success";
  const title = details.kind === "failed"
    ? "WORKFLOW FAILED"
    : details.kind === "awaiting_input"
      ? "WORKFLOW INPUT"
      : details.kind === "blocked"
        ? "WORKFLOW BLOCKED"
        : "WORKFLOW COMPLETE";
  const glyph = details.kind === "failed" ? "✗" : details.kind === "awaiting_input" ? "？" : details.kind === "blocked" ? "!" : "✓";
  const stage = details.stageName ?? details.failedStageId ?? details.stageId;
  const tool = stage === undefined ? lifecycleToolOrigin(details) : undefined;
  const headline = details.kind === "failed"
    ? `Workflow "${details.workflowName}" failed`
    : details.kind === "awaiting_input"
      ? `Workflow "${details.workflowName}" needs input`
      : details.kind === "blocked"
        ? `Workflow "${details.workflowName}" ${details.active === true ? "is blocked" : "ended blocked"}`
        : `Workflow "${details.workflowName}" completed`;
  return renderWorkflowNoticeCard({
    title,
    glyph,
    headline,
    tone,
    fields: [
      { label: "workflow", value: details.workflowName },
      { label: "run", value: details.runId },
      { label: "stage", value: stage },
      { label: "tool", value: tool },
      { label: "prompt", value: details.promptMessage, tone: "muted" },
      { label: "error", value: details.error, tone: "error" },
      { label: "duration", value: formatDurationMs(details.durationMs), tone: "muted" },
    ],
    hints: [details.kind === "awaiting_input" ? `/workflow connect ${details.runId}` : `/workflow status ${details.runId}`],
    fallbackText: opts.fallbackText,
    width: opts.width,
    ...(opts.theme ? { theme: opts.theme } : {}),
  });
}

function formatDurationMs(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined;
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function themeFromRenderer(piTheme: unknown): GraphTheme | undefined {
  return piTheme === undefined ? undefined : deriveGraphThemeFromPiTheme(piTheme);
}
