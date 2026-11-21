import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { ImageContent, TextContent } from "@bastani/atomic-ai/compat";
import { commitAdmittedCustomMessage, commitAdmittedCustomMessages } from "./agent-session-custom-message-commit.ts";
import { holdsTurnsForDetachedResults } from "./agent-session-detached-tools.ts";
import { wakeIdleSessionForHeartbeat } from "./agent-session-heartbeat-wake.ts";
import { cancelHeldInput, heldInputView } from "./agent-session-held-input.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { noteMessageSaved, recordPersistenceFailure } from "./agent-session-persistence-failures.ts";
import {
	confirmCustomMessageWrite,
	hasUncertainCustomMessageWrite,
	isProtectedStreamingCustomMessage,
	markCustomMessageDisplayed,
	recordFailedCustomMessageWrite,
	refreshFailedCustomMessageWrites,
	restoreProtectedStreamingCustomMessages,
} from "./agent-session-persistent-custom-messages.ts";
import { markQueuedMessageImages, waitForCustomMessagePreparation } from "./agent-session-prompt.ts";
import {
	abort,
	interruptTurn,
	pauseQueuedMessages,
	pauseTurn,
	resumeQueuedMessages,
	resumeTurn,
} from "./agent-session-queue-pause.ts";
import { abortTurnRetries } from "./agent-session-retry.ts";
import {
	forgetAllTypedQueuedTexts,
	forgetTypedQueuedRecord,
	forgetTypedQueuedText,
	type QueueLane,
	rememberTypedQueuedText,
	restoreTypedQueuedText,
	type TypedQueuedText,
} from "./agent-session-typed-queue.ts";
import {
	type AgentQueueAccess,
	type ClearedQueue,
	type ClearQueueOptions,
	customMessageExcludesContext,
	type DrainedAgentQueues,
	drainAgentMessageQueue,
	type InterruptQueueHold,
	normalizeInterruptAbortMessage,
	priorityHoldCounts,
	type UserMessageWithRawText,
} from "./agent-session-types.js";
import { noticeOvertookPrompt } from "./chat-admission-order.js";
import { joinCommandSend, noteCommandAnswer } from "./command-deliveries.ts";
import type { SendMessageOptions, SendMessagesOptions } from "./extensions/index.js";
import type { CustomMessage, StageAdmittedCustomMessage } from "./messages.ts";
import {
	beginQueuedMessageDelivery,
	endQueuedMessageDelivery,
	keepsDroppedQueuedMessages,
	noteQueuedMessagesDropped,
	type QueuedDeliveryEntry,
	type QueuedMessageDelivery,
	type QueuedMessageReceipt,
} from "./queued-message-delivery.ts";
import { writesEndWithWriter } from "./queued-message-receipts.ts";
import { withOwnResourceAdmission } from "./resource-admission-scope.ts";
import {
	assertSessionOpen,
	sessionGenerationClosing,
	sessionLifetime,
	trackSessionWork,
} from "./session-lifecycle-work.ts";
import { checkedCustomMessage } from "./session-manager-entries.ts";
import { settingsWriteOwner } from "./settings-write-ownership.ts";
import { parseSlashCommand } from "./slash-commands.js";

const interruptMutationQueues = new WeakMap<AgentSession, Promise<void>>();

function serializeInterruptMutation(owner: AgentSession, operation: () => Promise<void>): Promise<void> {
	const previous = interruptMutationQueues.get(owner) ?? Promise.resolve();
	const delivery = previous.then(operation);
	interruptMutationQueues.set(
		owner,
		delivery.catch(() => undefined),
	);
	return delivery;
}

const laneImages = new WeakMap<AgentMessage, ImageContent[] | undefined>();

function rememberLaneMessage(message: AgentMessage, images: ImageContent[] | undefined): void {
	laneImages.set(message, images?.length ? [...images] : undefined);
}

function queuedTextImages(texts: readonly string[], removed: readonly AgentMessage[]): (ImageContent[] | undefined)[] {
	const images = removed.flatMap((message) => (laneImages.has(message) ? [laneImages.get(message)] : []));
	const firstQueuedIndex = images.length - texts.length;
	return texts.map((_, index) => images[firstQueuedIndex + index]);
}

/**
 * A message the user queued in a lane, from the moment it is queued until its `message_start` reaches the session:
 * listed by its text while it waits in the queue; once a run takes it, under way with its delivery (#6080), and no
 * longer listed or taken back by `clearQueue()`. It is the queued message object itself that names it, so another
 * message with the same text, such as a prompt sent meanwhile, never takes its place.
 */
