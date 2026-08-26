import type { Message } from "./types.js";

export interface ReplyWaiterRecord {
  from: string;
  replyTo: string;
  resolve(message: Message): void;
  reject(error: Error): void;
}

/** Handle owned by the tool call that won waiter admission. */
export interface ReplyWait {
  /**
   * Resolves with the correlated reply, or rejects on timeout, cancellation,
   * send failure, or disconnect. The rejection is pre-handled internally, so
   * the promise can safely sit unawaited between other awaits (for example
   * while the question is still being sent) without ever becoming an
   * unhandled rejection.
   */
  promise: Promise<Message>;
  /** Rejects only this waiter. No-op once it settled or was replaced. */
  cancel(error: Error): void;
}

export type ReplyWaitAdmission =
  | { ok: true; wait: ReplyWait }
  | { ok: false; reason: "busy"; limit: number }
  | { ok: false; reason: "cancelled" };

export const DEFAULT_REPLY_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_PENDING_REPLY_WAITS = 6;

/**
 * Correlation-keyed reply waiter registry with synchronous per-question
 * admission, a bounded capacity, scoped per-record cleanup, and reject-all
 * teardown. Each waiter retains its own timeout, abort signal, and cancellation.
 */
export class ReplyWaiterRegistry {
  private readonly waiters = new Map<string, ReplyWaiterRecord>();
  private readonly maxPending: number;

  constructor(
    private readonly timeoutMs: number = DEFAULT_REPLY_TIMEOUT_MS,
    maxPending: number = DEFAULT_MAX_PENDING_REPLY_WAITS,
  ) {
    this.maxPending = Math.max(1, maxPending);
  }

  pending(): ReplyWaiterRecord[] {
    return [...this.waiters.values()];
  }

  has(): boolean {
    return this.waiters.size > 0;
  }

  size(): number {
    return this.waiters.size;
  }

  get limit(): number {
    return this.maxPending;
  }

  rejectAll(error: Error): void {
    for (const waiter of this.pending()) waiter.reject(error);
  }

  begin(from: string, replyTo: string, signal?: AbortSignal): ReplyWaitAdmission {
    if (signal?.aborted) return { ok: false, reason: "cancelled" };
    if (this.waiters.size >= this.maxPending) {
      return { ok: false, reason: "busy", limit: this.maxPending };
    }
    let record!: ReplyWaiterRecord;
    const promise = new Promise<Message>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        record.reject(new Error(`No reply from "${from}" within ${Math.round(this.timeoutMs / 60_000)} minutes`));
      }, this.timeoutMs);
      const onAbort = () => record.reject(new Error("Cancelled"));
      const cleanup = () => {
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (this.waiters.get(replyTo) === record) this.waiters.delete(replyTo);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      record = {
        from,
        replyTo,
        resolve: (message) => {
          if (settled) return;
          cleanup();
          resolve(message);
        },
        reject: (error) => {
          if (settled) return;
          cleanup();
          reject(error);
        },
      };
      this.waiters.set(replyTo, record);
    });
    // Pre-attach a handler so a rejection that fires while the owner is
    // between awaits can never crash the process as an unhandled rejection.
    promise.catch(() => undefined);
    return {
      ok: true,
      wait: {
        promise,
        cancel: (error) => record.reject(error),
      },
    };
  }
}
