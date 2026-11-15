import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { AwayAsks } from "../../packages/intercom/broker/away-asks.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import { SessionIdReclaim } from "../../packages/intercom/broker/session-id-reclaim.js";
import type { SessionInfo } from "../../packages/intercom/types.js";

const ADDRESSES: Record<string, string> = {
	asker: "asker-address",
	recipient: "recipient-address",
	child: "child-address",
	// The released subagent back under a new Intercom id, with the same return address.
	"child-2": "child-address",
	// A session that registered with an empty return address proves nothing.
	unproven: "",
};

const info = (id: string): SessionInfo => ({
	id,
	name: id,
	cwd: "/",
	model: "test-model",
	pid: 1,
	startedAt: 0,
	lastActivity: 0,
});

/** One broker's view of the durable file at `path`: a new one stands for the broker after a restart or crash. */
function broker(path: string): PendingQuestionIndex {
	const index = new PendingQuestionIndex();
	index.useAwayStore(new AwayAsks(path), (sessionId) => ADDRESSES[sessionId]);
	return index;
}

/** Who is connected to the restarted broker, by id and the return address it registered with. */
function connected(...sessionIds: string[]) {
	return (sessionId: string, returnAddress: string) =>
		sessionIds.includes(sessionId) && (returnAddress === "" || ADDRESSES[sessionId] === returnAddress);
}

const fileIn = () => join(mkdtempSync(join(tmpdir(), "away-asks-live-")), "away-asks.sqlite");

test("a live route outlives its broker, and comes back once both proven peers are connected again (#4829)", () => {
	const path = fileIn();
	broker(path).record("asker", "recipient", "q-1");

	const restarted = broker(path);
	assert.deepEqual(restarted.restoreDormant("asker", ADDRESSES.asker, connected("asker")), []);
	assert.equal(restarted.matchesReply("recipient", "asker", "q-1"), false);
	assert.deepEqual(restarted.restoreDormant("recipient", ADDRESSES.recipient, connected("asker", "recipient")), [
		{ messageId: "q-1", senderSessionId: "asker", targetSessionId: "recipient" },
	]);
	assert.equal(restarted.matchesReply("recipient", "asker", "q-1"), true);
});

test("an answered or failed live route does not come back after a restart (#4829)", () => {
	const path = fileIn();
	const first = broker(path);
	first.record("asker", "recipient", "answered");
	first.record("asker", "recipient", "failed");
	first.record("asker", "other", "pruned");
	assert.equal(first.clearReply("recipient", "asker", "answered"), true);
	assert.equal(first.takeForTarget("recipient").length, 1);
	assert.equal(first.takeForSender("asker").length, 1);

	const restarted = broker(path);
	assert.deepEqual(restarted.restoreDormant("asker", ADDRESSES.asker, connected("asker", "recipient", "other")), []);
	assert.deepEqual(restarted.restoreDormant("recipient", ADDRESSES.recipient, connected("asker", "recipient")), []);
});

test("a live route whose asker cannot prove itself is not written (#4829)", () => {
	const path = fileIn();
	broker(path).record("anonymous", "recipient", "q-1");
	broker(path).record("unproven", "recipient", "q-2");
	const restarted = broker(path);
	assert.deepEqual(
		restarted.restoreDormant("recipient", ADDRESSES.recipient, () => true),
		[],
	);
});

test("after a restart, a recipient that ends fails its live asks once for their askers, and only the proven one (#4829)", () => {
	const path = fileIn();
	broker(path).record("asker", "recipient", "q-1");

	const restarted = broker(path);
	// Another session under the recipient's id fails nothing, and cannot answer.
	assert.equal(restarted.hasDormantReply("q-1", "recipient", "impostor-address"), false);
	restarted.failDormantForTarget(info("recipient"), "ended", "recipient-ended", "impostor-address");
	assert.deepEqual(restarted.heldForAsker(ADDRESSES.asker), []);
	assert.equal(restarted.hasDormantReply("q-1", "recipient", ADDRESSES.recipient), true);

	restarted.failDormantForTarget(info("recipient"), "ended", "recipient-ended", ADDRESSES.recipient);
	const held = restarted.heldForAsker(ADDRESSES.asker);
	assert.deepEqual(
		held.map(({ message }) => ({ replyTo: message.replyTo, replyError: message.replyError })),
		[{ replyTo: "q-1", replyError: "ended" }],
	);
	assert.equal(restarted.hasDormantReply("q-1", "recipient", ADDRESSES.recipient), false);
});

