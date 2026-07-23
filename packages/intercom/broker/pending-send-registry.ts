import { randomUUID } from "crypto";
import type { LogicalSendOptions } from "./send-signature.js";
export { buildSendSignature } from "./send-signature.js";

const DEFAULT_GENERATION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_GENERATIONS = 10_000;

export interface SendOptionsLike extends LogicalSendOptions {}

export interface SendResultLike {
  id: string;
  delivered: boolean;
  reason?: string;
}

export interface PendingSendAttempt {
  readonly messageId: string;
  readonly attemptId: string;
  readonly signature: string;
  readonly promise: Promise<SendResultLike>;
}

interface OwnedPendingSend extends PendingSendAttempt {
  legacyEligible: boolean;
  generation: number;
  resolve(result: SendResultLike): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface PendingSendAcquisition {
  attempt: PendingSendAttempt;
  owner: boolean;
}

interface SendGeneration {
  generation: number;
  touchedAt: number;
}


export class PendingSendRegistry {
  private readonly attempts = new Map<string, OwnedPendingSend>();
  private readonly generations = new Map<string, SendGeneration>();

  constructor(
    private readonly generationTtlMs = DEFAULT_GENERATION_TTL_MS,
    private readonly maxGenerations = DEFAULT_MAX_GENERATIONS,
    private readonly now: () => number = Date.now,
  ) {}

  private nextGeneration(messageId: string): number {
    const now = this.now();
    for (const [id, record] of this.generations) {
      if (now - record.touchedAt <= this.generationTtlMs) break;
      this.generations.delete(id);
    }
    const previous = this.generations.get(messageId);
    const generation = previous && now - previous.touchedAt <= this.generationTtlMs ? previous.generation + 1 : 1;
    this.generations.delete(messageId);
    this.generations.set(messageId, { generation, touchedAt: now });
    while (this.generations.size > Math.max(1, this.maxGenerations)) {
      const oldest = this.generations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.generations.delete(oldest);
    }
    return generation;
  }

  private touchGeneration(attempt: OwnedPendingSend): void {
    this.generations.delete(attempt.messageId);
    this.generations.set(attempt.messageId, { generation: attempt.generation, touchedAt: this.now() });
    while (this.generations.size > Math.max(1, this.maxGenerations)) {
      const oldest = this.generations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.generations.delete(oldest);
    }
  }
  acquire(messageId: string, signature: string, timeoutMs: number): PendingSendAcquisition {
    const existing = this.attempts.get(messageId);
    if (existing) {
      if (existing.signature !== signature) {
        throw new Error(`Intercom message ID '${messageId}' is already pending with a different target or payload`);
      }
      return { attempt: existing, owner: false };
    }

    let resolvePromise!: (result: SendResultLike) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<SendResultLike>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const generation = this.nextGeneration(messageId);
    const attempt: OwnedPendingSend = {
      messageId,
      attemptId: randomUUID(),
      signature,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      legacyEligible: generation === 1,
      generation,
    };
    attempt.timer = setTimeout(() => {
      this.reject(attempt, new Error("Send timeout"));
    }, timeoutMs);
    this.attempts.set(messageId, attempt);
    return { attempt, owner: true };
  }

  resolve(messageId: string, attemptId: string, result: SendResultLike): boolean {
    const attempt = this.attempts.get(messageId);
    if (!attempt || attempt.attemptId !== attemptId) return false;
    this.attempts.delete(messageId);
    if (attempt.timer) clearTimeout(attempt.timer);
    this.touchGeneration(attempt);
    attempt.resolve(result);
    return true;
  }

  /** Resolve a pre-attemptId response only for an ID's first active generation. */
  resolveLegacy(messageId: string, result: SendResultLike): boolean {
    const attempt = this.attempts.get(messageId);
    if (!attempt?.legacyEligible) return false;
    return this.resolve(messageId, attempt.attemptId, result);
  }

  reject(attempt: PendingSendAttempt, error: Error): boolean {
    const current = this.attempts.get(attempt.messageId);
    if (current !== attempt) return false;
    this.attempts.delete(attempt.messageId);
    if (current.timer) clearTimeout(current.timer);
    this.touchGeneration(current);
    current.reject(error);
    return true;
  }

  rejectAll(error: Error): void {
    for (const attempt of [...this.attempts.values()]) this.reject(attempt, error);
  }
}
