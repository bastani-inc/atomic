import assert from "node:assert/strict";
import type net from "node:net";
import { Socket } from "node:net";
import { afterEach, test, vi } from "vitest";
import { IntercomClient, type SendResult } from "../../packages/intercom/broker/client.js";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { ROUTE_UNAVAILABLE_REASON } from "../../packages/intercom/broker/delivery-failure-reason.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import {
	type BrokerConnectedSession,
	handleBrokerSend,
	ROUTE_RESTORATION_WAIT_MS,
} from "../../packages/intercom/broker/send-handler.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { BrokerMessage } from "../../packages/intercom/types.js";

const UNAUTHORIZED = "Pending question route does not authorize this public reply";

function session(id: string): BrokerConnectedSession {
	return {
		socket: { id } as unknown as net.Socket,
		info: { id, name: id, cwd: "/tmp", model: "test", pid: 1, startedAt: 1, lastActivity: 1 },
		registrationReturnAddress: `${id}-address`,
	};
}

/** An asker and its recipient on one broker after a restart, and the recipient's reply to the asker's ask. */
function replyAfterRestart() {
	const asker = session("asker");
	const replier = session("replier");
	const sessions = new Map([
		[asker.info.id, asker],
		[replier.info.id, replier],
	]);
	const pending = new PendingQuestionIndex();
	const writes: Array<{ to: net.Socket; frame: BrokerMessage }> = [];
	const reply = (messageId: string) =>
		handleBrokerSend(
			replier.socket,
			{
				type: "send",
				to: asker.info.id,
				requirePendingReply: true,
				message: { id: messageId, timestamp: 1, replyTo: "question", content: { text: "port 8080" } },
			},
			replier.info.id,
			sessions,
			new DeliveredMessageCache(),
			(to, frame) => {
				writes.push({ to, frame });
				return true;
			},
			undefined,
			pending,
		);
	const answers = () => writes.filter((write) => write.to === replier.socket).map((write) => write.frame);
	const delivered = () => writes.filter((write) => write.to === asker.socket).map((write) => write.frame);
	return { asker, replier, pending, reply, answers, delivered };
}

afterEach(() => {
	vi.useRealTimers();
});

test("a reply to an asker whose routes are still being restored is delivered once they are (#5101)", () => {
	const { asker, replier, pending, reply, answers, delivered } = replyAfterRestart();
	const restoring = pending.beginRestoring(asker.info.id);

	reply("reply-1");
	assert.deepEqual(answers(), [], "the reply was decided before the asker's routes were restored");

	pending.record(asker.info.id, replier.info.id, "question");
	pending.finishRestoring(asker.info.id, restoring);
	assert.deepEqual(
		answers().map((frame) => frame.type),
		["delivered"],
	);
	assert.deepEqual(
		delivered().map((frame) => (frame.type === "message" ? frame.message.id : frame.type)),
		["reply-1"],
	);
});

test("a reply whose replier's own routes are still being restored waits for them too (#5101)", () => {
	const { asker, replier, pending, reply, answers } = replyAfterRestart();
	const restoring = pending.beginRestoring(replier.info.id);

	reply("reply-1");
	assert.deepEqual(answers(), []);

	pending.record(asker.info.id, replier.info.id, "question");
	pending.finishRestoring(replier.info.id, restoring);
	assert.deepEqual(
		answers().map((frame) => frame.type),
		["delivered"],
	);
});

test("a reply no restored route authorizes is still refused as unauthorized (#5101)", () => {
	const { asker, pending, reply, answers, delivered } = replyAfterRestart();
	const restoring = pending.beginRestoring(asker.info.id);

	reply("reply-1");
	pending.finishRestoring(asker.info.id, restoring);
	assert.deepEqual(answers(), [
		{ type: "delivery_failed", messageId: "reply-1", attemptId: undefined, reason: UNAUTHORIZED },
	]);
	assert.deepEqual(delivered(), []);
});

test("a reply still waiting on a restoration when its bound passes is refused as retryable, once (#5101)", () => {
	vi.useFakeTimers();
	const { asker, replier, pending, reply, answers, delivered } = replyAfterRestart();
	const restoring = pending.beginRestoring(asker.info.id);

	reply("reply-1");
	vi.advanceTimersByTime(ROUTE_RESTORATION_WAIT_MS - 1);
	assert.deepEqual(answers(), []);
	vi.advanceTimersByTime(1);
	assert.deepEqual(answers(), [
		{
			type: "delivery_failed",
			messageId: "reply-1",
			attemptId: undefined,
			reason: ROUTE_UNAVAILABLE_REASON,
			routeUnavailable: true,
		},
	]);

	// The restoration that ends later does not decide the same reply again.
	pending.record(asker.info.id, replier.info.id, "question");
	pending.finishRestoring(asker.info.id, restoring);
	assert.equal(answers().length, 1);
	assert.deepEqual(delivered(), []);
});