test("a route parked for a released recipient outlives its broker; once taken up, it does not (#4829)", () => {
	const parkedPath = fileIn();
	const first = broker(parkedPath);
	first.record("asker", "child", "q-1");
	first.parkTarget("child", "child", "owner");

	const restarted = broker(parkedPath);
	assert.deepEqual(restarted.restoreDormant("child", ADDRESSES.child, connected("asker", "child")), [
		{ messageId: "q-1", senderSessionId: "asker", targetSessionId: "child" },
	]);

	const takenPath = fileIn();
	const taken = broker(takenPath);
	taken.record("asker", "child", "q-1");
	taken.parkTarget("child", "child", "owner");
	assert.equal(taken.takeParked("child", "owner").length, 1);
	assert.deepEqual(broker(takenPath).restoreDormant("child", ADDRESSES.child, connected("asker", "child")), []);
});

test("a released subagent's parked ask and the failure held for it outlive their broker, for that subagent (#4829)", () => {
	const path = fileIn();
	const first = broker(path);
	first.parkAsker("child", "owner", { messageId: "q-1", senderSessionId: "child", targetSessionId: "recipient" });
	const failure = {
		askerSessionId: "child",
		from: info("gone"),
		message: { id: "failed-1", timestamp: 0, replyTo: "q-2", replyError: "ended", content: { text: "ended" } },
	};
	first.holdForReleasedChild("child", "owner", failure);
	first.holdForReleasedChild("child", "owner", failure);

	const restarted = broker(path);
	// The subagent is back under a new id, proving itself by its return address.
	assert.deepEqual(restarted.restoreDormant("child-2", ADDRESSES.child, connected("child-2", "recipient")), [
		{ messageId: "q-1", senderSessionId: "child-2", targetSessionId: "recipient" },
	]);
	assert.deepEqual(
		restarted.heldForAsker(ADDRESSES.child).map(({ message }) => message.id),
		["failed-1"],
	);

	const takenPath = fileIn();
	const taken = broker(takenPath);
	taken.parkAsker("child", "owner", { messageId: "q-1", senderSessionId: "child", targetSessionId: "recipient" });
	taken.holdForReleasedChild("child", "owner", failure);
	assert.equal(taken.takeParkedAskers("child", "owner").length, 1);
	assert.equal(taken.takeHeldForReleasedChild("child", "owner").length, 1);
	const takenRestarted = broker(takenPath);
	assert.deepEqual(takenRestarted.restoreDormant("child-2", ADDRESSES.child, connected("child-2", "recipient")), []);
	assert.deepEqual(takenRestarted.heldForAsker(ADDRESSES.child), []);
});

test("a durable file an older broker wrote opens, and its kept asks still route (#4829)", () => {
	const path = fileIn();
	const older = new DatabaseSync(path);
	older.exec(`
		CREATE TABLE away_questions (
			message_id TEXT NOT NULL,
			sender_session_id TEXT NOT NULL,
			target_session_id TEXT NOT NULL,
			sender_return_address TEXT,
			kept_at INTEGER NOT NULL,
			PRIMARY KEY (message_id, sender_session_id, target_session_id)
		);
	`);
	older
		.prepare("INSERT INTO away_questions VALUES (?, ?, ?, ?, ?)")
		.run("q-1", "asker", "recipient", ADDRESSES.asker, Date.now());
	older.close();

	const index = broker(path);
	assert.deepEqual(index.restoreDormant("recipient", ADDRESSES.recipient, connected("asker", "recipient")), [
		{ messageId: "q-1", senderSessionId: "asker", targetSessionId: "recipient" },
	]);
	// Opened again, the migrated file keeps working.
	assert.deepEqual(broker(path).restoreDormant("recipient", ADDRESSES.recipient, connected("asker", "recipient")), [
		{ messageId: "q-1", senderSessionId: "asker", targetSessionId: "recipient" },
	]);
});

test("a live route an earlier broker writes after this one opened the file is taken up all the same (#4829)", () => {
	const path = fileIn();
	// A broker that lost its socket path keeps serving its sessions for a moment after its successor opened the file.
	const successor = broker(path);
	broker(path).record("asker", "recipient", "q-late");
	assert.deepEqual(successor.restoreDormant("recipient", ADDRESSES.recipient, connected("asker", "recipient")), [
		{ messageId: "q-late", senderSessionId: "asker", targetSessionId: "recipient" },
	]);
});

test("a route parked for a departed owner's released recipient does not come back after a restart (#4829)", () => {
	const path = fileIn();
	const first = broker(path);
	first.record("asker", "child", "q-1");
	first.parkTarget("child", "child", "owner");
	assert.equal(first.takeParkedForOwner("owner").length, 1);
	assert.deepEqual(broker(path).restoreDormant("child", ADDRESSES.child, connected("asker", "child")), []);
});

