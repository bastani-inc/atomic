import assert from "node:assert/strict";
import type net from "node:net";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	PRESENCE_BACKLOG_BYTES,
	PRESENCE_COALESCE_INTERVAL_MS,
	PRESENCE_MAX_DEFERRAL_MS,
	PresenceFanout,
} from "../../packages/intercom/broker/presence-fanout.js";
import { handleBrokerPresence } from "../../packages/intercom/broker/presence-handler.js";
import type { BrokerConnectedSession } from "../../packages/intercom/broker/send-handler.js";
import type { BrokerMessage, SessionInfo } from "../../packages/intercom/types.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function connected(id: string, groups: string[], extra: Partial<SessionInfo> = {}): BrokerConnectedSession {
	return {
		socket: { writableLength: 0 } as net.Socket,
		info: {
			id,
			name: id,
			cwd: "/tmp",
			model: "m",
			pid: 1,
			startedAt: 1,
			lastActivity: 1,
			groups,
			group: groups[0],
			...extra,
		},
		registrationGroup: groups[0],
	};
}

function harness(definitions: Array<[string, string[]]>) {
	const sessions = new Map<string, BrokerConnectedSession>();
	for (const [id, groups] of definitions) sessions.set(id, connected(id, groups));
	const writes: Array<{ to: string; message: BrokerMessage }> = [];
	const recipientOf = (socket: net.Socket) =>
		[...sessions.values()].find((session) => session.socket === socket)?.info.id ?? "?";
	const write = (socket: net.Socket, message: BrokerMessage) => {
		writes.push({ to: recipientOf(socket), message });
	};
	const fanout = new PresenceFanout(sessions, write);
	const presence = (id: string, message: Record<string, unknown>) =>
		handleBrokerPresence(
			sessions.get(id)!.socket,
			message as never,
			id,
			sessions,
			write,
			undefined,
			(peer, changed) => fanout.queue(peer, changed.info.id),
		);
	const updates = () =>
		writes.flatMap(({ to, message }) =>
			message.type === "presence_update" ? [`${to}<-${message.session.id}:${message.session.status}`] : [],
		);
	return { sessions, writes, fanout, presence, updates };
}

test("a burst of changes reaches each peer as one update carrying the latest state, after the interval (#5146)", async () => {
	const h = harness([
		["a", ["g"]],
		["b", ["g"]],
		["c", ["g"]],
		["outsider", ["other"]],
	]);
	for (const status of ["one", "two", "three"]) h.presence("a", { type: "presence", status });
	h.presence("b", { type: "presence", status: "busy" });
	assert.deepEqual(h.updates(), [], "nothing is written before the interval ends");

	await vi.advanceTimersByTimeAsync(PRESENCE_COALESCE_INTERVAL_MS);

	assert.deepEqual(h.updates().sort(), ["a<-b:busy", "b<-a:three", "c<-a:three", "c<-b:busy"]);
});

test("an update that changes nothing a peer sees, such as a tool call's identity sync, is not sent (#5146)", async () => {
	const h = harness([
		["a", ["g"]],
		["b", ["g"]],
	]);
	h.presence("a", { type: "presence", name: "a", model: "m", groups: ["g"] });
	await vi.advanceTimersByTimeAsync(PRESENCE_COALESCE_INTERVAL_MS * 4);
	assert.deepEqual(h.writes, []);

	h.presence("a", { type: "presence", model: "other" });
	await vi.advanceTimersByTimeAsync(PRESENCE_COALESCE_INTERVAL_MS);
	assert.equal(h.writes.length, 1, "a changed model is still news");
});

test("a recipient whose socket is backlogged gets presence after its backlog drains, or after the deferral cap (#5146)", async () => {
	const h = harness([
		["a", ["g"]],
		["slow", ["g"]],
		["stuck", ["g"]],
	]);
	const slow = h.sessions.get("slow")!.socket as { writableLength: number };
	const stuck = h.sessions.get("stuck")!.socket as { writableLength: number };
	slow.writableLength = PRESENCE_BACKLOG_BYTES + 1;
	stuck.writableLength = PRESENCE_BACKLOG_BYTES + 1;
	h.presence("a", { type: "presence", status: "busy" });

	await vi.advanceTimersByTimeAsync(PRESENCE_COALESCE_INTERVAL_MS * 3);
	assert.deepEqual(h.updates(), [], "receipts, acknowledgements and messages already queued go first");

	slow.writableLength = PRESENCE_BACKLOG_BYTES;
	await vi.advanceTimersByTimeAsync(PRESENCE_COALESCE_INTERVAL_MS);
	assert.deepEqual(h.updates(), ["slow<-a:busy"]);

	await vi.advanceTimersByTimeAsync(PRESENCE_MAX_DEFERRAL_MS);
	assert.deepEqual(h.updates(), ["slow<-a:busy", "stuck<-a:busy"], "presence is never held back indefinitely");
});

test("a flush writes gathered presence at once, and a session gone or out of the group by then is not announced (#5146)", async () => {
	const h = harness([
		["a", ["g"]],
		["b", ["g"]],
		["leaver", ["g"]],
		["mover", ["g"]],
	]);
	h.presence("a", { type: "presence", status: "busy" });
	h.presence("leaver", { type: "presence", status: "busy" });
	h.presence("mover", { type: "presence", status: "busy" });
	h.sessions.delete("leaver");
	h.sessions.get("mover")!.info.groups = ["elsewhere"];
	h.sessions.get("mover")!.info.group = "elsewhere";

	h.fanout.flush(h.sessions.get("b")!.socket);
	assert.deepEqual(h.updates(), ["b<-a:busy"]);

	await vi.advanceTimersByTimeAsync(PRESENCE_COALESCE_INTERVAL_MS);
	assert.deepEqual(
		h.updates().filter((update) => update.startsWith("b<-")),
		["b<-a:busy"],
		"flushed presence is not written twice",
	);
});

test("presence gathered for a session that disconnected, or for a replaced connection, is dropped (#5146)", async () => {
	const h = harness([
		["a", ["g"]],
		["gone", ["g"]],
		["replaced", ["g"]],
		["disposed", ["other"]],
	]);
	h.presence("a", { type: "presence", status: "busy" });
	h.fanout.forget(h.sessions.get("gone")!.socket);
	h.sessions.set("replaced", connected("replaced", ["g"]));

	await vi.advanceTimersByTimeAsync(PRESENCE_COALESCE_INTERVAL_MS);
	assert.deepEqual(h.updates(), []);

	h.fanout.queue(h.sessions.get("disposed")!, "a");
	h.fanout.dispose();
	await vi.advanceTimersByTimeAsync(PRESENCE_COALESCE_INTERVAL_MS);
	assert.deepEqual(h.updates(), []);
});
