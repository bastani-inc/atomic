import type { StorageNotifications } from "@bastani/atomic/storage";

/** A connected session the listener sends `LISTEN` on and receives notifications from. */
export interface ListenClient {
	query(sql: string): Promise<unknown>;
	on(event: "notification", listener: (message: { channel: string; payload?: string }) => void): unknown;
	on(event: "error" | "end", listener: () => void): unknown;
	end(): Promise<void>;
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
}

export const LISTEN_PROBE_TIMEOUT_MS: 2000;
export const LISTEN_RETRY: { readonly firstMs: 1000; readonly maxMs: 30000 };
export const LISTEN_HEALTH_INTERVAL_MS: 30000;

export function createPostgresListener(options: ListenerOptions): StorageNotifications & { close(): Promise<void> };
