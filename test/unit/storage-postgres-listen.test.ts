import assert from "node:assert/strict";
import type { StorageNotificationEvent } from "@bastani/atomic/storage";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	createNotifyCoalescer,
	createPostgresListener,
	LISTEN_HEALTH_INTERVAL_MS,
	LISTEN_RETRY,
	type ListenClient,
	type ListenerOptions,
	NOTIFY_COALESCE_MS,
} from "../../packages/storage-postgres/listen.js";

/**
 * The Postgres listening connection (#5103) against a fake session: what it listens to, when it reports listening,
 * how it treats a probe that never arrives (a transaction pooler), and how it retries a connection that fails.
 */

const PROBE_TIMEOUT_MS = 50;
const RETRY = { firstMs: 100, maxMs: 400 } as const;
const HEALTH_INTERVAL_MS = 1_000;

/** A session the listener opens: records its statements, and delivers notifications sent while it listens. */
class FakeSession implements ListenClient {
	readonly statements: string[] = [];
	readonly channels = new Set<string>();
	ended = false;
	/** A session whose peer vanished without a reset: it delivers nothing more, and nothing says so. */
	blackholed = false;
	private readonly handlers = new Map<string, ((...args: never[]) => void)[]>();
	failQuery: boolean;
	constructor(options: { readonly failQuery?: boolean } = {}) {
		this.failQuery = options.failQuery === true;
	}
	async query(sql: string): Promise<unknown> {
		this.statements.push(sql);
		if (this.failQuery) throw new Error("connection lost");
		if (sql === "UNLISTEN *") this.channels.clear();
		const listened = /^(UN)?LISTEN "(.*)"$/.exec(sql);
		if (listened?.[1] === undefined && listened?.[2] !== undefined) this.channels.add(listened[2]);
		else if (listened?.[2] !== undefined) this.channels.delete(listened[2]);
		return {};
	}
	on(event: string, handler: (...args: never[]) => void): unknown {
		this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
		return this;
	}
	async end(): Promise<void> {
		this.ended = true;
	}
	notify(channel: string, payload: string): void {
		if (this.ended || this.blackholed || !this.channels.has(channel)) return;
		for (const handler of this.handlers.get("notification") ?? [])
			(handler as (message: { channel: string; payload?: string }) => void)({ channel, payload });
	}
	fail(event: "error" | "end" = "error"): void {
		for (const handler of this.handlers.get(event) ?? []) (handler as () => void)();
	}
	/** Hands the listener a notification as the session would, whatever it listens to. */
	emit(message: { channel: string; payload?: string }): void {
		for (const handler of this.handlers.get("notification") ?? [])
			(handler as (message: { channel: string; payload?: string }) => void)(message);
	}
	/** The probe channel the listener listened to first. */
	probeChannel(): string {
		return /^LISTEN "(.*)"$/.exec(this.statements[0] ?? "")![1]!;
	}
}

/** A fake server: every session it opened, and whether the pool's notifications reach them (not through a pooler). */
function fakeServer(
	options: {
		pooled?: boolean;
		refuse?: () => boolean;
		failQuery?: boolean;
		send?: (deliver: (channel: string, payload: string) => void, channel: string, payload: string) => void;
		defaults?: boolean;
	} = {},
) {
	const sessions: FakeSession[] = [];
	let connects = 0;
	const deliver = (channel: string, payload: string) => {
		for (const session of sessions) session.notify(channel, payload);
	};
	const listener = createPostgresListener({
		async connect() {
			connects++;
			if (options.refuse?.()) throw new Error("connect ECONNREFUSED");
			const session = new FakeSession({ failQuery: options.failQuery === true });
			sessions.push(session);
			return session;
		},
		async send(channel, payload) {
			if (options.send !== undefined) options.send(deliver, channel, payload);
			else if (!options.pooled) deliver(channel, payload);
		},
		channelName: (channel) => `n_${channel}`,
		...(options.defaults === true
			? {}
			: { probeTimeoutMs: PROBE_TIMEOUT_MS, retry: RETRY, healthIntervalMs: HEALTH_INTERVAL_MS }),
	} satisfies ListenerOptions);
	return { listener, sessions, deliver, connects: () => connects };
}

