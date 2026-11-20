import type { AssistantMessage } from "../types.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";

/** `AssistantMessageDiagnostic.type` of the note that Atomic inferred a GitHub Copilot response's stop reason. */
export const GITHUB_COPILOT_INFERRED_STOP_REASON_DIAGNOSTIC = "github_copilot_inferred_stop_reason";

/**
 * The stop reason of a GitHub Copilot Chat Completions response whose stream ended normally, with its terminal
 * `[DONE]` event, but reported no finish reason, as GitHub Copilot sometimes does (seen with Gemini models):
 * `toolUse` when the response has tool calls and every one of them is complete, `stop` when it has none. A response
 * with no text and no tool call gets `stop`, which the empty-response check then reports. Undefined when a tool call
 * may be incomplete: the stream then counts as one that ended early.
 */
export function inferGitHubCopilotStopReason(
	output: AssistantMessage,
	everyToolCallComplete: boolean,
): "stop" | "toolUse" | undefined {
	if (!output.content.some((block) => block.type === "toolCall")) return "stop";
	return everyToolCallComplete ? "toolUse" : undefined;
}

/** Note on a finished response that its stop reason was inferred, so debug output and session exports show it. */
export function recordGitHubCopilotInferredStopReason(output: AssistantMessage): void {
	appendAssistantMessageDiagnostic(output, {
		type: GITHUB_COPILOT_INFERRED_STOP_REASON_DIAGNOSTIC,
		timestamp: Date.now(),
		details: {
			stopReason: output.stopReason,
			message: `GitHub Copilot ended the response stream normally without a finish reason; the stop reason "${output.stopReason}" was inferred from the complete response.`,
		},
	});
}
