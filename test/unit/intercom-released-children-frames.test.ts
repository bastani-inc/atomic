import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { JsonWireValue } from "../../packages/intercom/broker/framing.js";
import {
	isReleasedReservationKey,
	isRestoringRecipientAlias,
	isValidChildName,
	normalizeReservationTarget,
	RELEASED_CHILD_ALIASES_MAX,
	releasedReservationKey,
	validateReleasedChildFrame,
} from "../../packages/intercom/broker/released-children.js";

const ID_A = "11111111-2222-3333-4444-555555555555";
const ID_B = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

const refusal = (code: string, childName?: string) =>
	childName === undefined ? { ok: false, refusal: { code } } : { ok: false, refusal: { code, childName } };

describe("released child reservation keys", () => {
	test("normalizes targets by trimming and lowercasing (#4326)", () => {
		assert.equal(normalizeReservationTarget("  Worker-ONE  "), "worker-one");
		assert.equal(releasedReservationKey("  Worker-ONE "), "released:worker-one");
	});

	test("recognizes released keys only by their prefix (#4326)", () => {
		assert.equal(isReleasedReservationKey("released:worker"), true);
		assert.equal(isReleasedReservationKey("released:"), true);
		assert.equal(isReleasedReservationKey("capability"), false);
		assert.equal(isReleasedReservationKey("x-released:worker"), false);
	});

	test("accepts only whole session ids as restoring aliases, ignoring surrounding whitespace (#4326)", () => {
		assert.equal(isRestoringRecipientAlias(ID_A), true);
		assert.equal(isRestoringRecipientAlias(ID_B), true);
		assert.equal(isRestoringRecipientAlias(`  ${ID_A}\n`), true);
		assert.equal(isRestoringRecipientAlias(`x${ID_A}`), false);
		assert.equal(isRestoringRecipientAlias(`${ID_A}x`), false);
		assert.equal(isRestoringRecipientAlias("worker-one"), false);
	});

	test("rejects blank and wildcard child names (#4326)", () => {
		assert.equal(isValidChildName("worker"), true);
		assert.equal(isValidChildName("  worker  "), true);
		assert.equal(isValidChildName(""), false);
		assert.equal(isValidChildName("   "), false);
		assert.equal(isValidChildName("*"), false);
		assert.equal(isValidChildName(" * "), false);
		assert.equal(isValidChildName("**"), true);
	});
});

describe("validateReleasedChildFrame", () => {
	test("parses valid children, trimming names and keeping aliases and groups (#4326)", () => {
		const frame: JsonWireValue = [
			{ childName: "  one  ", wake: true, group: "lane", aliases: [ID_A, ID_B] },
			{ childName: "two", wake: false },
		];
		assert.deepEqual(validateReleasedChildFrame(frame), {
			ok: true,
			children: [
				{ childName: "one", group: "lane", aliases: [ID_A, ID_B], wake: true },
				{ childName: "two", aliases: [], wake: false },
			],
		});
	});

	test("refuses a frame that is not a non-empty array (#4326)", () => {
		assert.deepEqual(validateReleasedChildFrame(undefined), refusal("invalid_frame"));
		assert.deepEqual(validateReleasedChildFrame([]), refusal("invalid_frame"));
		assert.deepEqual(validateReleasedChildFrame({ childName: "a", wake: true }), refusal("invalid_frame"));
	});

	test("refuses items that are not plain objects without naming a child (#4326)", () => {
		assert.deepEqual(validateReleasedChildFrame([null]), refusal("invalid_frame"));
		assert.deepEqual(validateReleasedChildFrame([[]]), refusal("invalid_frame"));
		assert.deepEqual(validateReleasedChildFrame([["a"]]), refusal("invalid_frame"));
		assert.deepEqual(validateReleasedChildFrame(["worker"]), refusal("invalid_frame"));
		assert.deepEqual(validateReleasedChildFrame([7]), refusal("invalid_frame"));
		assert.deepEqual(validateReleasedChildFrame([true]), refusal("invalid_frame"));
	});

	test("refuses invalid child names, naming the child only when it is a string (#4326)", () => {
		assert.deepEqual(
			validateReleasedChildFrame([{ childName: "   ", wake: true }]),
			refusal("invalid_child_name", "   "),
		);
		assert.deepEqual(
			validateReleasedChildFrame([{ childName: "*", wake: true }]),
			refusal("invalid_child_name", "*"),
		);
		assert.deepEqual(validateReleasedChildFrame([{ childName: "", wake: true }]), refusal("invalid_child_name", ""));
		assert.deepEqual(validateReleasedChildFrame([{ childName: 5, wake: true }]), refusal("invalid_child_name"));
		assert.deepEqual(validateReleasedChildFrame([{ wake: true }]), refusal("invalid_child_name"));
	});

	test("refuses a missing or non-boolean wake flag, naming the child (#4326)", () => {
		assert.deepEqual(validateReleasedChildFrame([{ childName: "a" }]), refusal("invalid_frame", "a"));
		assert.deepEqual(validateReleasedChildFrame([{ childName: "a", wake: "yes" }]), refusal("invalid_frame", "a"));
	});

	test("refuses a non-string group (#4326)", () => {
		assert.deepEqual(
			validateReleasedChildFrame([{ childName: "a", wake: true, group: 3 }]),
			refusal("invalid_group", "a"),
		);
	});

	test("refuses aliases that are not an array of session ids (#4326)", () => {
		assert.deepEqual(
			validateReleasedChildFrame([{ childName: "a", wake: true, aliases: "nope" }]),
			refusal("invalid_alias", "a"),
		);
		assert.deepEqual(
			validateReleasedChildFrame([{ childName: "a", wake: true, aliases: [5] }]),
			refusal("invalid_alias", "a"),
		);
		assert.deepEqual(
			validateReleasedChildFrame([{ childName: "a", wake: true, aliases: ["worker-two"] }]),
			refusal("invalid_alias", "a"),
		);
	});

	test("allows exactly the alias maximum and refuses one more (#4326)", () => {
		const ids = Array.from(
			{ length: RELEASED_CHILD_ALIASES_MAX + 1 },
			(_, index) => `0000000${index}-0000-0000-0000-000000000000`,
		);
		const atMax = validateReleasedChildFrame([
			{ childName: "a", wake: true, aliases: ids.slice(0, RELEASED_CHILD_ALIASES_MAX) },
		]);
		assert.equal(atMax.ok, true);
		assert.deepEqual(
			validateReleasedChildFrame([{ childName: "a", wake: true, aliases: ids }]),
			refusal("too_many_aliases", "a"),
		);
	});

	test("the first invalid item refuses the whole frame and names that child (#4326)", () => {
		assert.deepEqual(
			validateReleasedChildFrame([
				{ childName: "good", wake: true },
				{ childName: "bad", wake: 1 },
				{ childName: "*", wake: true },
			]),
			refusal("invalid_frame", "bad"),
		);
	});
});
