import type { RetryDeadline } from "@bastani/atomic-ai";
import { setLongTimeoutAt } from "@bastani/atomic-timers";
import { type DecisionPhase, DecisionTimeoutError } from "../decision/errors.js";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

const DISABLED_IDLE_DECISION_DEADLINE_MS = 2_147_483_647;
const CANCELLED_MESSAGE = "Structured output cancelled; no decision was accepted.";

/** The failure for an aborted decision: the deadline error when the deadline fired, otherwise a plain cancellation. */
export function abortFailure(signal: AbortSignal): Error {
	return signal.reason instanceof DecisionTimeoutError ? signal.reason : new Error(CANCELLED_MESSAGE);
}

export function validateTimeoutOverride(value: number | undefined): void {
	if (value === undefined) return;
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error("Structured output timeoutMs must be a positive integer.");
	}
}

/**
 * The elapsed time limit for one decision: an explicit `timeoutMs`, else the session's `httpIdleTimeoutMs`, else that
 * setting's default. Disabled idle timeouts still use the documented fallback decision deadline.
 */
export function resolveDecisionDeadlineMs(timeoutMs: number | undefined, httpIdleTimeoutMs?: number): number {
	validateTimeoutOverride(timeoutMs);
	const requested = timeoutMs ?? httpIdleTimeoutMs ?? SETTINGS_DEFAULTS.httpIdleTimeoutMs;
	return requested === 0 ? DISABLED_IDLE_DECISION_DEADLINE_MS : requested;
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

/** One model request, from send to response; transport retries and their waits are not part of it. Records only the stop reason and timing, never content. */
export class DecisionAttempt {
	readonly startedAt = performance.now();
	readonly phase: Exclude<DecisionPhase, "resolve">;
	constructor(phase: Exclude<DecisionPhase, "resolve">) {
		this.phase = phase;
	}
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
	declare retryDeadline?: RetryDeadline;

	get size(): number {
		return this.attempts.length;
	}

	begin(phase: Exclude<DecisionPhase, "resolve">): DecisionAttempt {
		const attempt = new DecisionAttempt(phase);
		this.attempts.push(attempt);
		return attempt;
	}

	/** The phase of the latest request, or `resolve` before the first one was sent. */
	get phase(): DecisionPhase {
		return this.attempts.at(-1)?.phase ?? "resolve";
	}

	/** Mark every generation still in flight as ended without a response. */
	settleOpen(): void {
		for (const attempt of this.attempts) attempt.settle();
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
 * the caller aborts and with a {@link DecisionTimeoutError} when the limit passes, so the existing abort
 * plumbing cancels the in-flight generation. The timer is always released.
 */
export async function withinDecisionDeadline<T>(
	callerSignal: AbortSignal | undefined,
	timeoutMs: number,
	run: (decision: DecisionRun) => Promise<T>,
	options?: { guardProviderRetries: true },
): Promise<T> {
	const controller = new AbortController();
	const trace = new DecisionTrace();
	const forwardCallerAbort = () => controller.abort(callerSignal?.reason);
	if (callerSignal?.aborted) forwardCallerAbort();
	else callerSignal?.addEventListener("abort", forwardCallerAbort, { once: true });
	const startedAt = performance.now();
	const expire = () =>
		controller.abort(
			new DecisionTimeoutError({
				timeoutMs,
				elapsedMs: Math.round(performance.now() - startedAt),
				phase: trace.phase,
				attempts: trace.describe(),
			}),
		);
	if (options?.guardProviderRetries) trace.retryDeadline = { at: startedAt + timeoutMs, onExpired: expire };
	const timer = setLongTimeoutAt(expire, startedAt + timeoutMs);
	try {
		return await run({ signal: controller.signal, trace });
	} finally {
		timer.clear();
		callerSignal?.removeEventListener("abort", forwardCallerAbort);
	}
}