interface QueuedOccurrence {
	readonly lane: QueueLane;
	readonly text: string;
	/** The id it is saved with: a host that loses the engine delivering it finds its save by it. */
	readonly receiptId: string;
	/** The text that was submitted for it, kept for `clearQueue()` while it is queued. */
	typed: TypedQueuedText;
	/** A run took it once and ended before starting it, and it was queued again: it is not queued again a second time. */
	requeued?: true;
	/** Under way: a run took it from the queue. */
	taken?: {
		readonly delivery: QueuedMessageDelivery | undefined;
		/** A `queue_update` without it went out as the run took it, before its `message_start`. */
		announced: boolean;
	};
}

const queuedOccurrences = new WeakMap<AgentMessage, QueuedOccurrence>();
/** The receipt id of each queued message, by the message object, until it is saved (its id is saved with it). */
const receiptIds = new WeakMap<AgentMessage, string>();

/** The receipt id `message`, a queued message, is saved with; undefined for any other message. */
export function queuedMessageReceiptId(message: AgentMessage): string | undefined {
	return receiptIds.get(message);
}

/** The receipt of each queued message a run took, by the message object. */
const takenReceipts = new WeakMap<AgentMessage, QueuedMessageReceipt>();

/** The receipt of `message`, a queued message a run took and has not saved; undefined for any other message. */
export function queuedMessageReceipt(message: AgentMessage): QueuedMessageReceipt | undefined {
	return takenReceipts.get(message);
}

/** `message` was saved: nothing needs to find its save any more, so its receipt (and the text it keeps) goes. */
export function forgetQueuedMessageReceipt(message: AgentMessage): void {
	takenReceipts.delete(message);
}
/** Per session, oldest first: the queued messages runs took whose `message_start` has not reached the session. */
const takenNotStarted = new WeakMap<AgentSession, AgentMessage[]>();
/** Runs each session started, counted: a prompt that only starts a turn tells whether one started meanwhile. */
const runsStarted = new WeakMap<AgentSession, number>();

/** A run starts. */
export function queueRunStarted(session: AgentSession): void {
	runsStarted.set(session, (runsStarted.get(session) ?? 0) + 1);
}

/** How many runs the session started so far. */
export function sessionRunsStarted(session: AgentSession): number {
	return runsStarted.get(session) ?? 0;
}

/** Queue `text` in `lane`: listed, then queued for the agent, and only then announced (#4257: listeners may act on it). */
function queueUserText(
	session: AgentSession,
	lane: QueueLane,
	text: string,
	images: ImageContent[] | undefined,
	typed: string | undefined,
	rawText: string | undefined,
	receiptId: string = randomUUID(),
): void {
	assertSessionOpen(session);
	const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
	if (images) {
		content.push(...images);
	}
	const message: UserMessageWithRawText = {
		role: "user",
		content,
		...(rawText !== undefined && rawText !== text ? { rawText } : {}),
		timestamp: Date.now(),
	};
	if (images?.length) markQueuedMessageImages(message);
	rememberLaneMessage(message, images);
	(lane === "steer" ? session._steeringMessages : session._followUpMessages).push(text);
	receiptIds.set(message, receiptId);
	queuedOccurrences.set(message, {
		lane,
		text,
		receiptId,
		typed: rememberTypedQueuedText(session, lane, text, typed),
	});
	session._queueAgentMessage(message, lane);
	// A listener sees the message where it is: a `clearQueue()` it runs at once takes it back for good.
	try {
		session._emitQueueUpdate();
	} catch (error) {
		// The caller is told it was not queued, as before: so it is not. One a listener already handed to a run or took
		// back meanwhile stays where it went, and was queued.
		if (withdrawQueuedMessage(session, message)) throw error;
	}
}

/** The index of the `rank`-th (from 0) `text` in `list`; -1 when there are not that many. */
function nthIndexOf(list: readonly string[], text: string, rank: number): number {
	let seen = 0;
	for (let index = 0; index < list.length; index++)
		if (list[index] === text) {
			if (seen === rank) return index;
			seen++;
		}
	return -1;
}

/** Take `message` back out of the queue it was just put in; false when it is no longer there to take. */
function withdrawQueuedMessage(session: AgentSession, message: AgentMessage): boolean {
	const occurrence = queuedOccurrences.get(message);
	if (occurrence === undefined || occurrence.taken !== undefined) return false;
	let found = false;
	const hold = session._activeInterruptQueueHold;
	for (const held of hold === undefined ? [] : [hold.steering, hold.followUp]) {
		const index = held.indexOf(message);
		if (index >= 0) {
			held.splice(index, 1);
			found = true;
		}
	}
	if (!found) {
		const queued = session._drainQueuedAgentMessages();
		found = queued.steering.includes(message) || queued.followUp.includes(message);
		session._restoreQueuedAgentMessages({
			steering: queued.steering.filter((candidate) => candidate !== message),
			followUp: queued.followUp.filter((candidate) => candidate !== message),
		});
	}
	// A `clearQueue()` a listener ran already took it.
	if (!found) return false;
	queuedOccurrences.delete(message);
	// Its own place: messages a listener queued meanwhile, even with the same text, keep theirs.
	const list = occurrence.lane === "steer" ? session._steeringMessages : session._followUpMessages;
	const index = nthIndexOf(list, occurrence.text, forgetTypedQueuedRecord(session, occurrence.typed));
	if (index >= 0) list.splice(index, 1);
	try {
		session._emitQueueUpdate();
	} catch {
		// The listener's first failure is the one reported.
	}
	return true;
}

