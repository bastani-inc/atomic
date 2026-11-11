import assert from "node:assert/strict";
import type net from "node:net";
import { afterEach, test, vi } from "vitest";
import {
	isSubagentRecipientOwnerSuspendedError,
	SubagentRecipientOwnerSuspendedError,
} from "../../packages/intercom/broker/recipient-gone-errors.js";
import { ReleasedChildReservationError } from "../../packages/intercom/broker/released-child-errors.js";
import { releasedReservationKey } from "../../packages/intercom/broker/released-children.js";
import {
	type HeldSend,
	ORPHANED_RESERVATIONS_MAX,
	RESTORING_RECIPIENT_HOLD_MS,
	RestoringRecipients,
} from "../../packages/intercom/broker/restoring-recipients.js";
import type { DeliveryFailureReasonCode, SessionInfo } from "../../packages/intercom/types.js";

afterEach(() => {
	vi.useRealTimers();
});

const CHILD = "subagent-worker-suspended-1";
const HOST = "01a1c7ac-ffab-74d0-833c-bc9f2d3a4b9f";

interface Expiry {
	readonly messageId: string;
	readonly reason: string;
	readonly reasonCode: DeliveryFailureReasonCode;
	readonly error?: Error;
}

function recipients(orphansMax?: number): { recipients: RestoringRecipients; expired: Expiry[] } {
	const expired: Expiry[] = [];
	const created = new RestoringRecipients(
		(held, reason, reasonCode, error) =>
			expired.push({ messageId: held.messageId, reason, reasonCode, ...(error === undefined ? {} : { error }) }),
		orphansMax,
	);
	return { recipients: created, expired };
}

function sender(id: string, groups: string[] = ["default"]): { id: string; info: SessionInfo } {
	return { id, info: { id, cwd: "/repo", model: "m", pid: 1, startedAt: 1, lastActivity: 1, groups } };
}

function send(messageId: string, to = CHILD): HeldSend {
	return { socket: {} as net.Socket, senderId: "sender", messageId, clientMessage: { type: "send", to } };
}

function reserveReleased(target: RestoringRecipients, owner: string, childName = CHILD, group = "default") {
	return target.reserve(releasedReservationKey(childName), owner, childName, group, [], {
		dormant: true,
		wake: true,
		replaceAliases: true,
	});
}

test("a released child outlives its owner's disconnect and holds sends without asking anyone to wake it (#4639)", () => {
	assert.equal(ORPHANED_RESERVATIONS_MAX, 4_096);
	const { recipients: held } = recipients();
	reserveReleased(held, "stage-1");
	assert.deepEqual(held.dropOwner("stage-1", HOST), []);
	assert.equal(held.size, 1);
	assert.equal(held.orphanCount, 1);
	assert.equal(held.releasedOwner(CHILD), "stage-1");
	assert.deepEqual(held.admit(CHILD, sender("sender"), send("m1"), true), {
		kind: "held",
		timeoutMs: RESTORING_RECIPIENT_HOLD_MS,
	});
	assert.equal(held.heldSendCount, 1);
});

test("the same host session coming back takes the child over, is asked to wake it, and its registration delivers the held sends (#4639)", () => {
	const { recipients: held } = recipients();
	reserveReleased(held, "stage-1");
	held.dropOwner("stage-1", HOST);
	held.admit(CHILD, sender("sender"), send("m1"), true);
	held.admit(CHILD, sender("sender"), send("m2"), true);

	held.adoptOrphans("stage-2", HOST);
	assert.equal(held.orphanCount, 0);
	assert.equal(held.releasedOwner(CHILD), "stage-2");
	assert.equal(held.sizes().byOwner, 1, "the departed owner keeps no index entry");
	assert.deepEqual(reserveReleased(held, "stage-2"), { ownerSessionId: "stage-2", childName: CHILD });
	assert.deepEqual(reserveReleased(held, "stage-2"), undefined, "the wake is asked once");
	assert.deepEqual(held.extendHolds(CHILD, "stage-2")?.length, 2, "the new owner may confirm the wake");
	const taken = held.consume(undefined, { childName: CHILD, groups: new Set(["default"]), authorizedBy: "stage-2" });
	assert.deepEqual(
		taken.map((entry) => entry.messageId),
		["m1", "m2"],
	);
	assert.equal(held.size, 0);
});

