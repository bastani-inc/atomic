import type { AgentLoopTurnUpdate, PrepareNextTurnContext } from "@earendil-works/pi-agent-core";

import { normalizeToolResultImages } from "../utils/tool-result-images.js";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { assertToolPairingInvariant } from "./context-tool-pairing.js";
import { guardSubagentProtectedPaths } from "./subagent-protected-paths.ts";
import { redirectOversizedToolResult } from "./tools/oversized-tool-result.js";

export function _installAgentToolHooks(this: AgentSession): void {
	this.agent.beforeToolCall = async ({ toolCall, args }) => {
		const protectedPathBlock = guardSubagentProtectedPaths(this._subagentPolicy, this._cwd, {
			toolName: toolCall.name,
			input: args as Record<string, unknown>,
		});
		if (protectedPathBlock) return protectedPathBlock;
		const runner = this._extensionRunner;
		if (!runner.hasHandlers("tool_call")) {
			return undefined;
		}

		await this._agentEventQueue;

		try {
			const result = await runner.emitToolCall({
				type: "tool_call",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
			});
			if (result?.block && result.terminate === true) {
				this._terminatingToolCallIds.add(toolCall.id);
			} else {
				this._terminatingToolCallIds.delete(toolCall.id);
			}
			return result;
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

		const hookContent = hookResult?.content ?? result.content;
		// Run after extension hooks so extension-injected images enter history at provider-safe sizes.
		const normalizedContent = await normalizeToolResultImages(hookContent, {
			autoResizeImages: this.settingsManager.getImageAutoResize(),
		});
		const resultReplacement =
			hookResult || normalizedContent !== hookContent
				? {
						content: normalizedContent,
						details: hookResult?.details,
						isError: hookResult?.isError ?? isError,
					}
				: undefined;
		const finalResult = {
			content: normalizedContent,
			// Preserve original details when an extension hook rewrites only content;
			// the redirect check only replaces model-visible content blocks.
			details: hookResult?.details ?? result.details,
		};
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

		if (result.terminate === true) this._terminatingToolCallIds.add(toolCall.id);
		else this._terminatingToolCallIds.delete(toolCall.id);
		return redirectReplacement ?? resultReplacement;
	};
}

/**
 * Install a prepareNextTurnWithContext hook so that extension tool changes
 * (e.g. setActiveTools) and before_agent_start systemPrompt overrides are
 * applied to the next provider request within the same run.
 */
export function _installAgentNextTurnRefresh(this: AgentSession): void {
	const previousPrepareNextTurnWithContext =
		this.agent.prepareNextTurnWithContext ??
		(this.agent.prepareNextTurn
			? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
			: undefined);

	const previousShouldStopAfterTurn = this.agent.shouldStopAfterTurn;
	this.agent.shouldStopAfterTurn = async (turn, signal) => {
		const toolCallIds = turn.message.content.filter((part) => part.type === "toolCall").map((part) => part.id);
		const terminatingBatch =
			toolCallIds.length > 0 && toolCallIds.every((id) => this._terminatingToolCallIds.has(id));
		for (const id of toolCallIds) this._terminatingToolCallIds.delete(id);

		const shouldStop = (await previousShouldStopAfterTurn?.(turn, signal)) ?? false;
		this._stopAfterTurnBlockedContinuation = shouldStop;
		await settleFallbackAfterTurn(this, turn, terminatingBatch);
		return shouldStop;
	};

	const previousTransformContext = this.agent.transformContext;
	this.agent.transformContext = async (messages, signal) => {
		const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
		const guarded = this._finishPostToolCompactionPreflight(transformed);
		// Last checkpoint before provider conversion: a structurally invalid context
		// here becomes an unrecoverable provider 400, so surface it as an Atomic error.
		assertToolPairingInvariant(guarded);
		return guarded;
	};

	const prepareTurn = async (turn: PrepareNextTurnContext, signal?: AbortSignal): Promise<AgentLoopTurnUpdate> => {
		const compactedMessages =
			turn.toolResults.length > 0
				? await this._preflightPostToolContext(turn.context.messages, signal)
				: turn.context.messages;
		const compactedContext =
			compactedMessages === turn.context.messages ? turn.context : { ...turn.context, messages: compactedMessages };
		const preparedTurn = compactedContext === turn.context ? turn : { ...turn, context: compactedContext };
		const previousSnapshot = await previousPrepareNextTurnWithContext?.(preparedTurn, signal);
		const previousContext = previousSnapshot?.context ?? compactedContext;

		return {
			...previousSnapshot,
			context: {
				...previousContext,
				messages: previousContext.messages,
				systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
				tools: this.agent.state.tools.slice(),
			},
			model: this.agent.state.model,
			thinkingLevel: this.agent.state.thinkingLevel,
		};
	};

	// pi-agent-core 0.84.4 runs the stop hook before queue polling and invokes
	// preparation only after that polling establishes that another turn will run.
	this.agent.prepareNextTurnWithContext = prepareTurn;
}

async function settleFallbackAfterTurn(
	session: AgentSession,
	turn: PrepareNextTurnContext,
	terminatingBatch: boolean,
): Promise<void> {
	// Settle before queued follow-up messages are polled, but keep the fallback
	// lifecycle open for deceptive completions that event processing must retry
	// on the same model (safety refusal, empty completion, or length truncation).
	const preserveFallbackForFailure =
		turn.message.role === "assistant" &&
		!session.agent.hasQueuedMessages() &&
		(turn.message.stopReason === "length" ||
			session._isEmptyCompletion?.(turn.message) === true ||
			session._isSafetyRefusal?.(turn.message) === true);
	if (!preserveFallbackForFailure && (turn.toolResults.length === 0 || terminatingBatch)) {
		await session._agentEventQueue;
		await session._settleFallbackModelScope();
	}
}

export const agentSessionToolHooksMethods = {
	_installAgentToolHooks,
	_installAgentNextTurnRefresh,
};
