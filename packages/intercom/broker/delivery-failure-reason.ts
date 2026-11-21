import type { DeliveryFailureReasonCode } from "../types.js";

const DELIVERY_FAILURE_REASON_CODES: ReadonlySet<string> = new Set<DeliveryFailureReasonCode>([
	"message_id_conflict",
	"session_not_found",
	"recipient_not_restored",
	"recipient_parked",
	"released_reply_answered",
	"released_reply_in_flight",
	"not_hosted_by_connection",
]);

export function isDeliveryFailureReasonCode(value: string): value is DeliveryFailureReasonCode {
	return DELIVERY_FAILURE_REASON_CODES.has(value);
}

/**
 * #5101, #4997: why a reply no route authorizes yet is refused, as `route_unavailable` (not final): its ask's route is
 * still being restored, or the broker that may keep it is unavailable. The same reply may be authorized shortly.
 */
export const ROUTE_UNAVAILABLE_REASON =
	"No route Intercom can reach authorizes this reply yet: the ask's route is still being restored, or the broker that may keep it is unavailable. Try again shortly.";

/**
 * Why a reply to an ask is refused when no pending question route authorizes it and none can appear: the ask was
 * answered, or its route expired. Final, unlike {@link ROUTE_UNAVAILABLE_REASON}: no reply to that ask can be delivered.
 */
export const UNAUTHORIZED_REPLY_REASON = "Pending question route does not authorize this public reply";
