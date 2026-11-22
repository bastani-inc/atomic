/**
 * A queued message from the moment its turn takes it out of the session's queue until its own `message_start`
 * reaches the session's listeners. Between the two, the session runs the extensions' `message_start` hooks, and the
 * `queue_update` it sent when the turn took the message already lists the queue without it. A chat keeps showing such
 * a message as queued until its own row is in the transcript, so the message is never off screen.
 *
 * Nothing here changes a public event or its order. Only deliveries still under way are reachable: an event a listener
 * keeps reaches the session's deliveries in flight, never the text of one that ended, and each `queue_update` records a
 * number, not a copy. An isolated engine tells its host about them with {@link QueuedDeliveryRelay}: each message's
 * text crosses once, when a `queue_update` first names it, and its end crosses as a count.
 */
export interface QueuedMessageDelivery {
	readonly lane: "steer" | "followUp";
	readonly text: string;
	/** Its place in the order the session's turns took messages. */
	readonly order: number;
	/** How its save can be found in the session's store after the engine delivering it is lost. */
	readonly receipt?: QueuedMessageReceipt;
}

/**
 * How a queued message's save is found in its session's store: the message is saved with `id`, and only after the
 * session's stored entries reached `after` (in generation `epoch` of the store), as it was taken after that. `typed` is
 * the text submitted for it, when it is not the text it was queued as.
 */
export interface QueuedMessageReceipt {
	readonly id: string;
	readonly after: number;
	readonly epoch?: string;
	readonly typed?: string;
	/**
	 * The engine that took it writes its session to a local file, so nothing it wrote can land after it exited: only then
	 * can a replacement prove the message was never saved.
	 */
	readonly local?: true;
}

/** Messages per lane, each lane in the order the turns took them. */
export interface QueuedMessageLanes {
	readonly steering: readonly string[];
	readonly followUp: readonly string[];
}

/** The lanes with no message: what every chat draws while nothing is being delivered. */
export const NO_QUEUED_MESSAGES: QueuedMessageLanes = Object.freeze({
	steering: Object.freeze([]),
	followUp: Object.freeze([]),
});

/** One session's deliveries under way, by their order, in the order its turns took them; dropped once none is left. */
interface SessionDeliveries {
	taken: number;
	readonly underWay: Map<number, QueuedMessageDelivery>;
	/** The texts under way per lane, kept until the next delivery begins or ends, so an unchanged one is the same. */
	lanes?: QueuedMessageLanes;
}

/** The deliveries a `queue_update` lists: those of `session` the turns had taken when it was sent, while under way. */
export interface QueueUpdateDeliveries {
	readonly session: SessionDeliveries;
	readonly through: number;
}

const sessions = new WeakMap<object, SessionDeliveries>();
const listedWith = new WeakMap<object, QueueUpdateDeliveries>();
/** Every delivery under way, whichever session it belongs to. */
const underWay = new WeakSet<QueuedMessageDelivery>();

/** The turn took `text` out of `session`'s `lane` queue; its `message_start` has not reached the listeners yet. */
export function beginQueuedMessageDelivery(
	session: object,
	lane: QueuedMessageDelivery["lane"],
	text: string,
	receipt?: QueuedMessageReceipt,
): QueuedMessageDelivery {
	let deliveries = sessions.get(session);
	if (deliveries === undefined) {
		deliveries = { taken: 0, underWay: new Map() };
		sessions.set(session, deliveries);
	}
	const delivery: QueuedMessageDelivery = {
		lane,
		text,
		order: ++deliveries.taken,
		...(receipt === undefined ? {} : { receipt }),
	};
	deliveries.underWay.set(delivery.order, delivery);
	deliveries.lanes = undefined;
	underWay.add(delivery);
	return delivery;
}

/**
 * The message's `message_start` is reaching the listeners now, or never will (a hook failed, or the session already
 * shows the input): it is no longer under way.
 */
