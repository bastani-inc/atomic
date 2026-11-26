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
 *   healthIntervalMs?: number,
 * }} ListenerOptions
 */

/**
 * How long the listening connection waits for its probe notification, sent through the database's pool, before it
 * decides the endpoint is a transaction pooler that does not deliver notifications to the listening session.
 */
export const LISTEN_PROBE_TIMEOUT_MS = 2_000;
/** The wait before the listening connection is opened again after it failed, and the longest such wait. */
export const LISTEN_RETRY = /** @type {const} */ ({ firstMs: 1_000, maxMs: 30_000 });
/**
 * How often a listening connection sends itself a probe notification through the pool, which must arrive within
 * `LISTEN_PROBE_TIMEOUT_MS`; otherwise the connection is taken for half-open (its peer gone without a reset) and
 * replaced.
 */
export const LISTEN_HEALTH_INTERVAL_MS = 30_000;

/**
 * How long after a notification goes out the same notification (channel and payload) waits before it goes out again:
 * the commits of that window share the one sent after it. A listener polls once for all of them instead of once for each.
 */
export const NOTIFY_COALESCE_MS = 5;

/**
 * A notification a committed transaction sends: a `pg_notify` statement, with its parameters. Two with the same text and
 * parameters are the same notification.
 * @typedef {{ readonly sql: string, readonly params: readonly unknown[] }} Notice
 */

/**
 * Coalesces this process's notifications, as River's insert notify limiter does: a notification goes out with its
 * transaction's commit unless the same one went out within `windowMs`. One held back that way goes out once its
 * transaction committed and the window since the last one passed, through `sendLater`, once for every commit held back
 * in that window. A notification is only ever sent after the commit it announces, so a listener that polls when it
 * arrives finds that commit's writes.
 * @param {{ windowMs?: number, sendLater: (notices: readonly Notice[]) => Promise<void> }} options
 */
export function createNotifyCoalescer(options) {
	const windowMs = options.windowMs ?? NOTIFY_COALESCE_MS;
	/** When each notification last went out, by this process's clock. */
	/** @type {Map<string, number>} */
	const sentAt = new Map();
	/** Notifications held back whose commits are done, to go out at the end of their window. */
	/** @type {Map<string, Notice>} */
	const held = new Map();
	/** @type {NodeJS.Timeout | undefined} */
	let timer;
	/** @type {Set<Promise<void>>} */
	const sending = new Set();

	const keyOf = (/** @type {Notice} */ notice) => JSON.stringify([notice.sql, notice.params]);
	/** Forgets notifications whose window ended with none held back, so the map holds only recent ones. */
	const forget = (/** @type {number} */ now) => {
		for (const [key, at] of sentAt) if (now - at >= windowMs && !held.has(key)) sentAt.delete(key);
	};
	const send = (/** @type {readonly Notice[]} */ notices) => {
		const sent = options.sendLater(notices).catch(() => {});
		sending.add(sent);
		void sent.then(() => sending.delete(sent));
	};
	const flush = () => {
		timer = undefined;
		const now = Date.now();
		/** @type {Notice[]} */
		const due = [];
		for (const [key, notice] of held) {
			if (now - (sentAt.get(key) ?? -Infinity) < windowMs) continue;
			held.delete(key);
			sentAt.set(key, now);
			due.push(notice);
		}
		if (due.length > 0) send(due);
		schedule();
	};
	const schedule = () => {
		if (timer !== undefined || held.size === 0) return;
		let next = Infinity;
		for (const key of held.keys()) next = Math.min(next, (sentAt.get(key) ?? -Infinity) + windowMs);
		timer = setTimeout(flush, Math.max(0, next - Date.now()));
		timer.unref?.();
	};

	return {
		/**
		 * Of `notices`, which a transaction whose commit was just sent ran, the ones to send with that commit now; each other
		 * goes out later, through `sendLater`, if `committed` resolves true.
		 * @param {readonly Notice[]} notices
		 * @param {Promise<boolean>} committed
		 * @returns {Notice[]}
		 */
		take(notices, committed) {
			const now = Date.now();
			if (sentAt.size > 1024) forget(now);
			/** @type {Notice[]} */
			const immediate = [];
			for (const notice of notices) {
				const key = keyOf(notice);
				const last = sentAt.get(key);
				if (last === undefined || now - last >= windowMs) {
					// Sent behind this commit, so it covers the commits held back before it too.
					sentAt.set(key, now);
					held.delete(key);
					immediate.push(notice);
					continue;
				}
				void committed.then(
					(done) => {
						if (!done) return;
						held.set(key, notice);
						schedule();
					},
					() => {},
				);
			}
			return immediate;
		},
		/** Sends every notification held back now, and resolves once every one sent later was answered. */
		async flush() {
			clearTimeout(timer);
			timer = undefined;
			if (held.size > 0) {
				const due = [...held.values()];
				held.clear();
				send(due);
			}
			await Promise.all(sending);
		},
	};
}

