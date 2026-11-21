import type { AgentSessionQueuePauseControl } from "../../../core/agent-session-methods.ts";
import type { BashExecutionMessage } from "../../../core/messages.ts";
import { combineQueuedMessagesForEditor } from "../chat-input-actions.ts";
import { classifyChatCommand } from "../skill-command-autocomplete.ts";
import type { SteeringQueueController } from "../steering-queue-controller.ts";
import type { ChatMessageEntry } from "./chat-message-renderer.ts";
import { recordChatSessionPrompt, setChatSessionEditorText } from "./chat-session-host-editor.ts";
import {
	decrementOptimisticUserSignature,
	incrementOptimisticUserSignature,
	isChatSessionBashRunning,
	isChatSessionStreaming,
	notifyChatSessionStatus,
	notifyChatSessionWarning,
	requiredChatSessionCommand,
	requiredChatSessionPromptCommand,
	settleChatSessionPromptLifecycle,
	startChatSessionWorkingLifecycle,
	stopChatSessionWorkingLifecycle,
	syncChatSessionAnimationTick,
} from "./chat-session-host-runtime.ts";
import { CHAT_SESSION_RESUMING_STATUS, type ChatSessionHostState } from "./chat-session-host-state.ts";
import type { ChatSessionSubmitMode } from "./chat-session-host-types.ts";
import { errorMessage, parseBashInput, userMessageSignature } from "./chat-session-host-utils.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.js";

function supportsQueuedMessagePause(
	session: AgentSessionQueuePauseControl | undefined,
): session is AgentSessionQueuePauseControl {
	return typeof session?.pauseQueuedMessages === "function" && typeof session.resumeQueuedMessages === "function";
}

export function interruptChatSession<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	options?: { restoreQueuedMessages?: boolean },
): Promise<void> {
	const active = state.interruptSettlement;
	if (active !== undefined) return active;
	state.interruptFailureMessage = undefined;
	const settlement = (async (): Promise<void> => {
		try {
			const session = state.getAgentSession?.();
			if (supportsQueuedMessagePause(session)) session.pauseQueuedMessages();
			if (options?.restoreQueuedMessages) {
				restoreQueuedMessagesToEditor(state, {
					suppressEmptyNotice: true,
					preserveUnprotectedCustomMessages: true,
				});
			}
			state.sdkBusy = false;
			state.workingMessage = undefined;
			state.workingRunMeter.stop();
			stopChatSessionWorkingLifecycle(state);
			await state.commands.interrupt?.();
		} catch (err) {
			state.interruptFailureMessage = errorMessage(err);
			state.statusMessage = state.interruptFailureMessage;
			throw err;
		} finally {
			syncChatSessionAnimationTick(state);
			state.requestRender?.();
		}
	})();
	state.interruptSettlement = settlement;
	void settlement
		.finally(() => {
			if (state.interruptSettlement === settlement) state.interruptSettlement = undefined;
		})
		.catch(() => {});
	return settlement;
}

async function submitAfterInterruptSettlement<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	settlement: Promise<void>,
	text: string,
	mode: ChatSessionSubmitMode,
): Promise<void> {
	const editorText = state.inputBuffer;
	recordChatSessionPrompt(state, text);
	try {
		state.sdkBusy = true;
		state.statusMessage = CHAT_SESSION_RESUMING_STATUS;
		syncChatSessionAnimationTick(state);
		state.requestRender?.();
		await settlement;
		await requiredChatSessionCommand(state, "resume")(text, mode);
		if (state.inputBuffer === editorText) setChatSessionEditorText(state, "");
		state.sdkBusy = false;
		if (state.statusMessage === CHAT_SESSION_RESUMING_STATUS) state.statusMessage = "";
	} catch (err) {
		state.sdkBusy = false;
		state.statusMessage = errorMessage(err);
		state.interruptFailureMessage = undefined;
	} finally {
		syncChatSessionAnimationTick(state);
		state.requestRender?.();
	}
}

