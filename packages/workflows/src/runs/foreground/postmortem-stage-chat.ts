/**
 * Post-mortem stage-chat resolver.
 *
 * Generalizes the safe detached-handle pattern introduced by completed
 * durable-workflow inspection (#1758) so any eligible terminal agent stage
 * with a valid retained Atomic session can be reopened as an interactive
 * post-mortem chat — from generic `/workflow attach` / `/workflow connect`,
 * restored/replayed durable snapshots, and `workflow send` — not only the
 * dedicated completed-inspection path.
 *
 * A post-mortem chat appends follow-up conversation to the stage's retained
 * session (append-in-place, matching same-process handles and #1758). It never
 * resumes, retries, rewinds, or otherwise mutates workflow execution: the
 * handle is detached from run-level pause/resume control from birth and cannot
 * pause/resume the workflow DAG. Tool side effects from follow-up turns are
 * possible (the agent keeps its ordinary tools); only the workflow execution
 * state is immutable.
 *
 * The resolver deliberately does NOT fabricate a `LiveStageRuntime`: that
 * carries scheduler, store-mutation, exit, failure, and finalization
 * dependencies a post-mortem conversation must never receive.
 *
 * cross-ref:
 *   - src/durable/completed-inspection.ts (authoritative completed catalog/open)
 *   - src/runs/foreground/stage-control-registry.ts (get-or-create ownership)
 *   - src/shared/session-transcript.ts (retained-session validation)
 */
import type { StageSnapshot } from "../../shared/store-types.js";
import { isReopenableSessionTranscript } from "../../shared/session-transcript.js";
import { createStageContext, type StageAdapters } from "./stage-runner.js";
import {
  type AgentSessionEventListener,
  type StageControlHandle,
  type StageControlRegistry,
} from "./stage-control-registry.js";

/** Why a terminal stage could not be revived as an interactive post-mortem chat. */
export type PostMortemUnavailableReason =
  | "no_adapter"
  | "not_terminal"
  | "no_session"
  | "invalid_session";

export type EnsurePostMortemStageHandleResult =
  | { readonly ok: true; readonly handle: StageControlHandle }
  | { readonly ok: false; readonly reason: PostMortemUnavailableReason };

export interface PostMortemStageChatDeps {
  readonly registry: StageControlRegistry;
  readonly adapters?: StageAdapters;
  /** Working directory used when reopening the retained session. */
  readonly cwd?: string;
  /** Default stage session directory to restore after a host restart. */
  readonly defaultSessionDir?: string;
}

/** Terminal statuses whose retained agent session may be reopened for follow-up. */
const TERMINAL_POSTMORTEM_STATUSES = new Set<StageSnapshot["status"]>(["completed"]);

/**
 * True when the snapshot is an eligible terminal agent stage: a completed stage
 * that retains a `sessionFile`. Prompt/boundary/summary/skipped nodes without
 * their own agent session are excluded because they have no `sessionFile`.
 */
export function isPostMortemEligibleStage(stage: StageSnapshot): boolean {
  return TERMINAL_POSTMORTEM_STATUSES.has(stage.status)
    && typeof stage.sessionFile === "string"
    && stage.sessionFile.length > 0;
}

/**
 * Resolve an interactive post-mortem chat handle for a terminal agent stage.
 *
 * Reuses an existing non-disposed registry handle when present; otherwise
 * validates the retained session and lazily creates a detached, single-flight
 * handle keyed by the real `{ runId, stageId }`. Returns an explicit
 * unavailable reason so callers can preserve the read-only transcript.
 */
export function ensurePostMortemStageHandle(
  runId: string,
  stage: StageSnapshot,
  deps: PostMortemStageChatDeps,
): EnsurePostMortemStageHandleResult {
  const existing = deps.registry.get(runId, stage.id);
  if (existing !== undefined && existing.isDisposed !== true) {
    return { ok: true, handle: existing };
  }
  if (deps.adapters?.agentSession === undefined) return { ok: false, reason: "no_adapter" };
  if (!TERMINAL_POSTMORTEM_STATUSES.has(stage.status)) return { ok: false, reason: "not_terminal" };
  const sessionFile = stage.sessionFile;
  if (typeof sessionFile !== "string" || sessionFile.length === 0) return { ok: false, reason: "no_session" };
  if (!isReopenableSessionTranscript(sessionFile)) return { ok: false, reason: "invalid_session" };

  const adapters = deps.adapters;
  const handle = deps.registry.getOrCreateDetached(runId, stage.id, () =>
    createPostMortemStageHandle(runId, stage, sessionFile, adapters, deps.cwd, deps.defaultSessionDir),
  );
  return { ok: true, handle };
}

/**
 * Build a lazy session-only stage-control handle that reopens `sessionFile` on
 * first use and appends follow-up conversation without dispatching the
 * workflow. Pause/resume of workflow execution is rejected.
 */
export function createPostMortemStageHandle(
  runId: string,
  stage: Pick<StageSnapshot, "id" | "name" | "sessionId">,
  sessionFile: string,
  adapters: StageAdapters,
  cwd: string | undefined,
  defaultSessionDir: string | undefined,
): StageControlHandle {
  const context = createStageContext({
    runId,
    stageId: stage.id,
    stageName: stage.name,
    adapters,
    stageOptions: {
      resumeFromSessionFile: sessionFile,
      ...(cwd !== undefined ? { cwd } : {}),
    },
    ...(defaultSessionDir !== undefined ? { defaultSessionDir } : {}),
  });
  let disposed = false;
  const ensureAttached = async (): Promise<void> => {
    if (disposed) throw new Error(`Post-mortem stage chat "${stage.name}" is closed.`);
    if (context.__sessionMeta().sessionFile === undefined) {
      await context.__ensureSessionFromFile(sessionFile);
    }
  };
  return {
    runId,
    stageId: stage.id,
    stageName: stage.name,
    status: "completed",
    get sessionId() { return context.__sessionMeta().sessionId ?? stage.sessionId; },
    get sessionFile() { return context.__sessionMeta().sessionFile ?? sessionFile; },
    get isStreaming() { return context.isStreaming; },
    get isDisposed() { return disposed; },
    get messages() { return context.messages; },
    get agentSession() { return context.__agentSession(); },
    async ensureAttached() { await ensureAttached(); },
    async prompt(text: string) {
      await ensureAttached();
      await context.prompt(text);
    },
    async steer(text: string) {
      await ensureAttached();
      await context.steer(text);
    },
    async followUp(text: string) {
      await ensureAttached();
      await context.followUp(text);
    },
    async pause() {
      throw new Error("Post-mortem stage chat cannot pause or resume workflow execution.");
    },
    async resume() {
      throw new Error("Post-mortem stage chat cannot pause or resume workflow execution.");
    },
    subscribe(listener: AgentSessionEventListener) { return context.subscribe(listener); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await context.__dispose();
    },
  };
}