export function endQueuedMessageDelivery(session: object, delivery: QueuedMessageDelivery | undefined): void {
	if (delivery === undefined) return;
	const deliveries = sessions.get(session);
	if (deliveries?.underWay.get(delivery.order) !== delivery) return;
	deliveries.underWay.delete(delivery.order);
	deliveries.lanes = undefined;
	underWay.delete(delivery);
	// A later delivery starts a new record, which an event sent before it never reaches.
	if (deliveries.underWay.size === 0) sessions.delete(session);
}

/** Record with `event`, a `queue_update` `session` is about to send, which deliveries are under way now. */
export function noteQueueUpdateDeliveries(session: object, event: object): void {
	const deliveries = sessions.get(session);
	if (deliveries !== undefined) listedWith.set(event, { session: deliveries, through: deliveries.taken });
}

/** The deliveries `event`, a `queue_update`, lists; undefined when none was under way as it was sent. */
export function queueUpdateDeliveries(event: object): QueueUpdateDeliveries | undefined {
	return listedWith.get(event);
}

/** The texts of `lane` that `listed` still has under way, in the order the turns took them. */
export function queuedTextsUnderWay(
	listed: QueueUpdateDeliveries | undefined,
	lane: QueuedMessageDelivery["lane"],
): string[] {
	if (listed === undefined) return [];
	const texts: string[] = [];
	for (const delivery of listed.session.underWay.values())
		if (delivery.lane === lane && delivery.order <= listed.through) texts.push(delivery.text);
	return texts;
}

/** The receipts of `lane`'s messages `listed` still has under way, as {@link queuedTextsUnderWay} lists their texts. */
export function queuedReceiptsUnderWay(
	listed: QueueUpdateDeliveries | undefined,
	lane: QueuedMessageDelivery["lane"],
): (QueuedMessageReceipt | undefined)[] {
	if (listed === undefined) return [];
	const receipts: (QueuedMessageReceipt | undefined)[] = [];
	for (const delivery of listed.session.underWay.values())
		if (delivery.lane === lane && delivery.order <= listed.through) receipts.push(delivery.receipt);
	return receipts;
}

/**
 * Every message `session` is delivering now, per lane. The session's queue lists none of them, so a chat that reads
 * the queue and this at the same moment shows each queued message once. The same object until a delivery begins or
 * ends; {@link NO_QUEUED_MESSAGES} when none is under way.
 */
export function queuedMessagesUnderWay(session: object): QueuedMessageLanes {
	const deliveries = sessions.get(session);
	if (deliveries === undefined) return NO_QUEUED_MESSAGES;
	deliveries.lanes ??= lanesOf(deliveries.underWay.values());
	return deliveries.lanes;
}

/** A message a turn took, as an engine names it to its host, with its receipt when the engine keeps one. */
export interface QueuedDeliveryEntry {
	readonly lane: QueuedMessageDelivery["lane"];
	readonly text: string;
	readonly receipt?: QueuedMessageReceipt;
}

/**
 * The queued messages dropped as a run ended, by its `agent_end` event, until the one that gives them back takes them:
 * only for a session that has one (see {@link keepDroppedQueuedMessages}), so nothing else that keeps the event keeps
 * them.
 */
const droppedAtRunEnd = new WeakMap<object, readonly QueuedDeliveryEntry[]>();
/**
 * Per session, how many take what its runs drop from its queue to give it back to the user: a main chat that shows the
 * session, or the binding that tells an engine's host about it.
 */
const droppedKeepers = new WeakMap<object, number>();

/**
 * What `session`'s runs drop from its queue is given back to the user: its main chat, or its engine's host, takes it
 * from each run's end. Answers the release, which the taker calls once it no longer follows the session.
 */
export function keepDroppedQueuedMessages(session: object): () => void {
	droppedKeepers.set(session, (droppedKeepers.get(session) ?? 0) + 1);
	let kept = true;
	return () => {
		if (!kept) return;
		kept = false;
		const keepers = (droppedKeepers.get(session) ?? 1) - 1;
		if (keepers > 0) droppedKeepers.set(session, keepers);
		else droppedKeepers.delete(session);
	};
}

/** Whether something gives `session`'s dropped queued messages back to the user. */
export function keepsDroppedQueuedMessages(session: object): boolean {
	return droppedKeepers.has(session);
}

