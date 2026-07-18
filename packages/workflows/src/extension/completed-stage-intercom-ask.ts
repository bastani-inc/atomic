import type { StageControlHandle } from "../runs/foreground/stage-control-registry.js";
import type {
  EnsurePostMortemStageHandleResult,
  PostMortemUnavailableReason,
} from "../runs/foreground/postmortem-stage-chat.js";

const LATE_STAGE_MESSAGE_EVENT = "atomic:workflow-stage-late-message";
const POST_MORTEM_ATTACH_TIMEOUT_MS = 10_000;

interface IntercomAskMessage {
  readonly customType: "intercom_message";
  readonly content: string;
  readonly details?: {
    readonly message?: {
      readonly expectsReply?: boolean;
    };
  };
}

interface CompletedStageAskEvent {
  handled: boolean;
  completion?: Promise<void>;
  readonly batch: boolean;
  readonly workflowRunId?: string;
  readonly workflowStageId?: string;
  readonly messages: readonly IntercomAskMessage[];
}

interface WorkflowEventSurface {
  readonly events?: {
    on?(event: string, listener: (payload: unknown) => void): (() => void) | void;
  };
  on?(event: "session_shutdown", listener: () => void): void;
}

export type CompletedStageHandleResolver = (
  runId: string,
  stageId: string,
) => EnsurePostMortemStageHandleResult | undefined;

/**
 * Claims late blocking Intercom asks for completed workflow stages and runs one
 * post-mortem turn in the retained conversation. Ordinary late notifications
 * keep using the existing parent-chat route.
 */
export function registerCompletedStageIntercomAskRouter(
  pi: WorkflowEventSurface,
  resolveHandle: CompletedStageHandleResolver,
): () => void {
  const queues = new Map<string, Promise<void>>();
  let disposed = false;
  const unsubscribe = pi.events?.on?.(LATE_STAGE_MESSAGE_EVENT, (payload) => {
    if (disposed || !isCompletedStageAskEvent(payload)) return;
    payload.handled = true;
    payload.completion = enqueueTargetTurn(
      queues,
      `${payload.workflowRunId}:${payload.workflowStageId}`,
      () => deliverAsPostMortemTurn(payload, resolveHandle),
    );
  });
  const dispose = (): void => {
    disposed = true;
    queues.clear();
    unsubscribe?.();
  };
  pi.on?.("session_shutdown", dispose);
  return dispose;
}

function isCompletedStageAskEvent(payload: unknown): payload is CompletedStageAskEvent & {
  readonly workflowRunId: string;
  readonly workflowStageId: string;
} {
  if (typeof payload !== "object" || payload === null) return false;
  const event = payload as Partial<CompletedStageAskEvent>;
  return typeof event.workflowRunId === "string"
    && event.workflowRunId.length > 0
    && typeof event.workflowStageId === "string"
    && event.workflowStageId.length > 0
    && Array.isArray(event.messages)
    && event.messages.length > 0
    && event.messages.every((message) =>
      message?.customType === "intercom_message"
      && typeof message.content === "string"
      && message.details?.message?.expectsReply === true,
    );
}

function enqueueTargetTurn(
  queues: Map<string, Promise<void>>,
  key: string,
  deliver: () => Promise<void>,
): Promise<void> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(deliver);
  queues.set(key, current);
  void current.finally(() => {
    if (queues.get(key) === current) queues.delete(key);
  }).catch(() => {});
  return current;
}

async function deliverAsPostMortemTurn(
  event: CompletedStageAskEvent & { readonly workflowRunId: string; readonly workflowStageId: string },
  resolveHandle: CompletedStageHandleResolver,
): Promise<void> {
  const resolution = resolveHandle(event.workflowRunId, event.workflowStageId);
  if (resolution === undefined) {
    throw new Error(
      `Intercom ask target is unavailable: completed workflow stage ${event.workflowRunId}/${event.workflowStageId} was deleted or is no longer retained.`,
    );
  }
  if (!resolution.ok) {
    throw new Error(unavailableReason(event.workflowRunId, event.workflowStageId, resolution.reason));
  }
  const handle = resolution.handle;
  if (handle.status !== "completed" || handle.isDisposed === true) {
    throw new Error(
      `Intercom ask target is not resumable: workflow stage ${event.workflowRunId}/${event.workflowStageId} has no retained completed conversation.`,
    );
  }
  await attachWithTimeout(handle);
  for (const message of event.messages) {
    if (handle.isStreaming) await handle.followUp(message.content);
    else await handle.prompt(message.content);
  }
}

async function attachWithTimeout(handle: StageControlHandle): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(
      `Intercom ask target failed to resume within ${POST_MORTEM_ATTACH_TIMEOUT_MS}ms: retained stage conversation ${handle.runId}/${handle.stageId}.`,
    )), POST_MORTEM_ATTACH_TIMEOUT_MS);
  });
  try {
    await Promise.race([handle.ensureAttached(), bounded]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function unavailableReason(runId: string, stageId: string, reason: PostMortemUnavailableReason): string {
  const target = `${runId}/${stageId}`;
  switch (reason) {
    case "not_terminal":
      return `Intercom ask target is not resumable: workflow stage ${target} is not a completed stage with a retained conversation.`;
    case "no_session":
      return `Intercom ask target is unavailable: completed workflow stage ${target} has no retained conversation.`;
    case "invalid_session":
      return `Intercom ask target is unavailable: retained conversation for completed workflow stage ${target} is missing, deleted, or invalid.`;
    case "no_adapter":
      return `Intercom ask target is not resumable: no workflow stage session adapter can reopen ${target}.`;
  }
}
