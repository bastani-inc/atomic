/**
 * Cross-process workflow resume using DBOS as the sole source of state.
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
import { launchDetachedUntilStartup, workflowStartupFailureMessage } from "../runs/background/startup-admission.js";
import type { JobTracker } from "../runs/background/job-tracker.js";
import { resolveAndValidateInputs } from "../runs/foreground/executor-inputs.js";
import { getDurableBackend } from "./factory.js";

import { resumableEntryFromHandle, type DurableWorkflowBackend } from "./backend.js";
import type { ResumableWorkflowEntry } from "./types.js";
import { isDurableWorkflowResumable, isForeignLiveWorkflow } from "./resume-eligibility.js";
import { getAtomicExecutorId } from "./dbos-sdk-handle.js";
import { workflowDefinitionRequirementMessage } from "../runs/foreground/executor-child-helpers.js";
import { isWorkflowDefinition } from "../runs/foreground/executor-child-helpers.js";
import type { RunSnapshot } from "../shared/store-types.js";

export type ResumeDurableResult =
  | { ok: true; runId: string; workflowId: string; name: string; message: string }
  | { ok: false; reason: "workflow_not_found" | "not_resumable" | "invalid_inputs" | "not_registered" | "stale" | "startup_failed"; message: string };

export interface ResumeDurableDeps {
  readonly registry: WorkflowRegistry;
  /** Base run options forwarded to the detached runner (store, persistence, …). */
  readonly baseRunOpts: RunOpts;
  /** Durable backend override (defaults to the global singleton). */
  readonly durableBackend?: DurableWorkflowBackend;
  /** Job tracker used by the detached resume launch. */
  readonly jobs?: JobTracker;
}

/** Hydrate current DBOS metadata and checkpoints before synchronous replay reads. */
export async function prepareDurableResume(
  workflowIdOrPrefix: string | undefined,
  deps: ResumeDurableDeps,
): Promise<readonly ResumableWorkflowEntry[]> {
  const backend = deps.durableBackend ?? getDurableBackend();
  await backend.hydrateResumableWorkflows();
  const catalog = backend.listResumableWorkflows();
  // If a specific target was requested, hydrate that workflow too (it might
  // be resumable but not yet in the resumable filter — e.g. recently failed).
  if (workflowIdOrPrefix !== undefined) {
    const resolved = resolveDurableEntry(workflowIdOrPrefix, catalog);
    if (resolved !== undefined && !("kind" in resolved)) {
      await backend.hydrateWorkflow(resolved.workflowId);
    }
  }
  return backend.listResumableWorkflows();
}

/** Resolve a current DBOS catalog entry by full id or unique prefix. */
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

