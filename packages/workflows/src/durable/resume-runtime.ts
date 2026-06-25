/**
 * Cross-session durable workflow resume adapter.
 *
 * Resumes a workflow whose durable checkpoints live in the durable backend
 * (and are mirrored to the session JSONL cache) but whose in-process run is no
 * longer live. This is the production path behind `/workflow resume <id>` when
 * the id names a durable workflow that is not present in the live run store.
 *
 * Resume semantics (DBOS-aligned):
 *   1. Look up the durable catalog entry (workflow name + cached inputs).
 *   2. Resolve the workflow definition from the registry.
 *   3. Re-dispatch the workflow as a new background run, reusing the ORIGINAL
 *      top-level workflow id as the run id. Because durable checkpoints are
 *      keyed by workflow id, every `ctx.tool` / `ctx.ui` / `ctx.stage` call
 *      inside the resumed run returns its cached result instead of re-executing
 *      — completed side effects are not repeated, exactly like DBOS replay.
 *
 * The adapter deliberately re-dispatches through `runDetached` rather than
 * reconstructing an in-memory snapshot, so it works across processes and
 * sessions without a live store entry.
 *
 * cross-ref: issue #1498 — "/workflow resume connects/attempts resume by
 * top-level workflow id."
 */

import type { WorkflowInputValues } from "../shared/types.js";
import type { WorkflowRegistry } from "../workflows/registry.js";
import type { RunOpts } from "../runs/foreground/executor-types.js";
import { runDetached, type DetachedAccepted } from "../runs/background/runner.js";
import { resolveAndValidateInputs } from "../runs/foreground/executor-inputs.js";
import { getDurableBackend } from "./factory.js";
import type { DurableWorkflowBackend } from "./backend.js";
import type { ResumableWorkflowEntry } from "./types.js";
import { workflowDefinitionRequirementMessage } from "../runs/foreground/executor-child-helpers.js";
import { isWorkflowDefinition } from "../runs/foreground/executor-child-helpers.js";

export type ResumeDurableResult =
  | { ok: true; runId: string; workflowId: string; name: string; message: string }
  | { ok: false; reason: "workflow_not_found" | "not_resumable" | "invalid_inputs" | "not_registered" | "stale"; message: string };

export interface ResumeDurableDeps {
  readonly registry: WorkflowRegistry;
  /** Base run options forwarded to the detached runner (store, persistence, …). */
  readonly baseRunOpts: RunOpts;
  /** Durable backend override (defaults to the global singleton). */
  readonly durableBackend?: DurableWorkflowBackend;
}

/**
 * Prepare a durable resume: hydrate the backend's in-memory mirror from the
 * persistent store (DBOS) so synchronous reads in {@link resumeDurableWorkflow}
 * find the workflow and its checkpoints. No-op for backends without hydration.
 *
 * Must be awaited before calling {@link resumeDurableWorkflow} when the backend
 * might be a fresh DBOS process.
 */
export async function prepareDurableResume(
  workflowIdOrPrefix: string | undefined,
  deps: ResumeDurableDeps,
): Promise<readonly ResumableWorkflowEntry[]> {
  const backend = deps.durableBackend ?? getDurableBackend();
  // Hydrate all resumable workflows first so the catalog is complete.
  if (backend.hydrateResumableWorkflows !== undefined) {
    await backend.hydrateResumableWorkflows();
  }
  const catalog = backend.listResumableWorkflows();
  // If a specific target was requested, hydrate that workflow too (it might
  // be resumable but not yet in the resumable filter — e.g. recently failed).
  if (workflowIdOrPrefix !== undefined) {
    const resolved = resolveDurableEntry(workflowIdOrPrefix, catalog);
    if (resolved !== undefined && !("kind" in resolved)) {
      if (backend.hydrateWorkflow !== undefined) {
        await backend.hydrateWorkflow(resolved.workflowId);
      }
    }
  }
  return backend.listResumableWorkflows();
}

/**
 * Resolve a durable catalog entry for a workflow id (full or prefix match).
 * Prefers the durable backend's resumable list; falls back to an explicit
 * session-scan catalog when provided by the caller.
 */
export function resolveDurableEntry(
  workflowIdOrPrefix: string,
  catalog: readonly ResumableWorkflowEntry[],
): ResumableWorkflowEntry | { kind: "ambiguous"; matches: readonly ResumableWorkflowEntry[] } | undefined {
  const exact = catalog.find((entry) => entry.workflowId === workflowIdOrPrefix);
  if (exact !== undefined) return exact;
  const prefixMatches = catalog.filter((entry) => entry.workflowId.startsWith(workflowIdOrPrefix));
  if (prefixMatches.length === 0) return undefined;
  if (prefixMatches.length === 1) return prefixMatches[0];
  return { kind: "ambiguous", matches: prefixMatches };
}

/**
 * Resume a durable workflow by top-level workflow id. Re-dispatches the workflow
 * with the cached inputs and the original workflow id so durable checkpoints
 * replay (skipping completed side effects).
 */
