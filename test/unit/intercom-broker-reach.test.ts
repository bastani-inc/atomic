import assert from "node:assert/strict";
import type net from "node:net";
import { test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { knownGroupSummaries, sessionsVisibleTo } from "../../packages/intercom/broker/group-membership.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import { handleBrokerPresence, replaceSessionReach } from "../../packages/intercom/broker/presence-handler.js";
import { type HeldSend, RestoringRecipients } from "../../packages/intercom/broker/restoring-recipients.js";
import { type BrokerConnectedSession, handleBrokerSend } from "../../packages/intercom/broker/send-handler.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import { createReachPolicy, type IntercomReachPolicy } from "../../packages/intercom/reach-policy.js";
import type { BrokerMessage, Message } from "../../packages/intercom/types.js";

interface Definition {
	readonly groups: string[];
	readonly reach?: IntercomReachPolicy;
}

function connected(id: string, definition: Definition, socket: net.Socket): BrokerConnectedSession {
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
			groups: definition.groups,
			group: definition.groups[0],
		},
		registrationGroup: definition.groups[0],
		...(definition.reach === undefined ? {} : { reach: definition.reach }),
	};
}

function message(id: string, extra: Partial<Message> = {}): Message {
	return { id, timestamp: 1, content: { text: id }, ...extra };
}

function broker(definitions: Record<string, Definition>) {
	const sessions = new Map<string, BrokerConnectedSession>();
	const sockets: Record<string, net.Socket> = {};
	for (const [id, definition] of Object.entries(definitions)) {
		const socket = { id } as unknown as net.Socket;
		sockets[id] = socket;
		sessions.set(id, connected(id, definition, socket));
	}
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	const write = (socket: net.Socket, frame: BrokerMessage): boolean => {
		writes.push({ socket, message: frame });
		return true;
	};
	const pendingQuestions = new PendingQuestionIndex();
	const delivered = new DeliveredMessageCache();
	const framesTo = (id: string) => writes.filter(({ socket }) => socket === sockets[id]).map(({ message }) => message);
	return {
		sessions,
		pendingQuestions,
		framesTo,
		presence(id: string, frame: Record<string, unknown>) {
			handleBrokerPresence(sockets[id]!, frame as never, id, sessions, write);
		},
		send(id: string, to: string, sent: Message, extra: Record<string, unknown> = {}) {
			handleBrokerSend(
				sockets[id]!,
				{ type: "send", to, message: sent, ...extra },
				id,
				sessions,
				delivered,
				write,
				new SupervisorChannelCache(),
				pendingQuestions,
			);
		},
		received(id: string): string[] {
			return framesTo(id).flatMap((frame) => (frame.type === "message" ? [frame.message.id] : []));
		},
		outcome(id: string, messageId: string): BrokerMessage | undefined {
			return framesTo(id).find(
				(frame) =>
					(frame.type === "delivered" || frame.type === "delivery_failed") && frame.messageId === messageId,
			);
		},
		write,
	};
}

const reachOf = (home: string, reachable: string[] = []) => createReachPolicy(home, reachable);

test("the broker refuses a send outside the sender's reach with the reason, and delivers one inside it (#5352)", () => {
	const b = broker({
		a: { groups: ["doc-a"], reach: reachOf("doc-a", ["doc-b"]) },
		b: { groups: ["doc-b"], reach: reachOf("doc-b") },
		c: { groups: ["doc-c"], reach: reachOf("doc-c") },
	});
	b.send("a", "b", message("a-to-b"));
	b.send("a", "c", message("a-to-c"));
	b.send("b", "a", message("b-to-a"));

	assert.deepEqual(b.received("b"), ["a-to-b"]);
	assert.deepEqual(b.received("c"), []);
	assert.deepEqual(b.received("a"), []);
	const refused = b.outcome("a", "a-to-c");
	assert.equal(refused?.type, "delivery_failed");
	assert.match(
		refused?.type === "delivery_failed" ? refused.reason : "",
		/outside this session's Intercom reach \(home group doc-a; reachable groups: doc-b\)/,
	);
	const reverse = b.outcome("b", "b-to-a");
	assert.match(reverse?.type === "delivery_failed" ? reverse.reason : "", /reachable groups: none/);
});

test("a name outside the sender's reach is not found, and the reason says what the sender reaches (#5352)", () => {
	const b = broker({
		a: { groups: ["doc-a"], reach: reachOf("doc-a") },
		c: { groups: ["doc-c"] },
	});
	b.send("a", "C", message("by-name"));
	const refused = b.outcome("a", "by-name");
	assert.match(
		refused?.type === "delivery_failed" ? refused.reason : "",
		/^Session not found\. This session reaches only/,
	);
	assert.deepEqual(b.received("c"), []);
});

test("a reply to an ask the replier received crosses one-way reach; an unrecorded reply does not (#5352)", () => {
	const b = broker({
		a: { groups: ["doc-a"], reach: reachOf("doc-a", ["doc-b"]) },
		b: { groups: ["doc-b"], reach: reachOf("doc-b") },
	});
	b.send("a", "b", message("question", { expectsReply: true }));
	assert.deepEqual(b.received("b"), ["question"]);

	b.send("b", "a", message("answer", { replyTo: "question" }));
	b.send("b", "a", message("forged-answer", { replyTo: "never-asked" }));

	assert.deepEqual(b.received("a"), ["answer"]);
	assert.equal(b.outcome("b", "forged-answer")?.type, "delivery_failed");
});

