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
import type {
  WorkflowDefinition,
  WorkflowPersistencePort,
  WorkflowMcpPort,
  WorkflowRuntimeConfig,
  WorkflowDetails,
  WorkflowDirectOptions,
  WorkflowDirectTaskItem,
  WorkflowChainStep,
} from "../shared/types.js";
import type { StageAdapters } from "../runs/foreground/stage-runner.js";
import { runChain, runParallel, runTask, type RunOpts } from "../runs/foreground/executor.js";
import type { Store } from "../shared/store.js";
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
  /** Stage adapters forwarded to the executor (prompt/complete/subagent). */
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
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

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
  dispatch(args: WorkflowToolArgs): Promise<WorkflowToolResult>;

  /** Execute direct single/parallel/chain workflow tool modes. */
  runDirect(args: WorkflowToolArgs): Promise<WorkflowDetails>;
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

  function runOptions(args: WorkflowToolArgs): RunOpts {
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
    };
  }

  function directOptions(args: WorkflowToolArgs): WorkflowDirectOptions {
    return {
      ...(typeof args.task === "string" ? { task: args.task } : {}),
      ...(typeof args.chainName === "string" ? { chainName: args.chainName } : {}),
      ...(args.context !== undefined ? { context: args.context } : {}),
      ...(typeof args.forkFromSessionFile === "string" ? { forkFromSessionFile: args.forkFromSessionFile } : {}),
      ...(typeof args.concurrency === "number" ? { concurrency: args.concurrency } : {}),
      ...(typeof args.chainDir === "string" ? { chainDir: args.chainDir } : {}),
      ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
      ...(args.output !== undefined ? { output: args.output } : {}),
      ...(args.outputMode !== undefined ? { outputMode: args.outputMode } : {}),
      ...(args.maxOutput !== undefined ? { maxOutput: args.maxOutput } : {}),
      ...(typeof args.artifacts === "boolean" ? { artifacts: args.artifacts } : {}),
      ...(typeof args.sessionDir === "string" ? { sessionDir: args.sessionDir } : {}),
      ...(typeof args.progress === "boolean" ? { progress: args.progress } : {}),
      ...(typeof args.worktree === "boolean" ? { worktree: args.worktree } : {}),
    };
  }

  function directMode(args: WorkflowToolArgs): WorkflowDetails["mode"] {
    if (Array.isArray(args.chain)) return "chain";
    if (Array.isArray(args.tasks)) return "parallel";
    return "single";
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

  function runDirectForeground(args: WorkflowToolArgs, runId?: string): Promise<WorkflowDetails> {
    const baseRunOptions = runOptions(args);
    const effectiveRunOptions = runId === undefined
      ? baseRunOptions
      : { ...baseRunOptions, runId };
    if (Array.isArray(args.chain)) {
      return runChain(args.chain, directOptions(args), effectiveRunOptions);
    }
    if (Array.isArray(args.tasks)) {
      return runParallel(args.tasks, directOptions(args), effectiveRunOptions);
    }
    if (args.task !== undefined && typeof args.task === "object") {
      return runTask(args.task, directOptions(args), effectiveRunOptions);
    }
    throw new Error("WorkflowRuntime.runDirect: no direct execution mode supplied");
  }

  function runDirectAsync(args: WorkflowToolArgs): WorkflowDetails {
    const runId = crypto.randomUUID();
    const mode = directMode(args);
    const delivery = effectiveIntercomDelivery(args, mode);
    const parentSession = intercomParentSession(args);
    const background = runDirectForeground(args, runId);
    void background.then(
      (details) => {
        emitDirectIntercom(withIntercomSummary(details, delivery, parentSession), delivery, parentSession);
      },
      (error: unknown) => {
        const details: WorkflowDetails = withIntercomSummary({
          mode,
          action: "run",
          runId,
          status: "failed",
          progress: { completed: 0, total: directProgressTotal(args) },
          error: error instanceof Error ? error.message : String(error),
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
    }, delivery, parentSession);
  }

  return {
    get registry(): WorkflowRegistry {
      return registry;
    },

    dispatch(args: WorkflowToolArgs): Promise<WorkflowToolResult> {
      return dispatch(args, { registry, adapters, store: activeStore, cancellation, persistence, mcp, config });
    },

    runDirect(args: WorkflowToolArgs): Promise<WorkflowDetails> {
      if (args.async === true) {
        return Promise.resolve(runDirectAsync(args));
      }
      const mode = directMode(args);
      const delivery = effectiveIntercomDelivery(args, mode);
      const parentSession = intercomParentSession(args);
      return runDirectForeground(args).then((details) => {
        const summarized = withIntercomSummary(details, delivery, parentSession);
        emitDirectIntercom(summarized, delivery, parentSession);
        return summarized;
      });
    },
  };
}
