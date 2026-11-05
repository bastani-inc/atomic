import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { isDeliveryFailureReasonCode } from "../../packages/intercom/broker/delivery-failure-reason.js";
import {
	isReleasedChildError,
	ReleasedChildError,
	ReleasedChildReservationError,
	releasedChildErrorFor,
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

	test("a refusal without a child name names the request and has no childName property (#4326)", () => {
		const error = releasedChildErrorFor({ code: "invalid_frame" });
		assert.equal(error.message, `Released-child request refused: request (invalid_frame). ${HINTS.invalid_frame}`);
		assert.equal(error.childName, undefined);
	});

	test("the error classes carry their names and the factory picks the class by code (#4326)", () => {
		assert.equal(new ReleasedChildError({ code: "invalid_frame" }).name, "ReleasedChildError");
		const reservation = releasedChildErrorFor({ code: "invalid_alias", childName: "a" });
		assert.ok(reservation instanceof ReleasedChildReservationError);
		assert.equal(reservation.name, "ReleasedChildReservationError");
		const unknown = releasedChildErrorFor({ code: "unknown_released_child", childName: "a" });
		assert.ok(unknown instanceof UnknownReleasedChildError);
		assert.equal(unknown.name, "UnknownReleasedChildError");
		assert.equal(Object.prototype.toString.call(unknown), "[object Error]");
	});

	test("the cause option is kept on the error (#4326)", () => {
		const cause = new Error("root");
		const error = new ReleasedChildError({ code: "invalid_frame" }, { cause });
		assert.equal(error.cause, cause);
	});

	test("the guard accepts instances even when their name was changed (#4326)", () => {
		const renamed = new ReleasedChildError({ code: "invalid_frame" });
		Object.defineProperty(renamed, "name", { value: "Renamed" });
		assert.equal(isReleasedChildError(renamed), true);
	});

	test("the guard accepts structural errors of the three names that carry a string code (#4326)", () => {
		for (const name of ["ReleasedChildError", "ReleasedChildReservationError", "UnknownReleasedChildError"]) {
			assert.equal(isReleasedChildError(Object.assign(new Error("x"), { name, code: "invalid_frame" })), true, name);
		}
	});

	test("the guard rejects plain errors, nameless codes and codeless names (#4326)", () => {
		assert.equal(isReleasedChildError(new Error("x")), false);
		assert.equal(isReleasedChildError(Object.assign(new Error("x"), { code: "invalid_frame" })), false);
		assert.equal(isReleasedChildError(Object.assign(new Error("x"), { name: "ReleasedChildError" })), false);
		assert.equal(isReleasedChildError(Object.assign(new Error("x"), { name: "ReleasedChildError", code: 4 })), false);
		assert.equal(
			isReleasedChildError(Object.assign(new Error("x"), { name: "OtherError", code: "invalid_frame" })),
			false,
		);
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
