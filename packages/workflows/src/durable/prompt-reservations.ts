import { adjustDurablePendingPrompts, type DurableWorkflowBackend } from "./backend.js";
import { promptReservationToken, type PromptReservationToken } from "./prompt-reservation-state.js";

/** Internal prompt-reservation seam; intentionally not part of the public backend contract. */
export interface DurablePromptReservationBackend {
  promptReservationScope(workflowId: string): {
    readonly rootWorkflowId: string;
    readonly scope: string;
  };
  pendingPromptToken(workflowId: string, reservationId: string): PromptReservationToken | undefined;
  reservePendingPrompt(workflowId: string, reservationId: string): PromptReservationToken;
  releasePendingPrompt(workflowId: string, reservationId: string, token: PromptReservationToken): void;
}

type ReservationCapableBackend = DurableWorkflowBackend & Partial<DurablePromptReservationBackend>;

interface FallbackReservationState {
  readonly active: Map<string, PromptReservationToken>;
  readonly generations: Map<string, number>;
}

const fallbackReservations = new WeakMap<DurableWorkflowBackend, Map<string, FallbackReservationState>>();

function capable(backend: DurableWorkflowBackend): ReservationCapableBackend {
  return backend as ReservationCapableBackend;
}

function fallbackState(backend: DurableWorkflowBackend, workflowId: string): FallbackReservationState {
  let workflows = fallbackReservations.get(backend);
  if (workflows === undefined) {
    workflows = new Map();
    fallbackReservations.set(backend, workflows);
  }
  let state = workflows.get(workflowId);
  if (state === undefined) {
    state = { active: new Map(), generations: new Map() };
    workflows.set(workflowId, state);
  }
  return state;
}

export function durablePromptScope(
  backend: DurableWorkflowBackend,
  workflowId: string,
): { readonly rootWorkflowId: string; readonly scope: string } {
  return capable(backend).promptReservationScope?.(workflowId) ?? {
    rootWorkflowId: workflowId,
    scope: "root",
  };
}

export function claimDurablePromptToken(
  backend: DurableWorkflowBackend,
  workflowId: string,
  reservationId: string,
): PromptReservationToken | undefined {
  return capable(backend).pendingPromptToken?.(workflowId, reservationId);
}

export function reserveDurablePrompt(
  backend: DurableWorkflowBackend,
  workflowId: string,
  reservationId: string,
): PromptReservationToken {
  const target = capable(backend);
  if (target.reservePendingPrompt !== undefined) {
    return target.reservePendingPrompt(workflowId, reservationId);
  }
  const state = fallbackState(backend, workflowId);
  const current = state.active.get(reservationId);
  if (current !== undefined) return current;
  const generation = (state.generations.get(reservationId) ?? 0) + 1;
  state.generations.set(reservationId, generation);
  const token = promptReservationToken({
    reservationId,
    generation,
    tokenId: `fallback:${crypto.randomUUID()}`,
  });
  state.active.set(reservationId, token);
  adjustDurablePendingPrompts(backend, workflowId, 1);
  return token;
}

export function releaseDurablePrompt(
  backend: DurableWorkflowBackend,
  workflowId: string,
  reservationId: string,
  token: PromptReservationToken,
): void {
  const target = capable(backend);
  if (target.releasePendingPrompt !== undefined) {
    target.releasePendingPrompt(workflowId, reservationId, token);
    return;
  }
  const state = fallbackState(backend, workflowId);
  if (state.active.get(reservationId)?.tokenId !== token.tokenId) return;
  state.active.delete(reservationId);
  adjustDurablePendingPrompts(backend, workflowId, -1);
}

export type { PromptReservationToken } from "./prompt-reservation-state.js";