export async function submitChatSession<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	mode: ChatSessionSubmitMode = "auto",
	submittedText?: string,
): Promise<void> {
	if (state.disposed) return;
	const text = (submittedText ?? state.inputBuffer).trim();
	if (!text) return;
	state.noticeMessage = "";
	state.lastWarningMessage = undefined;
	// Task inspection is local even while Escape is settling. It must never release
	// the pause or fall through to model delivery; other slash commands keep their order.
	if (classifyChatCommand(text) === "tasks") {
		try {
			if (!(await state.commands.handleSlashCommand?.(text))) {
				notifyChatSessionWarning(state, "Task inspection is unavailable in this host.");
			}
			setChatSessionEditorText(state, "");
		} catch (err) {
			notifyChatSessionWarning(state, errorMessage(err));
		} finally {
			state.requestRender?.();
		}
		return;
	}
	const steering = state.steeringController;
	if (steering !== undefined) {
		await submitSteeredChatSession(state, steering, text, mode);
		return;
	}
	const send = state.commands.send;
	if (send !== undefined) {
		await sendChatSessionText(state, send, text, mode);
		return;
	}
	const interruptSettlement = state.interruptSettlement;
	if (interruptSettlement !== undefined) {
		await submitAfterInterruptSettlement(state, interruptSettlement, text, mode);
		return;
	}
	if (state.interruptFailureMessage !== undefined) {
		state.statusMessage = state.interruptFailureMessage;
		state.interruptFailureMessage = undefined;
		syncChatSessionAnimationTick(state);
		state.requestRender?.();
		return;
	}
	if (text.startsWith("/") && state.commands.handleSlashCommand) {
		const handled = await state.commands.handleSlashCommand(text);
		if (handled) {
			setChatSessionEditorText(state, "");
			state.requestRender?.();
			return;
		}
	}
	recordChatSessionPrompt(state, text);
	if (state.compacting) {
		setChatSessionEditorText(state, "");
		state.compactionQueuedMessages = [...state.compactionQueuedMessages, { text, mode }];
		notifyChatSessionStatus(state, "Queued message until compaction completes");
		return;
	}
	const bash = parseBashInput(text);
	if (bash?.command) {
		if (isChatSessionBashRunning(state)) {
			notifyChatSessionWarning(state, "A bash command is already running. esc cancel first.");
			setChatSessionEditorText(state, text);
			return;
		}
		setChatSessionEditorText(state, "");
		await runChatSessionBashCommand(state, bash.command, bash.excludeFromContext);
		return;
	}
	setChatSessionEditorText(state, "");
	const isPaused = state.isPaused?.() === true;
	const agentSession = state.getAgentSession?.();
	const nativeQueuePaused = supportsQueuedMessagePause(agentSession) && agentSession.queuedMessagesPaused;
	const heldBehindCompactionQueue = state.compactionFlushPending || state.compactionQueuedMessages.length > 0;
	if (heldBehindCompactionQueue && !isPaused && !nativeQueuePaused) {
		state.compactionQueuedMessages = [...state.compactionQueuedMessages, { text, mode }];
		state.requestRender?.();
		if (!state.compactionFlushPending) await flushChatSessionCompactionQueue(state);
		return;
	}
	// Resuming a pause sends one message. Send the oldest held one; the rest, then this
	// submission, follow in order when that turn ends.
	const resumeHeld = heldBehindCompactionQueue && !state.compactionFlushPending;
	if (resumeHeld) state.compactionQueuedMessages = [...state.compactionQueuedMessages, { text, mode }];
	const submission = resumeHeld ? takeNextCompactionMessage(state) : undefined;
	const submitText = submission?.text ?? text;
	const submitMode = submission?.mode ?? mode;
	let submissionStarted = false;
	if (submission) {
		state.compactionPromptStarted = () => {
			submissionStarted = true;
		};
	}
	const isStreaming = isChatSessionStreaming(state);
	// The session publishes the expanded skill block; a raw optimistic signature cannot reconcile with it.
	const shouldAppendOptimisticUser =
		submitMode === "auto" && !isStreaming && classifyChatCommand(submitText) !== "skill";
	const optimisticSignature = shouldAppendOptimisticUser ? userMessageSignature(submitText) : undefined;
	if (optimisticSignature !== undefined) {
		state.liveChat.appendUserText(submitText);
		state.bodyViewport.scrollToBottom();
		incrementOptimisticUserSignature(state, optimisticSignature);
	}
	state.requestRender?.();
	let submittedPromptLifecycleGeneration: number | undefined;
	try {
		if (isPaused) {
			state.sdkBusy = true;
			state.statusMessage = CHAT_SESSION_RESUMING_STATUS;
			syncChatSessionAnimationTick(state);
			state.requestRender?.();
			await requiredChatSessionCommand(state, "resume")(submitText, submitMode);
			state.sdkBusy = false;
			if (state.statusMessage === CHAT_SESSION_RESUMING_STATUS) state.statusMessage = "";
			syncChatSessionAnimationTick(state);
			return;
		}
		if (nativeQueuePaused) {
			state.sdkBusy = true;
			state.statusMessage = CHAT_SESSION_RESUMING_STATUS;
			syncChatSessionAnimationTick(state);
			state.requestRender?.();
			await agentSession.resumeQueuedMessages();
			await state.commands.ensureAttached?.();
			await requiredChatSessionPromptCommand(state)(submitText, submitMode);
			state.sdkBusy = false;
			if (state.statusMessage === CHAT_SESSION_RESUMING_STATUS) state.statusMessage = "";
			syncChatSessionAnimationTick(state);
			return;
		}
		if (isStreaming) {
			await queueChatSessionMessage(
				state,
				submitText,
				submitMode === "followUp" ? "followUp" : "steer",
				!submission,
			);
		} else {
			state.workingRunMeter.stop();
			state.statusMessage = "";
			state.sdkBusy = true;
			startChatSessionWorkingLifecycle(state);
			submittedPromptLifecycleGeneration = state.workingLifecycleGeneration;
			syncChatSessionAnimationTick(state);
			state.requestRender?.();
			await state.commands.ensureAttached?.();
			await requiredChatSessionPromptCommand(state)(submitText, submitMode);
			settleSubmittedPromptLifecycle(state, submittedPromptLifecycleGeneration);
			syncChatSessionAnimationTick(state);
			state.requestRender?.();
		}
	} catch (err) {
		if (optimisticSignature !== undefined) {
			decrementOptimisticUserSignature(state, optimisticSignature);
		}
		if (submission && !submissionStarted) {
			state.compactionQueuedMessages = [submission, ...state.compactionQueuedMessages];
		}
		if (isStreaming && !isPaused && !nativeQueuePaused) {
			// Queuing failed, not the turn the message was meant for.
			state.noticeMessage = errorMessage(err);
		} else {
			settleSubmittedPromptLifecycle(state, submittedPromptLifecycleGeneration);
			state.statusMessage = errorMessage(err);
		}
		syncChatSessionAnimationTick(state);
		state.requestRender?.();
	} finally {
		if (submission) state.compactionPromptStarted = undefined;
	}
}

