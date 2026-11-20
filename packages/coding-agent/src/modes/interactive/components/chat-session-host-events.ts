import type { AgentSession, AgentSessionEvent } from "../../../core/agent-session.js";
import type { CompactionReason } from "../../../core/agent-session-types.js";
import {
	type CompactionForm,
	VERBATIM_COMPACTION_PROMPT_VERSION,
	VERBATIM_COMPACTION_STRATEGY,
	type VerbatimCompactionDetails,
	type VerbatimCompactionResult,
} from "../../../core/compaction/index.ts";
import {
	type CustomMessage,
	createVerbatimCompactionMessage,
	isVerbatimCompactionMessage,
} from "../../../core/messages.ts";
import { queueUpdateDeliveries } from "../../../core/queued-message-delivery.ts";
import { pickWhimsicalWorkingMessage } from "../whimsical-messages.ts";
import { confirmQueuedChatSessionMessages, flushChatSessionCompactionQueue } from "./chat-session-host-actions.ts";
import {
	chatSessionTokenCount,
	chatSessionWorkingMeta,
	restoreChatSessionTokens,
} from "./chat-session-host-rendering.ts";
import {
	afterChatSessionEvent,
	decrementOptimisticUserSignature,
	startChatSessionWorkingLifecycle,
	stopChatSessionWorkingLifecycle,
} from "./chat-session-host-runtime.ts";
import {
	CHAT_SESSION_RETRYING_STATUS,
	CHAT_SESSION_RETRYING_SUMMARY_STATUS,
	CHAT_SESSION_SWITCHING_MODEL_STATUS,
	type ChatSessionHostState,
	countableTranscriptLength,
} from "./chat-session-host-state.ts";
import {
	exactTextOnlyUserPrompt,
	extractMessageText,
	firstRawUserExactText,
	isChatMessageEntry,
	isMessageLike,
	isUserMessageLike,
	syncFirstUserEntry,
	userMessageSignature,
} from "./chat-session-host-utils.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.js";
import { type RetryWait, retryWaitFromEvent } from "./retry-status-line.ts";

export type { CompactionReason } from "../../../core/agent-session-types.js";

/**
 * A retry or a model fallback ended the turn it waited in, cancelled or out of attempts: the turn's worked line counts
 * from its start to now, through every attempt and wait, as it would have counted on through the next attempt.
 */
function endRetriedTurn<TExtraEntry extends ChatTranscriptEntryLike>(state: ChatSessionHostState<TExtraEntry>): void {
	const continued = state.retryContinuesRun;
	state.retryContinuesRun = false;
	const turn = continued ? state.workingRunMeter.endedRunSnapshot() : undefined;
	if (turn === undefined) return;
	const message = state.workedRun?.message ?? state.lastWorkingMessage;
	state.workedRun = { message, snapshot: { ...turn, tokens: chatSessionTokenCount(state) } };
}

/**
 * A retry waits out its backoff: `Retrying · <reason> · attempt 1/3 in 2s`, with what the chat knows of `wait`, is
 * the working line until the next attempt's `agent_start`, or the retry's `auto_retry_end`, clears it.
 */
export function showChatSessionRetryWait<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	wait: RetryWait = {},
): void {
	state.sdkBusy = true;
	state.workingMessage = undefined;
	state.statusMessage = CHAT_SESSION_RETRYING_STATUS;
	state.retryWait = wait;
	stopChatSessionWorkingLifecycle(state);
}

/**
 * A move to a fallback model: `Switching model…` is the working line until the next model's `agent_start`, or the
 * switch's `model_fallback_end`, clears it.
 */
export function showChatSessionModelSwitch<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): void {
	state.sdkBusy = true;
	state.workingMessage = undefined;
	state.statusMessage = CHAT_SESSION_SWITCHING_MODEL_STATUS;
	stopChatSessionWorkingLifecycle(state);
}

