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
 * A completed stage may keep its chat handle alive while being detached from
 * run-level pause/resume control. That lets the chat stay interactive without
 * letting a finished stage keep blocking or pausing downstream work.
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

import type { AgentSession, AgentSessionEvent } from "@bastani/atomic";

export type StageControlStatus =
  | "pending"
  | "running"
  | "awaiting_input"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "skipped";

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
  /** True after the executor has released the live SDK session behind this handle. */
  readonly isDisposed?: boolean;
  readonly messages: AgentSession["messages"];
  /** Live coding-agent session when available, used by embedded chat/footer UI. */
  readonly agentSession?: AgentSession;
  /** Replayable in-flight tool starts/partial updates for stage-chat remounts. */
  pendingToolExecutionEvents?(): readonly AgentSessionEvent[];
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
  /** Release the underlying SDK session and unregister this direct chat handle. */
  dispose?(): void | Promise<void>;
}

/**
 * Per-run aggregate. Fans pause/resume to currently-running stage
 * handles. Backed by the same `StageControlRegistry`.
 */
export interface WorkflowRunControlHandle {
  readonly runId: string;
  /** Stage handles still participating in run-level workflow control. */
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
   * Register a stage handle. The returned disposer removes the chat handle
   * entirely. Stage completion should normally call `detachControl()` first so
   * run-level pause/resume stops seeing the stage while any open chat pane can
   * keep using its direct handle reference.
   */
  register(handle: StageControlHandle): () => void;
  /**
   * Atomically resolve an existing non-disposed handle for `runId + stageId`
   * or create one via `create`, register it, and immediately detach it from
   * run-level pause/resume control. Used by the post-mortem stage-chat
   * resolver so repeated attach/send calls single-flight onto one detached
   * writer per real stage instead of racing competing sessions.
   */
  getOrCreateDetached(
    runId: string,
    stageId: string,
    create: () => StageControlHandle,
  ): StageControlHandle;
  /**
   * Remove this stage from run-level pause/resume aggregates while keeping
   * `get()` chat attachment live until the registration disposer runs.
   */
  detachControl(runId: string, stageId: string, handle?: StageControlHandle): boolean;
  /** Resolve a single stage handle by run + stage id, including detached chats. */
  get(runId: string, stageId: string): StageControlHandle | undefined;
  /** Resolve all currently-registered chat handles for a run. */
  forRun(runId: string): readonly StageControlHandle[];
  /** Build a run-level control aggregate. Cheap; not memoised. */
  run(runId: string): WorkflowRunControlHandle;
  /**
   * Drop every registration and invoke each handle's optional dispose hook.
   * Used on session boundaries to release retained direct chat handles and
   * their subscriptions when the host store is cleared.
   */
  clear(): void;
}

/**
 * In-memory implementation. Handles live in a `Map<runId, Map<stageId, handle>>`
 * so per-run lookups stay cheap as workflows scale.
 */
