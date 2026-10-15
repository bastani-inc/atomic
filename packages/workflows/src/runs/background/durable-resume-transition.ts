import type { DurableWorkflowBackend } from "../../durable/backend.js";
import { getDurableBackend } from "../../durable/factory.js";
import {
	getLoadableDurableWorkflow,
	transitionDurableWorkflowStatus,
} from "../../durable/workflow-status-transition.js";

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

/** Persist the root running transition after visible local resume. */
export async function markDurableResumed(runId: string): Promise<DurableResumeTransitionOutcome> {
	const backend = getDurableBackend();
	const pending = transitionsFor(backend);
	const handle = getLoadableDurableWorkflow(backend, runId);
	if (handle === undefined || handle.status === "running") return "not_needed";
	if (handle.status !== "paused") return "refused";
	pending.add(runId);
	try {
		const transitioned = await transitionDurableWorkflowStatus(backend, runId, ["paused"], "running");
		if (!transitioned) {
			const authoritative = getLoadableDurableWorkflow(backend, runId);
			return authoritative?.status === "running" ? "not_needed" : "refused";
		}
		return "transitioned";
	} finally {
		pending.delete(runId);
	}
}
