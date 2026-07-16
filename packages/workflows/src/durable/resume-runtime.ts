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
import { resumableEntryFromHandle, type DurableWorkflowBackend } from "./backend.js";
import type { ResumableWorkflowEntry } from "./types.js";
import { isDurableWorkflowResumable } from "./resume-eligibility.js";
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
    if (!backend.isWorkflowLoadable(workflowIdOrPrefix)) {
      return { ok: false, reason: "not_registered", message: `Durable workflow ${workflowIdOrPrefix.slice(0, 8)} uses an incompatible or unavailable persisted format and cannot be resumed.` };
    }
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
  if (!backend.isWorkflowLoadable(resolved.workflowId)) {
    return { ok: false, reason: "not_registered", message: `Durable workflow ${resolved.workflowId.slice(0, 8)} uses an incompatible or unavailable persisted format and cannot be resumed.` };
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
    return alreadyRunningResult(handle.name, resolved.workflowId, deps.baseRunOpts.store);
  }
  if (!isDurableWorkflowResumable(handle)) {
    return { ok: false, reason: "not_resumable", message: `Workflow ${resolved.workflowId.slice(0, 8)} is ${handle.status}, not resumable.` };
  }

  const def = deps.registry.get(handle.name);
  if (def === undefined) {
    return { ok: false, reason: "workflow_not_found", message: `Workflow definition not found: ${handle.name}` };
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

  const resumeRunOpts: RunOpts = {
    ...deps.baseRunOpts,
    ...(handle.invocationCwd !== undefined ? { cwd: handle.invocationCwd } : {}),
    runId: resolved.workflowId,
    durableBackend: backend,
  };

  const accepted: DetachedAccepted = runDetached(def, inputs, resumeRunOpts);

  return {
    ok: true,
    runId: accepted.runId,
    workflowId: resolved.workflowId,
    name: handle.name,
    message: `Resuming durable workflow "${handle.name}" (${resolved.workflowId.slice(0, 8)}) — completed checkpoints will be replayed.`,
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
    }. See agents working and chat with or steer each stage using \`/workflow connect ${workflowId.slice(0, 8)}\`; use \`/workflow quit ${workflowId.slice(0, 8)}\` to pause the run for later resume.`,
  };
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
/** Remove restored/live snapshots whose authoritative durable format is non-loadable. */
export function purgeSuppressedWorkflowRuns(backend: DurableWorkflowBackend, store: RunOpts["store"]): readonly string[] {
  if (store === undefined) return [];
  const removed: string[] = [];
  for (const run of store.runs()) {
    if (backend.isWorkflowLoadable(run.id)) continue;
    if (store.removeRun(run.id)) removed.push(run.id);
  }
  return removed;
}

/**
 * Targeted durable preparation: resolve ONLY the given workflow ids by reading
 * their per-workflow state files (O(ids)), never enumerating the durable
 * directory or scanning session transcripts. Used by `session_start` and
 * mid-run resume-shadow paths, which always know the concrete ids they need.
 *
 * cross-ref: startup performance — a full `~/.atomic/workflow-durable` scan on
 * every session start scaled with total workflow history (seconds to minutes),
 * not with the current session.
 */
export async function prepareTargetedDurableResumable(
  backend: DurableWorkflowBackend,
  workflowIds: readonly string[],
): Promise<readonly ResumableWorkflowEntry[]> {
  const entries: ResumableWorkflowEntry[] = [];
  const seen = new Set<string>();
  for (const workflowId of workflowIds) {
    if (seen.has(workflowId)) continue;
    seen.add(workflowId);
    if (backend.hydrateWorkflow !== undefined) {
      await backend.hydrateWorkflow(workflowId);
    }
    const handle = backend.getLoadableWorkflow !== undefined
      ? backend.getLoadableWorkflow(workflowId)
      : backend.isWorkflowLoadable(workflowId) ? backend.getWorkflow(workflowId) : undefined;
    if (handle === undefined || !isDurableWorkflowResumable(handle)) continue;
    entries.push(resumableEntryFromHandle(handle));
  }
  return entries;
}

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
  const suppressed = scanned.filter((entry) => {
    const handle = backend.getWorkflow(entry.workflowId);
    return !liveIds.has(entry.workflowId) && handle !== undefined && isDurableWorkflowResumable(handle);
  });
  return [...live, ...suppressed];
}
