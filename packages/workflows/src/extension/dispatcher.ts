/**
 * WorkflowDispatcher — routes tool actions (list, inputs, run) through the
 * WorkflowRegistry + executor.  status/interrupt/resume are handled upstream in
 * index.ts since they operate on in-flight run tracking, not the registry.
 *
 * Design: pure function `dispatch(args, opts)`.  No broad catch — caller sees
 * real errors so bugs surface instead of being swallowed as success-shaped results.
 */

import type { WorkflowRegistry } from "../workflows/registry.js";
import type { StageAdapters } from "../runs/foreground/stage-runner.js";
import { store as defaultStore, type Store } from "../shared/store.js";
import type { CancellationRegistry } from "../runs/background/cancellation-registry.js";
import { jobTracker as defaultJobTracker, type JobTracker } from "../runs/background/job-tracker.js";
import { resolveInputs } from "../runs/foreground/executor.js";
import { runDetached } from "../runs/background/runner.js";
import type { WorkflowToolResult, WorkflowInputEntry } from "./render-result.js";
import type { WorkflowToolArgs } from "./index.js";
import {
  INTERACTIVE_WORKFLOW_POLICY,
  type WorkflowExecutionPolicy,
  type WorkflowPersistencePort,
  type WorkflowMcpPort,
  type WorkflowRuntimeConfig,
  type WorkflowModelCatalogPort,
  type WorkflowSourceReference,
} from "../shared/types.js";

type WorkflowRunResult = Extract<WorkflowToolResult, { action: "run" }>;