/**
 * The run that sends `event`, an `agent_end`, dropped `dropped`: queued messages runs took and lost twice, as they were
 * submitted, which are no longer queued and were never sent.
 */
export function noteQueuedMessagesDropped(event: object, dropped: readonly QueuedDeliveryEntry[]): void {
	droppedAtRunEnd.set(event, dropped);
}

/**
 * Take the queued messages dropped as the run that sent `event`, an `agent_end`, ended; undefined when none was. Taken
 * once: the event holds them no longer.
 */
export function takeQueuedMessagesDroppedAt(event: object): readonly QueuedDeliveryEntry[] | undefined {
	const dropped = droppedAtRunEnd.get(event);
	droppedAtRunEnd.delete(event);
	return dropped;
}

/** `copy` is sent in place of `event`, an `agent_end`: what that run's end dropped goes with it instead. */
export function carryDroppedQueuedMessages(event: object, copy: object): void {
	const dropped = droppedAtRunEnd.get(event);
	if (dropped === undefined) return;
	droppedAtRunEnd.delete(event);
	droppedAtRunEnd.set(copy, dropped);
}

/**
 * What changed in the deliveries an engine told its host about: the `ended` oldest of them are no longer under way,
 * then the turns took `taken`, in order. With a run's `agent_end`, `dropped` are the messages that run took and lost a
 * second time, as submitted, which are no longer queued (see `requeueQueuedMessagesNotStarted`).
 */
export interface QueuedDeliveryChange {
	readonly ended?: number;
	readonly taken?: readonly QueuedDeliveryEntry[];
	readonly dropped?: readonly QueuedDeliveryEntry[];
	/** With a queued user message's start, or its save, the receipt id the message is queued (and saved) with. */
	readonly message?: string;
	/** With a user message's start, the host prompt send id it originated from, when the prompt named one. */
	readonly origin?: string;
}

/**
 * The engine's side of the deliveries its host draws for the main chat. With each event it sends, {@link note} answers
 * what the host has to learn: the messages a `queue_update` names that the host was not told about, and how many of the
 * ones it was told about are no longer under way. Deliveries end in the order the turns took them (the session handles
 * their events one at a time), so the ended ones are always the oldest; one that ended out of order is counted once
 * those before it have. Each event costs constant time, apart from the messages it names.
 */
export class QueuedDeliveryRelay {
	/**
	 * The deliveries the host was told about and not told ended, oldest first, from `head` on. A slot before `head` is
	 * cleared as it is passed, so no message ended is kept.
	 */
	private told: (QueuedMessageDelivery | undefined)[] = [];
	private head = 0;
	/** The record of the session's deliveries the host was last told about, and the last order it was told. */
	private toldRecord: SessionDeliveries | undefined;
	private toldThrough = 0;
	private readonly retired = new WeakSet<object>();

	/**
	 * The change to send with `event`, which `session` sends now; undefined when there is none to send with it. `message`
	 * is the receipt id of the queued user message `event` starts or saves; `origin` is the host prompt send id that
	 * originated the user message `event` starts.
	 */
	note(
		session: object,
		event: { readonly type: string },
		message?: string,
		origin?: string,
	): QueuedDeliveryChange | undefined {
		// Before it is written, a newer update of the same tool call can replace a tool update, and a change with it.
		// Taken from a run's end even when it is not sent, so the event holds them no longer.
		const dropped = event.type === "agent_end" ? (takeQueuedMessagesDroppedAt(event) ?? []) : [];
		if (event.type === "tool_execution_update" || this.retired.has(session)) return undefined;
		const start = this.head;
		for (let next = this.told[this.head]; next !== undefined && !underWay.has(next); next = this.told[this.head]) {
			this.told[this.head] = undefined;
			this.head++;
		}
		const ended = this.head - start;
		const taken = event.type === "queue_update" ? this.newlyListed(event) : [];
		// Drop the told ones that ended once they are most of the list: each delivery is moved at most once.
		if (this.head > 0 && this.head * 2 >= this.told.length) {
			this.told = this.told.slice(this.head);
			this.head = 0;
		}
		for (const delivery of taken) this.told.push(delivery);
		if (ended === 0 && taken.length === 0 && dropped.length === 0 && message === undefined && origin === undefined)
			return undefined;
		return {
			...(message === undefined ? {} : { message }),
			...(origin === undefined ? {} : { origin }),
			...(ended > 0 ? { ended } : {}),
			...(taken.length > 0
				? {
						taken: taken.map(({ lane, text, receipt }) => ({
							lane,
							text,
							...(receipt === undefined ? {} : { receipt }),
						})),
					}
				: {}),
			...(dropped.length > 0 ? { dropped: dropped.map(({ lane, text }) => ({ lane, text })) } : {}),
		};
	}

