export interface PromptReservationEntry {
  readonly reservationId: string;
  readonly generation: number;
  readonly tokenId: string;
}

declare const promptReservationTokenBrand: unique symbol;

/** Opaque ownership proof returned by reserve and required by release. */
export interface PromptReservationToken extends PromptReservationEntry {
  readonly [promptReservationTokenBrand]: true;
}

export interface PromptReservationSnapshot {
  readonly active: readonly PromptReservationEntry[];
  readonly released: readonly Omit<PromptReservationEntry, "tokenId">[];
  readonly anonymousTokenIds: readonly string[];
  readonly consumedTokenIds: readonly string[];
}

export function promptReservationToken(entry: PromptReservationEntry): PromptReservationToken {
  return entry as PromptReservationToken;
}

export function inactivePromptReservationToken(reservationId: string): PromptReservationToken {
  return promptReservationToken({ reservationId, generation: 1, tokenId: `inactive:${crypto.randomUUID()}` });
}

function nextLegacyToken(existing: ReadonlySet<string>, index: number): string {
  let candidate = `legacy:${index}`;
  while (existing.has(candidate)) candidate = `legacy:${++index}`;
  return candidate;
}

/** Identity-owned prompt tokens with generation tombstones for memory/file stores. */
export class PromptReservationState {
  private readonly active = new Map<string, PromptReservationEntry>();
  private readonly released = new Map<string, number>();
  private readonly availableTokens = new Set<string>();
  private readonly anonymousTokens = new Set<string>();
  private readonly consumedTokens = new Set<string>();

  constructor(pendingPrompts: number, snapshot?: PromptReservationSnapshot) {
    for (const tokenId of snapshot?.consumedTokenIds ?? []) this.consumedTokens.add(tokenId);
    for (const entry of snapshot?.active ?? []) {
      if (this.consumedTokens.has(entry.tokenId)) continue;
      const current = this.active.get(entry.reservationId);
      if (current === undefined || entry.generation > current.generation) {
        this.active.set(entry.reservationId, entry);
      }
      this.availableTokens.add(entry.tokenId);
    }
    for (const entry of snapshot?.released ?? []) {
      const generation = Math.max(this.released.get(entry.reservationId) ?? 0, entry.generation);
      this.released.set(entry.reservationId, generation);
      const active = this.active.get(entry.reservationId);
      if (active !== undefined && active.generation <= generation) {
        this.active.delete(entry.reservationId);
        this.availableTokens.delete(active.tokenId);
        this.consumedTokens.add(active.tokenId);
      }
    }
    for (const tokenId of snapshot?.anonymousTokenIds ?? []) {
      if (this.consumedTokens.has(tokenId)) continue;
      this.anonymousTokens.add(tokenId);
      this.availableTokens.add(tokenId);
    }
    let index = 0;
    while (this.availableTokens.size < Math.max(0, Math.trunc(pendingPrompts))) {
      const tokenId = nextLegacyToken(this.availableTokens, index++);
      this.anonymousTokens.add(tokenId);
      this.availableTokens.add(tokenId);
    }
  }

  get pendingPrompts(): number {
    return this.availableTokens.size;
  }

  activeToken(reservationId: string): PromptReservationToken | undefined {
    const active = this.active.get(reservationId);
    return active === undefined ? undefined : promptReservationToken(active);
  }

  claim(reservationId: string): PromptReservationToken | undefined {
    return this.activeToken(reservationId)
      ?? (this.anonymousTokens.size > 0 ? this.reserve(reservationId) : undefined);
  }

  reserve(reservationId: string): PromptReservationToken {
    const current = this.active.get(reservationId);
    if (current !== undefined) return promptReservationToken(current);
    const generation = Math.max(this.released.get(reservationId) ?? 0, 0) + 1;
    const anonymous = this.released.has(reservationId)
      ? undefined
      : this.anonymousTokens.values().next().value as string | undefined;
    const tokenId = anonymous ?? `reservation:${encodeURIComponent(reservationId)}:${generation}`;
    if (anonymous !== undefined) this.anonymousTokens.delete(anonymous);
    const entry = { reservationId, generation, tokenId };
    this.active.set(reservationId, entry);
    this.availableTokens.add(tokenId);
    return promptReservationToken(entry);
  }

  release(reservationId: string, token: PromptReservationToken): void {
    const active = this.active.get(reservationId);
    if (active === undefined || token === undefined || token.reservationId !== reservationId
      || active.generation !== token.generation || active.tokenId !== token.tokenId) return;
    this.active.delete(reservationId);
    this.consume(active.tokenId);
    this.released.set(reservationId, active.generation);
  }

  adjust(delta: number): void {
    const count = Math.max(0, Math.trunc(Math.abs(delta)));
    for (let index = 0; index < count; index++) {
      if (delta > 0) {
        const tokenId = `scalar:${crypto.randomUUID()}`;
        this.anonymousTokens.add(tokenId);
        this.availableTokens.add(tokenId);
      } else if (delta < 0) {
        const anonymous = this.anonymousTokens.values().next().value as string | undefined;
        if (anonymous !== undefined) {
          this.consume(anonymous);
          continue;
        }
        const active = this.active.values().next().value as PromptReservationEntry | undefined;
        if (active === undefined) break;
        this.active.delete(active.reservationId);
        this.released.set(active.reservationId, active.generation);
        this.consume(active.tokenId);
      }
    }
  }

  snapshot(): PromptReservationSnapshot {
    return {
      active: [...this.active.values()],
      released: [...this.released].map(([reservationId, generation]) => ({ reservationId, generation })),
      anonymousTokenIds: [...this.anonymousTokens],
      consumedTokenIds: [...this.consumedTokens],
    };
  }

  private consume(tokenId: string): void {
    this.availableTokens.delete(tokenId);
    this.anonymousTokens.delete(tokenId);
    this.consumedTokens.add(tokenId);
  }
}

export function mergePromptReservationSnapshots(
  first: PromptReservationSnapshot | undefined,
  second: PromptReservationSnapshot | undefined,
  pendingPrompts: number,
): PromptReservationSnapshot | undefined {
  if (first === undefined && second === undefined) return undefined;
  const consumed = new Set([...(first?.consumedTokenIds ?? []), ...(second?.consumedTokenIds ?? [])]);
  const released = new Map<string, number>();
  for (const entry of [...(first?.released ?? []), ...(second?.released ?? [])]) {
    released.set(entry.reservationId, Math.max(released.get(entry.reservationId) ?? 0, entry.generation));
  }
  const active = new Map<string, PromptReservationEntry>();
  for (const entry of [...(first?.active ?? []), ...(second?.active ?? [])]) {
    if (consumed.has(entry.tokenId) || (released.get(entry.reservationId) ?? 0) >= entry.generation) continue;
    const current = active.get(entry.reservationId);
    if (current === undefined || entry.generation > current.generation) active.set(entry.reservationId, entry);
  }
  const anonymousTokenIds = new Set([...(first?.anonymousTokenIds ?? []), ...(second?.anonymousTokenIds ?? [])]);
  for (const tokenId of consumed) anonymousTokenIds.delete(tokenId);
  return new PromptReservationState(pendingPrompts, {
    active: [...active.values()],
    released: [...released].map(([reservationId, generation]) => ({ reservationId, generation })),
    anonymousTokenIds: [...anonymousTokenIds],
    consumedTokenIds: [...consumed],
  }).snapshot();
}
