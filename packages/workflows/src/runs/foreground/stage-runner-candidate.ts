import type { StageOptions, WorkflowModelAttempt } from "../../shared/types.js";
import type { WorkflowResolvedModelCandidate } from "../shared/model-fallback.js";

export function effectiveCandidateReasoning(
  candidate: WorkflowResolvedModelCandidate,
  fallback: StageOptions["thinkingLevel"] | undefined,
): StageOptions["thinkingLevel"] | undefined {
  return candidate.reasoningLevel ?? fallback;
}

export function modelAttemptReasoning(
  candidate: WorkflowResolvedModelCandidate,
  fallback: StageOptions["thinkingLevel"] | undefined,
): Pick<WorkflowModelAttempt, "reasoningLevel"> {
  const reasoningLevel = effectiveCandidateReasoning(candidate, fallback);
  return reasoningLevel !== undefined ? { reasoningLevel } : {};
}

export function candidateLabel(candidate: WorkflowResolvedModelCandidate): string {
  return candidate.reasoningLevel !== undefined ? `${candidate.id}:${candidate.reasoningLevel}` : candidate.id;
}
