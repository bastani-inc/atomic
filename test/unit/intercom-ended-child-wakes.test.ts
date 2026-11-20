import assert from "node:assert/strict";
import type net from "node:net";
import { afterEach, test, vi } from "vitest";
import {
	DepartedChildren,
	type HeldSendRefusal,
	validateEndedChildrenFrame,
	type WakeSender,
} from "../../packages/intercom/broker/departed-children.js";
import {
	ENDED_CHILD_HOLD_MAX_MS,
	ENDED_CHILD_QUEUE_BYTES_MAX,
	ENDED_CHILD_WAKE_ANSWER_MS,
	ENDED_CHILD_WAKE_CHAIN_MAX,
	ENDED_CHILD_WAKE_START_MAX_MS,
	ENDED_CHILD_WAKE_WINDOW_MS,
	ENDED_CHILD_WAKES_PER_WINDOW,
	EndedChildWakeBudget,
	type EndedChildWakeFailure,
	isHeldWhilePaused,
	isQueuedForWake,
	PAUSED_RECIPIENT_TARGET,
	RESUMING_RECIPIENT_TARGET,
} from "../../packages/intercom/broker/ended-child-wakes.js";
import type { HeldSend } from "../../packages/intercom/broker/restoring-recipients.js";

afterEach(() => {
	vi.useRealTimers();
});

const OWNER = "owner-session";
const CHILD = "subagent-worker-aabcf28b-1";

function wakeSender(id = "peer", options: { groups?: string[]; wakeKey?: string } = {}): WakeSender {
	return {
		id,
		info: {
			id,
			name: id,
			cwd: "/repo",
			model: "m",
			pid: 1,
			startedAt: 1,
			lastActivity: 1,
			groups: options.groups ?? ["default"],
		},
		waker: { id, name: id },
		...(options.wakeKey === undefined ? {} : { wakeKey: options.wakeKey }),
	};
}

function send(messageId: string, options: { wake?: boolean; text?: string; broadcastId?: string } = {}): HeldSend {
	return {
		socket: {} as net.Socket,
		senderId: "peer",
		messageId,
		clientMessage: {
			type: "send",
			to: CHILD,
			...(options.wake === false ? {} : { wakeEndedRecipient: true }),
			message: {
				id: messageId,
				timestamp: 1,
				...(options.broadcastId === undefined ? {} : { broadcastId: options.broadcastId }),
				content: { text: options.text ?? "hello" },
			},
		},
	};
}

function children(ownerLive = true, budget = new EndedChildWakeBudget()) {
	const failed: EndedChildWakeFailure[] = [];
	const refused: HeldSendRefusal[] = [];
	const departed = new DepartedChildren((refusals) => refused.push(...refusals), undefined, undefined, undefined, {
		failed: (failures) => failed.push(...failures),
		budget,
		ownerLive: () => ownerLive,
	});
	return { departed, failed, refused };
}

function ended(
	departed: DepartedChildren,
	outcome: "completed" | "failed" | "stopped" | "cancelled",
	messages?: "wake" | "hold",
) {
	return departed.mark(OWNER, [
		{
			childName: CHILD,
			group: "default",
			aliases: [],
			outcome,
			childId: "aabcf28b:0",
			...(messages ? { messages } : {}),
		},
	]);
}

test("an owner's report says what it does with a message to a subagent that ended, never for one cancelled (#5999)", () => {
	const frame = validateEndedChildrenFrame(
		[
			{ childName: "a", outcome: "completed", messages: "wake" },
			{ childName: "b", outcome: "stopped", messages: "hold" },
			{ childName: "c", outcome: "cancelled", messages: "wake" },
			{ childName: "d", outcome: "failed" },
		],
		"default",
	);
	assert.ok(frame.ok);
	assert.deepEqual(
		frame.children.map((child) => child.messages),
		["wake", "hold", undefined, undefined],
	);
	const invalid = validateEndedChildrenFrame(
		[{ childName: "a", outcome: "completed", messages: "always" }],
		"default",
	);
	assert.deepEqual(invalid, { ok: false, refusal: { code: "invalid_frame", childName: "a" } });
});

