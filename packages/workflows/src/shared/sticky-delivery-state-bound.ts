import type { StickyStageDeliveryStatus } from "./sticky-stage-delivery-status.js";

/** Most delivery states one possible-stage row carries; the rest are counted, not listed. */
export const STICKY_DELIVERY_STATE_EXEMPLAR_LIMIT = 20;

/** States that still need action, in the order exemplars are chosen; `delivered` follows, most recent first. */
const UNRESOLVED_STATES: readonly StickyStageDeliveryStatus["state"][] = [
	"queued",
	"receipt-unverified",
	"session-replaced",
	"delivery-unavailable",
	"root-unresolved",
	"stage-terminal",
];

export interface BoundedStickyDeliveryStates {
	/** Every state when there are at most the limit; otherwise exemplars, unresolved first, then the latest delivered. */
	readonly deliveryStates: readonly StickyStageDeliveryStatus[];
	/** How many delivery states the row has in each state, over all of them. */
	readonly deliveryStateCounts: Readonly<Record<string, number>>;
	/** Delivery states left out of `deliveryStates`; absent when none were. */
	readonly omittedDeliveryStates?: number;
}

/**
 * Bound one row's delivery states. A long fan-out accumulates a delivery state per sticky message and
 * matching stage, which made every route announcement and `intercom list` result grow for the whole run.
 */
export function boundStickyDeliveryStates(
	states: readonly StickyStageDeliveryStatus[],
	limit = STICKY_DELIVERY_STATE_EXEMPLAR_LIMIT,
): BoundedStickyDeliveryStates {
	const counts = new Map<string, number>(UNRESOLVED_STATES.map((state) => [state, 0]));
	counts.set("delivered", 0);
	for (const delivery of states) counts.set(delivery.state, (counts.get(delivery.state) ?? 0) + 1);
	const deliveryStateCounts = Object.fromEntries([...counts].filter(([, count]) => count > 0));
	if (states.length <= limit) return { deliveryStates: states, deliveryStateCounts };
	const exemplars: StickyStageDeliveryStatus[] = [];
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
