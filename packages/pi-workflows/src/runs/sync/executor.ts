/**
 * Main DAG executor: run(def, inputs, opts) → RunResult
 */

import type {
  WorkflowDefinition,
  WorkflowRunContext,
  WorkflowUIContext,
  WorkflowUIAdapter,
  WorkflowInputSchema,
  StageOptions,
  WorkflowMcpPort,
  WorkflowPersistencePort,
} from "../../shared/types.js";
import type { StageAdapters } from "./stage-runner.js";
import type { RunStatus, StageSnapshot, RunSnapshot, WorkflowOverlayAdapter } from "../../store-types.js";
import type { Store } from "../../store.js";
import type { CancellationRegistry } from "../detach/cancellation-registry.js";
import { createStageContext } from "./stage-runner.js";
import { GraphFrontierTracker } from "../shared/graph-inference.js";
import { store as defaultStore } from "../../store.js";

export interface ResolvedInputs extends Record<string, unknown> {}

export interface RunOpts {
  adapters?: StageAdapters;
  /** HIL adapter injected by the pi runtime or test harness. */
  ui?: WorkflowUIAdapter;
  /** Store override (for testing; defaults to singleton store) */
  store?: Store;
  /** Persistence port for writing session entries (run.start, stage.start, etc.). */
  persistence?: WorkflowPersistencePort;
  /** MCP scope-gating port; forwards per-stage allow/deny to the MCP adapter. */
  mcp?: WorkflowMcpPort;
  /** Cancellation registry; the executor registers an ActiveRunController per run. */
  cancellation?: CancellationRegistry;
  /** Overlay adapter for displaying run progress in the UI layer. */
  overlay?: WorkflowOverlayAdapter;
  /** AbortSignal that requests cancellation from the caller side. */
  signal?: AbortSignal;
  onRunStart?: (snapshot: RunSnapshot) => void;
  onStageStart?: (runId: string, snapshot: StageSnapshot) => void;
  onStageEnd?: (runId: string, snapshot: StageSnapshot) => void;
  onRunEnd?: (runId: string, status: RunStatus, result?: Record<string, unknown>, error?: string) => void;
}

export interface RunResult {
  readonly runId: string;
  readonly status: RunStatus;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  readonly stages: StageSnapshot[];
}

// ---------------------------------------------------------------------------
// Input resolution / validation
// ---------------------------------------------------------------------------

