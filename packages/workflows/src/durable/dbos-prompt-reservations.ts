import type { WorkflowSerializableValue } from "../shared/types.js";
import type { DbosStepRecord } from "./dbos-backend.js";
import type { DurableCheckpointEntry } from "./types.js";
import { promptReservationToken, type PromptReservationToken } from "./prompt-reservation-state.js";

const RESERVATION_PREFIX = "__atomic_prompt_reservation";
const DELTA_PREFIX = "__atomic_prompt_delta";

export interface DbosActivePromptReservation {
  readonly generation: number;
  readonly tokenId: string;
  readonly claimedLegacy: boolean;
}

export interface DbosPromptReservationState {
  readonly active: Map<string, DbosActivePromptReservation>;
  readonly maxGeneration: Map<string, number>;
  readonly releasedGeneration: Map<string, number>;
  /** Unique identity/scalar tokens only; anonymous legacy balance is separate. */
  readonly availableTokens: Set<string>;
  readonly consumedTokens: Set<string>;
  anonymousLegacyBalance: number;
  readonly baseline: number;
  readonly epoch?: string;
  hasEvents: boolean;
}

export function emptyDbosPromptReservationState(baseline = 0, epoch?: string): DbosPromptReservationState {
  const normalized = Math.max(0, Math.trunc(baseline));
  return {
    active: new Map(),
    maxGeneration: new Map(),
    releasedGeneration: new Map(),
    availableTokens: new Set(),
    consumedTokens: new Set(),
    anonymousLegacyBalance: normalized,
    baseline: normalized,
    ...(epoch !== undefined ? { epoch } : {}),
    hasEvents: false,
  };
}

export function promptReservationStepName(
  reservationId: string,
  generation: number,
  operation: "reserve" | "release",
  epoch?: string,
): string {
  const legacyName = `${RESERVATION_PREFIX}:${operation}:${reservationId}:${generation}`;
  return epoch === undefined ? legacyName : `${legacyName}:${epoch}`;
}

export function promptDeltaStepName(): string {
  return `${DELTA_PREFIX}:${crypto.randomUUID()}`;
}

export function encodePromptReservationEvent(input: {
  readonly reservationId: string;
  readonly generation: number;
  readonly operation: "reserve" | "release";
  readonly tokenId: string;
  readonly claimedLegacy: boolean;
  readonly epoch?: string;
}): WorkflowSerializableValue {
  return {
    __atomicPromptReservation: true,
    version: input.epoch === undefined ? 3 : 4,
    reservationId: input.reservationId,
    generation: input.generation,
    operation: input.operation,
    tokenId: input.tokenId,
    claimedLegacy: input.claimedLegacy,
    ...(input.epoch !== undefined ? { epoch: input.epoch } : {}),
  };
}

/** Legacy encoder retained so existing v1 event stores remain readable. */
export function encodePromptDelta(delta: number): WorkflowSerializableValue {
  return { __atomicPromptDelta: true, version: 1, delta };
}

export function isDbosPromptStateStep(stepName: string): boolean {
  return stepName.startsWith(`${RESERVATION_PREFIX}:`) || stepName.startsWith(`${DELTA_PREFIX}:`);
}

interface ParsedReservation {
  readonly reservationId: string;
  readonly generation: number;
  readonly operation: "reserve" | "release";
  readonly tokenId?: string;
  readonly claimedLegacy: boolean;
  readonly version: 1 | 2 | 3 | 4;
  readonly epoch?: string;
}

interface ReservationGeneration {
  tokenId?: string;
  claimedLegacy: boolean;
  reserved: boolean;
  released: boolean;
  version: 1 | 2 | 3 | 4;
}

