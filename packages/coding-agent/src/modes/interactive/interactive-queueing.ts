import type { PromptDisposition } from "../../core/agent-session-types.js";
import { parseSlashCommand } from "../../core/slash-commands.js";
import {
	clearInteractiveEngineQueue,
	getInteractiveEngineRemoteCommands,
} from "../interactive-engine/extension-ui-bridge.ts";
import { isRpcRequestAcceptedFailure } from "../rpc/rpc-transport-error.ts";
import { QueuedMessagesView, queuedMessageRows } from "./components/queued-messages-view.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { theme } from "./interactive-mode-deps.ts";
import type { CompactionQueuedMessage } from "./interactive-mode-types.ts";
import {
	restoredQueue,
	type SteeringEditorQueue,
	SteeringQueueController,
	type SteeringQueueLists,
	type SteeringTarget,
} from "./steering-queue-controller.ts";

/** Typing order of messages handed to the session, so one it refuses returns to its own place. */
const handOffOrder = new WeakMap<CompactionQueuedMessage, number>();
let nextHandOff = 0;

/**
 * The main chat's steering controller. Messages handed to the session that it has not confirmed yet stay shown as
 * queued until the session reports it took them; from then on the session lists them itself. They are the session's
 * from the moment they are sent, so a restore takes them from the session's own answer and never from this copy.
 */
const mainControllers = new WeakMap<InteractiveModeBase, SteeringQueueController>();

export function mainSteering(mode: InteractiveModeBase): SteeringQueueController {
	let controller = mainControllers.get(mode);
	if (controller === undefined) {
		controller = new SteeringQueueController(mainSteeringTarget(mode), mainEditorQueue(mode));
		mainControllers.set(mode, controller);
	}
	return controller;
}

/** The main chat's session, read at each call, so a session the chat switched to is the one steered. */
function mainSteeringTarget(mode: InteractiveModeBase): SteeringTarget {
	return {
		get busy() {
			return mode.session.isStreaming || mode.promptTurn !== undefined;
		},
		get paused() {
			return mode.session.queuedMessagesPaused;
		},
		queued: () => ({
			steering: mode.session.getSteeringMessages(),
			followUp: mode.session.getFollowUpMessages(),
		}),
		prompt: (text, options) => mode.session.prompt(text, options),
		clearQueue: (options) =>
			clearInteractiveEngineQueue(mode.runtimeHost) ?? Promise.resolve(mode.session.clearQueue(options)),
	};
}

/** The messages the main editor holds while compaction runs, listed after the session's own. */
function mainEditorQueue(mode: InteractiveModeBase): SteeringEditorQueue {
	return {
		held: () => mode.compactionQueuedMessages,
		takeHeld: () => {
			const held = mode.compactionQueuedMessages;
			const heldSendFailed = mode.compactionSendFailed;
			mode.compactionQueuedMessages = [];
			mode.compactionSendFailed = false;
			return {
				messages: held,
				putBack: () => {
					mode.compactionQueuedMessages = [...held, ...mode.compactionQueuedMessages];
					// If compaction ended meanwhile, its flush found the queue empty and nothing else will send these.
					// Marked as unsent, they go out in order ahead of the next submission, as a batch whose first send
					// failed does.
					mode.compactionSendFailed ||= heldSendFailed || (held.length > 0 && !mode.compactionActive);
				},
			};
		},
		changed: () => mode.updatePendingMessagesDisplay(),
		requestRender: () => mode.ui.requestRender(),
	};
}

InteractiveModeBase.prototype.getAllQueuedMessages = function (this: InteractiveModeBase): {
	steering: string[];
	followUp: string[];
} {
	return mainSteering(this).allQueued();
};

/**
 * Take every queued message back from the session and this editor, so the caller can restore them.
 *
 * What the session removed is its own answer, not this editor's copy of its queue. An engine child lists its queue
 * by `queue_update` events that trail it by a round trip, so a message it queued meanwhile is missing from the copy
 * and one it already took into a turn is still in it (#4257). The messages only this editor holds follow them.
 * When the session cannot be reached nothing is removed and the held messages stay queued.
 */
InteractiveModeBase.prototype.clearAllQueues = async function (
	this: InteractiveModeBase,
	options?: { preserveUnprotectedCustomMessages?: boolean },
): Promise<{
	steering: string[];
	followUp: string[];
}> {
	return mainSteering(this).clearAll(options);
};