/**
 * Queue a steering message (already expanded, no extension command check). `typed` is the text that was submitted,
 * when an `input` hook or an expansion may have changed it; `clearQueue()` gives it back.
 */
export async function _queueSteer(
	this: AgentSession,
	text: string,
	images?: ImageContent[],
	typed?: string,
	rawText?: string,
	receiptId?: string,
): Promise<void> {
	queueUserText(this, "steer", text, images, typed, rawText, receiptId);
}

/**
 * Internal: Queue a follow-up message (already expanded, no extension command check). `typed` is as for `_queueSteer`.
 */
export async function _queueFollowUp(
	this: AgentSession,
	text: string,
	images?: ImageContent[],
	typed?: string,
	rawText?: string,
	receiptId?: string,
): Promise<void> {
	queueUserText(this, "followUp", text, images, typed, rawText, receiptId);
}

/** A run takes the queued `message` now: it leaves the list and is under way until its `message_start`. */
function takeOccurrence(session: AgentSession, message: AgentMessage): QueuedOccurrence | undefined {
	const occurrence = queuedOccurrences.get(message);
	if (occurrence === undefined || occurrence.taken !== undefined) return occurrence;
	const list = occurrence.lane === "steer" ? session._steeringMessages : session._followUpMessages;
	const index = nthIndexOf(list, occurrence.text, forgetTypedQueuedRecord(session, occurrence.typed));
	if (index >= 0) list.splice(index, 1);
	const receipt = index >= 0 ? takenReceipt(session, occurrence) : undefined;
	if (receipt !== undefined) takenReceipts.set(message, receipt);
	occurrence.taken = {
		delivery:
			receipt !== undefined
				? beginQueuedMessageDelivery(session, occurrence.lane, occurrence.text, receipt)
				: undefined,
		announced: false,
	};
	return occurrence;
}

/**
 * The receipt of `occurrence`, taken now: it can only be saved after every entry the session's store holds now, so a
 * search for its save after a lost engine starts after them.
 */
function takenReceipt(session: AgentSession, occurrence: QueuedOccurrence): QueuedMessageReceipt {
	const manager = session.sessionManager;
	const epoch = manager.getHistoryEpoch();
	const typed = occurrence.typed.typed;
	return {
		id: occurrence.receiptId,
		after: manager.getLastSeq(),
		...(epoch === undefined ? {} : { epoch }),
		...(typed === occurrence.text ? {} : { typed }),
		...(writesEndWithWriter(manager.getSessionStore()) ? { local: true as const } : {}),
	};
}

/**
 * Tell the session when a run takes queued messages: from then on they are under way, shown as being delivered and
 * never given back to the editor, since the run delivers them whatever is cleared meanwhile.
 */
export function installQueuedMessageTaking(session: AgentSession): void {
	session.agent.onQueuedMessagesTaken = (messages) => {
		const taken: QueuedOccurrence[] = [];
		for (const message of messages) {
			const occurrence = queuedOccurrences.get(message);
			if (occurrence === undefined || occurrence.taken !== undefined) continue;
			takeOccurrence(session, message);
			const pending = takenNotStarted.get(session) ?? [];
			pending.push(message);
			takenNotStarted.set(session, pending);
			taken.push(occurrence);
		}
		if (taken.length === 0) return;
		// Announced once, now: its `message_start` does not announce it again.
		for (const occurrence of taken) if (occurrence.taken !== undefined) occurrence.taken.announced = true;
		session._emitQueueUpdate();
	};
}

/**
 * The `message_start` of `message` reaches the session: when it is a queued message, it is no longer queued or waiting
 * to start. Answers its text and its delivery, which ends as its `message_start` reaches the listeners.
 */
export function startQueuedMessage(
	session: AgentSession,
	message: AgentMessage,
):
	| { readonly text: string; readonly delivery: QueuedMessageDelivery | undefined; readonly announced: boolean }
	| undefined {
	const occurrence = takeOccurrence(session, message);
	if (occurrence === undefined) return undefined;
	queuedOccurrences.delete(message);
	const pending = takenNotStarted.get(session);
	const index = pending?.indexOf(message) ?? -1;
	if (pending !== undefined && index >= 0) {
		pending.splice(index, 1);
		if (pending.length === 0) takenNotStarted.delete(session);
	}
	const taken = occurrence.taken;
	return taken?.delivery === undefined
		? undefined
		: { text: occurrence.text, delivery: taken.delivery, announced: taken.announced };
}

