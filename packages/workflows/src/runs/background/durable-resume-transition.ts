import type { DurableWorkflowBackend } from "../../durable/backend.js";
import { getDurableBackend } from "../../durable/factory.js";

const pendingRunningTransitions = new WeakMap<DurableWorkflowBackend, Set<string>>();

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
export async function markDurableResumed(runId: string): Promise<void> {
  const backend = getDurableBackend();
  const pending = transitionsFor(backend);
  const status = backend.getWorkflow(runId)?.status;
  if (!pending.has(runId) && status !== "paused") return;
  if (pending.has(runId) && status !== "paused" && status !== "running") {
    pending.delete(runId);
    return;
  }
  pending.add(runId);
  try {
    // Reissue even when an earlier failed flush already changed the local
    // mirror to running. Persistent backends need a new queued write to retry.
    backend.setWorkflowStatus(runId, "running");
    await backend.flush?.();
    pending.delete(runId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to persist resumed workflow ${runId}: ${detail}`);
  }
}