InteractiveModeBase.prototype.updatePendingMessagesDisplay = function (this: InteractiveModeBase): void {
	this.pendingMessagesContainer.clear();
	for (const component of this.pendingBashComponents) {
		this.pendingMessagesContainer.addChild(component);
	}
	const rows = queuedMessageRows(this.getAllQueuedMessages());
	if (rows.length > 0) {
		const dequeueKey = this.getAppKeyDisplay("app.message.dequeue");
		this.pendingMessagesContainer.addChild(new QueuedMessagesView(rows, dequeueKey, (text) => theme.fg("dim", text)));
	}
};

InteractiveModeBase.prototype.restoreQueuedMessagesToEditor = async function (
	this: InteractiveModeBase,
	options?: {
		abort?: boolean;
		currentText?: string;
		preserveUnprotectedCustomMessages?: boolean;
	},
): Promise<number> {
	const restored = restoredQueue(
		await this.clearAllQueues(options),
		() => options?.currentText ?? this.editor.getExpandedText?.() ?? this.editor.getText(),
	);
	if (restored !== undefined) this.editor.setText(restored.text);
	this.updatePendingMessagesDisplay();
	if (options?.abort) {
		void this.session.abort();
	}
	return restored?.messages.length ?? 0;
};

/** Report a restore the session could not answer; nothing was removed, so every message is still queued. */
export function showQueueRestoreFailure(mode: InteractiveModeBase, error: unknown): void {
	mode.showError(`Failed to restore queued messages: ${error instanceof Error ? error.message : String(error)}`);
}

InteractiveModeBase.prototype.queueCompactionMessage = function (
	this: InteractiveModeBase,
	text: string,
	mode: "steer" | "followUp",
): void {
	this.compactionQueuedMessages.push({ text, mode });
	this.editor.addToHistory?.(text);
	this.editor.setText("");
	this.updatePendingMessagesDisplay();
	if (this.compactionActive) {
		this.showStatus("Queued message for after compaction");
		return;
	}
	if (!this.compactionFlushPending) void this.flushCompactionQueue({ willRetry: false });
};

InteractiveModeBase.prototype.isExtensionCommand = function (this: InteractiveModeBase, text: string): boolean {
	if (!text.startsWith("/")) return false;

	const extensionRunner = this.session.extensionRunner;

	const commandName = parseSlashCommand(text).name;
	if (extensionRunner.getCommand(commandName)) return true;
	return getInteractiveEngineRemoteCommands(this.runtimeHost).some(
		(command) => command.source === "extension" && command.name === commandName,
	);
};

InteractiveModeBase.prototype.flushCompactionQueue = async function (
	this: InteractiveModeBase,
	options?: {
		willRetry?: boolean;
		afterPrompt?: boolean;
	},
): Promise<void> {
	if (this.compactionFlushPending || this.compactionQueuedMessages.length === 0) return;
	if (this.promptTurn?.dispatched === false) return;
	this.compactionFlushPending = true;
	this.compactionSendFailed = false;
	try {
		if (options?.afterPrompt === true) await sendHeldInput(this);
		else await sendCompactionQueue(this, options?.willRetry === true);
	} finally {
		this.compactionFlushPending = false;
		this.updatePendingMessagesDisplay();
	}
	const arrivedAfterDrain =
		this.compactionQueuedMessages.length > 0 && !this.compactionSendFailed && !this.compactionActive;
	if (arrivedAfterDrain) await this.flushCompactionQueue(options);
};

async function sendCompactionQueue(mode: InteractiveModeBase, willRetry: boolean): Promise<void> {
	const queueOnly = !willRetry && (mode.session.isStreaming || mode.session.queuedMessagesPaused);
	if (queueOnly) {
		await drainCompactionQueue(mode, (message) =>
			mode.session.prompt(message.text, { streamingBehavior: message.mode }),
		);
		return;
	}
	if (!willRetry && !(await startCompactionQueuePrompt(mode))) return;
	await drainCompactionQueue(mode, (message) => {
		if (mode.isExtensionCommand(message.text)) return mode.session.prompt(message.text);
		if (message.mode === "followUp") return mode.session.followUp(message.text);
		return mode.session.steer(message.text);
	});
}

