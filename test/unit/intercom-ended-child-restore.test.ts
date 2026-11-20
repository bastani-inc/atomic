import assert from "node:assert/strict";
import type net from "node:net";
import { afterEach, test, vi } from "vitest";
import {
	DepartedChildren,
	type JournalDeparture,
	type RestoredEndedQueue,
	type WakeSender,
} from "../../packages/intercom/broker/departed-children.js";
import {
	ENDED_CHILD_OWNER_AWAY_MAX_MS,
	ENDED_CHILD_WAKE_WINDOW_MS,
	ENDED_CHILD_WAKES_PER_WINDOW,
	EndedChildWakeBudget,
	type EndedChildWakeFailure,
	isHeldWhilePaused,
	PAUSED_RECIPIENT_TARGET,
	RESUMING_RECIPIENT_TARGET,
} from "../../packages/intercom/broker/ended-child-wakes.js";
import type { HeldSend } from "../../packages/intercom/broker/restoring-recipients.js";

/**
 * #5999 durable wake queue: what a restarted broker does with the messages an earlier one kept for subagents that
 * ended, before and after their owner reports them again.
 */

afterEach(() => {
	vi.useRealTimers();
});

const OWNER = "owner-session";
const HOST = "owner-host";
const CHILD = "subagent-worker-restored-1";

function sender(id = "peer"): WakeSender {
	return {
		id,
		info: { id, name: id, cwd: "/repo", model: "m", pid: 1, startedAt: 1, lastActivity: 1, groups: ["default"] },
		waker: { id, name: id },
	};
}

function send(messageId: string, wake = true): HeldSend {
	return {
		socket: {} as net.Socket,
		senderId: "peer",
		messageId,
		clientMessage: {
			type: "send",
			to: CHILD,
			...(wake ? { wakeEndedRecipient: true } : {}),
			message: { id: messageId, timestamp: 1, content: { text: messageId } },
		},
	};
}

function restoredQueue(
	messages: "wake" | "hold",
	ids: readonly string[],
	extra: Partial<RestoredEndedQueue> = {},
): RestoredEndedQueue {
	return {
		ownerSessionId: OWNER,
		ownerHost: HOST,
		childName: CHILD,
		group: "default",
		aliases: [],
		childId: "run:0",
		outcome: messages === "hold" ? "stopped" : "completed",
		messages,
		sends: ids.map((id) => ({ held: send(id), sender: sender() })),
		...extra,
	};
}

function children(ownerLive: () => boolean = () => true, budget = new EndedChildWakeBudget()) {
	const failed: EndedChildWakeFailure[] = [];
	const journal = { away: [] as Array<number | undefined>, wakes: [] as unknown[] };
	const departed = new DepartedChildren(() => {}, undefined, undefined, undefined, {
		failed: (failures) => failed.push(...failures),
		budget,
		ownerLive,
		ownerHost: () => HOST,
		journal: {
			queued: () => undefined,
			wake: (_departure: JournalDeparture, wake) => journal.wakes.push(wake),
			ownerAway: (_departures, since) => journal.away.push(since),
			rekeyOwner: () => {},
		},
	});
	return { departed, failed, journal, budget };
}

function mark(departed: DepartedChildren, outcome: "completed" | "stopped" | "cancelled") {
	return departed.mark(OWNER, [
		{
			childName: CHILD,
			group: "default",
			aliases: [],
			outcome,
			childId: "run:0",
			...(outcome === "cancelled"
				? {}
				: { messages: outcome === "stopped" ? ("hold" as const) : ("wake" as const) }),
		},
	]);
}

test("a restored queue wakes its finished subagent only once its owner reports it again: one new wake, counted", () => {
	const budget = new EndedChildWakeBudget();
	const { departed, failed } = children(() => true, budget);
	// Its owner is connected already, and has not reported the child yet.
	assert.deepEqual(
		departed.restore([restoredQueue("wake", ["m1", "m2"], { wake: { id: "lost-wake", depth: 1 } })], () => OWNER),
		[],
		"no wake from what an earlier broker knew",
	);
	const marked = mark(departed, "completed");
	assert.equal(marked.wakes.length, 1);
	assert.notEqual(marked.wakes[0]!.wakeId, "lost-wake");
	assert.equal(marked.wakes[0]!.childName, CHILD);
	// Reported again (another reconnect): no second wake while this one is pending.
	assert.equal(mark(departed, "completed").wakes.length, 0);
	assert.deepEqual(
		departed.registered(CHILD, new Set(["default"]), OWNER).map((held) => held.messageId),
		["m1", "m2"],
	);
	assert.deepEqual(failed, []);
	// The wake counted against the bounds.
	for (let index = 1; index < ENDED_CHILD_WAKES_PER_WINDOW; index++) budget.commit(`${OWNER}\0${CHILD}`);
	assert.equal(budget.check(`${OWNER}\0${CHILD}`, undefined).ok, false);
});