export function compactionStatusMessage(reason: CompactionReason): string {
	switch (reason) {
		case "manual":
			return "Compacting context...";
		case "threshold":
			return "Auto-compacting...";
		case "overflow":
			return "Context overflow detected. Auto-compacting...";
		case "branchSummary":
			return "Summarizing branch…";
	}
}

function hasVerbatimCompactionMessage(messages: AgentSession["messages"]): boolean {
	return messages.some((message) => message.role === "custom" && isVerbatimCompactionMessage(message));
}

const COMPACTION_FORMS: ReadonlySet<CompactionForm> = new Set([
	"cleared",
	"compacted",
] as const satisfies readonly CompactionForm[]);

function isCompleteCompactionResult(result: VerbatimCompactionResult): boolean {
	return (
		typeof result.compactedText === "string" &&
		typeof result.tokensBefore === "number" &&
		result.stats !== undefined &&
		result.parameters !== undefined &&
		result.promptVersion === VERBATIM_COMPACTION_PROMPT_VERSION &&
		COMPACTION_FORMS.has(result.form)
	);
}

function boundaryMessageFromResult(
	result: VerbatimCompactionResult,
): CustomMessage<VerbatimCompactionDetails> | undefined {
	if (!isCompleteCompactionResult(result)) return undefined;
	const details = {
		strategy: VERBATIM_COMPACTION_STRATEGY,
		promptVersion: result.promptVersion,
		parameters: result.parameters,
		stats: result.stats,
		form: result.form,
		...(result.backend === undefined ? {} : { backend: result.backend }),
		...(result.model === undefined ? {} : { model: result.model }),
		...(result.fallbackReason === undefined ? {} : { fallbackReason: result.fallbackReason }),
		...(result.history === undefined ? {} : { history: result.history }),
		...(result.backupPath === undefined ? {} : { backupPath: result.backupPath }),
	} satisfies VerbatimCompactionDetails;
	return createVerbatimCompactionMessage(
		result.compactedText,
		result.tokensBefore,
		new Date().toISOString(),
		details,
	) as CustomMessage<VerbatimCompactionDetails>;
}

function customMessageText(message: CustomMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function transcriptHasBoundaryForResult(
	transcript: readonly ChatTranscriptEntryLike[],
	result: VerbatimCompactionResult,
): boolean {
	return transcript.some((entry) => {
		const candidate = entry as ChatTranscriptEntryLike & {
			readonly kind?: string;
			readonly message?: CustomMessage<VerbatimCompactionDetails>;
		};
		if (
			candidate.kind !== "custom" ||
			candidate.message?.role !== "custom" ||
			!isVerbatimCompactionMessage(candidate.message)
		) {
			return false;
		}
		if (candidate.message?.details?.form !== result.form) return false;
		return customMessageText(candidate.message).endsWith(result.compactedText);
	});
}

function refreshCompactedTranscript<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	result: VerbatimCompactionResult,
): void {
	const session = state.getAgentSession?.();
	const manager = session?.sessionManager;
	// The session's transcript keeps rows a context edit left out of the next request. A session or session manager
	// that cannot give one shows its messages.
	const compactedMessages =
		session?.transcriptMessages ??
		(typeof manager?.buildSessionProjection === "function"
			? manager.buildSessionProjection("transcript").messages
			: session?.messages);
	// A session in another process sent its compacted messages as plain data, so its boundary is
	// recognised by its custom type rather than by identity.
	const remoteMessages = session === undefined ? state.getSessionMessages?.() : undefined;
	const messages =
		compactedMessages && hasVerbatimCompactionMessage(compactedMessages)
			? compactedMessages
			: remoteMessages?.some((message) => message.role === "custom" && message.customType === "compaction")
				? remoteMessages
				: undefined;
	if (messages) {
		if (state.bodyViewport.getScrollFromBottom() > 0) {
			state.newMessages.observe(false, countableTranscriptLength(state));
		}
		const firstUser = firstRawUserExactText(messages);
		state.seenFirstRawUser = firstUser.seenUser;
		state.firstUserEntryExactText = firstUser.exactText;
		state.replaceTranscriptWindow(messages);
		syncFirstUserEntry(state);
		const meter = state.getSessionContextMeter?.(messages);
		if (meter) restoreChatSessionTokens(state, meter);
		state.newMessages.compactionRefreshed(countableTranscriptLength(state));
		return;
	}
	if (transcriptHasBoundaryForResult(state.transcript, result)) return;
	const boundary = boundaryMessageFromResult(result);
	if (boundary) state.liveChat.appendMessages([boundary]);
}

