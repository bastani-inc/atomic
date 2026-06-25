import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { redirectOversizedToolResult } from "./tools/oversized-tool-result.js";

export function _installAgentToolHooks(this: AgentSession): void {
	this.agent.beforeToolCall = async ({ toolCall, args }) => {
		const runner = this._extensionRunner;
		if (!runner.hasHandlers("tool_call")) {
			return undefined;
		}

		await this._agentEventQueue;

		try {
			return await runner.emitToolCall({
				type: "tool_call",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
			});
		} catch (err) {
			if (err instanceof Error) {
				throw err;
			}
			throw new Error(`Extension failed, blocking execution: ${String(err)}`);
		}
	};

	this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
		const runner = this._extensionRunner;
		const hookResult = runner.hasHandlers("tool_result")
			? await runner.emitToolResult({
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					isError,
				})
			: undefined;

		const extensionReplacement = hookResult
			? {
					content: hookResult.content,
					details: hookResult.details,
					isError: hookResult.isError ?? isError,
				}
			: undefined;
		const finalResult = hookResult
			? {
					content: hookResult.content ?? result.content,
					// Preserve original details when an extension hook rewrites only content;
					// the redirect check only replaces model-visible content blocks.
					details: hookResult.details ?? result.details,
				}
			: result;
		const finalIsError = hookResult?.isError ?? isError;
		const redirectReplacement = await redirectOversizedToolResult({
			toolName: toolCall.name,
			toolCallId: toolCall.id,
			result: finalResult,
			isError: finalIsError,
			sessionId: this.sessionManager.getSessionId(),
			sessionDir: this.sessionManager.getSessionDir() || undefined,
			maxResultSizeChars: this.getToolDefinition(toolCall.name)?.maxResultSizeChars,
		});

		return redirectReplacement ?? extensionReplacement;
	};
}

// =========================================================================
// Event Subscription
// =========================================================================

/** Emit an event to all listeners */

export const agentSessionToolHooksMethods = {
	_installAgentToolHooks,
};
