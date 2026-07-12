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
  | { ok: false; reason: "busy" | "cancelled" };

export const DEFAULT_REPLY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Single-slot reply waiter with atomic admission.
 *
 * Admission is a synchronous check-and-reserve: when two blocking asks race
 * (parallel tool calls, cross-tool intercom/contact_supervisor concurrency),
 * the first reservation wins and every concurrent loser receives a structured
 * `{ ok: false, reason: "busy" }` refusal instead of a rejected promise.
 * Cancellation and failure paths settle only their own waiter, so a losing or
 * failing call can never tear down a reservation owned by another call.
 */
export class ReplyWaiterSlot {
  private waiter: ReplyWaiterRecord | null = null;

  constructor(private readonly timeoutMs: number = DEFAULT_REPLY_TIMEOUT_MS) {}

  /** The currently pending waiter, used for inbound reply correlation. */
  current(): ReplyWaiterRecord | null {
    return this.waiter;
  }

  has(): boolean {
    return this.waiter !== null;
  }

  /**
   * Rejects whichever waiter is currently pending. Reserved for slot-wide
   * teardown (session shutdown/replacement, broker disconnect); individual
   * tool calls must use their own `ReplyWait.cancel` instead.
   */
  rejectCurrent(error: Error): void {
    this.waiter?.reject(error);
  }

  begin(from: string, replyTo: string, signal?: AbortSignal): ReplyWaitAdmission {
    if (this.waiter) {
      return { ok: false, reason: "busy" };
    }
    if (signal?.aborted) {
      return { ok: false, reason: "cancelled" };
    }
    let record!: ReplyWaiterRecord;
    const promise = new Promise<Message>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        record.reject(new Error(`No reply from "${from}" within ${Math.round(this.timeoutMs / 60_000)} minutes`));
      }, this.timeoutMs);
      const onAbort = () => {
        record.reject(new Error("Cancelled"));
      };
      const cleanup = () => {
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (this.waiter === record) {
          this.waiter = null;
        }
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
      this.waiter = record;
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
