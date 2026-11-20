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
): QueuedMessageDelivery {
	let deliveries = sessions.get(session);
	if (deliveries === undefined) {
		deliveries = { taken: 0, underWay: new Map() };
		sessions.set(session, deliveries);
	}
	const delivery: QueuedMessageDelivery = { lane, text, order: ++deliveries.taken };
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

/** A message a turn took, as an engine names it to its host. */
export interface QueuedDeliveryEntry {
	readonly lane: QueuedMessageDelivery["lane"];
	readonly text: string;
}

/**
 * What changed in the deliveries an engine told its host about: the `ended` oldest of them are no longer under way,
 * then the turns took `taken`, in order.
 */
export interface QueuedDeliveryChange {
	readonly ended?: number;
	readonly taken?: readonly QueuedDeliveryEntry[];
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

	/** The change to send with `event`, which `session` sends now; undefined when there is none to send with it. */
	note(session: object, event: { readonly type: string }): QueuedDeliveryChange | undefined {
		// Before it is written, a newer update of the same tool call can replace a tool update, and a change with it.
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
		if (ended === 0 && taken.length === 0) return undefined;
		return {
			...(ended > 0 ? { ended } : {}),
			...(taken.length > 0 ? { taken: taken.map(({ lane, text }) => ({ lane, text })) } : {}),
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

	/** A line brought `change`: what it took joins now; its end, returned, applies when its event reaches the chat. */
	receive(change: QueuedDeliveryChange): QueuedDeliveryEnd | undefined {
		if (change.taken !== undefined && change.taken.length > 0) this.set([...this.entries, ...change.taken]);
		return change.ended === undefined || change.ended === 0
			? undefined
			: { ended: change.ended, resets: this.resets };
	}

	/** The event that carried `end` reaches the chat now: the oldest messages it ended leave. */
	end(end: QueuedDeliveryEnd): void {
		if (end.resets === this.resets) this.set(this.entries.slice(end.ended));
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
	const { ended, taken } = value as { ended?: unknown; taken?: unknown };
	if (ended !== undefined && !(typeof ended === "number" && Number.isSafeInteger(ended) && ended >= 0))
		return undefined;
	if (taken !== undefined && !Array.isArray(taken)) return undefined;
	const entries: QueuedDeliveryEntry[] = [];
	for (const entry of (taken as unknown[] | undefined) ?? []) {
		if (typeof entry !== "object" || entry === null) return undefined;
		const { lane, text } = entry as { lane?: unknown; text?: unknown };
		if ((lane !== "steer" && lane !== "followUp") || typeof text !== "string") return undefined;
		entries.push({ lane, text });
	}
	return {
		...(typeof ended === "number" && ended > 0 ? { ended } : {}),
		...(entries.length > 0 ? { taken: entries } : {}),
	};
}