export function createStageControlRegistry(): StageControlRegistry {
  type RegistryEntry = {
    handle: StageControlHandle;
    controlsDependencies: boolean;
  };

  const _byRun = new Map<string, Map<string, RegistryEntry>>();

  function ensureRun(runId: string): Map<string, RegistryEntry> {
    let runMap = _byRun.get(runId);
    if (!runMap) {
      runMap = new Map();
      _byRun.set(runId, runMap);
    }
    return runMap;
  }

  function controlledEntries(runId: string): RegistryEntry[] {
    const runMap = _byRun.get(runId);
    if (!runMap) return [];
    return [...runMap.values()].filter((entry) => entry.controlsDependencies);
  }

  function makeRunHandle(runId: string): WorkflowRunControlHandle {
    return {
      runId,
      stages(): readonly StageControlHandle[] {
        return controlledEntries(runId).map((entry) => entry.handle);
      },
      pausedStages(): readonly StageControlHandle[] {
        return controlledEntries(runId)
          .map((entry) => entry.handle)
          .filter((h) => h.status === "paused");
      },
      async pause(stageId?: string): Promise<readonly StageControlHandle[]> {
        const runMap = _byRun.get(runId);
        if (!runMap) return [];
        const controlEntries = controlledEntries(runId);
        const targets = stageId
          ? [runMap.get(stageId)]
              .filter(
                (entry): entry is RegistryEntry => entry !== undefined && entry.controlsDependencies,
              )
              .map((entry) => entry.handle)
          : controlEntries
              .map((entry) => entry.handle)
              .filter((h) => h.status === "running" || h.status === "pending");
        const before = new Map(
          controlEntries.map((entry) => [entry.handle.stageId, entry.handle.status]),
        );
        for (const handle of targets) {
          if (handle.status === "paused") continue;
          if (handle.status === "completed" || handle.status === "failed" || handle.status === "skipped") continue;
          await handle.pause();
        }
        return controlledEntries(runId)
          .map((entry) => entry.handle)
          .filter((handle) => {
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
        const controlEntries = controlledEntries(runId);
        const before = new Map(
          controlEntries.map((entry) => [entry.handle.stageId, entry.handle.status]),
        );
        const targets = stageId
          ? [runMap.get(stageId)]
              .filter(
                (entry): entry is RegistryEntry => entry !== undefined && entry.controlsDependencies,
              )
              .map((entry) => entry.handle)
          : controlEntries.map((entry) => entry.handle).filter((h) => h.status === "paused");
        for (const handle of targets) {
          if (handle.status !== "paused") continue;
          await handle.resume(message);
        }
        return controlledEntries(runId)
          .map((entry) => entry.handle)
          .filter((handle) => {
            const previous = before.get(handle.stageId);
            return (previous === "paused" || previous === "blocked") && previous !== handle.status;
          });
      },
    };
  }

  return {
    register(handle: StageControlHandle): () => void {
      const runMap = ensureRun(handle.runId);
      runMap.set(handle.stageId, { handle, controlsDependencies: true });
      return () => {
        const existing = _byRun.get(handle.runId);
        if (!existing) return;
        if (existing.get(handle.stageId)?.handle === handle) {
          existing.delete(handle.stageId);
        }
        if (existing.size === 0) _byRun.delete(handle.runId);
      };
    },
    getOrCreateDetached(
      runId: string,
      stageId: string,
      create: () => StageControlHandle,
    ): StageControlHandle {
      const runMap = ensureRun(runId);
      const existing = runMap.get(stageId);
      if (existing !== undefined && existing.handle.isDisposed !== true) return existing.handle;
      if (existing !== undefined) {
        runMap.delete(stageId);
        void Promise.resolve(existing.handle.dispose?.()).catch((err: unknown) => {
          console.warn("atomic-workflows: stale stage handle dispose failed", err);
        });
      }
      const handle = create();
      runMap.set(handle.stageId, { handle, controlsDependencies: false });
      return handle;
    },
    detachControl(runId: string, stageId: string, handle?: StageControlHandle): boolean {
      const entry = _byRun.get(runId)?.get(stageId);
      if (!entry) return false;
      if (handle !== undefined && entry.handle !== handle) return false;
      if (!entry.controlsDependencies) return false;
      entry.controlsDependencies = false;
      return true;
    },
    get(runId: string, stageId: string): StageControlHandle | undefined {
      return _byRun.get(runId)?.get(stageId)?.handle;
    },
    forRun(runId: string): readonly StageControlHandle[] {
      const runMap = _byRun.get(runId);
      if (!runMap) return [];
      return [...runMap.values()].map((entry) => entry.handle);
    },
    run(runId: string): WorkflowRunControlHandle {
      return makeRunHandle(runId);
    },
    clear(): void {
      const handles = [..._byRun.values()].flatMap((runMap) =>
        [...runMap.values()].map((entry) => entry.handle),
      );
      _byRun.clear();
      for (const handle of handles) {
        void Promise.resolve(handle.dispose?.()).catch((err: unknown) => {
          console.warn("atomic-workflows: stage handle dispose failed", err);
        });
      }
    },
  };
}

/**
 * Process-wide registry. Tests and embedders SHOULD prefer passing an
 * explicit instance via `RunOpts.stageControlRegistry`; the singleton
 * is the default consumer surface used by the extension factory.
 */
export const stageControlRegistry: StageControlRegistry = createStageControlRegistry();
