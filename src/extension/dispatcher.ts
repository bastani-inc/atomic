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
import type { Store } from "../shared/store.js";
import type { CancellationRegistry } from "../runs/background/cancellation-registry.js";
import type { JobTracker } from "../runs/background/job-tracker.js";
import { resolveInputs } from "../runs/foreground/executor.js";
import { runDetached } from "../runs/background/runner.js";
import type { WorkflowToolResult, WorkflowInputEntry } from "./render-result.js";
import type { WorkflowToolArgs } from "./index.js";
import type { WorkflowPersistencePort, WorkflowMcpPort, WorkflowRuntimeConfig } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DispatcherOpts {
  /** Registry of compiled workflow definitions. */
  registry: WorkflowRegistry;
  /** Stage adapters forwarded to the executor (prompt/complete/subagent). */
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

      // Pre-validate inputs against the workflow's declared schema. The
      // executor would otherwise throw the same TypeError deep inside the
      // background promise — silently from the caller's perspective. Catch
      // it here so the dispatch result names what's missing.
      try {
        resolveInputs(def.inputs, inputs);
      } catch (err) {
        return {
          action: "run",
          name: def.name,
          runId: "",
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          stages: [],
        };
      }

      const accepted = runDetached(def, inputs, {
        adapters: opts.adapters,
        store: opts.store,
        cancellation: opts.cancellation,
        jobs: opts.jobs,
        persistence: opts.persistence,
        mcp: opts.mcp,
        config: opts.config,
      });
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
