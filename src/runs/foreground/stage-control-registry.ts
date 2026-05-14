/**
 * Live stage-control registry — runtime-only handle table keyed by
 * `runId + stageId`. Snapshots in `StoreSnapshot` are JSON-cloned and
 * cannot carry function/AgentSession references, so live "attach a
 * pane to this stage" wiring lives here instead.
 *
 * The registry exposes:
 *  - `StageControlHandle` — per-stage prompt/steer/follow-up/pause/resume
 *    surface used by the attached chat pane.
 *  - `WorkflowRunControlHandle` — per-run aggregate used by `/workflow pause`
 *    and `/workflow resume` to fan an action across the stages that are
 *    actually pausable right now.
 *
 * The registry does not know about Pi SDK details; it talks to the
 * stage-runner via a small interface so tests can fake it without a real
 * `AgentSession`.
 *
 * cross-ref:
 *   - src/runs/foreground/stage-runner.ts (InternalStageContext)
 *   - src/runs/foreground/executor.ts (registers/unregisters handles)
 *   - pi docs/sdk.md (AgentSession.prompt/steer/followUp/abort)
 */

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type StageControlStatus =
  | "pending"
  | "running"
  | "awaiting_input"
  | "paused"
  | "blocked"
  | "completed"
  | "failed";

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

/**
 * Per-stage interactive surface exposed to the attached chat pane.
 *
 * Implementations wrap an `InternalStageContext` (which lazily creates
 * the underlying Pi SDK `AgentSession`) and add controlled pause/resume
 * semantics that the raw SDK does not provide.
 */
export interface StageControlHandle {
  readonly runId: string;
  readonly stageId: string;
  readonly stageName: string;
  readonly status: StageControlStatus;
  readonly sessionId: string | undefined;
  readonly sessionFile: string | undefined;
  readonly isStreaming: boolean;
  readonly messages: AgentSession["messages"];
  /** Ensure the SDK session exists. Cheap when already attached. */
  ensureAttached(): Promise<void>;
  /** Send a prompt. Use only when the stage is idle / not streaming. */
  prompt(text: string): Promise<void>;
  /** Steer the current streaming operation (interrupt mid-turn). */
  steer(text: string): Promise<void>;
  /** Queue a follow-up after the current operation completes. */
  followUp(text: string): Promise<void>;
  /**
   * True controlled pause. Aborts the current Pi op without finalizing
   * the stage as failed; the original `prompt()` awaiter is held until
   * `resume()` is called.
   */
  pause(): Promise<void>;
  /**
   * Release a paused stage. If `message` is provided it is sent as the
   * next user message before resuming.
   */
  resume(message?: string): Promise<void>;
  /**
   * Subscribe to AgentSession events. The pending-listener semantics
   * from `InternalStageContext.subscribe` apply: listeners registered
   * before the session exists are buffered and bound on first attach.
   */
  subscribe(listener: AgentSessionEventListener): () => void;
}

/**
 * Per-run aggregate. Fans pause/resume to currently-running stage
 * handles. Backed by the same `StageControlRegistry`.
 */
export interface WorkflowRunControlHandle {
  readonly runId: string;
  /** All stage handles known to the registry for this run. */
  stages(): readonly StageControlHandle[];
  /** Currently paused stage handles. */
  pausedStages(): readonly StageControlHandle[];
  /**
   * Pause every currently running stage (or the specific stage when
   * `stageId` is supplied). Returns every handle whose pause state changed,
   * including cascade-blocked descendants; keeping the array return preserves
   * existing slash-command iteration ergonomics.
   */
  pause(stageId?: string): Promise<readonly StageControlHandle[]>;
  /**
   * Resume every paused stage (or the specific stage when `stageId`
   * is supplied). `message`, if given, is forwarded to each resumed
   * stage as the next user message.
   */
  resume(stageId?: string, message?: string): Promise<readonly StageControlHandle[]>;
}