export function classifyDbosPromptReservationState(
  records: readonly DbosStepRecord[],
  baseline = 0,
  epoch?: string,
): DbosPromptReservationState {
  const state = emptyDbosPromptReservationState(baseline, epoch);
  const generations = new Map<string, Map<number, ReservationGeneration>>();
  const deltas: number[] = [];
  for (const record of records) {
    if (record.stepName.startsWith(`${DELTA_PREFIX}:`)) {
      if (epoch !== undefined) continue;
      const delta = parseDelta(record.output);
      if (delta !== undefined) {
        deltas.push(delta);
        state.hasEvents = true;
      }
      continue;
    }
    if (!record.stepName.startsWith(`${RESERVATION_PREFIX}:`)) continue;
    const event = parseReservation(record.output);
    if (event === undefined || event.epoch !== epoch) continue;
    state.hasEvents = true;
    let byGeneration = generations.get(event.reservationId);
    if (byGeneration === undefined) {
      byGeneration = new Map();
      generations.set(event.reservationId, byGeneration);
    }
    const entry = byGeneration.get(event.generation) ?? {
      claimedLegacy: false,
      reserved: false,
      released: false,
      version: event.version,
    };
    entry.claimedLegacy ||= event.claimedLegacy;
    entry.tokenId ??= event.tokenId;
    entry.version = Math.max(entry.version, event.version) as 1 | 2 | 3 | 4;
    if (event.operation === "reserve") entry.reserved = true;
    else entry.released = true;
    byGeneration.set(event.generation, entry);
  }

  for (const [reservationId, byGeneration] of generations) {
    const maxGeneration = Math.max(...byGeneration.keys());
    state.maxGeneration.set(reservationId, maxGeneration);
    for (const [generation, entry] of [...byGeneration].sort(([a], [b]) => a - b)) {
      const claimedLegacy = entry.claimedLegacy || (entry.version === 2 && entry.tokenId?.startsWith("legacy:") === true);
      const tokenId = migratedUniqueToken(reservationId, generation, entry, claimedLegacy);
      if (claimedLegacy && state.anonymousLegacyBalance > 0) state.anonymousLegacyBalance -= 1;
      if (entry.released) {
        state.releasedGeneration.set(
          reservationId,
          Math.max(state.releasedGeneration.get(reservationId) ?? 0, generation),
        );
        consumeToken(state, tokenId);
      }
      if (generation === maxGeneration && entry.reserved && !entry.released
        && !state.consumedTokens.has(tokenId)) {
        state.active.set(reservationId, { generation, tokenId, claimedLegacy });
        state.availableTokens.add(tokenId);
      }
    }
  }

  let scalarIndex = 0;
  for (const delta of deltas) {
    const count = Math.max(0, Math.trunc(Math.abs(delta)));
    for (let index = 0; index < count; index++) {
      if (delta > 0) {
        const tokenId = `v1-scalar:${scalarIndex++}`;
        if (!state.consumedTokens.has(tokenId)) state.availableTokens.add(tokenId);
      }
      else if (delta < 0 && state.anonymousLegacyBalance > 0) state.anonymousLegacyBalance -= 1;
      else if (delta < 0) {
        const tokenId = state.availableTokens.values().next().value as string | undefined;
        if (tokenId !== undefined) consumeToken(state, tokenId);
      }
    }
  }
  for (const [reservationId, reservation] of state.active) {
    if (state.consumedTokens.has(reservation.tokenId)) state.active.delete(reservationId);
  }
  return state;
}

export function promptReservationAdjustment(state: DbosPromptReservationState): number {
  return pendingPrompts(state) - state.baseline;
}

function migratedUniqueToken(
  reservationId: string,
  generation: number,
  entry: ReservationGeneration,
  claimedLegacy: boolean,
): string {
  if (entry.tokenId !== undefined && !claimedLegacy) return entry.tokenId;
  const version = entry.version === 1 ? "v1" : "legacy-claim";
  return `${version}:${encodeURIComponent(reservationId)}:${generation}`;
}

function parseReservation(output: WorkflowSerializableValue): ParsedReservation | undefined {
  if (!isRecord(output) || output["__atomicPromptReservation"] !== true
    || typeof output["reservationId"] !== "string" || typeof output["generation"] !== "number"
    || !Number.isInteger(output["generation"]) || output["generation"] < 1
    || (output["operation"] !== "reserve" && output["operation"] !== "release")) return undefined;
  if (output["version"] === 4 && typeof output["tokenId"] === "string"
    && typeof output["claimedLegacy"] === "boolean" && typeof output["epoch"] === "string") {
    return {
      reservationId: output["reservationId"], generation: output["generation"], operation: output["operation"],
      tokenId: output["tokenId"], claimedLegacy: output["claimedLegacy"], version: 4, epoch: output["epoch"],
    };
  }
  if (output["version"] === 3 && typeof output["tokenId"] === "string"
    && typeof output["claimedLegacy"] === "boolean") {
    return {
      reservationId: output["reservationId"], generation: output["generation"], operation: output["operation"],
      tokenId: output["tokenId"], claimedLegacy: output["claimedLegacy"], version: 3,
    };
  }
  if (output["version"] === 2 && (typeof output["tokenId"] === "string" || output["tokenId"] === null)) {
    const tokenId = typeof output["tokenId"] === "string" ? output["tokenId"] : undefined;
    return {
      reservationId: output["reservationId"], generation: output["generation"], operation: output["operation"],
      ...(tokenId !== undefined ? { tokenId } : {}), claimedLegacy: tokenId?.startsWith("legacy:") ?? false, version: 2,
    };
  }
  if (output["version"] === 1 && typeof output["claimedLegacy"] === "boolean") {
    return {
      reservationId: output["reservationId"], generation: output["generation"], operation: output["operation"],
      claimedLegacy: output["claimedLegacy"], version: 1,
    };
  }
  return undefined;
}