export function resolveInputs(
  schema: Readonly<Record<string, WorkflowInputSchema>>,
  provided: Record<string, unknown>,
): ResolvedInputs {
  const resolved: Record<string, unknown> = { ...provided };

  // Apply defaults for missing keys
  for (const [key, schemaDef] of Object.entries(schema)) {
    if (resolved[key] === undefined && "default" in schemaDef && schemaDef.default !== undefined) {
      resolved[key] = schemaDef.default;
    }
  }

  // Validate required fields
  for (const [key, schemaDef] of Object.entries(schema)) {
    if (schemaDef.required === true && resolved[key] === undefined) {
      throw new TypeError(`pi-workflows: required input "${key}" not provided`);
    }
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// HIL unavailable fallback — rejects with precise per-primitive error
// ---------------------------------------------------------------------------

function makeUnavailableUIContext(): WorkflowUIContext {
  const msg = (primitive: string): string =>
    `pi-workflows: HIL ctx.ui.${primitive} is unavailable because pi runtime did not provide a UI adapter`;
  return {
    input: () => Promise.reject(new Error(msg("input"))),
    confirm: () => Promise.reject(new Error(msg("confirm"))),
    select: () => Promise.reject(new Error(msg("select"))),
    editor: () => Promise.reject(new Error(msg("editor"))),
  };
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

export async function run(
  def: WorkflowDefinition,
  inputs: Record<string, unknown>,
  opts: RunOpts = {},
): Promise<RunResult> {
  const activeStore = opts.store ?? defaultStore;
  const adapters = opts.adapters ?? {};

  // 1. Resolve + validate inputs
  const resolvedInputs = resolveInputs(def.inputs, inputs);

  // 2. Generate runId
  const runId = crypto.randomUUID();

  // 3. Create RunSnapshot + register
  const runSnapshot: RunSnapshot = {
    id: runId,
    name: def.name,
    inputs: Object.freeze(resolvedInputs),
    status: "running",
    stages: [],
    startedAt: Date.now(),
  };

  activeStore.recordRunStart(runSnapshot);
  opts.onRunStart?.(runSnapshot);

  // 4. Create GraphFrontierTracker
  const tracker = new GraphFrontierTracker();

  // 5. Build WorkflowRunContext
  const ctx: WorkflowRunContext = {
    inputs: resolvedInputs,
    ui: opts.ui ?? makeUnavailableUIContext(),

    stage(name: string, options?: StageOptions) {
      // a. Generate stageId
      const stageId = crypto.randomUUID();

      // b. tracker.onSpawn → parentIds
      const parentIds = tracker.onSpawn(stageId, name);

      // c. Create StageSnapshot as "pending"
      const stageSnapshot: StageSnapshot = {
        id: stageId,
        name,
        status: "pending",
        parentIds: Object.freeze(parentIds),
        toolEvents: [],
      };

      // d. Record stage start in store (as pending), call onStageStart
      activeStore.recordStageStart(runId, stageSnapshot);
      opts.onStageStart?.(runId, stageSnapshot);

      // e. Create inner StageContext (raw, without wrapping)
      const innerCtx = createStageContext({ stageId, stageName: name, adapters });

      const wrapMethod = <TArgs extends unknown[]>(
        method: (...args: TArgs) => Promise<string>,
      ): ((...args: TArgs) => Promise<string>) => {
        return async (...args: TArgs): Promise<string> => {
          stageSnapshot.status = "running";
          stageSnapshot.startedAt = Date.now();
          activeStore.recordStageStart(runId, stageSnapshot);

          // Apply MCP scope gating if port + options provided
          const mcpAllow = options?.mcp?.allow ?? null;
          const mcpDeny = options?.mcp?.deny ?? null;
          if (opts.mcp && (mcpAllow !== null || mcpDeny !== null)) {
            opts.mcp.setScope(stageId, mcpAllow, mcpDeny);
          }

          try {
            const result = await method(...args);
            stageSnapshot.status = "completed";
            stageSnapshot.result = result;
            return result;
          } catch (err) {
            stageSnapshot.status = "failed";
            stageSnapshot.error = err instanceof Error ? err.message : String(err);
            throw err;
          } finally {
            stageSnapshot.endedAt = Date.now();
            stageSnapshot.durationMs =
              stageSnapshot.startedAt !== undefined
                ? stageSnapshot.endedAt - stageSnapshot.startedAt
                : undefined;

            // Clear MCP scope after stage settles
            if (opts.mcp && (mcpAllow !== null || mcpDeny !== null)) {
              opts.mcp.clearScope(stageId);
            }

            activeStore.recordStageEnd(runId, stageSnapshot);
            opts.onStageEnd?.(runId, stageSnapshot);
            tracker.onSettle(stageId);
          }
        };
      };

      return {
        name,
        prompt: wrapMethod(innerCtx.prompt.bind(innerCtx)),
        complete: wrapMethod(innerCtx.complete.bind(innerCtx)),
        subagent: wrapMethod(innerCtx.subagent.bind(innerCtx)),
      };
    },
  };

  // 6. Call def.run(ctx)
  try {
    const result = await def.run(ctx);

    // 7. recordRunEnd "completed"
    activeStore.recordRunEnd(runId, "completed", result);
    opts.onRunEnd?.(runId, "completed", result);

    // 8. Return RunResult
    return {
      runId,
      status: "completed",
      result,
      stages: [...runSnapshot.stages],
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // 9. recordRunEnd "failed"
    activeStore.recordRunEnd(runId, "failed", undefined, errorMessage);
    opts.onRunEnd?.(runId, "failed", undefined, errorMessage);

    return {
      runId,
      status: "failed",
      error: errorMessage,
      stages: [...runSnapshot.stages],
    };
  }
}
