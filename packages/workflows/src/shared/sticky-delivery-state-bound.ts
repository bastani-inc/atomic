import type { StickyStageDeliveryStatus } from "./sticky-stage-delivery-status.js";

/** Most delivery states one possible-stage row, status run or inspected run lists; the rest are counted. */
export const STICKY_DELIVERY_STATE_EXEMPLAR_LIMIT = 5;

/** States that still need action, in the order exemplars are chosen; `delivered` follows, most recent first. */
const UNRESOLVED_STATES: readonly StickyStageDeliveryStatus["state"][] = [
	"queued",
	"receipt-unverified",
	"session-replaced",
	"delivery-unavailable",
	"root-unresolved",
	"stage-terminal",
];

export interface BoundedStickyDeliveryStates<State> {
	/** Every state when there are at most the limit; otherwise exemplars, unresolved first, then the latest delivered. */
	readonly deliveryStates: readonly State[];
	/** How many delivery states there are in each state, over all of them; absent when there are none. */
	readonly deliveryStateCounts?: Readonly<Record<string, number>>;
	/** Delivery states left out of `deliveryStates`; absent when none were. */
	readonly omittedDeliveryStates?: number;
}

/**
 * Bound a list of delivery states. A long fan-out accumulates a delivery state per sticky message and
 * matching stage, which made route announcements, `intercom list` results and workflow status grow for
 * the whole run.
 */
export function boundStickyDeliveryStates<State extends Pick<StickyStageDeliveryStatus, "state">>(
	states: readonly State[],
	limit = STICKY_DELIVERY_STATE_EXEMPLAR_LIMIT,
): BoundedStickyDeliveryStates<State> {
	if (states.length === 0) return { deliveryStates: states };
	const counts = new Map<string, number>(UNRESOLVED_STATES.map((state) => [state, 0]));
	counts.set("delivered", 0);
	for (const delivery of states) counts.set(delivery.state, (counts.get(delivery.state) ?? 0) + 1);
	const deliveryStateCounts = Object.fromEntries([...counts].filter(([, count]) => count > 0));
	if (states.length <= limit) return { deliveryStates: states, deliveryStateCounts };
	const exemplars: State[] = [];
	for (const state of UNRESOLVED_STATES) {
		for (const delivery of states) {
			if (exemplars.length === limit) break;
			if (delivery.state === state) exemplars.push(delivery);
		}
	}
	for (let index = states.length - 1; index >= 0 && exemplars.length < limit; index--) {
		const delivery = states[index]!;
		if (delivery.state === "delivered") exemplars.push(delivery);
	}
	return {
		deliveryStates: exemplars,
		deliveryStateCounts,
		omittedDeliveryStates: states.length - exemplars.length,
	};
}

/** The text line that reports a bounded list's omitted delivery states and every state's total. */
export function omittedDeliveryStatesLine(
	bounded: Pick<BoundedStickyDeliveryStates<unknown>, "deliveryStateCounts" | "omittedDeliveryStates">,
): string | undefined {
	const omitted = bounded.omittedDeliveryStates ?? 0;
	if (omitted === 0 || bounded.deliveryStateCounts === undefined) return undefined;
	const counts = Object.entries(bounded.deliveryStateCounts)
		.map(([state, count]) => `${count} ${state}`)
		.join(", ");
	return `… ${omitted} more delivery state${omitted === 1 ? "" : "s"} omitted (all: ${counts})`;
}
