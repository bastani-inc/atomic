/**
 * ExtensionRuntime — facade that owns the WorkflowRegistry and delegates
 * tool/slash dispatch through the WorkflowDispatcher.
 *
 * Startup seam: callers supply a registry directly (from a discovery worker
 * or createBundledWorkflowRegistry if available) or a list of compiled
 * definitions.  The runtime itself is registry-agnostic.
 *
 * cross-ref: src/extension/dispatcher.ts
 *            src/workflows/registry.ts
 */

import { createRegistry } from "../workflows/registry.js";
import type { WorkflowRegistry } from "../workflows/registry.js";
import {
  type WorkflowDefinition,
  type WorkflowPersistencePort,
  type WorkflowMcpPort,
  type WorkflowRuntimeConfig,
  type WorkflowModelCatalogPort,
  type WorkflowExecutionPolicy,
} from "../shared/types.js";
import type { StageAdapters } from "../runs/foreground/stage-runner.js";
import { resolveAndValidateInputs, type RunOpts } from "../runs/foreground/executor.js";
import type { Store } from "../shared/store.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { CancellationRegistry } from "../runs/background/cancellation-registry.js";
import { store as defaultStore } from "../shared/store.js";
import { dispatch } from "./dispatcher.js";
import type { WorkflowToolArgs } from "./index.js";
import type { WorkflowToolResult } from "./render-result.js";
import { launchDetachedUntilStartup, workflowStartupFailureMessage } from "../runs/background/startup-admission.js";
import type { JobTracker } from "../runs/background/job-tracker.js";
import { getDurableBackend, initializeDurableBackend } from "../durable/factory.js";
import {
  createDurableResumeRuntime,
  type DurableResumeRuntime,
} from "./runtime-durable-resume.js";
import { claimActiveBlockedResume, discardFailedActiveBlockedContinuation, finalizeResumedActiveBlockedSourceRun, releaseActiveBlockedClaim } from "./runtime-active-block-claim.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ExtensionRuntimeOpts {
  /**
   * Pre-populated registry — takes precedence over `definitions`.
   * Pass the output of a discovery worker / createBundledWorkflowRegistry here.
   */
  registry?: WorkflowRegistry;
  /**
   * Seed definitions used when no registry is provided.
   * Typically populated by the discovery worker at startup.
   */
  definitions?: WorkflowDefinition[];
  /** Stage adapters forwarded to the executor (prompt/complete). */
  adapters?: StageAdapters;

  /** Store override (defaults to the singleton store). */
  store?: Store;
  /** Cancellation registry forwarded to the executor. */
  cancellation?: CancellationRegistry;
  /** Persistence port forwarded to the executor. */
  persistence?: WorkflowPersistencePort;
  /** MCP scope-gating port forwarded to the executor. */
  mcp?: WorkflowMcpPort;
  /**
   * Resolved runtime configuration. Injected by the composition root after
   * merging file config with defaults. Forwarded to dispatch → run/runDetached.
   */
  config?: WorkflowRuntimeConfig;
  /** Optional model catalog forwarded to workflow runs for fallback resolution. */
  models?: WorkflowModelCatalogPort;
  /** Job tracker forwarded to named detached runs. */
  jobs?: JobTracker;
  /** Invocation cwd used for workflow execution. Defaults to process.cwd(). */
  cwd?: string;
  /** Resolve the host's non-default session directory for workflow stage transcripts. */
  resolveDefaultStageSessionDir?: () => string | undefined;
  /** Seed lifecycle state before historical completed snapshots are restored. */
  beforeRestoreCompleted?: (snapshots: readonly RunSnapshot[]) => void;
}
// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------
export type ResumeFailedRunResult =
  | { ok: true; runId: string; sourceRunId: string; resumeFromStageId: string; message: string }
  | { ok: false; reason: "run_not_found" | "not_resumable" | "workflow_not_found" | "insufficient_state"; message: string };

export interface ExtensionRuntime extends DurableResumeRuntime {
  /**
   * Live registry — read-only reference.
   * Reflects all definitions registered at startup.
   */
  readonly registry: WorkflowRegistry;

  /**
   * Dispatch a `list`, `inputs`, or `run` action.
   * Status and run-control actions use the dedicated control modules directly.
   */
  dispatch(args: WorkflowToolArgs, options?: RuntimeDispatchOptions): Promise<WorkflowToolResult>;