function recorder() {
	const events: StorageNotificationEvent[] = [];
	return { events, listener: (event: StorageNotificationEvent) => events.push(event) };
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

test("a notification is a pg_notify statement on the shortened channel name (#5103)", () => {
	const { listener } = fakeServer();
	assert.deepEqual(listener.notify("p_pool_ready", "root"), {
		sql: "SELECT pg_notify(?, ?)",
		params: ["n_p_pool_ready", "root"],
	});
});

test("listening starts on the first listen, then delivers each channel's notifications to its own listeners (#5103)", async () => {
	const server = fakeServer();
	const ready = recorder();
	const wakeups = recorder();
	const readySubscription = server.listener.listen("ready", ready.listener);
	server.listener.listen("wakeups", wakeups.listener);
	assert.deepEqual(await server.listener.state(), { status: "listening" });
	assert.equal(server.connects(), 1, "one connection serves every channel");
	assert.deepEqual(server.sessions[0]!.statements.slice(1), ['LISTEN "n_ready"', 'LISTEN "n_wakeups"']);
	assert.deepEqual(ready.events, [{ kind: "listening" }]);
	server.deliver("n_ready", "root");
	server.deliver("n_wakeups", "broker");
	assert.deepEqual(ready.events, [{ kind: "listening" }, { kind: "notification", payload: "root" }]);
	assert.deepEqual(wakeups.events, [{ kind: "listening" }, { kind: "notification", payload: "broker" }]);
	readySubscription.close();
	readySubscription.close();
	await vi.runOnlyPendingTimersAsync();
	assert.equal(server.sessions[0]!.statements.at(-1), 'UNLISTEN "n_ready"');
	server.deliver("n_ready", "late");
	assert.equal(ready.events.length, 2);
	await server.listener.close();
	assert.equal(server.sessions[0]!.ended, true);
});

test("a channel added while listening is listened to on the open connection, and a second listener of a channel keeps it (#5103)", async () => {
	const server = fakeServer();
	server.listener.listen("first", () => {});
	await server.listener.state();
	const one = recorder();
	const two = recorder();
	const closing = server.listener.listen("second", one.listener);
	server.listener.listen("second", two.listener);
	await vi.runOnlyPendingTimersAsync();
	assert.equal(server.sessions[0]!.statements.filter((sql) => sql === 'LISTEN "n_second"').length, 1);
	closing.close();
	server.deliver("n_second", "root");
	assert.deepEqual(one.events, []);
	assert.deepEqual(two.events, [{ kind: "notification", payload: "root" }]);
	assert.ok(!server.sessions[0]!.statements.includes('UNLISTEN "n_second"'));
});

test("a probe that never arrives, as through a transaction pooler, leaves no LISTEN behind and is not tried again (#5103)", async () => {
	const server = fakeServer({ pooled: true });
	const events = recorder();
	server.listener.listen("ready", events.listener);
	const state = server.listener.state();
	await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
	assert.deepEqual(await state, { status: "unavailable", reason: "pooler" });
	const [session] = server.sessions;
	assert.equal(session!.ended, true);
	// Only the probe's own channel was ever listened to, and it was unlistened before the session closed.
	assert.deepEqual(session!.statements, [`LISTEN "${session!.probeChannel()}"`, "UNLISTEN *"]);
	assert.equal(session!.channels.size, 0);
	server.listener.listen("later", () => {});
	await vi.advanceTimersByTimeAsync(RETRY.maxMs * 10);
	assert.equal(server.connects(), 1, "a pooler is probed once per process");
	assert.deepEqual(await server.listener.state(), { status: "unavailable", reason: "pooler" });
	server.deliver("n_ready", "root");
	assert.deepEqual(events.events, [], "nothing is delivered through a session that is not listening");
	await server.listener.close();
});

test("a refused connection is retried after growing waits, up to the longest, and resumes with a listening event (#5103)", async () => {
	let refusing = true;
	const server = fakeServer({ refuse: () => refusing });
	const events = recorder();
	server.listener.listen("ready", events.listener);
	assert.deepEqual(await server.listener.state(), { status: "unavailable", reason: "connection-failed" });
	assert.equal(server.connects(), 1);
	for (const [wait, connects] of [
		[RETRY.firstMs, 2],
		[RETRY.firstMs * 2, 3],
		[RETRY.maxMs, 4],
		[RETRY.maxMs, 5],
	] as const) {
		await vi.advanceTimersByTimeAsync(wait - 1);
		assert.equal(server.connects(), connects - 1, `no retry before ${wait} ms`);
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(server.connects(), connects);
	}
	refusing = false;
	await vi.advanceTimersByTimeAsync(RETRY.maxMs);
	assert.deepEqual(await server.listener.state(), { status: "listening" });
	assert.deepEqual(events.events, [{ kind: "listening" }]);
	await server.listener.close();
	await vi.advanceTimersByTimeAsync(RETRY.maxMs * 4);
	assert.equal(server.connects(), 6, "a closed listener retries no more");
});

test("a session that breaks is replaced after the first wait, and a session that listened resets the waits (#5103)", async () => {
	const server = fakeServer();
	const events = recorder();
	server.listener.listen("ready", events.listener);
	await server.listener.state();
	server.sessions[0]!.fail();
	assert.deepEqual(await server.listener.state(), { status: "unavailable", reason: "connection-failed" });
	assert.equal(server.sessions[0]!.ended, true);
	await vi.advanceTimersByTimeAsync(RETRY.firstMs);
	assert.equal(server.sessions.length, 2);
	assert.deepEqual(await server.listener.state(), { status: "listening" });
	assert.deepEqual(events.events, [{ kind: "listening" }, { kind: "listening" }]);
	server.sessions[1]!.fail();
	await vi.advanceTimersByTimeAsync(RETRY.firstMs);
	assert.equal(server.sessions.length, 3, "the wait starts over after a session that listened");
	await server.listener.close();
});

test("a session whose LISTEN fails is dropped as a failed connection (#5103)", async () => {
	const server = fakeServer({ failQuery: true });
	server.listener.listen("ready", () => {});
	assert.deepEqual(await server.listener.state(), { status: "unavailable", reason: "connection-failed" });
	assert.equal(server.sessions[0]!.ended, true);
	await server.listener.close();
});

test("a listener that throws keeps the others delivered (#5103)", async () => {
	const server = fakeServer();
	const events = recorder();
	server.listener.listen("ready", () => {
		throw new Error("listener failed");
	});
	server.listener.listen("ready", events.listener);
	await server.listener.state();
	server.deliver("n_ready", "root");
	assert.deepEqual(events.events, [{ kind: "listening" }, { kind: "notification", payload: "root" }]);
	await server.listener.close();
});

test("a listener closed while connecting ends the session it opens (#5103)", async () => {
	let open!: (session: FakeSession) => void;
	const session = new FakeSession();
	const listener = createPostgresListener({
		connect: () =>
			new Promise<FakeSession>((resolve) => {
				open = resolve;
			}),
		send: async () => {},
		channelName: (channel) => channel,
	});
	listener.listen("ready", () => {});
	const closed = listener.close();
	open(session);
	await closed;
	assert.equal(session.ended, true);
	assert.deepEqual(session.statements, []);
	assert.deepEqual(await listener.state(), { status: "connecting" }, "a connection never opened says so");
});

test("without options the listener retries after a second, doubling up to thirty (#5103)", async () => {
	assert.deepEqual(LISTEN_RETRY, { firstMs: 1_000, maxMs: 30_000 });
	assert.equal(LISTEN_HEALTH_INTERVAL_MS, 30_000);
	const server = fakeServer({ refuse: () => true, defaults: true });
	server.listener.listen("ready", () => {});
	await server.listener.state();
	await vi.advanceTimersByTimeAsync(999);
	assert.equal(server.connects(), 1);
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(server.connects(), 2);
	await server.listener.close();
});

test("a channel name with a quote is quoted whole (#5103)", async () => {
	const server = fakeServer();
	server.listener.listen('a"b', () => {});
	await server.listener.state();
	assert.equal(server.sessions[0]!.statements.at(-1), 'LISTEN "n_a""b"');
	await server.listener.close();
});

test("a listener closed while its connection is refused connects no more (#5103)", async () => {
	let refuse!: (error: Error) => void;
	let connects = 0;
	const listener = createPostgresListener({
		connect: () => {
			connects++;
			return new Promise<ListenClient>((_, reject) => {
				refuse = reject;
			});
		},
		send: async () => {},
		channelName: (channel) => channel,
	});
	listener.listen("ready", () => {});
	const closed = listener.close();
	refuse(new Error("refused"));
	await closed;
	await vi.advanceTimersByTimeAsync(LISTEN_RETRY.maxMs * 2);
	assert.equal(connects, 1);
});

test("a session that ends is replaced, and a failure of a session already replaced changes nothing (#5103)", async () => {
	const server = fakeServer();
	const events = recorder();
	server.listener.listen("ready", events.listener);
	await server.listener.state();
	server.sessions[0]!.fail("end");
	assert.deepEqual(await server.listener.state(), { status: "unavailable", reason: "connection-failed" });
	await vi.advanceTimersByTimeAsync(RETRY.firstMs);
	assert.deepEqual(await server.listener.state(), { status: "listening" });
	server.sessions[0]!.fail("error");
	assert.deepEqual(await server.listener.state(), { status: "listening" });
	assert.equal(server.sessions[1]!.ended, false);
	// A notification the replaced session still hands over is not delivered.
	server.sessions[0]!.emit({ channel: "n_ready", payload: "stale" });
	server.sessions[1]!.emit({ channel: "n_ready" });
	assert.deepEqual(events.events.slice(-1), [{ kind: "notification", payload: "" }]);
	assert.ok(!events.events.some((event) => event.kind === "notification" && event.payload === "stale"));
	await server.listener.close();
});

test("a notification before the probe arrives, or a probe with another payload, is not taken for listening (#5103)", async () => {
	let session: FakeSession | undefined;
	const events = recorder();
	const server = fakeServer({
		send: (_deliver, channel) => {
			session = server.sessions[0];
			session!.emit({ channel: "n_ready", payload: "early" });
			session!.emit({ channel, payload: "not-the-nonce" });
		},
	});
	server.listener.listen("ready", events.listener);
	const state = server.listener.state();
	await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
	assert.deepEqual(await state, { status: "unavailable", reason: "pooler" });
	assert.deepEqual(events.events, []);
	await server.listener.close();
});

test("a probe that arrives after its session broke does not make the listener listening (#5103)", async () => {
	const server = fakeServer({
		send: (deliver, channel, payload) => {
			server.sessions[0]!.fail();
			server.sessions[0]!.ended = false;
			deliver(channel, payload);
		},
	});
	server.listener.listen("ready", () => {});
	assert.deepEqual(await server.listener.state(), { status: "unavailable", reason: "connection-failed" });
	await server.listener.close();
});

test("a stray probe notification after listening is ignored (#5103)", async () => {
	const server = fakeServer();
	const events = recorder();
	server.listener.listen("ready", events.listener);
	await server.listener.state();
	server.sessions[0]!.emit({ channel: server.sessions[0]!.probeChannel(), payload: "late" });
	assert.deepEqual(events.events, [{ kind: "listening" }]);
	await server.listener.close();
});

test("a channel added while the probe is in flight is listened to on that session (#5103)", async () => {
	let release!: () => void;
	const server = fakeServer({
		send: (deliver, channel, payload) => {
			release = () => deliver(channel, payload);
		},
	});
	server.listener.listen("ready", () => {});
	const state = server.listener.state();
	await vi.advanceTimersByTimeAsync(0);
	const late = recorder();
	server.listener.listen("late", late.listener);
	await vi.advanceTimersByTimeAsync(0);
	release();
	assert.deepEqual(await state, { status: "listening" });
	server.deliver("n_late", "root");
	assert.deepEqual(late.events, [{ kind: "listening" }, { kind: "notification", payload: "root" }]);
	await server.listener.close();
});

test("a LISTEN or UNLISTEN that fails on a listening session drops it as a failed connection (#5103)", async () => {
	for (const failing of ["listen", "unlisten"] as const) {
		const server = fakeServer();
		const first = server.listener.listen("ready", () => {});
		await server.listener.state();
		server.sessions[0]!.failQuery = true;
		if (failing === "listen") server.listener.listen("other", () => {});
		else first.close();
		await vi.advanceTimersByTimeAsync(0);
		assert.deepEqual(await server.listener.state(), { status: "unavailable", reason: "connection-failed" }, failing);
		assert.equal(server.sessions[0]!.ended, true);
		await server.listener.close();
	}
});

test("a listening session that stops delivering, as a half-open connection, is replaced at its next health probe (#5103)", async () => {
	const server = fakeServer();
	const events = recorder();
	server.listener.listen("ready", events.listener);
	await server.listener.state();
	// Healthy probes keep the session.
	await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 3);
	assert.equal(server.sessions.length, 1);
	assert.deepEqual(await server.listener.state(), { status: "listening" });
	server.sessions[0]!.blackholed = true;
	await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS + PROBE_TIMEOUT_MS - 1);
	assert.deepEqual(await server.listener.state(), { status: "listening" }, "not before the probe times out");
	await vi.advanceTimersByTimeAsync(1);
	assert.deepEqual(await server.listener.state(), { status: "unavailable", reason: "connection-failed" });
	assert.equal(server.sessions[0]!.ended, true);
	await vi.advanceTimersByTimeAsync(RETRY.firstMs);
	assert.equal(server.sessions.length, 2);
	assert.deepEqual(await server.listener.state(), { status: "listening" });
	assert.deepEqual(events.events, [{ kind: "listening" }, { kind: "listening" }]);
	server.deliver("n_ready", "root");
	assert.deepEqual(events.events.at(-1), { kind: "notification", payload: "root" });
	await server.listener.close();
	const sessions = server.sessions.length;
	await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 3);
	assert.equal(server.sessions.length, sessions, "a closed listener probes no more");
});