function parseDelta(output: WorkflowSerializableValue): number | undefined {
  if (!isRecord(output) || output["__atomicPromptDelta"] !== true || output["version"] !== 1
    || typeof output["delta"] !== "number" || !Number.isFinite(output["delta"])) return undefined;
  return output["delta"];
}

function isRecord(value: WorkflowSerializableValue): value is Record<string, WorkflowSerializableValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface DbosPromptReservationHost {
  readonly pendingPrompts: (workflowId: string) => number;
  readonly adjustPendingPrompts: (workflowId: string, delta: number) => void;
  readonly persist: (workflowId: string, stepName: string, output: WorkflowSerializableValue) => void;
}

/** Instance-local projection over immutable, identity-owned DBOS prompt-token events. */
export class DbosPromptReservationTracker {
  private readonly baselines = new Map<string, number>();
  private readonly states = new Map<string, DbosPromptReservationState>();

  constructor(private readonly host: DbosPromptReservationHost) {}

  registerWorkflow(workflowId: string, pending: number | undefined, existingPending: number): number {
    if (pending === undefined) return this.register(workflowId, existingPending);
    return this.states.has(workflowId)
      ? this.setBaseline(workflowId, pending)
      : this.register(workflowId, pending);
  }

  register(workflowId: string, pending: number): number {
    const existing = this.states.get(workflowId);
    if (existing !== undefined) return pendingPrompts(existing);
    this.baselines.set(workflowId, pending);
    this.states.set(workflowId, emptyDbosPromptReservationState(pending));
    return Math.max(0, Math.trunc(pending));
  }

  setBaseline(workflowId: string, pending: number): number {
    const normalized = Math.max(0, Math.trunc(pending));
    this.baselines.set(workflowId, normalized);
    this.states.set(workflowId, emptyDbosPromptReservationState(normalized, crypto.randomUUID()));
    return normalized;
  }
  delete(workflowId: string): void { this.baselines.delete(workflowId); this.states.delete(workflowId); }
  clear(): void { this.baselines.clear(); this.states.clear(); }
  metadataEntry(workflowId: string, entry: DurableCheckpointEntry): DurableCheckpointEntry {
    const epoch = this.states.get(workflowId)?.epoch;
    return {
      ...entry,
      pendingPrompts: this.baselines.get(workflowId) ?? entry.pendingPrompts,
      ...(epoch !== undefined ? { promptReservationEpoch: epoch } : {}),
    };
  }

  hydrate(workflowId: string, baseline: number, records: readonly DbosStepRecord[], epoch?: string): number {
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
      else if (delta < 0 && state.anonymousLegacyBalance > 0) this.releaseAnonymous(workflowId, state);
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
    const state = this.state(workflowId);
    const reservation = state.active.get(reservationId);
    if (reservation !== undefined) return tokenFor(reservationId, reservation);
    return state.anonymousLegacyBalance > 0 ? this.reserve(workflowId, reservationId) : undefined;
  }

  reserve(workflowId: string, reservationId: string): PromptReservationToken {
    const state = this.state(workflowId);
    const current = state.active.get(reservationId);
    if (current !== undefined) return tokenFor(reservationId, current);
    const generation = (state.maxGeneration.get(reservationId) ?? 0) + 1;
    const claimedLegacy = !state.releasedGeneration.has(reservationId) && state.anonymousLegacyBalance > 0;
    const epochPrefix = state.epoch === undefined ? "" : `${state.epoch}:`;
    const tokenId = `prompt:${epochPrefix}${encodeURIComponent(reservationId)}:${generation}`;
    const reservation = { generation, tokenId, claimedLegacy };
    applyReserve(state, reservationId, reservation);
    this.syncPending(workflowId, state);
    this.persistReservation(workflowId, state, reservationId, reservation, "reserve");
    return tokenFor(reservationId, reservation);
  }

