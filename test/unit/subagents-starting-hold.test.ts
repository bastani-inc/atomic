/**
 * The pieces that keep sends for a starting subagent waiting until it registers: the broker's hold for a starting
 * child, the owner's hold that it makes again after it reconnects and for a retried start, and the start step a child
 * waits in while it registers on Intercom.
 */
import assert from "node:assert/strict";
import type net from "node:net";
import { afterEach, test, vi } from "vitest";
import {
	isSessionStartTimeoutError,
	rehydrateSessionStartError,
	SessionStartTimeoutError,
	serializeSessionStartError,
} from "../../packages/coding-agent/src/index.js";
import {
	RESTORING_RECIPIENT_HOLD_MS,
	RestoringRecipients,
	STARTING_RECIPIENT_HOLD_MAX_MS,
} from "../../packages/intercom/broker/restoring-recipients.js";
import { INTERCOM_CONNECTED_EVENT } from "../../packages/subagents/src/intercom/own-intercom-session.js";
import {
	holdChildTargets,
	holdStartingChild,
	SUBAGENT_RELEASE_RESTORING_CHILD_EVENT,
	SUBAGENT_RESERVE_RESTORING_CHILD_EVENT,
	type SubagentReleaseRestoringChildRequest,
	type SubagentReserveRestoringChildRequest,
} from "../../packages/subagents/src/runs/foreground/subagent-child-hold.js";
import { sessionStartPhase } from "../../packages/subagents/src/runs/inprocess/session-start-budget.js";
import { subagentStartHoldMs } from "../../packages/subagents/src/runs/shared/start-progress.js";

afterEach(() => vi.useRealTimers());

const CHILD = "subagent-worker-1a2b3c4d-1";

function heldSend(messageId: string) {
	return { socket: {} as net.Socket, senderId: "sender", messageId, clientMessage: { type: "send", to: CHILD } };
}

const SENDER = {
	id: "sender",
	info: { id: "sender", cwd: "/repo", model: "m", pid: 1, startedAt: 1, lastActivity: 1, groups: ["default"] },
};

test("a send to a starting subagent waits as long as its owner asks, within the broker's bounds", () => {
	vi.useFakeTimers();
	const expired: string[] = [];
	const recipients = new RestoringRecipients((held, reason) => expired.push(`${held.messageId}: ${reason}`));
	recipients.reserve("capability", "owner", CHILD, "default", [], { holdMs: 12 * 60_000 });
	const admitted = recipients.admit(CHILD, SENDER, heldSend("m1"), true);
	assert.deepEqual(admitted, { kind: "held", timeoutMs: 12 * 60_000 });
	vi.advanceTimersByTime(RESTORING_RECIPIENT_HOLD_MS + 1_000);
	assert.deepEqual(expired, [], "it outlasts a restoring subagent's hold");
	vi.advanceTimersByTime(12 * 60_000);
	assert.equal(expired.length, 1);
	assert.match(expired[0]!, /^m1: Subagent `subagent-worker-1a2b3c4d-1` is still starting/);

	// An owner cannot hold sends longer than the broker allows, or for less than a restore's hold.
	recipients.reserve("capability-2", "owner", "subagent-worker-2", "default", [], { holdMs: 10 * 60 * 60_000 });
	const capped = recipients.admit("subagent-worker-2", SENDER, heldSend("m2"), true);
	assert.deepEqual(capped, { kind: "held", timeoutMs: STARTING_RECIPIENT_HOLD_MAX_MS });
	recipients.reserve("capability-3", "owner", "subagent-worker-3", "default", [], { holdMs: 5 });
	const floored = recipients.admit("subagent-worker-3", SENDER, heldSend("m3"), true);
	assert.deepEqual(floored, { kind: "held", timeoutMs: RESTORING_RECIPIENT_HOLD_MS });
	// A restore's hold is unchanged.
	recipients.reserve("capability-4", "owner", "subagent-worker-4", "default", []);
	const restoring = recipients.admit("subagent-worker-4", SENDER, heldSend("m4"), true);
	assert.deepEqual(restoring, { kind: "held", timeoutMs: RESTORING_RECIPIENT_HOLD_MS });
});

test("an existing restoring reservation upgraded to a starting hold waits for the requested start duration (#5341)", () => {
	vi.useFakeTimers();
	const expired: string[] = [];
	const recipients = new RestoringRecipients((held, reason) => expired.push(`${held.messageId}: ${reason}`));
	recipients.reserve("capability", "owner", CHILD, "default", [], { dormant: false });
	assert.deepEqual(recipients.admit(CHILD, SENDER, heldSend("m0"), true), {
		kind: "held",
		timeoutMs: RESTORING_RECIPIENT_HOLD_MS,
	});
	recipients.reserve("capability", "owner", CHILD, "default", [], { dormant: false, holdMs: 12 * 60_000 });
	assert.deepEqual(recipients.admit(CHILD, SENDER, heldSend("m1"), true), {
		kind: "held",
		timeoutMs: 12 * 60_000,
	});
	vi.advanceTimersByTime(12 * 60_000);
	assert.match(expired.at(-1) ?? "", /^m1: Subagent `subagent-worker-1a2b3c4d-1` is still starting/);
});

