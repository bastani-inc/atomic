import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { AWAY_ASKS_PER_RECIPIENT_MAX, AwayAsks } from "../../packages/intercom/broker/away-asks.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import type { SessionInfo } from "../../packages/intercom/types.js";

const info = (id: string): SessionInfo => ({
	id,
	name: id,
	cwd: "/",
	model: "test-model",
	pid: 1,
	startedAt: 0,
	lastActivity: 0,
});

const fileIn = () => join(mkdtempSync(join(tmpdir(), "away-asks-cap-")), "away-asks.sqlite");

/** One broker's index over the away store at `path` (in memory without one), its clock fixed at `now`. */
function brokerIndex(path?: string, now = 1_000): PendingQuestionIndex {
	const index = new PendingQuestionIndex();
	index.useAwayStore(new AwayAsks(path, () => now));
	return index;
}

/** Many more rows than any cap, all newer than what the test kept, waiting for sessions the test never names. */
function fillWithOtherSessions(path: string, rows: number, at: number): void {
	const database = new DatabaseSync(path);
	database.exec("BEGIN IMMEDIATE");
	const ask = database.prepare(
		"INSERT INTO away_questions (message_id, sender_session_id, target_session_id, sender_return_address, kept_at) VALUES (?, ?, ?, ?, ?)",
	);
	const reply = database.prepare(
		"INSERT INTO held_messages (message_id, asker_session_id, asker_return_address, replier_session_id, from_json, message_json, held_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	for (let row = 0; row < rows; row++) {
		ask.run(`other-ask-${row}`, `other-asker-${row}`, `other-recipient-${row}`, `other-address-${row}`, at);
		reply.run(
			`other-reply-${row}`,
			`other-asker-${row}`,
			`other-address-${row}`,
			`other-recipient-${row}`,
			"{}",
			"{}",
			at,
		);
	}
	database.exec("COMMIT");
	database.close();
}

test("a recipient whose away queue is full refuses a further kept ask, and keeps every earlier one (#4996)", () => {
	const index = brokerIndex();
	for (let ask = 0; ask <= AWAY_ASKS_PER_RECIPIENT_MAX; ask++) index.record(`asker-${ask}`, "recipient", `q-${ask}`);
	index.record("asker-0", "other-recipient", "q-other");

	const refused = index.keepDormantForRecipient(index.takeForTarget("recipient"));

	assert.deepEqual(refused, [
		{
			messageId: `q-${AWAY_ASKS_PER_RECIPIENT_MAX}`,
			senderSessionId: `asker-${AWAY_ASKS_PER_RECIPIENT_MAX}`,
			targetSessionId: "recipient",
		},
	]);
	assert.equal(index.hasDormantReply("q-0", "recipient"), true, "the oldest kept ask is not evicted");
	assert.equal(index.hasDormantReply(`q-${AWAY_ASKS_PER_RECIPIENT_MAX - 1}`, "recipient"), true);
	assert.equal(index.hasDormantReply(`q-${AWAY_ASKS_PER_RECIPIENT_MAX}`, "recipient"), false);
	// Another recipient's queue is its own: its ask is kept while the full one refuses.
	assert.deepEqual(index.keepDormantForRecipient(index.takeForTarget("other-recipient")), []);
	assert.equal(index.hasDormantReply("q-other", "other-recipient"), true);
});

test("an ask already kept for its away recipient is kept again at the cap, not refused (#4996)", () => {
	const index = brokerIndex();
	for (let ask = 0; ask < AWAY_ASKS_PER_RECIPIENT_MAX; ask++) index.record("asker", "recipient", `q-${ask}`);
	assert.deepEqual(index.keepDormantForRecipient(index.takeForTarget("recipient")), []);
	index.record("asker", "recipient", "q-0");
	assert.deepEqual(index.keepDormantForRecipient(index.takeForTarget("recipient")), []);
	assert.equal(index.hasDormantReply("q-0", "recipient"), true);
});

test("a kept ask and a reply held for its away asker survive any number of rows waiting for other sessions (#4996)", () => {
	const path = fileIn();
	const first = brokerIndex(path);
	first.record("asker", "recipient", "answered");
	first.record("asker", "recipient", "unanswered");
	// The asker closes; both of its asks wait for it.
	first.keepDormant(first.takeForSender("asker"), "asker-address");
	fillWithOtherSessions(path, 2 * AWAY_ASKS_PER_RECIPIENT_MAX + 10_001, 2_000);

	// The recipient answers one while the store holds far more than any cap: the reply is held, not refused or evicted.
	const restarted = brokerIndex(path);
	const answered = restarted.dormantReply("answered", "recipient");
	assert.ok(answered);
	assert.equal(answered.senderReturnAddress, "asker-address");
	restarted.holdForAwayAsker({ ...answered, senderReturnAddress: "asker-address" }, info("recipient"), {
		id: "reply-1",
		timestamp: 0,
		replyTo: "answered",
		content: { text: "port 8080" },
	});
	// Another session's ask kept, and a broker restart, both used to evict the oldest rows.
	restarted.record("someone", "elsewhere", "later");
	assert.deepEqual(restarted.keepDormantForRecipient(restarted.takeForTarget("elsewhere")), []);

	const back = brokerIndex(path);
	assert.deepEqual(
		back.heldForAsker("asker-address").map(({ message }) => message.id),
		["reply-1"],
	);
	assert.equal(back.hasDormantReply("unanswered", "recipient"), true, "the unanswered ask still waits for its reply");
});

test("an ask kept for its away recipient keeps its asker's return address, so a broker that goes first still fails it to the asker (#4996)", () => {
	const path = fileIn();
	const first = new PendingQuestionIndex();
	first.useAwayStore(new AwayAsks(path, () => 1_000), (sessionId) =>
		sessionId === "asker" ? "asker-address" : undefined,
	);
	first.record("asker", "recipient", "q-1");
	assert.deepEqual(first.keepDormantForRecipient(first.takeForTarget("recipient")), []);

	// The broker goes before the asker's departure is handled; the recipient then ends.
	const restarted = brokerIndex(path);
	restarted.failDormantForTarget(info("recipient"), "ended", "recipient-ended");
	assert.deepEqual(
		restarted.heldForAsker("asker-address").map(({ message }) => message.replyTo),
		["q-1"],
	);
});