test("a restored queue of a paused subagent is never woken, whatever its owner reports, until it is continued", () => {
	const { departed, failed } = children();
	departed.restore([restoredQueue("hold", ["p1"])], () => OWNER);
	assert.deepEqual(mark(departed, "stopped").wakes, []);
	const [held] = departed.registered(CHILD, new Set(["default"]), OWNER);
	assert.equal(held?.messageId, "p1");
	assert.equal(isHeldWhilePaused(held as HeldSend), true, "it follows what continues the subagent");
	assert.deepEqual(failed, []);
});

test("a restored queue fails once when its owner reports the subagent cancelled", () => {
	const { departed, failed } = children();
	departed.restore([restoredQueue("wake", ["m1", "m2"])], () => OWNER);
	assert.deepEqual(mark(departed, "cancelled").wakes, []);
	assert.deepEqual(
		failed.map((failure) => [failure.held.messageId, failure.reason]),
		[
			[
				"m1",
				`Subagent "${CHILD}" was cancelled for good and has no live session (recipient_cancelled). It cannot be resumed; launch a fresh subagent if its work is still needed.`,
			],
			[
				"m2",
				`Subagent "${CHILD}" was cancelled for good and has no live session (recipient_cancelled). It cannot be resumed; launch a fresh subagent if its work is still needed.`,
			],
		],
	);
	mark(departed, "cancelled");
	assert.equal(failed.length, 2, "once");
});

test("before its owner reports it, a restored subagent takes only sends that ask to wake it, behind what was restored", () => {
	const { departed } = children();
	departed.restore([restoredQueue("wake", ["m1"])], () => OWNER);
	assert.deepEqual(
		departed.admit(CHILD, sender(), send("plain", false), true),
		{ kind: "none" },
		"the answer of before the restart",
	);
	assert.deepEqual(departed.admitWake(CHILD, sender(), send("m2")), {
		kind: "queued",
		target: RESUMING_RECIPIENT_TARGET,
	});
	// A retry of a restored message, whose answer the restart cut off, is answered again and queued nowhere else.
	assert.deepEqual(departed.admitWake(CHILD, sender(), send("m1")), {
		kind: "queued",
		target: RESUMING_RECIPIENT_TARGET,
		duplicate: true,
	});
	assert.equal(mark(departed, "completed").wakes.length, 1);
	assert.deepEqual(
		departed.registered(CHILD, new Set(["default"]), OWNER).map((held) => held.messageId),
		["m1", "m2"],
	);
});

test("an owner that is not back waits for what is left of its 7 days, from when it went away", () => {
	vi.useFakeTimers();
	vi.setSystemTime(10 * ENDED_CHILD_OWNER_AWAY_MAX_MS);
	const { departed, failed, journal } = children(() => false);
	const awaySince = Date.now() - ENDED_CHILD_OWNER_AWAY_MAX_MS / 2;
	departed.restore([restoredQueue("hold", ["p1"], { awaySince })], () => undefined);
	assert.deepEqual(journal.away, [awaySince]);
	assert.deepEqual(
		departed.admitWake(CHILD, sender(), send("p2")),
		{ kind: "queued", target: PAUSED_RECIPIENT_TARGET },
		"a message for it waits with the others",
	);
	vi.advanceTimersByTime(ENDED_CHILD_OWNER_AWAY_MAX_MS / 2 - 1);
	assert.equal(failed.length, 0);
	vi.advanceTimersByTime(1);
	assert.deepEqual(
		failed.map((failure) => failure.held.messageId),
		["p1", "p2"],
	);
	assert.match(failed[0]!.reason, /the session that launched it has not been back for 7 days/);
});

test("an owner back after a restart takes its subagents over again, untimed", () => {
	vi.useFakeTimers();
	const { departed, failed, journal } = children(() => true);
	departed.restore([restoredQueue("hold", ["p1"])], () => undefined);
	assert.deepEqual(departed.adoptOrphans("owner-back", HOST), []);
	assert.deepEqual(journal.away.at(-1), undefined, "it is back");
	vi.advanceTimersByTime(2 * ENDED_CHILD_OWNER_AWAY_MAX_MS);
	assert.deepEqual(failed, []);
	assert.deepEqual(
		departed.registered(CHILD, new Set(["default"]), "owner-back").map((held) => held.messageId),
		["p1"],
	);
});