export function resumeDurableWorkflow(
  workflowIdOrPrefix: string,
  deps: ResumeDurableDeps,
  catalog?: readonly ResumableWorkflowEntry[],
): ResumeDurableResult {
  const backend = deps.durableBackend ?? getDurableBackend();
  const resolvedCatalog = catalog ?? backend.listResumableWorkflows();
  const resolved = resolveDurableEntry(workflowIdOrPrefix, resolvedCatalog);
  if (resolved === undefined) {
    return { ok: false, reason: "not_registered", message: `No durable workflow found for id/prefix: ${workflowIdOrPrefix}` };
  }
  if ("kind" in resolved) {
    return {
      ok: false,
      reason: "not_registered",
      message: `Ambiguous workflow prefix "${workflowIdOrPrefix}" matches: ${resolved.matches.map((m) => `${m.name} (${m.workflowId.slice(0, 8)})`).join(", ")}`,
    };
  }
  if (!isResumableEntry(resolved)) {
    return { ok: false, reason: "not_resumable", message: `Workflow ${resolved.workflowId.slice(0, 8)} is ${resolved.status}, not resumable.` };
  }

  const def = deps.registry.get(resolved.name);
  if (def === undefined) {
    return { ok: false, reason: "workflow_not_found", message: `Workflow definition not found: ${resolved.name}` };
  }
  if (!isWorkflowDefinition(def)) {
    return { ok: false, reason: "workflow_not_found", message: workflowDefinitionRequirementMessage("resumeDurableWorkflow", def) };
  }

  // Refuse cache-only resume: if the durable backend has no registered handle
  // for this workflow, the entry was discovered solely from session JSONL
  // metadata. Resuming would silently re-run from scratch (no checkpoints to
  // replay), which the issue explicitly forbids. Surface it as stale so the
  // caller can re-run explicitly instead.
  // cross-ref: issue #1498 — do not silently re-run from cache-only metadata.
  const handle = backend.getWorkflow(resolved.workflowId);
  if (handle === undefined) {
    return {
      ok: false,
      reason: "stale",
      message: `Workflow ${resolved.workflowId.slice(0, 8)} has only session-cache metadata and no durable checkpoint state; resume would re-run from scratch. Re-run the workflow to start fresh.`,
    };
  }

  const inputs: Record<string, unknown> = { ...handle.inputs };
  try {
    resolveAndValidateInputs(def.inputs, inputs as WorkflowInputValues, `workflow "${def.name}"`);
  } catch (err) {
    return { ok: false, reason: "invalid_inputs", message: `invalid_inputs: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Mark the workflow as resuming in the backend, then re-dispatch with the
  // ORIGINAL workflow id as the run id so durable checkpoints replay.
  backend.setWorkflowStatus(resolved.workflowId, "running");

  const accepted: DetachedAccepted = runDetached(def, inputs, {
    ...deps.baseRunOpts,
    runId: resolved.workflowId,
    durableBackend: backend,
  });

  return {
    ok: true,
    runId: accepted.runId,
    workflowId: resolved.workflowId,
    name: resolved.name,
    message: `Resuming durable workflow "${resolved.name}" (${resolved.workflowId.slice(0, 8)}) — completed checkpoints will be replayed.`,
  };
}

function isResumableEntry(entry: ResumableWorkflowEntry): boolean {
  const isRoot = entry.rootWorkflowId === undefined || entry.rootWorkflowId === entry.workflowId;
  if (!isRoot) return false;
  if (entry.status === "failed" || entry.status === "blocked") return entry.resumable !== false;
  return entry.status === "running" || entry.status === "paused";
}

/**
 * Check whether the durable backend records a TERMINAL (non-resumable) status
 * for the given workflow id. Terminal status suppresses stale session-cache
 * entries so a completed/cancelled workflow is not resurrected as resumable.
 *
 * Returns true only when the backend has a registered handle whose status is
 * definitively terminal (completed, cancelled, or failed-and-non-resumable).
 */
export function isBackendTerminal(backend: DurableWorkflowBackend, workflowId: string): boolean {
  const handle = backend.getWorkflow(workflowId);
  if (handle === undefined) return false;
  const status = handle.status;
  if (status === "completed" || status === "cancelled") return true;
  if (status === "failed" || status === "blocked") return handle.resumable === false;
  return false;
}

/**
 * Runtime-facing async preparation: hydrate the durable backend from DBOS
 * (when supported) then list resumable workflows with optional session-dir
 * scan merge. Used by the ExtensionRuntime's `prepareDurableResumable`.
 *
 * Terminal-state suppression: when the backend knows a workflow is terminal
 * (completed/cancelled/non-resumable), any stale session-cache entry for the
 * same workflow id is suppressed so terminal workflows cannot be resurrected
 * from the JSONL cache. cross-ref: issue #1498.
 */
export async function prepareRuntimeDurableResumable(
  getBackend: () => DurableWorkflowBackend,
  resolveSessionDir: () => string | undefined,
  workflowIdOrPrefix?: string,
  sessionDir?: string,
): Promise<readonly ResumableWorkflowEntry[]> {
  const backend = getBackend();
  if (backend.hydrateResumableWorkflows !== undefined) {
    await backend.hydrateResumableWorkflows();
  }
  if (workflowIdOrPrefix !== undefined && backend.hydrateWorkflow !== undefined) {
    const catalog = backend.listResumableWorkflows();
    const resolved = resolveDurableEntry(workflowIdOrPrefix, catalog);
    if (resolved !== undefined && !("kind" in resolved)) {
      await backend.hydrateWorkflow(resolved.workflowId);
    }
  }
  const live = backend.listResumableWorkflows();
  const effectiveSessionDir = sessionDir ?? resolveSessionDir();
  if (effectiveSessionDir === undefined) return live;
  const { scanResumableWorkflows } = await import("./resume-catalog.js");
  const scanned = scanResumableWorkflows(effectiveSessionDir);
  const liveIds = new Set(live.map((e) => e.workflowId));
  // Suppress stale session-cache entries whose backend status is terminal.
  // The backend is the checkpoint source of truth; JSONL cache entries can
  // lag behind terminal transitions (completed/cancelled) and would otherwise
  // resurrect terminal workflows as resumable.
  const suppressed = scanned.filter((e) => !liveIds.has(e.workflowId) && !isBackendTerminal(backend, e.workflowId));
  return [...live, ...suppressed];
}