const settleSubmittedPromptLifecycle = settleChatSessionPromptLifecycle;

export async function abortChatSessionCompaction<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): Promise<void> {
	try {
		if (state.commands.abortCompaction === undefined) {
			// A host without an abort command also has no engine completion to clear
			// this local indicator.
			state.compacting = false;
			state.compactionStartedAt = undefined;
			state.sdkBusy = false;
		} else {
			await state.commands.abortCompaction();
			// Keep new input behind prompts already queued for this compaction. The
			// matching compaction_end event owns the release and the state reset.
		}
		notifyChatSessionStatus(state, "Compaction cancelled");
	} catch (err) {
		notifyChatSessionWarning(state, errorMessage(err));
	} finally {
		syncChatSessionAnimationTick(state);
		state.requestRender?.();
	}
}

export async function abortChatSessionBash<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): Promise<void> {
	try {
		await state.commands.abortBash?.();
		state.localBashRunning = false;
		notifyChatSessionStatus(state, "Bash command cancelled");
	} catch (err) {
		notifyChatSessionWarning(state, errorMessage(err));
	} finally {
		state.requestRender?.();
	}
}

type CompactionQueuedMessage = ChatSessionHostState<never>["compactionQueuedMessages"][number];

/**
 * Send compaction-queued messages one at a time from the front of the queue. Input submitted
 * meanwhile joins the back, so a failed message returns to the front ahead of everything after it.
 */
