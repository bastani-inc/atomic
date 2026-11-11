import type { DeliveryFailureReasonCode } from "../types.js";

const DELIVERY_FAILURE_REASON_CODES: ReadonlySet<string> = new Set<DeliveryFailureReasonCode>([
	"message_id_conflict",
	"session_not_found",
	"recipient_not_restored",
	"recipient_parked",
	"released_reply_answered",
	"released_reply_in_flight",
]);

export function isDeliveryFailureReasonCode(value: string): value is DeliveryFailureReasonCode {
	return DELIVERY_FAILURE_REASON_CODES.has(value);
}