export function applyChatSessionAgentEvent<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	event: AgentSessionEvent,
): boolean {
	if (state.disposed) return false;
	const type = String((event as { type?: unknown }).type ?? "");
	if (type === "message_start") {
		const message = (event as { message?: unknown }).message;
		if (isUserMessageLike(message)) {
			state.userMessagesShown++;
			if (!state.seenFirstRawUser) {
				state.seenFirstRawUser = true;
				state.firstUserEntryExactText = exactTextOnlyUserPrompt(message);
			}
			const signature = userMessageSignature(extractMessageText(message.content));
			const count = state.optimisticUserSignatureCounts.get(signature) ?? 0;
			if (count > 0) {
				decrementOptimisticUserSignature(state, signature);
				return false;
			}
		}
	}
	if (type === "message_end") {
		const message = (event as { message?: unknown }).message;
		if (typeof message === "object" && message !== null && "role" in message) {
			state.workingRunMeter.settled(message as { role: string });
		}
	}
	if (isSharedLiveChatEvent(type)) {
		const changed = state.liveChat.applyEvent(event);
		if (type === "message_start" && state.firstUserEntry === undefined && state.seenFirstRawUser) {
			syncFirstUserEntry(state);
		}
		if (type === "message_update") {
			const hasDelta = (event as { assistantMessageEvent?: unknown }).assistantMessageEvent !== undefined;
			meterStreamingAssistant(state, (event as { message?: unknown }).message, !hasDelta);
		}
		const toolCallEvent = assistantToolCallEvent(event);
		const changedByToolCall = toolCallEvent !== undefined ? state.liveChat.applyEvent(toolCallEvent) : false;
		afterChatSessionEvent(state, changed || changedByToolCall);
		return changed || changedByToolCall;
	}
	let changed = false;
	switch (type) {
		case "agent_start": {
			// The attempt after a retry's wait or a model fallback continues its turn, and its time and tokens with it.
			const { turnStartedAt } = event as Extract<AgentSessionEvent, { type: "agent_start" }>;
			if (state.retryContinuesRun) state.workingRunMeter.continueRun(turnStartedAt);
			else state.workingRunMeter.start(turnStartedAt);
			state.retryContinuesRun = false;
			state.sdkBusy = true;
			state.workingMessage = undefined;
			state.lastWorkingMessage = undefined;
			state.interruptedTurnSnapshot = undefined;
			startChatSessionWorkingLifecycle(state);
			state.liveChat.clearPendingTools();
			state.statusMessage = "";
			changed = true;
			state.compactionPromptStarted?.();
			break;
		}
		case "agent_end": {
			const manualTakeoverPending = state.manualCompactionTakeoverPending;
			const interrupted = state.interruptedTurnSnapshot;
			if (interrupted?.startedAt !== undefined && state.workingRunMeter.snapshot() === undefined) {
				state.workingRunMeter.resume(interrupted.startedAt, interrupted.settledTokens, false);
				if (state.lastWorkingMessage === undefined) {
					state.lastWorkingMessage = interrupted.lastWorkingMessage;
				}
			}
			const snapshot = chatSessionWorkingMeta(state);
			if (snapshot !== undefined && !manualTakeoverPending) {
				state.workedRun = { message: state.lastWorkingMessage, snapshot };
			} else if (interrupted?.workedRun !== undefined && !manualTakeoverPending) {
				state.workedRun = interrupted.workedRun;
			}
			if (interrupted !== undefined) {
				state.interruptedTurnSnapshot = {
					...interrupted,
					startedAt: undefined,
					workedRun: state.workedRun ?? interrupted.workedRun,
				};
			}
			state.workingRunMeter.stop();
			state.sdkBusy = manualTakeoverPending;
			state.compacting = manualTakeoverPending;
			if (!manualTakeoverPending) state.compactionStartedAt = undefined;
			state.workingMessage = undefined;
			state.liveChat.clearPendingTools();
			if (!manualTakeoverPending) state.statusMessage = "";
			stopChatSessionWorkingLifecycle(state);
			changed = true;
			if (!manualTakeoverPending && state.compactionQueuedMessages.length > 0) {
				const idle = state.getAgentSession?.()?.agent.waitForIdle() ?? Promise.resolve();
				void idle.then(() => flushChatSessionCompactionQueue(state));
			}
			break;
		}
		case "turn_start":
			startChatSessionWorkingLifecycle(state);
			state.workingRunMeter.requestStarted();
			state.workingMessage = pickWhimsicalWorkingMessage();
			state.lastWorkingMessage = state.workingMessage;
			changed = true;
			break;
		case "turn_end":
			state.compacting = state.manualCompactionTakeoverPending;
			if (!state.manualCompactionTakeoverPending) state.compactionStartedAt = undefined;
			state.workingMessage = undefined;
			stopChatSessionWorkingLifecycle(state);
			changed = true;
			break;
		case "queue_update": {
			const queue = event as { steering?: unknown; followUp?: unknown };
			const steering = Array.isArray(queue.steering)
				? queue.steering.filter((item): item is string => typeof item === "string")
				: [];
			const followUp = Array.isArray(queue.followUp)
				? queue.followUp.filter((item): item is string => typeof item === "string")
				: [];
			confirmQueuedChatSessionMessages(state, steering, followUp);
			// Messages the turn took whose own row is not here yet stay listed until it is.
			state.deliveringQueuedMessages = queueUpdateDeliveries(event);
			state.pendingSteeringMessages = steering;
			state.pendingFollowUpMessages = followUp;
			changed = true;
			break;
		}
		case "tool_call":
		case "tool_use":
			changed = state.liveChat.applyEvent(legacyToolStartEvent(event));
			break;
		case "tool_result":
			changed = state.liveChat.applyEvent(legacyToolResultEvent(event));
			break;
		case "thinking_delta":
		case "thinking":
			changed = state.liveChat.applyEvent(legacyThinkingEvent(event));
			if (changed) meterStreamingAssistant(state);
			break;
		case "compaction_start": {
			const compaction = event as Extract<AgentSessionEvent, { type: "compaction_start" }>;
			state.compacting = true;
			state.compactionStartedAt =
				state.getAgentSession?.()?.compactionStartedAt ??
				state.getChatBoxSession?.()?.compactionStartedAt ??
				Date.now();
			state.sdkBusy = true;
			state.statusMessage = compactionStatusMessage(compaction.reason);
			changed = true;
			break;
		}
		case "compaction_end": {
			const compaction = event as Extract<AgentSessionEvent, { type: "compaction_end" }>;
			const manualTakeoverPending =
				compaction.reason !== "manual" &&
				(compaction.manualTakeoverPending === true || state.manualCompactionTakeoverPending);
			if (manualTakeoverPending) {
				state.manualCompactionTakeoverPending = true;
			} else if (compaction.reason === "manual") {
				state.manualCompactionTakeoverPending = false;
			}
			state.compacting = manualTakeoverPending;
			state.compactionStartedAt = manualTakeoverPending
				? (state.compactionStartedAt ??
					state.getAgentSession?.()?.compactionStartedAt ??
					state.getChatBoxSession?.()?.compactionStartedAt ??
					Date.now())
				: undefined;
			state.sdkBusy = manualTakeoverPending || compaction.midTurn === true;
			if (!manualTakeoverPending) state.statusMessage = compaction.errorMessage ?? "";
			if (compaction.midTurn !== true || compaction.aborted || compaction.errorMessage) {
				state.workingMessage = undefined;
				stopChatSessionWorkingLifecycle(state);
			} else if (!state.workingLifecycleActive) {
				// A successful no-op ends before the next turn_start, so nothing else
				// would restart ordinary Working for the continuing stream.
				startChatSessionWorkingLifecycle(state);
			}
			// `result` and `errorMessage` are independent facts. The post-tool gate can
			// report a hard-input-limit failure *after* the boundary was already
			// committed, and skipping the refresh there hid a durable context
			// destruction behind an error line. Show the boundary, then the status.
			if (!compaction.aborted && compaction.result) {
				refreshCompactedTranscript(state, compaction.result);
			}
			if (!manualTakeoverPending && state.compactionQueuedMessages.length > 0) {
				void flushChatSessionCompactionQueue(state);
			}
			changed = true;
			break;
		}
		case "summarization_retry_scheduled":
			state.sdkBusy = true;
			state.statusMessage = CHAT_SESSION_RETRYING_SUMMARY_STATUS;
			state.retryWait = retryWaitFromEvent(
				event as Extract<AgentSessionEvent, { type: "summarization_retry_scheduled" }>,
				"summary",
			);
			changed = true;
			break;
		case "summarization_retry_attempt_start": {
			const retry = event as Extract<AgentSessionEvent, { type: "summarization_retry_attempt_start" }>;
			state.sdkBusy = true;
			state.statusMessage = compactionStatusMessage(
				retry.source === "branchSummary" ? "branchSummary" : retry.reason,
			);
			changed = true;
			break;
		}
		case "summarization_retry_finished":
			state.statusMessage = state.compacting ? compactionStatusMessage("manual") : "";
			changed = true;
			break;
		case "auto_retry_start":
			showChatSessionRetryWait(
				state,
				retryWaitFromEvent(event as Extract<AgentSessionEvent, { type: "auto_retry_start" }>),
			);
			state.retryContinuesRun = true;
			changed = true;
			break;
		case "model_fallback_start":
			// A fallback after a failed answer continues that turn; one before a turn's first request starts it.
			state.retryContinuesRun = state.retryContinuesRun || state.workingRunMeter.endedOnFailedAttempt();
			showChatSessionModelSwitch(state);
			changed = true;
			break;
		case "model_fallback_end": {
			const fallback = event as Extract<AgentSessionEvent, { type: "model_fallback_end" }>;
			// A fallback that ended without an error to report (the turn was stopped) leaves no notice.
			state.statusMessage = fallback.success ? "" : (fallback.finalError ?? "");
			state.workingMessage = undefined;
			if (!fallback.success) {
				endRetriedTurn(state);
				state.workingRunMeter.stop();
				state.workingRunMeter.endTurn();
				state.sdkBusy = false;
				state.compacting = false;
				state.compactionStartedAt = undefined;
			}
			stopChatSessionWorkingLifecycle(state);
			changed = true;
			break;
		}
		case "auto_retry_end": {
			const retry = event as Extract<AgentSessionEvent, { type: "auto_retry_end" }>;
			state.statusMessage = "";
			state.workingMessage = undefined;
			if (!retry.success) {
				endRetriedTurn(state);
				state.workingRunMeter.stop();
				state.workingRunMeter.endTurn();
				state.sdkBusy = false;
				state.compacting = false;
				state.compactionStartedAt = undefined;
			}
			stopChatSessionWorkingLifecycle(state);
			changed = true;
			break;
		}
		case "agent_continue_error": {
			const continueError = event as Extract<AgentSessionEvent, { type: "agent_continue_error" }>;
			state.workingRunMeter.stop();
			state.sdkBusy = false;
			state.compacting = false;
			state.compactionStartedAt = undefined;
			state.statusMessage = continueError.errorMessage;
			state.workingMessage = undefined;
			stopChatSessionWorkingLifecycle(state);
			changed = true;
			break;
		}
		default:
			changed = false;
	}
	afterChatSessionEvent(state, changed);
	return changed;
}

