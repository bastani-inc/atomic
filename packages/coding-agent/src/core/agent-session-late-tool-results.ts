import type { AgentToolResult } from "@bastani/atomic-agent-core";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { LateToolOutcome } from "./tools/tool-abort-grace.ts";

/** The custom message a call's late outcome is recorded as, after its interrupted turn stopped waiting for it (#5486). */
export const LATE_TOOL_RESULT_CUSTOM_TYPE = "late-tool-result";

export interface LateToolResultDetails {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly isError: boolean;
}

function resultText(result: AgentToolResult<unknown>): string {
	const text = (result.content ?? [])
		.map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
		.join("\n")
		.trim();
	return text || "(no output)";
}

/** How a late outcome reads in the conversation. */
export function lateToolResultText(toolCallId: string, toolName: string, outcome: LateToolOutcome): string {
	const failed = outcome.kind === "error" || outcome.result.isError === true;
	const body =
		outcome.kind === "result"
			? resultText(outcome.result)
			: outcome.error instanceof Error
				? outcome.error.message
				: String(outcome.error);
	return `The ${toolName} call ${toolCallId} that was interrupted ${failed ? "failed" : "finished"} after its turn ended:\n${body}`;
}

/**
 * Add a call's late outcome to the conversation without starting a turn: the model reads it with its next turn, and a
 * turn running now takes it once that turn ends. A session that has closed meanwhile records nothing.
 */
export function recordLateToolOutcome(
	session: AgentSession,
	toolCallId: string,
	toolName: string,
	outcome: LateToolOutcome,
): void {
	const details: LateToolResultDetails = {
		toolCallId,
		toolName,
		isError: outcome.kind === "error" || outcome.result.isError === true,
	};
	void Promise.resolve()
		.then(() =>
			session.sendCustomMessage(
				{
					customType: LATE_TOOL_RESULT_CUSTOM_TYPE,
					content: lateToolResultText(toolCallId, toolName, outcome),
					display: true,
					details,
				},
				{ triggerTurn: false },
			),
		)
		.catch(() => {});
}