export interface StageControlRegistry {
  /**
   * Register a stage handle. The registry calls `onSettle()` when the
   * handle should be removed (stage completed / failed / killed).
   */
  register(handle: StageControlHandle): () => void;
  /** Resolve a single stage handle by run + stage id. */
  get(runId: string, stageId: string): StageControlHandle | undefined;
  /** Resolve all currently-registered stage handles for a run. */
  forRun(runId: string): readonly StageControlHandle[];
  /** Build a run-level control aggregate. Cheap; not memoised. */
  run(runId: string): WorkflowRunControlHandle;
  /**
   * Drop every registration. Used on session boundaries to release
   * any leaked handles when the host store is cleared.
   */
  clear(): void;
}

/**
 * In-memory implementation. Handles live in a `Map<runId, Map<stageId, handle>>`
 * so per-run lookups stay cheap as workflows scale.
 */
export function createStageControlRegistry(): StageControlRegistry {
  const _byRun = new Map<string, Map<string, StageControlHandle>>();

  function ensureRun(runId: string): Map<string, StageControlHandle> {
    let runMap = _byRun.get(runId);
    if (!runMap) {
      runMap = new Map();
      _byRun.set(runId, runMap);
    }
    return runMap;
  }

  function makeRunHandle(runId: string): WorkflowRunControlHandle {
    return {
      runId,
      stages(): readonly StageControlHandle[] {
        const runMap = _byRun.get(runId);
        if (!runMap) return [];
        return [...runMap.values()];
      },
      pausedStages(): readonly StageControlHandle[] {
        const runMap = _byRun.get(runId);
        if (!runMap) return [];
        return [...runMap.values()].filter((h) => h.status === "paused");
      },
      async pause(stageId?: string): Promise<readonly StageControlHandle[]> {
        const runMap = _byRun.get(runId);
        if (!runMap) return [];
        const targets = stageId
          ? [runMap.get(stageId)].filter((h): h is StageControlHandle => h !== undefined)
          : [...runMap.values()].filter(
              (h) => h.status === "running" || h.status === "pending",
            );
        const before = new Map(
          [...runMap.values()].map((handle) => [handle.stageId, handle.status]),
        );
        for (const handle of targets) {
          if (handle.status === "paused") continue;
          if (handle.status === "completed" || handle.status === "failed") continue;
          await handle.pause();
        }
        return [...runMap.values()].filter((handle) => {
          const previous = before.get(handle.stageId);
          return previous !== handle.status && (handle.status === "paused" || handle.status === "blocked");
        });
      },
      async resume(
        stageId?: string,
        message?: string,
      ): Promise<readonly StageControlHandle[]> {
        const runMap = _byRun.get(runId);
        if (!runMap) return [];
        const before = new Map(
          [...runMap.values()].map((handle) => [handle.stageId, handle.status]),
        );
        const targets = stageId
          ? [runMap.get(stageId)].filter((h): h is StageControlHandle => h !== undefined)
          : [...runMap.values()].filter((h) => h.status === "paused");
        for (const handle of targets) {
          if (handle.status !== "paused") continue;
          await handle.resume(message);
        }
        return [...runMap.values()].filter((handle) => {
          const previous = before.get(handle.stageId);
          return (previous === "paused" || previous === "blocked") && previous !== handle.status;
        });
      },
    };
  }

  return {
    register(handle: StageControlHandle): () => void {
      const runMap = ensureRun(handle.runId);
      runMap.set(handle.stageId, handle);
      return () => {
        const existing = _byRun.get(handle.runId);
        if (!existing) return;
        if (existing.get(handle.stageId) === handle) {
          existing.delete(handle.stageId);
        }
        if (existing.size === 0) _byRun.delete(handle.runId);
      };
    },
    get(runId: string, stageId: string): StageControlHandle | undefined {
      return _byRun.get(runId)?.get(stageId);
    },
    forRun(runId: string): readonly StageControlHandle[] {
      const runMap = _byRun.get(runId);
      if (!runMap) return [];
      return [...runMap.values()];
    },
    run(runId: string): WorkflowRunControlHandle {
      return makeRunHandle(runId);
    },
    clear(): void {
      _byRun.clear();
    },
  };
}

/**
 * Process-wide registry. Tests and embedders SHOULD prefer passing an
 * explicit instance via `RunOpts.stageControlRegistry`; the singleton
 * is the default consumer surface used by the extension factory.
 */
export const stageControlRegistry: StageControlRegistry = createStageControlRegistry();
