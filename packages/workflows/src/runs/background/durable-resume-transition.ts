import type { DurableWorkflowBackend } from "../../durable/backend.js";
import {
  getLoadableDurableWorkflow,
  transitionDurableWorkflowStatus,
} from "../../durable/workflow-status-transition.js";
import { getDurableBackend } from "../../durable/factory.js";

const pendingRunningTransitions = new WeakMap<DurableWorkflowBackend, Set<string>>();

export type DurableResumeTransitionOutcome = "transitioned" | "not_needed" | "refused";

function transitionsFor(backend: DurableWorkflowBackend): Set<string> {
  let transitions = pendingRunningTransitions.get(backend);
  if (transitions === undefined) {
    transitions = new Set();
    pendingRunningTransitions.set(backend, transitions);
  }
  return transitions;
}

/** Whether a previous visible resume still needs its durable running write. */
export function hasPendingDurableResumeTransition(runId: string): boolean {
  return pendingRunningTransitions.get(getDurableBackend())?.has(runId) ?? false;
}

/** Persist and flush the root running transition after visible local resume. */
export async function markDurableResumed(runId: string): Promise<DurableResumeTransitionOutcome> {
  const backend = getDurableBackend();
  const pending = transitionsFor(backend);
  const handle = getLoadableDurableWorkflow(backend, runId);
  if (handle === undefined) {
    pending.delete(runId);
    return "not_needed";
  }
  if (!pending.has(runId) && handle.status === "running") return "not_needed";
  if (!pending.has(runId) && handle.status !== "paused") return "refused";
  if (pending.has(runId) && handle.status !== "paused" && handle.status !== "running") {
    pending.delete(runId);
    return "refused";
  }
  pending.add(runId);
  try {
    // Reissue even when an earlier failed flush already changed the local
    // mirror to running. Persistent backends need a new queued write to retry.
    const transitioned = await transitionDurableWorkflowStatus(
      backend,
      runId,
      pending.has(runId) ? ["paused", "running"] : ["paused"],
      "running",
    );
    if (!transitioned) {
      pending.delete(runId);
      const authoritative = getLoadableDurableWorkflow(backend, runId);
      return authoritative?.status === "running" ? "not_needed" : "refused";
    }
    await backend.flush?.();
    pending.delete(runId);
    return "transitioned";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to persist resumed workflow ${runId}: ${detail}`);
  }
}
