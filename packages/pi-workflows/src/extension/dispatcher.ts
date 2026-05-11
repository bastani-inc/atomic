/**
 * WorkflowDispatcher — routes tool actions (list, inputs, run) through the
 * WorkflowRegistry + executor.  status/kill/resume are handled upstream in
 * index.ts since they operate on in-flight run tracking, not the registry.
 *
 * Design: pure function `dispatch(args, opts)`.  No broad catch — caller sees
 * real errors so bugs surface instead of being swallowed as success-shaped results.
 */

import type { WorkflowRegistry } from "../workflows/registry.js";
import type { StageAdapters } from "../runs/sync/stage-runner.js";
import type { Store } from "../store.js";
import type { CancellationRegistry } from "../runs/detach/cancellation-registry.js";
import { run } from "../runs/sync/executor.js";
import type { WorkflowToolResult, WorkflowInputEntry } from "./render-result.js";
import type { WorkflowToolArgs } from "./index.js";
import type { WorkflowUIAdapter, WorkflowPersistencePort } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DispatcherOpts {
  /** Registry of compiled workflow definitions. */
  registry: WorkflowRegistry;
  /** Stage adapters forwarded to the executor (prompt/complete/subagent). */
  adapters?: StageAdapters;
  /** UI adapter forwarded to the executor (HIL / progress rendering). */
  ui?: WorkflowUIAdapter;
  /** Store override (for testing; falls back to executor default). */
  store?: Store;
  /** Cancellation registry forwarded to the executor. */
  cancellation?: CancellationRegistry;
  /** Persistence port forwarded to the executor. */
  persistence?: WorkflowPersistencePort;
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
  const name = args.name ?? "";
  const inputs = args.inputs ?? {};

  switch (action) {
    // -----------------------------------------------------------------------
    // list — enumerate registered workflow names
    // -----------------------------------------------------------------------
    case "list":
      return { action: "list", workflows: opts.registry.names() };

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
        }),
      );
      return { action: "inputs", name, inputs: inputSchema };
    }

    // -----------------------------------------------------------------------
    // run — validate inputs, execute, return real RunResult fields
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

      // run() handles input validation (resolveInputs) and execution.
      // Let real errors propagate — no broad catch here.
      const runResult = await run(def, inputs, {
        adapters: opts.adapters,
        ui: opts.ui,
        store: opts.store,
        cancellation: opts.cancellation,
        persistence: opts.persistence,
      });

      return {
        action: "run",
        name: def.name,
        runId: runResult.runId,
        status: runResult.status,
        result: runResult.result,
        error: runResult.error,
        stages: runResult.stages,
      };
    }

    default:
      // status/kill/resume are not routed here; unknown actions are bugs.
      throw new Error(`WorkflowDispatcher: unknown action "${action}"`);
  }
}
