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

	constructor(report: (diagnostic: ActivityWatchdogDiagnostic) => void) {
		this.report = report;
	}

	/** Call `listener` with `value`, which is, or comes from, `about`: what the engine sent, described on failure. */
	call<T>(listener: (value: T) => unknown, value: T, input: HostListenerInput, about: unknown = value): void {
		let result: unknown;
		try {
			result = listener(value);
		} catch (error) {
			this.fail(describeInput(input, about), error);
			return;
		}
		if (isPromise(result))
			observe(result, HostListenerFailures.rejectionObserver(this.weak, describeInput(input, about)));
	}

	/**
	 * What observes a listener's promise holds while it is pending: the description of the input and a weak
	 * reference to the reporter, never the input itself or the host behind the reporter.
	 */
	private static rejectionObserver(failures: WeakRef<HostListenerFailures>, handling: string) {
		return (error: unknown) => failures.deref()?.fail(handling, error);
	}

	private fail(handling: string, error: unknown): void {
		try {
			const reported: unknown = this.report({
				activity: undefined,
				elapsedMs: 0,
				level: "unresponsive",
				source: "host",
				message: `Atomic failed while handling ${handling}: ${describeFailure(error)}`,
			});
			if (isPromise(reported)) observe(reported, ignore);
		} catch {
			// Reporting the failure failed too. There is nowhere left to report it, and it must not end the process.
		}
	}
}
