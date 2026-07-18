import type { WorkflowSerializableValue } from "../shared/types.js";
import type { DbosStepRecord } from "./dbos-backend.js";
import { DURABLE_FORMAT_VERSION } from "./format-version.js";
import { promptReservationToken, type PromptReservationToken } from "./prompt-reservation-state.js";
import type { DurableWorkflowMetadata } from "./types.js";

const RESERVATION_PREFIX = "__atomic_prompt_reservation";

export interface DbosActivePromptReservation {
  readonly generation: number;
  readonly tokenId: string;
}

export interface DbosPromptReservationState {
  readonly active: Map<string, DbosActivePromptReservation>;
  readonly maxGeneration: Map<string, number>;
  readonly releasedGeneration: Map<string, number>;
  readonly availableTokens: Set<string>;
  readonly consumedTokens: Set<string>;
  readonly baseline: number;
  readonly epoch: string;
  hasEvents: boolean;
}

export function emptyDbosPromptReservationState(baseline = 0, epoch: string = crypto.randomUUID()): DbosPromptReservationState {
  const normalized = Math.max(0, Math.trunc(baseline));
  const availableTokens = new Set<string>();
  for (let index = 0; index < normalized; index++) availableTokens.add(`baseline:${epoch}:${index}`);
  return {
    active: new Map(),
    maxGeneration: new Map(),
    releasedGeneration: new Map(),
    availableTokens,
    consumedTokens: new Set(),
    baseline: normalized,
    epoch,
    hasEvents: false,
  };
}

export function promptReservationStepName(
  reservationId: string,
  generation: number,
  operation: "reserve" | "release",
  epoch: string,
): string {
  return `${RESERVATION_PREFIX}:${operation}:${reservationId}:${generation}:${epoch}`;
}

export function encodePromptReservationEvent(input: {
  readonly reservationId: string;
  readonly generation: number;
  readonly operation: "reserve" | "release";
  readonly tokenId: string;
  readonly epoch: string;
}): WorkflowSerializableValue {
  return {
    __atomicPromptReservation: true,
    version: DURABLE_FORMAT_VERSION,
    reservationId: input.reservationId,
    generation: input.generation,
    operation: input.operation,
    tokenId: input.tokenId,
    epoch: input.epoch,
  };
}

export function isDbosPromptStateStep(stepName: string): boolean {
  return stepName.startsWith(`${RESERVATION_PREFIX}:`);
}

interface ParsedReservation {
  readonly reservationId: string;
  readonly generation: number;
  readonly operation: "reserve" | "release";
  readonly tokenId: string;
  readonly epoch: string;
}

interface ReservationGeneration {
  tokenId: string;
  reserved: boolean;
  released: boolean;
}

export function classifyDbosPromptReservationState(
  records: readonly DbosStepRecord[],
  baseline = 0,
  epoch: string = crypto.randomUUID(),
): DbosPromptReservationState {
  const state = emptyDbosPromptReservationState(baseline, epoch);
  const generations = new Map<string, Map<number, ReservationGeneration>>();
  for (const record of records) {
    if (!isDbosPromptStateStep(record.stepName)) continue;
    const event = parseReservation(record.output);
    if (event === undefined || event.epoch !== epoch) continue;
    state.hasEvents = true;
    let byGeneration = generations.get(event.reservationId);
    if (byGeneration === undefined) {
      byGeneration = new Map();
      generations.set(event.reservationId, byGeneration);
    }
    const entry = byGeneration.get(event.generation) ?? {
      tokenId: event.tokenId,
      reserved: false,
      released: false,
    };
    if (entry.tokenId !== event.tokenId) continue;
    if (event.operation === "reserve") entry.reserved = true;
    else entry.released = true;
    byGeneration.set(event.generation, entry);
  }

  for (const [reservationId, byGeneration] of generations) {
    const maxGeneration = Math.max(...byGeneration.keys());
    state.maxGeneration.set(reservationId, maxGeneration);
    for (const [generation, entry] of [...byGeneration].sort(([a], [b]) => a - b)) {
      if (entry.released) {
        state.releasedGeneration.set(reservationId, Math.max(state.releasedGeneration.get(reservationId) ?? 0, generation));
        consumeToken(state, entry.tokenId);
      }
      if (generation === maxGeneration && entry.reserved && !entry.released
        && !state.consumedTokens.has(entry.tokenId)) {
        state.active.set(reservationId, { generation, tokenId: entry.tokenId });
        state.availableTokens.add(entry.tokenId);
      }
    }
  }
  return state;
}

