import type { WorkflowPossibleStageAnnouncement, WorkflowStickyDeliveryState } from "./types.js";

/** Most delivery states one possible-stage row carries; the rest are counted, not listed. */
export const WORKFLOW_DELIVERY_STATE_EXEMPLAR_LIMIT = 20;

/** States that still need action, in the order exemplars are chosen; `delivered` follows, most recent first. */
const UNRESOLVED_STATES = [
	"queued",
	"receipt-unverified",
	"session-replaced",
	"delivery-unavailable",
	"root-unresolved",
	"stage-terminal",
];

/**
 * Bound a possible-stage row's delivery states as workflow hosts do, for rows from hosts that announce
 * every state. Rows already within the limit pass through unchanged.
 */
export function boundWorkflowPossibleStageRow(
	row: WorkflowPossibleStageAnnouncement,
	limit = WORKFLOW_DELIVERY_STATE_EXEMPLAR_LIMIT,
): WorkflowPossibleStageAnnouncement {
	const states = row.deliveryStates;
	if (states === undefined || states.length <= limit) return row;
	const exemplars: WorkflowStickyDeliveryState[] = [];
	for (const state of UNRESOLVED_STATES) {
		for (const delivery of states) {
			if (exemplars.length === limit) break;
			if (delivery.state === state) exemplars.push(delivery);
		}
	}
	for (let index = states.length - 1; index >= 0 && exemplars.length < limit; index--) {
		if (states[index]!.state === "delivered") exemplars.push(states[index]!);
	}
	for (const delivery of states) {
		if (exemplars.length === limit) break;
		if (delivery.state !== "delivered" && !UNRESOLVED_STATES.includes(delivery.state)) exemplars.push(delivery);
	}
	const counts = new Map<string, number>();
	for (const delivery of states) counts.set(delivery.state, (counts.get(delivery.state) ?? 0) + 1);
	return {
		...row,
		deliveryStates: exemplars,
		deliveryStateCounts: row.deliveryStateCounts ?? Object.fromEntries(counts),
		omittedDeliveryStates: (row.omittedDeliveryStates ?? 0) + states.length - exemplars.length,
	};
}
