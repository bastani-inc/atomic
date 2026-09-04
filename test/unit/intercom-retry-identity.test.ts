import assert from "node:assert/strict";
import { test } from "vitest";
import {
	ASK_REPLY_TIMEOUT_MS,
	RETRY_IDENTITY_MAX_REUSES,
	RETRY_IDENTITY_RETRY_OPPORTUNITY_MS,
	RETRY_IDENTITY_TTL_MS,
	RetryIdentityCapacityError,
	type RetryIdentityInput,
	RetryIdentityReservations,
} from "../../packages/intercom/retry-identity.js";
import { DELIVERED_MESSAGE_TTL_MS } from "../../packages/intercom/retry-policy.js";

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

test("attachment member order is canonical while array order, duplicates, and language semantics stay exact", () => {
	const reservations = new RetryIdentityReservations({ createId: ids() });
	const firstAttachments: RetryIdentityInput["attachments"] = [
		{ type: "snippet", name: "ordered", content: "alpha", language: "ts" },
		{ type: "context", name: "duplicate", content: "beta" },
		{ type: "context", name: "duplicate", content: "beta" },
	];
	const reorderedMembers: RetryIdentityInput["attachments"] = [
		{ language: "ts", content: "alpha", name: "ordered", type: "snippet" },
		{ language: undefined, content: "beta", name: "duplicate", type: "context" },
		{ content: "beta", name: "duplicate", type: "context" },
	];
	const first = reservations.begin({ ...base, attachments: firstAttachments });
	reservations.retainAfterRecoverableDisconnect(first);

	const reorderedRetry = reservations.begin({ ...base, attachments: reorderedMembers });
	assert.equal(reorderedRetry.messageId, first.messageId, "typed member insertion order is not logical identity");
	reservations.retainAfterRecoverableDisconnect(reorderedRetry);

	const [ordered, duplicate] = reorderedMembers;
	assert.ok(ordered);
	assert.ok(duplicate);
	assert.notEqual(
		reservations.begin({ ...base, attachments: [duplicate, ordered, duplicate] }).messageId,
		first.messageId,
		"attachment array order remains significant",
	);
	assert.notEqual(
		reservations.begin({ ...base, attachments: [ordered, duplicate] }).messageId,
		first.messageId,
		"attachment duplicates remain significant",
	);
	assert.notEqual(
		reservations.begin({
			...base,
			attachments: [ordered, { ...duplicate, language: "" }, duplicate],
		}).messageId,
		first.messageId,
		"a supported empty language is distinct from omitted or undefined language",
	);
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

test("concurrent recoverable operations retain independent identities in original call order", () => {
	const reservations = new RetryIdentityReservations({ createId: ids() });
	const first = reservations.begin(base);
	const second = reservations.begin(base);
	reservations.retainAfterRecoverableDisconnect(first);
	reservations.retainAfterRecoverableDisconnect(second);

	const firstRetry = reservations.begin(base);
	const secondRetry = reservations.begin(base);
	const concurrentIntentionalCall = reservations.begin(base);
	assert.equal(firstRetry.messageId, first.messageId);
	assert.equal(secondRetry.messageId, second.messageId);
	assert.notEqual(concurrentIntentionalCall.messageId, first.messageId);
	assert.notEqual(concurrentIntentionalCall.messageId, second.messageId);
});

test("duplicate retention and settlement affect only the originating attempt", () => {
	const reservations = new RetryIdentityReservations({ createId: ids() });
	const first = reservations.begin(base);
	const second = reservations.begin(base);
	reservations.retainAfterRecoverableDisconnect(first);
	reservations.retainAfterRecoverableDisconnect(first);
	reservations.retainAfterRecoverableDisconnect(second);
	reservations.release(first);

	assert.equal(reservations.begin(base).messageId, second.messageId);
	assert.notEqual(reservations.begin(base).messageId, first.messageId);
});

test("a stale duplicate retain cannot expose an identity already claimed by its retry", () => {
	const reservations = new RetryIdentityReservations({ createId: ids() });
	const first = reservations.begin(base);
	reservations.retainAfterRecoverableDisconnect(first);
	const retry = reservations.begin(base);
	reservations.retainAfterRecoverableDisconnect(first);

	assert.equal(retry.messageId, first.messageId);
	assert.notEqual(reservations.begin(base).messageId, first.messageId);
});

test("capacity pressure fails closed without evicting an accepted retry identity", () => {
	let now = 0;
	const reservations = new RetryIdentityReservations({
		ttlMs: 100,
		maxEntries: 2,
		now: () => now,
		createId: ids(),
	});
	const oldest = reservations.begin(base);
	const middle = reservations.begin({ ...base, text: "middle" });
	const overflow = reservations.begin({ ...base, text: "overflow" });
	reservations.retainAfterRecoverableDisconnect(oldest);
	reservations.retainAfterRecoverableDisconnect(middle);
	reservations.retainAfterRecoverableDisconnect(overflow);

	assert.throws(() => reservations.begin(base), RetryIdentityCapacityError);
	assert.throws(() => reservations.begin({ ...base, text: "new work" }), RetryIdentityCapacityError);
	now = 100;
	assert.doesNotThrow(() => reservations.begin(base));
});

test("retry identity scope preserves every operation field, ordering, and session boundary", () => {
	const reservations = new RetryIdentityReservations({ createId: ids() });
	const first = reservations.begin(base);
	reservations.retainAfterRecoverableDisconnect(first);

	const distinct: RetryIdentityInput[] = [
		{ ...base, sessionId: "session-b" },
		{ ...base, action: "ask" },
		{ ...base, target: "reviewer" },
		{ ...base, target: "worker " },
		{ ...base, target: "WORKER" },
		{ ...base, text: "preserve whitespace" },
		{ ...base, attachments: [...(base.attachments ?? [])].reverse() },
		{ ...base, replyTo: "other-question" },
		{ ...base, requestedReplyTo: "question-id" },
		{ ...base, expectsReply: true },
	];
	for (const input of distinct) assert.notEqual(reservations.begin(input).messageId, first.messageId);
});

test("retry identity covers the full ask wait plus an explicit bounded retry opportunity", () => {
	let now = 1_000;
	const reservations = new RetryIdentityReservations({ now: () => now, createId: ids() });
	const first = reservations.begin(base);
	reservations.retainAfterRecoverableDisconnect(first);
	now += ASK_REPLY_TIMEOUT_MS;
	const atAskBoundary = reservations.begin(base);
	assert.equal(atAskBoundary.messageId, first.messageId);
	reservations.retainAfterRecoverableDisconnect(atAskBoundary);
	now += RETRY_IDENTITY_RETRY_OPPORTUNITY_MS - 1;
	const beforeRetryBoundary = reservations.begin(base);
	assert.equal(beforeRetryBoundary.messageId, first.messageId);
	reservations.retainAfterRecoverableDisconnect(beforeRetryBoundary);
	now += 1;
	assert.notEqual(reservations.begin(base).messageId, first.messageId);
	assert.equal(RETRY_IDENTITY_TTL_MS, ASK_REPLY_TIMEOUT_MS + RETRY_IDENTITY_RETRY_OPPORTUNITY_MS);
	assert.ok(DELIVERED_MESSAGE_TTL_MS > RETRY_IDENTITY_TTL_MS);
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

test("retry reservation pressure does not mint an unsafe replacement identity", () => {
	const reservations = new RetryIdentityReservations({ maxEntries: 2, createId: ids() });
	for (const text of ["first", "second", "third"]) {
		const attempt = reservations.begin({ ...base, text });
		reservations.retainAfterRecoverableDisconnect(attempt);
	}
	assert.throws(() => reservations.begin({ ...base, text: "first" }), RetryIdentityCapacityError);
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