function meterStreamingAssistant<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	rawMessage?: unknown,
	preferRaw = false,
): void {
	if (!preferRaw) {
		for (let index = state.transcript.length - 1; index >= 0; index -= 1) {
			const entry = state.transcript[index]!;
			if (
				isChatMessageEntry(entry) &&
				entry.kind === "assistant" &&
				state.liveChat.isStreamingAssistantEntry(entry)
			) {
				state.workingRunMeter.streaming(entry.message);
				return;
			}
		}
	}
	if (typeof rawMessage === "object" && rawMessage !== null && "role" in rawMessage) {
		state.workingRunMeter.streaming(rawMessage as { role: string });
	}
}

function isSharedLiveChatEvent(type: string): boolean {
	return (
		type === "message_start" ||
		type === "message_update" ||
		type === "message_end" ||
		type === "tool_execution_start" ||
		type === "tool_execution_update" ||
		type === "tool_execution_end"
	);
}

function assistantToolCallEvent(event: AgentSessionEvent):
	| {
			type: "tool_call_args";
			toolCallId: string;
			toolName: string;
			args: unknown;
	  }
	| undefined {
	const assistantEvent = (
		event as {
			assistantMessageEvent?: {
				type?: unknown;
				contentIndex?: unknown;
				partial?: unknown;
				toolCall?: unknown;
			};
		}
	).assistantMessageEvent;
	const streamType = String(assistantEvent?.type ?? "");
	if (!streamType.startsWith("toolcall_")) return undefined;
	const explicit = toolCallPayload(assistantEvent?.toolCall);
	if (explicit) return explicit;
	const contentIndex = typeof assistantEvent?.contentIndex === "number" ? assistantEvent.contentIndex : undefined;
	if (contentIndex === undefined) return undefined;
	const partial = assistantEvent?.partial;
	if (!isMessageLike(partial) || partial.role !== "assistant") return undefined;
	const content = partial.content;
	if (!Array.isArray(content)) return undefined;
	return toolCallPayload(content[contentIndex]);
}