test("a session of the same host that reconnects under the same Intercom id takes the child over too (#4639)", () => {
	const { recipients: held } = recipients();
	reserveReleased(held, "stage-1");
	held.dropOwner("stage-1", HOST);
	held.admit(CHILD, sender("sender"), send("m1"), true);
	held.adoptOrphans("stage-1", HOST);
	assert.equal(held.orphanCount, 0);
	assert.deepEqual(reserveReleased(held, "stage-1"), { ownerSessionId: "stage-1", childName: CHILD });
	assert.deepEqual(
		held.dropOwner("stage-1").map((entry) => entry.messageId),
		["m1"],
		"taken back, it is its owner's again: a disconnect without its host ends it as before",
	);
});

test("no other session takes a suspended owner's child, and a session without a host takes none (#4639)", () => {
	const { recipients: held } = recipients();
	reserveReleased(held, "stage-1");
	held.dropOwner("stage-1", HOST);
	held.adoptOrphans("stranger", "01a1ffff-0000-7000-8000-000000000000");
	held.adoptOrphans("stranger", undefined);
	assert.equal(held.orphanCount, 1);
	assert.equal(held.releasedOwner(CHILD), "stage-1");
	assert.throws(
		() => reserveReleased(held, "stranger"),
		(error: Error) => error instanceof ReleasedChildReservationError && error.code === "not_owner",
	);
});

test("a held send whose owner does not come back is refused, retryably, as its owner being away (#4639)", () => {
	vi.useFakeTimers();
	const { recipients: held, expired } = recipients();
	reserveReleased(held, "stage-1");
	held.dropOwner("stage-1", HOST);
	held.admit(` ${CHILD} `, sender("sender"), send("m1", ` ${CHILD} `), true);
	vi.advanceTimersByTime(RESTORING_RECIPIENT_HOLD_MS - 1);
	assert.equal(expired.length, 0);
	vi.advanceTimersByTime(1);
	assert.equal(expired.length, 1);
	const [refusal] = expired;
	assert.equal(refusal?.messageId, "m1");
	assert.equal(refusal?.reasonCode, "recipient_owner_suspended");
	assert.ok(refusal?.error instanceof SubagentRecipientOwnerSuspendedError);
	assert.ok(isSubagentRecipientOwnerSuspendedError(refusal.error));
	assert.equal(refusal.reason, refusal.error.message);
	assert.equal(refusal.error.retryable, true);
	assert.deepEqual(refusal.error.fields, { target: CHILD, childName: CHILD });
	assert.equal(held.heldSendCount, 0);
	assert.equal(held.orphanCount, 1, "the child stays held for its owner");
});

test("after its owner took it back, an expired hold reads as one for a child being woken again (#4639)", () => {
	vi.useFakeTimers();
	const { recipients: held, expired } = recipients();
	reserveReleased(held, "stage-1");
	held.dropOwner("stage-1", HOST);
	held.admit(CHILD, sender("sender"), send("m1"), true);
	held.adoptOrphans("stage-2", HOST);
	reserveReleased(held, "stage-2");
	vi.advanceTimersByTime(RESTORING_RECIPIENT_HOLD_MS);
	assert.equal(expired.length, 1);
	assert.equal(expired[0]?.reasonCode, "recipient_not_restored");
	assert.equal(expired[0]?.error, undefined);
});

test("a client that cannot wait, or a full hold, is refused as its owner being away (#4639)", () => {
	const { recipients: held } = recipients();
	reserveReleased(held, "stage-1");
	held.dropOwner("stage-1", HOST);
	const cannotWait = held.admit(CHILD, sender("sender"), send("m0"), false);
	assert.equal(cannotWait.kind, "refused");
	assert.ok(cannotWait.kind === "refused" && isSubagentRecipientOwnerSuspendedError(cannotWait.error ?? new Error()));
	assert.equal(cannotWait.reason, cannotWait.error?.message);
	assert.equal(cannotWait.reasonCode, undefined);
	for (let index = 0; index < 256; index++)
		assert.equal(held.admit(CHILD, sender("sender"), send(`m${index}`), true).kind, "held");
	const full = held.admit(CHILD, sender("sender"), send("overflow"), true);
	assert.ok(full.kind === "refused" && full.error?.code === "recipient_owner_suspended");
});