test("a failed-ask message held for a released subagent outlives its broker on its own, once (#4829)", () => {
	const path = fileIn();
	const first = broker(path);
	const failure = (id: string, askerSessionId: string) => ({
		askerSessionId,
		from: info("gone"),
		message: { id, timestamp: 0, replyTo: "q-1", replyError: "ended", content: { text: "ended" } },
	});
	first.holdForReleasedChild("child", "owner", failure("failed-1", "child"));
	first.holdForReleasedChild("child", "owner", failure("failed-1", "child"));
	// One whose subagent cannot prove itself is held in memory only.
	first.holdForReleasedChild("anonymous", "owner", failure("failed-2", "anonymous"));
	first.holdForReleasedChild("unproven", "owner", failure("failed-3", "unproven"));
	assert.equal(first.hasHeldForReleasedChild("anonymous", "owner"), true);

	const restarted = broker(path);
	assert.deepEqual(
		restarted.heldForAsker(ADDRESSES.child).map(({ message }) => message.id),
		["failed-1"],
	);
	assert.deepEqual(
		first.takeHeldForReleasedChild("child", "owner").map(({ message }) => message.id),
		["failed-1"],
		"a failure held twice is taken once",
	);
});

test("a released subagent's held failure is taken from a broker that keeps nothing durably (#4829)", () => {
	const index = new PendingQuestionIndex();
	index.holdForReleasedChild("child", "owner", {
		askerSessionId: "child",
		from: info("gone"),
		message: { id: "failed-1", timestamp: 0, replyTo: "q-1", replyError: "ended", content: { text: "ended" } },
	});
	assert.equal(index.takeHeldForReleasedChild("child", "owner").length, 1);
});

test("a departed session's return address is known until its id is granted again (#4829)", () => {
	const reclaim = new SessionIdReclaim();
	const id = "00000000-0000-4000-8000-000000000001";
	assert.equal(reclaim.retiredReturnAddress(id), undefined);
	reclaim.retire(id, "child-address");
	assert.equal(reclaim.retiredReturnAddress(id), "child-address");
	assert.equal(
		reclaim.grant(id, "child-address", () => false),
		id,
	);
	assert.equal(reclaim.retiredReturnAddress(id), undefined);
});

test("an ask kept while only its recipient is away keeps its live asker's return address, so its failure outlives a crash (#4950)", () => {
	const path = fileIn();
	const first = broker(path);
	first.record("asker", "recipient", "q-1");
	// The recipient goes away while the asker is live; the broker crashes before the asker's departure is handled.
	first.keepDormant(first.takeForTarget("recipient"));

	const restarted = broker(path);
	restarted.failDormantForTarget(info("recipient"), "ended", "recipient-ended", ADDRESSES.recipient);
	assert.deepEqual(
		restarted.heldForAsker(ADDRESSES.asker).map(({ message }) => message.replyTo),
		["q-1"],
	);
});

test("a kept ask whose asker is connected when its recipient ends is failed on the asker's route, not held (#4950)", () => {
	const index = broker(fileIn());
	index.record("asker", "recipient", "q-1");
	index.keepDormant(index.takeForTarget("recipient"));
	index.failToConnectedAskerWhen((question, returnAddress) =>
		connected("asker")(question.senderSessionId, returnAddress),
	);

	index.failDormantForTarget(info("recipient"), "ended", "recipient-ended", ADDRESSES.recipient);
	assert.deepEqual(index.heldForAsker(ADDRESSES.asker), []);
	// What the broker fails as `peer_disconnected` to a live asker when its recipient ends.
	assert.deepEqual(index.takeForTarget("recipient"), [
		{ senderSessionId: "asker", targetSessionId: "recipient", messageId: "q-1" },
	]);
});

test("a kept ask whose asker can neither be told nor held for stays kept when its recipient ends (#4950)", () => {
	const index = broker(fileIn());
	index.record("unproven", "recipient", "q-1");
	index.keepDormant(index.takeForTarget("recipient"));

	index.failDormantForTarget(info("recipient"), "ended", "recipient-ended", ADDRESSES.recipient);
	assert.equal(index.hasDormantReply("q-1", "recipient", ADDRESSES.recipient), true);
});

test("a recipient's end reports which kept asks it held for their askers and which return to a connected asker (#4950)", () => {
	const store = new AwayAsks(fileIn());
	const toRecipient = (senderSessionId: string, messageId: string) => ({
		senderSessionId,
		targetSessionId: "recipient",
		messageId,
	});
	store.keep([toRecipient("asker", "q-held"), toRecipient("child", "q-live")], (question) =>
		question.senderSessionId === "asker" ? ADDRESSES.asker : ADDRESSES.child,
	);

	const outcome = store.failForTarget(
		info("recipient"),
		"ended",
		"recipient-ended",
		() => false,
		"",
		(question, returnAddress) => connected("child")(question.senderSessionId, returnAddress),
	);
	assert.deepEqual(outcome, { failed: [toRecipient("asker", "q-held")], live: [toRecipient("child", "q-live")] });
	assert.equal(store.question("q-live", "recipient"), undefined);
});