test("a restoration that a newer one replaced does not release the replies waiting on the newer one (#5101)", () => {
	const { asker, replier, pending, reply, answers } = replyAfterRestart();
	const first = pending.beginRestoring(asker.info.id);
	const second = pending.beginRestoring(asker.info.id);

	reply("reply-1");
	pending.finishRestoring(asker.info.id, first);
	assert.deepEqual(
		answers(),
		[],
		"the abandoned registration decided the reply before the asker's routes were restored",
	);

	pending.record(asker.info.id, replier.info.id, "question");
	pending.finishRestoring(asker.info.id, second);
	assert.deepEqual(
		answers().map((frame) => frame.type),
		["delivered"],
	);
});

function connectedClient() {
	const client = new IntercomClient();
	const frames: Array<Record<string, unknown> & { attemptId: string }> = [];
	const socket = new Socket();
	vi.spyOn(socket, "write").mockImplementation((data) => {
		assert.ok(Buffer.isBuffer(data));
		frames.push(JSON.parse(data.subarray(4).toString("utf8")));
		return true;
	});
	client["socket"] = socket;
	client["_sessionId"] = "replier";
	const receive = (message: object) => client["handleBrokerMessage"](message as never);
	return { client, frames, receive };
}

test("a client resolves a reply refused while its route is unavailable as route_unavailable (#5101)", async () => {
	const { client, frames, receive } = connectedClient();
	const sent = client.send("asker", { text: "port 8080", messageId: "reply-1", replyTo: "question" });
	receive({
		type: "delivery_failed",
		messageId: "reply-1",
		attemptId: frames[0]?.attemptId,
		reason: ROUTE_UNAVAILABLE_REASON,
		routeUnavailable: true,
	});
	assert.deepEqual(await sent, {
		id: "reply-1",
		delivered: false,
		reason: ROUTE_UNAVAILABLE_REASON,
		reasonCode: "route_unavailable",
	});
});

test("a client keeps the wire reason code of a refusal that also says its route is unavailable (#5101)", async () => {
	const { client, frames, receive } = connectedClient();
	const sent = client.send("asker", { text: "port 8080", messageId: "reply-1", replyTo: "question" });
	receive({
		type: "delivery_failed",
		messageId: "reply-1",
		attemptId: frames[0]?.attemptId,
		reason: "Session not found",
		reasonCode: "session_not_found",
		routeUnavailable: true,
	});
	assert.equal((await sent).reasonCode, "session_not_found");
});

interface ToolResult {
	readonly content: Array<{ text: string }>;
	readonly isError: boolean;
	readonly details?: Record<string, unknown>;
}

/** The intercom tool replying to an ask whose reply the broker refuses with `refusal`. */
async function replyRefusedWith(refusal: Omit<SendResult, "id" | "delivered">): Promise<ToolResult> {
	const asker = { id: "asker", name: "asker", cwd: "/tmp", model: "test", pid: 1, startedAt: 1, lastActivity: 1 };
	const replies = new ReplyTracker();
	replies.recordIncomingMessage(asker, {
		id: "question",
		timestamp: 1,
		expectsReply: true,
		content: { text: "which port?" },
	});
	let tool: { execute(...args: unknown[]): Promise<ToolResult> } | undefined;
	const client = {
		sessionId: "replier",
		async listSessions() {
			return [asker];
		},
		async send(_to: string, message: { messageId: string }): Promise<SendResult> {
			return { id: message.messageId, delivered: false, ...refusal };
		},
	};
	const waiters = new ReplyWaiterRegistry();
	registerIntercomTool(
		{
			registerTool(value: typeof tool) {
				tool = value;
			},
			async appendEntry() {},
		} as never,
		{
			ensureConnected: async () => client,
			syncPresenceIdentity() {},
			confirmSend: false,
			beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) => waiters.begin(from, replyTo, signal),
			replyTracker: replies,
		} as never,
	);
	assert.ok(tool);
	return tool.execute("reply", { action: "reply", message: "port 8080" }, undefined, undefined, {
		sessionManager: { getSessionId: () => "atomic-session" },
		hasUI: false,
	});
}

test("the intercom tool tells the agent a reply refused while its route is unavailable may be sent again (#5101)", async () => {
	const result = await replyRefusedWith({ reason: ROUTE_UNAVAILABLE_REASON, reasonCode: "route_unavailable" });
	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /Try again shortly/);
	assert.equal(result.details?.reasonCode, "route_unavailable");
	assert.equal(result.details?.retryLater, true);
});

test("the intercom tool does not tell the agent to retry a reply refused for good (#5101)", async () => {
	const result = await replyRefusedWith({ reason: UNAUTHORIZED });
	assert.equal(result.isError, true);
	assert.equal(result.details?.retryLater, undefined);
	assert.equal(result.details?.reasonCode, undefined);
});
