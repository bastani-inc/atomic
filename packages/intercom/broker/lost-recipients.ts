/**
 * #5154: a recipient whose end was lost (its broker stopped before it recorded the departure) looks like a session that
 * may come back. Once it has been gone this long without registering again, the asks to it fail as "unavailable".
 */

/**
 * A recipient whose broker restarted and retired its presence: a live session registers again within seconds of its
 * broker coming back (its reconnect backoff tops out at 30 s), so one still gone after this long is not coming back.
 */
export const LOST_RECIPIENT_UNAVAILABLE_AFTER_MS = 5 * 60 * 1000;

/**
 * A recipient whose presence lease went stale with no broker restarting: its host may only be asleep, which cannot be
 * told from a stop, so it is given much longer.
 */
export const LOST_RECIPIENT_STALE_LEASE_AFTER_MS = 60 * 60 * 1000;

/** Test-only overrides of the two bounds, in milliseconds. */
export const LOST_RECIPIENT_AFTER_ENV = "ATOMIC_INTERCOM_LOST_RECIPIENT_AFTER_MS";
export const LOST_RECIPIENT_STALE_LEASE_AFTER_ENV = "ATOMIC_INTERCOM_LOST_RECIPIENT_STALE_LEASE_AFTER_MS";

export interface LostRecipientBounds {
	/** After a restart of its broker retired its presence. */
	readonly afterRestartMs: number;
	/** After its presence lease went stale, counted from when it went stale. */
	readonly afterStaleLeaseMs: number;
}

function boundFrom(value: string | undefined, fallback: number): number {
	const parsed = value === undefined ? Number.NaN : Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** The bounds a broker uses: the named defaults, unless a test overrides them. */
export function lostRecipientBounds(env: NodeJS.ProcessEnv = process.env): LostRecipientBounds {
	return {
		afterRestartMs: boundFrom(env[LOST_RECIPIENT_AFTER_ENV], LOST_RECIPIENT_UNAVAILABLE_AFTER_MS),
		afterStaleLeaseMs: boundFrom(env[LOST_RECIPIENT_STALE_LEASE_AFTER_ENV], LOST_RECIPIENT_STALE_LEASE_AFTER_MS),
	};
}

function minutes(ms: number): string {
	const count = Math.max(1, Math.round(ms / 60_000));
	return `${count} minute${count === 1 ? "" : "s"}`;
}

/** Why an ask to a lost recipient failed: it did not end cleanly, and asking again later may reach it. */
export function lostRecipientReason(name: string, boundMs: number): string {
	return `Session "${name}" is unavailable: its broker stopped and it has not come back within ${minutes(boundMs)}; it may not have ended cleanly, so you can ask again later`;
}
