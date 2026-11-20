/**
 * Points where a test can make the broker crash, to prove what it has written by then survives (#4829). The broker
 * crashes at the point named by {@link BROKER_CRASH_AT_ENV}; with the variable unset, as outside tests, nothing happens.
 */
export const BROKER_CRASH_AT_ENV = "ATOMIC_INTERCOM_BROKER_CRASH_AT";

/** A departing session's asks are off their live routes, and not yet kept for its return. */
export const DEPARTURE_ASKS_TAKEN = "departure-asks-taken";

/** A departing session's asks to it are off their live routes, and not yet kept for its return. */
export const DEPARTURE_ASKS_TO_IT_TAKEN = "departure-asks-to-it-taken";

/** #4996: a departing session that ended has failed the asks to it for their connected askers, before that is saved. */
export const DEPARTURE_ASKS_TO_IT_FAILED = "departure-asks-to-it-failed";

/**
 * #5145: a broker failing the asks to a recipient that ended has queued an away asker's failure in the outbox, before it
 * cleared the ask or woke the asker's broker.
 */
export const ASK_FAILURE_QUEUED = "ask-failure-queued";

/** #5999 durable wake queue: a message for a subagent that ended is kept, and its sender not yet answered `queued`. */
export const ENDED_QUEUE_KEPT = "ended-queue-kept";

/**
 * #5999 durable wake queue: a kept message reached its subagent, which confirmed saving it (the delivered-message
 * authority accepted it), and its row is not yet deleted.
 */
export const ENDED_QUEUE_RECEIVED = "ended-queue-received";

/** Crash here, as a kill would, when a test asked for `point`. */
export function crashPoint(point: string): void {
	if (process.env[BROKER_CRASH_AT_ENV] === point) process.kill(process.pid, "SIGKILL");
}
