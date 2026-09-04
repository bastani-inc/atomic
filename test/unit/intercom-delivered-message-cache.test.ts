import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import {
	DELIVERED_MESSAGE_MAX_ENTRIES,
	DeliveredMessageCache,
} from "../../packages/intercom/broker/delivered-message-cache.js";
import { buildMessageSendSignature, buildSendSignature } from "../../packages/intercom/broker/send-signature.js";

test("successful message ids fail closed at capacity without evicting live acceptance proof", () => {
	const cache = new DeliveredMessageCache(100, 2);
	assert.equal(cache.record("one", "signature-one", 0), "recorded");
	assert.equal(cache.record("two", "signature-two", 1), "recorded");
	assert.equal(cache.lookup("one", "signature-one", 2), "match");
	assert.equal(cache.lookup("one", "different", 2), "conflict");
	assert.equal(cache.record("three", "signature-three", 3), "capacity");
	assert.equal(cache.lookup("one", "signature-one", 3), "match", "oldest live proof is retained at pressure");
	assert.equal(cache.lookup("three", "signature-three", 3), "miss");
	assert.equal(cache.record("three", "signature-three", 102), "recorded", "expired proof frees capacity");
	assert.equal(cache.lookup("one", "signature-one", 102), "miss");
	assert.equal(cache.lookup("three", "signature-three", 102), "match");
});

test("accepted record content has an independent byte bound and fails closed at pressure", () => {
	const cache = new DeliveredMessageCache(100, 10, undefined, 20);
	assert.equal(cache.record("one", "1234567890", 0), "recorded");
	assert.equal(cache.record("two", "1234567890", 1), "capacity");
	assert.equal(cache.lookup("one", "1234567890", 1), "match");
	assert.equal(cache.record("oversized", "x".repeat(21), 1), "capacity");
});

test("the former 10,000-entry boundary cannot evict a still-live accepted identity", () => {
	const cache = new DeliveredMessageCache();
	assert.equal(cache.record("retained", "retained-signature", 0), "recorded");
	for (let index = 1; index < DELIVERED_MESSAGE_MAX_ENTRIES; index += 1) {
		assert.equal(cache.record(`unrelated-${index}`, `signature-${index}`, index), "recorded");
	}
	assert.equal(cache.record("pressure", "pressure-signature", DELIVERED_MESSAGE_MAX_ENTRIES), "capacity");
	assert.equal(
		cache.lookup("retained", "retained-signature", DELIVERED_MESSAGE_MAX_ENTRIES),
		"match",
		"capacity pressure must preserve the oldest live retry authority",
	);
});

test("question route metadata is available only to the exact delivered identity and sender groups", () => {
	const cache = new DeliveredMessageCache(100, 2);
	cache.recordQuestion(
		"question",
		"accepted-signature",
		{ targetSessionId: "accepted-target", senderGroupIdentity: "accepted-groups" },
		0,
	);

	assert.equal(cache.lookupQuestionTarget("question", "accepted-signature", "accepted-groups", 1), "accepted-target");
	assert.equal(cache.lookupQuestionTarget("other-id", "accepted-signature", "accepted-groups", 1), undefined);
	assert.equal(cache.lookupQuestionTarget("question", "changed-signature", "accepted-groups", 1), undefined);
	assert.equal(cache.lookupQuestionTarget("question", "accepted-signature", "changed-groups", 1), undefined);
	cache.record("ordinary-send", "ordinary-signature", 2);
	assert.equal(cache.lookupQuestionTarget("ordinary-send", "ordinary-signature", "accepted-groups", 2), undefined);
	assert.equal(cache.lookupQuestionTarget("question", "accepted-signature", "accepted-groups", 101), undefined);
});