/**
 * The run ended (`runEnd` is its `agent_end`): queued messages it took and never started (its turn preparation failed,
 * or it stopped first) are queued again, at the front of their lanes in the order they were queued, with the text that
 * was submitted for them, so they are delivered or taken back like any other queued message: the queue goes on as it
 * does after any failed run. One that a run already took and lost once is not queued again but dropped, so a run that
 * keeps failing before it starts it never repeats it; `runEnd` tells which, as submitted, for a chat to give back.
 */
export function requeueQueuedMessagesNotStarted(session: AgentSession, runEnd?: object): void {
	const pending = takenNotStarted.get(session);
	if (pending === undefined) return;
	takenNotStarted.delete(session);
	const back: Record<QueueLane, AgentMessage[]> = { steer: [], followUp: [] };
	const typed: TypedQueuedText[] = [];
	const dropped: QueuedDeliveryEntry[] = [];
	for (const message of pending) {
		const occurrence = queuedOccurrences.get(message);
		if (occurrence?.taken === undefined) continue;
		const listed = occurrence.taken.delivery !== undefined;
		endQueuedMessageDelivery(session, occurrence.taken.delivery);
		occurrence.taken = undefined;
		// Taken and lost once already, or no longer listed when it was taken: not queued again.
		if (occurrence.requeued || !listed) {
			queuedOccurrences.delete(message);
			// Never started, so never saved: a chat can give it back to be sent again by hand.
			if (listed) dropped.push({ lane: occurrence.lane, text: occurrence.typed.typed });
			continue;
		}
		occurrence.requeued = true;
		back[occurrence.lane].push(message);
		typed.push(occurrence.typed);
	}
	if (runEnd !== undefined && dropped.length > 0 && keepsDroppedQueuedMessages(session))
		noteQueuedMessagesDropped(runEnd, dropped);
	if (back.steer.length === 0 && back.followUp.length === 0) return;
	const textsOf = (messages: readonly AgentMessage[]) =>
		messages.map((message) => queuedOccurrences.get(message)?.text ?? "");
	session._steeringMessages.unshift(...textsOf(back.steer));
	session._followUpMessages.unshift(...textsOf(back.followUp));
	for (const record of typed.reverse()) restoreTypedQueuedText(session, record);
	const hold = session._activeInterruptQueueHold;
	if (hold !== undefined) {
		// After the priority messages an interrupt put at the front, as they were queued.
		hold.steering.splice(priorityHoldCounts.get(hold) ?? 0, 0, ...back.steer);
		hold.followUp.unshift(...back.followUp);
	} else {
		const queued = session._drainQueuedAgentMessages();
		session._restoreQueuedAgentMessages({
			steering: [...back.steer, ...queued.steering],
			followUp: [...back.followUp, ...queued.followUp],
		});
	}
	session._emitQueueUpdate();
}

/**
 * Throw an error if the text is an extension command.
 */