  /** Start a linked continuation for a failed resumable named workflow run. */
  resumeFailedRun(sourceRunId: string, stageId?: string, options?: RuntimeDispatchOptions): Promise<ResumeFailedRunResult>;

}
export interface RuntimeDispatchOptions {
  readonly policy?: WorkflowExecutionPolicy;
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an ExtensionRuntime.
 *
 * @example — discovery worker registry
 * ```ts
 * const runtime = createExtensionRuntime({ registry: createBundledWorkflowRegistry() });
 * ```
 *
 * @example — explicit definitions
 * ```ts
 * const runtime = createExtensionRuntime({ definitions: [myWorkflow] });
 * ```
 */
export function createExtensionRuntime(opts: ExtensionRuntimeOpts = {}): ExtensionRuntime {
  const registry = opts.registry ?? createRegistry(opts.definitions ?? []);
  const adapters = opts.adapters;
  const activeStore = opts.store ?? defaultStore;
  const cancellation = opts.cancellation;
  const persistence = opts.persistence;
  const mcp = opts.mcp;
  const config = opts.config;
  const models = opts.models;
  const jobs = opts.jobs;
  const runtimeCwd = opts.cwd ?? process.cwd();
  const resolveDefaultStageSessionDir = opts.resolveDefaultStageSessionDir;
  const beforeRestoreCompleted = opts.beforeRestoreCompleted;
  const ensureDbosReady = async (): Promise<void> => {
    // Deliberately not memoized: the factory revalidates its memoized backend
    // against the current DBOS lifecycle generation, so caching a permanently
    // resolved promise here could mask a backend stopped after a
    // host-session replacement (issue #1957).
    await initializeDurableBackend();
  };

  function runOptions(policy?: WorkflowExecutionPolicy): RunOpts {
    const defaultSessionDir = resolveDefaultStageSessionDir?.();
    return {
      adapters,
      store: activeStore,
      cancellation,
      persistence,
      mcp,
      config,
      models,
      ...(defaultSessionDir !== undefined ? { defaultSessionDir } : {}),
      ...(policy !== undefined ? { executionMode: policy.mode } : {}),
      registry,
      cwd: runtimeCwd,
    };
  }

  function matchesResumeStageIdentifier(stage: RunSnapshot["stages"][number], identifier: string): boolean {
    return stage.id === identifier || stage.name === identifier || stage.id.startsWith(identifier);
  }

  function stageLabel(stage: RunSnapshot["stages"][number]): string {
    return `${stage.name} (${stage.id.slice(0, 12)})`;
  }

  function resolveUniqueResumeStage(source: RunSnapshot, identifier: string): { ok: true; stage: RunSnapshot["stages"][number] } | { ok: false; message: string } {
    const exactId = source.stages.find((stage) => stage.id === identifier);
    if (exactId !== undefined) return { ok: true, stage: exactId };

    const exactNames = source.stages.filter((stage) => stage.name === identifier);
    if (exactNames.length === 1) return { ok: true, stage: exactNames[0]! };
    if (exactNames.length > 1) {
      return { ok: false, message: `insufficient_state: ambiguous stage identifier "${identifier}" matches: ${exactNames.map(stageLabel).join(", ")}` };
    }

    const matches = source.stages.filter((stage) => matchesResumeStageIdentifier(stage, identifier));
    if (matches.length === 0) return { ok: false, message: `insufficient_state: stage not found in source run ${source.id}: ${identifier}` };
    if (matches.length > 1) {
      return { ok: false, message: `insufficient_state: ambiguous stage identifier "${identifier}" matches: ${matches.map(stageLabel).join(", ")}` };
    }
    return { ok: true, stage: matches[0]! };
  }

  function resolveResumeStage(source: RunSnapshot, stageId?: string): { ok: true; stageId: string } | { ok: false; message: string } {
    if (stageId !== undefined) {
      const resolved = resolveUniqueResumeStage(source, stageId);
      if (!resolved.ok) return { ok: false, message: resolved.message };
      const stage = resolved.stage;
      if (stage.status !== "failed") return { ok: false, message: `insufficient_state: stage ${stage.name} is ${stage.status}, not failed` };
      return { ok: true, stageId: stage.id };
    }
    const failedStageId = source.failedStageId ?? source.stages.find((stage) => stage.status === "failed")?.id;
    if (failedStageId === undefined) {
      return { ok: false, message: `insufficient_state: failed run ${source.id} does not identify a failed stage` };
    }
    return { ok: true, stageId: failedStageId };
  }

  async function resumeFailedRun(sourceRunId: string, stageId?: string, options?: RuntimeDispatchOptions): Promise<ResumeFailedRunResult> {
    const source = activeStore.runs().find((run) => run.id === sourceRunId);
    if (source === undefined) {
      return { ok: false, reason: "run_not_found", message: `run not found: ${sourceRunId}` };
    }
    const isTerminalFailedResumable = source.status === "failed" && source.endedAt !== undefined && source.resumable !== false;
    const isActiveBlockedResumable = source.endedAt === undefined && source.resumable === true && source.failureRecoverability === "recoverable";
    if (!isTerminalFailedResumable && !isActiveBlockedResumable) {
      return { ok: false, reason: "not_resumable", message: `run ${sourceRunId} is not a resumable workflow run` };
    }
    const def = registry.get(source.name);
    if (def === undefined) {
      return { ok: false, reason: "workflow_not_found", message: `workflow_not_found: ${source.name}` };
    }
    const resolvedStage = resolveResumeStage(source, stageId);
    if (!resolvedStage.ok) {
      return { ok: false, reason: "insufficient_state", message: resolvedStage.message };
    }
    const sourceInputs = { ...source.inputs };
    try {
      resolveAndValidateInputs(def.inputs, sourceInputs, `workflow "${def.name}"`);
    } catch (err) {
      return { ok: false, reason: "insufficient_state", message: `insufficient_state: ${err instanceof Error ? err.message : String(err)}` };
    }
    const stageMessage = (verb: string, runId: string): string =>
      `${verb} workflow "${def.name}" from run ${source.id.slice(0, 8)} at stage ${resolvedStage.stageId.slice(0, 8)} (run ${runId.slice(0, 8)}).`;
    const launchContinuation = () => launchDetachedUntilStartup(def, sourceInputs, {
      ...runOptions(options?.policy),
      continuation: { source, resumeFromStageId: resolvedStage.stageId },
      ...(jobs !== undefined ? { jobs } : {}),
    });
    if (isActiveBlockedResumable) {
      // Keep the durable blocked source recoverable until fresh-ID startup admission succeeds.
      if (!claimActiveBlockedResume(getDurableBackend(), source.id)) {
        return { ok: false, reason: "not_resumable", message: `run ${source.id} is already being resumed in this session` };
      }
      let launch: ReturnType<typeof launchContinuation>;
      try {
        launch = launchContinuation();
      } catch (error) {
        releaseActiveBlockedClaim(source.id);
        return { ok: false, reason: "insufficient_state", message: `failed to resume run ${source.id}: ${error instanceof Error ? error.message : String(error)}` };
      }
      const { accepted } = launch;
      const admission = await launch.wait;
      if (!admission.started) {
        const startupError = workflowStartupFailureMessage(admission, activeStore.runs().find((run) => run.id === accepted.runId)?.error, `workflow run ${accepted.runId} ended before startup admission`);
        try {
          await discardFailedActiveBlockedContinuation(getDurableBackend(), accepted.runId, activeStore);
        } catch (error) {
          releaseActiveBlockedClaim(source.id);
          return { ok: false, reason: "insufficient_state", message: `continuation for run ${source.id} failed to start (${startupError}) and cleanup failed: ${error instanceof Error ? error.message : String(error)}; source left resumable` };
        }
        releaseActiveBlockedClaim(source.id);
        return { ok: false, reason: "insufficient_state", message: `continuation for run ${source.id} failed to start: ${startupError}; source left resumable` };
      }
      try {
        finalizeResumedActiveBlockedSourceRun(source, accepted.runId, activeStore, persistence);
      } catch (error) {
        releaseActiveBlockedClaim(source.id);
        return { ok: false, reason: "insufficient_state", message: `failed to finalize resumed source ${source.id}: ${error instanceof Error ? error.message : String(error)}` };
      }
      releaseActiveBlockedClaim(source.id);
      return { ok: true, runId: accepted.runId, sourceRunId: source.id, resumeFromStageId: resolvedStage.stageId, message: stageMessage("Resuming blocked", accepted.runId) };
    }
    let launch: ReturnType<typeof launchContinuation>;
    try {
      launch = launchContinuation();
    } catch (error) {
      return { ok: false, reason: "insufficient_state", message: `failed to resume run ${source.id}: ${error instanceof Error ? error.message : String(error)}` };
    }
    const { accepted } = launch;
    const admission = await launch.wait;
    if (!admission.started) {
      const startupError = workflowStartupFailureMessage(admission, activeStore.runs().find((run) => run.id === accepted.runId)?.error, `workflow run ${accepted.runId} ended before startup admission`);
      try {
        await discardFailedActiveBlockedContinuation(getDurableBackend(), accepted.runId, activeStore);
      } catch (error) {
        return { ok: false, reason: "insufficient_state", message: `continuation for run ${source.id} failed to start (${startupError}) and cleanup failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      return { ok: false, reason: "insufficient_state", message: `continuation for run ${source.id} failed to start: ${startupError}` };
    }
    return { ok: true, runId: accepted.runId, sourceRunId: source.id, resumeFromStageId: resolvedStage.stageId, message: stageMessage("Resuming failed", accepted.runId) };
  }


  return {
    get registry(): WorkflowRegistry {
      return registry;
    },

    async dispatch(args: WorkflowToolArgs, options?: RuntimeDispatchOptions): Promise<WorkflowToolResult> {
      await ensureDbosReady();
      const defaultSessionDir = resolveDefaultStageSessionDir?.();
      return dispatch(args, {
        registry,
        adapters,
        store: activeStore,
        cancellation,
        jobs,
        persistence,
        mcp,
        config,
        models,
        policy: options?.policy,
        cwd: runtimeCwd,
        ...(defaultSessionDir !== undefined ? { defaultSessionDir } : {}),
      });
    },


    resumeFailedRun,
    ...createDurableResumeRuntime({
      registry,
      store: activeStore,
      adapters,
      runtimeCwd,
      ensureReady: ensureDbosReady,
      resolveDefaultStageSessionDir,
      baseRunOpts: (policy) => runOptions(policy),
      beforeRestoreCompleted,
      ...(jobs !== undefined ? { jobs } : {}),
    }),

  };
}