export function promptReservationAdjustment(state: DbosPromptReservationState): number {
  return state.availableTokens.size - state.baseline;
}

function parseReservation(output: WorkflowSerializableValue): ParsedReservation | undefined {
  if (!isRecord(output) || output["__atomicPromptReservation"] !== true
    || output["version"] !== DURABLE_FORMAT_VERSION
    || typeof output["reservationId"] !== "string"
    || typeof output["generation"] !== "number"
    || !Number.isInteger(output["generation"]) || output["generation"] < 1
    || (output["operation"] !== "reserve" && output["operation"] !== "release")
    || typeof output["tokenId"] !== "string" || typeof output["epoch"] !== "string") return undefined;
  return {
    reservationId: output["reservationId"], generation: output["generation"],
    operation: output["operation"], tokenId: output["tokenId"], epoch: output["epoch"],
  };
}

function isRecord(value: WorkflowSerializableValue): value is Record<string, WorkflowSerializableValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface DbosPromptReservationHost {
  readonly pendingPrompts: (workflowId: string) => number;
  readonly adjustPendingPrompts: (workflowId: string, delta: number) => void;
  readonly persist: (workflowId: string, stepName: string, output: WorkflowSerializableValue) => void;
}

export class DbosPromptReservationTracker {
  private readonly baselines = new Map<string, number>();
  private readonly states = new Map<string, DbosPromptReservationState>();

  constructor(private readonly host: DbosPromptReservationHost) {}

  registerWorkflow(workflowId: string, pending: number | undefined, existingPending: number): number {
    if (pending === undefined) return this.register(workflowId, existingPending);
    return this.states.has(workflowId) ? this.setBaseline(workflowId, pending) : this.register(workflowId, pending);
  }

  register(workflowId: string, pending: number): number {
    const existing = this.states.get(workflowId);
    if (existing !== undefined) return pendingPrompts(existing);
    const normalized = Math.max(0, Math.trunc(pending));
    this.baselines.set(workflowId, normalized);
    this.states.set(workflowId, emptyDbosPromptReservationState(normalized));
    return normalized;
  }

  setBaseline(workflowId: string, pending: number): number {
    const normalized = Math.max(0, Math.trunc(pending));
    this.baselines.set(workflowId, normalized);
    this.states.set(workflowId, emptyDbosPromptReservationState(normalized));
    return normalized;
  }

  delete(workflowId: string): void { this.baselines.delete(workflowId); this.states.delete(workflowId); }
  clear(): void { this.baselines.clear(); this.states.clear(); }

  metadata(
    workflowId: string,
    value: Omit<DurableWorkflowMetadata, "promptReservationEpoch">,
  ): DurableWorkflowMetadata {
    const state = this.state(workflowId);
    return {
      ...value,
      pendingPrompts: this.baselines.get(workflowId) ?? value.pendingPrompts,
      promptReservationEpoch: state.epoch,
    };
  }

  hydrate(workflowId: string, baseline: number, records: readonly DbosStepRecord[], epoch?: string): number {
    if (epoch === undefined) return 0;
    const state = classifyDbosPromptReservationState(records, baseline, epoch);
    this.baselines.set(workflowId, baseline);
    this.states.set(workflowId, state);
    return pendingPrompts(state);
  }

  adjust(workflowId: string, delta: number): void {
    const state = this.state(workflowId);
    const count = Math.max(0, Math.trunc(Math.abs(delta)));
    for (let index = 0; index < count; index++) {
      if (delta > 0) this.reserveScalar(workflowId, state);
      else if (delta < 0) {
        const tokenId = state.availableTokens.values().next().value as string | undefined;
        if (tokenId === undefined) break;
        const owner = [...state.active].find(([, reservation]) => reservation.tokenId === tokenId);
        if (owner !== undefined) this.releaseGeneration(workflowId, state, owner[0], owner[1]);
        else this.releaseUnownedToken(workflowId, state, tokenId);
      }
    }
    this.syncPending(workflowId, state);
  }

  token(workflowId: string, reservationId: string): PromptReservationToken | undefined {
    const reservation = this.state(workflowId).active.get(reservationId);
    return reservation === undefined ? undefined : tokenFor(reservationId, reservation);
  }

