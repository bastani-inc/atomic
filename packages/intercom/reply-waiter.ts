import { ASK_REPLY_TIMEOUT_MS } from "./retry-policy.js";
import type { Message } from "./types.js";

export interface ReplyWaiterRecord {
  from: string;
  replyTo: string;
  readonly signal?: AbortSignal;
  handoffReady?: true;
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
  /** Absolute deadline of this question, persisted when the waiting session is released. */
  readonly deadline: number;
  /** Whether the question is still awaiting a reply. */
  isPending(): boolean;
  /** Its question and deadline have been recorded for release. */
  readyForHandoff(): void;
  /** Bind only this question to the broker-authorized recipient before dispatch. */
  bindSender(from: string): void;
  /** Rejects only this waiter. No-op once it settled or was replaced. */
  cancel(error: Error): void;
}

export type ReplyWaitAdmission =
  | { ok: true; wait: ReplyWait }
  | { ok: false; reason: "busy"; limit: number }
  | { ok: false; reason: "cancelled" };

export const DEFAULT_REPLY_TIMEOUT_MS = ASK_REPLY_TIMEOUT_MS;
export const DEFAULT_MAX_PENDING_REPLY_WAITS = 6;

/** Internal control signal: the waiting call is handed to the released child's owner, not failed. */
export class ReleasedReplyHandoff extends Error {
  override readonly name = "ReleasedReplyHandoff";
  constructor() { super("Reply wait handed to the released child owner"); }
}

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

  /** A broker-authorized restored peer replaces the target of exactly this question. */
  rebind(replyTo: string, previousSessionId: string, sessionId: string): void {
    const waiter = this.waiters.get(replyTo);
    if (waiter?.from === previousSessionId) waiter.from = sessionId;
  }

  /** Reject the waiter of exactly this question, if one is waiting. */
  cancel(replyTo: string, error: Error): void {
    this.waiters.get(replyTo)?.reject(error);
  }

  get limit(): number {
    return this.maxPending;
  }

  rejectAll(error: Error): void {
    for (const waiter of this.pending()) waiter.reject(error);
  }

  releaseRunningWaits(error: Error): number {
    let released = 0;
    for (const waiter of this.pending()) {
      if (waiter.handoffReady && waiter.signal?.aborted === false) {
        waiter.reject(new ReleasedReplyHandoff());
        released += 1;
      } else waiter.reject(error);
    }
    return released;
  }

  /** `timeoutMs: null` waits without a deadline: an `ask`'s own wait budget ends it instead (#4751). */
  begin(from: string, replyTo: string, signal?: AbortSignal, timeoutMs: number | null = this.timeoutMs): ReplyWaitAdmission {
    if (signal?.aborted) return { ok: false, reason: "cancelled" };
    if (this.waiters.size >= this.maxPending) {
      return { ok: false, reason: "busy", limit: this.maxPending };
    }
    const deadline = timeoutMs === null ? Number.MAX_SAFE_INTEGER : Date.now() + timeoutMs;
    let record!: ReplyWaiterRecord;
    const promise = new Promise<Message>((resolve, reject) => {
      let settled = false;
      const timeout = timeoutMs === null ? undefined : setTimeout(() => {
        record.reject(new Error(`No reply from "${from}" within ${Math.round(timeoutMs / 60_000)} minutes`));
      }, timeoutMs);
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
        ...(signal === undefined ? {} : { signal }),
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
        deadline,
        isPending: () => this.waiters.get(replyTo) === record,
        readyForHandoff: () => { if (this.waiters.get(replyTo) === record) record.handoffReady = true; },
        bindSender: (sender) => { if (this.waiters.get(replyTo) === record) record.from = sender; },
        cancel: (error) => record.reject(error),
      },
    };
  }
}
