/** The broker's refusal code for a child whose supervisor capability it cannot honour at registration. */
export const SUPERVISOR_AUTHORIZATION_REFUSED_CODE = "supervisor_authorization_refused";
/** The reason the broker gives, which a broker older than the code sends alone. */
export const SUPERVISOR_AUTHORIZATION_REFUSED_REASON = "Invalid supervisor authorization";

/**
 * The broker refused the supervisor capability a subagent registered with: it was never issued for this child, or the
 * session it was issued to is no longer connected (a released or restarted owner). The child is still a child: it
 * registers without the capability and reaches its supervisor by name.
 */
export class IntercomSupervisorAuthorizationRefusedError extends Error {
	readonly code = SUPERVISOR_AUTHORIZATION_REFUSED_CODE;
	constructor(reason: string = SUPERVISOR_AUTHORIZATION_REFUSED_REASON) {
		super(reason);
		this.name = "IntercomSupervisorAuthorizationRefusedError";
	}
}

export function isSupervisorAuthorizationRefusal(error: unknown): boolean {
	return (
		error instanceof IntercomSupervisorAuthorizationRefusedError ||
		(error instanceof Error && error.message === SUPERVISOR_AUTHORIZATION_REFUSED_REASON)
	);
}

/**
 * How long a child keeps registering with a refused supervisor capability before it registers without it. A broker
 * restart refuses a capability until the supervisor reconnects and restores it, usually within a few seconds.
 */
export const SUPERVISOR_REFUSAL_RETRY_MS = 30_000;

const SUPERVISOR_REFUSAL_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000] as const;

/** The pause before the next registration with a refused capability. */
export function supervisorRefusalRetryDelayMs(attempt: number): number {
	return SUPERVISOR_REFUSAL_BACKOFF_MS[Math.min(attempt, SUPERVISOR_REFUSAL_BACKOFF_MS.length - 1)]!;
}

/** Wait `ms`, or less when `signal` aborts first. */
export function pauseUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		timer.unref?.();
		signal.addEventListener("abort", done, { once: true });
	});
}