function showCompactionQueueError(mode: InteractiveModeBase, error: unknown): void {
	mode.showError(`Failed to send queued message: ${error instanceof Error ? error.message : String(error)}`);
}

function takeNextCompactionMessage(mode: InteractiveModeBase): CompactionQueuedMessage | undefined {
	const [next, ...rest] = mode.compactionQueuedMessages;
	mode.compactionQueuedMessages = rest;
	mode.updatePendingMessagesDisplay();
	return next;
}

function returnCompactionMessage(mode: InteractiveModeBase, message: CompactionQueuedMessage, error: unknown): void {
	mode.compactionQueuedMessages = [message, ...mode.compactionQueuedMessages];
	mode.compactionSendFailed = true;
	mode.updatePendingMessagesDisplay();
	showCompactionQueueError(mode, error);
}

function returnHandedOffMessage(mode: InteractiveModeBase, message: CompactionQueuedMessage, error: unknown): void {
	const rank = handOffOrder.get(message) ?? -1;
	const queue = mode.compactionQueuedMessages;
	const index = queue.findIndex((queued) => (handOffOrder.get(queued) ?? Number.POSITIVE_INFINITY) > rank);
	mode.compactionQueuedMessages =
		index === -1 ? [...queue, message] : [...queue.slice(0, index), message, ...queue.slice(index)];
	mode.compactionSendFailed = true;
	mode.updatePendingMessagesDisplay();
	showCompactionQueueError(mode, error);
}

function confirmHandOff(mode: InteractiveModeBase, message: CompactionQueuedMessage): boolean {
	return mainSteering(mode).settle(message);
}

/**
 * Show a message sent while the agent works as queued at once, before the session confirms it (#4696). Delivery waits
 * on the session: in an isolated engine that is a round trip through a process whose event loop the agent's own work,
 * such as a running subagent, shares. The editor shows the message until `settleSubmission()` or a `queue_update` that
 * lists it, whichever comes first.
 */
export function showSubmissionAsQueued(
	mode: InteractiveModeBase,
	text: string,
	lane: CompactionQueuedMessage["mode"],
): CompactionQueuedMessage {
	return mainSteering(mode).showAsQueued({ text, mode: lane });
}

/**
 * Stop showing a submission once the session answered it: queued, it lists the message itself; started or handled, it
 * is no longer queued; refused, the caller gives it back to the editor and reports why.
 */
export function settleSubmission(mode: InteractiveModeBase, message: CompactionQueuedMessage): void {
	if (confirmHandOff(mode, message)) mode.ui.requestRender();
}

/**
 * Stop showing editor copies of messages the session's queue now lists, so a confirmed message is never shown twice
 * (#4696). Only a message this update added confirms a copy, oldest copy first, so an identical message queued
 * earlier does not.
 */
export function reconcileQueuedSubmissions(mode: InteractiveModeBase, queue: SteeringQueueLists): void {
	mainSteering(mode).reconcile(queue);
}

/**
 * Hand the editor's held messages to the session before an extension command runs during compaction (#4251).
 * The session registers input as it arrives and holds it until compaction ends, so a message the command sends
 * goes out after them, in typing order. Each message stays shown here until the session confirms it took it, and
 * from then on the session lists it as queued. The session's clearQueue() returns it for Alt+Up and Ctrl+C, also
 * when the confirmation is still on its way. A message the session refuses returns to the editor queue.
 */
export function handOffCompactionQueue(mode: InteractiveModeBase): void {
	const messages = mode.compactionQueuedMessages;
	if (messages.length === 0) return;
	mode.compactionQueuedMessages = [];
	mainSteering(mode).track(messages);
	for (const message of messages) {
		handOffOrder.set(message, nextHandOff++);
		let accepted = false;
		void mode.session
			.prompt(message.text, {
				streamingBehavior: message.mode,
				preflightResult: (success) => {
					accepted = success;
					if (success) confirmHandOff(mode, message);
				},
			})
			.catch((error: unknown) => {
				if (accepted || isRpcRequestAcceptedFailure(error)) {
					confirmHandOff(mode, message);
					showCompactionQueueError(mode, error);
					return;
				}
				// Alt+Up may already have returned it to the editor; only an unconfirmed message goes back.
				if (confirmHandOff(mode, message)) returnHandedOffMessage(mode, message, error);
			});
	}
	mode.updatePendingMessagesDisplay();
}

