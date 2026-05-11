/**
 * ExtensionRuntime — facade that owns the WorkflowRegistry and delegates
 * tool/slash dispatch through the WorkflowDispatcher.
 *
 * Startup seam: callers supply a registry directly (from a discovery worker
 * or createBundledWorkflowRegistry if available) or a list of compiled
 * definitions.  The runtime itself is registry-agnostic.
 *
 * cross-ref: packages/pi-workflows/src/extension/dispatcher.ts
 *            packages/pi-workflows/src/workflows/registry.ts
 */

import { createRegistry } from "../workflows/registry.js";
import type { WorkflowRegistry } from "../workflows/registry.js";
import type { WorkflowDefinition, WorkflowUIAdapter, WorkflowPersistencePort, WorkflowMcpPort, WorkflowRuntimeConfig } from "../shared/types.js";
import type { StageAdapters } from "../runs/sync/stage-runner.js";
import type { Store } from "../store.js";
import type { CancellationRegistry } from "../runs/detach/cancellation-registry.js";
import { store as defaultStore } from "../store.js";
import { dispatch } from "./dispatcher.js";
import type { WorkflowToolArgs } from "./index.js";
import type { WorkflowToolResult } from "./render-result.js";

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
  /** HIL UI adapter forwarded to the executor (prompt/confirm/select/editor). */
  ui?: WorkflowUIAdapter;
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
   * For `status`, `kill`, and `resume` use the runs/detach/status module directly.
   */
  dispatch(args: WorkflowToolArgs): Promise<WorkflowToolResult>;
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
  const ui = opts.ui;
  const activeStore = opts.store ?? defaultStore;
  const cancellation = opts.cancellation;
  const persistence = opts.persistence;
  const mcp = opts.mcp;
  const config = opts.config;

  return {
    get registry(): WorkflowRegistry {
      return registry;
    },

    dispatch(args: WorkflowToolArgs): Promise<WorkflowToolResult> {
      return dispatch(args, { registry, adapters, ui, store: activeStore, cancellation, persistence, mcp, config });
    },
  };
}