/** Resume by DBOS workflow id and replay current persisted checkpoints. */
export async function resumeDurableWorkflow(
  workflowIdOrPrefix: string,
  deps: ResumeDurableDeps,
  catalog?: readonly ResumableWorkflowEntry[],
): Promise<ResumeDurableResult> {
  const backend = deps.durableBackend ?? getDurableBackend();
  const resolvedCatalog = catalog ?? backend.listResumableWorkflows();
  const resolved = resolveDurableEntry(workflowIdOrPrefix, resolvedCatalog);
  if (resolved === undefined) {
    const direct = backend.getWorkflow(workflowIdOrPrefix);
    if (direct !== undefined && direct.status === "running") {
      if (hasActiveLiveRun(deps.baseRunOpts.store, direct.workflowId)) {
        return alreadyRunningResult(direct.name, direct.workflowId, deps.baseRunOpts.store);
      }
      if (isForeignLiveWorkflow(direct, getAtomicExecutorId())) {
        return foreignRunningResult(direct.name, direct.workflowId);
      }
    }
    if (!backend.isWorkflowLoadable(workflowIdOrPrefix)) {
      return {
        ok: false,
        reason: "not_registered",
        message: `Workflow ${workflowIdOrPrefix.slice(0, 8)} has no valid current DBOS state.`,
      };
    }
    return { ok: false, reason: "not_registered", message: `No resumable workflow found for id/prefix: ${workflowIdOrPrefix}` };
  }
  if ("kind" in resolved) {
    return {
      ok: false,
      reason: "not_registered",
      message: `Ambiguous workflow prefix "${workflowIdOrPrefix}" matches: ${resolved.matches.map((m) => `${m.name} (${m.workflowId.slice(0, 8)})`).join(", ")}`,
    };
  }
  if (!backend.isWorkflowLoadable(resolved.workflowId)) {
    return {
      ok: false,
      reason: "not_registered",
      message: `Workflow ${resolved.workflowId.slice(0, 8)} has no valid current DBOS state.`,
    };
  }
  // Revalidate the authoritative DBOS handle before resume. A running handle
  // is refused when this process still has an actively executing run, or when
  // fresh ownership metadata shows another Atomic session is executing it.
  const handle = backend.getWorkflow(resolved.workflowId);
  if (handle === undefined) {
    return {
      ok: false,
      reason: "stale",
      message: `Workflow ${resolved.workflowId.slice(0, 8)} has no current DBOS checkpoint state; re-run the workflow to start fresh.`,
    };
  }

  if (handle.status === "running") {
    if (hasActiveLiveRun(deps.baseRunOpts.store, resolved.workflowId)) {
      return alreadyRunningResult(handle.name, resolved.workflowId, deps.baseRunOpts.store);
    }
    if (isForeignLiveWorkflow(handle, getAtomicExecutorId())) {
      return foreignRunningResult(handle.name, resolved.workflowId);
    }
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

  // Claim resume against concurrent deletion through the required transition seam.
  const claimed = await backend.transitionWorkflowStatus(
    resolved.workflowId,
    [handle.status],
    "running",
  );
  if (!claimed) {
    return {
      ok: false,
      reason: "stale",
      message: `Workflow ${resolved.workflowId.slice(0, 8)} changed while resume was pending; refresh the workflow list and try again.`,
    };
  }

  const resumeRunOpts: RunOpts = {
    ...deps.baseRunOpts,
    ...(handle.invocationCwd !== undefined ? { cwd: handle.invocationCwd } : {}),
    runId: resolved.workflowId,
    durableBackend: backend,
  };

  let launch: ReturnType<typeof launchDetachedUntilStartup>;
  try {
    launch = launchDetachedUntilStartup(def, inputs, {
      ...resumeRunOpts,
      ...(deps.jobs !== undefined ? { jobs: deps.jobs } : {}),
    });
  } catch (error) {
    backend.setWorkflowStatus(resolved.workflowId, handle.status, handle.pendingPrompts, handle.resumable);
    await backend.flush();
    return { ok: false, reason: "startup_failed", message: `Failed to resume durable workflow ${resolved.workflowId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const { accepted } = launch;
  const admission = await launch.wait;
  if (!admission.started) {
    const snapshot = deps.baseRunOpts.store?.runs().find((run) => run.id === accepted.runId);
    const error = workflowStartupFailureMessage(
      admission,
      snapshot?.error,
      `Workflow ${resolved.workflowId.slice(0, 8)} ended before startup admission`,
    );
    deps.baseRunOpts.store?.removeRun(accepted.runId);
    backend.setWorkflowStatus(resolved.workflowId, handle.status, handle.pendingPrompts, handle.resumable);
    await backend.flush();
    return { ok: false, reason: "startup_failed", message: `Failed to resume durable workflow ${resolved.workflowId.slice(0, 8)}: ${error}` };
  }

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
function foreignRunningResult(name: string, workflowId: string): ResumeDurableResult {
  return {
    ok: false,
    reason: "not_resumable",
    message: `Workflow "${name}" (${workflowId.slice(0, 8)}) is actively running in another Atomic session. `
      + "Control it from that session; it becomes resumable here only after that session pauses, quits, or crashes.",
  };
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

/** Remove local snapshots that do not exist as valid current DBOS workflows. */
export function purgeSuppressedWorkflowRuns(backend: DurableWorkflowBackend, store: RunOpts["store"]): readonly string[] {
  if (store === undefined) return [];
  const removed: string[] = [];
  for (const run of store.runs()) {
    if (backend.isWorkflowLoadable(run.id)) continue;
    if (store.removeRun(run.id)) removed.push(run.id);
  }
  return removed;
}

/** Hydrate a bounded set of known DBOS workflow ids. */
export async function prepareTargetedDurableResumable(
  backend: DurableWorkflowBackend,
  workflowIds: readonly string[],
): Promise<readonly ResumableWorkflowEntry[]> {
  const entries: ResumableWorkflowEntry[] = [];
  const seen = new Set<string>();
  for (const workflowId of workflowIds) {
    if (seen.has(workflowId)) continue;
    seen.add(workflowId);
    await backend.hydrateWorkflow(workflowId);
    const handle = backend.getLoadableWorkflow(workflowId);
    if (handle === undefined || !isDurableWorkflowResumable(handle)) continue;
    entries.push(resumableEntryFromHandle(handle));
  }
  return entries;
}

export async function prepareRuntimeDurableResumable(
  getBackend: () => DurableWorkflowBackend,
  workflowIdOrPrefix?: string,
): Promise<readonly ResumableWorkflowEntry[]> {
  const backend = getBackend();
  await backend.hydrateResumableWorkflows();
  if (workflowIdOrPrefix !== undefined) {
    const resolved = resolveDurableEntry(workflowIdOrPrefix, backend.listResumableWorkflows());
    if (resolved !== undefined && !("kind" in resolved)) await backend.hydrateWorkflow(resolved.workflowId);
  }
  return backend.listResumableWorkflows();
}
