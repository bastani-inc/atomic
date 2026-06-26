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
import type { RunSnapshot } from "../shared/store-types.js";

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
    // Not in the (filtered) resumable catalog. It may still be a workflow the
    // backend knows about. Only surface "already running" when there is a live,
    // actively-executing run for it in this session; otherwise a `running`
    // durable handle is a crashed process and falls through to not-found.
    const direct = backend.getWorkflow(workflowIdOrPrefix);
    if (direct !== undefined && direct.status === "running" && hasActiveLiveRun(deps.baseRunOpts.store, direct.workflowId)) {
      return alreadyRunningResult(direct.name, direct.workflowId, deps.baseRunOpts.store);
    }
    return { ok: false, reason: "not_registered", message: `No durable workflow found for id/prefix: ${workflowIdOrPrefix}` };
  }
  if ("kind" in resolved) {
    return {
      ok: false,
      reason: "not_registered",
      message: `Ambiguous workflow prefix "${workflowIdOrPrefix}" matches: ${resolved.matches.map((m) => `${m.name} (${m.workflowId.slice(0, 8)})`).join(", ")}`,
    };
  }
  // Authoritative backend-handle check: a cache-only entry (no handle) is
  // "stale" regardless of its cached status. A `running` handle is only
  // refused when there is a live, actively-executing run for it in THIS
  // session — otherwise it is a crashed process and cross-session crash
  // recovery should proceed.
  const handle = backend.getWorkflow(resolved.workflowId);
  if (handle === undefined) {
    return {
      ok: false,
      reason: "stale",
      message: `Workflow ${resolved.workflowId.slice(0, 8)} has only session-cache metadata and no durable checkpoint state; resume would re-run from scratch. Re-run the workflow to start fresh.`,
    };
  }
  if (handle.status === "running" && hasActiveLiveRun(deps.baseRunOpts.store, resolved.workflowId)) {
    return alreadyRunningResult(resolved.name, resolved.workflowId, deps.baseRunOpts.store);
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

  const inputs: Record<string, unknown> = { ...handle.inputs };
  try {
    resolveAndValidateInputs(def.inputs, inputs as WorkflowInputValues, `workflow "${def.name}"`);
  } catch (err) {
    return { ok: false, reason: "invalid_inputs", message: `invalid_inputs: ${err instanceof Error ? err.message : String(err)}` };
  }
  removeDurableResumeShadowRuns(deps.baseRunOpts.store, resolved.workflowId);


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

function isDurableResumeShadow(run: RunSnapshot): boolean {
  return run.endedAt !== undefined || run.exitReason === "quit" || run.status === "paused";
}

function removeDurableResumeShadowRuns(store: RunOpts["store"], workflowId: string): void {
  if (store === undefined) return;
  for (;;) {
    const existing = store.runs().find((run) => run.id === workflowId);
    if (existing === undefined || !isDurableResumeShadow(existing)) return;
    if (!store.removeRun(workflowId)) return;
  }
}

function alreadyRunningResult(name: string, workflowId: string, store: RunOpts["store"]): ResumeDurableResult {
  const here = store?.runs().some((r) => r.id === workflowId && r.endedAt === undefined) === true;
  return {
    ok: false,
    reason: "not_resumable",
    message: `Workflow "${name}" (${workflowId.slice(0, 8)}) is already running${
      here ? " in this session" : " in another session"
    }. Attach with \`/workflow connect ${workflowId.slice(0, 8)}\`, or if that session has ended, clear it with \`/workflow kill ${workflowId.slice(0, 8)}\` and re-run.`,
  };
}

function hasResumeProgress(entry: ResumableWorkflowEntry): boolean {
  return entry.completedCheckpoints > 0 || entry.pendingPrompts > 0;
}

function isResumableEntry(entry: ResumableWorkflowEntry): boolean {
  const isRoot = entry.rootWorkflowId === undefined || entry.rootWorkflowId === entry.workflowId;
  if (!isRoot) return false;
  if (entry.status === "failed" || entry.status === "blocked") return entry.resumable !== false;
  // `running` is resumable at this layer: a `running` durable handle may be a
  // crashed process. Same-session double-resume is blocked separately via
  // `hasActiveLiveRun` before dispatch.
  return (entry.status === "running" || entry.status === "paused") && hasResumeProgress(entry);
}

/**
 * True when the live run store has an actively-executing (not ended, not quit)
 * run for `workflowId`. This is the only reliable signal that a durable
 * `running` handle is genuinely live in THIS process — distinguishing a real
 * double-resume from cross-session crash recovery.
 */
function hasActiveLiveRun(store: RunOpts["store"] | undefined, workflowId: string): boolean {
  if (store === undefined) return false;
  return store.runs().some((r) => r.id === workflowId && r.endedAt === undefined && r.exitReason !== "quit");
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

function hasBackendResumeState(backend: DurableWorkflowBackend, workflowId: string): boolean {
  return backend.getWorkflow(workflowId) !== undefined;
}

/**
 * Runtime-facing async preparation: hydrate the durable backend from DBOS
 * (when supported) then list resumable workflows with optional session-dir
 * scan merge. Used by the ExtensionRuntime's `prepareDurableResumable`.
 *
 * Stale-cache suppression: when a session JSONL cache entry has no matching
 * durable backend handle, it came from an older/non-checkpointed workflow
 * engine and is hidden from selectors. When the backend knows a workflow is
 * terminal (completed/cancelled/non-resumable), stale cache rows for that id
 * are also suppressed. cross-ref: issue #1498.
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
  // Suppress cache-only entries from older workflow engines. Without a
  // durable backend handle/checkpoint state, selecting the row can only fail
  // as stale (or risk re-running from scratch), so it should not clutter the
  // resume selector.
  const suppressed = scanned.filter((e) =>
    !liveIds.has(e.workflowId) &&
    hasBackendResumeState(backend, e.workflowId) &&
    !isBackendTerminal(backend, e.workflowId)
  );
  return [...live, ...suppressed];
}
