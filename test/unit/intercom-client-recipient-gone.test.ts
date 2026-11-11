import assert from "node:assert/strict";
import { Socket } from "node:net";
import { test, vi } from "vitest";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const {
	IntercomClient,
	isSubagentRecipientEndedError,
	ReleasedChildReservationError,
	SubagentRecipientDisconnectedError,
	SubagentRecipientEndedError,
	serializeIntercomRecipientGoneError,
	serializeIntercomReleasedReplyError,
	ReleasedReplyAnsweredError,
} = await import("../../packages/intercom/broker/client.js");

const FIELDS = { target: "subagent-worker-aabcf28b-1", childName: "subagent-worker-aabcf28b-1", childId: "aabcf28b:0" };

type Frame = Record<string, unknown> & { attemptId: string; requestId: string };

function connectedClient(marksEndedChildren = true) {
	const client = new IntercomClient();
	const frames: Frame[] = [];
	const socket = new Socket();
	vi.spyOn(socket, "write").mockImplementation((data) => {
		assert.ok(Buffer.isBuffer(data));
		frames.push(JSON.parse(data.subarray(4).toString("utf8")));
		return true;
	});
	client["socket"] = socket;
	client["_sessionId"] = "owner";
	client["brokerMarksEndedChildren"] = marksEndedChildren;
	const receive = (message: object) => client["handleBrokerMessage"](message as never);
	return { client, frames, receive };
}

test("a client resolves a send to a gone subagent with the typed error the broker sent, its code as the reason code (#4639)", async () => {
	const { client, frames, receive } = connectedClient();
	const sent = client.send(FIELDS.target, { text: "are you done?", messageId: "m1" });
	const error = new SubagentRecipientEndedError("recipient_completed", FIELDS);
	receive({
		type: "delivery_failed",
		messageId: "m1",
		attemptId: frames[0]!.attemptId,
		reason: error.message,
		recipientError: JSON.parse(JSON.stringify(serializeIntercomRecipientGoneError(error))),
	});
	const result = await sent;
	assert.equal(result.delivered, false);
	assert.equal(result.reason, error.message);
	assert.equal(result.reasonCode, "recipient_completed");
	assert.ok(result.error instanceof SubagentRecipientEndedError);
	assert.ok(isSubagentRecipientEndedError(result.error));
	assert.deepEqual(result.error.fields, FIELDS);
});

test("a client refuses a delivery failure whose gone-recipient error is malformed or comes with another code (#4639)", () => {
	const { receive } = connectedClient();
	const serialized = serializeIntercomRecipientGoneError(new SubagentRecipientDisconnectedError(FIELDS));
	const replyError = serializeIntercomReleasedReplyError(
		new ReleasedReplyAnsweredError({ messageId: "m", questionId: "q", childName: "c" }),
	);
	for (const frame of [
		{ recipientError: { ...serialized, fields: {} } },
		{ recipientError: "recipient_disconnected" },
		{ recipientError: serialized, reasonCode: "session_not_found" },
		{ recipientError: serialized, reasonCode: "released_reply_answered", error: replyError },
	]) {
		assert.throws(
			() => receive({ type: "delivery_failed", messageId: "m", reason: "refused", ...frame }),
			/Invalid delivery_failed message/,
			JSON.stringify(frame),
		);
	}
	assert.doesNotThrow(() =>
		receive({ type: "delivery_failed", messageId: "m", reason: "refused", recipientError: serialized }),
	);
});

test("a client reports ended subagents in frames of at most 500, each acknowledged before the next (#4639)", async () => {
	const { client, frames, receive } = connectedClient();
	const children = Array.from({ length: 501 }, (_, index) => ({
		childName: `subagent-worker-${index}`,
		outcome: "completed" as const,
	}));
	children[0] = {
		childName: "subagent-worker-0",
		outcome: "completed",
		...{ group: "workflow:run", aliases: ["01a1c1d9-bebd-73e1-a79d-668cf0bd43b8"], childId: "run:0" },
	};
	const marked = client.markEndedChildren(children);
	await vi.waitFor(() => assert.equal(frames.length, 1));
	assert.equal(frames[0]!.type, "mark_ended_children");
	const first = frames[0]!.children as Array<Record<string, unknown>>;
	assert.equal(first.length, 500);
	assert.deepEqual(first[0], {
		childName: "subagent-worker-0",
		group: "workflow:run",
		aliases: ["01a1c1d9-bebd-73e1-a79d-668cf0bd43b8"],
		outcome: "completed",
		childId: "run:0",
	});
	assert.deepEqual(first[1], { childName: "subagent-worker-1", outcome: "completed" });
	receive({ type: "released_children_ack", requestId: frames[0]!.requestId });
	await vi.waitFor(() => assert.equal(frames.length, 2));
	assert.deepEqual(frames[1]!.children, [{ childName: "subagent-worker-500", outcome: "completed" }]);
	receive({ type: "released_children_ack", requestId: frames[1]!.requestId });
	await marked;
});

test("a broker's refusal of an ended-subagent report rejects with the typed reservation error (#4639)", async () => {
	const { client, frames, receive } = connectedClient();
	const marked = client.markEndedChildren([{ childName: "subagent-worker-1", outcome: "failed" }]);
	await vi.waitFor(() => assert.equal(frames.length, 1));
	receive({
		type: "released_children_ack",
		requestId: frames[0]!.requestId,
		refusal: { code: "not_owner", childName: "subagent-worker-1" },
	});
	const error = await marked.then(
		() => undefined,
		(refusal: Error) => refusal,
	);
	assert.ok(error instanceof ReleasedChildReservationError);
	assert.equal(error.code, "not_owner");
});

test("a client sends no report to a broker that does not take one, or when there is nothing to report (#4639)", async () => {
	const older = connectedClient(false);
	await older.client.markEndedChildren([{ childName: "subagent-worker-1", outcome: "completed" }]);
	assert.deepEqual(older.frames, []);
	const current = connectedClient();
	await current.client.markEndedChildren([]);
	assert.deepEqual(current.frames, []);
});

test("registration takes the broker's ended-subagent capability only as `true` (#4639)", () => {
	const registered = (marksEndedChildren: unknown) => {
		const client = new IntercomClient();
		client.on("_registered", () => {});
		client["handleBrokerMessage"]({ type: "registered", sessionId: "s1", marksEndedChildren } as never);
		return client["brokerMarksEndedChildren"] as boolean;
	};
	assert.equal(registered(true), true);
	assert.equal(registered(undefined), false);
	assert.throws(() => registered("yes"), /Invalid registered message/);
	assert.throws(() => registered(false), /Invalid registered message/);
});

test("a client that never registered sends no report and does not fail (#4639)", async () => {
	await new IntercomClient().markEndedChildren([{ childName: "subagent-worker-1", outcome: "completed" }]);
});

test("exactly 500 ended subagents go in one frame (#4639)", async () => {
	const { client, frames, receive } = connectedClient();
	const marked = client.markEndedChildren(
		Array.from({ length: 500 }, (_, index) => ({
			childName: `subagent-worker-${index}`,
			outcome: "failed" as const,
		})),
	);
	await vi.waitFor(() => assert.equal(frames.length, 1));
	receive({ type: "released_children_ack", requestId: frames[0]!.requestId });
	await marked;
	assert.equal(frames.length, 1);
});
