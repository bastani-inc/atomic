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
	RetryTokenError,
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

function sequence(prefix: string) {
	let next = 0;
	return () => `${prefix}-${++next}`;
}

function fixture(options: ConstructorParameters<typeof RetryIdentityReservations>[0] = {}) {
	return new RetryIdentityReservations({
		createId: sequence("operation"),
		createToken: sequence("retry"),
		...options,
	});
}

function retain(reservations: RetryIdentityReservations, input = base) {
	const attempt = reservations.begin(input);
	const retryToken = reservations.retainAfterRecoverableDisconnect(attempt);
	assert.ok(retryToken);
	return { attempt, retryToken };
}

test("a retained operation is reused only by its explicit retry token", () => {
	const reservations = fixture();
	const { attempt: first, retryToken } = retain(reservations);

	const intentionalRepeat = reservations.begin(base);
	assert.notEqual(intentionalRepeat.messageId, first.messageId);
	reservations.release(intentionalRepeat);

	const retry = reservations.begin(base, retryToken);
	assert.equal(retry.messageId, first.messageId);
	assert.equal(retry.reuseCount, 1);
	reservations.release(retry);
	assert.throws(
		() => reservations.begin(base, retryToken),
		(error: unknown) => {
			assert.ok(error instanceof RetryTokenError);
			return error.code === "settled";
		},
	);
});

test("attachment object order is canonical while array order, duplicates, and language stay exact", () => {
	const reservations = fixture();
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
	const input = { ...base, attachments: firstAttachments };
	const { attempt: first, retryToken } = retain(reservations, input);
	assert.equal(
		reservations.begin({ ...base, attachments: reorderedMembers }, retryToken).messageId,
		first.messageId,
		"typed member insertion order is not logical identity",
	);

	for (const attachments of [
		[reorderedMembers[1]!, reorderedMembers[0]!, reorderedMembers[1]!],
		[reorderedMembers[0]!, reorderedMembers[1]!],
		[reorderedMembers[0]!, { ...reorderedMembers[1]!, language: "" }, reorderedMembers[1]!],
	]) {
		assert.throws(() => reservations.begin({ ...base, attachments }, retryToken), RetryTokenError);
	}
});

test("an omitted and an empty attachment list share canonical retry identity", () => {
	const reservations = fixture();
	const input = { ...base, attachments: undefined };
	const { attempt, retryToken } = retain(reservations, input);
	assert.equal(reservations.begin({ ...input, attachments: [] }, retryToken).messageId, attempt.messageId);
});

test("concurrent identical failures get independent tokens and exact identities", () => {
	const reservations = fixture();
	const first = reservations.begin(base);
	const second = reservations.begin(base);
	const firstToken = reservations.retainAfterRecoverableDisconnect(first);
	const secondToken = reservations.retainAfterRecoverableDisconnect(second);
	assert.ok(firstToken);
	assert.ok(secondToken);
	assert.notEqual(firstToken, secondToken);
	assert.equal(reservations.begin(base, secondToken).messageId, second.messageId);
	assert.equal(reservations.begin(base, firstToken).messageId, first.messageId);
	assert.notEqual(reservations.begin(base).messageId, first.messageId);
});

test("invalid, mismatched, foreign-session, and already claimed tokens fail without changing another identity", () => {
	const reservations = fixture();
	const { attempt: first, retryToken } = retain(reservations);
	for (const input of [
		{ ...base, sessionId: "foreign-session" },
		{ ...base, action: "ask" as const },
		{ ...base, target: "worker " },
		{ ...base, text: "different" },
		{ ...base, replyTo: "different" },
		{ ...base, requestedReplyTo: "different" },
		{ ...base, expectsReply: true },
	]) {
		assert.throws(() => reservations.begin(input, retryToken), RetryTokenError);
	}
	assert.throws(() => reservations.begin(base, "foreign-token"), RetryTokenError);
	const claimed = reservations.begin(base, retryToken);
	assert.equal(claimed.messageId, first.messageId);
	assert.throws(
		() => reservations.begin(base, retryToken),
		(error: unknown) => {
			assert.ok(error instanceof RetryTokenError);
			return error.code === "in_flight";
		},
	);
});

