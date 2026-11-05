import assert from "node:assert/strict";
import type net from "node:net";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { releasedReservationKey } from "../../packages/intercom/broker/released-children.js";
import {
	type HeldSend,
	RESTORING_RECIPIENT_HOLD_MAX_MS,
	RESTORING_RECIPIENT_HOLD_MS,
	RestoringRecipients,
} from "../../packages/intercom/broker/restoring-recipients.js";
import type { DeliveryFailureReasonCode, SessionInfo } from "../../packages/intercom/types.js";

const CHILD = "worker-one";
const RELEASED_KEY = releasedReservationKey(CHILD);
const ID_A = "11111111-2222-3333-4444-555555555555";
const ID_B = "22222222-3333-4444-5555-666666666666";

interface Expiry {
	readonly messageId: string;
	readonly reasonCode: DeliveryFailureReasonCode;
}

let expired: Expiry[];

function newRecipients(): RestoringRecipients {
	return new RestoringRecipients((held, _reason, reasonCode) =>
		expired.push({ messageId: held.messageId, reasonCode }),
	);
}

function sender(id: string, groups: string[] = ["default"]): { id: string; info: SessionInfo } {
	return { id, info: { id, cwd: "/repo", model: "m", pid: 1, startedAt: 1, lastActivity: 1, groups } };
}

function send(messageId: string, senderId: string, to = CHILD): HeldSend {
	return { socket: {} as net.Socket, senderId, messageId, clientMessage: { type: "send", to } };
}

function hold(recipients: RestoringRecipients, messageId: string, senderId = "s1", to = CHILD, groups?: string[]) {
	return recipients.admit(to, sender(senderId, groups), send(messageId, senderId, to), true);
}

function ids(held: readonly HeldSend[]): string[] {
	return held.map((entry) => entry.messageId);
}

beforeEach(() => {
	vi.useFakeTimers();
	expired = [];
});

afterEach(() => {
	vi.useRealTimers();
});

