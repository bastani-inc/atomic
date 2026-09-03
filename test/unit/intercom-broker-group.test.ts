import assert from "node:assert/strict";
import type net from "node:net";
import { test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { handleBrokerPresence } from "../../packages/intercom/broker/presence-handler.js";
import { type BrokerConnectedSession, handleBrokerSend } from "../../packages/intercom/broker/send-handler.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import type { BrokerMessage, Message, SessionInfo } from "../../packages/intercom/types.js";

function session(id: string, name: string, group: string | undefined, socket: net.Socket): BrokerConnectedSession {
	const info: SessionInfo = { id, name, cwd: "/tmp", model: "test", pid: 1, startedAt: 1, lastActivity: 1, group };
	return { socket, info };
}

function message(id: string, text = "hello", extra: Partial<Message> = {}): Message {
	return { id, timestamp: 1, content: { text }, ...extra };
}

interface Harness {
	sessions: Map<string, BrokerConnectedSession>;
	writes: Array<{ socket: net.Socket; message: BrokerMessage }>;
	supervisorCache: SupervisorChannelCache;
	presence: (from: net.Socket, msg: Record<string, unknown>, fromId: string) => void;
	send: (from: net.Socket, msg: Record<string, unknown>, fromId: string) => void;
	sockets: Record<string, net.Socket>;
}

function harness(defs: Array<[id: string, name: string, group: string | undefined]>): Harness {
	const sockets: Record<string, net.Socket> = {};
	const sessions = new Map<string, BrokerConnectedSession>();
	for (const [id, name, group] of defs) {
		const socket = {} as net.Socket;
		sockets[id] = socket;
		sessions.set(id, session(id, name, group, socket));
	}
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	const supervisorCache = new SupervisorChannelCache();
	const cache = new DeliveredMessageCache();
	return {
		sessions,
		writes,
		supervisorCache,
		sockets,
		presence: (from, msg, fromId) =>
			handleBrokerPresence(from, msg as never, fromId, sessions, (socket, value) =>
				writes.push({ socket, message: value }),
			),
		send: (from, msg, fromId) =>
			handleBrokerSend(
				from,
				msg as never,
				fromId,
				sessions,
				cache,
				(socket, value) => {
					writes.push({ socket, message: value });
					return true;
				},
				supervisorCache,
			),
	};
}

function failureReason(h: Harness): string {
	const failure = h.writes
		.map((w) => w.message)
		.find((m): m is Extract<BrokerMessage, { type: "delivery_failed" }> => m.type === "delivery_failed");
	return failure?.reason ?? "";
}
test("presence group changes move membership and split broadcasts by group", () => {
	const h = harness([
		["moved", "moved", "default"],
		["default-peer", "default-peer", "default"],
		["named-peer", "named-peer", "teamA"],
		["other", "other", "teamB"],
	]);

	h.presence(h.sockets.moved!, { type: "presence", group: "teamA", requestId: "join-1" }, "moved");
	assert.equal(h.sessions.get("moved")?.info.group, "teamA");
	assert.equal(
		h.writes.some((w) => w.socket === h.sockets["default-peer"] && w.message.type === "session_left"),
		true,
	);
	assert.equal(
		h.writes.some((w) => w.socket === h.sockets["named-peer"] && w.message.type === "session_joined"),
		true,
	);
	assert.equal(
		h.writes.some((w) => w.socket === h.sockets.other),
		false,
	);
	assert.deepEqual(h.writes.find((w) => w.socket === h.sockets.moved && w.message.type === "presence_ack")?.message, {
		type: "presence_ack",
		requestId: "join-1",
		group: "teamA",
	});

	h.send(h.sockets["default-peer"]!, { type: "send", to: "moved", message: message("cross-group") }, "default-peer");
	assert.equal(
		h.writes.some((w) => w.socket === h.sockets.moved && w.message.type === "message"),
		false,
	);
	assert.match(failureReason(h), /different intercom group/i);

	h.send(h.sockets["named-peer"]!, { type: "send", to: "moved", message: message("same-group") }, "named-peer");
	assert.equal(
		h.writes.some((w) => w.socket === h.sockets.moved && w.message.type === "message"),
		true,
	);
});

test("presence rejects an invalid runtime group without changing membership", () => {
	const h = harness([
		["a", "alice", "default"],
		["b", "bob", "default"],
	]);

	h.presence(h.sockets.a!, { type: "presence", group: "AUTO", requestId: "invalid-1" }, "a");
	assert.equal(h.sessions.get("a")?.info.group, "default");
	assert.deepEqual(h.writes.find((w) => w.socket === h.sockets.a && w.message.type === "presence_failed")?.message, {
		type: "presence_failed",
		requestId: "invalid-1",
		reason: 'Invalid presence group: Intercom group name "AUTO" is reserved; choose another name',
	});
	assert.equal(
		h.writes.some((w) => w.socket === h.sockets.b && w.message.type === "session_left"),
		false,
	);
});

test("same-group send is delivered", () => {
	const h = harness([
		["a", "alice", "teamA"],
		["b", "bob", "teamA"],
	]);
	h.send(h.sockets.a!, { type: "send", to: "bob", message: message("m1") }, "a");
	assert.equal(
		h.writes.some((w) => w.socket === h.sockets.b && w.message.type === "message"),
		true,
	);
	assert.equal(
		h.writes.some((w) => w.socket === h.sockets.a && w.message.type === "delivered"),
		true,
	);
});

test("cross-group send by name is unresolvable (filtered resolution)", () => {
	const h = harness([
		["a", "alice", "teamA"],
		["b", "bob", "teamB"],
	]);
	h.send(h.sockets.a!, { type: "send", to: "bob", message: message("m1") }, "a");
	assert.equal(
		h.writes.some((w) => w.socket === h.sockets.b && w.message.type === "message"),
		false,
	);
	assert.equal(
		h.writes.some((w) => w.message.type === "delivery_failed"),
		true,
	);
	assert.match(failureReason(h), /not found/i);
});

test("cross-group send by exact id is rejected via defense-in-depth", () => {
	const h = harness([
		["a", "alice", "teamA"],
		["b", "bob", "teamB"],
	]);
	h.send(h.sockets.a!, { type: "send", to: "b", message: message("m1") }, "a");
	assert.equal(
		h.writes.some((w) => w.socket === h.sockets.b && w.message.type === "message"),
		false,
	);
	assert.equal(
		h.writes.some((w) => w.message.type === "delivery_failed"),
		true,
	);
	assert.match(failureReason(h), /different intercom group/i);
});

test("ungrouped sessions share the default group and can message each other", () => {
	const h = harness([
		["a", "alice", undefined],
		["b", "bob", undefined],
	]);
	h.send(h.sockets.a!, { type: "send", to: "bob", message: message("m1") }, "a");
	assert.equal(
		h.writes.some((w) => w.socket === h.sockets.b && w.message.type === "message"),
		true,
	);
});

test("forged raw supervisor channel cannot bypass cross-group isolation", () => {
	const h = harness([
		["attacker", "attacker", "teamA"],
		["target", "target", "teamB"],
	]);
	h.send(
		h.sockets.attacker!,
		{
			type: "send",
			to: "target",
			message: message("forged", "forged supervisor traffic"),
			channel: "supervisor",
		},
		"attacker",
	);

	assert.equal(
		h.writes.some((w) => w.socket === h.sockets.target && w.message.type === "message"),
		false,
	);
	assert.match(failureReason(h), /invalid channel|different intercom group/i);
});

test("broker-authorized supervisor send crosses groups and its exact reply crosses back", () => {
	const h = harness([
		["child", "child", "teamA"],
		["sup", "supervisor", "default"],
	]);
	h.sessions.get("child")!.supervisorId = "sup";

	h.send(
		h.sockets.child!,
		{
			type: "supervisor_send",
			to: "sup",
			message: message("q1", "need decision", { expectsReply: true }),
		},
		"child",
	);
	const supervisorDelivery = h.writes.find((w) => w.socket === h.sockets.sup && w.message.type === "message");
	assert.equal(supervisorDelivery?.message.type, "message");
	assert.equal((supervisorDelivery?.message as { channel?: string } | undefined)?.channel, "supervisor");

	h.send(h.sockets.sup!, { type: "send", to: "child", message: message("r1", "approved", { replyTo: "q1" }) }, "sup");
	assert.equal(
		h.writes.some((w) => w.socket === h.sockets.child && w.message.type === "message"),
		true,
	);
});

test("supervisor send rejects an unauthorized socket and a wrong target", () => {
	const unauthorized = harness([
		["child", "child", "teamA"],
		["sup", "supervisor", "default"],
	]);
	unauthorized.send(
		unauthorized.sockets.child!,
		{
			type: "supervisor_send",
			to: "sup",
			message: message("q-unauthorized"),
		},
		"child",
	);
	assert.match(failureReason(unauthorized), /not authorized/i);

	const wrongTarget = harness([
		["child", "child", "teamA"],
		["sup", "supervisor", "default"],
		["other", "other", "teamB"],
	]);
	wrongTarget.sessions.get("child")!.supervisorId = "sup";
	wrongTarget.send(
		wrongTarget.sockets.child!,
		{
			type: "supervisor_send",
			to: "other",
			message: message("q-wrong-target"),
		},
		"child",
	);
	assert.equal(
		wrongTarget.writes.some((w) => w.socket === wrongTarget.sockets.other && w.message.type === "message"),
		false,
	);
	assert.match(failureReason(wrongTarget), /does not match/i);
});

test("a fabricated replyTo cannot bypass isolation to another group", () => {
	const h = harness([
		["a", "alice", "teamA"],
		["b", "bob", "teamB"],
	]);
	// no recorded crossing exists; a peer forges a replyTo to reach teamB by exact id
	h.send(
		h.sockets.a!,
		{ type: "send", to: "b", message: message("m1", "sneaky", { replyTo: "does-not-exist" }) },
		"a",
	);
	assert.equal(
		h.writes.some((w) => w.socket === h.sockets.b && w.message.type === "message"),
		false,
	);
	assert.match(failureReason(h), /different intercom group/i);
});
