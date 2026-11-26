import type { StorageNotifications } from "@bastani/atomic/storage";

/** A connected session the listener sends `LISTEN` on and receives notifications from. */
export interface ListenClient {
	query(sql: string): Promise<unknown>;
	on(event: "notification", listener: (message: { channel: string; payload?: string }) => void): unknown;
	on(event: "error" | "end", listener: () => void): unknown;
	end(): Promise<void>;
	/** Closes the session's socket at once, without waiting for the server; used once `CLOSE_WAIT_MS` passed. */
	destroy?(): void;
}

export interface ListenerOptions {
	/** Opens a new session to the listening endpoint. */
	connect: () => Promise<ListenClient>;
	/** Sends a notification through the database's pool, as a store's transaction would. */
	send: (channel: string, payload: string) => Promise<void>;
	/** The identifier a channel name is sent and listened to as. */
	channelName: (channel: string) => string;
	/** Default `LISTEN_PROBE_TIMEOUT_MS`. */
	probeTimeoutMs?: number;
	/** Default `LISTEN_RETRY`. */
	retry?: { readonly firstMs: number; readonly maxMs: number };
	/** Default `LISTEN_HEALTH_INTERVAL_MS`. */
	healthIntervalMs?: number;
	/** How long `close()` waits for the session to end before it destroys it. Default `CLOSE_WAIT_MS`. */
	closeWaitMs?: number;
}

export const LISTEN_PROBE_TIMEOUT_MS: 2000;
export const LISTEN_RETRY: { readonly firstMs: 1000; readonly maxMs: 30000 };
export const LISTEN_HEALTH_INTERVAL_MS: 30000;
/** How long closing waits for the server to let go of a connection before it drops it. */
export const CLOSE_WAIT_MS: 5000;

export function createPostgresListener(options: ListenerOptions): StorageNotifications & { close(): Promise<void> };

/** How long after a notification goes out the same notification waits before it goes out again. */
export const NOTIFY_COALESCE_MS: 5;

/** A notification a committed transaction sends: a `pg_notify` statement, with its parameters. */
export interface Notice {
	readonly sql: string;
	readonly params: readonly unknown[];
}

export interface NotifyCoalescer {
	/**
	 * Of `notices`, which a transaction whose commit was just sent ran, the ones to send with that commit now; each other
	 * goes out later, through `sendLater`, if `committed` resolves true.
	 */
	take(notices: readonly Notice[], committed: Promise<boolean>): Notice[];
	/** Sends every notification held back now, and resolves once every one sent later was answered. */
	flush(): Promise<void>;
}

export function createNotifyCoalescer(options: {
	windowMs?: number;
	sendLater: (notices: readonly Notice[]) => Promise<void>;
}): NotifyCoalescer;
