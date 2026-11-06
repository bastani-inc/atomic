import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	INTERCOM_CONNECTED_EVENT,
	isAcknowledgeReleasedChildWakeRequest,
	isDropReleasedChildrenRequest,
	isReserveReleasedChildrenRequest,
	SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT,
	SUBAGENT_DROP_RELEASED_CHILDREN_EVENT,
	SUBAGENT_RELEASED_CHILD_WAKE_EVENT,
	SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT,
} from "../../packages/intercom/session-recovery.js";
import * as subagentEvents from "../../packages/subagents/src/runs/foreground/released-child-reservations.js";

describe("released child event names", () => {
	test("are pinned to their literal values (#4326)", () => {
		assert.equal(SUBAGENT_RELEASED_CHILD_WAKE_EVENT, "subagent:released-child-wake");
		assert.equal(SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, "subagent:reserve-released-children");
		assert.equal(SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, "subagent:drop-released-children");
		assert.equal(SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, "subagent:acknowledge-released-child-wake");
		assert.equal(INTERCOM_CONNECTED_EVENT, "intercom:connected");
	});

	test("agree between the intercom and subagents packages (#4326)", () => {
		assert.equal(subagentEvents.SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT);
		assert.equal(subagentEvents.SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, SUBAGENT_DROP_RELEASED_CHILDREN_EVENT);
		assert.equal(
			subagentEvents.SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT,
			SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT,
		);
		assert.equal(subagentEvents.INTERCOM_CONNECTED_EVENT, INTERCOM_CONNECTED_EVENT);
	});
});

describe("isReserveReleasedChildrenRequest", () => {
	const child = { childName: "subagent-a", wake: true };

	test("accepts well-formed children with and without optional fields (#4326)", () => {
		assert.equal(isReserveReleasedChildrenRequest({ children: [] }), true);
		assert.equal(isReserveReleasedChildrenRequest({ children: [child] }), true);
		assert.equal(
			isReserveReleasedChildrenRequest({
				children: [child, { childName: "b", wake: false, group: "g", aliases: ["x", "y"] }],
			}),
			true,
		);
		assert.equal(
			isReserveReleasedChildrenRequest({ children: [{ ...child, group: undefined, aliases: undefined }] }),
			true,
		);
		assert.equal(isReserveReleasedChildrenRequest({ children: [{ ...child, aliases: [] }] }), true);
	});

	test("rejects a value that is not an object with a children array (#4326)", () => {
		for (const value of [
			null,
			undefined,
			0,
			1,
			"",
			"children",
			true,
			false,
			{},
			{ children: "x" },
			{ children: {} },
		]) {
			assert.equal(isReserveReleasedChildrenRequest(value), false);
		}
	});

	test("rejects when any single child is malformed (#4326)", () => {
		const malformed = [
			null,
			undefined,
			"subagent-a",
			7,
			{ wake: true },
			{ childName: 5, wake: true },
			{ childName: "a" },
			{ childName: "a", wake: "yes" },
			{ childName: "a", wake: true, group: 3 },
			{ childName: "a", wake: true, group: null },
			{ childName: "a", wake: true, aliases: "x" },
			{ childName: "a", wake: true, aliases: null },
			{ childName: "a", wake: true, aliases: ["x", 2] },
		];
		for (const bad of malformed) {
			assert.equal(isReserveReleasedChildrenRequest({ children: [bad] }), false);
			assert.equal(isReserveReleasedChildrenRequest({ children: [child, bad] }), false);
			assert.equal(isReserveReleasedChildrenRequest({ children: [bad, child] }), false);
		}
	});
});

describe("isDropReleasedChildrenRequest", () => {
	test("accepts child names with optional gone and refusal text (#4326)", () => {
		assert.equal(isDropReleasedChildrenRequest({ childNames: [] }), true);
		assert.equal(isDropReleasedChildrenRequest({ childNames: ["a", "b"] }), true);
		assert.equal(isDropReleasedChildrenRequest({ childNames: ["a"], gone: "ended" }), true);
		assert.equal(isDropReleasedChildrenRequest({ childNames: ["a"], refusal: "taken over" }), true);
		assert.equal(isDropReleasedChildrenRequest({ childNames: ["a"], gone: "g", refusal: "r" }), true);
		assert.equal(isDropReleasedChildrenRequest({ childNames: ["a"], gone: undefined, refusal: undefined }), true);
	});

	test("rejects non-objects and a missing or malformed name list (#4326)", () => {
		for (const value of [
			null,
			undefined,
			0,
			1,
			"",
			"childNames",
			true,
			false,
			{},
			{ childNames: "a" },
			{ childNames: {} },
			{ childNames: ["a", 1] },
			{ childNames: [null] },
			{ childNames: [1, "a"] },
		]) {
			assert.equal(isDropReleasedChildrenRequest(value), false);
		}
	});

	test("rejects a gone or refusal that is not a string (#4326)", () => {
		assert.equal(isDropReleasedChildrenRequest({ childNames: ["a"], gone: 1 }), false);
		assert.equal(isDropReleasedChildrenRequest({ childNames: ["a"], gone: null }), false);
		assert.equal(isDropReleasedChildrenRequest({ childNames: ["a"], gone: false }), false);
		assert.equal(isDropReleasedChildrenRequest({ childNames: ["a"], refusal: 1 }), false);
		assert.equal(isDropReleasedChildrenRequest({ childNames: ["a"], refusal: null }), false);
		assert.equal(isDropReleasedChildrenRequest({ childNames: ["a"], gone: "g", refusal: 2 }), false);
		assert.equal(isDropReleasedChildrenRequest({ childNames: ["a"], gone: 2, refusal: "r" }), false);
	});
});

describe("isAcknowledgeReleasedChildWakeRequest", () => {
	test("accepts an object with a string child name (#4326)", () => {
		assert.equal(isAcknowledgeReleasedChildWakeRequest({ childName: "subagent-a" }), true);
		assert.equal(isAcknowledgeReleasedChildWakeRequest({ childName: "" }), true);
	});

	test("rejects everything else (#4326)", () => {
		for (const value of [
			null,
			undefined,
			0,
			"childName",
			"subagent-a",
			true,
			{},
			{ childName: 1 },
			{ childName: null },
			{ childName: ["a"] },
			{ childNames: ["a"] },
		]) {
			assert.equal(isAcknowledgeReleasedChildWakeRequest(value), false);
		}
	});
});