test("accepted delivery and question metadata survive cache process replacement", () => {
	const dir = mkdtempSync(join(tmpdir(), "intercom-delivered-cache-"));
	const path = join(dir, "accepted.sqlite");
	try {
		const first = new DeliveredMessageCache(100, 3, path);
		assert.equal(first.record("send", "send-signature", 10, "recipient-return"), "recorded");
		assert.equal(
			first.recordQuestion(
				"ask",
				"ask-signature",
				{ targetSessionId: "old-target", senderGroupIdentity: "sender-groups" },
				11,
				"recipient-return",
			),
			"recorded",
		);
		first.close();

		const replacement = new DeliveredMessageCache(100, 3, path);
		assert.equal(replacement.lookupForTarget("send", "send-signature", "recipient-return", 12), "match");
		assert.equal(replacement.lookupQuestionTarget("ask", "ask-signature", "sender-groups", 12), "old-target");
		assert.equal(replacement.lookupForTarget("send", "send-signature", "different-recipient", 12), "conflict");
		replacement.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a crash between durable reservation and proven forwarding stays uncertain and fails closed", () => {
	const dir = mkdtempSync(join(tmpdir(), "intercom-delivered-uncertain-"));
	const path = join(dir, "accepted.sqlite");
	try {
		const first = new DeliveredMessageCache(100, 3, path);
		assert.equal(
			first.reserveQuestion(
				"send",
				"signature",
				{ targetSessionId: "recipient-session", senderGroupIdentity: "sender-groups" },
				10,
				"recipient",
			),
			"recorded",
		);
		assert.equal(first.lookupQuestionTarget("send", "signature", "sender-groups", 10), undefined);
		first.close();
		const replacement = new DeliveredMessageCache(100, 3, path);
		assert.equal(replacement.lookupForTarget("send", "signature", "recipient", 11), "uncertain");
		assert.equal(replacement.accept("send", "signature", "recipient"), "accepted");
		assert.equal(replacement.lookupQuestionTarget("send", "signature", "sender-groups", 11), "recipient-session");
		assert.equal(replacement.lookupForTarget("send", "signature", "recipient", 11), "match");
		replacement.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("concurrent durable authorities serialize acceptance without losing records", () => {
	const dir = mkdtempSync(join(tmpdir(), "intercom-delivered-concurrent-"));
	const path = join(dir, "accepted.sqlite");
	try {
		const first = new DeliveredMessageCache(100, 3, path);
		const second = new DeliveredMessageCache(100, 3, path);
		assert.equal(first.record("one", "signature-one", 1), "recorded");
		assert.equal(second.record("two", "signature-two", 2), "recorded");
		assert.equal(first.lookup("two", "signature-two", 3), "match");
		assert.equal(second.lookup("one", "signature-one", 3), "match");
		first.close();
		second.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("durable byte accounting charges fixed digest authority rather than plaintext length", () => {
	const dir = mkdtempSync(join(tmpdir(), "intercom-delivered-digest-bytes-"));
	const path = join(dir, "accepted.sqlite");
	try {
		const cache = new DeliveredMessageCache(100, 3, path, 70);
		assert.equal(cache.record("one", "x".repeat(1_000_000), 1), "recorded");
		assert.equal(cache.record("second", "small", 2), "capacity");
		assert.equal(cache.lookup("one", "x".repeat(1_000_000), 2), "match");
		cache.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("durable entry and byte pressure preserve existing authority and refuse new acceptance", () => {
	const dir = mkdtempSync(join(tmpdir(), "intercom-delivered-pressure-"));
	const path = join(dir, "accepted.sqlite");
	try {
		const entryBound = new DeliveredMessageCache(100, 1, path);
		assert.equal(entryBound.record("retained", "signature", 1), "recorded");
		assert.equal(entryBound.record("entry-pressure", "other", 2), "capacity");
		entryBound.close();

		const byteBound = new DeliveredMessageCache(100, 10, path, 20);
		assert.equal(byteBound.record("byte-pressure", "0123456789", 2), "capacity");
		assert.equal(byteBound.lookup("retained", "signature", 2), "match");
		byteBound.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("malformed durable rows cannot authorize dedupe or question-route rebinding", () => {
	const dir = mkdtempSync(join(tmpdir(), "intercom-delivered-malformed-"));
	const path = join(dir, "accepted.sqlite");
	try {
		const initialized = new DeliveredMessageCache(100, 3, path);
		initialized.close();
		const database = new DatabaseSync(path);
		database.exec(`
			INSERT INTO delivered_messages (
				message_id, state, signature, delivered_at, target_identity,
				question_target_session_id, question_sender_group_identity
			) VALUES ('malformed', 'accepted', 'not-a-fixed-digest', 1, NULL, 'target', NULL);
		`);
		database.close();
		const cache = new DeliveredMessageCache(100, 3, path);
		assert.equal(cache.lookup("malformed", "any signature", 2), "invalid");
		assert.equal(cache.record("malformed", "any signature", 2), "invalid");
		assert.equal(cache.lookupQuestionTarget("malformed", "any signature", "groups", 2), undefined);
		cache.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("missing or malformed authority pairs fail closed without recreating lost state", () => {
	for (const state of ["database-only", "key-only", "malformed-key"] as const) {
		const dir = mkdtempSync(join(tmpdir(), `intercom-delivered-${state}-`));
		const path = join(dir, "accepted.sqlite");
		const keyPath = join(dir, "accepted.key");
		try {
			if (state !== "key-only") writeFileSync(path, "");
			if (state !== "database-only") writeFileSync(keyPath, state === "malformed-key" ? "short" : Buffer.alloc(32));
			const cache = new DeliveredMessageCache(100, 3, path);
			assert.equal(cache.lookup("unknown", "signature", 1), "invalid");
			assert.equal(cache.record("new", "signature", 1), "invalid");
			assert.equal(existsSync(path), state !== "key-only", "a missing database is never silently recreated");
			assert.equal(existsSync(keyPath), state !== "database-only", "a missing key is never silently recreated");
			cache.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

test("corrupt durable acceptance storage fails closed instead of starting empty", () => {
	const dir = mkdtempSync(join(tmpdir(), "intercom-delivered-corrupt-"));
	const path = join(dir, "accepted.sqlite");
	try {
		writeFileSync(path, "truncated-not-a-database");
		writeFileSync(join(dir, "accepted.key"), Buffer.alloc(32));
		const cache = new DeliveredMessageCache(100, 3, path);
		assert.equal(cache.lookup("unknown", "signature", 1), "invalid");
		assert.equal(cache.record("new", "signature", 1), "invalid");
		assert.equal(cache.lookupQuestionTarget("unknown", "signature", "groups", 1), undefined);
		cache.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("durable storage prunes stale records and reopens their bounded capacity", () => {
	const dir = mkdtempSync(join(tmpdir(), "intercom-delivered-stale-"));
	const path = join(dir, "accepted.sqlite");
	try {
		const first = new DeliveredMessageCache(100, 1, path);
		assert.equal(first.record("stale", "old", 0), "recorded");
		first.close();
		const replacement = new DeliveredMessageCache(100, 1, path);
		assert.equal(replacement.record("fresh", "new", 101), "recorded");
		assert.equal(replacement.lookup("stale", "old", 101), "miss");
		replacement.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("durable authority stores only a keyed fixed digest and owner-only artifacts", () => {
	const dir = mkdtempSync(join(tmpdir(), "intercom-delivered-private-"));
	const intercomDir = join(dir, "intercom");
	const path = join(intercomDir, "delivered-messages.sqlite");
	const keyPath = join(intercomDir, "delivered-messages.key");
	const signature = buildSendSignature("recipient", {
		text: "TOP-SECRET",
		attachments: [{ type: "context", name: "credentials", content: "API_KEY=secret" }],
	});
	try {
		const cache = new DeliveredMessageCache(100, 3, path);
		assert.equal(cache.record("sensitive", signature, 1, "recipient-return"), "recorded");
		const database = new DatabaseSync(path);
		const row = database.prepare("SELECT signature FROM delivered_messages WHERE message_id = 'sensitive'").get();
		assert.match(String(row?.signature), /^[a-f0-9]{64}$/);
		database.close();
		for (const artifact of [path, `${path}-wal`, `${path}-shm`, keyPath]) {
			if (!existsSync(artifact)) continue;
			const bytes = readFileSync(artifact);
			assert.equal(bytes.includes("TOP-SECRET"), false, `${artifact} must not persist message text`);
			assert.equal(bytes.includes("API_KEY=secret"), false, `${artifact} must not persist attachment content`);
			if (process.platform !== "win32") assert.equal(statSync(artifact).mode & 0o777, 0o600);
		}
		assert.equal(existsSync(keyPath), true);
		if (process.platform !== "win32") assert.equal(statSync(intercomDir).mode & 0o777, 0o700);
		cache.close();
		if (process.platform !== "win32") {
			chmodSync(intercomDir, 0o755);
			chmodSync(path, 0o644);
			chmodSync(keyPath, 0o644);
		}

		const replacement = new DeliveredMessageCache(100, 3, path);
		assert.equal(replacement.lookupForTarget("sensitive", signature, "recipient-return", 2), "match");
		assert.equal(replacement.lookupForTarget("sensitive", `${signature}changed`, "recipient-return", 2), "conflict");
		if (process.platform !== "win32") {
			assert.equal(statSync(intercomDir).mode & 0o777, 0o700);
			assert.equal(statSync(path).mode & 0o777, 0o600);
			assert.equal(statSync(keyPath).mode & 0o777, 0o600);
		}
		replacement.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("logical send signatures normalize options and ignore transport metadata", () => {
	const options = {
		text: "done",
		attachments: [{ type: "snippet" as const, name: "proof", content: "ok", language: "text" }],
		replyTo: "parent-message",
		expectsReply: false,
	};
	const signature = buildSendSignature("parent", options);
	assert.equal(
		buildMessageSendSignature("parent", {
			id: "attempt-a",
			timestamp: 1,
			replyTo: options.replyTo,
			expectsReply: options.expectsReply,
			content: { text: options.text, attachments: options.attachments },
		}),
		signature,
	);
	assert.equal(
		buildMessageSendSignature("parent", {
			id: "attempt-b",
			timestamp: 999,
			replyTo: options.replyTo,
			expectsReply: options.expectsReply,
			content: { text: options.text, attachments: options.attachments },
		}),
		signature,
		"id and timestamp must not affect logical identity",
	);
	const sourcedMessage = {
		id: "attempt-c",
		timestamp: 1,
		replyTo: options.replyTo,
		expectsReply: options.expectsReply,
		source: { subagentRunId: "source-run", subagentAgent: "reviewer", subagentIndex: 1 },
		content: { text: options.text, attachments: options.attachments },
	};
	const ownedSignature = buildMessageSendSignature("parent", sourcedMessage, "sender-session");
	assert.equal(
		buildMessageSendSignature("parent", { ...sourcedMessage, timestamp: 999 }, "sender-session"),
		ownedSignature,
		"transport timestamp does not change broker-owned identity",
	);
	assert.notEqual(buildMessageSendSignature("parent", sourcedMessage, "other-sender"), ownedSignature);
	assert.notEqual(
		buildMessageSendSignature(
			"parent",
			{ ...sourcedMessage, source: { ...sourcedMessage.source, subagentRunId: "other-source" } },
			"sender-session",
		),
		ownedSignature,
	);
	assert.notEqual(buildSendSignature("other", options), signature);
	assert.notEqual(buildSendSignature("parent", { ...options, text: "changed" }), signature);
	assert.notEqual(buildSendSignature("parent", { ...options, replyTo: "other" }), signature);
	assert.equal(
		buildSendSignature("parent", { text: "done" }),
		buildSendSignature("parent", {
			text: "done",
			attachments: [],
			expectsReply: false,
		}),
		"empty optional collections and false flags normalize to their wire semantics",
	);
	assert.notEqual(buildSendSignature("parent", { ...options, expectsReply: true }), signature);
});
