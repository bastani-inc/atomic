const AGENT_SESSION_BUSY_HINT = "Specify streamingBehavior ('steer' or 'followUp') to queue the message.";

/**
 * `prompt()` was called while the session is running a turn, without saying how to queue the message. Nothing was
 * sent: send it again with `streamingBehavior`, or wait for the turn to end.
 */
export class AgentSessionBusyError extends Error {
	override readonly name = "AgentSessionBusyError" as const;
	readonly code = "agent_session_busy" as const;
	readonly hint = AGENT_SESSION_BUSY_HINT;

	constructor() {
		super(
			`Agent is already processing: the session is running a turn (agent_session_busy). ${AGENT_SESSION_BUSY_HINT}`,
		);
	}
}

export function isAgentSessionBusyError(value: unknown): value is AgentSessionBusyError {
	if (value instanceof AgentSessionBusyError) return true;
	if (typeof value !== "object" || value === null) return false;
	const { name, code } = value as { readonly name?: unknown; readonly code?: unknown };
	return name === "AgentSessionBusyError" && code === "agent_session_busy";
}
