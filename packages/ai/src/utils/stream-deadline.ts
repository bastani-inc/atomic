/**
 * Idle deadline for provider response streams (#2553).
 *
 * The HTTP layer only bounds the request/response handshake and, for SDK clients,
 * the socket idle timeout its dispatcher enforces. A body that decodes into a
 * decompression failure can destroy the underlying stream without ever rejecting
 * the async iterator the adapter is awaiting, so `for await (...)` stays pending
 * forever, the adapter's promise never settles, and retry/model-fallback logic
 * never advances. GitHub Copilot with the default `transport: "auto"` reproduces
 * this as a repeated `Library error: zlib error: incorrect header check`.
 *
 * {@link withStreamDeadline} bounds the gap *between* stream events, below the
 * HTTP layer, so a stalled stream always settles as a transient transport error
 * that {@link isRetryableAssistantError} classifies as retryable.
 */

import { combineAbortSignals, type CombinedAbortSignal } from "./abort-signals.ts";

/**
 * Default idle gap allowed between two provider stream events, in milliseconds.
 *
 * Deliberately below the 600000 ms default HTTP idle timeout so a stalled stream
 * is cut by this deadline rather than waiting on the transport, while staying
 * generous enough for slow reasoning models that go quiet between events.
 */
export const DEFAULT_STREAM_DEADLINE_MS = 300_000;

/** The largest delay accepted by a platform timer without overflow. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Message text used when a stream exceeds its idle deadline. */
export function streamDeadlineErrorMessage(deadlineMs: number): string {
	return `Provider stream timed out after ${deadlineMs}ms without a new event (stream deadline exceeded)`;
}

/**
 * Raised when a provider stream produces no event within its idle deadline.
 *
 * The message intentionally carries transport-timeout wording so the shared
 * transient-error classifier treats it as a retryable transport failure.
 */
export class StreamDeadlineError extends Error {
	readonly deadlineMs: number;

	constructor(deadlineMs: number) {
		super(streamDeadlineErrorMessage(deadlineMs));
		this.name = "StreamDeadlineError";
		this.deadlineMs = deadlineMs;
	}
}

/**
 * Deadline-owned signal used to cancel the provider request when the stream
 * deadline fires. The caller signal remains separate, so an internal deadline
 * abort is reported as a retryable error rather than `stopReason: "aborted"`.
 */
export interface StreamDeadlineHandle {
	readonly deadlineMs: number | undefined;
	readonly signal: AbortSignal | undefined;
	readonly abortedByDeadline: boolean;
	abort(): void;
	cleanup(): void;
}

/**
 * Resolve the effective idle deadline for a stream.
 *
 * `undefined` selects {@link DEFAULT_STREAM_DEADLINE_MS}. A non-positive or
 * non-finite value disables the deadline and returns `undefined`, matching how
 * `httpIdleTimeoutMs` and `websocketConnectTimeoutMs` treat `0`/`"disabled"`.
 */
export function resolveStreamDeadlineMs(value: number | undefined): number | undefined {
	if (value === undefined) return DEFAULT_STREAM_DEADLINE_MS;
	if (!Number.isFinite(value) || value <= 0) return undefined;
	return Math.floor(value);
}

/**
 * Create a request signal that combines caller cancellation with a private
 * deadline controller. Calling {@link StreamDeadlineHandle.abort} aborts the
 * provider transport without marking the caller's signal as aborted.
 */
export function createStreamDeadline(value: number | undefined, callerSignal?: AbortSignal): StreamDeadlineHandle {
	const deadlineMs = resolveStreamDeadlineMs(value);
	if (deadlineMs === undefined) {
		return {
			deadlineMs,
			signal: callerSignal,
			abortedByDeadline: false,
			abort: () => {},
			cleanup: () => {},
		};
	}

	const controller = new AbortController();
	const combined: CombinedAbortSignal = combineAbortSignals([callerSignal, controller.signal]);
	let abortedByDeadline = false;
	return {
		deadlineMs,
		signal: combined.signal,
		get abortedByDeadline() {
			return abortedByDeadline;
		},
		abort: () => {
			if (!controller.signal.aborted) {
				abortedByDeadline = true;
				controller.abort(new StreamDeadlineError(deadlineMs));
			}
		},
		cleanup: combined.cleanup,
	};
}

/**
 * Schedule a timer without allowing the platform's 32-bit delay clamp to turn
 * a valid long deadline into a one-millisecond timeout.
 */
function scheduleDeadline(callback: () => void, delayMs: number): () => void {
	let remaining = delayMs;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cancelled = false;

	const arm = () => {
		if (cancelled) return;
		const delay = Math.min(remaining, MAX_TIMER_DELAY_MS);
		timer = setTimeout(() => {
			if (cancelled) return;
			remaining -= delay;
			if (remaining <= 0) {
				callback();
				return;
			}
			arm();
		}, delay);
	};

	arm();
	return () => {
		cancelled = true;
		if (timer !== undefined) clearTimeout(timer);
	};
}

/**
 * Wrap an async iterable so each pending `next()` is bounded by an idle deadline.
 *
 * The timer is restarted per event, so it caps the gap between events rather than
 * total stream duration: a long but progressing stream is never cut. When the
 * deadline expires, `onDeadline` is invoked before the wrapper rejects. Adapters
 * use that callback to abort the request signal, which interrupts the pending
 * provider read and runs the source's cleanup before fallback starts.
 *
 * A deadline of `undefined` delegates straight to the source and adds no timer.
 */
export async function* withStreamDeadline<T>(
	source: AsyncIterable<T>,
	deadlineMs: number | undefined,
	onDeadline?: () => void,
): AsyncGenerator<T, void, undefined> {
	if (deadlineMs === undefined) {
		yield* source;
		return;
	}

	const iterator = source[Symbol.asyncIterator]();
	let closed = false;
	const closeSource = (): void => {
		if (closed) return;
		closed = true;
		try {
			void Promise.resolve(iterator.return?.()).catch(() => {});
		} catch {
			// A source iterator without a usable `return` needs no cleanup.
		}
	};

	try {
		for (;;) {
			let cancelTimer: (() => void) | undefined;
			let deadlineFired = false;
			const pending = Promise.resolve(iterator.next());
			const deadline = new Promise<never>((_resolve, reject) => {
				cancelTimer = scheduleDeadline(() => {
					deadlineFired = true;
					try {
						onDeadline?.();
					} finally {
						reject(new StreamDeadlineError(deadlineMs));
					}
				}, deadlineMs);
			});

			let result: IteratorResult<T>;
			try {
				result = await Promise.race([pending, deadline]);
			} catch (error) {
				// The transport abort normally rejects the losing read. Swallow its
				// eventual rejection, but preserve the deadline error as the public
				// failure even if abort delivery wins the race by a microtask.
				void pending.catch(() => {});
				closeSource();
				if (deadlineFired) throw new StreamDeadlineError(deadlineMs);
				throw error;
			} finally {
				cancelTimer?.();
			}

			if (result.done) {
				closed = true;
				return;
			}
			yield result.value;
		}
	} finally {
		closeSource();
	}
}
