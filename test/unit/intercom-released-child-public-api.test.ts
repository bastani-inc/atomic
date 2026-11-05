import assert from "node:assert/strict";
import { test } from "vitest";
import * as intercom from "../../packages/intercom/index.js";

test("the Intercom package exposes released-child errors and their guards and serialization (#4326)", () => {
	const error = new intercom.ReleasedChildReservationError({ code: "not_owner", childName: "worker" });
	assert.ok(intercom.isIntercomReleasedChildError(error));
	assert.ok(intercom.isReleasedChildReservationError(error));
	const restored = intercom.rehydrateIntercomReleasedChildError(intercom.serializeIntercomReleasedChildError(error));
	assert.ok(restored instanceof intercom.ReleasedChildReservationError);
	assert.equal(restored.code, "not_owner");
	assert.equal(restored.childName, "worker");
	assert.ok(
		intercom.isUnknownReleasedChildError(new intercom.UnknownReleasedChildError({ code: "unknown_released_child" })),
	);
});