function toolCallPayload(value: unknown):
	| {
			type: "tool_call_args";
			toolCallId: string;
			toolName: string;
			args: unknown;
	  }
	| undefined {
	if (value === null || typeof value !== "object") return undefined;
	const candidate = value as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
	if (candidate.type !== "toolCall") return undefined;
	if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return undefined;
	return {
		type: "tool_call_args",
		toolCallId: candidate.id,
		toolName: candidate.name,
		args: candidate.arguments ?? {},
	};
}

function legacyToolStartEvent(event: AgentSessionEvent): {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: unknown;
} {
	const payload = event as { toolCallId?: unknown; name?: unknown; input?: unknown; args?: unknown };
	const toolName = typeof payload.name === "string" ? payload.name : "tool";
	const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : `live-${toolName}`;
	return {
		type: "tool_execution_start",
		toolCallId,
		toolName,
		args: payload.input ?? payload.args ?? {},
	};
}

function legacyToolResultEvent(event: AgentSessionEvent): {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
} {
	const payload = event as {
		toolCallId?: unknown;
		name?: unknown;
		output?: unknown;
		isError?: unknown;
	};
	const toolName = typeof payload.name === "string" ? payload.name : "tool";
	const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : `live-${toolName}`;
	const output = payload.output;
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName,
		result:
			output !== null && typeof output === "object" && "content" in output
				? output
				: { content: typeof output === "string" ? [{ type: "text", text: output }] : [] },
		isError: payload.isError === true,
	};
}

function legacyThinkingEvent(event: AgentSessionEvent): {
	type: "message_update";
	assistantMessageEvent: { type: "thinking_delta"; contentIndex: number; delta: string };
} {
	const delta = String((event as { delta?: unknown }).delta ?? (event as { text?: unknown }).text ?? "");
	return {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta },
	};
}