/** Quotes `name` as an SQL identifier. */
function quoted(/** @type {string} */ name) {
	return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Postgres `LISTEN`/`NOTIFY` wake-ups (#5103). Every channel shares one listening connection, opened on the first
 * `listen` or `state` call and again, with a growing wait, after it fails or breaks. Once connected it listens to a
 * probe channel of its own and sends a probe notification through the database's pool. When the probe never arrives,
 * as through a transaction pooler, it unlistens, closes the connection, and stays `pooler` for good: it listens to
 * no other channel there, so no later notification reaches a pooled server connection. While listening it repeats
 * the probe every `healthIntervalMs` and replaces a connection the probe no longer reaches. Callers keep their polls;
 * this only makes them find work sooner.
 * @param {ListenerOptions} options
 * @returns {StorageNotifications & { close(): Promise<void> }}
 */
export function createPostgresListener(options) {
	const probeTimeoutMs = options.probeTimeoutMs ?? LISTEN_PROBE_TIMEOUT_MS;
	const retry = options.retry ?? LISTEN_RETRY;
	const healthIntervalMs = options.healthIntervalMs ?? LISTEN_HEALTH_INTERVAL_MS;
	const probeChannel = `atomic_listen_probe_${randomBytes(6).toString("hex")}`;
	/** @type {Map<string, Set<NotificationListener>>} */
	const channels = new Map();
	/** @type {StorageListenerState} */
	let state = { status: "connecting" };
	/** @type {ListenClient | undefined} */
	let client;
	/** The connection while it listens: `client` once its probe arrived. */
	/** @type {ListenClient | undefined} */
	let live;
	/** @type {Promise<void> | undefined} */
	let firstAttempt;
	/** @type {NodeJS.Timeout | undefined} */
	let retryTimer;
	/** @type {NodeJS.Timeout | undefined} */
	let healthTimer;
	let failures = 0;
	let closed = false;
	/** A transaction pooler was found: it stays one, and probing it again would leave a LISTEN on it each time. */
	let pooled = false;
	/** The probes in flight, by nonce. */
	/** @type {Map<string, () => void>} */
	const probes = new Map();

	/** @param {string} name @param {StorageNotificationEvent} event */
	const dispatch = (name, event) => {
		const listeners = channels.get(name);
		// A notification can arrive for a channel whose last listener just left, before its UNLISTEN.
		if (listeners === undefined) return;
		for (const listener of [...listeners]) {
			try {
				listener(event);
			} catch {
				// A listener's failure is its own.
			}
		}
	};

	const scheduleRetry = () => {
		if (closed || pooled || retryTimer !== undefined) return;
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
		live = undefined;
		clearTimeout(healthTimer);
		state = { status: "unavailable", reason };
		void lost.end().catch(() => {});
		scheduleRetry();
	};

	/**
	 * Sends a probe notification through the pool, and resolves with whether it reached the listening connection within
	 * the probe timeout.
	 * @returns {Promise<boolean>}
	 */
	const probe = async () => {
		const nonce = randomBytes(8).toString("hex");
		/** @type {NodeJS.Timeout | undefined} */
		let timer;
		/** @type {(arrived: boolean) => void} */
		let settle = () => {};
		const arrived = new Promise((resolve) => {
			settle = resolve;
			probes.set(nonce, () => resolve(true));
		});
		try {
			await options.send(probeChannel, nonce);
			// The wait starts once the notification was sent: opening a pool connection for it first, which through a
			// proxy tunnel can take longer than the wait, says nothing of whether notifications arrive (#5473).
			timer = setTimeout(() => settle(false), probeTimeoutMs);
			return /** @type {boolean} */ (await arrived);
		} finally {
			clearTimeout(timer);
			probes.delete(nonce);
		}
	};

	/** @param {ListenClient} opened */
	const scheduleHealth = (opened) => {
		// `drop` and `close` clear the timer, so it fires only while `opened` listens.
		healthTimer = setTimeout(async () => {
			let healthy = false;
			try {
				healthy = await probe();
			} catch {
				// The pool could not send the probe: the connection is not known to listen.
			}
			if (healthy) scheduleHealth(opened);
			else drop(opened, "connection-failed");
		}, healthIntervalMs);
		healthTimer.unref?.();
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
			if (message.channel === probeChannel) probes.get(payload)?.();
			else if (client === opened && state.status === "listening")
				dispatch(message.channel, { kind: "notification", payload });
		});
		try {
			// Only the probe channel until the probe arrives: a pooler keeps a LISTEN on whichever server connection ran
			// it, and that connection's later notifications would reach no client.
			await opened.query(`LISTEN ${quoted(probeChannel)}`);
			if (!(await probe())) {
				await opened.query("UNLISTEN *").catch(() => {});
				pooled = true;
				drop(opened, "pooler");
				return;
			}
			// Channels added meanwhile are in the map, and the loop reaches them.
			for (const name of channels.keys()) await opened.query(`LISTEN ${quoted(name)}`);
		} catch {
			drop(opened, "connection-failed");
			return;
		}
		if (client !== opened) return;
		failures = 0;
		live = opened;
		state = { status: "listening" };
		scheduleHealth(opened);
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
				const current = live;
				// A channel added while listening is listened to on that connection; a failure drops it, and the next one
				// listens to every channel. One added while connecting is listened to once the probe arrives.
				if (current !== undefined)
					current.query(`LISTEN ${quoted(name)}`).catch(() => drop(current, "connection-failed"));
			}
			listeners.add(listener);
			void start();
			return {
				close() {
					const current = channels.get(name);
					// Closing again finds the listener gone.
					if (!current?.delete(listener) || current.size > 0) return;
					channels.delete(name);
					const connected = live;
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
			clearTimeout(healthTimer);
			retryTimer = undefined;
			await firstAttempt;
			const current = client;
			client = undefined;
			await current?.end().catch(() => {});
		},
	};
}