export function _throwIfExtensionCommand(this: AgentSession, text: string): void {
	const commandName = parseSlashCommand(text).name;
	const command = this._extensionRunner.getCommand(commandName);

	if (command) {
		throw new Error(
			`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
		);
	}
}

/**
 * Send a custom message to the session. Creates a CustomMessageEntry.
 *
 * Handles five cases:
 * - Streaming + interrupt trigger: aborts the active run and starts an immediate custom-message turn
 * - Streaming + explicit display-only context exclusion: appends to state/session, no turn and no queue
 * - Streaming otherwise: queues message, processed when loop pulls from queue
 * - Not streaming + triggerTurn: appends to state/session, starts new turn
 * - Not streaming + no trigger: appends to state/session, no turn
 *
 * @param message Custom message with customType, content, display, details
 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
 * @param options.deliverAs Delivery mode: "steer", "followUp", "nextTurn", or "interrupt"
 */

export function sendCustomMessage<T = unknown>(
	this: AgentSession,
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
	options?: SendMessageOptions,
): Promise<void> {
	// #6113: print mode waits for what an extension command sends before it prints and closes the session.
	return joinCommandSend(this, () => sendCustomMessageNow.call(this, message, options));
}

async function sendCustomMessageNow<T>(
	this: AgentSession,
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
	options?: SendMessageOptions,
): Promise<void> {
	assertSessionOpen(this);
	const checked = checkedCustomMessage(message);
	return deliveredMessageTurn(this, () => {
		const waking = wakeIdleSessionForHeartbeat(this, options);
		return waking
			? waking.then(() => admittedCustomMessage.call(this, checked, options))
			: admittedCustomMessage.call(this, checked, options);
	});
}

/**
 * A delivered message starts this session's turn, so the turn runs under this session's own resource admission, or
 * none: never under the scope its sender runs in.
 */
function deliveredMessageTurn<T>(session: AgentSession, deliver: () => Promise<T>): Promise<T> {
	return withOwnResourceAdmission(session._resourceAdmission, () => trackSessionWork(session, deliver));
}

async function admittedCustomMessage<T>(
	this: AgentSession,
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
	options?: SendMessageOptions,
): Promise<void> {
	const lifetime = sessionLifetime(this);
	const appMessage = {
		role: "custom" as const,
		customType: message.customType,
		content: message.content ?? [],
		display: message.display,
		details: message.details,
		timestamp: Date.now(),
		...(options?.excludeFromContext === true ? { excludeFromContext: true } : {}),
		...(options?.stageAdmissionKey === undefined ? {} : { stageAdmissionKey: options.stageAdmissionKey }),
	} satisfies CustomMessage<T> & { stageAdmissionKey?: string };
	const boundary = this._subagentMessageAdmission;
	const commit = async (): Promise<void> => {
		if (boundary && options?.stageAdmissionBarrier) await options.stageAdmissionBarrier();
		assertSessionOpen(this);
		if (lifetime.aborted) throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });
		await commitAdmittedCustomMessage(this, appMessage, options);
	};
	// Event hooks may await non-triggering writes while protected input awaits the
	// event writer. Those local writes must not queue behind that external input.
	const deliver = () =>
		boundary && options?.triggerTurn === true ? boundary.serializeMessageDelivery(commit) : commit();
	if (boundary === undefined) return deliver();
	await boundary.admit(options?.stageAdmissionKey, deliver, () => {
		throw new Error("Subagent execution is terminal and cannot accept messages");
	});
}

/** Atomically admits a custom-message batch in array order. */
export function sendCustomMessages<T = unknown>(
	this: AgentSession,
	messages: Array<Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">>,
	options?: SendMessagesOptions,
): Promise<void> {
	return joinCommandSend(this, () => sendCustomMessagesNow.call(this, messages, options));
}

async function sendCustomMessagesNow<T>(
	this: AgentSession,
	messages: Array<Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">>,
	options?: SendMessagesOptions,
): Promise<void> {
	assertSessionOpen(this);
	const checked = messages.map((message) => checkedCustomMessage(message));
	return deliveredMessageTurn(this, () => admittedCustomMessages.call(this, checked, options));
}

async function admittedCustomMessages<T>(
	this: AgentSession,
	messages: Array<Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">>,
	options?: SendMessagesOptions,
): Promise<void> {
	const lifetime = sessionLifetime(this);
	const timestamp = Date.now();
	const appMessages = messages.map((message, index) => {
		const stageAdmissionKey = options?.stageAdmissionKeys?.[index] ?? options?.stageAdmissionKey;
		return {
			role: "custom" as const,
			customType: message.customType,
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp,
			...(options?.excludeFromContext === true ? { excludeFromContext: true } : {}),
			...(stageAdmissionKey === undefined ? {} : { stageAdmissionKey }),
		} satisfies CustomMessage<T> & { stageAdmissionKey?: string };
	});
	if (appMessages.length === 0) return;
	const boundary = this._subagentMessageAdmission;
	const commit = async (): Promise<void> => {
		if (boundary && options?.stageAdmissionBarrier) await options.stageAdmissionBarrier();
		assertSessionOpen(this);
		if (lifetime.aborted) throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });
		await commitAdmittedCustomMessages(this, appMessages, options);
	};
	const deliver = () =>
		boundary && options?.triggerTurn === true ? boundary.serializeMessageDelivery(commit) : commit();
	if (boundary === undefined) return deliver();
	await boundary.admit(options?.stageAdmissionKey, deliver, () => {
		throw new Error("Subagent execution is terminal and cannot accept messages");
	});
}

const pendingCustomMessageSaves = new WeakMap<CustomMessage, PromiseWithResolvers<void>>();

/**
 * A custom message keyed `stageAdmissionKey` that waits in memory for the current turn to end, and a promise that
 * settles once it is saved in the session; undefined when no such message waits (#5047).
 */
export function pendingCustomMessageSaved(session: AgentSession, stageAdmissionKey: string): Promise<void> | undefined {
	const message = session._pendingCustomMessages.find(
		(candidate) => (candidate as StageAdmittedCustomMessage).stageAdmissionKey === stageAdmissionKey,
	);
	if (message === undefined) return undefined;
	const saved = pendingCustomMessageSaves.get(message) ?? Promise.withResolvers<void>();
	pendingCustomMessageSaves.set(message, saved);
	return saved.promise;
}

export async function _appendCustomMessage<T>(this: AgentSession, message: CustomMessage<T>): Promise<void> {
	const stageAdmissionMessage = message as StageAdmittedCustomMessage;
	const manager = this.sessionManager;
	const key = stageAdmissionMessage.stageAdmissionKey;
	const refresh = refreshFailedCustomMessageWrites(this);
	if (refresh !== undefined) await refresh;
	let entryId =
		key === undefined || !hasUncertainCustomMessageWrite(manager, key)
			? undefined
			: manager
					.getBranch()
					.find(
						(entry) =>
							entry.type === "custom_message" &&
							entry.stageAdmissionKey === key &&
							entry.protectedReconciliation === undefined,
					)?.id;
	if (entryId === undefined) {
		try {
			entryId = await manager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
				customMessageExcludesContext(message),
				undefined,
				key,
			);
		} catch (error) {
			if (key !== undefined) recordFailedCustomMessageWrite(manager, error, key);
			throw error;
		}
	}
	confirmCustomMessageWrite(manager, key);
	if (message.display && customMessageExcludesContext(message)) noticeOvertookPrompt(this, entryId);
	this._entryIdsByMessage.set(message, entryId);
	noteMessageSaved(this, message);
	pendingCustomMessageSaves.get(message)?.resolve();
	this._refreshFinalizedContext();
	markCustomMessageDisplayed(this, entryId);
	this._emit({ type: "message_start", message });
	this._emit({ type: "message_end", message });
	noteCommandAnswer(this, message);
}

const pendingCustomMessageDrains = new WeakMap<AgentSession, Promise<void>>();

/**
 * Append context-only custom messages once the current turn's tool results are in history. Within a run, a message
 * that cannot be saved stops the run like any other unsaved message (#4254): it is reported once and stays buffered
 * for the next prompt, and the stopped run saves nothing more.
 */
export function _flushPendingCustomMessages(this: AgentSession, withinRun = false): Promise<void> {
	const pending = pendingCustomMessageDrains.get(this);
	if (pending) return pending;
	if (this._pendingCustomMessages.length === 0) return Promise.resolve();
	if (withinRun && this._persistenceFailure !== undefined) return Promise.resolve();

	const drain = (async () => {
		while (this._pendingCustomMessages.length > 0) {
			const message = this._pendingCustomMessages[0];
			try {
				await this._appendCustomMessage(message);
			} catch (error) {
				// A listener that throws after the message was saved is no save failure; it still fails the turn.
				if (!withinRun || this._entryIdsByMessage.has(message)) throw error;
				recordPersistenceFailure(this, message, error);
				return;
			}
			this._pendingCustomMessages.shift();
		}
	})();
	pendingCustomMessageDrains.set(this, drain);
	void drain.then(
		() => pendingCustomMessageDrains.delete(this),
		() => pendingCustomMessageDrains.delete(this),
	);
	return drain;
}
export function _enqueueInterruptCustomMessage<T>(
	this: AgentSession,
	message: CustomMessage<T>,
	options?: SendMessageOptions,
): Promise<void> {
	assertSessionOpen(this);
	this._pendingInterruptDeliveries += 1;
	// Establish the hold synchronously when the interrupt is enqueued, not when
	// the serialized delivery callback later starts. Callers commonly fire and
	// forget sendCustomMessage(), then queue additional steer/follow-up messages
	// before the promise chain gets a microtask; those messages must be captured
	// in the active interrupt hold instead of pi-agent-core's live queues.
	this._ensureActiveInterruptQueueHold();
	const delivery = trackSessionWork(this, () =>
		this._interruptDeliveryQueue.then(async () => {
			try {
				await this._sendInterruptCustomMessageNow(message, options);
			} finally {
				this._pendingInterruptDeliveries -= 1;
				if (this._pendingInterruptDeliveries === 0) {
					this._restoreAndClearActiveInterruptQueueHold();
				}
			}
		}),
	);
	this._interruptDeliveryQueue = delivery.catch(() => undefined);
	return delivery.finally(async () => {
		if (
			this._subagentMessageAdmission?.isOpen() &&
			this._pendingInterruptDeliveries === 0 &&
			this._activePromptCount === 0 &&
			!this.isStreaming &&
			!this._disposed &&
			!sessionGenerationClosing.has(this) &&
			!sessionLifetime(this).aborted
		) {
			await this._runAgentContinuation(async () => {}, "settle");
		} else if (this._pendingInterruptDeliveries === 0 && this._activePromptCount === 0 && !this.isStreaming) {
			this._subagentPolicy?.onTurnDrained?.();
		}
	});
}

async function sendInterruptCustomMessageUnlocked<T>(
	session: AgentSession,
	message: CustomMessage<T>,
	options?: SendMessageOptions,
): Promise<void> {
	assertSessionOpen(session);
	const lifetime = sessionLifetime(session);
	abortTurnRetries.call(session);
	session._ensureActiveInterruptQueueHold();
	await waitForCustomMessagePreparation(session);
	if (session.isStreaming || session._isPreparingRun) {
		const previousAbortMessage = session._activeInterruptAbortMessage;
		session._activeInterruptAbortMessage = normalizeInterruptAbortMessage(options?.interruptAbortMessage);
		try {
			session.agent.abort();
			await session.agent.waitForIdle();
			await session._agentEventQueue;
		} finally {
			session._activeInterruptAbortMessage = previousAbortMessage;
		}
	}
	assertSessionOpen(session);
	if (lifetime.aborted) throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });
	if (session._queuedMessagesPaused || holdsTurnsForDetachedResults(session)) {
		session._queueAgentMessage(message, "steer");
		return;
	}
	session._abortPreparedRunAtStart = false;
	// The interrupt starts a request, so it passes the same check as a prompt: a context over the trigger is cleared first.
	await session._compactBeforeContinuation([message]);
	assertSessionOpen(session);
	if (lifetime.aborted) throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });
	await session.agent.prompt(message);
}

export function _sendInterruptCustomMessageNow<T>(
	this: AgentSession,
	message: CustomMessage<T>,
	options?: SendMessageOptions,
): Promise<void> {
	return serializeInterruptMutation(this, () => sendInterruptCustomMessageUnlocked(this, message, options));
}

export function _ensureActiveInterruptQueueHold(this: AgentSession): InterruptQueueHold {
	if (this._activeInterruptQueueHold !== undefined) {
		return this._activeInterruptQueueHold;
	}
	const drained = this._drainQueuedAgentMessages();
	this._activeInterruptQueueHold = {
		steering: [...drained.steering],
		followUp: [...drained.followUp],
	};
	return this._activeInterruptQueueHold;
}

export function _restoreAndClearActiveInterruptQueueHold(this: AgentSession): void {
	if (this._queuedMessagesPaused) return;
	const hold = this._activeInterruptQueueHold;
	if (hold === undefined) return;
	const currentCoreQueues = this._drainQueuedAgentMessages();
	this._restoreQueuedAgentMessages({
		steering: [...hold.steering, ...currentCoreQueues.steering],
		followUp: [...hold.followUp, ...currentCoreQueues.followUp],
	});
	this._activeInterruptQueueHold = undefined;
}

export function _queueAgentMessage(
	this: AgentSession,
	message: AgentMessage,
	delivery: "steer" | "followUp" | "interrupt",
): void {
	const hold = delivery === "interrupt" ? this._ensureActiveInterruptQueueHold() : this._activeInterruptQueueHold;
	if (hold !== undefined) {
		if (delivery === "followUp") {
			hold.followUp.push(message);
		} else if (delivery === "interrupt") {
			const index = priorityHoldCounts.get(hold) ?? 0;
			hold.steering.splice(index, 0, message);
			priorityHoldCounts.set(hold, index + 1);
		} else {
			hold.steering.push(message);
		}
	} else if (delivery === "followUp") {
		this.agent.followUp(message);
	} else {
		this.agent.steer(message);
	}
	const yieldReason = message.role === "user" ? "input-needed" : "intercom-coordination";
	this._agentTaskHost?.yieldTaskWaits(yieldReason);
	this._childTaskWaits.yieldAll(yieldReason);
}

export function _drainQueuedAgentMessages(this: AgentSession): DrainedAgentQueues {
	// pi-agent-core exposes public clear methods but no public drain/restore pair.
	// Interrupt and pause holds prevent an aborting run from consuming queued raw
	// messages while preserving every entry for the existing resume boundary.
	const agentWithQueues = this.agent as unknown as AgentQueueAccess;
	return {
		steering: drainAgentMessageQueue(agentWithQueues.steeringQueue),
		followUp: drainAgentMessageQueue(agentWithQueues.followUpQueue),
	};
}

export function _restoreQueuedAgentMessages(this: AgentSession, queues: DrainedAgentQueues): void {
	for (const message of queues.steering) {
		this.agent.steer(message);
	}
	for (const message of queues.followUp) {
		this.agent.followUp(message);
	}
}
/**
 * Clear queued text for editor restoration while retaining optional raw custom entries.
 */
export function clearQueue(this: AgentSession, options?: ClearQueueOptions): ClearedQueue {
	// Input held while the session compacts goes back to the caller too, and is never sent. It is held as typed.
	const held = cancelHeldInput(this);
	const steering = [...this._steeringMessages, ...held.steering];
	const followUp = [...this._followUpMessages, ...held.followUp];
	const typed = {
		steering: [...this._steeringMessages.map((text) => forgetTypedQueuedText(this, "steer", text)), ...held.steering],
		followUp: [
			...this._followUpMessages.map((text) => forgetTypedQueuedText(this, "followUp", text)),
			...held.followUp,
		],
	};
	const retyped =
		typed.steering.some((text, index) => text !== steering[index]) ||
		typed.followUp.some((text, index) => text !== followUp[index]);
	forgetAllTypedQueuedTexts(this);
	const queuedSteering = this._steeringMessages;
	const queuedFollowUp = this._followUpMessages;
	this._steeringMessages = [];
	this._followUpMessages = [];
	const removed = this._drainQueuedAgentMessages();
	const hold = this._activeInterruptQueueHold;
	if (hold !== undefined) {
		removed.steering.push(...hold.steering.splice(0));
		removed.followUp.push(...hold.followUp.splice(0));
		priorityHoldCounts.delete(hold);
	}
	const images = {
		steering: [...queuedTextImages(queuedSteering, removed.steering), ...held.images.steering],
		followUp: [...queuedTextImages(queuedFollowUp, removed.followUp), ...held.images.followUp],
	};
	const withImages = [...images.steering, ...images.followUp].some((entry) => entry !== undefined);
	restoreProtectedStreamingCustomMessages(this, removed);
	if (options?.preserveUnprotectedCustomMessages && hold !== undefined) {
		const restoreUnprotectedCustomMessages = (
			removedMessages: AgentMessage[],
			heldMessages: AgentMessage[],
		): void => {
			const currentlyHeld = [...heldMessages];
			const preserved = removedMessages.filter(
				(message): message is Extract<AgentMessage, { role: "custom" }> =>
					message.role === "custom" && !isProtectedStreamingCustomMessage(this, message),
			);
			if (preserved.length === 0) return;
			const preservedReferences = new Set<AgentMessage>(preserved);
			const restoredProtected = new Set(currentlyHeld);
			const ordered = removedMessages.filter(
				(message) => preservedReferences.has(message) || restoredProtected.has(message),
			);
			const unmatched = currentlyHeld.filter((message) => !ordered.includes(message));
			heldMessages.splice(0, heldMessages.length, ...ordered, ...unmatched);
		};
		restoreUnprotectedCustomMessages(removed.steering, hold.steering);
		restoreUnprotectedCustomMessages(removed.followUp, hold.followUp);
	}
	if (
		!this._queuedMessagesPaused &&
		this._pendingInterruptDeliveries === 0 &&
		hold !== undefined &&
		hold.steering.length === 0 &&
		hold.followUp.length === 0
	) {
		this._activeInterruptQueueHold = undefined;
	}
	this._emitQueueUpdate();
	return {
		steering,
		followUp,
		...(retyped ? { typed } : {}),
		...(withImages ? { images } : {}),
	};
}

/** Number of pending messages (includes both steering and follow-up) */
export function getSteeringMessages(this: AgentSession): readonly string[] {
	const held = heldInputView(this).steering;
	return held.length === 0 ? this._steeringMessages : [...this._steeringMessages, ...held];
}

/** Get pending follow-up messages (read-only) */
export function getFollowUpMessages(this: AgentSession): readonly string[] {
	const held = heldInputView(this).followUp;
	return held.length === 0 ? this._followUpMessages : [...this._followUpMessages, ...held];
}

// =========================================================================
// Model Management
// =========================================================================

export function setSteeringMode(this: AgentSession, mode: "all" | "one-at-a-time"): void {
	this.agent.steeringMode = mode;
	settingsWriteOwner.run(this, () => this.settingsManager.setSteeringMode(mode));
}

/**
 * Set follow-up message mode.
 * Saves to settings.
 */

export function setFollowUpMode(this: AgentSession, mode: "all" | "one-at-a-time"): void {
	this.agent.followUpMode = mode;
	settingsWriteOwner.run(this, () => this.settingsManager.setFollowUpMode(mode));
}

// =========================================================================
// Queue and delivery settings
// =========================================================================
export const agentSessionMessageQueueMethods = {
	_queueSteer,
	_queueFollowUp,
	_throwIfExtensionCommand,
	sendCustomMessage,
	sendCustomMessages,
	_appendCustomMessage,
	_flushPendingCustomMessages,
	_enqueueInterruptCustomMessage,
	_sendInterruptCustomMessageNow,
	_ensureActiveInterruptQueueHold,
	_restoreAndClearActiveInterruptQueueHold,
	pauseQueuedMessages,
	resumeQueuedMessages,
	_queueAgentMessage,
	_drainQueuedAgentMessages,
	_restoreQueuedAgentMessages,
	clearQueue,
	getSteeringMessages,
	getFollowUpMessages,
	abort,
	interruptTurn,
	pauseTurn,
	resumeTurn,
	setSteeringMode,
	setFollowUpMode,
};