export async function flushChatSessionCompactionQueue<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): Promise<void> {
	if (state.compactionFlushPending || state.compactionQueuedMessages.length === 0) return;
	state.compactionFlushPending = true;
	try {
		const agentSession = state.getAgentSession?.();
		const queueOnly =
			isChatSessionStreaming(state) || state.isPaused?.() === true || agentSession?.queuedMessagesPaused;
		if (!queueOnly && !(await startChatSessionCompactionPrompt(state))) return;
		for (let message = takeNextCompactionMessage(state); message; message = takeNextCompactionMessage(state)) {
			try {
				if (message.mode === "followUp") await queueChatSessionFollowUp(state, message.text);
				else await queueChatSessionSteer(state, message.text);
			} catch (err) {
				returnCompactionMessage(state, message, err);
				return;
			}
		}
	} finally {
		state.compactionFlushPending = false;
		state.requestRender?.();
	}
}

function takeNextCompactionMessage<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): CompactionQueuedMessage | undefined {
	const [next, ...rest] = state.compactionQueuedMessages;
	state.compactionQueuedMessages = rest;
	state.requestRender?.();
	return next;
}

function returnCompactionMessage<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	message: CompactionQueuedMessage,
	err: unknown,
): void {
	state.compactionQueuedMessages = [message, ...state.compactionQueuedMessages];
	notifyChatSessionWarning(state, errorMessage(err));
	state.requestRender?.();
}

/**
 * Start the first queued prompt. The rest of the batch stays queued until the prompt is accepted,
 * which the host observes as its run starting or the command settling, so a rejected prompt is
 * restored ahead of it.
 */
async function startChatSessionCompactionPrompt<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): Promise<boolean> {
	const first = takeNextCompactionMessage(state);
	if (!first) return false;
	let accept!: (accepted: boolean) => void;
	const accepted = new Promise<boolean>((resolve) => {
		accept = resolve;
	});
	state.compactionPromptStarted = () => accept(true);
	const prompt = requiredChatSessionPromptCommand(state)(first.text, first.mode);
	prompt.then(
		() => accept(true),
		() => accept(false),
	);
	try {
		if (await accepted) {
			prompt.catch((err) => notifyChatSessionWarning(state, errorMessage(err)));
			return true;
		}
		returnCompactionMessage(
			state,
			first,
			await prompt.then(
				() => undefined,
				(err: unknown) => err,
			),
		);
		return false;
	} finally {
		state.compactionPromptStarted = undefined;
	}
}

export function restoreQueuedMessagesToEditor<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	options?: { suppressEmptyNotice?: boolean; preserveUnprotectedCustomMessages?: boolean },
): boolean {
	const steering = state.steeringController;
	if (steering !== undefined) return restoreSteeredQueue(state, steering, options);
	const queuedMessages = [
		...state.pendingSteeringMessages,
		...state.pendingFollowUpMessages,
		...state.compactionQueuedMessages.map((message) => message.text),
	];
	if (queuedMessages.length === 0) {
		if (!options?.suppressEmptyNotice) notifyChatSessionStatus(state, "No queued messages to restore");
		return false;
	}
	const restoredText = combineQueuedMessagesForEditor(queuedMessages, state.inputBuffer);
	state.pendingSteeringMessages = [];
	state.pendingFollowUpMessages = [];
	state.compactionQueuedMessages = [];
	setChatSessionEditorText(state, restoredText);
	state
		.getAgentSession?.()
		?.clearQueue(
			options?.preserveUnprotectedCustomMessages ? { preserveUnprotectedCustomMessages: true } : undefined,
		);
	state.requestRender?.();
	return true;
}

