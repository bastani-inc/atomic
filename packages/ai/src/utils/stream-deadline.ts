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

import { raceWithAbortSignal } from "./abort.ts";
import { type CombinedAbortSignal, combineAbortSignals } from "./abort-signals.ts";
import type { AssistantMessageEventStream } from "./event-stream.ts";

/**
 * Default gap allowed without a non-keepalive provider stream event, in milliseconds.
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
	return `Provider stream timed out after ${deadlineMs}ms without progress (stream deadline exceeded)`;
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
	abort(reason?: Error): void;
	wrap<T, K extends T = never>(source: AsyncIterable<T>, isKeepAlive?: (item: T) => item is K): AsyncGenerator<Exclude<T, K>, void, undefined>;
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
export function createStreamDeadline(
	value: number | undefined,
	callerSignal?: AbortSignal,
	output?: AssistantMessageEventStream,
): StreamDeadlineHandle {
	const deadlineMs = resolveStreamDeadlineMs(value);
	const controller = new AbortController();
	const combined: CombinedAbortSignal = combineAbortSignals([callerSignal, controller.signal]);
	let abortedByDeadline = false;
	const abort = (reason?: Error) => {
		if (controller.signal.aborted) return;
		if (reason) controller.abort(reason);
		else if (deadlineMs !== undefined) {
			abortedByDeadline = true;
			controller.abort(new StreamDeadlineError(deadlineMs));
		}
	};
	return {
		deadlineMs,
		signal: combined.signal,
		get abortedByDeadline() {
			return abortedByDeadline;
		},
		abort,
		wrap: (source, isKeepAlive) => withStreamDeadline(source, deadlineMs, abort, isKeepAlive, {
			signal: combined.signal,
			progress: output ? () => output.contentProgress : undefined,
		}),
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
 * The timer caps the wait for progress, not the total stream duration.
 * By default, each non-keepalive item counts; adapters supply a cursor so
 * only new normalized assistant content counts. Keep-alives are dropped.
 * When the deadline expires, `onDeadline` aborts the transport before the
 * wrapper rejects, so fallback does not leave the request running.
 *
 * A deadline of `undefined` adds no timer and passes the source through, still dropping keep-alives.
 */
export async function* withStreamDeadline<T, K extends T = never>(
	source: AsyncIterable<T>,
	deadlineMs: number | undefined,
	onDeadline?: () => void,
	isKeepAlive?: (item: T) => item is K,
	options?: { signal?: AbortSignal; progress?: () => number },
): AsyncGenerator<Exclude<T, K>, void, undefined> {
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

	const { progress, signal: callerSignal } = options ?? {};
	let lastProgress = progress?.();
	let waitSignal = callerSignal;
	let cancelTimer: (() => void) | undefined;
	const reset = () => {
		cancelTimer?.();
		cancelTimer = undefined;
		waitSignal = callerSignal;
	};
	try {
		for (;;) {
			if (deadlineMs !== undefined && !cancelTimer) {
				const deadline = new AbortController();
				waitSignal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
				cancelTimer = scheduleDeadline(() => {
					deadline.abort(new StreamDeadlineError(deadlineMs));
					onDeadline?.();
				}, deadlineMs);
			}
			waitSignal?.throwIfAborted();
			const pending = Promise.resolve(iterator.next());
			const result = await (waitSignal ? raceWithAbortSignal(pending, waitSignal) : pending);
			if (result.done) {
				closed = true;
				return;
			}
			if (isKeepAlive?.(result.value) === true) continue;

			if (!progress) reset();
			yield result.value as Exclude<T, K>;
			waitSignal?.throwIfAborted();
			const cursor = progress?.();
			if (cursor !== lastProgress) {
				lastProgress = cursor;
				reset();
			}
		}
	} finally {
		reset();
		closeSource();
	}
}
