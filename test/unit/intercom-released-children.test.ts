import assert from "node:assert/strict";
import type net from "node:net";
import { afterEach, test, vi } from "vitest";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import {
	isReleasedChildError,
	ReleasedChildReservationError,
	UnknownReleasedChildError,
} from "../../packages/intercom/broker/released-child-errors.js";
import {
	RELEASED_CHILD_FRAME_MAX,
	releasedReservationKey,
	validateReleasedChildFrame,
} from "../../packages/intercom/broker/released-children.js";
import {
	type HeldSend,
	RESTORING_RECIPIENT_HOLD_MAX_MS,
	RESTORING_RECIPIENT_HOLD_MS,
	RestoringRecipients,
} from "../../packages/intercom/broker/restoring-recipients.js";
import type {
	DeliveryFailureReasonCode,
	ReleasedChildRefusalCode,
	SessionInfo,
} from "../../packages/intercom/types.js";

afterEach(() => {
	vi.useRealTimers();
});

const CHILD = "subagent-worker-run1-1";
const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_SESSION_ID = "66666666-7777-4888-9999-000000000000";

interface Expiry {
	readonly messageId: string;
	readonly reasonCode: DeliveryFailureReasonCode;
}

function sender(id: string, groups: string[] = ["default"]): { id: string; info: SessionInfo } {
	return { id, info: { id, cwd: "/repo", model: "m", pid: 1, startedAt: 1, lastActivity: 1, groups } };
}

function send(messageId: string, senderId: string, to = CHILD): HeldSend {
	return { socket: {} as net.Socket, senderId, messageId, clientMessage: { type: "send", to } };
}

function recipientsRecordingExpiry(): { recipients: RestoringRecipients; expired: Expiry[] } {
	const expired: Expiry[] = [];
	const recipients = new RestoringRecipients((held, _reason, reasonCode) =>
		expired.push({ messageId: held.messageId, reasonCode }),
	);
	return { recipients, expired };
}

function reserveReleased(recipients: RestoringRecipients, owner: string, childName: string, wake: boolean): void {
	recipients.reserve(releasedReservationKey(childName), owner, childName, "default", [], {
		dormant: true,
		wake,
		replaceAliases: true,
	});
}

function refusalCodeOf(children: unknown): { code: ReleasedChildRefusalCode; childName?: string } | undefined {
	const validation = validateReleasedChildFrame(children as Parameters<typeof validateReleasedChildFrame>[0]);
	return validation.ok ? undefined : validation.refusal;
}

test("a released-child frame is validated as a whole, naming the first invalid child and why (#4326)", () => {
	const valid = { childName: ` ${CHILD} `, group: "lane", aliases: [SESSION_ID], wake: true };
	const accepted = validateReleasedChildFrame([valid, { childName: "other", wake: false }]);
	assert.deepEqual(accepted.ok && accepted.children, [
		{ childName: CHILD, group: "lane", aliases: [SESSION_ID], wake: true },
		{ childName: "other", aliases: [], wake: false },
	]);

	assert.deepEqual(refusalCodeOf([valid, { childName: "   ", wake: true }]), {
		code: "invalid_child_name",
		childName: "   ",
	});
	assert.deepEqual(refusalCodeOf([{ childName: "*", wake: true }]), { code: "invalid_child_name", childName: "*" });
	assert.deepEqual(refusalCodeOf([{ childName: "a", aliases: ["not-a-session-id"], wake: true }]), {
		code: "invalid_alias",
		childName: "a",
	});
	assert.deepEqual(refusalCodeOf([{ childName: "a", aliases: [1], wake: true }]), {
		code: "invalid_alias",
		childName: "a",
	});
	assert.deepEqual(
		refusalCodeOf([{ childName: "a", aliases: Array.from({ length: 5 }, () => SESSION_ID), wake: true }]),
		{ code: "too_many_aliases", childName: "a" },
	);
	assert.deepEqual(refusalCodeOf([{ childName: "a", group: 3, wake: true }]), {
		code: "invalid_group",
		childName: "a",
	});
	assert.deepEqual(refusalCodeOf([{ childName: "a" }]), { code: "invalid_frame", childName: "a" });
	assert.deepEqual(refusalCodeOf([]), { code: "invalid_frame" });
	assert.deepEqual(refusalCodeOf("children"), { code: "invalid_frame" });
	assert.deepEqual(
		refusalCodeOf(
			Array.from({ length: RELEASED_CHILD_FRAME_MAX + 1 }, (_, index) => ({ childName: `c${index}`, wake: true })),
		),
		{ code: "invalid_frame" },
	);
});

