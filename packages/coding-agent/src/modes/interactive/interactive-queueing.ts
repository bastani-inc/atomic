import type { PromptDisposition, UserMessageWithRawText } from "../../core/agent-session-types.js";
import {
	NO_QUEUED_MESSAGES,
	type QueuedMessageLanes,
	queuedMessagesUnderWay,
} from "../../core/queued-message-delivery.ts";
import { parseSlashCommand } from "../../core/slash-commands.js";
import {
	clearInteractiveEngineQueue,
	getInteractiveEngineRemoteCommands,
} from "../interactive-engine/extension-ui-bridge.ts";
import { IsolatedInteractiveRuntime } from "../interactive-engine/isolated-runtime.js";
import { isRpcRequestAcceptedFailure } from "../rpc/rpc-transport-error.ts";
import { promptHandle } from "./agent-view/agent-drafts.ts";
import { viewedSteering } from "./agent-view/viewed-submit.ts";
import { combineQueuedMessagesForEditor } from "./chat-input-actions.ts";
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
		// An isolated engine can crash with what it queued; the chat then gives those messages back.
		canBeLost: true,
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

/**
 * The messages the main chat's session took from its queue whose own row the transcript does not show yet. Its queue
 * no longer lists them; the chat draws them as queued ahead of their lane until their `message_start` arrives. In
 * process they are read from the session with its queue; an isolated engine tells the host about them with its events.
 */
function mainQueuedDeliveries(mode: InteractiveModeBase): QueuedMessageLanes {
	const runtime = mode.runtimeHost;
	return runtime instanceof IsolatedInteractiveRuntime
		? runtime.queuedMessagesUnderWay()
		: queuedMessagesUnderWay(mode.session);
}

/** The messages being delivered that the main chat's rows drew when they were last built. */
const drawnDeliveries = new WeakMap<InteractiveModeBase, QueuedMessageLanes>();

/**
 * Build the main chat's rows again when a message they draw as being delivered is no longer delivered, without an
 * event that builds them: a delivery that ended without its `message_start` (a hook failed, or the session already
 * shows the input). Its row goes with the next event the session sends. A delivery that begins needs nothing here: the
 * rows drawn before it still list it as queued, and the `queue_update` it brings builds them again.
 */
export function redrawMainQueuedDeliveries(mode: InteractiveModeBase): void {
	const drawn = drawnDeliveries.get(mode);
	if (drawn === undefined || drawn === NO_QUEUED_MESSAGES) return;
	// While a subagent is shown, the rows are its queue.
	if (mode.agentView?.viewed?.kind === "agent") return;
	if (drawn === mainQueuedDeliveries(mode)) return;
	mode.updatePendingMessagesDisplay();
	mode.ui.requestRender();
}

