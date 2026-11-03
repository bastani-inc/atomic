import {
	clearInteractiveEngineQueue,
	getInteractiveEngineRemoteCommands,
} from "../interactive-engine/extension-ui-bridge.ts";
import { isRpcRequestAcceptedFailure } from "../rpc/rpc-transport-error.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { combineQueuedMessagesForEditor, Spacer, TruncatedText, theme } from "./interactive-mode-deps.ts";
import type { CompactionQueuedMessage } from "./interactive-mode-types.ts";

/** Typing order of messages handed to the session, so one it refuses returns to its own place. */
const handOffOrder = new WeakMap<CompactionQueuedMessage, number>();
let nextHandOff = 0;
/**
 * Messages handed to the session that it has not confirmed yet. The editor keeps showing them until the session
 * reports it took them; from then on the session lists them itself. They are the session's from the moment they
 * are sent, so a restore takes them from the session's own answer and never from this copy.
 */
const unconfirmedHandOffs = new WeakMap<InteractiveModeBase, CompactionQueuedMessage[]>();

function heldByEditor(mode: InteractiveModeBase): CompactionQueuedMessage[] {
	return [...(unconfirmedHandOffs.get(mode) ?? []), ...mode.compactionQueuedMessages];
}

InteractiveModeBase.prototype.getAllQueuedMessages = function (this: InteractiveModeBase): {
	steering: string[];
	followUp: string[];
} {
	const held = heldByEditor(this);
	return {
		steering: [
			...this.session.getSteeringMessages(),
			...held.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
		],
		followUp: [
			...this.session.getFollowUpMessages(),
			...held.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
		],
	};
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
	// Leave the editor queue now, so nothing sends these messages while the session answers.
	const held = this.compactionQueuedMessages;
	const heldSendFailed = this.compactionSendFailed;
	this.compactionQueuedMessages = [];
	this.compactionSendFailed = false;
	let removed: { steering: string[]; followUp: string[] };
	try {
		const clearing =
			clearInteractiveEngineQueue(this.runtimeHost) ?? Promise.resolve(this.session.clearQueue(options));
		this.updatePendingMessagesDisplay();
		removed = await clearing;
	} catch (error) {
		this.compactionQueuedMessages = [...held, ...this.compactionQueuedMessages];
		// If compaction ended meanwhile, its flush found the queue empty and nothing else will send these. Marked as
		// unsent, they go out in order ahead of the next submission, as a batch whose first send failed does.
		this.compactionSendFailed ||= heldSendFailed || (held.length > 0 && !this.compactionActive);
		this.updatePendingMessagesDisplay();
		throw error;
	}
	// A hand-off the session has not confirmed yet is the session's: it either lists it or reports its refusal.
	return {
		steering: [...removed.steering, ...held.filter((msg) => msg.mode === "steer").map((msg) => msg.text)],
		followUp: [...removed.followUp, ...held.filter((msg) => msg.mode === "followUp").map((msg) => msg.text)],
	};
};

InteractiveModeBase.prototype.updatePendingMessagesDisplay = function (this: InteractiveModeBase): void {
	this.pendingMessagesContainer.clear();
	const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
	if (steeringMessages.length > 0 || followUpMessages.length > 0) {
		this.pendingMessagesContainer.addChild(new Spacer(1));
		for (const message of steeringMessages) {
			const text = theme.fg("dim", `Steering: ${message}`);
			this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
		}
		for (const message of followUpMessages) {
			const text = theme.fg("dim", `Follow-up: ${message}`);
			this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
		}
		const dequeueHint = this.getAppKeyDisplay("app.message.dequeue");
		const hintText = theme.fg("dim", `↳ ${dequeueHint} to edit all queued messages`);
		this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
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
	const { steering, followUp } = await this.clearAllQueues(options);
	const allQueued = [...steering, ...followUp];
	if (allQueued.length === 0) {
		this.updatePendingMessagesDisplay();
		if (options?.abort) {
			void this.session.abort();
		}
		return 0;
	}
	const currentText = options?.currentText ?? this.editor.getText();
	const combinedText = combineQueuedMessagesForEditor(allQueued, currentText);
	this.editor.setText(combinedText);
	this.updatePendingMessagesDisplay();
	if (options?.abort) {
		void this.session.abort();
	}
	return allQueued.length;
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

	const spaceIndex = text.indexOf(" ");
	const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
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
	const pending = unconfirmedHandOffs.get(mode);
	const index = pending?.indexOf(message) ?? -1;
	if (!pending || index === -1) return false;
	pending.splice(index, 1);
	if (pending.length === 0) unconfirmedHandOffs.delete(mode);
	mode.updatePendingMessagesDisplay();
	return true;
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
	unconfirmedHandOffs.set(mode, [...(unconfirmedHandOffs.get(mode) ?? []), ...messages]);
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
	onQueued?: () => void,
): Promise<{ error: unknown } | undefined> {
	let accept!: (accepted: boolean) => void;
	const accepted = new Promise<boolean>((resolve) => {
		accept = resolve;
	});
	const prompt = mode.session.prompt(message.text, {
		streamingBehavior: message.mode,
		preflightResult: (success, disposition) => {
			if (success && disposition === "queued") onQueued?.();
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
		const refused = await promptUntilAccepted(
			mode,
			message,
			echoed ? () => mode.discardDeferredRenderedUserInput(message.text) : undefined,
		);
		if (refused !== undefined) {
			if (echoed) mode.discardDeferredRenderedUserInput(message.text);
			returnCompactionMessage(mode, message, refused.error);
			return;
		}
	}
}

InteractiveModeBase.prototype.flushPendingBashComponents = function (this: InteractiveModeBase): void {
	for (const component of this.pendingBashComponents) {
		this.pendingMessagesContainer.removeChild(component);
		this.chatContainer.addChild(component);
	}
	this.pendingBashComponents = [];
};