test("token scope can be checked before resolving reply state without consuming a claim", () => {
	const reservations = fixture();
	const { retryToken } = retain(reservations);
	assert.equal(reservations.validateRetryToken(retryToken, base.sessionId, base.action), RETRY_IDENTITY_MAX_REUSES);
	assert.throws(() => reservations.validateRetryToken(retryToken, "foreign-session", base.action), RetryTokenError);
	assert.throws(() => reservations.validateRetryToken(retryToken, base.sessionId, "reply"), RetryTokenError);
	assert.equal(reservations.begin(base, retryToken).reuseCount, 1, "preflight must not consume a claimed attempt");
});

test("a claimed retry retains its token after an inconclusive result but a fresh nondelivery does not", () => {
	const reservations = fixture();
	const { attempt: first, retryToken } = retain(reservations);
	const retry = reservations.begin(base, retryToken);
	assert.equal(reservations.retainAfterInconclusiveRetry(retry), retryToken);
	assert.equal(reservations.begin(base, retryToken).messageId, first.messageId);

	const fresh = reservations.begin({ ...base, text: "fresh failure" });
	assert.equal(reservations.retainAfterInconclusiveRetry(fresh), undefined);
});

test("capacity pressure refuses fresh work without evicting retained token claims", () => {
	let now = 0;
	const reservations = fixture({ ttlMs: 100, maxEntries: 2, now: () => now });
	const oldest = retain(reservations);
	const middle = retain(reservations, { ...base, text: "middle" });
	const overflow = reservations.begin({ ...base, text: "overflow" });
	assert.throws(() => reservations.retainAfterRecoverableDisconnect(overflow), RetryIdentityCapacityError);
	assert.throws(() => reservations.begin({ ...base, text: "new work" }), RetryIdentityCapacityError);
	assert.equal(reservations.begin(base, oldest.retryToken).messageId, oldest.attempt.messageId);
	assert.equal(reservations.begin({ ...base, text: "middle" }, middle.retryToken).messageId, middle.attempt.messageId);
	now = 100;
	assert.doesNotThrow(() => reservations.begin(base));
});
test("settled token tombstones stay bounded without blocking a new retained operation", () => {
	const reservations = fixture({ maxEntries: 1 });
	const first = retain(reservations);
	reservations.release(reservations.begin(base, first.retryToken));
	const second = retain(reservations, { ...base, text: "second" });
	assert.throws(() => reservations.begin(base, first.retryToken), RetryTokenError);
	assert.equal(reservations.begin({ ...base, text: "second" }, second.retryToken).messageId, second.attempt.messageId);
});

test("retry deadline covers the ask window, never extends, and an expired claim fails loudly", () => {
	let now = 1_000;
	const reservations = fixture({ now: () => now });
	const { attempt: first, retryToken } = retain(reservations);
	now += ASK_REPLY_TIMEOUT_MS;
	const firstRetry = reservations.begin(base, retryToken);
	assert.equal(firstRetry.messageId, first.messageId);
	assert.equal(reservations.retainAfterRecoverableDisconnect(firstRetry), retryToken);
	now += RETRY_IDENTITY_RETRY_OPPORTUNITY_MS - 1;
	assert.equal(reservations.begin(base, retryToken).messageId, first.messageId);
	now += 1;
	assert.throws(
		() => reservations.begin(base, retryToken),
		(error: unknown) => {
			assert.ok(error instanceof RetryTokenError);
			return error.code === "expired";
		},
	);
	assert.equal(RETRY_IDENTITY_TTL_MS, ASK_REPLY_TIMEOUT_MS + RETRY_IDENTITY_RETRY_OPPORTUNITY_MS);
	assert.ok(DELIVERED_MESSAGE_TTL_MS > RETRY_IDENTITY_TTL_MS);
});

test("one token permits exactly three claimed attempts without extending its deadline", () => {
	let now = 0;
	const reservations = fixture({ ttlMs: 100, now: () => now });
	const { attempt: first, retryToken } = retain(reservations);
	for (let reuse = 1; reuse <= RETRY_IDENTITY_MAX_REUSES; reuse += 1) {
		const retry = reservations.begin(base, retryToken);
		assert.equal(retry.messageId, first.messageId);
		assert.equal(retry.reuseCount, reuse);
		now += 10;
		assert.equal(
			reservations.retainAfterRecoverableDisconnect(retry),
			reuse === RETRY_IDENTITY_MAX_REUSES ? undefined : retryToken,
		);
	}
	assert.throws(
		() => reservations.begin(base, retryToken),
		(error: unknown) => {
			assert.ok(error instanceof RetryTokenError);
			return error.code === "exhausted";
		},
	);
});
