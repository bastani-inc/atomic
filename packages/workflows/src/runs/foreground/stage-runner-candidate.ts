import type { WorkflowModelAttempt } from "../../shared/types.js";
import type { WorkflowResolvedModelCandidate } from "../shared/model-fallback.js";

export function effectiveCandidateReasoning(
	candidate: WorkflowResolvedModelCandidate,
): WorkflowResolvedModelCandidate["reasoningLevel"] {
	return candidate.reasoningLevel;
}

export function modelAttemptReasoning(
	candidate: WorkflowResolvedModelCandidate,
): Pick<WorkflowModelAttempt, "reasoningLevel"> {
	const reasoningLevel = effectiveCandidateReasoning(candidate);
	return reasoningLevel !== undefined ? { reasoningLevel } : {};
}

export function candidateLabel(candidate: WorkflowResolvedModelCandidate): string {
	return candidate.reasoningLevel !== undefined ? `${candidate.id}:${candidate.reasoningLevel}` : candidate.id;
}
