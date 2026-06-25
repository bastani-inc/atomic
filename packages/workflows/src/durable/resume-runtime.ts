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
  | { ok: false; reason: "workflow_not_found" | "not_resumable" | "invalid_inputs" | "not_registered"; message: string };

export interface ResumeDurableDeps {
  readonly registry: WorkflowRegistry;
  /** Base run options forwarded to the detached runner (store, persistence, …). */
  readonly baseRunOpts: RunOpts;
  /** Durable backend override (defaults to the global singleton). */
  readonly durableBackend?: DurableWorkflowBackend;
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
  if (!isResumableStatus(resolved.status)) {
    return { ok: false, reason: "not_resumable", message: `Workflow ${resolved.workflowId.slice(0, 8)} is ${resolved.status}, not resumable.` };
  }

  const def = deps.registry.get(resolved.name);
  if (def === undefined) {
    return { ok: false, reason: "workflow_not_found", message: `Workflow definition not found: ${resolved.name}` };
  }
  if (!isWorkflowDefinition(def)) {
    return { ok: false, reason: "workflow_not_found", message: workflowDefinitionRequirementMessage("resumeDurableWorkflow", def) };
  }

  // Inputs live on the durable workflow handle (source of truth), not the
  // resume catalog entry (which is a discovery cache). Fall back to empty
  // inputs when the handle is unavailable.
  const handle = backend.getWorkflow(resolved.workflowId);
  const inputs: Record<string, unknown> = handle !== undefined ? { ...handle.inputs } : {};
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

function isResumableStatus(status: ResumableWorkflowEntry["status"]): boolean {
  return status === "running" || status === "paused" || status === "failed" || status === "blocked";
}
