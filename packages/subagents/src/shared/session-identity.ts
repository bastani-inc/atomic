interface SessionIdentityManager {
	getSessionId(): string | null | undefined;
}

export class SubagentSessionIdentityError extends Error {
	constructor() {
		super("Current session identity is unavailable.");
		this.name = "SubagentSessionIdentityError";
	}
}

export function resolveCurrentSessionId(sessionManager: SessionIdentityManager): string {
	const sessionId = sessionManager.getSessionId();
	if (sessionId === undefined || sessionId === null) throw new SubagentSessionIdentityError();
	return sessionId;
}
