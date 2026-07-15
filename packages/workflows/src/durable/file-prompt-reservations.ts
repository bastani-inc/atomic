import { InMemoryDurableBackend } from "./backend.js";
import { inactivePromptReservationToken, PromptReservationState, type PromptReservationSnapshot, type PromptReservationToken } from "./prompt-reservation-state.js";
import type { FileDurableRecord } from "./file-state.js";

export type FilePromptReservations = Map<string, PromptReservationState>;

export function promptReservationsFrom(records: readonly FileDurableRecord[]): FilePromptReservations {
  return new Map(records.map((record) => [
    record.handle.workflowId,
    new PromptReservationState(record.handle.pendingPrompts, snapshotFromRecord(record)),
  ]));
}

export function withPromptReservations(
  records: readonly FileDurableRecord[],
  reservations: ReadonlyMap<string, PromptReservationState>,
): readonly FileDurableRecord[] {
  return records.map((record) => {
    const { promptReservations: _legacy, ...current } = record;
    const state = reservations.get(record.handle.workflowId);
    return state === undefined ? current : { ...current, promptReservationState: state.snapshot() };
  });
}

export function resetFilePrompts(
  reservations: FilePromptReservations,
  workflowId: string,
  pendingPrompts: number,
): void {
  reservations.set(workflowId, new PromptReservationState(pendingPrompts));
}

export function adjustFilePrompts(
  latest: InMemoryDurableBackend,
  reservations: FilePromptReservations,
  workflowId: string,
  delta: number,
): void {
  const state = stateFor(latest, reservations, workflowId);
  if (state === undefined) return;
  state.adjust(delta);
  updateLatestPromptCount(latest, workflowId, state.pendingPrompts);
}

export function claimFilePrompt(
  latest: InMemoryDurableBackend, reservations: FilePromptReservations, workflowId: string, reservationId: string,
): PromptReservationToken | undefined {
  const state = stateFor(latest, reservations, workflowId);
  const token = state?.claim(reservationId);
  if (state !== undefined && token !== undefined) updateLatestPromptCount(latest, workflowId, state.pendingPrompts);
  return token;
}

export function reserveFilePrompt(
  latest: InMemoryDurableBackend,
  reservations: FilePromptReservations,
  workflowId: string,
  reservationId: string,
): PromptReservationToken {
  const state = stateFor(latest, reservations, workflowId);
  if (state === undefined) return inactivePromptReservationToken(reservationId);
  const token = state.reserve(reservationId);
  updateLatestPromptCount(latest, workflowId, state.pendingPrompts);
  return token;
}

export function releaseFilePrompt(
  latest: InMemoryDurableBackend,
  reservations: FilePromptReservations,
  workflowId: string,
  reservationId: string,
  token: PromptReservationToken,
): void {
  const state = stateFor(latest, reservations, workflowId);
  if (state === undefined) return;
  state.release(reservationId, token);
  updateLatestPromptCount(latest, workflowId, state.pendingPrompts);
}

function stateFor(
  latest: InMemoryDurableBackend,
  reservations: FilePromptReservations,
  workflowId: string,
): PromptReservationState | undefined {
  const handle = latest.getWorkflow(workflowId);
  if (handle === undefined) return undefined;
  let state = reservations.get(workflowId);
  if (state === undefined) {
    state = new PromptReservationState(handle.pendingPrompts);
    reservations.set(workflowId, state);
  }
  return state;
}

function updateLatestPromptCount(
  latest: InMemoryDurableBackend,
  workflowId: string,
  pendingPrompts: number,
): void {
  const handle = latest.getWorkflow(workflowId);
  if (handle !== undefined) {
    latest.setWorkflowStatus(workflowId, handle.status, pendingPrompts, handle.resumable);
  }
}

function snapshotFromRecord(record: FileDurableRecord): PromptReservationSnapshot | undefined {
  if (record.promptReservationState !== undefined) return record.promptReservationState;
  if (record.promptReservations === undefined) return undefined;
  return {
    active: record.promptReservations.map((reservationId) => ({
      reservationId, generation: 1, tokenId: `reservation:${encodeURIComponent(reservationId)}:1`,
    })),
    released: [],
    anonymousTokenIds: [],
    consumedTokenIds: [],
  };
}