/**
 * Deliver messages one at a time from the front of the compaction queue. Input submitted meanwhile
 * joins the back of that queue, so a failed message returns to the front ahead of everything after it.
 */
async function drainCompactionQueue(
	mode: InteractiveModeBase,
	deliver: (message: CompactionQueuedMessage) => Promise<unknown>,
	limit = Number.POSITIVE_INFINITY,
): Promise<boolean> {
	for (let delivered = 0; delivered < limit; delivered++) {
		const message = takeNextCompactionMessage(mode);
		if (!message) break;
		try {
			await deliver(message);
		} catch (error) {
			returnCompactionMessage(mode, message, error);
			return false;
		}
	}
	return true;
}

/**
 * Run leading extension commands, then start the first prompt. The rest of the batch stays in the
 * compaction queue until that prompt is accepted, so a rejected prompt is restored ahead of it.
 */
async function startCompactionQueuePrompt(mode: InteractiveModeBase): Promise<boolean> {
	const firstPromptIndex = mode.compactionQueuedMessages.findIndex(
		(message) => !mode.isExtensionCommand(message.text),
	);
	const leadingCommands = firstPromptIndex === -1 ? mode.compactionQueuedMessages.length : firstPromptIndex;
	const ranCommands = await drainCompactionQueue(
		mode,
		(message) => mode.session.prompt(message.text),
		leadingCommands,
	);
	if (!ranCommands) return false;
	const first = takeNextCompactionMessage(mode);
	if (!first) return false;
	const refused = await promptUntilAccepted(mode, first);
	if (refused === undefined) return true;
	returnCompactionMessage(mode, first, refused.error);
	return false;
}

async function promptUntilAccepted(
	mode: InteractiveModeBase,
	message: CompactionQueuedMessage,
	onAccepted?: (disposition: PromptDisposition | undefined) => void,
): Promise<{ error: unknown } | undefined> {
	let accept!: (accepted: boolean) => void;
	const accepted = new Promise<boolean>((resolve) => {
		accept = resolve;
	});
	const prompt = mode.session.prompt(message.text, {
		streamingBehavior: message.mode,
		preflightResult: (success, disposition) => {
			if (success) onAccepted?.(disposition);
			accept(success);
		},
	});
	prompt.then(
		() => accept(true),
		(error: unknown) => accept(isRpcRequestAcceptedFailure(error)),
	);
	if (await accepted) {
		prompt.catch((error) => showCompactionQueueError(mode, error));
		return undefined;
	}
	return {
		error: await prompt.then(
			() => undefined,
			(error: unknown) => error,
		),
	};
}

async function sendHeldInput(mode: InteractiveModeBase): Promise<void> {
	while (mode.compactionQueuedMessages.length > 0) {
		const message = takeNextCompactionMessage(mode);
		if (!message) return;
		const echoed = !message.text.startsWith("/");
		if (echoed) mode.renderDeferredUserInput(message.text);
		const shownBefore = mode.userMessagesShownBySession;
		const refused = await promptUntilAccepted(
			mode,
			message,
			echoed
				? (disposition) => {
						if (disposition === "queued" || disposition === "handled")
							mode.discardDeferredRenderedUserInput(message.text);
						if (disposition === "started") mode.expectStartedUserInput(message.text, shownBefore);
					}
				: undefined,
		);
		if (refused !== undefined) {
			if (echoed) mode.discardDeferredRenderedUserInput(message.text);
			returnCompactionMessage(mode, message, refused.error);
			return;
		}
		// #5135: a run that repeats input the chat already shows as unsaved shows no message of its own.
		if (
			echoed &&
			mode.startedDeferredUserInput === message.text &&
			mode.deferredRenderedUserInputs?.includes(message.text) === true
		)
			mode.discardDeferredRenderedUserInput(message.text);
	}
}

InteractiveModeBase.prototype.flushPendingBashComponents = function (this: InteractiveModeBase): void {
	for (const component of this.pendingBashComponents) {
		this.pendingMessagesContainer.removeChild(component);
		this.chatContainer.addChild(component);
	}
	this.pendingBashComponents = [];
};
