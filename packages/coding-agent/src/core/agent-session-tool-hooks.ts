import type { SystemMessage } from "@bastani/pi-ai";
import type { AgentLoopTurnUpdate, PrepareNextTurnContext } from "@earendil-works/pi-agent-core";
import { normalizeToolResultImages } from "../utils/tool-result-images.js";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { assertToolPairingInvariant } from "./context-tool-pairing.js";
import { normalizeBuildSystemPromptOptions } from "./system-prompt.ts";
import { redirectOversizedToolResult } from "./tools/oversized-tool-result.js";

export function _installAgentToolHooks(this: AgentSession): void {
	this.agent.beforeToolCall = async ({ toolCall, args }) => {
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
			? await runner.emitToolResult(
					{
						type: "tool_result",
						toolName: toolCall.name,
						toolCallId: toolCall.id,
						input: args as Record<string, unknown>,
						content: result.content,
						details: result.details,
						isError,
					},
					true,
				)
			: undefined;

		const hookContent = hookResult?.content ?? result.content;
		// Run after extension hooks so extension-injected images enter history at provider-safe sizes.
		const resizeOptions = this.model?.inputLimits?.images?.resize;
		const normalizedContent = await normalizeToolResultImages(hookContent, {
			autoResizeImages: this.settingsManager.getImageAutoResize(),
			...(resizeOptions ? { resizeOptions } : {}),
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

	const previousFinishTurn = this.agent.finishTurn;
	this.agent.finishTurn = async (turn, signal) => {
		// shouldStopAfterTurn previously ran only for normal responses. finishTurn
		// also fires for error/aborted turns, but those stay hard exits whose
		// decisions agent-core ignores, so skip the side effects there too.
		if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return undefined;
		const toolCallIds = turn.message.content.filter((part) => part.type === "toolCall").map((part) => part.id);
		const terminatingBatch =
			toolCallIds.length > 0 && toolCallIds.every((id) => this._terminatingToolCallIds.has(id));
		for (const id of toolCallIds) this._terminatingToolCallIds.delete(id);

		const previousDecision = (await previousFinishTurn?.(turn, signal)) ?? undefined;
		this._stopAfterTurnBlockedContinuation = previousDecision?.action === "end";
		await settleFallbackAfterTurn(this, turn, terminatingBatch);
		if (this._subagentMessageAdmission) await this._subagentMessageAdmission.waitForPendingDeliveries();
		return previousDecision;
	};

	const previousTransformContext = this.agent.transformContext;
	this.agent.transformContext = async (messages, signal) => {
		const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
		const guarded = this._finishPostToolCompactionPreflight(transformed);
		// Last checkpoint before provider conversion: a structurally invalid context
		// here becomes an unrecoverable provider 400, so surface it as an Atomic error.
		assertToolPairingInvariant(guarded);
		const forced = this._runSystemPromptOptions?.forceSystemPrompt ?? this._baseSystemPromptOptions.forceSystemPrompt;
		if (forced === undefined) return guarded;
		let sawInitialSystem = false;
		const rebuilt: typeof guarded = [];
		for (const message of guarded) {
			if (message.role !== "system") {
				rebuilt.push(message);
				continue;
			}
			if (!sawInitialSystem) {
				sawInitialSystem = true;
				const head: SystemMessage = {
					role: "system",
					content: forced,
					...(message.toolsAdded ? { toolsAdded: message.toolsAdded } : {}),
					timestamp: message.timestamp,
				};
				rebuilt.push(head);
				continue;
			}
			if (!message.toolsAdded?.length && !message.toolsRemoved?.length) continue;
			const toolDelta: SystemMessage = {
				role: "system",
				content: "",
				...(message.toolsAdded ? { toolsAdded: message.toolsAdded } : {}),
				...(message.toolsRemoved ? { toolsRemoved: message.toolsRemoved } : {}),
				timestamp: message.timestamp,
			};
			rebuilt.push(toolDelta);
		}
		if (!sawInitialSystem) {
			rebuilt.unshift({ role: "system", content: forced, timestamp: Date.now() });
		}
		return rebuilt;
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
		// A caller-supplied replacement is the complete context for the next request; the
		// canonical projection must not overwrite it at the request boundary.
		this._callerReplacedNextRequestContext = previousSnapshot?.context !== undefined;
		const previousContext = previousSnapshot?.context ?? compactedContext;
		const runOptions = this._runSystemPromptOptions ?? this._baseSystemPromptOptions;
		const options = normalizeBuildSystemPromptOptions({
			...runOptions,
			selectedModel: this.model,
			selectedThinkingLevel: this.thinkingLevel,
			selectedTools: this.getActiveToolNames(),
			toolSnippets: { ...this._baseSystemPromptOptions.toolSnippets, ...runOptions.toolSnippets },
			toolGuidelines: { ...this._baseSystemPromptOptions.toolGuidelines, ...runOptions.toolGuidelines },
		});
		const updateMessage = this._preparePromptAndToolLoadout(options, previousContext.messages);
		this._runSystemPromptOptions = options;

		return {
			...previousSnapshot,
			context: {
				...previousContext,
				messages: previousContext.messages,
				tools: this.agent.state.tools.slice(),
			},
			messages: updateMessage ? [...(previousSnapshot?.messages ?? []), updateMessage] : previousSnapshot?.messages,
			model: this.agent.state.model,
			thinkingLevel: this.agent.state.thinkingLevel,
		};
	};

	// pi-agent-core 0.85.0 runs the stop hook before queue polling and invokes
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
