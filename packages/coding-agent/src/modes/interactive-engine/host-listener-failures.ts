import { createHash } from "node:crypto";
import { isNativeError, isPromise } from "node:util/types";
import type { ActivityWatchdogDiagnostic } from "./activity-watchdog.ts";

/** What a host listener was handling when it failed. */
export type HostListenerInput = "event" | "message" | "extension UI request" | "end";

const SHOWN_TYPE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The `type` the engine gave what it sent, when it can be read and is safe to show. */
function shownType(value: unknown): string {
	try {
		const type = (value as { type?: unknown } | undefined)?.type;
		return typeof type === "string" && SHOWN_TYPE.test(type) ? `"${type}"` : "unrecognized";
	} catch {
		return "unrecognized";
	}
}

function describeInput(input: HostListenerInput, value: unknown): string {
	switch (input) {
		case "event":
			return `the interactive engine's ${shownType(value)} event`;
		case "message":
			return `the interactive engine's ${shownType(value)} message`;
		case "extension UI request":
			return "an extension UI request from the interactive engine";
		case "end":
			return "the end of the interactive engine";
	}
}

/** What the listener threw, as its message. A value that throws again when it is read gets a fixed text. */
function describeFailure(error: unknown): string {
	try {
		return String(isNativeError(error) ? error.message || error.name : error);
	} catch {
		return "an exception whose message cannot be read";
	}
}

const ignore = (): void => {};

/**
 * Run `report`, a call of the host's own diagnostic reporter, so that nothing it throws, and no rejection of the
 * native promise it returns, goes further: reporting a failure must never end the process, nor stop what reported it.
 * Only a native promise is observed, with the intrinsic `then`; any other returned value is left as it is.
 */
export function reportContained(report: () => unknown): void {
	try {
		const reported = report();
		if (isPromise(reported)) observe(reported, ignore);
	} catch {
		// Reporting failed too. There is nowhere left to report it, and it must not end the process.
	}
}

/**
 * Observe a native promise's rejection with the intrinsic `then`, so the promise's own `then` or `catch` never runs.
 * Only a native promise is observed at all: checking any other value for `then` would run that value's code. A
 * promise that cannot be observed (its constructor throws) is left as it is.
 */
function observe(promise: Promise<unknown>, onRejected: (error: unknown) => void): void {
	try {
		Reflect.apply(Promise.prototype.then, promise, [undefined, onRejected]);
	} catch {
		// Nothing was registered, so nothing can be reported; the listener itself did not fail.
	}
}

/**
 * Calls the host's own listeners with what the interactive engine sent. A listener runs in this process, so what it
 * throws, or what the promise it returns rejects with, is a failure of the host's handling, not of the engine's
 * output (#6107). Each failure is reported once, as that, and goes no further: the other listeners still get the
 * input, the engine's connection is not failed, and nothing escapes from a timer or a promise and ends the process.
 */
export class HostListenerFailures {
	private readonly report: (diagnostic: ActivityWatchdogDiagnostic) => void;
	/** How a listener's pending promise reaches this reporter without keeping it, or its host, alive. */
	private readonly weak = new WeakRef(this);
	/** Each failing listener's latest failure on each input it failed on, kept only while the listener is. */
	private readonly latest = new WeakMap<object, ListenerFailures>();

	constructor(report: (diagnostic: ActivityWatchdogDiagnostic) => void) {
		this.report = report;
	}

	/**
	 * Call `listener` with `value`, which is, or comes from, `about`: what the engine sent, described on failure. `key`
	 * is the listener as the host registered it, when `listener` only adapts it to this call.
	 */
	call<T>(
		listener: (value: T) => unknown,
		value: T,
		input: HostListenerInput,
		about: unknown = value,
		key: object = listener,
	): void {
		let result: unknown;
		try {
			result = listener(value);
		} catch (error) {
			this.fail(this.failuresOf(key), describeInput(input, about), error);
			return;
		}
		if (isPromise(result))
			observe(
				result,
				HostListenerFailures.rejectionObserver(this.weak, this.failuresOf(key), describeInput(input, about)),
			);
	}

	/**
	 * What observes a listener's promise holds while it is pending: the description of the input, the record of its
	 * listener's failures and a weak reference to the reporter, never the input, the listener or the host behind the
	 * reporter.
	 */
	private static rejectionObserver(
		failures: WeakRef<HostListenerFailures>,
		listener: ListenerFailures,
		handling: string,
	) {
		return (error: unknown) => failures.deref()?.fail(listener, handling, error);
	}

	private failuresOf(key: object): ListenerFailures {
		let failures = this.latest.get(key);
		if (failures === undefined) {
			failures = new Map();
			this.latest.set(key, failures);
		}
		return failures;
	}

	/**
	 * Report one failure. One that repeats its listener's latest failure on the same input, for the same reason,
	 * continues that failure's series, so a listener that fails on every streamed update is shown once, with a count,
	 * not once per update.
	 */
	private fail(listener: ListenerFailures, handling: string, error: unknown): void {
		const reason = describeFailure(error);
		const identity = failureIdentity(reason);
		const latest = listener.get(handling);
		const series = latest?.identity === identity ? latest.series : {};
		listener.delete(handling);
		listener.set(handling, { identity, series });
		if (listener.size > TRACKED_INPUTS) listener.delete(listener.keys().next().value!);
		reportContained(() =>
			this.report({
				activity: undefined,
				elapsedMs: 0,
				level: "unresponsive",
				source: "host",
				message: `Atomic failed while handling ${handling}: ${reason}`,
				series,
			}),
		);
	}
}

/** How many inputs a listener's latest failures are kept for; one that fails on more forgets the oldest. */
const TRACKED_INPUTS = 16;
/** Reasons up to this long are kept as they are; a longer one is kept as its digest. */
const KEPT_REASON_LENGTH = 256;

/** What tells two failure reasons apart, without keeping a long one: its text, or the digest of its code units. */
function failureIdentity(reason: string): string {
	return reason.length <= KEPT_REASON_LENGTH
		? `text:${reason}`
		: `digest:${reason.length}:${createHash("sha256").update(Buffer.from(reason, "utf16le")).digest("base64")}`;
}

/** A listener's latest failure on each input, oldest first: why it failed, and the series of identical failures. */
type ListenerFailures = Map<string, { readonly identity: string; readonly series: object }>;