async function runChatSessionBashCommand<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	command: string,
	excludeFromContext: boolean,
): Promise<void> {
	const runBash = state.commands.runBash;
	if (!runBash) {
		notifyChatSessionWarning(state, "no bash command configured for this chat session");
		return;
	}
	const bashMessage: BashExecutionMessage = {
		role: "bashExecution",
		command,
		output: "",
		exitCode: undefined,
		cancelled: false,
		truncated: false,
		timestamp: Date.now(),
		...(excludeFromContext ? { excludeFromContext: true } : {}),
	};
	const bashEntry: ChatMessageEntry = {
		role: "tool",
		kind: "bashExecution",
		message: bashMessage,
		isPartial: true,
	};
	state.transcript.push(bashEntry);
	state.localBashRunning = true;
	state.bodyViewport.scrollToBottom();
	state.requestRender?.();
	try {
		const result = await runBash({
			command,
			excludeFromContext,
			onChunk: (chunk) => {
				bashMessage.output += chunk;
				state.requestRender?.();
			},
		});
		bashMessage.output = result.output;
		bashMessage.exitCode = result.exitCode;
		bashMessage.cancelled = result.cancelled;
		bashMessage.truncated = result.truncated;
		if (result.fullOutputPath !== undefined) {
			bashMessage.fullOutputPath = result.fullOutputPath;
		}
	} catch (err) {
		bashMessage.output = errorMessage(err);
		bashMessage.exitCode = undefined;
		bashMessage.cancelled = false;
		bashMessage.truncated = false;
	} finally {
		bashEntry.isPartial = false;
		state.localBashRunning = false;
		state.requestRender?.();
	}
}

type QueuedChatSessionMessage = ChatSessionHostState<never>["unconfirmedQueuedMessages"][number];

/**
 * Queue a message typed while the agent works, showing it as queued from submit rather than from the session's
 * `queue_update` (#4696). The session confirms it only after its input hooks and earlier submissions, on an event loop
 * the agent's own work, such as a running subagent, shares. The copy goes once the session answers or lists it. A
 * refused message is reported by the caller and, when `restoreOnFailure`, given back to the editor; one the session
 * accepted is not, even when its turn fails afterwards.
 */
async function queueChatSessionMessage<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	text: string,
	lane: QueuedChatSessionMessage["mode"],
	restoreOnFailure: boolean,
): Promise<void> {
	// A `/skill:` command is queued expanded, so its typed text never matches the row the session lists.
	const shown: QueuedChatSessionMessage | undefined =
		classifyChatCommand(text) === "skill" ? undefined : { text, mode: lane };
	if (shown) {
		state.unconfirmedQueuedMessages = [...state.unconfirmedQueuedMessages, shown];
		state.requestRender?.();
	}
	const settle = () => {
		if (!shown || !state.unconfirmedQueuedMessages.includes(shown)) return;
		state.unconfirmedQueuedMessages = state.unconfirmedQueuedMessages.filter((message) => message !== shown);
		state.requestRender?.();
	};
	// A message the session accepted was sent, even if its turn fails later, so it is never given back to the editor.
	let accepted = false;
	const answered = (success: boolean) => {
		accepted ||= success;
		settle();
	};
	try {
		if (lane === "followUp") await queueChatSessionFollowUp(state, text, answered);
		else await queueChatSessionSteer(state, text, answered);
	} catch (err) {
		if (restoreOnFailure && !accepted && !state.disposed) {
			const typedSince = state.inputBuffer;
			setChatSessionEditorText(state, typedSince.length === 0 ? text : `${text}\n${typedSince}`);
		}
		throw err;
	} finally {
		settle();
	}
}

/**
 * Drop the shown copies of messages a `queue_update` adds to the session's queue, oldest first, so a confirmed
 * message is never listed twice (#4696). A message the queue already listed confirms nothing.
 */
export function confirmQueuedChatSessionMessages<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	steering: readonly string[],
	followUp: readonly string[],
): void {
	if (state.steeringController !== undefined) {
		state.steeringController.reconcile({ steering, followUp });
		return;
	}
	if (state.unconfirmedQueuedMessages.length === 0) return;
	const added = {
		steer: addedQueueEntries(state.pendingSteeringMessages, steering),
		followUp: addedQueueEntries(state.pendingFollowUpMessages, followUp),
	};
	state.unconfirmedQueuedMessages = state.unconfirmedQueuedMessages.filter((message) => {
		const lane = added[message.mode];
		const index = lane.indexOf(message.text);
		if (index === -1) return true;
		lane.splice(index, 1);
		return false;
	});
}

