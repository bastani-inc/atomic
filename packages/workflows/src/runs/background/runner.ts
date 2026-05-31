/**
 * Detached runner — fires the sync executor in a background promise and
 * returns an immediate accepted result describing the dispatched run.
 *
 * Lifecycle:
 *   1. Preallocate runId (UUID).
 *   2. Create own AbortController.
 *   3. Register (runId, controller) in both CancellationRegistry and JobTracker.
 *   4. Start sync executor as background promise (no await).
 *   5. On settle: unregister from both registries, swallow any unhandled rejection.
 *   6. Return DetachedAccepted immediately.
 *
 * Does NOT wire slash/tool surfaces — callable API only.
 * cross-ref: spec detached-runner
 */

import type { WorkflowDefinition, WorkflowExecutionMode } from "../../shared/types.js";
import type { RunOpts, RunResult } from "../foreground/executor.js";
import type { CancellationRegistry } from "./cancellation-registry.js";
import type { JobTracker } from "./job-tracker.js";
import type { Store } from "../../shared/store.js";
import { run as syncRun } from "../foreground/executor.js";
import { cancellationRegistry as defaultCancellationRegistry } from "./cancellation-registry.js";
import { jobTracker as defaultJobTracker } from "./job-tracker.js";
import { store as defaultStore } from "../../shared/store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Immediate response returned by `runDetached()`. Background is the only
 * execution mode for workflow runs — this is the canonical "run accepted"
 * shape consumed by the dispatcher and rendered by `render-result`.
 */
export interface DetachedAccepted {
  readonly action: "run";
  readonly name: string;
  readonly runId: string;
  readonly status: "running";
  readonly message: string;
  readonly stages: [];
}

export interface DetachedRunOpts
  extends Omit<RunOpts, "signal" | "cancellation" | "deferWorkflowStart"> {
  /**
   * Override CancellationRegistry (default: singleton cancellationRegistry).
   */
  cancellation?: CancellationRegistry;
  /**
   * Override JobTracker (default: singleton jobTracker).
   */
  jobs?: JobTracker;
  /** Runtime execution mode for UI/prompt policy. Defaults to interactive. */
  executionMode?: WorkflowExecutionMode;
}

// ---------------------------------------------------------------------------
// Helper — build accepted result object
// ---------------------------------------------------------------------------

export function buildDetachedAccepted(
  name: string,
  runId: string,
): DetachedAccepted {
  return {
    action: "run",
    name,
    runId,
    status: "running",
    message: `Workflow "${name}" started in background (runId: ${runId}).`,
    stages: [],
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Start a workflow run in the background and return immediately.
 *
 * The background promise is fire-and-forget from the caller's perspective;
 * the store remains source of truth for run status. Cancellation is wired
 * through the provided (or default) CancellationRegistry.
 */
export function runDetached<TInputs extends Record<string, unknown>>(
  def: WorkflowDefinition<TInputs>,
  inputs: Record<string, unknown>,
  opts: DetachedRunOpts = {},
): DetachedAccepted {
  const registry = opts.cancellation ?? defaultCancellationRegistry;
  const tracker = opts.jobs ?? defaultJobTracker;

  // 1. Pre-allocate runId unless the caller supplied one for continuation/tests.
  const runId = opts.runId ?? crypto.randomUUID();

  // 2. Create AbortController for this run
  const controller = new AbortController();

  // 3. Register in cancellation registry BEFORE starting background promise
  //    so any concurrent abort() calls issued immediately after runDetached()
  //    are not lost.
  registry.register(runId, controller);

  // 4. Build executor opts — inject runId seam, signal, and node-local
  //    store-backed HIL. Background runs must NOT route ctx.ui.* through pi.ui
  //    dialogs (those steal focus from the main chat editor); the executor
  //    records prompts on synthetic workflow nodes and the attached stage chat
  //    drives the response. Destructure `jobs`/`cancellation`/`ui` out so
  //    they're not forwarded to RunOpts twice.
  const {
    jobs: _jobs,
    cancellation: _cancellation,
    ui: _ui,
    store: storeOverride,
    ...restOpts
  } = opts;
  const store: Store = storeOverride ?? defaultStore;
  const execOpts: RunOpts = {
    ...restOpts,
    runId,
    signal: controller.signal,
    cancellation: registry,
    store,
    usePromptNodesForUi: opts.executionMode !== "non_interactive",
    deferWorkflowStart: true,
  };

  // 5. Start background promise
  const backgroundPromise: Promise<RunResult> = syncRun(def, inputs, execOpts);

  // 6. Build void promise that unregisters on settle and swallows rejections
  const voidPromise: Promise<void> = backgroundPromise.then(
    () => {
      tracker.unregister(runId);
      // CancellationRegistry.unregister called by executor in its finally block.
    },
    (_err: unknown) => {
      // Reject path: executor already records failed/killed status in store.
      // Swallow here to avoid unhandled rejection — store is source of truth.
      tracker.unregister(runId);
    },
  );

  // 7. Register live job in tracker
  tracker.register({ runId, controller, promise: voidPromise });

  // 8. Return immediate accepted result
  return buildDetachedAccepted(def.name, runId);
}
