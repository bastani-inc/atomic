/**
 * Points where a test can make the broker crash, to prove what it has written by then survives (#4829). The broker
 * crashes at the point named by {@link BROKER_CRASH_AT_ENV}; with the variable unset, as outside tests, nothing happens.
 */
export const BROKER_CRASH_AT_ENV = "ATOMIC_INTERCOM_BROKER_CRASH_AT";

/** A departing session's asks are off their live routes, and not yet kept for its return. */
export const DEPARTURE_ASKS_TAKEN = "departure-asks-taken";

/** Crash here, as a kill would, when a test asked for `point`. */
export function crashPoint(point: string): void {
	if (process.env[BROKER_CRASH_AT_ENV] === point) process.kill(process.pid, "SIGKILL");
}