function addedQueueEntries(before: readonly string[], after: readonly string[]): string[] {
	const unmatched = [...before];
	return after.filter((text) => {
		const index = unmatched.indexOf(text);
		if (index === -1) return true;
		unmatched.splice(index, 1);
		return false;
	});
}

async function queueChatSessionSteer<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	text: string,
	onAnswered?: (success: boolean) => void,
): Promise<void> {
	if (classifyChatCommand(text) === "skill" && state.commands.submitUserMessage) {
		await state.commands.submitUserMessage(text, "auto");
		return;
	}
	const agentSession = state.getAgentSession?.();
	if (agentSession?.isStreaming || agentSession?.queuedMessagesPaused) {
		// Only `/skill:` expands (above); other text queues literally, as an idle submission is sent.
		await agentSession.prompt(text, {
			streamingBehavior: "steer",
			expandPromptTemplates: false,
			preflightResult: onAnswered,
		});
		return;
	}
	await requiredChatSessionCommand(state, "steer")(text);
}

async function queueChatSessionFollowUp<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	text: string,
	onAnswered?: (success: boolean) => void,
): Promise<void> {
	if (classifyChatCommand(text) === "skill" && state.commands.submitUserMessage) {
		await state.commands.submitUserMessage(text, "followUp");
		return;
	}
	const agentSession = state.getAgentSession?.();
	if (agentSession?.isStreaming || agentSession?.queuedMessagesPaused) {
		await agentSession.prompt(text, {
			streamingBehavior: "followUp",
			expandPromptTemplates: false,
			preflightResult: onAnswered,
		});
		return;
	}
	await requiredChatSessionCommand(state, "followUp")(text);
}

async function sendChatSessionText<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	send: NonNullable<ChatSessionHostState<TExtraEntry>["commands"]["send"]>,
	text: string,
	mode: ChatSessionSubmitMode,
): Promise<void> {
	recordChatSessionPrompt(state, text);
	setChatSessionEditorText(state, "");
	state.requestRender?.();
	try {
		await send(text, mode);
	} catch (err) {
		if (state.disposed) return;
		const typedSince = state.inputBuffer;
		setChatSessionEditorText(state, typedSince.length === 0 ? text : `${text}\n${typedSince}`);
		notifyChatSessionWarning(state, errorMessage(err));
	}
}

/**
 * A submission to a chat that steers its agent as the main chat does. The chat's own commands run at once and never
 * reach the agent; input typed while it compacts waits in the editor; anything else goes to the agent through the
 * steering controller: queued in its lane while the agent works and shown as a queued row from submit, or its next
 * turn while it is idle. A message the agent refuses comes back to the editor above what was typed since.
 */
async function submitSteeredChatSession<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	steering: SteeringQueueController,
	text: string,
	mode: ChatSessionSubmitMode,
): Promise<void> {
	if (text.startsWith("/") && state.commands.handleSlashCommand) {
		try {
			if (await state.commands.handleSlashCommand(text)) {
				setChatSessionEditorText(state, "");
				return;
			}
		} catch (err) {
			notifyChatSessionWarning(state, errorMessage(err));
			return;
		} finally {
			state.requestRender?.();
		}
	}
	const bash = parseBashInput(text);
	if (bash?.command && !state.commands.runBash) {
		// The agent's shell is not this chat's to run: the command stays in the editor, and nothing reaches the agent.
		setChatSessionEditorText(state, text);
		notifyChatSessionWarning(state, "! shell commands are not available in this chat");
		return;
	}
	recordChatSessionPrompt(state, text);
	if (state.compacting) {
		setChatSessionEditorText(state, "");
		state.compactionQueuedMessages = [...state.compactionQueuedMessages, { text, mode }];
		notifyChatSessionStatus(state, "Queued message until compaction completes");
		return;
	}
	if (bash?.command) {
		if (isChatSessionBashRunning(state)) {
			notifyChatSessionWarning(state, "A bash command is already running. esc cancel first.");
			setChatSessionEditorText(state, text);
			return;
		}
		setChatSessionEditorText(state, "");
		await runChatSessionBashCommand(state, bash.command, bash.excludeFromContext);
		return;
	}
	setChatSessionEditorText(state, "");
	if (state.compactionFlushPending || state.compactionQueuedMessages.length > 0) {
		// Messages held through a compaction go out first, in the order they were typed.
		state.compactionQueuedMessages = [...state.compactionQueuedMessages, { text, mode }];
		state.requestRender?.();
		if (!state.compactionFlushPending) await flushChatSessionCompactionQueue(state);
		return;
	}
	state.requestRender?.();
	const result = await steering.submit(text, mode === "followUp" ? "followUp" : "auto");
	if (state.disposed) return;
	if (result.kind === "refused") {
		const typedSince = state.inputBuffer;
		setChatSessionEditorText(state, typedSince.length === 0 ? text : `${text}\n${typedSince}`);
		notifyChatSessionWarning(state, errorMessage(result.error));
	} else if (result.kind === "lost" || result.kind === "failed") {
		notifyChatSessionWarning(state, errorMessage(result.error));
	}
	state.requestRender?.();
}