describe("reservation ownership and takeover", () => {
	test("a reservation key made again by another owner replaces the first owner's and keeps its held sends in order (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve("cap", "o1", CHILD, "default", []);
		hold(recipients, "m1");
		hold(recipients, "m2");
		recipients.reserve("cap", "o2", CHILD, "default", []);
		assert.equal(recipients.size, 1);
		assert.equal(recipients.heldSendCount, 2);
		assert.deepEqual(
			recipients.active().map((reservation) => reservation.ownerSessionId),
			["o2"],
		);
		assert.deepEqual(recipients.dropOwner("o1"), []);
		assert.equal(recipients.size, 1);
		assert.deepEqual(ids(recipients.consume("cap")), ["m1", "m2"]);
		assert.equal(recipients.size, 0);
	});

	test("the same owner reserving the child under a new key merges targets and held sends into one reservation (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve("cap-1", "o1", CHILD, "default", [ID_A]);
		hold(recipients, "m1", "s1", ID_A);
		recipients.reserve("cap-2", "o1", CHILD, "default", []);
		assert.equal(recipients.size, 1);
		const [only] = recipients.active();
		assert.equal(only?.capability, "cap-2");
		assert.deepEqual(only?.aliases, [ID_A]);
		assert.equal(recipients.admit(ID_A, sender("s2"), send("m2", "s2", ID_A), true).kind, "held");
		assert.equal(recipients.heldSendCount, 2);
		recipients.dropSender("s1");
		assert.equal(recipients.heldSendCount, 1);
		recipients.dropSender("s2");
		assert.equal(recipients.heldSendCount, 0);
		assert.deepEqual(recipients.consume("cap-2"), []);
	});

	test("held sends moved to a taking-over reservation are dropped once with their sender (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve("cap-1", "o1", CHILD, "default", []);
		hold(recipients, "m1");
		recipients.reserve("cap-2", "o1", CHILD, "default", []);
		recipients.dropSender("s1");
		assert.equal(recipients.heldSendCount, 0);
		vi.advanceTimersByTime(RESTORING_RECIPIENT_HOLD_MS * 2);
		assert.deepEqual(expired, []);
	});

	test("reservations of the same child by different owners and groups coexist and stay independently addressable (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve("cap-1", "o1", CHILD, "g1", []);
		recipients.reserve("cap-2", "o2", CHILD, "g2", []);
		assert.equal(recipients.size, 2);
		assert.deepEqual(recipients.release("cap-1", "o1", undefined), { held: [] });
		assert.equal(recipients.size, 1);
		assert.equal(hold(recipients, "m1", "s1", CHILD, ["g2"]).kind, "held");
		assert.deepEqual(hold(recipients, "m2", "s9", CHILD, ["g1"]), { kind: "none" });
	});

	test("a dormant reservation of the same group is taken over with its held sends, another group's is not (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve("dormant", "launcher", CHILD, "lane", [], { dormant: true });
		hold(recipients, "m1", "s1", CHILD, ["lane"]);
		recipients.reserve("cap", "supervisor", CHILD, "lane", []);
		assert.equal(recipients.size, 1);
		assert.deepEqual(ids(recipients.consume("cap")), ["m1"]);

		const other = newRecipients();
		other.reserve("dormant", "launcher", CHILD, "lane", [], { dormant: true });
		other.reserve("cap", "supervisor", CHILD, "elsewhere", []);
		assert.equal(other.size, 2);
	});

	test("a reservation created by takeover starts a wake that was already confirmed as confirmed (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve(RELEASED_KEY, "o1", CHILD, "default", [], { wake: true });
		hold(recipients, "m1");
		assert.equal(recipients.extendHolds(CHILD, "o1")?.length, 1);
		assert.equal(recipients.reserve(RELEASED_KEY, "o2", CHILD, "default", [], { wake: false }), undefined);
		assert.deepEqual(recipients.extendHolds(CHILD, "o2"), []);
	});

	test("a reservation created by takeover keeps an unconfirmed wake extendable (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve(RELEASED_KEY, "o1", CHILD, "default", [], { wake: true });
		hold(recipients, "m1");
		recipients.reserve(RELEASED_KEY, "o2", CHILD, "default", [], { wake: false });
		const extended = recipients.extendHolds(CHILD, "o2");
		assert.equal(extended?.length, 1);
		assert.equal(extended?.[0]?.held.messageId, "m1");
	});
});

describe("reservation targets", () => {
	test("replacing aliases drops the old ones but keeps the child's own name (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve("cap", "o1", CHILD, "default", [ID_A]);
		recipients.reserve("cap", "o1", CHILD, "default", [ID_B], { replaceAliases: true });
		assert.deepEqual(recipients.active()[0]?.aliases, [ID_B]);
		assert.deepEqual(hold(recipients, "m1", "s1", ID_A), { kind: "none" });
		assert.equal(hold(recipients, "m2", "s1", ID_B).kind, "held");
		assert.equal(hold(recipients, "m3", "s1", CHILD).kind, "held");
	});

	test("aliases accumulate across reservations unless replacement is asked for (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve("cap", "o1", CHILD, "default", [ID_A]);
		recipients.reserve("cap", "o1", CHILD, "default", [ID_B]);
		assert.deepEqual(recipients.active()[0]?.aliases, [ID_A, ID_B]);
	});

	test("replacing aliases on a reservation made by takeover keeps the targets carried over (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve("cap-1", "o1", CHILD, "default", [ID_A]);
		recipients.reserve("cap-2", "o1", CHILD, "default", [ID_B], { replaceAliases: true });
		assert.deepEqual(recipients.active()[0]?.aliases, [ID_A, ID_B]);
	});

	test("blank aliases are ignored and at most eight targets are reserved (#4326)", () => {
		const recipients = newRecipients();
		const many = Array.from({ length: 10 }, (_, index) => `alias-${index}`);
		recipients.reserve("cap", "o1", CHILD, "default", ["   ", "", ...many]);
		assert.deepEqual(
			recipients.active()[0]?.aliases,
			many.slice(0, 7),
			"the name plus seven aliases fill the eight targets",
		);
		assert.deepEqual(hold(recipients, "m1", "s1", "alias-7"), { kind: "none" });
		assert.equal(hold(recipients, "m2", "s1", "alias-6").kind, "held");
	});

	test("consuming a reservation forgets its targets so a later reservation of the child starts clean (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve("cap-1", "o1", CHILD, "default", [ID_A]);
		recipients.consume("cap-1");
		recipients.reserve("cap-2", "o1", CHILD, "default", []);
		assert.deepEqual(recipients.active()[0]?.aliases, []);
	});

	test("releasing one of two reservations sharing a target leaves the other admitting sends (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve("cap-1", "o1", CHILD, "g1", [ID_A]);
		recipients.reserve("cap-2", "o2", CHILD, "g2", [ID_A]);
		recipients.release("cap-1", "o1", undefined);
		assert.equal(hold(recipients, "m1", "s1", ID_A, ["g2"]).kind, "held");
	});
});

