import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { isDeliveryFailureReasonCode } from "../../packages/intercom/broker/delivery-failure-reason.js";
import {
	IntercomReleasedChildError,
	isIntercomReleasedChildError,
	isReleasedChildErrorCode,
	isReleasedChildReservationError,
	isUnknownReleasedChildError,
	RELEASED_CHILD_ERROR_CODES,
	ReleasedChildReservationError,
	rehydrateIntercomReleasedChildError,
	releasedChildErrorFor,
	type SerializedIntercomReleasedChildError,
	serializeIntercomReleasedChildError,
	UnknownReleasedChildError,
} from "../../packages/intercom/broker/released-child-errors.js";
import type { ReleasedChildRefusalCode } from "../../packages/intercom/types.js";

const HINTS: Readonly<Record<ReleasedChildRefusalCode, string>> = {
	invalid_frame: "Send between 1 and 500 children per frame, each with a child name and a boolean wake flag.",
	invalid_child_name: "Use the child's exact, non-empty name; the wildcard `*` names no child.",
	invalid_alias: "Reserve extra targets only as session ids, never as names.",
	too_many_aliases: "Reserve at most 4 extra session ids per child.",
	invalid_group: "Give the group as a string, or omit it to use the owner's registration group.",
	unknown_released_child:
		"Reserve the child with reserveReleasedChildren on this connection before acknowledging its wake or dropping it.",
	not_owner:
		"Only the session that owns this child can reserve, drop or acknowledge it: the one that reserved it first, or that authorized it as its supervisor. Reconnect as that session, or launch a new child.",
	group_not_allowed:
		"Reserve a child in a workflow group only from a session that is a member of that group, or omit the group to use the owner's registration group.",
};

describe("released-child errors (#4326)", () => {
	for (const [code, hint] of Object.entries(HINTS) as [ReleasedChildRefusalCode, string][]) {
		test(`the ${code} refusal carries its exact hint and message naming the child (#4326)`, () => {
			const error = releasedChildErrorFor({ code, childName: "worker-1" });
			assert.equal(error.hint, hint);
			assert.equal(error.code, code);
			assert.equal(error.childName, "worker-1");
			assert.equal(error.retryable, false);
			assert.equal(error.message, `Released-child request refused: child "worker-1" (${code}). ${hint}`);
		});
	}

	test("the closed code set is exactly the documented refusal codes (#4326)", () => {
		assert.deepEqual([...RELEASED_CHILD_ERROR_CODES].sort(), Object.keys(HINTS).sort());
		for (const code of RELEASED_CHILD_ERROR_CODES) assert.equal(isReleasedChildErrorCode(code), true, code);
		for (const code of ["", "hold-failed", "NOT_OWNER", "child-unrestorable"]) {
			assert.equal(isReleasedChildErrorCode(code), false, code);
		}
	});

	test("a refusal without a child name names the request and has no childName property (#4326)", () => {
		const error = releasedChildErrorFor({ code: "invalid_frame" });
		assert.equal(error.message, `Released-child request refused: request (invalid_frame). ${HINTS.invalid_frame}`);
		assert.equal(error.childName, undefined);
	});

	test("the error classes carry unique names and the factory picks the class by code (#4326)", () => {
		assert.equal(new IntercomReleasedChildError({ code: "invalid_frame" }).name, "IntercomReleasedChildError");
		const reservation = releasedChildErrorFor({ code: "invalid_alias", childName: "a" });
		assert.ok(reservation instanceof ReleasedChildReservationError);
		assert.equal(reservation.name, "ReleasedChildReservationError");
		const notOwner = releasedChildErrorFor({ code: "not_owner", childName: "a" });
		assert.ok(notOwner instanceof ReleasedChildReservationError);
		const unknown = releasedChildErrorFor({ code: "unknown_released_child", childName: "a" });
		assert.ok(unknown instanceof UnknownReleasedChildError);
		assert.equal(unknown.name, "UnknownReleasedChildError");
		assert.equal(Object.prototype.toString.call(unknown), "[object Error]");
		for (const error of [new IntercomReleasedChildError({ code: "invalid_frame" }), reservation, unknown]) {
			assert.notEqual(error.name, "ReleasedChildError");
		}
	});

	test("the cause option is kept on the error (#4326)", () => {
		const cause = new Error("root");
		const error = new IntercomReleasedChildError({ code: "invalid_frame" }, { cause });
		assert.equal(error.cause, cause);
	});

	test("the guards accept instances even when their name was changed (#4326)", () => {
		const renamed = new ReleasedChildReservationError({ code: "not_owner" });
		Object.defineProperty(renamed, "name", { value: "Renamed" });
		assert.equal(isIntercomReleasedChildError(renamed), true);
		assert.equal(isReleasedChildReservationError(renamed), true);
		assert.equal(isUnknownReleasedChildError(renamed), false);
	});

	test("the guards accept structural errors of their names only with a code from the closed set (#4326)", () => {
		for (const name of ["IntercomReleasedChildError", "ReleasedChildReservationError", "UnknownReleasedChildError"]) {
			assert.equal(
				isIntercomReleasedChildError(Object.assign(new Error("x"), { name, code: "not_owner" })),
				true,
				name,
			);
			assert.equal(
				isIntercomReleasedChildError(Object.assign(new Error("x"), { name, code: "hold-failed" })),
				false,
				name,
			);
		}
		const structuralReservation = Object.assign(new Error("x"), {
			name: "ReleasedChildReservationError",
			code: "group_not_allowed",
		});
		assert.equal(isReleasedChildReservationError(structuralReservation), true);
		assert.equal(isUnknownReleasedChildError(structuralReservation), false);
		const structuralUnknown = Object.assign(new Error("x"), {
			name: "UnknownReleasedChildError",
			code: "unknown_released_child",
		});
		assert.equal(isUnknownReleasedChildError(structuralUnknown), true);
		assert.equal(isReleasedChildReservationError(structuralUnknown), false);
	});

	test("the guards reject plain errors, nameless codes, codeless names and the subagents family's name (#4326)", () => {
		assert.equal(isIntercomReleasedChildError(new Error("x")), false);
		assert.equal(isIntercomReleasedChildError(Object.assign(new Error("x"), { code: "invalid_frame" })), false);
		assert.equal(
			isIntercomReleasedChildError(Object.assign(new Error("x"), { name: "IntercomReleasedChildError" })),
			false,
		);
		assert.equal(
			isIntercomReleasedChildError(Object.assign(new Error("x"), { name: "IntercomReleasedChildError", code: 4 })),
			false,
		);
		assert.equal(
			isIntercomReleasedChildError(
				Object.assign(new Error("x"), { name: "ReleasedChildError", code: "invalid_frame" }),
			),
			false,
		);
	});
});