/**
 * Alt+Up in a steered chat: every queued message comes back to the editor, from the agent's own answer, steering
 * messages first and then follow-ups, in front of what is typed. Answers whether any message was listed as queued.
 */
function restoreSteeredQueue<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	steering: SteeringQueueController,
	options?: { suppressEmptyNotice?: boolean; preserveUnprotectedCustomMessages?: boolean },
): boolean {
	const listed = steering.hasQueued();
	const clear = options?.preserveUnprotectedCustomMessages ? { preserveUnprotectedCustomMessages: true } : undefined;
	const listedBefore = { steering: state.pendingSteeringMessages, followUp: state.pendingFollowUpMessages };
	void steering
		.restoreAll(() => state.inputBuffer, clear)
		.then(
			(restored) => {
				if (state.disposed) {
					// What the agent gave back is the reader's: it waits for them where their next draft is.
					if (restored !== undefined) state.keepRestoredMessages?.(restored.messages);
					return;
				}
				if (restored === undefined) {
					if (!options?.suppressEmptyNotice) notifyChatSessionStatus(state, "No queued messages to restore");
				} else {
					forgetListedQueue(state, listedBefore);
					setChatSessionEditorText(state, restored.text);
				}
				state.requestRender?.();
			},
			(err: unknown) => {
				if (!state.disposed)
					notifyChatSessionWarning(state, `Failed to restore queued messages: ${errorMessage(err)}`);
			},
		);
	state.requestRender?.();
	return listed;
}

/**
 * The chat's listing of the agent's queue no longer holds what was taken back from it, unless the agent listed its
 * queue again since (each listing replaces the lists): a message queued after the take stays as the agent listed it.
 */
function forgetListedQueue<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	listed: { readonly steering: readonly string[]; readonly followUp: readonly string[] },
): void {
	if (state.pendingSteeringMessages === listed.steering) state.pendingSteeringMessages = [];
	if (state.pendingFollowUpMessages === listed.followUp) state.pendingFollowUpMessages = [];
}

/**
 * Put messages already taken back from the agent's queue into the editor, with any the editor held, steering messages
 * first and then follow-ups, in front of what is typed. Answers how many came back.
 */
export function restoreTakenQueuedMessages<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	taken: { readonly steering: readonly string[]; readonly followUp: readonly string[] },
): number {
	const held = state.compactionQueuedMessages;
	state.compactionQueuedMessages = [];
	const messages = [
		...taken.steering,
		...held.filter((message) => message.mode !== "followUp").map((message) => message.text),
		...taken.followUp,
		...held.filter((message) => message.mode === "followUp").map((message) => message.text),
	];
	if (messages.length === 0) return 0;
	// The agent listed its queue without them when it gave them back; a listing after that is newer and stays.
	setChatSessionEditorText(state, combineQueuedMessagesForEditor(messages, state.inputBuffer));
	state.requestRender?.();
	return messages.length;
}
