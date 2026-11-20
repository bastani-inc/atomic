/**
 * A queued message from the moment its turn takes it out of the session's queue until its own `message_start`
 * reaches the session's listeners. Between the two, the session runs the extensions' `message_start` hooks, and the
 * `queue_update` it sent when the turn took the message already lists the queue without it. A chat in this process
 * keeps showing such a message as queued until its own row is in the transcript, so the message is never off screen.
 *
 * Nothing here changes a public event or its order, and nothing crosses a process boundary. Only deliveries still
 * under way are reachable: an event a listener keeps reaches the session's deliveries in flight, never the text of
 * one that ended, and each `queue_update` records a number, not a copy.
 */
export interface QueuedMessageDelivery {
	readonly lane: "steer" | "followUp";
	readonly text: string;
	/** Its place in the order the session's turns took messages. */
	readonly order: number;
}

/** One session's deliveries under way, in the order its turns took them; dropped once none is left. */
interface SessionDeliveries {
	taken: number;
	readonly underWay: Set<QueuedMessageDelivery>;
}

/** The deliveries a `queue_update` lists: those of `session` the turns had taken when it was sent, while under way. */
export interface QueueUpdateDeliveries {
	readonly session: SessionDeliveries;
	readonly through: number;
}

const sessions = new WeakMap<object, SessionDeliveries>();
const listedWith = new WeakMap<object, QueueUpdateDeliveries>();

/** The turn took `text` out of `session`'s `lane` queue; its `message_start` has not reached the listeners yet. */
export function beginQueuedMessageDelivery(
	session: object,
	lane: QueuedMessageDelivery["lane"],
	text: string,
): QueuedMessageDelivery {
	let deliveries = sessions.get(session);
	if (deliveries === undefined) {
		deliveries = { taken: 0, underWay: new Set() };
		sessions.set(session, deliveries);
	}
	const delivery: QueuedMessageDelivery = { lane, text, order: ++deliveries.taken };
	deliveries.underWay.add(delivery);
	return delivery;
}

/**
 * The message's `message_start` is reaching the listeners now, or never will (a hook failed, or the session already
 * shows the input): it is no longer under way.
 */
export function endQueuedMessageDelivery(session: object, delivery: QueuedMessageDelivery | undefined): void {
	if (delivery === undefined) return;
	const deliveries = sessions.get(session);
	if (deliveries === undefined || !deliveries.underWay.delete(delivery)) return;
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
	for (const delivery of listed.session.underWay)
		if (delivery.lane === lane && delivery.order <= listed.through) texts.push(delivery.text);
	return texts;
}