test("reserveReleasedChildren refuses an invalid child before any frame is sent, with a typed error naming it (#4326)", async () => {
	const client = new IntercomClient();
	const children = [
		{ childName: "fine", wake: true },
		{ childName: CHILD, aliases: ["a-name-not-an-id"], wake: false },
	];
	const error = await client.reserveReleasedChildren(children).then(
		() => undefined,
		(rejection: Error) => rejection,
	);
	assert.ok(error instanceof ReleasedChildReservationError);
	assert.ok(isReleasedChildError(error));
	assert.equal(error.name, "ReleasedChildReservationError");
	assert.equal(error.code, "invalid_alias");
	assert.equal(error.childName, CHILD);
	assert.equal(error.retryable, false);
	assert.match(error.hint, /session ids/);
	assert.match(error.message, /\(invalid_alias\)/);
	const structural = Object.assign(new Error("x"), {
		name: "UnknownReleasedChildError",
		code: "unknown_released_child",
	});
	assert.ok(isReleasedChildError(structural));
	assert.ok(new UnknownReleasedChildError({ code: "unknown_released_child", childName: CHILD }) instanceof Error);
});

test("a released reservation is keyed by its normalized child name and reserving it again replaces its aliases, group and wake flag, keeping held sends (#4326)", () => {
	const { recipients } = recipientsRecordingExpiry();
	recipients.reserve(releasedReservationKey(CHILD), "owner", CHILD, "default", [SESSION_ID], {
		dormant: true,
		wake: true,
		replaceAliases: true,
	});
	assert.equal(releasedReservationKey(` ${CHILD.toUpperCase()} `), releasedReservationKey(CHILD));
	assert.equal(recipients.admit(SESSION_ID, sender("peer"), send("held-1", "peer", SESSION_ID), true).kind, "held");

	assert.equal(
		recipients.reserve(releasedReservationKey(CHILD), "owner", CHILD, "lane", [OTHER_SESSION_ID], {
			dormant: true,
			wake: false,
			replaceAliases: true,
		}),
		undefined,
	);
	assert.equal(recipients.size, 1);
	assert.equal(recipients.heldSendCount, 1);
	assert.deepEqual(
		recipients.admit(SESSION_ID, sender("peer", ["lane"]), send("late", "peer", SESSION_ID), true),
		{ kind: "none" },
		"the replaced alias is no longer a target",
	);
	assert.deepEqual(
		recipients.admit(OTHER_SESSION_ID, sender("peer"), send("outside", "peer", OTHER_SESSION_ID), true),
		{ kind: "none" },
		"the new group excludes the old sender",
	);
	assert.equal(
		recipients.admit(OTHER_SESSION_ID, sender("peer", ["lane"]), send("held-2", "peer", OTHER_SESSION_ID), true).kind,
		"held",
	);
	assert.deepEqual(
		recipients.consume(undefined, { childName: CHILD, groups: new Set(["lane"]) }).map((held) => held.messageId),
		["held-1", "held-2"],
	);
	assert.equal(recipients.size, 0);
	assert.equal(recipients.heldSendCount, 0);
});

test("a parked released child holds sends without asking its owner, and tells expired senders it is parked (#4326)", () => {
	vi.useFakeTimers();
	const { recipients, expired } = recipientsRecordingExpiry();
	reserveReleased(recipients, "owner", CHILD, false);
	assert.deepEqual(recipients.admit(CHILD, sender("peer"), send("held-1", "peer"), true), {
		kind: "held",
		timeoutMs: RESTORING_RECIPIENT_HOLD_MS,
	});
	assert.equal(recipients.heldSendCount, 1);
	vi.advanceTimersByTime(RESTORING_RECIPIENT_HOLD_MS);
	assert.deepEqual(expired, [{ messageId: "held-1", reasonCode: "recipient_parked" }]);
	assert.equal(recipients.heldSendCount, 0);
	const refused = recipients.admit(CHILD, sender("peer"), send("legacy", "peer"), false);
	assert.deepEqual(refused.kind === "refused" && refused.reasonCode, "recipient_parked");
});

