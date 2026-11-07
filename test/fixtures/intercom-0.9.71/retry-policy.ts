/** Existing maximum wait for an `ask` reply. */
export const ASK_REPLY_TIMEOUT_MS = 10 * 60 * 1000;
/** Bounded reconnect opportunity after the ask wait. */
export const RETRY_IDENTITY_RETRY_OPPORTUNITY_MS = 60 * 1000;
/** An operation identity covers the full ask wait plus reconnect recovery. */
export const RETRY_IDENTITY_TTL_MS = ASK_REPLY_TIMEOUT_MS + RETRY_IDENTITY_RETRY_OPPORTUNITY_MS;
/** Broker authority outlives client-held identities so a boundary retry cannot lose acceptance proof in transit. */
export const DELIVERED_MESSAGE_TTL_MS = RETRY_IDENTITY_TTL_MS + RETRY_IDENTITY_RETRY_OPPORTUNITY_MS;
/** Three reconnect attempts, used independently before initialization and during delivery. */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000] as const;
/** How long a sender waits for one send's outcome before its client gives up. */
export const SEND_RESPONSE_TIMEOUT_MS = 10_000;
/** The broker answers an unconfirmed save before the sender's own wait ends, so the sender learns the outcome is uncertain. */
export const RECIPIENT_RECEIPT_TIMEOUT_MS = 8_000;
/**
 * #3983: a recipient still saving a message (a pooled stage's journal commit waiting behind other writers) reports
 * progress this often, each report extending the sender's wait by another `RECIPIENT_RECEIPT_TIMEOUT_MS`.
 */
export const RECIPIENT_SAVING_REPORT_INTERVAL_MS = RECIPIENT_RECEIPT_TIMEOUT_MS / 4;
/** No save holds its sender longer than this, however long the recipient keeps reporting progress. */
export const RECIPIENT_SAVE_MAX_WAIT_MS = 120_000;
