import { WorkflowPromptModelFailure } from "./stage-runner-messages.js";

export function unresolvedContextOverflowMessage(event: unknown): string | undefined {
  if (event === null || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  if (record["type"] !== "compaction_end" || record["unresolvedOverflow"] !== true) return undefined;
  const message = record["errorMessage"];
  return typeof message === "string" && message.trim().length > 0
    ? message
    : "Context overflow recovery was exhausted for the current model.";
}

export function unresolvedContextOverflowFailure(message: string): WorkflowPromptModelFailure {
  return new WorkflowPromptModelFailure({ message, code: "context_length_exceeded", stopReason: "error" });
}

export function isUnresolvedContextOverflowFailure(error: unknown): boolean {
  if (!(error instanceof WorkflowPromptModelFailure)) return false;
  const cause = error.cause;
  if (cause === null || typeof cause !== "object") return false;
  return (cause as { readonly code?: unknown }).code === "context_length_exceeded";
}

export function nextResumedContextOverflowFallbackIndex(error: unknown, currentIndex: number | undefined, candidateCount: number): number | "terminal" | undefined {
  if (!isUnresolvedContextOverflowFailure(error) || currentIndex === undefined) return undefined;
  const nextIndex = currentIndex + 1;
  return nextIndex >= candidateCount ? "terminal" : nextIndex;
}

export function terminatingToolCallId(event: unknown): string | undefined {
  if (event === null || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const result = record["result"];
  if (record["type"] !== "tool_execution_end" || result === null || typeof result !== "object") return undefined;
  if ((result as Record<string, unknown>)["terminate"] !== true) return undefined;
  const callId = record["toolCallId"];
  return typeof callId === "string" && callId.length > 0 ? callId : undefined;
}