InteractiveModeBase.prototype.updatePendingMessagesDisplay = function (this: InteractiveModeBase): void {
	this.pendingMessagesContainer.clear();
	// While a subagent is shown, the rows above the prompt are its queue, drawn as the main chat draws its own.
	const viewed = viewedSteering(this);
	if (viewed !== undefined) {
		// The main chat's rows are not drawn meanwhile: keep none of their texts.
		drawnDeliveries.delete(this);
		const shown = this.agentView?.viewed;
		const rows = queuedMessageRows(
			viewed.allQueued(),
			shown?.kind === "agent" ? shown.port.status().delivering : undefined,
		);
		if (rows.length === 0) return;
		const dequeueKey = this.getAppKeyDisplay("app.message.dequeue");
		this.pendingMessagesContainer.addChild(new QueuedMessagesView(rows, dequeueKey, (text) => theme.fg("dim", text)));
		return;
	}
	for (const component of this.pendingBashComponents) {
		this.pendingMessagesContainer.addChild(component);
	}
	// Drawing only: Alt+Up, Esc and engine recovery use the session's own queue, which no longer lists these.
	const delivering = mainQueuedDeliveries(this);
	if (delivering === NO_QUEUED_MESSAGES) drawnDeliveries.delete(this);
	else drawnDeliveries.set(this, delivering);
	const rows = queuedMessageRows(this.getAllQueuedMessages(), delivering);
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
	// Main's prompt, also once the screen shows a subagent before the session answers.
	const prompt = promptHandle(this, "main");
	const restored = restoredQueue(
		await this.clearAllQueues(options),
		() => options?.currentText ?? prompt.getExpandedText(),
	);
	if (restored !== undefined) prompt.setText(restored.text);
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
 * The session saved a user message: a message sent while the chat showed the turn running, which the session started
 * its next turn with, is delivered from here on, so an engine crash no longer gives it back.
 */
export function noteSteeringSaved(mode: InteractiveModeBase, message: UserMessageWithRawText): void {
	const text = mode.getUserMessageText(message);
	mainSteering(mode).noteSaved(message.rawText === undefined ? [text] : [text, message.rawText]);
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

/** `count` queued message(s), with the verb agreeing. */
function queuedMessagesPhrase(count: number): string {
	return count === 1 ? "1 queued message" : `${count} queued messages`;
}

/** The notice the main chat shows when a lost engine's queued messages come back to its editor. */
export function engineLossRestoredNotice(count: number): string {
	return `Engine restarted; ${queuedMessagesPhrase(count)} ${count === 1 ? "wasn't" : "weren't"} sent and ${count === 1 ? "is" : "are"} back in the editor`;
}

/**
 * The messages a lost engine had taken and was delivering when nothing tells whether it saved them: each in full, so
 * one that never arrived can be sent again by hand. None is sent again by itself.
 */
export function engineLossUnconfirmedNotice(messages: readonly string[], agent?: string): string {
	const count = messages.length;
	return [
		`Engine restarted; ${count === 1 ? "this message" : `these ${count} messages`}${agent === undefined ? "" : ` to ${agent}`} may not have been delivered:`,
		...messages,
	].join("\n");
}

/** What a subagent had queued, or had on its way, when the engine that runs it was lost. */
export interface LostSubagentQueue {
	readonly agent: string;
	readonly steering: readonly string[];
	readonly followUp: readonly string[];
}

/** The notice listing, in full and in order, what a subagent had queued when the engine was lost. */
export function engineLossSubagentNotice(queue: LostSubagentQueue): string | undefined {
	const messages = [...queue.steering, ...queue.followUp];
	if (messages.length === 0) return undefined;
	const verb = messages.length === 1 ? "wasn't" : "weren't";
	return [
		`Engine restarted; ${queuedMessagesPhrase(messages.length)} to ${queue.agent} ${verb} sent:`,
		...messages,
	].join("\n");
}

function textOfUserMessage(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	return content
		.flatMap((part: { type?: unknown; text?: unknown }) =>
			part.type === "text" && typeof part.text === "string" ? [part.text] : [],
		)
		.join("");
}

/** The user messages `messages` holds, as text. */
function userMessageTexts(messages: readonly { readonly role: string; readonly content?: unknown }[]): string[] {
	return messages.flatMap((message) => {
		const text = message.role === "user" ? textOfUserMessage(message.content) : undefined;
		return text === undefined ? [] : [text];
	});
}

/** `after` without one copy of each text of `before`: what was added. */
function withoutEach(after: readonly string[], before: readonly string[]): string[] {
	const remaining = new Map<string, number>();
	for (const text of before) remaining.set(text, (remaining.get(text) ?? 0) + 1);
	return after.filter((text) => {
		const count = remaining.get(text) ?? 0;
		if (count === 0) return true;
		remaining.set(text, count - 1);
		return false;
	});
}

/**
 * An isolated engine that is lost and replaced takes its queue with it. The messages the main chat showed as queued
 * come back to its editor, as Alt+Up would restore them, with a notice, unless the replacement's history shows the
 * lost engine delivered them. What it had already taken and was delivering, or showed without saving it, may have been
 * saved: a notice gives each in full, as unconfirmed. (What a shown subagent had queued is listed by
 * `attachLostAgentQueueNotices`.) Nothing is sent again. A deliberate replacement or stop, or a session the engine
 * retires, changes nothing.
 */
InteractiveModeBase.prototype.attachSteeringEngineRecovery = function (this: InteractiveModeBase): () => void {
	const runtime = this.runtimeHost;
	if (!(runtime instanceof IsolatedInteractiveRuntime)) return () => {};
	/** The user messages the chat knew when the engine was lost, while its replacement is pending. */
	let knownAtLoss: string[] | undefined;
	/** What the lost engine was delivering, steering first, each lane in order, while its replacement is pending. */
	let deliveringAtLoss: string[] = [];
	/** User messages whose row the chat showed and whose save (`message_end`) it has not heard of, oldest first. */
	let shownUnsaved: string[] = [];
	let shownUnsavedAtLoss: string[] = [];
	const stopShown = this.session.subscribe((event) => {
		if (event.type === "message_start" && event.message.role === "user") {
			const text = textOfUserMessage(event.message.content);
			if (text !== undefined) shownUnsaved.push(text);
		} else if (event.type === "message_end" && event.message.role === "user") {
			const text = textOfUserMessage(event.message.content);
			const index = text === undefined ? -1 : shownUnsaved.indexOf(text);
			if (index >= 0) shownUnsaved.splice(index, 1);
		} else if (event.type === "agent_end") shownUnsaved = [];
	});
	const stopEnded = runtime.onGenerationEnded((event) => {
		if (event.expected) {
			shownUnsaved = [];
			return;
		}
		mainSteering(this).loseTarget();
		runtime.discardLostQueue();
		const delivering = runtime.takeDeliveringAtLoss();
		if (delivering !== undefined) deliveringAtLoss.push(...delivering.steering, ...delivering.followUp);
		shownUnsavedAtLoss.push(...shownUnsaved);
		shownUnsaved = [];
		knownAtLoss ??= userMessageTexts(this.session.messages);
		this.updatePendingMessagesDisplay();
		this.ui.requestRender();
	});
	// The engine was lost or retired its session: what it was delivering never shows here.
	const stopForgotten = runtime.onQueuedDeliveriesForgotten(() => {
		this.updatePendingMessagesDisplay();
		this.ui.requestRender();
	});
	const stopRecovered = runtime.onEngineRecovered((replaced) => {
		const known = knownAtLoss;
		const delivering = deliveringAtLoss;
		const shown = shownUnsavedAtLoss;
		knownAtLoss = undefined;
		deliveringAtLoss = [];
		shownUnsavedAtLoss = [];
		if (known === undefined) return;
		void (async () => {
			let delivered: string[] | undefined;
			if (replaced) {
				try {
					delivered = withoutEach(await runtime.engineUserMessages(), known);
				} catch {
					// The replacement could not say what it holds: give everything back, nothing is resent.
				}
			}
			// What the lost engine had taken from its queue may have been saved, and answered, whatever its replacement's
			// history shows (a compaction can leave it out, and the engine may have saved it after the chat's last line):
			// it is listed in full as unconfirmed, neither given back nor sent again. So is a message whose row was shown
			// but whose save the chat never heard of. The replacement's history only accounts for what the chat still listed.
			const remaining = delivered === undefined ? undefined : withoutEach(delivered, [...shown, ...delivering]);
			const unconfirmed = [...shown, ...delivering];
			const messages = mainSteering(this).recoverTarget(remaining ?? []) ?? [];
			if (unconfirmed.length > 0) this.showWarning(engineLossUnconfirmedNotice(unconfirmed));
			if (messages.length === 0) {
				if (unconfirmed.length > 0) this.ui.requestRender();
				return;
			}
			// Main's prompt, whatever the screen shows by the time the replacement answers.
			const prompt = promptHandle(this, "main");
			prompt.setText(combineQueuedMessagesForEditor(messages, prompt.getExpandedText()));
			this.updatePendingMessagesDisplay();
			this.showWarning(engineLossRestoredNotice(messages.length));
			this.ui.requestRender();
		})();
	});
	return () => {
		stopShown();
		stopEnded();
		stopForgotten();
		stopRecovered();
	};
};