	/** The deliveries `event`, a `queue_update`, lists that the host was not told about, oldest first. */
	private newlyListed(event: object): QueuedMessageDelivery[] {
		const listed = listedWith.get(event);
		if (listed === undefined) return [];
		if (listed.session !== this.toldRecord) {
			this.toldRecord = listed.session;
			this.toldThrough = 0;
		}
		const taken: QueuedMessageDelivery[] = [];
		for (let order = this.toldThrough + 1; order <= listed.through; order++) {
			const delivery = listed.session.underWay.get(order);
			if (delivery !== undefined) taken.push(delivery);
		}
		this.toldThrough = Math.max(this.toldThrough, listed.through);
		return taken;
	}

	/**
	 * `session` is being replaced, and the host forgets every delivery it was told about. Its events from now on carry no
	 * change: the host shows the replacement.
	 */
	retire(session: object): void {
		this.retired.add(session);
		this.told = [];
		this.head = 0;
		this.toldRecord = undefined;
		this.toldThrough = 0;
	}
}

/** The end a line brought, kept until its event reaches the chat; it holds a count, never a message. */
export interface QueuedDeliveryEnd {
	readonly ended: number;
	/** The view's reset count when the line was read: an end read before a reset never applies. */
	readonly resets: number;
}

/**
 * A host's view of what its engine's main session is delivering: the messages the engine said its turns took, oldest
 * first, each until the event that ends it reaches the chat. A line's taken messages join when the host reads it, with
 * the cached queue that no longer lists them; its ended count waits for its event, which may be held back from the chat
 * (a compaction's end holds later events until the session view caught up), so a message leaves in the step its own
 * row is drawn. Losing the engine or its retiring the session forgets everything at once.
 */
export class QueuedDeliveryView {
	private entries: readonly QueuedDeliveryEntry[] = [];
	private lanes: QueuedMessageLanes = NO_QUEUED_MESSAGES;
	private resets = 0;

	/** The messages being delivered, per lane; the same object until they change. */
	get texts(): QueuedMessageLanes {
		return this.lanes;
	}

	/** The messages being delivered, oldest first, with their receipts. */
	get underWay(): readonly QueuedDeliveryEntry[] {
		return this.entries;
	}

	/** A line brought `change`: what it took joins now; its end, returned, applies when its event reaches the chat. */
	receive(change: QueuedDeliveryChange): QueuedDeliveryEnd | undefined {
		if (change.taken !== undefined && change.taken.length > 0) this.set([...this.entries, ...change.taken]);
		return change.ended === undefined || change.ended === 0
			? undefined
			: { ended: change.ended, resets: this.resets };
	}

	/** The event that carried `end` reaches the chat now: the oldest messages it ended leave. Answers them. */
	end(end: QueuedDeliveryEnd): readonly QueuedDeliveryEntry[] {
		if (end.resets !== this.resets) return [];
		const ended = this.entries.slice(0, end.ended);
		this.set(this.entries.slice(end.ended));
		return ended;
	}

	/** Forget every message; an end read before now never applies. Answers whether any was listed. */
	reset(): boolean {
		this.resets++;
		if (this.entries.length === 0) return false;
		this.set([]);
		return true;
	}

	private set(entries: readonly QueuedDeliveryEntry[]): void {
		this.entries = entries;
		this.lanes = lanesOf(entries);
	}
}

