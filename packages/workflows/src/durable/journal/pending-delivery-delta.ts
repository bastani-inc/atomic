import type { PendingStageMessage, PendingStageMessageDelivery } from "../../shared/store-types.js";

/**
 * A sticky entry's deliveries written as a change to the same entry in the run's previous event: drop these
 * indexes of the previous deliveries, then append `add`. Recording a delivery then costs the delivery, not
 * every live delivery again (#3920).
 */
interface PendingStageDeliveryDelta {
	readonly drop?: readonly number[];
	readonly add: readonly PendingStageMessageDelivery[];
}
type DeltaEncodedMessage = Omit<PendingStageMessage, "deliveries"> & {
	readonly deliveryDelta: PendingStageDeliveryDelta;
};
export type JournalPendingStageMessage = PendingStageMessage | DeltaEncodedMessage;

function identity(message: Pick<PendingStageMessage, "runId" | "id">): string {
	return JSON.stringify([message.runId, message.id]);
}

/** Entries whose identity occurs once; a duplicated identity cannot name its base unambiguously. */
function uniqueByIdentity<Message extends Pick<PendingStageMessage, "runId" | "id">>(
	messages: readonly Message[],
): Map<string, Message> {
	const result = new Map<string, Message>();
	const repeated = new Set<string>();
	for (const message of messages) {
		const key = identity(message);
		if (result.has(key)) repeated.add(key);
		result.set(key, message);
	}
	for (const key of repeated) result.delete(key);
	return result;
}

function isDeltaEncoded(message: JournalPendingStageMessage): message is DeltaEncodedMessage {
	return (message as Partial<DeltaEncodedMessage>).deliveryDelta !== undefined;
}

/**
 * Encode `next` against `previous`, the pending entries the run's journal holds before this event. Returns
 * undefined when no entry is smaller as a change, so the event keeps the full entries.
 */
export function encodePendingStageDeliveries(
	previous: readonly PendingStageMessage[],
	next: readonly PendingStageMessage[],
): readonly JournalPendingStageMessage[] | undefined {
	const bases = uniqueByIdentity(previous);
	const nextIdentities = uniqueByIdentity(next);
	let encodedAny = false;
	const encoded = next.map((message): JournalPendingStageMessage => {
		const base = bases.get(identity(message))?.deliveries;
		const deliveries = message.deliveries;
		if (base === undefined || deliveries === undefined || !nextIdentities.has(identity(message))) return message;
		const drop: number[] = [];
		let kept = 0;
		base.forEach((delivery, index) => {
			if (kept < deliveries.length && JSON.stringify(delivery) === JSON.stringify(deliveries[kept])) kept++;
			else drop.push(index);
		});
		const add = deliveries.slice(kept);
		if (drop.length + add.length >= deliveries.length) return message;
		encodedAny = true;
		const { deliveries: _full, ...rest } = message;
		return { ...rest, deliveryDelta: drop.length === 0 ? { add } : { drop, add } };
	});
	return encodedAny ? encoded : undefined;
}

/** Rebuild full entries from an event's entries and the run's entries before that event. */
export function decodePendingStageDeliveries(
	previous: readonly PendingStageMessage[],
	messages: readonly JournalPendingStageMessage[],
): readonly PendingStageMessage[] {
	if (!messages.some(isDeltaEncoded)) return messages as readonly PendingStageMessage[];
	const bases = uniqueByIdentity(previous);
	return messages.map((message) => {
		if (!isDeltaEncoded(message)) return message;
		const base = bases.get(identity(message))?.deliveries;
		if (base === undefined)
			throw new Error(`atomic-workflows: journal delivery change for ${identity(message)} has no base entry`);
		const { deliveryDelta, ...rest } = message;
		const dropped = new Set(deliveryDelta.drop ?? []);
		return { ...rest, deliveries: [...base.filter((_, index) => !dropped.has(index)), ...deliveryDelta.add] };
	});
}

/** Whether an event's entries need the run's earlier events to be read. */
export function hasPendingStageDeliveryDelta(messages: readonly JournalPendingStageMessage[] | undefined): boolean {
	return messages?.some(isDeltaEncoded) === true;
}
