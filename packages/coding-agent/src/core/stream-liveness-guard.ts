/**
 * Content-progress liveness guard for an assistant response stream (issue #2446).
 *
 * A non-terminating provider turn can block a foreground in-process subagent
 * indefinitely: the reporter observed 32749 consecutive whitespace-only
 * `toolcall_delta` events with no `message_end`, the child pending, fallback
 * attempt count stuck at 0, and the parent blocked ~6.5 hours. pi-agent-core's
 * consumption loop (`for await (const event of response)`) has no inter-event
 * timeout and no `signal.aborted` check, so a stream that floods contentless
 * deltas — or goes silent — never reaches a terminal event and `prompt()` never
 * settles. Fallback is throw-driven, so a stream that throws nothing never
 * advances a candidate.
 *
 * This guard wraps the `AssistantMessageEventStream` returned by the streamFn
 * factory and tracks time since the last *content-bearing* event. If no such
 * event arrives within `stallMs`, it **throws** (it must not return-done: after
 * the for-await loop agent-loop calls `await response.result()`, which would
 * hang forever without a terminal event). The throw surfaces as a retryable
 * provider failure whose message matches the classifier's
 * `stream ended before a terminal response event` pattern and normalizes to
 * `provider_unavailable` — so same-model retry and configured `fallbackModels`
 * advance inside the same `prompt()` call, or, with no fallback, `prompt()`
 * resolves with an error and the runner returns control.
 *
 * Classification of the resulting failure is entirely pi-agent-core's job: it
 * stamps `stopReason: signal.aborted ? "aborted" : "error"`. The guard only
 * decides *when* to end the stream; it never decides fallbackable-vs-cancelled.
 * On abort it ends promptly (so the parent unblocks) and the run is stamped
 * `"aborted"` → `cancelled` → no fallback. Real reasoning or tool activity
 * (any content-bearing delta, and every structural/terminal event) resets the
 * window, so long legitimate turns and in-flight tools are never affected.
 *
 * The guard is inert unless `stallMs > 0`, and only unattended in-process
 * subagent sessions set it; the interactive main session is byte-for-byte
 * unchanged.
 */

import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { EventStream } from "@earendil-works/pi-ai";

/**
 * Whether an event represents forward progress toward a terminal response.
 *
 * Only the three streaming delta events carry a `delta: string` and can flood
 * without advancing the message; a whitespace-only delta (the #2446 shape) adds
 * nothing a terminal event needs, so it does not count as progress. Every other
 * event — `start`, the `*_start`/`*_end` pairs, `done`, and `error` — is
 * structural or terminal and always counts.
 */
export function isProgressEvent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.trim().length > 0;
		default:
			return true;
	}
}

export interface StreamLivenessGuardOptions {
	/**
	 * No-progress window in milliseconds. Values `<= 0` (and `NaN`) disable the
	 * guard: {@link guardStreamLiveness} returns the source stream unchanged.
	 */
	stallMs: number;
	/**
	 * The run's abort signal. When it fires, the guard ends the stream promptly
	 * so an unattended parent unblocks; pi-agent-core then stamps the failure
	 * `"aborted"` (→ cancelled, no fallback).
	 */
	signal?: AbortSignal;
	/** Injectable clock; defaults to `Date.now`. Tests inject a fake clock. */
	now?: () => number;
	/**
	 * Injectable timer. Schedules `callback` after `ms` and returns a canceller.
	 * Defaults to a `setTimeout`/`clearTimeout` pair; tests inject a controllable
	 * timer so the silent-stall path is deterministic without real time.
	 */
	schedule?: (callback: () => void, ms: number) => () => void;
	/** Fired once when the no-progress deadline trips, with the observed idle ms. */
	onStall?: (idleMs: number) => void;
}

type RaceOutcome =
	| { readonly kind: "event"; readonly result: IteratorResult<AssistantMessageEvent> }
	| { readonly kind: "timeout" }
	| { readonly kind: "abort" };

const ABORT_MESSAGE = "stream consumption aborted";

const defaultSchedule = (callback: () => void, ms: number): (() => void) => {
	const handle = setTimeout(callback, ms);
	return () => clearTimeout(handle);
};

/**
 * Message wording is load-bearing: it matches the retryable
 * `stream ended before a terminal response event` pattern in
 * `model-fallback-failures.ts` and deliberately avoids `timeout`/`network`
 * tokens so the failure normalizes to `provider_unavailable` (fallbackable and
 * same-model-retryable) rather than `network_timeout`.
 */
function terminallessError(detail: string): Error {
	return new Error(`stream ended before a terminal response event (${detail})`);
}

class GuardedAssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	private readonly source: AssistantMessageEventStream;
	private readonly options: StreamLivenessGuardOptions;

	constructor(source: AssistantMessageEventStream, options: StreamLivenessGuardOptions) {
		// pi-ai's barrel re-exports `AssistantMessageEventStream` type-only (its
		// `types.ts` uses `export type`), so under `verbatimModuleSyntax` it cannot be
		// used as a value/`extends` target. Extend the value-exported base
		// `EventStream<AssistantMessageEvent, AssistantMessage>` instead — the real
		// subclass adds no members over it, so an instance stays assignable to the
		// `AssistantMessageEventStream` type. Mirror pi-ai's own ctor predicates so the
		// inherited base behaves identically if ever touched; the guard overrides
		// iteration and result(), so the base queue/push/end machinery goes unused.
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type for final result");
			},
		);
		this.source = source;
		this.options = options;
	}

	// The terminal result is produced by the underlying stream, which resolves it
	// as the `done`/`error` event is pushed — before that event reaches a
	// consumer. So on the normal path this is already resolved; on a stall/abort
	// the iterator throws and agent-loop never reaches its `await response.result()`.
	override result() {
		return this.source.result();
	}

	override async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		const { stallMs, signal, onStall } = this.options;
		const now = this.options.now ?? Date.now;
		const schedule = this.options.schedule ?? defaultSchedule;
		const iterator = this.source[Symbol.asyncIterator]();

		// Arm the abort race once with a single listener removed on cleanup.
		let removeAbortListener: (() => void) | undefined;
		const abortRace: Promise<RaceOutcome> | undefined = signal
			? new Promise<RaceOutcome>((resolve) => {
					if (signal.aborted) {
						resolve({ kind: "abort" });
						return;
					}
					const listener = () => resolve({ kind: "abort" });
					signal.addEventListener("abort", listener, { once: true });
					removeAbortListener = () => signal.removeEventListener("abort", listener);
				})
			: undefined;

		let lastProgressAt = now();
		// Whether a terminal `done`/`error` event has already been delivered. Once it
		// has, the underlying iterator's trailing `{done:true}` is a normal close and
		// must `return`, not throw. agent-loop happens to `return` on the terminal
		// event itself and never pulls that tail, but a plain `for await` consumer
		// would — and "closed without a terminal event" must stay truthful, reserved
		// for a source that stops without ever delivering one (which alone would hang
		// agent-loop's post-loop `await response.result()`).
		let sawTerminal = false;
		// One outstanding source.next() at a time; reused across timer wins.
		let pending: Promise<RaceOutcome> | undefined;

		try {
			while (true) {
				// Abort outranks the stall deadline, so an abort+stall tie resolves
				// deterministically as a cancellation.
				if (signal?.aborted) throw new Error(ABORT_MESSAGE);

				const idle = now() - lastProgressAt;
				if (idle >= stallMs) {
					onStall?.(idle);
					throw terminallessError(`no content progress for ${idle}ms`);
				}
				const remaining = stallMs - idle;

				if (!pending) {
					pending = iterator.next().then((result): RaceOutcome => ({ kind: "event", result }));
				}

				let cancelTimer: (() => void) | undefined;
				const timeout = new Promise<RaceOutcome>((resolve) => {
					cancelTimer = schedule(() => resolve({ kind: "timeout" }), remaining);
				});
				const racers = abortRace ? [pending, timeout, abortRace] : [pending, timeout];
				let outcome: RaceOutcome;
				try {
					outcome = await Promise.race(racers);
				} finally {
					cancelTimer?.();
				}

				if (outcome.kind === "abort") throw new Error(ABORT_MESSAGE);
				if (outcome.kind === "timeout") continue; // re-check the deadline (silent stall)

				// A delivered event consumes the pending slot regardless of content.
				pending = undefined;
				if (outcome.result.done) {
					if (sawTerminal) return; // normal close after a terminal done/error event
					// Source closed without ever delivering a terminal done/error event.
					// Returning would make agent-loop's post-loop `await response.result()`
					// hang forever, so end the stream retryably instead.
					throw terminallessError("source closed without a terminal event");
				}
				const event = outcome.result.value;
				if (event.type === "done" || event.type === "error") sawTerminal = true;
				if (isProgressEvent(event)) lastProgressAt = now();
				yield event;
			}
		} finally {
			removeAbortListener?.();
			// Release the underlying producer and swallow any still-outstanding
			// next() rejection so an abandoned pending cannot surface as an
			// unhandled rejection after we have thrown.
			void Promise.resolve(iterator.return?.()).catch(() => {});
			if (pending) void pending.catch(() => {});
		}
	}
}

/**
 * Wrap a raw assistant-response stream with a content-progress liveness guard.
 *
 * Returns `source` unchanged when `stallMs <= 0` (disabled), so the interactive
 * main session — which never sets a positive window — is unaffected. Otherwise
 * returns a stream that ends with a retryable failure when no content-bearing
 * event arrives within `stallMs`. The result is an `AssistantMessageEventStream`
 * subclass, so `instanceof` and the streamFn return contract are preserved.
 */
export function guardStreamLiveness(
	source: AssistantMessageEventStream,
	options: StreamLivenessGuardOptions,
): AssistantMessageEventStream {
	if (!(options.stallMs > 0)) return source;
	return new GuardedAssistantMessageEventStream(source, options);
}