function lanesOf(deliveries: Iterable<QueuedDeliveryEntry>): QueuedMessageLanes {
	const steering: string[] = [];
	const followUp: string[] = [];
	for (const delivery of deliveries) (delivery.lane === "steer" ? steering : followUp).push(delivery.text);
	return steering.length === 0 && followUp.length === 0 ? NO_QUEUED_MESSAGES : { steering, followUp };
}

/**
 * The field of an engine's event line that carries a change in deliveries. An engine writes it only for a host that
 * asked for it when it started the engine, so a host of an earlier version never receives it.
 */
const CHANGE_FIELD = "atomicQueuedDeliveries";

/** `record`, an event line an engine writes, with `change` when there is one. */
export function withQueuedDeliveryChange(record: object, change: QueuedDeliveryChange | undefined): object {
	return change === undefined ? record : { ...record, [CHANGE_FIELD]: change };
}

/**
 * Take the change in deliveries off `event`, an event line the host read from its engine, before anything else sees
 * the event: its listeners get it as the engine's session sent it, and keeping it keeps no message text.
 */
export function takeQueuedDeliveryChange(event: object): QueuedDeliveryChange | undefined {
	if (!(CHANGE_FIELD in event)) return undefined;
	const data = event as { [CHANGE_FIELD]?: unknown };
	const change = parseQueuedDeliveryChange(data[CHANGE_FIELD]);
	delete data[CHANGE_FIELD];
	return change;
}

/** `value` as a change in deliveries, as an engine writes one; undefined for anything else. */
function parseQueuedDeliveryChange(value: unknown): QueuedDeliveryChange | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const { ended, taken, dropped, message, origin } = value as {
		ended?: unknown;
		taken?: unknown;
		dropped?: unknown;
		message?: unknown;
		origin?: unknown;
	};
	if (ended !== undefined && !(typeof ended === "number" && Number.isSafeInteger(ended) && ended >= 0))
		return undefined;
	if (message !== undefined && typeof message !== "string") return undefined;
	if (origin !== undefined && typeof origin !== "string") return undefined;
	const entries = parseQueuedDeliveryEntries(taken);
	const droppedEntries = parseQueuedDeliveryEntries(dropped);
	if (entries === undefined || droppedEntries === undefined) return undefined;
	return {
		...(typeof ended === "number" && ended > 0 ? { ended } : {}),
		...(entries.length > 0 ? { taken: entries } : {}),
		...(droppedEntries.length > 0 ? { dropped: droppedEntries } : {}),
		...(message === undefined ? {} : { message }),
		...(origin === undefined ? {} : { origin }),
	};
}

/** `value`, absent or a list of messages with their lanes, as an engine writes one; undefined for anything else. */
function parseQueuedDeliveryEntries(value: unknown): QueuedDeliveryEntry[] | undefined {
	if (value !== undefined && !Array.isArray(value)) return undefined;
	const entries: QueuedDeliveryEntry[] = [];
	for (const entry of (value as unknown[] | undefined) ?? []) {
		if (typeof entry !== "object" || entry === null) return undefined;
		const { lane, text, receipt } = entry as { lane?: unknown; text?: unknown; receipt?: unknown };
		if ((lane !== "steer" && lane !== "followUp") || typeof text !== "string") return undefined;
		const parsed = parseQueuedMessageReceipt(receipt);
		entries.push(parsed === undefined ? { lane, text } : { lane, text, receipt: parsed });
	}
	return entries;
}

/** `value` as a receipt, as an engine writes one; undefined for anything else, which leaves the message without one. */
function parseQueuedMessageReceipt(value: unknown): QueuedMessageReceipt | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { id, after, epoch, typed, local } = value as {
		id?: unknown;
		after?: unknown;
		epoch?: unknown;
		typed?: unknown;
		local?: unknown;
	};
	if (typeof id !== "string" || !(typeof after === "number" && Number.isSafeInteger(after) && after >= 0))
		return undefined;
	if ((epoch !== undefined && typeof epoch !== "string") || (typed !== undefined && typeof typed !== "string"))
		return undefined;
	return {
		id,
		after,
		...(epoch === undefined ? {} : { epoch }),
		...(typed === undefined ? {} : { typed }),
		...(local === true ? { local } : {}),
	};
}
