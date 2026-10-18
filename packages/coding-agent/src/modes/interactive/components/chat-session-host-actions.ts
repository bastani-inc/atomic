import type { AgentSessionQueuePauseControl } from "../../../core/agent-session-methods.ts";
import type { BashExecutionMessage } from "../../../core/messages.ts";
import { combineQueuedMessagesForEditor } from "../chat-input-actions.ts";
import { classifyChatCommand } from "../skill-command-autocomplete.ts";
import type { ChatMessageEntry } from "./chat-message-renderer.ts";
import { setChatSessionEditorText } from "./chat-session-host-editor.ts";
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
import type { ChatSessionHostState } from "./chat-session-host-state.ts";
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
			stopChatSessionWorkingLifecycle(state, false);
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
	try {
		state.sdkBusy = true;
		state.statusMessage = "resuming…";
		syncChatSessionAnimationTick(state);
		state.requestRender?.();
		await settlement;
		await requiredChatSessionCommand(state, "resume")(text, mode);
		if (state.inputBuffer === editorText) setChatSessionEditorText(state, "");
		state.sdkBusy = false;
		if (state.statusMessage === "resuming…") state.statusMessage = "";
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
	if (state.statusMessage === state.lastWarningMessage) state.statusMessage = "";
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
			state.statusMessage = "resuming…";
			syncChatSessionAnimationTick(state);
			state.requestRender?.();
			await requiredChatSessionCommand(state, "resume")(submitText, submitMode);
			state.sdkBusy = false;
			if (state.statusMessage === "resuming…") state.statusMessage = "";
			syncChatSessionAnimationTick(state);
			return;
		}
		if (nativeQueuePaused) {
			state.sdkBusy = true;
			state.statusMessage = "resuming…";
			syncChatSessionAnimationTick(state);
			state.requestRender?.();
			await agentSession.resumeQueuedMessages();
			await state.commands.ensureAttached?.();
			await requiredChatSessionPromptCommand(state)(submitText, submitMode);
			state.sdkBusy = false;
			if (state.statusMessage === "resuming…") state.statusMessage = "";
			syncChatSessionAnimationTick(state);
			return;
		}
		if (submitMode === "followUp" && isStreaming) {
			await queueChatSessionFollowUp(state, submitText);
			return;
		}
		if (isStreaming) {
			await queueChatSessionSteer(state, submitText);
		} else {
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
		settleSubmittedPromptLifecycle(state, submittedPromptLifecycleGeneration);
		state.statusMessage = errorMessage(err);
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

async function queueChatSessionSteer<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	text: string,
): Promise<void> {
	if (classifyChatCommand(text) === "skill" && state.commands.submitUserMessage) {
		await state.commands.submitUserMessage(text, "auto");
		return;
	}
	const agentSession = state.getAgentSession?.();
	if (agentSession?.isStreaming || agentSession?.queuedMessagesPaused) {
		await agentSession.prompt(text, { streamingBehavior: "steer" });
		return;
	}
	await requiredChatSessionCommand(state, "steer")(text);
}

async function queueChatSessionFollowUp<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	text: string,
): Promise<void> {
	if (classifyChatCommand(text) === "skill" && state.commands.submitUserMessage) {
		await state.commands.submitUserMessage(text, "followUp");
		return;
	}
	const agentSession = state.getAgentSession?.();
	if (agentSession?.isStreaming || agentSession?.queuedMessagesPaused) {
		await agentSession.prompt(text, { streamingBehavior: "followUp" });
		return;
	}
	await requiredChatSessionCommand(state, "followUp")(text);
}
