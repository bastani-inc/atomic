import assert from "node:assert/strict";
import type net from "node:net";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { releasedReservationKey } from "../../packages/intercom/broker/released-children.js";
import {
	type HeldSend,
	RESTORING_RECIPIENT_HOLD_MAX_MS,
	RESTORING_RECIPIENT_HOLD_MS,
	type RestoringRecipientSizes,
	RestoringRecipients,
} from "../../packages/intercom/broker/restoring-recipients.js";
import type { SessionInfo } from "../../packages/intercom/types.js";

const CHILD = "subagent-worker-sizes-1";
const RELEASED_KEY = releasedReservationKey(CHILD);
const ID_A = "11111111-2222-3333-4444-555555555555";
const ID_B = "22222222-3333-4444-5555-666666666666";
const CYCLES = 50;
const BASELINE: RestoringRecipientSizes = {
	reservations: 0,
	byTarget: 0,
	byTargetMembers: 0,
	byChild: 0,
	byOwner: 0,
	withHeld: 0,
	heldSends: 0,
	timers: 0,
};

let expired: string[];

beforeEach(() => {
	vi.useFakeTimers();
	expired = [];
});

afterEach(() => {
	vi.useRealTimers();
});

function newRecipients(): RestoringRecipients {
	return new RestoringRecipients((held) => expired.push(held.messageId));
}

function sender(id: string): { id: string; info: SessionInfo } {
	return { id, info: { id, cwd: "/repo", model: "m", pid: 1, startedAt: 1, lastActivity: 1, groups: ["default"] } };
}

function send(messageId: string, senderId: string, to: string): HeldSend {
	return { socket: {} as net.Socket, senderId, messageId, clientMessage: { type: "send", to } };
}

function hold(recipients: RestoringRecipients, messageId: string, senderId = "s1", to = CHILD): void {
	assert.equal(recipients.admit(to, sender(senderId), send(messageId, senderId, to), true).kind, "held");
}

function reserveReleased(recipients: RestoringRecipients, owner = "owner", aliases: readonly string[] = [ID_A]): void {
	recipients.reserve(RELEASED_KEY, owner, CHILD, "default", aliases, {
		dormant: true,
		wake: true,
		replaceAliases: true,
	});
}

function assertBaseline(recipients: RestoringRecipients): void {
	assert.deepEqual(recipients.sizes(), BASELINE);
	assert.equal(vi.getTimerCount(), 0, "no hold timer is left live");
}

