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

import type { WorkflowDefinition, WorkflowExecutionMode, WorkflowInputValues, WorkflowOutputValues } from "../../shared/types.js";
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
  /**
   * Observes the raw executor outcome. Fulfillment includes the executor's
   * RunResult; rejection includes the thrown setup/final-flush error. The job
   * promise still resolves either way.
   */
  onRawSettled?: (ok: boolean, result: RunResult | undefined, error: unknown | undefined) => void;
}

// ---------------------------------------------------------------------------
// Helper — build accepted result object
// ---------------------------------------------------------------------------

export function workflowConnectGuidance(runId: string): string {
  return `Run /workflow connect ${runId} to see agents working and chat with and steer each stage.`;
}

export function buildDetachedAccepted(
  name: string,
  runId: string,
): DetachedAccepted {
  return {
    action: "run",
    name,
    runId,
    status: "running",
    message: `Workflow "${name}" started in background (runId: ${runId}). ${workflowConnectGuidance(runId)}`,
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
export function runDetached<
  TInputs extends WorkflowInputValues,
  TRunInputs extends WorkflowInputValues = TInputs,
>(
  def: WorkflowDefinition<TInputs, WorkflowOutputValues, TRunInputs>,
  inputs: Readonly<Record<string, unknown>>,
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
    onRawSettled,
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

  // 5-7. Register the job BEFORE starting the executor, so a registration
  //   failure can never leave a started (and now-orphaned) executor running.
  //   The job promise settles when the executor settles; it is wired below.
  let settleJob: () => void = () => {};
  const voidPromise: Promise<void> = new Promise<void>((resolve) => { settleJob = resolve; });
  try {
    tracker.register({ runId, controller, promise: voidPromise });
  } catch (error) {
    controller.abort(error);
    registry.unregister(runId);
    settleJob();
    throw error;
  }
  let backgroundPromise: Promise<RunResult>;
  try {
    backgroundPromise = syncRun(def, inputs, execOpts);
  } catch (error) {
    controller.abort(error);
    registry.unregister(runId);
    tracker.unregister(runId);
    settleJob();
    throw error;
  }
  const settle = (ok: boolean, result: RunResult | undefined, error: unknown | undefined): void => {
    try {
      onRawSettled?.(ok, result, error);
    } finally {
      registry.unregister(runId);
      tracker.unregister(runId);
      settleJob();
    }
  };
  void backgroundPromise.then(
    (result) => { settle(true, result, undefined); },
    (error: unknown) => { settle(false, undefined, error); },
  );

  // 8. Return immediate accepted result
  return buildDetachedAccepted(def.name, runId);
}
