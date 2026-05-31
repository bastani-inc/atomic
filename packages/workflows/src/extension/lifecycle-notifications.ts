import type {
  ExtensionAPI,
  PiMessageRenderComponent,
  PiMessageRendererResult,
} from "./index.js";
import type { Store } from "../shared/store.js";
import type {
  PendingPrompt,
  PromptKind,
  RunSnapshot,
  RunStatus,
  StageSnapshot,
  StageStatus,
  StoreSnapshot,
} from "../shared/store-types.js";
import { wrapPlainText } from "../tui/text-helpers.js";

export const LIFECYCLE_NOTICE_CUSTOM_TYPE = "workflows:lifecycle-notice";
export const LIFECYCLE_NOTICE_SNIPPET_LIMIT = 240;

export type WorkflowLifecycleNoticeKind = "completed" | "failed" | "awaiting_input";

export const WORKFLOW_LIFECYCLE_NOTICE_KINDS = [
  "completed",
  "failed",
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
  readonly promptKind?: PromptKind;
  readonly promptMessage?: string;
  readonly error?: string;
  readonly failedStageId?: string;
  readonly durationMs?: number;
  readonly createdAt: number;
}

export interface WorkflowLifecycleNotificationState {
  readonly deliveredTerminalRuns: Set<string>;
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

type RawRenderer = (payload: unknown) => PiMessageRendererResult;

// Process-lifetime registration dedupe: extension hosts are object identities
// and may be garbage-collected, but renderer registrations are not unregistered.
const rendererRegisteredHosts = new WeakSet<object>();

export function createWorkflowLifecycleNotificationState(): WorkflowLifecycleNotificationState {
  return {
    deliveredTerminalRuns: new Set<string>(),
    deliveredInputPrompts: new Set<string>(),
    suppressionDepth: 0,
  };
}

export function resetWorkflowLifecycleNotificationState(
  state: WorkflowLifecycleNotificationState,
): void {
  state.deliveredTerminalRuns.clear();
  state.deliveredInputPrompts.clear();
  state.suppressionDepth = 0;
}

export function seedWorkflowLifecycleNotificationState(
  state: WorkflowLifecycleNotificationState,
  snapshot: StoreSnapshot,
): void {
  for (const run of snapshot.runs) {
    if ((run.status === "completed" || run.status === "failed") && run.endedAt !== undefined) {
      state.deliveredTerminalRuns.add(terminalRunKey(run.status, run.id));
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

export function installWorkflowLifecycleNotifications(
  options: WorkflowLifecycleNotificationOptions,
): () => void {
  registerLifecycleNoticeRenderer(options);

  if (!options.config.enabled) return () => undefined;
  const send = options.sendMessage;
  if (typeof send !== "function") return () => undefined;

  const notifyOn = new Set<WorkflowLifecycleNoticeKind>(options.config.notifyOn);
  const state = options.state ?? createWorkflowLifecycleNotificationState();
  if (options.seedExisting !== false) {
    seedWorkflowLifecycleNotificationState(state, options.store.snapshot());
  }

  const emit = (details: WorkflowLifecycleNoticeDetails): void => {
    const content = formatWorkflowLifecycleNoticeText(details);
    const deliveryOptions = details.kind === "awaiting_input"
      // Awaiting-input notices are informational UI hints. Do not enqueue a
      // steer turn for them: a workflow can resolve the prompt and complete
      // before the queued turn renders, leaving a stale red/actionable
      // `/workflow connect` notification after completion.
      ? { triggerTurn: false, deliverAs: "steer" as const }
      : { triggerTurn: true, deliverAs: "steer" as const };
    try {
      // Store subscribers are notified in a tight loop. A lifecycle notice
      // failure must never abort sibling subscribers such as status writers.
      void Promise.resolve(
        send(
          {
            customType: LIFECYCLE_NOTICE_CUSTOM_TYPE,
            content,
            display: true,
            details,
          },
          deliveryOptions,
        ),
      ).catch((error: unknown) => warnLifecycleSendFailure(error));
    } catch (error) {
      warnLifecycleSendFailure(error);
      // Best-effort notification only; keep store delivery isolated.
    }
  };

  const emitTerminalNoticeOnce = (
    run: RunSnapshot,
    kind: "completed" | "failed",
  ): void => {
    if (run.status !== kind || run.endedAt === undefined || !notifyOn.has(kind)) {
      return;
    }

    const key = terminalRunKey(kind, run.id);
    if (state.deliveredTerminalRuns.has(key)) return;

    state.deliveredTerminalRuns.add(key);
    if (state.suppressionDepth > 0) return;
    emit(makeTerminalNotice(run, kind));
  };

  const emitStageAwaitingInputNoticeOnce = (
    run: RunSnapshot,
    stage: StageSnapshot,
  ): void => {
    if (stage.status !== "awaiting_input") return;

    const key = awaitingInputKey(run.id, stage);
    if (state.deliveredInputPrompts.has(key)) return;

    state.deliveredInputPrompts.add(key);
    if (state.suppressionDepth > 0) return;
    emit(makeStageAwaitingInputNotice(run, stage));
  };

  const emitRunAwaitingInputNoticeOnce = (run: RunSnapshot): void => {
    if (run.pendingPrompt === undefined) return;

    const key = runAwaitingInputKey(run.id, run.pendingPrompt);
    if (state.deliveredInputPrompts.has(key)) return;

    state.deliveredInputPrompts.add(key);
    if (state.suppressionDepth > 0) return;
    emit(makeRunAwaitingInputNotice(run, run.pendingPrompt));
  };

  const inspect = (snapshot: StoreSnapshot): void => {
    for (const run of snapshot.runs) {
      emitTerminalNoticeOnce(run, "completed");
      emitTerminalNoticeOnce(run, "failed");

      if (!notifyOn.has("awaiting_input")) continue;
      emitRunAwaitingInputNoticeOnce(run);
      for (const stage of run.stages) {
        emitStageAwaitingInputNoticeOnce(run, stage);
      }
    }
  };

  return options.store.subscribe(inspect);
}

export function registerLifecycleNoticeRenderer(
  options: Pick<WorkflowLifecycleNotificationOptions, "registerMessageRenderer" | "rendererHost">,
): void {
  const register = options.registerMessageRenderer;
  if (typeof register !== "function") return;

  const host = options.rendererHost ?? register;
  if (rendererRegisteredHosts.has(host)) return;

  const renderer: RawRenderer = (raw) => {
    const message = raw as { details?: WorkflowLifecycleNoticeDetails };
    if (!message.details) return undefined;
    return makeNoticeComponent(message.details);
  };

  register(LIFECYCLE_NOTICE_CUSTOM_TYPE, renderer);
  rendererRegisteredHosts.add(host);
}

export function formatWorkflowLifecycleNoticeText(details: WorkflowLifecycleNoticeDetails): string {
  const workflowName = escapeQuotedText(details.workflowName);
  if (details.kind === "completed") {
    return `✅ Workflow "${workflowName}" completed (run ${details.runId}). Inspect: /workflow status ${details.runId}`;
  }
  if (details.kind === "failed") {
    const stage = details.stageName ?? details.failedStageId;
    const stageText = stage ? `, stage ${stage}` : "";
    const errorText = details.error ? `: ${details.error}` : "";
    return `❌ Workflow "${workflowName}" failed (run ${details.runId}${stageText})${errorText}. Inspect: /workflow status ${details.runId}`;
  }
  const prompt = details.promptMessage ? ` Prompt: ${details.promptMessage}` : "";
  if (details.scope === "run") {
    return `❓ Workflow "${workflowName}" needs input (run ${details.runId}).${prompt} Respond: /workflow connect ${details.runId} to answer this run-level prompt.`;
  }
  const stage = details.stageName ?? details.stageId ?? "unknown";
  const responseHint = details.stageId && details.promptId
    ? `/workflow connect ${details.runId} or workflow({ action: "send", runId: ${jsonString(details.runId)}, stageId: ${jsonString(details.stageId)}, promptId: ${jsonString(details.promptId)}, response: ... })`
    : `/workflow connect ${details.runId}`;
  return `❓ Workflow "${workflowName}" needs input (run ${details.runId}, stage ${stage}).${prompt} Respond: ${responseHint}.`;
}

function makeTerminalNotice(
  run: RunSnapshot,
  kind: "completed" | "failed",
): WorkflowLifecycleNoticeDetails {
  const failedStage = run.failedStageId
    ? run.stages.find((stage) => stage.id === run.failedStageId)
    : undefined;
  return {
    kind,
    scope: "run",
    runId: run.id,
    workflowName: run.name,
    status: run.status,
    ...(run.error ? { error: truncateSnippet(run.error) } : {}),
    ...(run.failedStageId ? { failedStageId: run.failedStageId } : {}),
    ...(failedStage ? { stageId: failedStage.id, stageName: failedStage.name } : {}),
    ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
    // Normal store paths stamp endedAt; Date.now() is defensive for malformed restored snapshots.
    createdAt: run.endedAt ?? Date.now(),
  };
}

function makeStageAwaitingInputNotice(run: RunSnapshot, stage: StageSnapshot): WorkflowLifecycleNoticeDetails {
  const prompt = stage.pendingPrompt;
  return {
    kind: "awaiting_input",
    scope: "stage",
    runId: run.id,
    workflowName: run.name,
    status: stage.status,
    stageId: stage.id,
    stageName: stage.name,
    ...(prompt ? promptFields(prompt) : {}),
    // Normal store paths stamp awaitingInputSince; Date.now() is defensive for malformed restored snapshots.
    createdAt: prompt?.createdAt ?? stage.awaitingInputSince ?? Date.now(),
  };
}

function makeRunAwaitingInputNotice(run: RunSnapshot, prompt: PendingPrompt): WorkflowLifecycleNoticeDetails {
  return {
    kind: "awaiting_input",
    scope: "run",
    runId: run.id,
    workflowName: run.name,
    status: run.status,
    ...promptFields(prompt),
    createdAt: prompt.createdAt,
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

function terminalRunKey(kind: "completed" | "failed", runId: string): string {
  return `${kind}:${runId}`;
}

function promptFields(
  prompt: PendingPrompt,
): Pick<WorkflowLifecycleNoticeDetails, "promptId" | "promptKind" | "promptMessage"> {
  return {
    promptId: prompt.id,
    promptKind: prompt.kind,
    promptMessage: truncateSnippet(prompt.message),
  };
}

function awaitingInputKey(runId: string, stage: StageSnapshot): string {
  const promptId = stage.pendingPrompt?.id;
  if (promptId) return `awaiting_input:${runId}:stage:${stage.id}:${promptId}`;
  return `awaiting_input:${runId}:stage:${stage.id}:${stage.awaitingInputSince ?? "active"}`;
}

function runAwaitingInputKey(runId: string, prompt: PendingPrompt): string {
  return `awaiting_input:${runId}:run:${prompt.id}`;
}

function truncateSnippet(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= LIFECYCLE_NOTICE_SNIPPET_LIMIT) return normalized;
  return `${normalized.slice(0, LIFECYCLE_NOTICE_SNIPPET_LIMIT - 1)}…`;
}

function makeNoticeComponent(details: WorkflowLifecycleNoticeDetails): PiMessageRenderComponent {
  const text = formatWorkflowLifecycleNoticeText(details);
  return {
    render(width: number): string[] {
      // Wrap to the render width so a long run id / workflow name never emits a
      // line wider than the terminal. pi-tui hard-throws ("Rendered line N
      // exceeds terminal width") on any over-wide rendered line, which would
      // crash the whole TUI on narrow terminals or after a resize (#1109).
      // `wrapPlainText` hard-breaks long unbreakable tokens (e.g. UUIDs), so
      // every returned line is guaranteed to fit within `width`.
      return wrapPlainText(text, width);
    },
    invalidate() {
      /* stored lifecycle notices are immutable */
    },
  };
}
