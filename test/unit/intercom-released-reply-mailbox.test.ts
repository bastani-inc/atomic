import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, describe, test, vi } from "vitest";
import {
	answerReleasedChildReplies,
	type ReleasedChildReplyNotice,
	ReleasedReplyMailbox,
	releasedReplyMailbox,
} from "../../packages/intercom/released-reply-mailbox.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

const REPLIER_ID = "22222222-2222-4222-8222-222222222222";
const TIMEOUT_MS = 600_000;

const replier: SessionInfo = {
	id: REPLIER_ID,
	name: "replier",
	cwd: "/repo",
	model: "m",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
};

function reply(replyTo: string, text = "the answer", id = `reply-${replyTo}`): Message {
	return { id, timestamp: 1, replyTo, content: { text } };
}

function outcome(promise: Promise<Message>): Promise<string> {
	return promise.then(
		(message) => `resolved:${message.content.text}`,
		(error: Error) => `rejected:${error.message}`,
	);
}

afterEach(() => {
	vi.useRealTimers();
});

describe("released reply mailbox (#4326)", () => {
	test("a running wait moves to the mailbox at shutdown and the reply resolves the original promise once (#4326)", async () => {
		const mailbox = new ReleasedReplyMailbox();
		const registry = new ReplyWaiterRegistry(TIMEOUT_MS, 6, mailbox);
		const running = new AbortController();
		const admission = registry.begin(REPLIER_ID, "q1", running.signal);
		assert.ok(admission.ok);
		assert.equal(registry.releaseRunningWaits(new Error("Session shutting down")), 1);
		assert.equal(registry.size(), 0);
		assert.equal(mailbox.size, 1);
		assert.equal(mailbox.deliver(replier, reply("q1")), true);
		assert.equal(await outcome(admission.wait.promise), "resolved:the answer");
		assert.equal(mailbox.deliver(replier, reply("q1", "again", "reply-2")), false);
		assert.equal(mailbox.size, 0);
	});

	test("a wait with no running tool call is rejected at shutdown as before, not kept (#4326)", async () => {
		const mailbox = new ReleasedReplyMailbox();
		const registry = new ReplyWaiterRegistry(TIMEOUT_MS, 6, mailbox);
		const unsignalled = registry.begin(REPLIER_ID, "q1");
		const running = registry.begin(REPLIER_ID, "q2", new AbortController().signal);
		assert.ok(unsignalled.ok && running.ok);
		const unsignalledOutcome = outcome(unsignalled.wait.promise);
		assert.equal(registry.releaseRunningWaits(new Error("Session shutting down")), 1);
		assert.equal(await unsignalledOutcome, "rejected:Session shutting down");
		assert.equal(mailbox.size, 1);
		assert.equal(registry.size(), 0);
		running.wait.cancel(new Error("done"));
		assert.equal(mailbox.size, 0);
	});

	test("a kept wait leaves the mailbox when its call is aborted or its reply timeout passes (#4326)", async () => {
		vi.useFakeTimers();
		const mailbox = new ReleasedReplyMailbox();
		const registry = new ReplyWaiterRegistry(TIMEOUT_MS, 6, mailbox);
		const aborted = new AbortController();
		const first = registry.begin(REPLIER_ID, "q1", aborted.signal);
		const second = registry.begin(REPLIER_ID, "q2", new AbortController().signal);
		assert.ok(first.ok && second.ok);
		const outcomes = [outcome(first.wait.promise), outcome(second.wait.promise)];
		registry.releaseRunningWaits(new Error("Session shutting down"));
		assert.equal(mailbox.size, 2);
		aborted.abort();
		assert.equal(mailbox.size, 1);
		vi.advanceTimersByTime(TIMEOUT_MS);
		assert.equal(mailbox.size, 0);
		assert.deepEqual(await Promise.all(outcomes), [
			"rejected:Cancelled",
			`rejected:No reply from "${REPLIER_ID}" within 10 minutes`,
		]);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("a reply from a session the wait is not bound to does not resolve it (#4326)", async () => {
		const mailbox = new ReleasedReplyMailbox();
		const registry = new ReplyWaiterRegistry(TIMEOUT_MS, 6, mailbox);
		const admission = registry.begin(REPLIER_ID, "q1", new AbortController().signal);
		assert.ok(admission.ok);
		registry.releaseRunningWaits(new Error("Session shutting down"));
		assert.equal(mailbox.deliver({ ...replier, id: "someone-else", name: "someone-else" }, reply("q1")), false);
		assert.equal(mailbox.size, 1);
		admission.wait.cancel(new Error("done"));
		assert.equal(await outcome(admission.wait.promise), "rejected:done");
		assert.equal(mailbox.size, 0);
	});

	test("the mailbox is bounded: a wait past the bound is rejected at shutdown instead of kept (#4326)", async () => {
		const mailbox = new ReleasedReplyMailbox(1);
		const registry = new ReplyWaiterRegistry(TIMEOUT_MS, 6, mailbox);
		const kept = registry.begin(REPLIER_ID, "q1", new AbortController().signal);
		const refused = registry.begin(REPLIER_ID, "q2", new AbortController().signal);
		assert.ok(kept.ok && refused.ok);
		const refusedOutcome = outcome(refused.wait.promise);
		assert.equal(registry.releaseRunningWaits(new Error("Session shutting down")), 1);
		assert.equal(await refusedOutcome, "rejected:Session shutting down");
		assert.equal(mailbox.size, 1);
		kept.wait.cancel(new Error("done"));
		assert.equal(mailbox.size, 0);
	});

	test("one mailbox serves every Intercom instance in the process, even a separately loaded copy (#4326)", async () => {
		assert.equal(releasedReplyMailbox(), releasedReplyMailbox());
		vi.resetModules();
		const reloaded = await import("../../packages/intercom/released-reply-mailbox.js");
		assert.notEqual(reloaded.releasedReplyMailbox, releasedReplyMailbox);
		assert.equal(reloaded.releasedReplyMailbox(), releasedReplyMailbox());
	});
});

describe("owner answering a released child's reply (#4326)", () => {
	class FakeOwnerClient extends EventEmitter {
		readonly acknowledged: Array<{ messageId: string; accepted: boolean }> = [];
		acknowledgeReleasedChildReply(messageId: string, accepted: boolean): boolean {
			this.acknowledged.push({ messageId, accepted });
			return true;
		}
	}

	test("each reply frame is acknowledged once: accepted when a kept wait took it, refused otherwise (#4326)", async () => {
		const mailbox = new ReleasedReplyMailbox();
		const registry = new ReplyWaiterRegistry(TIMEOUT_MS, 6, mailbox);
		const admission = registry.begin(REPLIER_ID, "q1", new AbortController().signal);
		assert.ok(admission.ok);
		registry.releaseRunningWaits(new Error("Session shutting down"));
		const owner = new FakeOwnerClient();
		answerReleasedChildReplies(owner, mailbox);
		const frames: ReleasedChildReplyNotice[] = [
			{ from: replier, message: reply("q1") },
			{ from: replier, message: reply("q1", "late", "reply-late") },
			{ from: replier, message: reply("unknown") },
		];
		for (const frame of frames) owner.emit("released_child_reply", frame);
		assert.deepEqual(owner.acknowledged, [
			{ messageId: "reply-q1", accepted: true },
			{ messageId: "reply-late", accepted: false },
			{ messageId: "reply-unknown", accepted: false },
		]);
		assert.equal(await outcome(admission.wait.promise), "resolved:the answer");
	});
});
