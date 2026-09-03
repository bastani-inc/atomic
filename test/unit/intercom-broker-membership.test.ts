import assert from "node:assert/strict";
import type net from "node:net";
import { test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { knownGroupSummaries, sessionsVisibleTo } from "../../packages/intercom/broker/group-membership.js";
import { handleBrokerPresence } from "../../packages/intercom/broker/presence-handler.js";
import { type BrokerConnectedSession, handleBrokerSend } from "../../packages/intercom/broker/send-handler.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import type { BrokerMessage, Message } from "../../packages/intercom/types.js";

function connected(
	id: string,
	groups: string[],
	socket: net.Socket,
	extra: Partial<BrokerConnectedSession> = {},
): BrokerConnectedSession {
	return {
		socket,
		info: {
			id,
			name: id,
			cwd: "/tmp",
			model: "test",
			pid: 1,
			startedAt: 1,
			lastActivity: 1,
			groups,
			group: groups[0],
		},
		registrationGroup: groups[0],
		...extra,
	};
}

function wireMessage(id: string, extra: Partial<Message> = {}): Message {
	return { id, timestamp: 1, content: { text: "hello" }, ...extra };
}

function setup(definitions: Array<[string, string[]]>): {
	sessions: Map<string, BrokerConnectedSession>;
	sockets: Record<string, net.Socket>;
	writes: Array<{ socket: net.Socket; message: BrokerMessage }>;
	presence(id: string, message: Record<string, unknown>): void;
	send(id: string, to: string, message: Message, type?: "send" | "supervisor_send"): void;
} {
	const sessions = new Map<string, BrokerConnectedSession>();
	const sockets: Record<string, net.Socket> = {};
	for (const [id, groups] of definitions) {
		const socket = {} as net.Socket;
		sockets[id] = socket;
		sessions.set(id, connected(id, groups, socket));
	}
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	const write = (socket: net.Socket, message: BrokerMessage): boolean => {
		writes.push({ socket, message });
		return true;
	};
	return {
		sessions,
		sockets,
		writes,
		presence: (id, message) => handleBrokerPresence(sockets[id]!, message as never, id, sessions, write),
		send: (id, to, message, type = "send") =>
			handleBrokerSend(
				sockets[id]!,
				{ type, to, message },
				id,
				sessions,
				new DeliveredMessageCache(),
				write,
				new SupervisorChannelCache(),
			),
	};
}

test("joining adds a membership and broadcasts presence in both groups", () => {
	const h = setup([
		["member", ["alpha"]],
		["alpha-peer", ["alpha"]],
		["beta-peer", ["beta"]],
		["outside", ["outside"]],
	]);

	h.presence("member", { type: "join_group", group: "beta", requestId: "join-1" });

	assert.deepEqual(h.sessions.get("member")?.info.groups, ["alpha", "beta"]);
	assert.equal(
		h.writes.some(({ socket, message }) => socket === h.sockets["alpha-peer"] && message.type === "presence_update"),
		true,
	);
	assert.equal(
		h.writes.some(({ socket, message }) => socket === h.sockets["beta-peer"] && message.type === "session_joined"),
		true,
	);
	assert.equal(
		h.writes.some(({ socket }) => socket === h.sockets.outside),
		false,
	);
});

test("named leave removes only that group and unnamed leave returns to the home group", () => {
	const h = setup([
		["member", ["home", "alpha", "beta"]],
		["home-peer", ["home"]],
		["alpha-peer", ["alpha"]],
		["beta-peer", ["beta"]],
	]);
	h.sessions.set("member", { ...h.sessions.get("member")!, registrationGroup: "home" });

	h.presence("member", { type: "leave_group", group: "alpha", requestId: "leave-alpha" });
	assert.deepEqual(h.sessions.get("member")?.info.groups, ["home", "beta"]);
	assert.equal(
		h.writes.some(({ socket, message }) => socket === h.sockets["alpha-peer"] && message.type === "session_left"),
		true,
	);

	h.writes.length = 0;
	h.presence("member", { type: "leave_group", requestId: "leave-home" });
	assert.deepEqual(h.sessions.get("member")?.info.groups, ["home"]);
	assert.equal(
		h.writes.some(({ socket, message }) => socket === h.sockets["beta-peer"] && message.type === "session_left"),
		true,
	);
	assert.equal(
		h.writes.some(({ socket, message }) => socket === h.sockets["home-peer"] && message.type === "presence_update"),
		true,
	);
});

test("routing and list visibility use intersecting membership sets", () => {
	const h = setup([
		["bridge", ["alpha", "beta"]],
		["alpha-peer", ["alpha"]],
		["beta-peer", ["beta"]],
		["outside", ["outside"]],
	]);

	assert.deepEqual(
		sessionsVisibleTo(h.sessions, h.sessions.get("bridge")!.info)
			.map((session) => session.id)
			.sort(),
		["alpha-peer", "beta-peer", "bridge"],
	);
	h.send("bridge", "alpha-peer", wireMessage("to-alpha"));
	h.send("bridge", "beta-peer", wireMessage("to-beta"));
	h.send("bridge", "outside", wireMessage("to-outside"));
	assert.equal(
		h.writes.some(({ socket, message }) => socket === h.sockets["alpha-peer"] && message.type === "message"),
		true,
	);
	assert.equal(
		h.writes.some(({ socket, message }) => socket === h.sockets["beta-peer"] && message.type === "message"),
		true,
	);
	assert.equal(
		h.writes.some(({ socket, message }) => socket === h.sockets.outside && message.type === "message"),
		false,
	);
});

test("supervisor routing still crosses non-overlapping memberships", () => {
	const h = setup([
		["child", ["alpha", "beta"]],
		["supervisor", ["outside"]],
	]);
	h.sessions.get("child")!.supervisorId = "supervisor";

	h.send("child", "supervisor", wireMessage("supervisor-message"), "supervisor_send");

	assert.equal(
		h.writes.some(({ socket, message }) => socket === h.sockets.supervisor && message.type === "message"),
		true,
	);
});

test("all-groups summaries include every active group, counts, and requester membership", () => {
	const h = setup([
		["requester", ["alpha", "beta"]],
		["alpha-peer", ["alpha"]],
		["outside", ["outside"]],
	]);

	assert.deepEqual(knownGroupSummaries(h.sessions, h.sessions.get("requester")!.info), [
		{ group: "alpha", sessionCount: 2, member: true },
		{ group: "beta", sessionCount: 1, member: true },
		{ group: "outside", sessionCount: 1, member: false },
	]);
});

test("legacy single-group presence keeps replacement behavior", () => {
	const h = setup([
		["legacy", ["alpha"]],
		["alpha-peer", ["alpha"]],
		["beta-peer", ["beta"]],
	]);

	h.presence("legacy", { type: "presence", group: "beta", requestId: "legacy-presence" });

	assert.deepEqual(h.sessions.get("legacy")?.info.groups, ["beta"]);
	assert.equal(h.sessions.get("legacy")?.info.group, "beta");
	assert.equal(
		h.writes.some(({ socket, message }) => socket === h.sockets["alpha-peer"] && message.type === "session_left"),
		true,
	);
	assert.equal(
		h.writes.some(({ socket, message }) => socket === h.sockets["beta-peer"] && message.type === "session_joined"),
		true,
	);
});