  release(workflowId: string, reservationId: string, token: PromptReservationToken): void {
    const state = this.state(workflowId);
    const reservation = state.active.get(reservationId);
    if (reservation === undefined || token === undefined || token.reservationId !== reservationId
      || token.generation !== reservation.generation || token.tokenId !== reservation.tokenId) return;
    this.releaseGeneration(workflowId, state, reservationId, reservation);
    this.syncPending(workflowId, state);
  }

  private reserveScalar(workflowId: string, state: DbosPromptReservationState): void {
    const id = crypto.randomUUID();
    const reservationId = `__scalar:${id}`;
    const reservation = { generation: 1, tokenId: `scalar:${id}`, claimedLegacy: false };
    applyReserve(state, reservationId, reservation);
    this.persistReservation(workflowId, state, reservationId, reservation, "reserve");
  }

  private releaseUnownedToken(workflowId: string, state: DbosPromptReservationState, tokenId: string): void {
    const reservationId = `__token_release:${crypto.randomUUID()}`;
    const reservation = { generation: 1, tokenId, claimedLegacy: false };
    state.maxGeneration.set(reservationId, 1);
    state.releasedGeneration.set(reservationId, 1);
    consumeToken(state, tokenId);
    state.hasEvents = true;
    this.persistReservation(workflowId, state, reservationId, reservation, "release");
  }

  private releaseAnonymous(workflowId: string, state: DbosPromptReservationState): void {
    const reservationId = `__legacy_release:${crypto.randomUUID()}`;
    const reservation = { generation: 1, tokenId: `legacy-release:${crypto.randomUUID()}`, claimedLegacy: true };
    state.maxGeneration.set(reservationId, 1);
    state.releasedGeneration.set(reservationId, 1);
    state.anonymousLegacyBalance = Math.max(0, state.anonymousLegacyBalance - 1);
    state.consumedTokens.add(reservation.tokenId);
    state.hasEvents = true;
    this.persistReservation(workflowId, state, reservationId, reservation, "release");
  }

  private releaseGeneration(
    workflowId: string,
    state: DbosPromptReservationState,
    reservationId: string,
    reservation: DbosActivePromptReservation,
  ): void {
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

  private persistReservation(
    workflowId: string,
    state: DbosPromptReservationState,
    reservationId: string,
    reservation: DbosActivePromptReservation,
    operation: "reserve" | "release",
  ): void {
    this.host.persist(
      workflowId,
      promptReservationStepName(reservationId, reservation.generation, operation, state.epoch),
      encodePromptReservationEvent({ reservationId, operation, ...reservation, ...(state.epoch !== undefined ? { epoch: state.epoch } : {}) }),
    );
  }
}

function tokenFor(reservationId: string, reservation: DbosActivePromptReservation): PromptReservationToken {
  return promptReservationToken({ reservationId, generation: reservation.generation, tokenId: reservation.tokenId });
}

function pendingPrompts(state: DbosPromptReservationState): number {
  return state.anonymousLegacyBalance + state.availableTokens.size;
}

function applyReserve(
  state: DbosPromptReservationState,
  reservationId: string,
  reservation: DbosActivePromptReservation,
): void {
  state.maxGeneration.set(reservationId, reservation.generation);
  state.active.set(reservationId, reservation);
  if (reservation.claimedLegacy && state.anonymousLegacyBalance > 0) state.anonymousLegacyBalance -= 1;
  if (!state.consumedTokens.has(reservation.tokenId)) state.availableTokens.add(reservation.tokenId);
  state.hasEvents = true;
}

function applyRelease(
  state: DbosPromptReservationState,
  reservationId: string,
  reservation: DbosActivePromptReservation,
): void {
  state.active.delete(reservationId);
  state.releasedGeneration.set(
    reservationId,
    Math.max(state.releasedGeneration.get(reservationId) ?? 0, reservation.generation),
  );
  consumeToken(state, reservation.tokenId);
  state.hasEvents = true;
}

function consumeToken(state: DbosPromptReservationState, tokenId: string): void {
  state.availableTokens.delete(tokenId);
  state.consumedTokens.add(tokenId);
}