function failedRunResult(name: string | undefined, runId: string, error: string): WorkflowRunResult {
  return {
    action: "run",
    name,
    runId,
    status: "failed",
    error,
    stages: [],
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DispatcherOpts {
  /** Registry of compiled workflow definitions. */
  registry: WorkflowRegistry;
  /** Stage adapters forwarded to the executor (prompt/complete). */
  adapters?: StageAdapters;
  /** Store override (defaults to executor's singleton). */
  store?: Store;
  /** Cancellation registry forwarded to the detached runner. */
  cancellation?: CancellationRegistry;
  /** Job tracker forwarded to runDetached() for background run management. */
  jobs?: JobTracker;
  /** Persistence port forwarded to the executor. */
  persistence?: WorkflowPersistencePort;
  /** MCP scope-gating port forwarded to the executor. */
  mcp?: WorkflowMcpPort;
  /**
   * Resolved runtime configuration. Forwarded to runDetached() so downstream
   * tasks (maxDepth, concurrency, statusFile) can consume it.
   */
  config?: WorkflowRuntimeConfig;
  /** Optional model catalog forwarded to workflow runs for fallback resolution. */
  models?: WorkflowModelCatalogPort;
  /** Runtime-derived interaction policy for this dispatch. */
  policy?: WorkflowExecutionPolicy;
  /** Invocation cwd used for workflow execution. */
  cwd?: string;
  /** Discovery source metadata for workflow resources. */
  workflowSources?: readonly WorkflowSourceReference[];
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch a `list`, `inputs`, or `run` action.
 *
 * Throws for unknown actions or not-found workflows on `run`.
 * Returns a typed `WorkflowToolResult` — no broad catch, no success-shaped errors.
 */
export async function dispatch(
  args: WorkflowToolArgs,
  opts: DispatcherOpts,
): Promise<WorkflowToolResult> {
  const action = args.action ?? "run";
  const name = args.workflow ?? "";
  const inputs = args.inputs ?? {};

  switch (action) {
    // -----------------------------------------------------------------------
    // list — enumerate registered workflow metadata: name, description,
    // inputs. Single source of truth for the catalogue renderer.
    // -----------------------------------------------------------------------
    case "list": {
      const items = opts.registry.all().map((def) => ({
        name: def.normalizedName,
        description: def.description,
        inputs: Object.entries(def.inputs).map(([iname, schema]) => ({
          name: iname,
          required: schema.required === true,
        })),
      }));
      return { action: "list", items };
    }

    // -----------------------------------------------------------------------
    // inputs — return a workflow's input schema, or a clear not-found result
    // -----------------------------------------------------------------------
    case "inputs": {
      const def = opts.registry.get(name);
      if (!def) {
        return {
          action: "inputs",
          name,
          inputs: [],
          error: `Workflow not found: "${name}"`,
        };
      }
      const inputSchema: WorkflowInputEntry[] = Object.entries(def.inputs).map(
        ([iname, schema]) => ({
          name: iname,
          type: schema.type,
          description: schema.description,
          required: schema.required,
          default: "default" in schema ? schema.default : undefined,
          choices: schema.type === "select" ? schema.choices : undefined,
        }),
      );
      return { action: "inputs", name, inputs: inputSchema };
    }

    // -----------------------------------------------------------------------
    // run — always dispatched as a background run. The chat editor stays
    // free; the workflow surfaces progress through the store, the widget,
    // and the graph viewer overlay. Foreground execution is no longer a
    // user-facing option — call `run()` directly from src/runs/foreground
    // /executor.js if you need synchronous semantics in code or tests.
    // -----------------------------------------------------------------------
    case "run": {
      const def = opts.registry.get(name);
      if (!def) {
        // Return structured failed result — not-found is a user error, not a bug.
        // Status "failed" is honest; action is "run" for tool consumers to dispatch on.
        return {
          action: "run",
          name,
          runId: "",
          status: "failed",
          error: `Workflow not found: "${name}"`,
          stages: [],
        };
      }

      const policy = opts.policy ?? INTERACTIVE_WORKFLOW_POLICY;
      if (!policy.allowHumanInput && def.interaction?.humanInput === "required") {
        const reason = def.interaction.reason ? ` Reason: ${def.interaction.reason}` : "";
        return failedRunResult(
          def.name,
          "",
          `Workflow "${def.name}" requires human input and cannot run in non-interactive mode. Run Atomic interactively or choose a non-HiL workflow.${reason}`,
        );
      }

      // Pre-validate inputs against the workflow's declared schema. The
      // executor would otherwise throw the same TypeError deep inside the
      // background promise — silently from the caller's perspective. Catch
      // it here so the dispatch result names what's missing.
      try {
        resolveInputs(def.inputs, inputs);
      } catch (err) {
        return failedRunResult(
          def.name,
          "",
          err instanceof Error ? err.message : String(err),
        );
      }

      const accepted = runDetached(def, inputs, {
        registry: opts.registry,
        ...(opts.workflowSources !== undefined ? { workflowSources: opts.workflowSources } : {}),
        adapters: opts.adapters,
        store: opts.store,
        cancellation: opts.cancellation,
        jobs: opts.jobs,
        persistence: opts.persistence,
        mcp: opts.mcp,
        config: opts.config,
        models: opts.models,
        executionMode: policy.mode,
        cwd: opts.cwd,
      });
      if (policy.awaitTerminalRun === true) {
        const tracker = opts.jobs ?? defaultJobTracker;
        const job = tracker.get(accepted.runId);
        if (!job) {
          return failedRunResult(
            accepted.name,
            accepted.runId,
            `Workflow run ${accepted.runId} was accepted but no live job was registered to await`,
          );
        }
        await job.promise;
        const activeStore = opts.store ?? defaultStore;
        const snapshot = activeStore.runs().find((run) => run.id === accepted.runId);
        if (!snapshot) {
          return failedRunResult(
            accepted.name,
            accepted.runId,
            `Workflow run ${accepted.runId} ended without a retained snapshot`,
          );
        }
        return {
          action: "run",
          name: snapshot.name,
          runId: snapshot.id,
          status: snapshot.status,
          result: snapshot.result,
          error: snapshot.error,
          stages: snapshot.stages.map((stage) => structuredClone(stage)),
        };
      }
      return {
        action: "run",
        name: accepted.name,
        runId: accepted.runId,
        status: accepted.status,
        message: accepted.message,
        stages: [],
      };
    }

    default:
      // status/kill/resume are not routed here; unknown actions are bugs.
      throw new Error(`WorkflowDispatcher: unknown action "${action}"`);
  }
}
