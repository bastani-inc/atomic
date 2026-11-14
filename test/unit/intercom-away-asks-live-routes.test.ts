import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { AwayAsks } from "../../packages/intercom/broker/away-asks.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import type { SessionInfo } from "../../packages/intercom/types.js";

const ADDRESSES: Record<string, string> = {
	asker: "asker-address",
	recipient: "recipient-address",
	child: "child-address",
	// The released subagent back under a new Intercom id, with the same return address.
	"child-2": "child-address",
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
