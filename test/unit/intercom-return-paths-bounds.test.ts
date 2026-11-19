import assert from "node:assert/strict";
import { test } from "vitest";
import {
	RETURN_PATH_MAX_ENTRIES,
	RETURN_PATH_MESSAGE_LIMIT,
	RETURN_PATH_WINDOW_MS,
	type ReturnPathParty,
	ReturnPaths,
} from "../../packages/intercom/broker/return-paths.js";

function party(name: string): ReturnPathParty {
	return { sessionId: name, identity: `["return","${name}","default"]` };
}

/** Return paths on a clock the test moves. */
function clocked(maxEntries = RETURN_PATH_MAX_ENTRIES) {
	const clock = { now: 1_000 };
	return {
		clock,
		paths: new ReturnPaths(() => clock.now, RETURN_PATH_WINDOW_MS, RETURN_PATH_MESSAGE_LIMIT, maxEntries),
	};
}

function exhaust(paths: ReturnPaths, responder: ReturnPathParty, sender: ReturnPathParty, prefix: string): void {
	for (let index = 0; index < RETURN_PATH_MESSAGE_LIMIT; index++) {
		assert.equal(paths.use(responder, sender, `${prefix}-${index}`), true);
	}
	assert.equal(paths.use(responder, sender, `${prefix}-over`), false);
}

test("a dropped return path takes its answer count with it and is never reopened by pressure", () => {
	const recipient = party("recipient");
	for (const capacity of [2, RETURN_PATH_MAX_ENTRIES]) {
		const { paths } = clocked(capacity);
		for (let index = 0; index < capacity; index++) paths.open(recipient, party(`sender-${index}`), `note-${index}`);
		const original = party(`sender-${capacity - 1}`);
		exhaust(paths, recipient, original, `original-${capacity}`);
		// Answers on every other path, then one more path than the broker keeps.
		for (let index = 0; index < capacity - 1; index++)
			paths.use(recipient, party(`sender-${index}`), `other-${index}`);
		paths.open(recipient, party("sender-new"), "note-new");
		paths.use(recipient, party("sender-new"), "other-new");
		for (let index = 0; index < capacity * 2; index++)
			paths.open(party(`elsewhere-${index}`), party(`writer-${index}`), `pressure-${index}`);
		assert.equal(paths.use(recipient, original, `original-${capacity}-after-pressure`), false);
	}
});

test("each distinct message opens a fresh count, however close together; the same message never does", () => {
	const { clock, paths } = clocked();
	const recipient = party("recipient");
	const sender = party("sender");
	paths.open(recipient, sender, "first");
	exhaust(paths, recipient, sender, "first-answer");
	// A retry, replay or re-forward of the message that already reached the recipient.
	paths.open(recipient, sender, "first");
	assert.equal(paths.use(recipient, sender, "after-retry"), false);
	// A new message in the same clock tick.
	paths.open(recipient, sender, "second");
	assert.equal(paths.use(recipient, sender, "after-second"), true);
	clock.now += 1;
	assert.equal(paths.closed(recipient, sender), false);
});

test("a return path closes when its window ends and never opens on a clock that went back", () => {
	const { clock, paths } = clocked();
	const recipient = party("recipient");
	const sender = party("sender");
	paths.open(recipient, sender, "note");
	clock.now += RETURN_PATH_WINDOW_MS;
	assert.equal(paths.use(recipient, sender, "at-the-edge"), true);
	clock.now += 1;
	assert.equal(paths.use(recipient, sender, "too-late"), false);
	assert.equal(paths.closed(recipient, sender), true);
	// An answer already counted stays allowed, as its retry is the same message.
	assert.equal(paths.use(recipient, sender, "at-the-edge"), true);
	const behind = clocked();
	behind.paths.open(recipient, sender, "note");
	behind.clock.now -= 60 * 60_000;
	assert.equal(behind.paths.use(recipient, sender, "before-it-opened"), false);
});

test("a return path binds registration identities: a new session under the same id gets nothing", () => {
	const { paths } = clocked();
	const recipient = party("recipient");
	const sender = party("sender");
	paths.open(recipient, sender, "note");
	assert.equal(
		paths.holds(recipient, { sessionId: "sender", identity: '["return","another-host","default"]' }),
		false,
	);
	assert.equal(paths.use(recipient, { sessionId: "sender", identity: undefined }, "answer"), false);
	assert.equal(
		paths.holds({ sessionId: "recipient", identity: '["return","another-recipient","default"]' }, sender),
		false,
	);
	// A session registered without a return address has no stable identity, so it neither opens nor holds a path.
	const anonymous: ReturnPathParty = { sessionId: "anonymous", identity: undefined };
	paths.open(anonymous, sender, "anonymous-note");
	assert.equal(paths.holds(anonymous, sender), false);
	paths.revoke(sender.identity!);
	assert.equal(paths.holds(recipient, sender), false);
});

test("a path dropped under pressure is not reopened by the message that opened it", () => {
	const { paths } = clocked(1);
	const launcher = party("launcher");
	const recipient = party("recipient");
	paths.open(recipient, launcher, "live-note");
	exhaust(paths, recipient, launcher, "live-answer");
	paths.open(party("other"), party("writer"), "pressure");
	assert.equal(paths.holds(recipient, launcher), false);
	paths.open(recipient, launcher, "live-note");
	assert.equal(paths.holds(recipient, launcher), false);
});

test("a message handed over before its sender ended for good opens nothing, even once that end is forgotten", () => {
	const recipient = party("recipient");
	const sender = party("ended-sender");
	const { paths } = clocked(2);
	const handedOver = paths.mark();
	paths.revoke(sender.identity as string);
	paths.open(recipient, sender, "late-receipt", handedOver);
	assert.equal(paths.holds(recipient, sender), false);
	// More identities end than the paths remember: the sender's end is forgotten, and an old mark still opens nothing.
	for (let index = 0; index < 3; index++) paths.revoke(party(`other-${index}`).identity as string);
	paths.open(recipient, sender, "late-receipt-after-forgetting", handedOver);
	assert.equal(paths.holds(recipient, sender), false);
	// A message the identity sends after it registers again opens its path.
	paths.open(recipient, sender, "new-message", paths.mark());
	assert.equal(paths.holds(recipient, sender), true);
});