test("a woken released child's expired senders are told it was not restored, and a restoring supervisor's reservation keeps that code (#4326)", () => {
	vi.useFakeTimers();
	const { recipients, expired } = recipientsRecordingExpiry();
	reserveReleased(recipients, "owner", CHILD, true);
	recipients.admit(CHILD, sender("peer"), send("held-1", "peer"), true);
	vi.advanceTimersByTime(RESTORING_RECIPIENT_HOLD_MS);
	recipients.reserve("capability", "supervisor", "restoring", "default", [], {});
	recipients.admit("restoring", sender("peer"), send("held-2", "peer", "restoring"), true);
	vi.advanceTimersByTime(RESTORING_RECIPIENT_HOLD_MS);
	assert.deepEqual(expired, [
		{ messageId: "held-1", reasonCode: "recipient_not_restored" },
		{ messageId: "held-2", reasonCode: "recipient_not_restored" },
	]);
});

test("flipping a parked reservation to wake with sends held asks the owner once (#4326)", () => {
	const { recipients } = recipientsRecordingExpiry();
	reserveReleased(recipients, "owner", CHILD, false);
	recipients.admit(CHILD, sender("peer"), send("held-1", "peer"), true);
	const options = { dormant: true, wake: true, replaceAliases: true } as const;
	assert.deepEqual(recipients.reserve(releasedReservationKey(CHILD), "owner", CHILD, "default", [], options), {
		ownerSessionId: "owner",
		childName: CHILD,
	});
	assert.equal(recipients.reserve(releasedReservationKey(CHILD), "owner", CHILD, "default", [], options), undefined);
});

test("the owner's wake acknowledgement extends every held send once, up to 120 seconds from its admission (#4326)", () => {
	vi.useFakeTimers();
	const { recipients, expired } = recipientsRecordingExpiry();
	reserveReleased(recipients, "owner", CHILD, true);
	recipients.admit(CHILD, sender("peer"), send("held-1", "peer"), true);
	vi.advanceTimersByTime(5_000);
	recipients.admit(CHILD, sender("peer"), send("held-2", "peer"), true);
	vi.advanceTimersByTime(5_000);

	assert.equal(recipients.extendHolds(CHILD, "intruder"), undefined);
	assert.equal(recipients.extendHolds("unknown-child", "owner"), undefined);
	const extended = recipients.extendHolds(CHILD.toUpperCase(), "owner");
	assert.deepEqual(
		extended?.map(({ held, timeoutMs }) => [held.messageId, timeoutMs]),
		[
			["held-1", RESTORING_RECIPIENT_HOLD_MAX_MS - 10_000],
			["held-2", RESTORING_RECIPIENT_HOLD_MAX_MS - 5_000],
		],
	);
	assert.deepEqual(
		recipients.extendHolds(CHILD, "owner"),
		[],
		"a second acknowledgement of the same wake changes nothing",
	);

	vi.advanceTimersByTime(RESTORING_RECIPIENT_HOLD_MS * 2);
	assert.deepEqual(expired, []);
	vi.advanceTimersByTime(RESTORING_RECIPIENT_HOLD_MAX_MS - 10_000 - RESTORING_RECIPIENT_HOLD_MS * 2 - 1);
	assert.deepEqual(expired, []);
	vi.advanceTimersByTime(1);
	assert.deepEqual(expired, [{ messageId: "held-1", reasonCode: "recipient_not_restored" }]);
	vi.advanceTimersByTime(5_000);
	assert.deepEqual(
		Array.from(expired, (entry: Expiry) => entry.messageId),
		["held-1", "held-2"],
	);

	recipients.admit(CHILD, sender("peer"), send("held-3", "peer"), true);
	assert.equal(recipients.extendHolds(CHILD, "owner")?.length, 1, "the next hold can be extended again");
});

test("an acknowledgement with nothing held does not use up the extension of the next hold (#4326)", () => {
	vi.useFakeTimers();
	const { recipients } = recipientsRecordingExpiry();
	reserveReleased(recipients, "owner", CHILD, true);
	assert.deepEqual(recipients.extendHolds(CHILD, "owner"), []);
	recipients.admit(CHILD, sender("peer"), send("held-1", "peer"), true);
	assert.equal(recipients.extendHolds(CHILD, "owner")?.length, 1);
});