test("the wake bounds count again what an earlier broker counted, as long as it would have", () => {
	let now = 1_000_000;
	const wall = 50_000_000;
	const budget = new EndedChildWakeBudget(
		() => now,
		undefined,
		undefined,
		undefined,
		() => wall + (now - 1_000_000),
	);
	const key = `${OWNER}\0${CHILD}`;
	budget.restore([
		...Array.from({ length: ENDED_CHILD_WAKES_PER_WINDOW }, () => ({
			childKey: key,
			kind: "wake" as const,
			at: wall - ENDED_CHILD_WAKE_WINDOW_MS / 2,
			depth: 1,
		})),
		{ childKey: "chain", kind: "awake", at: wall - 1_000, depth: 3 },
	]);
	assert.equal(budget.check(key, undefined).ok, false, "as many wakes in the window as before the restart");
	assert.equal((budget.check("other", "chain") as { depth: number }).depth, 4, "the chain goes on where it was");
	now += ENDED_CHILD_WAKE_WINDOW_MS / 2;
	assert.equal(budget.check(key, undefined).ok, true, "and they leave the window when they would have");
});

test("after the wall clock stepped back, a wake counts as just now, and is forgotten one window later", () => {
	let now = 1_000_000;
	const wall = 50_000_000;
	const budget = new EndedChildWakeBudget(
		() => now,
		undefined,
		undefined,
		undefined,
		() => wall,
	);
	const key = `${OWNER}\0${CHILD}`;
	budget.restore(
		Array.from({ length: ENDED_CHILD_WAKES_PER_WINDOW }, () => ({
			childKey: key,
			kind: "wake" as const,
			// Written before the step back: in the future now.
			at: wall + 10 * ENDED_CHILD_WAKE_WINDOW_MS,
			depth: 1,
		})),
	);
	assert.equal(budget.check(key, undefined).ok, false);
	now += ENDED_CHILD_WAKE_WINDOW_MS - 1;
	assert.equal(budget.check(key, undefined).ok, false);
	now += 1;
	assert.equal(budget.check(key, undefined).ok, true, "never stricter for longer than a window");
});

const DAY_MS = 24 * 60 * 60_000;

test("with its launching session connected, a paused subagent's message waits past 7 days and reaches it when continued", () => {
	vi.useFakeTimers();
	const { departed, failed } = children(() => true);
	mark(departed, "stopped");
	assert.deepEqual(departed.admitWake(CHILD, sender(), send("p1")), {
		kind: "queued",
		target: PAUSED_RECIPIENT_TARGET,
	});
	vi.advanceTimersByTime(ENDED_CHILD_OWNER_AWAY_MAX_MS + 3 * DAY_MS);
	assert.deepEqual(failed, [], "no time limit while the launching session is here");
	assert.deepEqual(
		departed.registered(CHILD, new Set(["default"]), OWNER).map((held) => held.messageId),
		["p1"],
	);
});

test("its launching session away for just under 7 days, a paused subagent's message is still held, and reaches it when continued", () => {
	vi.useFakeTimers();
	assert.equal(ENDED_CHILD_OWNER_AWAY_MAX_MS, 7 * DAY_MS);
	const { departed, failed } = children(() => true);
	mark(departed, "stopped");
	departed.admitWake(CHILD, sender(), send("p1"));
	departed.dropOwner(OWNER, HOST);
	vi.advanceTimersByTime(7 * DAY_MS - 1);
	assert.deepEqual(failed, []);
	assert.deepEqual(departed.adoptOrphans(OWNER, HOST), []);
	assert.deepEqual(
		departed.registered(CHILD, new Set(["default"]), OWNER).map((held) => held.messageId),
		["p1"],
	);
});

test("the 7 days count only while the launching session is away without a break; then the message fails once", () => {
	vi.useFakeTimers();
	const { departed, failed } = children(() => true);
	mark(departed, "stopped");
	departed.admitWake(CHILD, sender(), send("p1"));
	departed.dropOwner(OWNER, HOST);
	vi.advanceTimersByTime(6 * DAY_MS);
	// Back for a while: its count starts again when it next goes away.
	assert.deepEqual(departed.adoptOrphans(OWNER, HOST), []);
	vi.advanceTimersByTime(6 * DAY_MS);
	departed.dropOwner(OWNER, HOST);
	vi.advanceTimersByTime(6 * DAY_MS);
	assert.equal(failed.length, 0, "never 7 days away in a row yet");
	vi.advanceTimersByTime(DAY_MS);
	assert.deepEqual(
		failed.map((failure) => [failure.held.messageId, failure.reason]),
		[
			[
				"p1",
				`Subagent "${CHILD}" was not continued for this message: the session that launched it has not been back for 7 days. The message was not delivered; send it again if it is still needed.`,
			],
		],
	);
	vi.advanceTimersByTime(ENDED_CHILD_OWNER_AWAY_MAX_MS);
	assert.equal(failed.length, 1, "once");
});