test("a message to a subagent that finished on its own is queued, and only the first asks its owner to resume it (#5999)", () => {
	vi.useFakeTimers();
	const { departed, failed } = children();
	ended(departed, "completed", "wake");
	const first = departed.admitWake(CHILD, wakeSender(), send("m1"));
	assert.equal(first.kind, "queued");
	assert.equal(first.kind === "queued" && first.target, RESUMING_RECIPIENT_TARGET);
	const wake = first.kind === "queued" ? first.wake : undefined;
	assert.ok(wake);
	assert.deepEqual(
		{ ...wake, wakeId: "w" },
		{
			ownerSessionId: OWNER,
			childName: CHILD,
			childId: "aabcf28b:0",
			wakeId: "w",
			waker: { id: "peer", name: "peer" },
			depth: 1,
		},
	);
	const second = departed.admitWake(CHILD, wakeSender(), send("m2"));
	assert.deepEqual(second, { kind: "queued", target: RESUMING_RECIPIENT_TARGET });
	assert.equal(departed.heldSendCount, 2);

	// Unanswered, the wake ends at its bound and the queued messages fail, once each.
	vi.advanceTimersByTime(ENDED_CHILD_WAKE_ANSWER_MS);
	assert.deepEqual(
		failed.map((failure) => [failure.held.messageId, failure.reason]),
		["m1", "m2"].map((id) => [
			id,
			`Subagent "${CHILD}" was not resumed for this message: its launching session did not answer. The message was not delivered.`,
		]),
	);
	assert.deepEqual(departed.sizes(), { departures: 1, byTarget: 1, byOwner: 1, heldSends: 0, timers: 0 });
	assert.equal(departed.queuedBytes, 0);
});

test("an accepted wake waits for the resumed subagent to register, which takes its queue first and in order (#5999)", () => {
	vi.useFakeTimers();
	const { departed, failed } = children();
	ended(departed, "failed", "wake");
	const first = departed.admitWake(CHILD, wakeSender(), send("m1"));
	const wake = first.kind === "queued" ? first.wake : undefined;
	assert.ok(wake);
	assert.equal(departed.answerWake(OWNER, CHILD, "another wake", true), false, "an answer to another wake is ignored");
	assert.equal(departed.answerWake(OWNER, CHILD, wake.wakeId, true), true);
	departed.admitWake(CHILD, wakeSender(), send("m2"));
	vi.advanceTimersByTime(ENDED_CHILD_WAKE_START_MAX_MS - 1);
	assert.deepEqual(failed, []);
	const delivered = departed.registered(CHILD, new Set(["default"]), OWNER);
	assert.deepEqual(
		delivered.map((held) => held.messageId),
		["m1", "m2"],
	);
	assert.ok(delivered.every(isQueuedForWake));
	assert.deepEqual(departed.sizes(), { departures: 0, byTarget: 0, byOwner: 0, heldSends: 0, timers: 0 });
	vi.advanceTimersByTime(1);
	assert.deepEqual(failed, []);
});

test("an owner that declines the wake fails the queued messages with its reason (#5999)", () => {
	const { departed, failed } = children();
	ended(departed, "completed", "wake");
	const first = departed.admitWake(CHILD, wakeSender(), send("m1"));
	assert.ok(first.kind === "queued" && first.wake);
	departed.answerWake(OWNER, CHILD, first.wake.wakeId, false, "it was cancelled for good");
	assert.deepEqual(
		failed.map((failure) => failure.reason),
		[
			`Subagent "${CHILD}" was not resumed for this message: it was cancelled for good. The message was not delivered.`,
		],
	);
	const again = departed.admitWake(CHILD, wakeSender(), send("m2"));
	assert.ok(again.kind === "queued" && again.wake !== undefined, "a later message may ask again");
});

test("a paused subagent is never woken: its message waits for it to be continued, for a bounded time (#5999)", () => {
	vi.useFakeTimers();
	const { departed, failed } = children();
	ended(departed, "stopped", "hold");
	const held = send("m1");
	assert.deepEqual(departed.admitWake(CHILD, wakeSender(), held), { kind: "queued", target: PAUSED_RECIPIENT_TARGET });
	assert.equal(isHeldWhilePaused(held), true);
	vi.advanceTimersByTime(ENDED_CHILD_HOLD_MAX_MS);
	assert.deepEqual(
		failed.map((failure) => failure.reason),
		[
			`Subagent "${CHILD}" is paused and was not continued within an hour. The message was not delivered; send it again once it is continued if it is still needed.`,
		],
	);
});