test("list and groups show a session with a reach policy only what it reaches (#5352)", () => {
	const b = broker({
		a: { groups: ["doc-a"], reach: reachOf("doc-a", ["doc-b"]) },
		a2: { groups: ["doc-a"], reach: reachOf("doc-a") },
		"a-team": { groups: ["doc-a/team"], reach: reachOf("doc-a/team") },
		b: { groups: ["doc-b"], reach: reachOf("doc-b") },
		c: { groups: ["doc-c"] },
		legacy: { groups: ["doc-a", "doc-c"] },
	});
	const visible = (id: string) =>
		sessionsVisibleTo(b.sessions, b.sessions.get(id)!.info, b.sessions.get(id)!.reach)
			.map((session) => session.id)
			.filter((other) => other !== id)
			.sort();
	assert.deepEqual(visible("a"), ["a-team", "a2", "b", "legacy"]);
	assert.deepEqual(visible("b"), []);
	assert.deepEqual(visible("a-team"), []);
	assert.deepEqual(visible("legacy"), ["a", "a2", "c"], "a session without a policy keeps the membership rule");

	const a = b.sessions.get("a")!;
	assert.deepEqual(knownGroupSummaries(b.sessions, a.info, a.reach), [
		{ group: "doc-a", sessionCount: 3, member: true },
		{ group: "doc-b", sessionCount: 1, member: false },
	]);
	const legacy = b.sessions.get("legacy")!;
	assert.deepEqual(
		knownGroupSummaries(b.sessions, legacy.info).map((summary) => summary.group),
		["doc-a", "doc-a/team", "doc-b", "doc-c"],
	);
});

test("a forged join, leave or presence outside the policy is refused and changes nothing (#5352)", () => {
	const b = broker({
		a: { groups: ["doc-a"], reach: reachOf("doc-a", ["doc-b"]) },
		c: { groups: ["doc-c"] },
	});
	const refusals = () => b.framesTo("a").filter((frame) => frame.type === "presence_failed");
	b.presence("a", { type: "join_group", group: "doc-c", requestId: "join-c" });
	b.presence("a", { type: "leave_group", group: "doc-a", requestId: "leave-home" });
	b.presence("a", { type: "presence", groups: ["doc-a", "doc-c"], requestId: "presence-c" });
	b.presence("a", { type: "presence", groups: ["doc-b"], requestId: "presence-without-home" });
	b.presence("a", { type: "presence", group: "doc-c", requestId: "legacy-group" });
	assert.deepEqual(
		refusals().map((frame) => (frame.type === "presence_failed" ? frame.requestId : "")),
		["join-c", "leave-home", "presence-c", "presence-without-home", "legacy-group"],
	);
	assert.match(refusals()[0]?.type === "presence_failed" ? refusals()[0]!.reason : "", /Group doc-c is outside/);
	assert.match(
		refusals()[1]?.type === "presence_failed" ? refusals()[1]!.reason : "",
		/home group doc-a can't be left/,
	);
	assert.deepEqual(b.sessions.get("a")!.info.groups, ["doc-a"]);
	assert.equal(b.framesTo("c").length, 0, "no peer heard of a refused change");

	b.presence("a", { type: "join_group", group: "doc-b", requestId: "join-b" });
	assert.deepEqual(b.sessions.get("a")!.info.groups, ["doc-a", "doc-b"]);
	b.presence("a", { type: "leave_group", requestId: "home" });
	assert.deepEqual(b.sessions.get("a")!.info.groups, ["doc-a"]);
});

test("a narrowed reach drops memberships outside it and refuses the next send (#5352)", () => {
	const b = broker({
		a: { groups: ["doc-a", "doc-b"], reach: reachOf("doc-a", ["doc-b"]) },
		b: { groups: ["doc-b"], reach: reachOf("doc-b") },
	});
	b.send("a", "b", message("before"));
	assert.equal(b.outcome("a", "before")?.type, "delivered");
	assert.ok(b.sessions.get("b") !== undefined);

	replaceSessionReach(b.sessions, b.write, b.sessions.get("a")!, reachOf("doc-a"));

	assert.deepEqual(b.sessions.get("a")!.info.groups, ["doc-a"]);
	assert.ok(
		b.framesTo("b").some((frame) => frame.type === "session_left" && frame.sessionId === "a"),
		"b no longer sees a once a left doc-b",
	);
	b.send("a", "b", message("after"));
	assert.equal(b.outcome("a", "after")?.type, "delivery_failed");
	assert.deepEqual(b.received("b"), ["before"]);
});

test("a send outside the sender's reach is never held for a restoring subagent (#5352)", () => {
	const holds = new RestoringRecipients(() => {});
	holds.reserve("owner:child", "owner", "child", "doc-b", []);
	const held = (senderId: string): HeldSend => ({
		socket: {} as net.Socket,
		senderId,
		messageId: `${senderId}-message`,
		clientMessage: { type: "send", to: "child" },
	});
	const info = (id: string, groups: string[]) => ({
		id,
		cwd: "/",
		model: "m",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
		groups,
	});

	const outside = { id: "a", info: info("a", ["doc-a"]), reach: reachOf("doc-a") };
	assert.deepEqual(holds.admit("child", outside, held("a"), true), { kind: "none" });

	const reaching = { id: "a2", info: info("a2", ["doc-a"]), reach: reachOf("doc-a", ["doc-b"]) };
	assert.equal(holds.admit("child", reaching, held("a2"), true).kind, "held");

	const answering = { id: "a3", info: info("a3", ["doc-a"]), reach: reachOf("doc-a"), answersAsk: true as const };
	assert.equal(
		holds.admit("child", answering, held("a3"), true).kind,
		"held",
		"a reply to the child's ask is always allowed",
	);

	const legacyOutside = { id: "l", info: info("l", ["doc-c"]), answersAsk: true as const };
	assert.deepEqual(
		holds.admit("child", legacyOutside, held("l"), true),
		{ kind: "none" },
		"legacy holds are unchanged",
	);
});
