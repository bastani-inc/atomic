import type { DurableWorkflowBackend } from "./backend.js";
import type { PromptReservationToken } from "./prompt-reservation-state.js";

export function durablePromptScope(
  backend: DurableWorkflowBackend,
  workflowId: string,
): { readonly rootWorkflowId: string; readonly scope: string } {
  return backend.promptReservationScope(workflowId);
}

export function claimDurablePromptToken(
  backend: DurableWorkflowBackend,
  workflowId: string,
  reservationId: string,
): PromptReservationToken | undefined {
  return backend.pendingPromptToken(workflowId, reservationId);
}

export function reserveDurablePrompt(
  backend: DurableWorkflowBackend,
  workflowId: string,
  reservationId: string,
): PromptReservationToken {
  return backend.reservePendingPrompt(workflowId, reservationId);
}

export function releaseDurablePrompt(
  backend: DurableWorkflowBackend,
  workflowId: string,
  reservationId: string,
  token: PromptReservationToken,
): void {
  backend.releasePendingPrompt(workflowId, reservationId, token);
}

export type { PromptReservationToken } from "./prompt-reservation-state.js";