test("only a send that asks to wake, to a subagent whose owner offers it and is here, is queued (#5999)", () => {
	const { departed } = children();
	ended(departed, "completed", "wake");
	assert.deepEqual(departed.admitWake(CHILD, wakeSender(), send("m1", { wake: false })), { kind: "none" });
	assert.deepEqual(departed.admitWake(CHILD, wakeSender(), send("m2", { broadcastId: "b" })), { kind: "none" });
	assert.deepEqual(departed.admitWake(CHILD, wakeSender("outsider", { groups: ["elsewhere"] }), send("m3")), {
		kind: "none",
	});
	const killed = children();
	ended(killed.departed, "cancelled", "wake");
	assert.deepEqual(killed.departed.admitWake(CHILD, wakeSender(), send("m4")), { kind: "none" });
	const away = children(false);
	ended(away.departed, "completed", "wake");
	assert.deepEqual(away.departed.admitWake(CHILD, wakeSender(), send("m5")), { kind: "none" });
	const older = children();
	ended(older.departed, "completed");
	assert.deepEqual(older.departed.admitWake(CHILD, wakeSender(), send("m6")), { kind: "none" });
	const unhooked = new DepartedChildren(() => {});
	unhooked.mark(OWNER, [{ childName: CHILD, group: "default", aliases: [], outcome: "completed", messages: "wake" }]);
	assert.deepEqual(unhooked.admitWake(CHILD, wakeSender(), send("m7")), { kind: "none" });
});

test("the messages queued for one subagent are bounded in bytes, and refused beyond it with its ended refusal (#5999)", () => {
	const { departed } = children();
	ended(departed, "stopped", "hold");
	const large = "x".repeat(1024 * 1024);
	let refused: ReturnType<DepartedChildren["admitWake"]> | undefined;
	for (let index = 0; index < 64 && refused === undefined; index++) {
		const admission = departed.admitWake(CHILD, wakeSender(), send(`m${index}`, { text: large }));
		if (admission.kind === "refused") refused = admission;
	}
	assert.ok(refused?.kind === "refused");
	assert.equal(refused.error.code, "recipient_stopped");
	assert.match(refused.reason, /The message was not queued for it: \d+ MiB of messages already wait for it\.$/);
	assert.ok(departed.queuedBytes <= ENDED_CHILD_QUEUE_BYTES_MAX);
});

test("a send that waited for the owner's verdict is queued once the verdict lets it, or refused as before (#5999)", () => {
	const { departed } = children();
	departed.depart({ ownerSessionId: OWNER, childName: CHILD, group: "default", aliases: [] });
	const flagged = send("m1");
	const plain = send("m2", { wake: false });
	assert.equal(departed.admit(CHILD, wakeSender(), flagged, true, wakeSender()).kind, "held");
	assert.equal(departed.admit(CHILD, wakeSender(), plain, true).kind, "held");
	const marked = ended(departed, "completed", "wake");
	assert.deepEqual(
		marked.queued.map(({ held, target }) => [held.messageId, target]),
		[["m1", RESUMING_RECIPIENT_TARGET]],
	);
	assert.equal(marked.wakes.length, 1);
	assert.deepEqual(
		marked.refused.map(({ held, error }) => [held.messageId, error.code]),
		[["m2", "recipient_completed"]],
	);
});

test("what was queued fails when the owner leaves, when it reports the subagent cancelled, or is forgotten (#5999)", () => {
	const { departed, failed } = children();
	ended(departed, "completed", "wake");
	departed.admitWake(CHILD, wakeSender(), send("m1"));
	ended(departed, "cancelled");
	assert.deepEqual(
		failed.map((failure) => failure.reason),
		[
			`Subagent "${CHILD}" was cancelled for good and has no live session (recipient_cancelled). It cannot be resumed; launch a fresh subagent if its work is still needed.`,
		],
	);
	ended(departed, "completed", "wake");
	departed.admitWake(CHILD, wakeSender(), send("m2"));
	departed.dropOwner(OWNER, "host-session");
	assert.match(failed.at(-1)!.reason, /disconnected before it was resumed/);
	assert.equal(departed.heldSendCount, 0);
});

