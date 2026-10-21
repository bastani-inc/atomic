/**
 * Extension startup failures.
 *
 * A session whose extensions fail `session_start` or `resources_discover` is
 * rolled back and rejects with one `ExtensionStartupError`. Its message and
 * `failures` name every failing extension and its own error, so callers can
 * report and classify the failure without reading `AggregateError.errors`.
 */

export const EXTENSION_STARTUP_FAILED_CODE = "ExtensionStartupFailed";

export interface ExtensionStartupFailure {
	readonly extensionPath: string;
	readonly event: string;
	readonly message: string;
}

function describeFailure(failure: ExtensionStartupFailure): string {
	return `${failure.extensionPath}: ${failure.message}`;
}

export class ExtensionStartupError extends AggregateError {
	readonly code = EXTENSION_STARTUP_FAILED_CODE;
	readonly failures: readonly ExtensionStartupFailure[];

	constructor(failures: readonly ExtensionStartupFailure[]) {
		super(
			failures.map((failure) => new Error(describeFailure(failure))),
			`Extension startup failed: ${failures.map(describeFailure).join("; ")}`,
		);
		this.name = "ExtensionStartupError";
		this.failures = failures;
	}
}

/** Load- and timing-dependent errors, such as an Intercom broker that could not start or accept a connection in time. */
const TRANSIENT_EXTENSION_STARTUP_PATTERNS: readonly RegExp[] = [
	/\btime[sd]?\s*out\b|\btimeout\b/i,
	/\b(?:ECONNREFUSED|ECONNRESET|ECONNABORTED|EPIPE|EAGAIN|EBUSY|ETIMEDOUT|EMFILE|ENFILE|EADDRINUSE)\b/,
	/\bconnect ENOENT\b/,
	/\bconnection closed\b|\bsocket hang up\b|\bclosed before registration\b/i,
	/\bexited before startup\b/i,
];

function isExtensionStartupError(error: unknown): error is ExtensionStartupError {
	return (
		error instanceof AggregateError &&
		(error as Partial<ExtensionStartupError>).code === EXTENSION_STARTUP_FAILED_CODE &&
		Array.isArray((error as Partial<ExtensionStartupError>).failures)
	);
}

function aggregatesExtensionStartupError(error: unknown, seen: Set<unknown>): boolean {
	if (!(error instanceof AggregateError) || seen.has(error)) return false;
	seen.add(error);
	if (isExtensionStartupError(error)) return true;
	return error.errors.some((inner: unknown) => aggregatesExtensionStartupError(inner, seen));
}

/** True when `error` is, or aggregates, an extension startup failure. */
export function isExtensionStartupFailure(error: unknown): boolean {
	return aggregatesExtensionStartupError(error, new Set());
}

/**
 * True when a fresh session may succeed: every failing extension reported a
 * load- or timing-dependent error. A startup failure whose rollback also failed
 * is never transient, so its ownership problems are not retried over.
 */
export function isTransientExtensionStartupFailure(error: unknown): boolean {
	return (
		isExtensionStartupError(error) &&
		error.failures.length > 0 &&
		error.failures.every((failure) =>
			TRANSIENT_EXTENSION_STARTUP_PATTERNS.some((pattern) => pattern.test(failure.message)),
		)
	);
}

/** Message for an aggregate that wraps a startup failure with the errors its cleanup reported. */
export function startupCleanupFailureMessage(summary: string, errors: readonly unknown[]): string {
	const details = errors.map((error) => (error instanceof Error ? error.message : String(error)));
	return `${summary}: ${details.join("; ")}`;
}