test("a health probe the pool cannot send replaces the session too (#5103)", async () => {
	let failing = false;
	const server = fakeServer({
		send: (deliver, channel, payload) => {
			if (failing) throw new Error("pool unavailable");
			deliver(channel, payload);
		},
	});
	server.listener.listen("ready", () => {});
	await server.listener.state();
	failing = true;
	await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
	assert.deepEqual(await server.listener.state(), { status: "unavailable", reason: "connection-failed" });
	await server.listener.close();
});

test("a notification for a channel whose last listener just left is dropped (#5103)", async () => {
	const server = fakeServer();
	const other = recorder();
	const leaving = server.listener.listen("ready", () => {});
	server.listener.listen("other", other.listener);
	await server.listener.state();
	leaving.close();
	// The session may still hand one over before its UNLISTEN takes effect.
	server.sessions[0]!.emit({ channel: "n_ready", payload: "late" });
	server.sessions[0]!.emit({ channel: "n_other", payload: "root" });
	assert.deepEqual(other.events.at(-1), { kind: "notification", payload: "root" });
	await server.listener.close();
});

test("the same notification within the window goes out once, after the commits it was held for; another goes out at once", async () => {
	const later: unknown[][] = [];
	const coalescer = createNotifyCoalescer({
		sendLater: async (notices) => {
			later.push(notices.map((notice) => notice.params));
		},
	});
	const wake = (broker: string) => ({ sql: "SELECT pg_notify(?, ?)", params: ["wakeups", broker] });
	const committed = Promise.resolve(true);
	assert.deepEqual(coalescer.take([wake("b"), wake("c")], committed), [wake("b"), wake("c")]);
	// Two more commits for b within the window, one of them rolled back, and one for d.
	assert.deepEqual(coalescer.take([wake("b")], committed), []);
	assert.deepEqual(coalescer.take([wake("b")], Promise.resolve(false)), []);
	assert.deepEqual(coalescer.take([wake("d")], committed), [wake("d")]);
	await vi.advanceTimersByTimeAsync(NOTIFY_COALESCE_MS - 1);
	assert.deepEqual(later, [], "held until the window since the last one passed");
	await vi.advanceTimersByTimeAsync(1);
	assert.deepEqual(later, [[["wakeups", "b"]]], "once for the commits held back, none for c or d");
	// The window starts again with the one sent later.
	assert.deepEqual(coalescer.take([wake("b")], committed), []);
	await vi.advanceTimersByTimeAsync(NOTIFY_COALESCE_MS);
	assert.equal(later.length, 2);
	await vi.advanceTimersByTimeAsync(NOTIFY_COALESCE_MS);
	assert.deepEqual(coalescer.take([wake("b")], committed), [wake("b")], "past the window it goes with its commit");
	await coalescer.flush();
	assert.equal(later.length, 2, "nothing held, nothing sent");
});

test("a notification held for a commit not yet answered waits for it, and closing sends what is held at once", async () => {
	const later: unknown[][] = [];
	const coalescer = createNotifyCoalescer({
		sendLater: async (notices) => {
			later.push(notices.map((notice) => notice.params));
		},
	});
	const wake = { sql: "SELECT pg_notify(?, ?)", params: ["wakeups", "b"] };
	coalescer.take([wake], Promise.resolve(true));
	let answer!: (done: boolean) => void;
	coalescer.take([wake], new Promise<boolean>((resolve) => (answer = resolve)));
	await vi.advanceTimersByTimeAsync(NOTIFY_COALESCE_MS * 3);
	assert.deepEqual(later, [], "its commit is not answered yet");
	answer(true);
	await vi.advanceTimersByTimeAsync(0);
	assert.deepEqual(later, [[["wakeups", "b"]]], "sent once its commit is answered, the window having passed");
	coalescer.take([wake], Promise.resolve(true));
	await vi.advanceTimersByTimeAsync(0);
	await coalescer.flush();
	assert.deepEqual(later, [[["wakeups", "b"]], [["wakeups", "b"]]]);
});