test("an owner's restoring holds, gone markers, and reservations of an owner with no host still end with it (#4639)", () => {
	const { recipients: held } = recipients();
	held.reserve("capability-1", "stage-1", "subagent-restoring-1", "default", [], { dormant: false });
	reserveReleased(held, "stage-1", "subagent-gone-1");
	held.release(releasedReservationKey("subagent-gone-1"), "stage-1", "its session file was deleted");
	reserveReleased(held, "stage-1");
	held.admit("subagent-restoring-1", sender("sender"), send("r1", "subagent-restoring-1"), true);
	assert.deepEqual(
		held.dropOwner("stage-1", HOST).map((entry) => entry.messageId),
		["r1"],
	);
	assert.equal(held.size, 1, "only the released child is kept");
	assert.equal(held.orphanCount, 1);

	reserveReleased(held, "plain-owner", "subagent-plain-1");
	held.admit("subagent-plain-1", sender("sender"), send("p1", "subagent-plain-1"), true);
	assert.deepEqual(
		held.dropOwner("plain-owner").map((entry) => entry.messageId),
		["p1"],
	);
	assert.equal(held.orphanCount, 1);
});

test("orphans are bounded: the oldest is forgotten first and its held sends are returned (#4639)", () => {
	const { recipients: held } = recipients(2);
	for (const index of [1, 2, 3]) reserveReleased(held, `stage-${index}`, `subagent-${index}`);
	held.admit("subagent-1", sender("sender"), send("m1", "subagent-1"), true);
	assert.deepEqual(held.dropOwner("stage-1", HOST), []);
	assert.deepEqual(held.dropOwner("stage-2", HOST), []);
	assert.deepEqual(
		held.dropOwner("stage-3", HOST).map((entry) => entry.messageId),
		["m1"],
	);
	assert.equal(held.orphanCount, 2);
	assert.equal(held.releasedOwner("subagent-1"), undefined);
	assert.equal(held.releasedOwner("subagent-3"), "stage-3");
	assert.equal(held.heldSendCount, 0);
});

test("the end of a run forgets the orphans in its invocation and returns their held sends (#4639)", () => {
	const { recipients: held } = recipients();
	reserveReleased(held, "stage-1", "subagent-run-1", "workflow:run/lane");
	reserveReleased(held, "stage-1", "subagent-other-1", "default");
	held.dropOwner("stage-1", HOST);
	held.admit("subagent-run-1", sender("member", ["workflow:run/lane"]), send("m1", "subagent-run-1"), true);
	assert.deepEqual(
		held.dropOrphans((group) => group.startsWith("workflow:run")).map((entry) => entry.messageId),
		["m1"],
	);
	assert.equal(held.orphanCount, 1);
	assert.deepEqual(held.admit("subagent-run-1", sender("member", ["workflow:run/lane"]), send("m2"), true), {
		kind: "none",
	});
	assert.deepEqual(
		held.dropOrphans(() => false),
		[],
	);
	held.clear();
	assert.equal(held.orphanCount, 0);
});

test("a restoring supervisor's reservation of the child takes an orphan's held sends over (#4639)", () => {
	const { recipients: held } = recipients();
	reserveReleased(held, "stage-1");
	held.dropOwner("stage-1", HOST);
	held.admit(CHILD, sender("sender"), send("m1"), true);
	held.reserve("capability-2", "restorer", CHILD, "default", [], { dormant: false });
	assert.equal(held.orphanCount, 0);
	assert.deepEqual(
		held.consume("capability-2").map((entry) => entry.messageId),
		["m1"],
	);
});

test("a wake the departed owner had confirmed can be confirmed again by the session that takes the child over (#4639)", () => {
	const { recipients: held } = recipients();
	reserveReleased(held, "stage-1");
	held.admit(CHILD, sender("sender"), send("m1"), true);
	assert.equal(held.extendHolds(CHILD, "stage-1")?.length, 1);
	held.dropOwner("stage-1", HOST);
	held.adoptOrphans("stage-2", HOST);
	assert.equal(held.extendHolds(CHILD, "stage-2")?.length, 1);
});
