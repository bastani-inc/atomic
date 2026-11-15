import assert from "node:assert/strict";
import type { StorageNotificationEvent } from "@bastani/atomic/storage";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createPostgresListener, type ListenClient } from "../../packages/storage-postgres/listen.js";

/**
 * The Postgres listening connection (#5103) against a fake session: what it listens to, when it reports listening,
 * how it treats a probe that never arrives (a transaction pooler), and how it retries a connection that fails.
 */

const PROBE_TIMEOUT_MS = 50;
const RETRY = { firstMs: 100, maxMs: 400 } as const;

/** A session the listener opens: records its statements, and delivers notifications sent while it listens. */
class FakeSession implements ListenClient {
	readonly statements: string[] = [];
	readonly channels = new Set<string>();
	ended = false;
	private readonly handlers = new Map<string, ((...args: never[]) => void)[]>();
	constructor(private readonly options: { readonly failQuery?: boolean } = {}) {}
	async query(sql: string): Promise<unknown> {
		this.statements.push(sql);
		if (this.options.failQuery) throw new Error("connection lost");
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
		if (this.ended || !this.channels.has(channel)) return;
		for (const handler of this.handlers.get("notification") ?? [])
			(handler as (message: { channel: string; payload?: string }) => void)({ channel, payload });
	}
	fail(): void {
		for (const handler of this.handlers.get("error") ?? []) (handler as () => void)();
	}
}

/** A fake server: every session it opened, and whether the pool's notifications reach them (not through a pooler). */
function fakeServer(options: { pooled?: boolean; refuse?: () => boolean; failQuery?: boolean } = {}) {
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
			if (!options.pooled) deliver(channel, payload);
		},
		channelName: (channel) => `n_${channel}`,
		probeTimeoutMs: PROBE_TIMEOUT_MS,
		retry: RETRY,
	});
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

test("a probe that never arrives, as through a transaction pooler, reports the pooler and closes the session (#5103)", async () => {
	const server = fakeServer({ pooled: true });
	const events = recorder();
	server.listener.listen("ready", events.listener);
	const state = server.listener.state();
	await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
	assert.deepEqual(await state, { status: "unavailable", reason: "pooler" });
	assert.equal(server.sessions[0]!.ended, true);
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
});
