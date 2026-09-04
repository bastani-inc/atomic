import assert from "node:assert/strict";
import { test } from "vitest";
import {
	RETRY_IDENTITY_MAX_REUSES,
	RETRY_IDENTITY_TTL_MS,
	type RetryIdentityInput,
	RetryIdentityReservations,
} from "../../packages/intercom/retry-identity.js";

const base: RetryIdentityInput = {
	sessionId: "session-a",
	action: "send",
	target: "worker",
	text: "preserve  whitespace",
	attachments: [
		{ type: "snippet", name: "same", content: "one" },
		{ type: "snippet", name: "same", content: "one" },
		{ type: "snippet", name: "same", content: "two" },
	],
	replyTo: "question-id",
	expectsReply: false,
};

function ids() {
	let next = 0;
	return () => `operation-${++next}`;
}

test("a recoverable retry reuses its operation identity and a settled repeat does not", () => {
	const reservations = new RetryIdentityReservations({ createId: ids() });
	const first = reservations.begin(base);
	reservations.retainAfterRecoverableDisconnect(first);
	const retry = reservations.begin(base);
	assert.equal(retry.messageId, first.messageId);
	assert.equal(retry.reuseCount, 1);

	reservations.release(retry);
	const intentionalRepeat = reservations.begin(base);
	assert.notEqual(intentionalRepeat.messageId, first.messageId);
});

test("begin claims a retained identity so a concurrent identical operation stays distinct", () => {
	const reservations = new RetryIdentityReservations({ createId: ids() });
	const first = reservations.begin(base);
	reservations.retainAfterRecoverableDisconnect(first);
	const retry = reservations.begin(base);
	const concurrent = reservations.begin(base);

	assert.equal(retry.messageId, first.messageId);
	assert.notEqual(concurrent.messageId, first.messageId);
});

test("retry identity scope preserves every operation field, ordering, and session boundary", () => {
	const reservations = new RetryIdentityReservations({ createId: ids() });
	const first = reservations.begin(base);
	reservations.retainAfterRecoverableDisconnect(first);

	const distinct: RetryIdentityInput[] = [
		{ ...base, sessionId: "session-b" },
		{ ...base, action: "ask" },
		{ ...base, target: "reviewer" },
		{ ...base, text: "preserve whitespace" },
		{ ...base, attachments: [...(base.attachments ?? [])].reverse() },
		{ ...base, replyTo: "other-question" },
		{ ...base, expectsReply: true },
	];
	for (const input of distinct) assert.notEqual(reservations.begin(input).messageId, first.messageId);
});

test("retry reservations expire before the broker delivery cache", () => {
	let now = 1_000;
	const reservations = new RetryIdentityReservations({ now: () => now, createId: ids() });
	const first = reservations.begin(base);
	reservations.retainAfterRecoverableDisconnect(first);
	now += RETRY_IDENTITY_TTL_MS;
	assert.notEqual(reservations.begin(base).messageId, first.messageId);
	assert.ok(RETRY_IDENTITY_TTL_MS < 10 * 60 * 1_000);
});

test("recoverable retries do not extend the original bounded identity lifetime", () => {
	let now = 1_000;
	const reservations = new RetryIdentityReservations({ ttlMs: 100, now: () => now, createId: ids() });
	const first = reservations.begin(base);
	reservations.retainAfterRecoverableDisconnect(first);
	now += 60;
	const retry = reservations.begin(base);
	assert.equal(retry.messageId, first.messageId);
	reservations.retainAfterRecoverableDisconnect(retry);
	now += 40;
	assert.notEqual(reservations.begin(base).messageId, first.messageId);
});

test("retry reservations evict the oldest entry at the configured bound", () => {
	const reservations = new RetryIdentityReservations({ maxEntries: 2, createId: ids() });
	const first = reservations.begin(base);
	reservations.retainAfterRecoverableDisconnect(first);
	const second = reservations.begin({ ...base, text: "second" });
	reservations.retainAfterRecoverableDisconnect(second);
	const third = reservations.begin({ ...base, text: "third" });
	reservations.retainAfterRecoverableDisconnect(third);

	assert.notEqual(reservations.begin(base).messageId, first.messageId);
	assert.equal(reservations.begin({ ...base, text: "second" }).messageId, second.messageId);
	assert.equal(reservations.begin({ ...base, text: "third" }).messageId, third.messageId);
});

test("one reservation permits exactly the documented three retry reuses", () => {
	const reservations = new RetryIdentityReservations({ createId: ids() });
	let attempt = reservations.begin(base);
	const stableId = attempt.messageId;
	reservations.retainAfterRecoverableDisconnect(attempt);
	for (let reuse = 1; reuse <= RETRY_IDENTITY_MAX_REUSES; reuse += 1) {
		attempt = reservations.begin(base);
		assert.equal(attempt.messageId, stableId);
		assert.equal(attempt.reuseCount, reuse);
		reservations.retainAfterRecoverableDisconnect(attempt);
	}
	assert.notEqual(reservations.begin(base).messageId, stableId);
});