describe("released-child errors across a process boundary (#4326)", () => {
	const crossBoundary = (serialized: SerializedIntercomReleasedChildError): SerializedIntercomReleasedChildError =>
		JSON.parse(JSON.stringify(serialized)) as SerializedIntercomReleasedChildError;

	test("each concrete error survives serialize and rehydrate with its class, guard, code, fields and hint (#4326)", () => {
		const cases = [
			[
				new ReleasedChildReservationError({ code: "not_owner", childName: "worker-1" }),
				ReleasedChildReservationError,
			],
			[
				new UnknownReleasedChildError({ code: "unknown_released_child", childName: "worker-2" }),
				UnknownReleasedChildError,
			],
			[new IntercomReleasedChildError({ code: "invalid_frame" }), IntercomReleasedChildError],
		] as const;
		for (const [original, expectedClass] of cases) {
			const serialized = crossBoundary(serializeIntercomReleasedChildError(original));
			assert.deepEqual(serialized, {
				name: original.name,
				code: original.code,
				message: original.message,
				hint: original.hint,
				retryable: false,
				fields: original.childName === undefined ? {} : { childName: original.childName },
			});
			const rehydrated = rehydrateIntercomReleasedChildError(serialized);
			assert.ok(rehydrated instanceof expectedClass, original.name);
			assert.ok(isIntercomReleasedChildError(rehydrated));
			assert.equal(rehydrated.name, original.name);
			assert.equal(rehydrated.code, original.code);
			assert.equal(rehydrated.childName, original.childName);
			assert.equal(rehydrated.hint, original.hint);
			assert.equal(rehydrated.message, original.message);
			assert.equal(rehydrated.retryable, false);
		}
	});

	test("the cause chain crosses the boundary bounded, as names and messages only (#4326)", () => {
		let cause = new Error("level-6");
		for (let level = 5; level >= 1; level -= 1) cause = new Error(`level-${level}`, { cause });
		cause.name = "SocketError";
		const original = new ReleasedChildReservationError({ code: "group_not_allowed", childName: "w" }, { cause });
		const serialized = crossBoundary(serializeIntercomReleasedChildError(original));
		const messages: string[] = [];
		for (let link = serialized.cause; link !== undefined; link = link.cause) messages.push(link.message);
		assert.deepEqual(messages, ["level-1", "level-2", "level-3", "level-4"]);
		assert.equal(serialized.cause?.name, "SocketError");
		const rehydrated = rehydrateIntercomReleasedChildError(serialized);
		assert.ok(rehydrated.cause instanceof Error);
		assert.equal(rehydrated.cause.name, "SocketError");
		assert.equal(rehydrated.cause.message, "level-1");
	});

	test("an unknown name rehydrates into the family base with its original name and code (#4326)", () => {
		const rehydrated = rehydrateIntercomReleasedChildError({
			name: "FutureReleasedChildError",
			code: "not_owner",
			message: "ignored",
			hint: "ignored",
			retryable: false,
			fields: { childName: "worker-3" },
		});
		assert.ok(rehydrated instanceof IntercomReleasedChildError);
		assert.equal(rehydrated instanceof ReleasedChildReservationError, false);
		assert.equal(rehydrated.name, "FutureReleasedChildError");
		assert.equal(rehydrated.code, "not_owner");
		assert.equal(rehydrated.childName, "worker-3");
		assert.equal(rehydrated.hint, HINTS.not_owner);
	});
});

describe("delivery failure reason codes (#4326)", () => {
	test("every known reason code is recognised (#4326)", () => {
		for (const code of ["message_id_conflict", "session_not_found", "recipient_not_restored", "recipient_parked"]) {
			assert.equal(isDeliveryFailureReasonCode(code), true, code);
		}
	});

	test("unknown and empty reason codes are rejected (#4326)", () => {
		for (const code of ["", "recipient_gone", "RECIPIENT_PARKED"]) {
			assert.equal(isDeliveryFailureReasonCode(code), false, code);
		}
	});
});
