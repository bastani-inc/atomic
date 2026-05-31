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
  type WorkflowDirectOptions,
  type WorkflowDirectTaskItem,
  type WorkflowChainStep,
  type WorkflowModelCatalogPort,
  type WorkflowExecutionPolicy,
} from "../shared/types.js";
import type { StageAdapters } from "../runs/foreground/stage-runner.js";
import { resolveInputs, runChain, runParallel, runTask, type RunOpts } from "../runs/foreground/executor.js";
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
import { runDetached } from "../runs/background/runner.js";
import type { JobTracker } from "../runs/background/job-tracker.js";
import { classifyWorkflowFailure } from "../shared/workflow-failures.js";
import type { WorkflowSourceReference } from "../workflows/import-resolver.js";

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
  /** Discovery source metadata used to resolve relative local path imports. */
  workflowSources?: readonly WorkflowSourceReference[];
  /** Invocation cwd used for local path workflow imports. Defaults to process.cwd(). */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export type ResumeFailedRunResult =
  | { ok: true; runId: string; sourceRunId: string; resumeFromStageId: string; message: string }
  | { ok: false; reason: "run_not_found" | "not_resumable" | "workflow_not_found" | "insufficient_state"; message: string };

export interface ExtensionRuntime {
  /**
   * Live registry — read-only reference.
   * Reflects all definitions registered at startup.
   */
  readonly registry: WorkflowRegistry;

  /**
   * Dispatch a `list`, `inputs`, or `run` action.
   * For `status`, `kill`, and `resume` use the runs/background/status module directly.
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
  const workflowSources = opts.workflowSources;
  const runtimeCwd = opts.cwd ?? process.cwd();

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
    return {
      adapters,
      store: activeStore,
      cancellation,
      persistence,
      mcp,
      config: effectiveConfig,
      models,
      ...(policy !== undefined ? { executionMode: policy.mode } : {}),
      registry,
      ...(workflowSources !== undefined ? { workflowSources } : {}),
      cwd: runtimeCwd,
    };
  }

  function withoutUndefinedProperties<T extends object>(value: T): Partial<T> {
    return Object.fromEntries(
      Object.entries(value).filter(([, field]) => field !== undefined),
    ) as Partial<T>;
  }

  function directOptions(args: WorkflowToolArgs): WorkflowDirectOptions {
    const {
      workflow: _workflow,
      inputs: _inputs,
      action: _action,
      runId: _runId,
      task,
      tasks: _tasks,
      chain: _chain,
      chainName,
      concurrency,
      failFast,
      async: _async,
      intercom: _intercom,
      output,
      outputMode,
      reads,
      chainDir,
      maxOutput,
      artifacts,
      worktree,
      gitWorktreeDir,
      baseBranch,
      ...stageOptions
    } = args;

    return {
      ...withoutUndefinedProperties(stageOptions),
      ...(typeof task === "string" ? { task } : {}),
      ...(typeof chainName === "string" ? { chainName } : {}),
      ...(typeof concurrency === "number" ? { concurrency } : {}),
      ...(typeof failFast === "boolean" ? { failFast } : {}),
      ...(typeof chainDir === "string" ? { chainDir } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(outputMode !== undefined ? { outputMode } : {}),
      ...(reads !== undefined ? { reads } : {}),
      ...(maxOutput !== undefined ? { maxOutput } : {}),
      ...(typeof artifacts === "boolean" ? { artifacts } : {}),
      ...(typeof worktree === "boolean" ? { worktree } : {}),
      ...(typeof gitWorktreeDir === "string" ? { gitWorktreeDir } : {}),
      ...(typeof baseBranch === "string" ? { baseBranch } : {}),
    };
  }

  function directMode(args: WorkflowToolArgs): WorkflowDetails["mode"] {
    if (Array.isArray(args.chain)) return "chain";
    if (Array.isArray(args.tasks)) return "parallel";
    return "single";
  }

  function directModelRequests(args: WorkflowToolArgs): Array<{ readonly model?: WorkflowDirectTaskItem["model"]; readonly fallbackModels?: readonly string[] }> {
    const options = directOptions(args);
    const withFallbackDefault = (item: WorkflowDirectTaskItem) => ({
      model: item.model ?? options.model,
      fallbackModels: item.fallbackModels ?? options.fallbackModels,
    });
    if (args.task !== undefined && typeof args.task === "object") return [withFallbackDefault(args.task)];
    if (Array.isArray(args.tasks)) return args.tasks.map(withFallbackDefault);
    if (Array.isArray(args.chain)) {
      return args.chain.flatMap((step) =>
        "parallel" in step
          ? step.parallel.map(withFallbackDefault)
          : [withFallbackDefault(step)],
      );
    }
    return [];
  }

  function directProgressTotal(args: WorkflowToolArgs): number {
    const countTask = (task: WorkflowDirectTaskItem): number => task.count ?? 1;
    const countChainStep = (step: WorkflowChainStep): number =>
      "parallel" in step
        ? step.parallel.reduce((total, task) => total + countTask(task), 0)
        : 1;
    if (Array.isArray(args.chain)) {
      return args.chain.reduce((total, step) => total + countChainStep(step), 0);
    }
    if (Array.isArray(args.tasks)) {
      return args.tasks.reduce((total, task) => total + countTask(task), 0);
    }
    return 1;
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

  function resumeFailedRun(sourceRunId: string, stageId?: string, options?: RuntimeDispatchOptions): ResumeFailedRunResult {
    const source = activeStore.runs().find((run) => run.id === sourceRunId);
    if (source === undefined) {
      return { ok: false, reason: "run_not_found", message: `run not found: ${sourceRunId}` };
    }
    if (source.status !== "failed" || source.endedAt === undefined || source.resumable === false) {
      return { ok: false, reason: "not_resumable", message: `run ${sourceRunId} is not a failed resumable workflow run` };
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
      resolveInputs(def.inputs, sourceInputs);
    } catch (err) {
      return { ok: false, reason: "insufficient_state", message: `insufficient_state: ${err instanceof Error ? err.message : String(err)}` };
    }
    const accepted = runDetached(def, sourceInputs, {
      ...runOptions({ workflow: def.name, inputs: sourceInputs }, options?.policy),
      continuation: { source, resumeFromStageId: resolvedStage.stageId },
    });
    return {
      ok: true,
      runId: accepted.runId,
      sourceRunId: source.id,
      resumeFromStageId: resolvedStage.stageId,
      message: `Resuming failed workflow "${def.name}" from run ${source.id.slice(0, 8)} at stage ${resolvedStage.stageId.slice(0, 8)} (new run ${accepted.runId}).`,
    };
  }

  async function runDirectAsync(args: WorkflowToolArgs, policy?: WorkflowExecutionPolicy): Promise<WorkflowDetails> {
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
      ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
    }, delivery, parentSession);
  }

  return {
    get registry(): WorkflowRegistry {
      return registry;
    },

    dispatch(args: WorkflowToolArgs, options?: RuntimeDispatchOptions): Promise<WorkflowToolResult> {
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
        workflowSources,
      });
    },

    runDirect(args: WorkflowToolArgs, options?: RuntimeDispatchOptions): Promise<WorkflowDetails> {
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
  };
}
