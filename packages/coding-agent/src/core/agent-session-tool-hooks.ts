import { getCurrentSystemMessage, type SystemMessage } from "@bastani/pi-ai";
import type { ToolCall } from "@bastani/pi-ai/compat";
import type {
	AfterToolCallResult,
	AgentLoopTurnUpdate,
	AgentToolResult,
	PrepareNextTurnContext,
} from "@earendil-works/pi-agent-core";
import { normalizeToolResultImages } from "../utils/tool-result-images.js";
import { committedContextMessages } from "./agent-session-background-compaction.ts";
import { isDetachedToolCall } from "./agent-session-detached-tools.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { getParentToolCallId } from "./agent-session-nested-tools.js";
import { rethrowUnlessReportedPersistenceFailure } from "./agent-session-persistence-failures.ts";
import { estimateContextTokens } from "./compaction/compaction.ts";
import { assertToolPairingInvariant } from "./context-tool-pairing.js";
import { sessionBlobOutput } from "./session-tool-output.ts";
import { projectToolLoadout } from "./tool-loadout.js";
import { redirectOversizedToolResult } from "./tools/oversized-tool-result.js";
import { workspaceSandboxDenial } from "./workspace/session.ts";

export function _installAgentToolHooks(this: AgentSession): void {
	this.agent.beforeToolCall = async ({ assistantMessage, toolCall, args }) => {
		const runner = this._extensionRunner;
		// #4226: a tool call never runs before its assistant message is saved, or once a save of the run failed.
		// Only that message's own processing is awaited: listeners of later events such as tool_execution_start
		// may wait for this tool to start.
		await this._messagesAwaitingPersistence.get(assistantMessage)?.catch(() => {});
		if (this._persistenceFailure !== undefined) return { block: true, reason: this._persistenceFailure };
		const sandboxDenial = workspaceSandboxDenial(this._workspace, toolCall.name);
		if (sandboxDenial !== undefined) return { block: true, reason: sandboxDenial.message };
		if (!runner.hasHandlers("tool_call")) {
			return undefined;
		}

		await this._agentEventQueue.catch(rethrowUnlessReportedPersistenceFailure);
		if (this._persistenceFailure !== undefined) return { block: true, reason: this._persistenceFailure };

		try {
			const result = await runner.emitToolCall({
				type: "tool_call",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				parentToolCallId: getParentToolCallId(),
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
		// A detached call's placeholder is no result: resumeDetachedTurn finalizes its real result when it arrives.
		if (isDetachedToolCall(this, toolCall.id)) return undefined;
		const parentToolCallId = getParentToolCallId();
		const replacement = await finalizeToolResult(this, { toolCall, args, result, isError, parentToolCallId });
		if (parentToolCallId) return replacement;
		if (result.terminate === true) this._terminatingToolCallIds.add(toolCall.id);
		else this._terminatingToolCallIds.delete(toolCall.id);
		return replacement;
	};
}

/** A finished tool call's result as its tool reported it, before the session finalizes it for history. */
export interface ToolResultToFinalize {
	readonly toolCall: Pick<ToolCall, "id" | "name">;
	readonly args: unknown;
	readonly result: AgentToolResult<unknown>;
	readonly isError: boolean;
	/** The tool call this one is nested in, when a tool called it; its output then stays uncapped. */
	readonly parentToolCallId: string | undefined;
	/** The result arrived after the stage was released, so its spill is kept as a blob of the session when it can be. */
	readonly releasedStage?: boolean;
}

/**
 * What a tool result becomes before it enters history, whether its call ran inline or detached: extension
 * `tool_result` handlers, image normalization, then the oversized-output spill. Returns the replacement for the
 * result, or `undefined` when it enters history as reported.
 */
export async function finalizeToolResult(
	session: AgentSession,
	{ toolCall, args, result, isError, parentToolCallId, releasedStage }: ToolResultToFinalize,
): Promise<AfterToolCallResult | undefined> {
	const runner = session._extensionRunner;
	const hookResult = runner.hasHandlers("tool_result")
		? await runner.emitToolResult(
				{
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					parentToolCallId,
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					structuredContent: result.structuredContent,
					usage: result.usage,
					isError,
				},
				true,
			)
		: undefined;

	const hookContent = hookResult?.content ?? result.content;
	// Run after extension hooks so extension-injected images enter history at provider-safe sizes.
	const resizeOptions = session.model?.inputLimits?.images?.resize;
	const normalizedContent = await normalizeToolResultImages(hookContent, {
		autoResizeImages: session.settingsManager.getImageAutoResize(),
		...(resizeOptions ? { resizeOptions } : {}),
	});
	const resultReplacement =
		hookResult || normalizedContent !== hookContent
			? {
					content: normalizedContent,
					details: hookResult?.details,
					isError: hookResult?.isError ?? isError,
					structuredContent: hookResult ? hookResult.structuredContent : result.structuredContent,
					usage: hookResult?.usage ?? result.usage,
				}
			: undefined;
	const finalResult = {
		content: normalizedContent,
		// Preserve original details when an extension hook rewrites only content;
		// the redirect check only replaces model-visible content blocks.
		details: hookResult?.details ?? result.details,
		structuredContent: hookResult ? hookResult.structuredContent : result.structuredContent,
		usage: hookResult?.usage ?? result.usage,
	};
	const finalIsError = hookResult?.isError ?? isError;
	// Nested output is script-visible, not model-visible. The orchestrating tool applies its final output cap.
	if (parentToolCallId) return resultReplacement;
	const redirectReplacement = await redirectOversizedToolResult({
		toolName: toolCall.name,
		toolCallId: toolCall.id,
		result: finalResult,
		isError: finalIsError,
		sessionId: session.sessionManager.getSessionId(),
		sessionDir: session.sessionManager.getSessionDir() || undefined,
		persist: releasedStage === true ? sessionBlobOutput(session.sessionManager, toolCall.id) : undefined,
		maxResultSizeChars: session.getToolDefinition(toolCall.name)?.maxResultSizeChars,
	});
	return redirectReplacement
		? { ...redirectReplacement, structuredContent: finalResult.structuredContent, usage: finalResult.usage }
		: resultReplacement;
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
		// A turn waiting on a detached call ends the run: nothing may continue past a call that has no result yet.
		const detachedTurn = toolCallIds.some((id) => isDetachedToolCall(this, id));

		const previousDecision = (await previousFinishTurn?.(turn, signal)) ?? undefined;
		this._stopAfterTurnBlockedContinuation = previousDecision?.action === "end" || detachedTurn;
		await settleFallbackAfterTurn(this, turn, terminatingBatch || detachedTurn);
		if (this._subagentMessageAdmission) await this._subagentMessageAdmission.waitForPendingDeliveries();
		return detachedTurn ? { action: "end" } : previousDecision;
	};

	const previousTransformContext = this.agent.transformContext;
	this.agent.transformContext = async (messages, signal) => {
		const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
		const guarded = this._finishPostToolCompactionPreflight(transformed);
		// Last checkpoint before provider conversion: a structurally invalid context
		// here becomes an unrecoverable provider 400, so surface it as an Atomic error.
		assertToolPairingInvariant(guarded);
		const forced = this._runSystemPromptOptions?.forceSystemPrompt ?? this._baseSystemPromptOptions.forceSystemPrompt;
		if (forced === undefined) return projectToolLoadout(this, guarded);
		const current = getCurrentSystemMessage(guarded);
		const head: SystemMessage = {
			role: "system",
			content: forced,
			...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
			timestamp: current?.timestamp ?? Date.now(),
		};
		return projectToolLoadout(this, [head, ...guarded.filter((message) => message.role !== "system")]);
	};

	const prepareTurn = async (turn: PrepareNextTurnContext, signal?: AbortSignal): Promise<AgentLoopTurnUpdate> => {
		const committed = await this._runBackgroundCompactionBoundary(true, true);
		const boundaryMessages = committed ? committedContextMessages(this) : turn.context.messages;
		const compactedMessages =
			turn.toolResults.length > 0
				? await this._preflightPostToolContext(boundaryMessages, signal)
				: boundaryMessages;
		this._maybeStartBackgroundCompaction(estimateContextTokens(compactedMessages).tokens);
		const compactedContext =
			compactedMessages === turn.context.messages ? turn.context : { ...turn.context, messages: compactedMessages };
		const preparedTurn = compactedContext === turn.context ? turn : { ...turn, context: compactedContext };
		const previousSnapshot = await previousPrepareNextTurnWithContext?.(preparedTurn, signal);
		// A caller-supplied replacement is the complete context for the next request; the
		// canonical projection must not overwrite it at the request boundary.
		this._callerReplacedNextRequestContext = previousSnapshot?.context !== undefined;
		const previousContext = previousSnapshot?.context ?? compactedContext;
		const options = this._currentRunSystemPromptOptions();
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
		// A message that could not be saved was already reported where its append failed (#4226);
		// any other listener failure still fails the turn.
		await session._agentEventQueue.catch(rethrowUnlessReportedPersistenceFailure);
		await session._settleFallbackModelScope();
	}
}

export const agentSessionToolHooksMethods = {
	_installAgentToolHooks,
	_installAgentNextTurnRefresh,
};
