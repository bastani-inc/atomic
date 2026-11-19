import type { AgentSession } from "./agent-session.js";
import type { AgentSessionEvent } from "./agent-session-types.js";

type RetryStart = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type ModelSwitch = Extract<AgentSessionEvent, { type: "model_fallback_start" }>;

/** A chat without a live event stream draws the latest published activity, without a transcript or error payload. */
export type PublishedChatActivity = "idle" | "working" | "retrying" | "switching";

/** The wait visible between a failed request and its next attempt. It is not the lifetime of the retry. */
export type SessionRetryStatus = (RetryStart & { readonly retryAt: number }) | ModelSwitch;

/** Older session sources expose the retry counter but not the wait's start event. */
export function sessionWaitsToRetry(
	session: Pick<AgentSession, "retryStatus" | "isWaitingToRetry" | "retryAttempt" | "isStreaming">,
): boolean {
	return "retryStatus" in session
		? session.retryStatus?.type === "auto_retry_start"
		: session.retryAttempt > 0 && (!session.isStreaming || session.isWaitingToRetry);
}

/** Only the start events need their payload; the session and its remote mirror publish the same transitions. */
export function retryStatusUpdate(
	event: RetryStart | ModelSwitch | { type: Exclude<AgentSessionEvent["type"], SessionRetryStatus["type"]> },
): SessionRetryStatus | null | undefined {
	switch (event.type) {
		case "auto_retry_start":
			return { ...event, retryAt: Date.now() + event.delayMs };
		case "model_fallback_start":
			return event;
		case "agent_start":
		case "agent_end":
		case "auto_retry_end":
		case "model_fallback_end":
		case "agent_continue_error":
		case "session_released":
			return null;
		default:
			return undefined;
	}
}
