import type { SessionInfo } from "./types.js";

export const NON_AGENT_RECIPIENT_REFUSAL = "Target is an internal non-agent connection and cannot receive Intercom messages";
export const TERMINAL_CHILD_ASK_REFUSAL = "Target noninteractive child is terminal and cannot reply; launch a fresh child with explicit context";

/** Older host registrations omit purpose and continue to represent agents. */
export function isAgentRecipient(session: Pick<SessionInfo, "recipientPurpose">): boolean {
	return session.recipientPurpose === undefined || session.recipientPurpose === "agent";
}
