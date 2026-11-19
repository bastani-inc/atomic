import assert from "node:assert/strict";
import type net from "node:net";
import { test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import { handleBrokerPresence } from "../../packages/intercom/broker/presence-handler.js";
import { type BrokerConnectedSession, handleBrokerSend } from "../../packages/intercom/broker/send-handler.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import type { BrokerMessage } from "../../packages/intercom/types.js";

function fixture() {
	const peer = (id: string): BrokerConnectedSession => ({
		socket: {} as net.Socket,
		info: { id, name: id, cwd: "/tmp", model: "test", pid: 1, startedAt: 1, lastActivity: 1, status: "idle" },
	});
	const sender = peer("parent");
	const child = peer("child");
	const sessions = new Map([sender, child].map((p) => [p.info.id, p]));
	const pending = new PendingQuestionIndex();
	const cache = new DeliveredMessageCache();
	const frames: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	const write = (socket: net.Socket, message: BrokerMessage) => {
		frames.push({ socket, message });
		return true;
	};
	const send = (id: string, expectsReply: boolean) =>
		handleBrokerSend(
			sender.socket,
			{ type: "send", to: "child", message: { id, timestamp: 1, expectsReply, content: { text: "question" } } },
			sender.info.id,
			sessions,
			cache,
			write,
			new SupervisorChannelCache(),
			pending,
		);
	return { sender, child, sessions, pending, frames, write, send };
}

// Regression: completed reviewer run 29c8290a retained an idle registration and admitted an unanswerable ask.
test("terminal child rejects asks immediately while retaining send delivery", () => {
	const f = fixture();
	f.child.info.replyCapability = "terminal";
	f.send("ask", true);
	assert.equal(f.frames.length, 1);
	const failure = f.frames[0]?.message;
	assert.equal(failure?.type, "delivery_failed");
	assert.ok(failure?.type === "delivery_failed");
	assert.match(failure.reason, /terminal.*cannot reply/i);
	assert.deepEqual(f.pending.takeForTarget("child"), []);
	f.send("send", false);
	assert.equal(f.frames.at(-1)?.message.type, "delivered");
	assert.equal(f.frames.at(-2)?.socket, f.child.socket);
});

test("terminal transition explicitly fails an acknowledged ask and does not settle unrelated peers", () => {
	const f = fixture();
	f.send("race", true);
	f.pending.record("parent", "other", "unrelated");
	handleBrokerPresence(
		f.child.socket,
		{ type: "presence", replyCapability: "terminal" },
		"child",
		f.sessions,
		f.write,
		f.pending,
	);
	const feedback = f.frames
		.filter((frame) => frame.socket === f.sender.socket && frame.message.type === "message")
		.map((frame) => frame.message as Extract<BrokerMessage, { type: "message" }>);
	assert.equal(feedback.length, 1);
	assert.equal(feedback[0]?.message.replyTo, "race");
	assert.match(feedback[0]?.message.replyError ?? "", /terminal.*cannot reply/i);
	assert.deepEqual(f.pending.takeForTarget("child"), []);
	assert.equal(f.pending.takeForTarget("other").length, 1);
});

test("terminal transition before socket acknowledgement cannot strand a newly recorded ask", () => {
	const f = fixture();
	let acknowledge: ((written: boolean) => void) | undefined;
	handleBrokerSend(
		f.sender.socket,
		{
			type: "send",
			to: "child",
			message: { id: "write-race", timestamp: 1, expectsReply: true, content: { text: "question" } },
		},
		"parent",
		f.sessions,
		new DeliveredMessageCache(),
		f.write,
		new SupervisorChannelCache(),
		f.pending,
		(_socket, _message, callback) => {
			acknowledge = callback;
		},
	);
	handleBrokerPresence(
		f.child.socket,
		{ type: "presence", replyCapability: "terminal" },
		"child",
		f.sessions,
		f.write,
		f.pending,
	);
	assert.ok(acknowledge);
	acknowledge(true);
	assert.deepEqual(f.pending.takeForTarget("child"), []);
	const last = f.frames.at(-1)?.message;
	assert.equal(last?.type, "delivery_failed");
	if (last?.type === "delivery_failed") assert.match(last.reason, /terminal.*cannot reply/i);
});

test("live idle and retained workflow recipients still accept asks and replies settle before termination", () => {
	for (const capability of [undefined, "live"] as const) {
		const f = fixture();
		f.child.info.replyCapability = capability;
		f.send("answered", true);
		assert.equal(f.frames.at(-1)?.message.type, "delivered");
		handleBrokerSend(
			f.child.socket,
			{
				type: "send",
				to: "parent",
				message: { id: "answer", timestamp: 2, replyTo: "answered", content: { text: "answer" } },
			},
			"child",
			f.sessions,
			new DeliveredMessageCache(),
			f.write,
			new SupervisorChannelCache(),
			f.pending,
		);
		const before = f.frames.filter((frame) => frame.message.type === "message").length;
		handleBrokerPresence(
			f.child.socket,
			{ type: "presence", replyCapability: "terminal" },
			"child",
			f.sessions,
			f.write,
			f.pending,
		);
		assert.equal(f.frames.filter((frame) => frame.message.type === "message").length, before);
		assert.deepEqual(f.pending.takeForTarget("child"), []);
		f.send("answered", true);
		assert.equal(
			f.frames.at(-1)?.message.type,
			"delivery_failed",
			"accepted ask retries cannot reopen a terminal wait",
		);
	}
});

test("disconnect before socket acknowledgement cannot create a stranded ask route", () => {
	const f = fixture();
	let acknowledge: ((written: boolean) => void) | undefined;
	handleBrokerSend(
		f.sender.socket,
		{
			type: "send",
			to: "child",
			message: { id: "disconnect-race", timestamp: 1, expectsReply: true, content: { text: "question" } },
		},
		"parent",
		f.sessions,
		new DeliveredMessageCache(),
		f.write,
		new SupervisorChannelCache(),
		f.pending,
		(_socket, _message, callback) => {
			acknowledge = callback;
		},
	);
	f.sessions.delete("child");
	assert.ok(acknowledge);
	acknowledge(true);
	assert.deepEqual(f.pending.takeForTarget("child"), []);
	const last = f.frames.at(-1)?.message;
	assert.ok(last?.type === "delivery_failed");
	assert.match(last.reason, /disconnected before replying/);
});