describe("restoring-recipient bookkeeping returns to baseline (#4326)", () => {
	test("a released child held, extended and consumed leaves no reservation, index entry, held set or timer (#4326)", () => {
		const recipients = newRecipients();
		reserveReleased(recipients);
		hold(recipients, "m1");
		hold(recipients, "m2", "s2", ID_A);
		assert.equal(recipients.extendHolds(CHILD, "owner")?.length, 2);
		assert.deepEqual(recipients.sizes(), {
			reservations: 1,
			byTarget: 2,
			byTargetMembers: 2,
			byChild: 1,
			byOwner: 1,
			withHeld: 1,
			heldSends: 2,
			timers: 2,
		});
		assert.equal(vi.getTimerCount(), 2);
		const taken = recipients.consume(undefined, {
			childName: CHILD,
			groups: new Set(["default"]),
			authorizedBy: "owner",
		});
		assert.deepEqual(
			taken.map((held) => held.messageId),
			["m1", "m2"],
		);
		assertBaseline(recipients);
		vi.advanceTimersByTime(RESTORING_RECIPIENT_HOLD_MAX_MS);
		assert.deepEqual(expired, []);
	});

	test("senders leaving clear their holds' timers and the reservation's held-set entry (#4326)", () => {
		const recipients = newRecipients();
		reserveReleased(recipients);
		hold(recipients, "m1");
		hold(recipients, "m2");
		recipients.dropSender("s1");
		assert.deepEqual(recipients.sizes(), {
			reservations: 1,
			byTarget: 2,
			byTargetMembers: 2,
			byChild: 1,
			byOwner: 1,
			withHeld: 0,
			heldSends: 0,
			timers: 0,
		});
		assert.equal(vi.getTimerCount(), 0);
		assert.deepEqual(recipients.release(RELEASED_KEY, "owner", undefined), { held: [] });
		assertBaseline(recipients);
	});

	test("a hold that expires, ordinary or extended, leaves no timer and no held-set entry (#4326)", () => {
		const recipients = newRecipients();
		reserveReleased(recipients);
		hold(recipients, "m1");
		vi.advanceTimersByTime(RESTORING_RECIPIENT_HOLD_MS);
		hold(recipients, "m2");
		recipients.extendHolds(CHILD, "owner");
		vi.advanceTimersByTime(RESTORING_RECIPIENT_HOLD_MAX_MS);
		assert.deepEqual(expired, ["m1", "m2"]);
		assert.equal(recipients.sizes().withHeld, 0);
		assert.equal(recipients.sizes().timers, 0);
		assert.deepEqual(recipients.dropOwner("owner"), []);
		assertBaseline(recipients);
	});

	test("a takeover moves held sends and leaves the replaced reservation in no index or held set (#4326)", () => {
		const recipients = newRecipients();
		reserveReleased(recipients, "launcher");
		hold(recipients, "m1");
		recipients.reserve("capability", "supervisor", CHILD, "default", [ID_B]);
		assert.deepEqual(recipients.sizes(), {
			reservations: 1,
			byTarget: 3,
			byTargetMembers: 3,
			byChild: 1,
			byOwner: 1,
			withHeld: 1,
			heldSends: 1,
			timers: 1,
		});
		assert.deepEqual(
			recipients.consume("capability").map((held) => held.messageId),
			["m1"],
		);
		assertBaseline(recipients);
	});

	test("a gone marker keeps only its reservation, and its owner leaving ends that too (#4326)", () => {
		const recipients = newRecipients();
		reserveReleased(recipients);
		hold(recipients, "m1");
		assert.deepEqual(
			recipients.release(RELEASED_KEY, "owner", "crashed")?.held.map((held) => held.messageId),
			["m1"],
		);
		assert.equal(recipients.sizes().withHeld, 0);
		assert.equal(recipients.sizes().timers, 0);
		assert.equal(vi.getTimerCount(), 0);
		recipients.dropOwner("owner");
		assertBaseline(recipients);
	});

	test("replaced aliases leave no empty target index entries (#4326)", () => {
		const recipients = newRecipients();
		reserveReleased(recipients, "owner", [ID_A]);
		reserveReleased(recipients, "owner", [ID_B]);
		assert.equal(recipients.sizes().byTarget, 2);
		assert.equal(recipients.sizes().byTargetMembers, 2);
		recipients.consume(undefined, { childName: CHILD, groups: new Set(["default"]), authorizedBy: "owner" });
		assertBaseline(recipients);
	});

	test("clear cancels every hold timer and empties every index (#4326)", () => {
		const recipients = newRecipients();
		reserveReleased(recipients);
		recipients.reserve("capability", "other-owner", "other-child", "default", []);
		hold(recipients, "m1");
		hold(recipients, "m2", "s1", "other-child");
		recipients.clear();
		assertBaseline(recipients);
	});

	test("repeated reserve, hold, wake, consume and expire cycles keep every size at baseline (#4326)", () => {
		const recipients = newRecipients();
		for (let cycle = 0; cycle < CYCLES; cycle++) {
			reserveReleased(recipients, `owner-${cycle % 3}`, [ID_A]);
			hold(recipients, `consumed-${cycle}`);
			recipients.extendHolds(CHILD, `owner-${cycle % 3}`);
			recipients.consume(undefined, {
				childName: CHILD,
				groups: new Set(["default"]),
				authorizedBy: `owner-${cycle % 3}`,
			});
			reserveReleased(recipients, "parker", [ID_B]);
			hold(recipients, `expired-${cycle}`, "s2", ID_B);
			vi.advanceTimersByTime(RESTORING_RECIPIENT_HOLD_MS);
			recipients.dropOwner("parker");
		}
		assert.equal(expired.length, CYCLES);
		assertBaseline(recipients);
	});
});