describe("wake requests and hold extension", () => {
	test("reserving without a waiting held send, or without wake, asks for no wake (#4326)", () => {
		const recipients = newRecipients();
		assert.equal(recipients.reserve(RELEASED_KEY, "o1", CHILD, "default", [], { wake: true }), undefined);
		const plain = newRecipients();
		plain.reserve(RELEASED_KEY, "o1", CHILD, "default", [], { wake: false });
		hold(plain, "m1");
		assert.equal(plain.reserve(RELEASED_KEY, "o1", CHILD, "default", [], { wake: false }), undefined);
	});

	test("making a reservation wakeable asks the owner to wake it and resets a confirmed wake (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve(RELEASED_KEY, "o1", CHILD, "default", [], { wake: false });
		hold(recipients, "m1");
		assert.deepEqual(recipients.reserve(RELEASED_KEY, "o1", CHILD, "default", [], { wake: true }), {
			ownerSessionId: "o1",
			childName: CHILD,
		});
		assert.equal(recipients.extendHolds(CHILD, "o1")?.length, 1);
		assert.equal(recipients.reserve(RELEASED_KEY, "o1", CHILD, "default", [], { wake: true }), undefined);
	});

	test("a capability reservation's wake names the capability (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve("cap", "o1", CHILD, "default", [], { wake: true });
		assert.deepEqual(hold(recipients, "m1"), {
			kind: "held",
			timeoutMs: RESTORING_RECIPIENT_HOLD_MS,
			wake: { ownerSessionId: "o1", childName: CHILD, capability: "cap" },
		});
		assert.deepEqual(hold(recipients, "m2"), { kind: "held", timeoutMs: RESTORING_RECIPIENT_HOLD_MS });
	});

	test("an extended hold survives the ordinary timeout and expires at the maximum counted from admission (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve(RELEASED_KEY, "o1", CHILD, "default", [], { wake: true });
		hold(recipients, "m1");
		vi.advanceTimersByTime(5_000);
		assert.deepEqual(
			recipients.extendHolds(CHILD, "o1")?.map((entry) => entry.timeoutMs),
			[RESTORING_RECIPIENT_HOLD_MAX_MS - 5_000],
		);
		vi.advanceTimersByTime(RESTORING_RECIPIENT_HOLD_MS * 2);
		assert.deepEqual(expired, []);
		vi.advanceTimersByTime(RESTORING_RECIPIENT_HOLD_MAX_MS);
		assert.deepEqual(expired, [{ messageId: "m1", reasonCode: "recipient_not_restored" }]);
		assert.equal(recipients.heldSendCount, 0);
	});

	test("a wake is confirmed once per wave of held sends, and a new send after confirmation does not reset it (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve(RELEASED_KEY, "o1", CHILD, "default", [], { wake: true });
		hold(recipients, "m1");
		assert.equal(recipients.extendHolds(CHILD, "o1")?.length, 1);
		assert.deepEqual(recipients.extendHolds(CHILD, "o1"), []);
		hold(recipients, "m2");
		assert.deepEqual(recipients.extendHolds(CHILD, "o1"), []);
	});

	test("a confirmed wake stays confirmed while other held sends remain after one leaves (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve(RELEASED_KEY, "o1", CHILD, "default", [], { wake: true });
		hold(recipients, "m1", "s1");
		hold(recipients, "m2", "s2");
		recipients.extendHolds(CHILD, "o1");
		recipients.dropSender("s1");
		assert.deepEqual(recipients.extendHolds(CHILD, "o1"), []);
		recipients.dropSender("s2");
		hold(recipients, "m3", "s3");
		assert.equal(recipients.extendHolds(CHILD, "o1")?.length, 1);
	});

	test("extending holds is refused for a stranger and empty when nothing is held (#4326)", () => {
		const recipients = newRecipients();
		assert.equal(recipients.extendHolds(CHILD, "o1"), undefined);
		recipients.reserve(RELEASED_KEY, "o1", CHILD, "default", [], { wake: true });
		assert.equal(recipients.extendHolds(CHILD, "other"), undefined);
		assert.deepEqual(recipients.extendHolds(CHILD, "o1"), []);
		hold(recipients, "m1");
		assert.equal(recipients.extendHolds(CHILD, "o1")?.length, 1);
	});
});

