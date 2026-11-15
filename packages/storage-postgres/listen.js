// @ts-check
import { randomBytes } from "node:crypto";

/**
 * @typedef {import("@bastani/atomic/storage").StorageListenerState} StorageListenerState
 * @typedef {import("@bastani/atomic/storage").StorageNotificationEvent} StorageNotificationEvent
 * @typedef {import("@bastani/atomic/storage").StorageNotifications} StorageNotifications
 * @typedef {(event: StorageNotificationEvent) => void} NotificationListener
 * @typedef {{
 *   query(sql: string): Promise<unknown>,
 *   on(event: "notification", listener: (message: { channel: string, payload?: string }) => void): unknown,
 *   on(event: "error" | "end", listener: () => void): unknown,
 *   end(): Promise<void>,
 * }} ListenClient
 * @typedef {{
 *   connect: () => Promise<ListenClient>,
 *   send: (channel: string, payload: string) => Promise<void>,
 *   channelName: (channel: string) => string,
 *   probeTimeoutMs?: number,
 *   retry?: { readonly firstMs: number, readonly maxMs: number },
 * }} ListenerOptions
 */

/**
 * How long the listening connection waits for its probe notification, sent through the database's pool, before it
 * decides the endpoint is a transaction pooler that does not deliver notifications to the listening session.
 */
export const LISTEN_PROBE_TIMEOUT_MS = 2_000;
/** The wait before the listening connection is opened again after it failed, and the longest such wait. */
export const LISTEN_RETRY = /** @type {const} */ ({ firstMs: 1_000, maxMs: 30_000 });

/** Quotes `name` as an SQL identifier. */
function quoted(/** @type {string} */ name) {
	return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Postgres `LISTEN`/`NOTIFY` wake-ups (#5103). Every channel shares one listening connection, opened on the first
 * `listen` or `state` call and again, with a growing wait, after it fails or breaks. Once connected it sends a probe
 * notification through the database's pool: when the probe never arrives, as through a transaction pooler, the
 * connection is closed and the state says `pooler`. Callers keep their polls; this only makes them find work sooner.
 * @param {ListenerOptions} options
 * @returns {StorageNotifications & { close(): Promise<void> }}
 */
export function createPostgresListener(options) {
	const probeTimeoutMs = options.probeTimeoutMs ?? LISTEN_PROBE_TIMEOUT_MS;
	const retry = options.retry ?? LISTEN_RETRY;
	const probeChannel = `atomic_listen_probe_${randomBytes(6).toString("hex")}`;
	/** @type {Map<string, Set<NotificationListener>>} */
	const channels = new Map();
	/** @type {StorageListenerState} */
	let state = { status: "connecting" };
	/** @type {ListenClient | undefined} */
	let client;
	/** @type {Promise<void> | undefined} */
	let firstAttempt;
	/** @type {NodeJS.Timeout | undefined} */
	let retryTimer;
	let failures = 0;
	let closed = false;
	/** @type {((payload: string) => void) | undefined} */
	let probeArrived;

	/** @param {string} name @param {StorageNotificationEvent} event */
	const dispatch = (name, event) => {
		for (const listener of [...(channels.get(name) ?? [])]) {
			try {
				listener(event);
			} catch {
				// A listener's failure is its own.
			}
		}
	};

	const scheduleRetry = () => {
		if (closed || retryTimer !== undefined) return;
		const delayMs = Math.min(retry.maxMs, retry.firstMs * 2 ** failures);
		failures++;
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			void attempt();
		}, delayMs);
		retryTimer.unref?.();
	};

	/** @param {ListenClient} lost @param {"pooler" | "connection-failed"} reason */
	const drop = (lost, reason) => {
		if (client !== lost) return;
		client = undefined;
		state = { status: "unavailable", reason };
		void lost.end().catch(() => {});
		scheduleRetry();
	};

	const attempt = async () => {
		if (closed) return;
		/** @type {ListenClient} */
		let opened;
		try {
			opened = await options.connect();
		} catch {
			state = { status: "unavailable", reason: "connection-failed" };
			scheduleRetry();
			return;
		}
		if (closed) {
			await opened.end().catch(() => {});
			return;
		}
		client = opened;
		opened.on("error", () => drop(opened, "connection-failed"));
		opened.on("end", () => drop(opened, "connection-failed"));
		opened.on("notification", (message) => {
			const payload = message.payload ?? "";
			if (message.channel === probeChannel) probeArrived?.(payload);
			else if (client === opened && state.status === "listening")
				dispatch(message.channel, { kind: "notification", payload });
		});
		const nonce = randomBytes(8).toString("hex");
		/** @type {NodeJS.Timeout | undefined} */
		let probeTimer;
		try {
			for (const name of [probeChannel, ...channels.keys()]) await opened.query(`LISTEN ${quoted(name)}`);
			const arrived = new Promise((resolve) => {
				probeArrived = (payload) => {
					if (payload === nonce) resolve(true);
				};
				probeTimer = setTimeout(() => resolve(false), probeTimeoutMs);
			});
			await options.send(probeChannel, nonce);
			if (!(await arrived)) {
				drop(opened, "pooler");
				return;
			}
		} catch {
			drop(opened, "connection-failed");
			return;
		} finally {
			clearTimeout(probeTimer);
			probeArrived = undefined;
		}
		if (client !== opened) return;
		failures = 0;
		state = { status: "listening" };
		for (const name of channels.keys()) dispatch(name, { kind: "listening" });
	};

	const start = () => {
		firstAttempt ??= attempt();
		return firstAttempt;
	};

	return {
		notify(channel, payload) {
			return { sql: "SELECT pg_notify(?, ?)", params: [options.channelName(channel), payload] };
		},
		listen(channel, listener) {
			const name = options.channelName(channel);
			let listeners = channels.get(name);
			if (listeners === undefined) {
				listeners = new Set();
				channels.set(name, listeners);
				const current = client;
				// A channel added while a connection is open, listening or still probing, is listened to on it; a failure drops
				// it, and the next one listens to every channel.
				if (current !== undefined)
					current.query(`LISTEN ${quoted(name)}`).catch(() => drop(current, "connection-failed"));
			}
			listeners.add(listener);
			void start();
			let open = true;
			return {
				close() {
					if (!open) return;
					open = false;
					const current = channels.get(name);
					current?.delete(listener);
					if (current?.size !== 0) return;
					channels.delete(name);
					const connected = client;
					if (connected !== undefined)
						connected.query(`UNLISTEN ${quoted(name)}`).catch(() => drop(connected, "connection-failed"));
				},
			};
		},
		async state() {
			await start();
			return state;
		},
		async close() {
			closed = true;
			clearTimeout(retryTimer);
			retryTimer = undefined;
			await firstAttempt;
			const current = client;
			client = undefined;
			await current?.end().catch(() => {});
		},
	};
}
