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