describe("hold capacity", () => {
	test("at most 256 sends are held per reservation and the next is refused with the not-restored code (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve("cap", "o1", CHILD, "default", []);
		for (let index = 0; index < 256; index += 1) {
			assert.equal(hold(recipients, `m${index}`).kind, "held");
		}
		const refused = hold(recipients, "overflow");
		assert.equal(refused.kind, "refused");
		assert.equal(refused.kind === "refused" ? refused.reasonCode : undefined, "recipient_not_restored");
		assert.equal(recipients.heldSendCount, 256);
	});

	test("a parked released child refuses sends that cannot wait with the parked code (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve(RELEASED_KEY, "o1", CHILD, "default", [], { wake: false });
		const refused = recipients.admit(CHILD, sender("s1"), send("m1", "s1"), false);
		assert.equal(refused.kind === "refused" ? refused.reasonCode : undefined, "recipient_parked");
	});
});

describe("ending holds", () => {
	test("consume takes a dormant reservation of the registering child and group but leaves ordinary ones (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve("dormant", "launcher", CHILD, "lane", [], { dormant: true });
		hold(recipients, "m1", "s1", CHILD, ["lane"]);
		recipients.reserve("ordinary", "other-owner", CHILD, "other", []);
		const registered = { childName: "Worker-One", groups: new Set(["lane", "other"]) };
		assert.deepEqual(ids(recipients.consume("unrelated", registered)), ["m1"]);
		assert.equal(recipients.size, 1);
		assert.deepEqual(
			recipients.active().map((reservation) => reservation.capability),
			["ordinary"],
		);
	});

	test("consume leaves a dormant reservation of another group and a gone released one (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve("dormant", "launcher", CHILD, "lane", [], { dormant: true });
		recipients.reserve(RELEASED_KEY, "o2", CHILD, "lane", []);
		recipients.release(RELEASED_KEY, "o2", "did not survive");
		assert.deepEqual(recipients.consume("unrelated", { childName: CHILD, groups: new Set(["other"]) }), []);
		assert.deepEqual(recipients.consume("unrelated", { childName: CHILD, groups: new Set(["lane"]) }), []);
		assert.equal(recipients.size, 1);
		assert.equal(recipients.active()[0]?.capability, RELEASED_KEY);
	});

	test("consume ends a released child's reservation when the child registers (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve(RELEASED_KEY, "o1", CHILD, "lane", []);
		hold(recipients, "m1", "s1", CHILD, ["lane"]);
		assert.deepEqual(ids(recipients.consume(undefined, { childName: CHILD, groups: new Set(["lane"]) })), ["m1"]);
		assert.equal(recipients.size, 0);
	});

	test("a gone reservation named by capability is not consumed (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve("cap", "o1", CHILD, "default", []);
		recipients.release("cap", "o1", "crashed");
		assert.deepEqual(recipients.consume("cap"), []);
		assert.equal(recipients.size, 1);
	});

	test("dropping an owner returns its held sends in order and ends only its reservations (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve("cap-1", "o1", "child-a", "default", []);
		recipients.reserve("cap-2", "o1", "child-b", "default", []);
		recipients.reserve("cap-3", "o2", "child-c", "default", []);
		hold(recipients, "a1", "s1", "child-a");
		hold(recipients, "b1", "s1", "child-b");
		hold(recipients, "a2", "s2", "child-a");
		hold(recipients, "c1", "s1", "child-c");
		assert.deepEqual(ids(recipients.dropOwner("o1")), ["a1", "a2", "b1"]);
		assert.equal(recipients.size, 1);
		assert.equal(recipients.heldSendCount, 1);
		assert.deepEqual(hold(recipients, "a3", "s1", "child-a"), { kind: "none" });
		assert.deepEqual(recipients.dropOwner("o1"), []);
	});

	test("dropping a sender cancels only its held sends and their timers (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve("cap-1", "o1", "child-a", "default", []);
		recipients.reserve("cap-2", "o1", "child-b", "default", []);
		hold(recipients, "a1", "s1", "child-a");
		hold(recipients, "a2", "s2", "child-a");
		hold(recipients, "b1", "s1", "child-b");
		recipients.dropSender("s1");
		assert.equal(recipients.heldSendCount, 1);
		vi.advanceTimersByTime(RESTORING_RECIPIENT_HOLD_MS);
		assert.deepEqual(expired, [{ messageId: "a2", reasonCode: "recipient_not_restored" }]);
		assert.deepEqual(recipients.consume("cap-1"), []);
		assert.deepEqual(recipients.consume("cap-2"), []);
	});

	test("clear ends every reservation, cancels holds and forgets all indexes (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve("cap", "o1", CHILD, "default", [ID_A]);
		hold(recipients, "m1");
		recipients.clear();
		assert.equal(recipients.size, 0);
		assert.equal(recipients.heldSendCount, 0);
		assert.deepEqual(recipients.active(), []);
		assert.deepEqual(hold(recipients, "m2", "s1", ID_A), { kind: "none" });
		assert.deepEqual(hold(recipients, "m3"), { kind: "none" });
		assert.equal(recipients.heldSendCount, 0);
		recipients.reserve("cap-2", "o1", CHILD, "default", []);
		assert.deepEqual(recipients.active()[0]?.aliases, []);
		vi.advanceTimersByTime(RESTORING_RECIPIENT_HOLD_MS * 2);
		assert.deepEqual(expired, []);
	});

	test("active reports each reservation with its aliases, flags and gone marker (#4326)", () => {
		const recipients = newRecipients();
		recipients.reserve("cap-1", "o1", "Child-A", "lane", [ID_A], { dormant: true, wake: true });
		recipients.reserve("cap-2", "o2", "child-b", "default", []);
		recipients.release("cap-2", "o2", "crashed");
		assert.deepEqual(recipients.active(), [
			{
				capability: "cap-1",
				ownerSessionId: "o1",
				childName: "Child-A",
				group: "lane",
				aliases: [ID_A],
				dormant: true,
				wake: true,
			},
			{
				capability: "cap-2",
				ownerSessionId: "o2",
				childName: "child-b",
				group: "default",
				aliases: [],
				dormant: false,
				wake: false,
				gone: "Subagent `child-b` did not survive the restart and is gone: crashed. The message was not sent; launch a fresh subagent if its work is still needed.",
			},
		]);
	});
});