test("a restoring hold of a subagent queued for keeps its queue; a release or a hosting forgets it (#5999)", () => {
	const { departed, failed } = children();
	ended(departed, "completed", "wake");
	departed.admitWake(CHILD, wakeSender(), send("m1"));
	assert.deepEqual(departed.supersede(OWNER, CHILD, true), []);
	assert.equal(departed.heldSendCount, 1, "the resume's own hold keeps what was queued");
	assert.deepEqual(failed, []);
	assert.deepEqual(departed.supersede(OWNER, CHILD), []);
	assert.equal(failed.length, 1);
});

test("a subagent is woken at most so often, and a chain of wakes stops at its bound (#5999)", () => {
	let now = 0;
	const budget = new EndedChildWakeBudget(() => now);
	for (let index = 0; index < ENDED_CHILD_WAKES_PER_WINDOW; index++) {
		assert.deepEqual(budget.check("child", undefined), { ok: true, depth: 1 });
		budget.commit("child");
	}
	const limited = budget.check("child", undefined);
	assert.equal(limited.ok, false);
	assert.match(limited.ok ? "" : limited.why, /already woken by messages 6 times in the last 10 minutes/);
	now += ENDED_CHILD_WAKE_WINDOW_MS;
	assert.equal(budget.check("child", undefined).ok, true, "the window moves on");

	budget.awoke("a", 1);
	assert.deepEqual(budget.check("b", "a"), { ok: true, depth: 2 }, "a wake from a woken sender is one further down");
	budget.awoke("a", ENDED_CHILD_WAKE_CHAIN_MAX);
	const chained = budget.check("b", "a");
	assert.equal(chained.ok, false);
	assert.match(chained.ok ? "" : chained.why, /wakes stop at 4 in a row/);
	budget.resumedByOwner("a");
	assert.deepEqual(budget.check("b", "a"), { ok: true, depth: 1 }, "an owner's own resume starts no chain");
	budget.awoke("a", ENDED_CHILD_WAKE_CHAIN_MAX);
	now += ENDED_CHILD_WAKE_WINDOW_MS + 1;
	assert.deepEqual(budget.check("b", "a"), { ok: true, depth: 1 }, "a wake older than the window counts no more");
});

test("a subagent its owner already holds takes a message without a wake, and a hold given up fails what waits (#5999)", () => {
	vi.useFakeTimers();
	const { departed, failed } = children();
	ended(departed, "completed", "wake");
	assert.deepEqual(departed.admitWake(CHILD, wakeSender(), send("m1"), true), {
		kind: "queued",
		target: RESUMING_RECIPIENT_TARGET,
	});
	departed.holdEnded(OWNER, CHILD, {});
	assert.equal(failed.length, 0, "a hold that ended for no reason given keeps the queue");
	departed.holdEnded(OWNER, CHILD, { refusal: "Subagent `x` did not start: boom The message was not sent." });
	assert.deepEqual(
		failed.map((failure) => failure.reason),
		["Subagent `x` did not start: boom The message was not sent."],
	);
	departed.admitWake(CHILD, wakeSender(), send("m2"), true);
	departed.holdEnded(OWNER, CHILD, { gone: "gone for good" });
	assert.equal(failed.at(-1)!.reason, "gone for good");
	assert.deepEqual(
		departed.admitWake(CHILD, wakeSender(), send("m3")),
		{ kind: "none" },
		"a gone subagent is forgotten",
	);

	const unstarted = children();
	ended(unstarted.departed, "completed", "wake");
	unstarted.departed.admitWake(CHILD, wakeSender(), send("m4"), true);
	vi.advanceTimersByTime(ENDED_CHILD_WAKE_START_MAX_MS);
	assert.match(unstarted.failed[0]!.reason, /it did not start in time/);
});