function ownerBus() {
	const handlers = new Map<string, Array<(payload: unknown) => void>>();
	const reserved: SubagentReserveRestoringChildRequest[] = [];
	const released: SubagentReleaseRestoringChildRequest[] = [];
	return {
		reserved,
		released,
		on(channel: string, handler: (payload: unknown) => void) {
			handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
			return () =>
				handlers.set(
					channel,
					(handlers.get(channel) ?? []).filter((other) => other !== handler),
				);
		},
		emit(channel: string, payload: unknown) {
			if (channel === SUBAGENT_RESERVE_RESTORING_CHILD_EVENT) {
				const request = payload as SubagentReserveRestoringChildRequest;
				reserved.push({ ...request });
				request.completion = Promise.resolve();
			}
			if (channel === SUBAGENT_RELEASE_RESTORING_CHILD_EVENT) {
				const request = payload as SubagentReleaseRestoringChildRequest;
				released.push({ ...request });
				request.completion = Promise.resolve();
			}
			for (const handler of handlers.get(channel) ?? []) handler(payload);
		},
	};
}

test("a launching child's hold is made again when its owner reconnects and when its start is retried, until it ends", async () => {
	const events = ownerBus();
	const holdMs = subagentStartHoldMs(undefined);
	const hold = await holdStartingChild({
		events,
		intercomTarget: CHILD,
		authorization: { capability: "launch-capability", supervisorSessionId: "owner", childName: CHILD },
		group: "default",
		holdMs,
	});
	assert.deepEqual(
		events.reserved.map(({ capability, holdMs: requested }) => ({ capability, holdMs: requested })),
		[{ capability: "launch-capability", holdMs }],
		"the launch holds sends for the length of both start attempts",
	);
	// The broker forgets an owner's holds when its connection ends.
	events.emit(INTERCOM_CONNECTED_EVENT, { sessionId: "owner" });
	assert.equal(events.reserved.length, 2, "the hold is made again once the owner is back");
	// The stalled start registered and took the sends held so far: its retry gets a hold of its own.
	await hold.renew();
	assert.equal(events.reserved.length, 3);
	assert.equal(events.reserved.at(-1)?.holdMs, holdMs);
	hold.settle({ status: "error", error: "Session start timed out." });
	assert.deepEqual(events.released, [
		{
			capability: "launch-capability",
			refusal: `Subagent \`${CHILD}\` did not start: Session start timed out. The message was not sent.`,
		},
	]);
	events.emit(INTERCOM_CONNECTED_EVENT, { sessionId: "owner" });
	await hold.renew();
	assert.equal(events.reserved.length, 3, "an ended hold is never made again");
});

test("an early restoring hold upgraded with holdWhileStarting is made again when its owner reconnects (#5341)", async () => {
	const events = ownerBus();
	const holdMs = subagentStartHoldMs(undefined);
	const hold = await holdChildTargets(
		events,
		{ intercomTarget: CHILD, childSessionId: "child-session-1" },
		"default",
		{ authorization: { capability: "relaunch-capability", supervisorSessionId: "owner", childName: CHILD } },
	);
	assert.ok(hold);
	assert.deepEqual(
		events.reserved.map(({ capability, aliases, holdMs: requested }) => ({
			capability,
			aliases,
			holdMs: requested,
		})),
		[{ capability: "relaunch-capability", aliases: ["child-session-1"], holdMs: undefined }],
	);

	await hold.holdWhileStarting(holdMs);
	assert.equal(events.reserved.length, 2);
	assert.deepEqual(events.reserved.at(-1), {
		capability: "relaunch-capability",
		aliases: ["child-session-1"],
		group: "default",
		holdMs,
	});

	events.emit(INTERCOM_CONNECTED_EVENT, { sessionId: "owner" });
	assert.equal(events.reserved.length, 3);
	assert.deepEqual(events.reserved.at(-1), {
		capability: "relaunch-capability",
		aliases: ["child-session-1"],
		group: "default",
		holdMs,
	});

	await hold.release();
	events.emit(INTERCOM_CONNECTED_EVENT, { sessionId: "owner" });
	assert.equal(events.reserved.length, 3);
});

test("the hold covers both start attempts of the configured budget", () => {
	assert.equal(subagentStartHoldMs(60_000), 2 * 60_000 + 2 * 60_000);
	assert.equal(subagentStartHoldMs(undefined), 2 * 5 * 60_000 + 2 * 60_000);
});

test("a start that ran out of its budget while registering on Intercom names that step, a setup step", () => {
	const loop = { turns: 1_000, meanTurnMs: 1, maxTurnMs: 5 };
	assert.equal(sessionStartPhase("registering-intercom", loop), "setup");
	const error = new SessionStartTimeoutError({
		subject: "subagent run/worker_1",
		phase: "setup",
		step: "registering-intercom",
		timeoutMs: 1_000,
		elapsedMs: 1_000,
		stepElapsedMs: 900,
		steps: [{ step: "registering-intercom", elapsedMs: 900 }],
		eventLoop: loop,
	});
	assert.match(error.message, /still registering on Intercom/);
	const rehydrated = rehydrateSessionStartError(serializeSessionStartError(error));
	assert.ok(isSessionStartTimeoutError(rehydrated));
	assert.equal(rehydrated.step, "registering-intercom");
});
