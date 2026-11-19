import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import type { IntercomClient, SendResult } from "../../packages/intercom/broker/client.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import { toolContext } from "../helpers/tool-context.js";

const sender: SessionInfo = {
	id: "sender-1",
	name: "reviewer",
	cwd: "/repo",
	model: "test",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
};
const message: Message = {
	id: "message-1",
	timestamp: 1,
	expectsReply: true,
	content: { text: "please reply" },
};

test("replyTo selects an exact ask when one sender has concurrent pending questions", () => {
	const tracker = new ReplyTracker();
	tracker.recordIncomingMessage(sender, message);
	tracker.recordIncomingMessage(sender, { ...message, id: "message-2" });

	assert.equal(tracker.resolveReplyTarget({ replyTo: "message-2" }).message.id, "message-2");
	assert.equal(tracker.resolveReplyTarget({ to: "reviewer", replyTo: "message-1" }).message.id, "message-1");
	assert.throws(() => tracker.resolveReplyTarget({ to: "another-session", replyTo: "message-1" }), /not from/);
});

test("explicit reply targets fail closed without redirecting the active ordinary thread", () => {
	const tracker = new ReplyTracker();
	const context = tracker.recordIncomingMessage(sender, { ...message, id: "plain", expectsReply: false });
	tracker.queueTurnContext(context);
	tracker.beginTurn();
	tracker.admitTurnMessage("plain");
	tracker.recordIncomingMessage(sender, message);
	for (const replyTo of ["stale-thread", ""]) {
		assert.throws(() => tracker.resolveReplyTarget({ replyTo }), /No .*reply context/);
	}
	assert.throws(() => tracker.resolveReplyTarget({ to: "" }), /No pending ask/);
	assert.throws(() => tracker.resolveReplyTarget({ to: "other", replyTo: "plain" }), /not from/);
	assert.equal(tracker.resolveReplyTarget({ replyTo: "plain" }), context);
	assert.equal(tracker.resolveReplyTarget({}), context);
	assert.deepEqual(
		tracker.listPending().map((pending) => pending.message.id),
		[message.id],
	);
});

test("parallel children keep every parent-targeted ask independently addressable", () => {
	const tracker = new ReplyTracker();
	const childA = { ...sender, id: "child-a", name: "child-a" };
	const childB = { ...sender, id: "child-b", name: "child-b" };
	tracker.recordIncomingMessage(childA, { ...message, id: "a-1" }, 1);
	tracker.recordIncomingMessage(childB, { ...message, id: "b-1" }, 2);
	tracker.recordIncomingMessage(childA, { ...message, id: "a-2" }, 3);

	assert.deepEqual(
		tracker.listPending().map((context) => context.message.id),
		["a-1", "b-1", "a-2"],
	);
	assert.equal(tracker.resolveReplyTarget({ to: "child-b" }).message.id, "b-1");
	assert.throws(() => tracker.resolveReplyTarget({ to: "child-a" }), /Multiple pending asks/);
	assert.equal(tracker.resolveReplyTarget({ replyTo: "a-2" }).message.id, "a-2");
	tracker.markReplied("a-2");
	assert.deepEqual(
		tracker.listPending().map((context) => context.message.id),
		["a-1", "b-1"],
	);
});

test("markReplied removes an exact ask from queued turn contexts", () => {
	const tracker = new ReplyTracker();
	const first = tracker.recordIncomingMessage(sender, message, 1);
	const second = tracker.recordIncomingMessage(sender, { ...message, id: "message-2" }, 2);
	tracker.queueTurnContext(first);
	tracker.queueTurnContext(second);
	tracker.markReplied("message-2");
	tracker.beginTurn();
	tracker.admitTurnMessage("message-2");
	tracker.admitTurnMessage("message-1");
	assert.equal(tracker.resolveReplyTarget({}), first);
	tracker.markReplied("message-1");
	tracker.endTurn();
	tracker.beginTurn();
	assert.throws(() => tracker.resolveReplyTarget({}), /No active intercom context/);
});

function replyWithCommit(appendEntry: ExtensionAPI["appendEntry"], queued = false) {
	const tracker = new ReplyTracker();
	tracker.recordIncomingMessage(sender, message);
	let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
	const api: Pick<ExtensionAPI, "registerTool" | "appendEntry"> = {
		registerTool(registered) {
			tool = registered;
		},
		appendEntry,
	};
	const client: Pick<IntercomClient, "sessionId" | "send"> = {
		sessionId: "self",
		async send(): Promise<SendResult> {
			return queued ? { id: "reply", delivered: false, queued: true } : { id: "reply", delivered: true };
		},
	};
	registerIntercomTool(api as ExtensionAPI, {
		ensureConnected: async () => client as IntercomClient,
		syncPresenceIdentity() {},
		homeGroup: () => "default",
		setJoinedGroups() {},
		clearJoinedGroups() {},
		confirmSend: false,
		beginReplyWait: () => {
			throw new Error("unexpected outbound ask");
		},
		replyTracker: tracker,
	});
	assert.ok(tool);
	const completion = tool.execute(
		"reply-call",
		{ action: "reply", message: "answer" },
		undefined,
		undefined,
		toolContext({ sessionManager: { getSessionId: () => "self" }, hasUI: false } as ExtensionContext),
	);
	return { tracker, completion };
}

for (const queued of [false, true]) {
	test(`${queued ? "queued" : "delivered"} reply completion and pending-ask removal wait for the session commit`, async () => {
		let commit: () => void = () => {};
		const pendingCommit = new Promise<void>((resolve) => {
			commit = resolve;
		});
		let appendStarted: () => void = () => {};
		const appending = new Promise<void>((resolve) => {
			appendStarted = resolve;
		});
		const { tracker, completion } = replyWithCommit(async () => {
			appendStarted();
			await pendingCommit;
		}, queued);
		await appending;
		assert.deepEqual(
			tracker.listPending().map((pending) => pending.message.id),
			[message.id],
		);
		commit();
		const result = await completion;
		assert.equal("isError" in result && result.isError, false);
		assert.deepEqual(tracker.listPending(), []);
	});
}

test("a rejected reply commit reaches the tool error handler without clearing the pending ask", async () => {
	const failure = new StorageUnavailableError({ adapter: "test", location: "reply" }, new Error("write failed"));
	const { tracker, completion } = replyWithCommit(async () => {
		throw failure;
	});
	const result = await completion;
	assert.equal("isError" in result && result.isError, true);
	assert.deepEqual(result.content, [{ type: "text", text: `Failed to reply: ${failure.message}` }]);
	assert.deepEqual(
		tracker.listPending().map((pending) => pending.message.id),
		[message.id],
	);
});