test("dropping a released child's owner returns its held sends and clears every index (#4326)", () => {
	const { recipients } = recipientsRecordingExpiry();
	reserveReleased(recipients, "owner", CHILD, true);
	reserveReleased(recipients, "owner", "other-child", true);
	reserveReleased(recipients, "someone-else", "third-child", true);
	recipients.admit(CHILD, sender("peer"), send("held-1", "peer"), true);
	assert.equal(recipients.size, 3);
	assert.deepEqual(
		recipients.dropOwner("owner").map((held) => held.messageId),
		["held-1"],
	);
	assert.equal(recipients.size, 1);
	assert.equal(recipients.heldSendCount, 0);
	assert.deepEqual(recipients.admit(CHILD, sender("peer"), send("later", "peer"), true), { kind: "none" });
});

test("a restoring supervisor's reservation of a released child takes it over with its held sends, once and in order (#4326)", () => {
	const { recipients } = recipientsRecordingExpiry();
	reserveReleased(recipients, "launcher", CHILD, true);
	recipients.admit(CHILD, sender("peer"), send("held-1", "peer"), true);
	recipients.reserve("stage-capability", "stage-session", CHILD, "default", []);
	recipients.admit(CHILD, sender("peer"), send("held-2", "peer"), true);
	assert.equal(recipients.size, 1);
	assert.equal(recipients.release(releasedReservationKey(CHILD), "launcher", undefined), undefined);
	assert.deepEqual(
		recipients.consume("stage-capability").map((held) => held.messageId),
		["held-1", "held-2"],
	);
});

test("a child registering without a supervisor capability ends its released reservation but not a dormant supervisor one (#4326)", () => {
	const { recipients } = recipientsRecordingExpiry();
	reserveReleased(recipients, "owner", CHILD, true);
	recipients.reserve("dormant-capability", "launcher", "dormant-child", "default", [], { dormant: true });
	recipients.admit(CHILD, sender("peer"), send("held-1", "peer"), true);
	recipients.admit("dormant-child", sender("peer"), send("held-2", "peer", "dormant-child"), true);
	const groups = new Set(["default"]);
	assert.deepEqual(recipients.consume(undefined, { childName: "dormant-child", groups }), []);
	assert.equal(recipients.size, 2);
	assert.deepEqual(
		recipients.consume(undefined, { childName: CHILD.toUpperCase(), groups: new Set(["elsewhere"]) }),
		[],
		"a registration outside the reservation's group does not end it",
	);
	assert.deepEqual(
		recipients.consume(undefined, { childName: CHILD, groups }).map((held) => held.messageId),
		["held-1"],
	);
	assert.equal(recipients.size, 1);
});

test("admitting a send does not walk the reservations, whatever their number (#4326)", () => {
	const { recipients } = recipientsRecordingExpiry();
	const RESERVATIONS = 10_000;
	for (let index = 0; index < RESERVATIONS; index++) {
		recipients.reserve(
			releasedReservationKey(`child-${index}`),
			`owner-${index % 10}`,
			`child-${index}`,
			"default",
			[],
			{
				dormant: true,
				wake: true,
			},
		);
	}
	assert.equal(recipients.size, RESERVATIONS);

	let steps = 0;
	const restores: Array<() => void> = [];
	const count = (prototype: object, method: string): void => {
		const original = Reflect.get(prototype, method) as (
			this: object,
			...args: object[]
		) => Iterator<object> | undefined;
		Reflect.set(prototype, method, function counted(this: object, ...args: object[]) {
			const result = original.apply(this, args);
			if (result === undefined || typeof result.next !== "function") return result;
			const next = result.next.bind(result);
			result.next = () => {
				steps += 1;
				return next();
			};
			return result;
		});
		restores.push(() => Reflect.set(prototype, method, original));
	};
	for (const prototype of [Map.prototype, Set.prototype]) {
		for (const method of ["entries", "values", "keys"]) count(prototype, method);
	}
	Reflect.set(Map.prototype, Symbol.iterator, Map.prototype.entries);
	Reflect.set(Set.prototype, Symbol.iterator, Set.prototype.values);
	try {
		const admission = recipients.admit("child-9999", sender("peer"), send("held-1", "peer", "child-9999"), true);
		assert.equal(admission.kind, "held");
		assert.deepEqual(recipients.admit("nobody", sender("peer"), send("none", "peer", "nobody"), true), {
			kind: "none",
		});
	} finally {
		for (const restore of restores) restore();
		Reflect.set(Map.prototype, Symbol.iterator, Map.prototype.entries);
		Reflect.set(Set.prototype, Symbol.iterator, Set.prototype.values);
	}
	assert.ok(steps <= 4, `admit stepped ${steps} times over ${RESERVATIONS} reservations`);
});
