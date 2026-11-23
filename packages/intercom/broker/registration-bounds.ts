/**
 * Protocol bounds for Intercom multi-node registration shared between broker and client.
 * Zero-dependency module so client startup never pulls broker-only or storage modules.
 */

/**
 * The longest a registration waits for its presence lease (and known-session record) to be written to shared storage
 * before answering the client; the write still finishes in the background if the store is slow.
 */
export const PRESENCE_REGISTRATION_BOUND_MS = 5_000;

/**
 * The longest a registration that asks for its id back waits for the shared database to bind it, before the presence
 * wait: both together stay within {@link BROKER_CONNECT_TIMEOUT_MS}. Past it the session gets a fresh id (or keeps the
 * id if its binding write confirms it), never an unchecked one.
 */
export const SESSION_ID_CLAIM_BOUND_MS = 2_500;

/**
 * The longest a claim waits in all once it found the id owned by a broker of this host that has exited: each step that
 * gives that broker's ids up and binds the id again has {@link SESSION_ID_CLAIM_BOUND_MS} of its own, up to this. The
 * registration's presence wait is shortened by the extra time (`presenceBoundAfterClaim`), so both together stay within
 * {@link BROKER_CONNECT_TIMEOUT_MS}.
 */
export const SESSION_ID_CLAIM_PROGRESS_CAP_MS = 2 * SESSION_ID_CLAIM_BOUND_MS;

/** Headroom past the combined claim and presence registration bounds for IPC, accept queueing, and store I/O. */
export const REGISTRATION_CONNECT_HEADROOM_MS = 2_500;

/**
 * How long `connect()` waits for the broker to answer `register`: derived from the combined id-claim and presence
 * registration bounds plus IPC/store headroom (2,500 + 5,000 + 2,500 = 10,000 ms).
 */
export const BROKER_CONNECT_TIMEOUT_MS =
	SESSION_ID_CLAIM_BOUND_MS + PRESENCE_REGISTRATION_BOUND_MS + REGISTRATION_CONNECT_HEADROOM_MS;

/** Minimum time an unanswered claim's reclaim write gets to decide its id even after a long broker stall. */
export const MIN_RECLAIM_DECISION_BOUND_MS = 1_500;

/**
 * Latest time from claim start that a registration waits for a reclaim decision, leaving IPC margin below
 * {@link BROKER_CONNECT_TIMEOUT_MS}.
 */
export const RECLAIM_DECISION_CLIENT_CAP_MS = BROKER_CONNECT_TIMEOUT_MS - 500;
