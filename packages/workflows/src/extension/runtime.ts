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
  INTERACTIVE_WORKFLOW_POLICY,
  type WorkflowDefinition,
  type WorkflowPersistencePort,
  type WorkflowMcpPort,
  type WorkflowRuntimeConfig,
  type WorkflowDetails,
  type WorkflowModelCatalogPort,
  type WorkflowExecutionPolicy,
} from "../shared/types.js";
import type { StageAdapters } from "../runs/foreground/stage-runner.js";
import { resolveAndValidateInputs, runChain, runParallel, runTask, type RunOpts } from "../runs/foreground/executor.js";
import type { Store } from "../shared/store.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { CancellationRegistry } from "../runs/background/cancellation-registry.js";
import { store as defaultStore } from "../shared/store.js";
import { dispatch } from "./dispatcher.js";
import type { WorkflowToolArgs } from "./index.js";
import type { WorkflowToolResult } from "./render-result.js";
import {
  emitWorkflowControlIntercom,
  emitWorkflowResultIntercom,
  workflowIntercomAvailable,
  type WorkflowIntercomDelivery,
  type WorkflowResultIntercomPort,
} from "../intercom/result-intercom.js";
import { validateWorkflowModels } from "../runs/shared/model-fallback.js";
import { runDetached, workflowConnectGuidance } from "../runs/background/runner.js";
import type { JobTracker } from "../runs/background/job-tracker.js";
import { appendRunEnd } from "../shared/persistence-session-entries.js";
import { classifyWorkflowFailure } from "../shared/workflow-failures.js";
import { initializeDurableBackend } from "../durable/factory.js";
import { directMode, directModelRequests, directOptions, directProgressTotal } from "./runtime-direct.js";
import {
  createDurableResumeRuntime,
  type DurableResumeRuntime,
} from "./runtime-durable-resume.js";

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
  /** Workflow-native pi-intercom result/control event delivery. */
  intercom?: WorkflowResultIntercomPort;
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

  /** Execute direct single/parallel/chain workflow tool modes. */
  runDirect(args: WorkflowToolArgs, options?: RuntimeDispatchOptions): Promise<WorkflowDetails>;

  /** Start a linked continuation for a failed resumable named workflow run. */
  resumeFailedRun(sourceRunId: string, stageId?: string, options?: RuntimeDispatchOptions): ResumeFailedRunResult;

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
  const intercom = opts.intercom;
  const models = opts.models;
  const jobs = opts.jobs;
  const runtimeCwd = opts.cwd ?? process.cwd();
  const resolveDefaultStageSessionDir = opts.resolveDefaultStageSessionDir;
  let dbosReady: Promise<void> | undefined;
  const ensureDbosReady = async (): Promise<void> => {
    dbosReady ??= initializeDurableBackend().then(() => undefined);
    await dbosReady;
  };

  function runOptions(args: WorkflowToolArgs, policy?: WorkflowExecutionPolicy): RunOpts {
    const argConcurrency =
      typeof args.concurrency === "number" && Number.isFinite(args.concurrency)
        ? Math.max(1, Math.floor(args.concurrency))
        : undefined;
    const effectiveConfig =
      argConcurrency === undefined
        ? config
        : {
            maxDepth: config?.maxDepth ?? 4,
            defaultConcurrency: argConcurrency,
            persistRuns: config?.persistRuns ?? true,
            statusFile: config?.statusFile ?? false,
            ...(config?.statusFilePath !== undefined ? { statusFilePath: config.statusFilePath } : {}),
            resumeInFlight: config?.resumeInFlight ?? "ask",
          };
    const defaultSessionDir = resolveDefaultStageSessionDir?.();
    return {
      adapters,
      store: activeStore,
      cancellation,
      persistence,
      mcp,
      config: effectiveConfig,
      models,
      ...(defaultSessionDir !== undefined ? { defaultSessionDir } : {}),
      ...(policy !== undefined ? { executionMode: policy.mode } : {}),
      registry,
      cwd: runtimeCwd,
    };
  }
  function explicitIntercomDelivery(args: WorkflowToolArgs): WorkflowIntercomDelivery | undefined {
    if (args.intercom?.enabled === false) return "off";
    if (args.intercom?.delivery !== undefined) return args.intercom.delivery;
    if (args.intercom?.enabled === true) return "control-and-result";
    return undefined;
  }
  function effectiveIntercomDelivery(args: WorkflowToolArgs, mode: WorkflowDetails["mode"]): WorkflowIntercomDelivery {
    const explicit = explicitIntercomDelivery(args);
    if (explicit !== undefined) return explicit;
    if (
      args.async === true &&
      workflowIntercomAvailable(intercom) &&
      (mode === "parallel" || mode === "chain")
    ) {
      return "control-and-result";
    }
    return "off";
  }
  function intercomParentSession(args: WorkflowToolArgs): string | undefined {
    if (args.intercom?.parentSession !== undefined) return args.intercom.parentSession;
    if (typeof intercom?.parentSession === "function") return intercom.parentSession();
    return intercom?.parentSession;
  }

  function withIntercomSummary(
    details: WorkflowDetails,
    delivery: WorkflowIntercomDelivery,
    parentSession?: string,
  ): WorkflowDetails {
    if (delivery === "off") return details;
    return {
      ...details,
      intercom: {
        enabled: workflowIntercomAvailable(intercom),
        delivery,
        ...(parentSession !== undefined ? { parentSession } : {}),
      },
    };
  }

  function emitDirectIntercom(details: WorkflowDetails, delivery: WorkflowIntercomDelivery, parentSession?: string): void {
    if (delivery === "off") return;
    const summarized = withIntercomSummary(details, delivery, parentSession);
    emitWorkflowControlIntercom(
      intercom,
      summarized,
      `workflow ${summarized.status}: ${summarized.runId ?? "unknown run"}`,
      { delivery: delivery === "result" ? "result" : delivery, parentSession },
    );
    emitWorkflowResultIntercom(intercom, summarized, {
      delivery: delivery === "notify" ? "notify" : delivery,
      parentSession,
    });
  }

  function runDirectForeground(
    args: WorkflowToolArgs,
    runId?: string,
    policy?: WorkflowExecutionPolicy,
  ): Promise<WorkflowDetails> {
    const directRunOptions = directOptions(args);
    const baseRunOptions = runOptions(args, policy);
    const effectiveRunOptions = runId === undefined
      ? baseRunOptions
      : { ...baseRunOptions, runId };

    if (Array.isArray(args.chain)) {
      return runChain(args.chain, directRunOptions, effectiveRunOptions);
    }
    if (Array.isArray(args.tasks)) {
      return runParallel(args.tasks, directRunOptions, effectiveRunOptions);
    }
    if (args.task !== undefined && typeof args.task === "object") {
      return runTask(args.task, directRunOptions, effectiveRunOptions);
    }
    throw new Error("WorkflowRuntime.runDirect: no direct execution mode supplied");
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

  function finalizeResumedActiveBlockedSourceRun(source: RunSnapshot, continuationRunId: string): void {
    const errorMessage = source.error ?? source.failureMessage ?? `workflow resumed in new run ${continuationRunId}`;
    const metadata = {
      ...(source.failureKind !== undefined ? { failureKind: source.failureKind } : {}),
      ...(source.failureCode !== undefined ? { failureCode: source.failureCode } : {}),
      failureRecoverability: "non_recoverable",
      failureDisposition: "terminal_killed",
      ...(source.failureMessage !== undefined ? { failureMessage: source.failureMessage } : {}),
      ...(source.failedStageId !== undefined ? { failedStageId: source.failedStageId } : {}),
      resumable: false,
      ...(source.retryAfterMs !== undefined ? { retryAfterMs: source.retryAfterMs } : {}),
    } as const;
    const recorded = activeStore.recordRunEnd(source.id, "killed", undefined, errorMessage, metadata);
    if (recorded && persistence !== undefined) {
      appendRunEnd(persistence, {
        runId: source.id,
        status: "killed",
        error: errorMessage,
        ...metadata,
        ts: Date.now(),
      });
    }
  }

  function resumeFailedRun(sourceRunId: string, stageId?: string, options?: RuntimeDispatchOptions): ResumeFailedRunResult {
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
    const accepted = runDetached(def, sourceInputs, {
      ...runOptions({ workflow: def.name, inputs: sourceInputs }, options?.policy),
      continuation: { source, resumeFromStageId: resolvedStage.stageId },
    });
    if (isActiveBlockedResumable) {
      finalizeResumedActiveBlockedSourceRun(source, accepted.runId);
    }
    return {
      ok: true,
      runId: accepted.runId,
      sourceRunId: source.id,
      resumeFromStageId: resolvedStage.stageId,
      message: isActiveBlockedResumable
        ? `Resuming blocked workflow "${def.name}" from run ${source.id.slice(0, 8)} at stage ${resolvedStage.stageId.slice(0, 8)} (new run ${accepted.runId}).`
        : `Resuming failed workflow "${def.name}" from run ${source.id.slice(0, 8)} at stage ${resolvedStage.stageId.slice(0, 8)} (new run ${accepted.runId}).`,
    };
  }

  async function runDirectAsync(args: WorkflowToolArgs, policy?: WorkflowExecutionPolicy): Promise<WorkflowDetails> {
    await ensureDbosReady();
    const runId = crypto.randomUUID();
    const mode = directMode(args);
    const delivery = effectiveIntercomDelivery(args, mode);
    const parentSession = intercomParentSession(args);
    let warnings: readonly string[] = [];
    try {
      warnings = await validateWorkflowModels({
        requests: directModelRequests(args),
        catalog: models,
      });
    } catch (error: unknown) {
      return withIntercomSummary({
        mode,
        action: "run",
        runId,
        status: "failed",
        progress: { completed: 0, total: directProgressTotal(args) },
        error: classifyWorkflowFailure(error).userMessage,
      }, delivery, parentSession);
    }
    const background = runDirectForeground(args, runId, policy);
    void background.then(
      (details) => {
        emitDirectIntercom(details, delivery, parentSession);
      },
      (error: unknown) => {
        const details: WorkflowDetails = withIntercomSummary({
          mode,
          action: "run",
          runId,
          status: "failed",
          progress: { completed: 0, total: directProgressTotal(args) },
          error: classifyWorkflowFailure(error).userMessage,
        }, delivery, parentSession);
        emitDirectIntercom(details, delivery, parentSession);
      },
    );
    return withIntercomSummary({
      mode,
      action: "run",
      runId,
      status: "accepted",
      progress: { completed: 0, total: directProgressTotal(args) },
      message: workflowConnectGuidance(runId),
      ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
    }, delivery, parentSession);
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

    async runDirect(args: WorkflowToolArgs, options?: RuntimeDispatchOptions): Promise<WorkflowDetails> {
      await ensureDbosReady();
      const policy = options?.policy ?? INTERACTIVE_WORKFLOW_POLICY;
      if (args.async === true && policy.awaitTerminalRun !== true) {
        return runDirectAsync(args, policy);
      }
      const mode = directMode(args);
      const delivery = effectiveIntercomDelivery(args, mode);
      const parentSession = intercomParentSession(args);
      return runDirectForeground(args, undefined, policy).then((details) => {
        const summarized = withIntercomSummary(details, delivery, parentSession);
        emitDirectIntercom(summarized, delivery, parentSession);
        return summarized;
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
      baseRunOpts: (policy) => runOptions({ workflow: "", inputs: {} }, policy),
    }),

  };
}
