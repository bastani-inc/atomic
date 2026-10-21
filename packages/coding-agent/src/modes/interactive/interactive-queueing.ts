import { InteractiveModeBase } from "./interactive-mode-base.ts";
import { combineQueuedMessagesForEditor, Spacer, TruncatedText, theme } from "./interactive-mode-deps.ts";
import type { CompactionQueuedMessage } from "./interactive-mode-types.ts";

InteractiveModeBase.prototype.getAllQueuedMessages = function (this: InteractiveModeBase): {
	steering: string[];
	followUp: string[];
} {
	return {
		steering: [
			...this.session.getSteeringMessages(),
			...this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
		],
		followUp: [
			...this.session.getFollowUpMessages(),
			...this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
		],
	};
};

InteractiveModeBase.prototype.clearAllQueues = function (
	this: InteractiveModeBase,
	options?: { preserveUnprotectedCustomMessages?: boolean },
): {
	steering: string[];
	followUp: string[];
} {
	const { steering, followUp } = this.session.clearQueue(options);
	const compactionSteering = this.compactionQueuedMessages
		.filter((msg) => msg.mode === "steer")
		.map((msg) => msg.text);
	const compactionFollowUp = this.compactionQueuedMessages
		.filter((msg) => msg.mode === "followUp")
		.map((msg) => msg.text);
	this.compactionQueuedMessages = [];
	this.compactionSendFailed = false;
	return {
		steering: [...steering, ...compactionSteering],
		followUp: [...followUp, ...compactionFollowUp],
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

InteractiveModeBase.prototype.restoreQueuedMessagesToEditor = function (
	this: InteractiveModeBase,
	options?: {
		abort?: boolean;
		currentText?: string;
		preserveUnprotectedCustomMessages?: boolean;
	},
): number {
	const { steering, followUp } = this.clearAllQueues(options);
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
	return !!extensionRunner.getCommand(commandName);
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
): Promise<{ error: unknown } | undefined> {
	let accept!: (accepted: boolean) => void;
	const accepted = new Promise<boolean>((resolve) => {
		accept = resolve;
	});
	const prompt = mode.session.prompt(message.text, {
		streamingBehavior: message.mode,
		preflightResult: (success) => accept(success),
	});
	prompt.then(
		() => accept(true),
		() => accept(false),
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
		const refused = await promptUntilAccepted(mode, message);
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
