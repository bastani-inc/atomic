import assert from "node:assert/strict";
import { test } from "vitest";
import {
	boundStickyDeliveryStates,
	STICKY_DELIVERY_STATE_EXEMPLAR_LIMIT,
} from "../../packages/workflows/src/shared/sticky-delivery-state-bound.js";
import type { StickyStageDeliveryStatus } from "../../packages/workflows/src/shared/sticky-stage-delivery-status.js";

function delivery(index: number, state: StickyStageDeliveryStatus["state"]): StickyStageDeliveryStatus {
	return {
		messageId: `m${index}`,
		target: "workflow:root/**",
		runId: "root",
		stageId: `s${index}`,
		state,
		reason: state,
	};
}

test("a row within the limit keeps every delivery state in order, with per-state counts", () => {
	const states = [delivery(0, "delivered"), delivery(1, "queued"), delivery(2, "delivered")];
	assert.deepEqual(boundStickyDeliveryStates(states), {
		deliveryStates: states,
		deliveryStateCounts: { queued: 1, delivered: 2 },
	});
});

test("a long row keeps unresolved states first, then the most recent delivered, and counts the rest", () => {
	const states = [
		...Array.from({ length: 30 }, (_, index) => delivery(index, "delivered")),
		delivery(30, "stage-terminal"),
		delivery(31, "queued"),
		delivery(32, "receipt-unverified"),
		delivery(33, "queued"),
	];
	const bounded = boundStickyDeliveryStates(states, 6);
	assert.deepEqual(
		bounded.deliveryStates.map((state) => state.messageId),
		["m31", "m33", "m32", "m30", "m29", "m28"],
	);
	assert.deepEqual(bounded.deliveryStateCounts, {
		queued: 2,
		"receipt-unverified": 1,
		"stage-terminal": 1,
		delivered: 30,
	});
	assert.equal(bounded.omittedDeliveryStates, 28);
});

test("the default bound lists at most the exemplar limit", () => {
	const states = Array.from({ length: 8_000 }, (_, index) =>
		delivery(index, index % 3 === 0 ? "queued" : "delivered"),
	);
	const bounded = boundStickyDeliveryStates(states);
	assert.equal(bounded.deliveryStates.length, STICKY_DELIVERY_STATE_EXEMPLAR_LIMIT);
	assert.equal(bounded.omittedDeliveryStates, 8_000 - STICKY_DELIVERY_STATE_EXEMPLAR_LIMIT);
	assert.deepEqual(bounded.deliveryStateCounts, { queued: 2_667, delivered: 5_333 });
});
