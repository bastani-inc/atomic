import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

/** The largest delay `setTimeout` honors; a larger one fires immediately. */
const MAX_DEADLINE_MS = 2_147_483_647;

const CANCELLED_MESSAGE = "Structured output cancelled; no decision was accepted.";

export class StructuredOutputDeadlineError extends Error {
	constructor(timeoutMs: number, attempts: string) {
		super(
			`Structured output decision exceeded its ${timeoutMs}ms deadline; no decision was accepted.${attempts ? ` ${attempts}` : ""}`,
		);
		this.name = "StructuredOutputDeadlineError";
	}
}

/** The failure for an aborted decision: the deadline error when the deadline fired, otherwise a plain cancellation. */
export function abortFailure(signal: AbortSignal): Error {
	return signal.reason instanceof StructuredOutputDeadlineError ? signal.reason : new Error(CANCELLED_MESSAGE);
}

export function validateTimeoutOverride(value: number | undefined): void {
	if (value === undefined) return;
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error("Structured output timeoutMs must be a positive integer.");
	}
}

/**
 * The wall-clock limit for one decision: an explicit `timeoutMs`, else the session's `httpIdleTimeoutMs`, else that
 * setting's default. Like the provider clients, an idle timeout of `0` (disabled) becomes the largest timer delay.
 */
export function resolveDecisionDeadlineMs(timeoutMs: number | undefined, httpIdleTimeoutMs?: number): number {
	validateTimeoutOverride(timeoutMs);
	const requested = timeoutMs ?? httpIdleTimeoutMs ?? SETTINGS_DEFAULTS.httpIdleTimeoutMs;
	return requested === 0 ? MAX_DEADLINE_MS : Math.min(requested, MAX_DEADLINE_MS);
}

function formatDuration(milliseconds: number): string {
	const ms = Math.round(milliseconds);
	if (ms < 1_000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
	const totalSeconds = Math.round(ms / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const pad = (value: number) => String(value).padStart(2, "0");
	const clock = hours > 0 ? `${hours}h${pad(minutes)}m` : `${minutes}m`;
	return `${clock}${pad(totalSeconds % 60)}s`;
}

/** One model generation, from request to response. Records only the stop reason and timing, never content. */
export class DecisionAttempt {
	readonly startedAt = performance.now();
	endedAt: number | undefined;
	stopReason: string | undefined;

	settle(stopReason?: string): void {
		this.endedAt ??= performance.now();
		if (stopReason !== undefined) this.stopReason = stopReason;
	}

	describe(now: number): string {
		const outcome =
			this.endedAt === undefined
				? "still generating"
				: this.stopReason === undefined
					? "no response"
					: `stopReason=${this.stopReason}`;
		return `${outcome} ${formatDuration((this.endedAt ?? now) - this.startedAt)}`;
	}
}

/** How every generation of one decision ended and how long it took, across repairs, retries and candidates. */
export class DecisionTrace {
	private readonly attempts: DecisionAttempt[] = [];

	get size(): number {
		return this.attempts.length;
	}

	begin(): DecisionAttempt {
		const attempt = new DecisionAttempt();
		this.attempts.push(attempt);
		return attempt;
	}

	/** The attempts from `first` onward, numbered from 1, or an empty string when there are none. */
	describe(first = 0): string {
		const now = performance.now();
		const shown = this.attempts.slice(first);
		if (shown.length === 0) return "";
		return `Attempts: ${shown.map((attempt, index) => `${index + 1}) ${attempt.describe(now)}`).join("; ")}.`;
	}
}

export interface DecisionRun {
	readonly signal: AbortSignal;
	readonly trace: DecisionTrace;
}

/**
 * Run a whole decision under one wall-clock limit. `run` receives a signal that aborts with the caller's reason when
 * the caller aborts and with a {@link StructuredOutputDeadlineError} when the limit passes, so the existing abort
 * plumbing cancels the in-flight generation. The timer is always released.
 */
export async function withinDecisionDeadline<T>(
	callerSignal: AbortSignal | undefined,
	timeoutMs: number,
	run: (decision: DecisionRun) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const trace = new DecisionTrace();
	const forwardCallerAbort = () => controller.abort(callerSignal?.reason);
	if (callerSignal?.aborted) forwardCallerAbort();
	else callerSignal?.addEventListener("abort", forwardCallerAbort, { once: true });
	const timer = setTimeout(
		() => controller.abort(new StructuredOutputDeadlineError(timeoutMs, trace.describe())),
		timeoutMs,
	);
	try {
		return await run({ signal: controller.signal, trace });
	} finally {
		clearTimeout(timer);
		callerSignal?.removeEventListener("abort", forwardCallerAbort);
	}
}