  reserve(workflowId: string, reservationId: string): PromptReservationToken {
    const state = this.state(workflowId);
    const current = state.active.get(reservationId);
    if (current !== undefined) return tokenFor(reservationId, current);
    const generation = (state.maxGeneration.get(reservationId) ?? 0) + 1;
    const reservation = { generation, tokenId: `prompt:${state.epoch}:${encodeURIComponent(reservationId)}:${generation}` };
    applyReserve(state, reservationId, reservation);
    this.syncPending(workflowId, state);
    this.persistReservation(workflowId, state, reservationId, reservation, "reserve");
    return tokenFor(reservationId, reservation);
  }

  release(workflowId: string, reservationId: string, token: PromptReservationToken): void {
    const state = this.state(workflowId);
    const reservation = state.active.get(reservationId);
    if (reservation === undefined || token.reservationId !== reservationId
      || token.generation !== reservation.generation || token.tokenId !== reservation.tokenId) return;
    this.releaseGeneration(workflowId, state, reservationId, reservation);
    this.syncPending(workflowId, state);
  }

  private reserveScalar(workflowId: string, state: DbosPromptReservationState): void {
    const id = crypto.randomUUID();
    const reservation = { generation: 1, tokenId: `scalar:${state.epoch}:${id}` };
    applyReserve(state, `__scalar:${id}`, reservation);
    this.persistReservation(workflowId, state, `__scalar:${id}`, reservation, "reserve");
  }

  private releaseUnownedToken(workflowId: string, state: DbosPromptReservationState, tokenId: string): void {
    const reservationId = `__token_release:${crypto.randomUUID()}`;
    const reservation = { generation: 1, tokenId };
    state.maxGeneration.set(reservationId, 1);
    state.releasedGeneration.set(reservationId, 1);
    consumeToken(state, tokenId);
    state.hasEvents = true;
    this.persistReservation(workflowId, state, reservationId, reservation, "release");
  }

  private releaseGeneration(workflowId: string, state: DbosPromptReservationState, reservationId: string, reservation: DbosActivePromptReservation): void {
    applyRelease(state, reservationId, reservation);
    this.persistReservation(workflowId, state, reservationId, reservation, "release");
  }

  private state(workflowId: string): DbosPromptReservationState {
    let state = this.states.get(workflowId);
    if (state === undefined) {
      state = emptyDbosPromptReservationState(this.baselines.get(workflowId) ?? 0);
      this.states.set(workflowId, state);
    }
    return state;
  }

  private syncPending(workflowId: string, state: DbosPromptReservationState): void {
    const delta = pendingPrompts(state) - this.host.pendingPrompts(workflowId);
    if (delta !== 0) this.host.adjustPendingPrompts(workflowId, delta);
  }

  private persistReservation(workflowId: string, state: DbosPromptReservationState, reservationId: string, reservation: DbosActivePromptReservation, operation: "reserve" | "release"): void {
    this.host.persist(
      workflowId,
      promptReservationStepName(reservationId, reservation.generation, operation, state.epoch),
      encodePromptReservationEvent({ reservationId, operation, ...reservation, epoch: state.epoch }),
    );
  }
}

function tokenFor(reservationId: string, reservation: DbosActivePromptReservation): PromptReservationToken {
  return promptReservationToken({ reservationId, generation: reservation.generation, tokenId: reservation.tokenId });
}

function pendingPrompts(state: DbosPromptReservationState): number { return state.availableTokens.size; }

function applyReserve(state: DbosPromptReservationState, reservationId: string, reservation: DbosActivePromptReservation): void {
  state.maxGeneration.set(reservationId, reservation.generation);
  state.active.set(reservationId, reservation);
  if (!state.consumedTokens.has(reservation.tokenId)) state.availableTokens.add(reservation.tokenId);
  state.hasEvents = true;
}

function applyRelease(state: DbosPromptReservationState, reservationId: string, reservation: DbosActivePromptReservation): void {
  state.active.delete(reservationId);
  state.releasedGeneration.set(reservationId, Math.max(state.releasedGeneration.get(reservationId) ?? 0, reservation.generation));
  consumeToken(state, reservation.tokenId);
  state.hasEvents = true;
}

function consumeToken(state: DbosPromptReservationState, tokenId: string): void {
  state.availableTokens.delete(tokenId);
  state.consumedTokens.add(tokenId);
}
