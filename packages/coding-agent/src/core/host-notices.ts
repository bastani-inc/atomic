import type { AgentSessionEvent } from "./agent-session-types.js";

export const HOST_NOTICE_TYPE = "atomic.turn-outcome.v1";

/** The terminal's turn-ending line, with its original prefix (automatic compaction errors have none). */
export function hostNoticeForEvent(
	event: AgentSessionEvent,
	compactionReason: string | undefined,
): { level: "error" | "warning" | "dim"; text: string; childUnprefixed?: true } | undefined {
	switch (event.type) {
		case "auto_retry_end":
			return event.success
				? undefined
				: {
						level: "error",
						text: `Error: Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`,
					};
		case "agent_continue_error":
			return { level: "error", text: `Error: ${event.errorMessage}`, childUnprefixed: true };
		case "compaction_end": {
			const manual = event.reason === "manual";
			if (!manual && (event.manualTakeoverPending || compactionReason === "manual")) return undefined;
			if (event.aborted)
				return manual
					? { level: "error", text: "Error: Compaction cancelled" }
					: { level: "dim", text: "Auto-compaction cancelled" };
			return event.errorMessage
				? {
						level: "error",
						text: manual ? `Error: ${event.errorMessage}` : event.errorMessage,
						...(manual ? { childUnprefixed: true as const } : {}),
					}
				: undefined;
		}
		case "worktree_snapshot_unavailable":
			return ["not-installed", "not-a-repository", "unborn-head"].includes(event.reason.code ?? "")
				? undefined
				: { level: "warning", text: `Warning: ${event.reason.message}` };
		default:
			return undefined;
	}
}
