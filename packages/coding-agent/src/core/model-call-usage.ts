import type { Usage } from "@bastani/pi-ai/compat";
import type { AgentSessionEvent } from "./agent-session-types.ts";

/**
 * The usage of the one model call a session event reports, or undefined for any other event: an assistant
 * response, a compaction request, a child session's call, or auxiliary usage such as cache warming (#5053).
 */
export function modelCallUsage(event: AgentSessionEvent): Usage | undefined {
	switch (event.type) {
		case "message_end":
			return event.message.role === "assistant" ? event.message.usage : undefined;
		case "compaction_usage":
		case "child_session_usage":
			return event.usage;
		case "entry_appended":
			return event.entry.type === "usage" ? event.entry.usage : undefined;
		default:
			return undefined;
	}
}
