import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	isReleasedChildError,
	RELEASED_CHILD_ERROR_NAME,
	ReleasedChildError,
} from "../../packages/subagents/src/runs/foreground/released-child-errors.js";

describe("ReleasedChildError", () => {
	test("a missing child record names the owner session and the child, and is not retryable (#4326)", () => {
		const error = new ReleasedChildError("child-record-missing", { ownerSessionId: "owner-1", childId: "run:3" });
		assert.ok(
			error.message.startsWith(
				"Session owner-1 has no record of subagent run:3 (child-record-missing). Wake the subagent",
			),
		);
		assert.equal(error.retryable, false);
		assert.equal(error.name, RELEASED_CHILD_ERROR_NAME);
	});

	test("an unrestorable child names the child and the reason, and the hint repeats the id (#4326)", () => {
		const error = new ReleasedChildError("child-unrestorable", { childId: "run:4", reason: "session file gone" });
		assert.ok(
			error.message.startsWith("Subagent run:4 cannot be restored: session file gone (child-unrestorable). "),
		);
		assert.ok(error.hint.includes('{ action: "resume", id: "run:4", message? }'));
		assert.equal(error.retryable, false);
	});

	test("the hint falls back to the child name, then to a generic subject (#4326)", () => {
		const byName = new ReleasedChildError("child-unrestorable", { childName: "worker-1", reason: "r" });
		assert.ok(byName.hint.includes('id: "worker-1"'));
		const anonymous = new ReleasedChildError("child-unrestorable", { reason: "r" });
		assert.ok(anonymous.hint.includes('id: "the subagent"'));
	});

	test("a failed record append names the state and the child and is retryable (#4326)", () => {
		const error = new ReleasedChildError("record-append-failed", { childId: "run:5", state: "terminal" });
		assert.ok(
			error.message.startsWith(
				"The terminal record of subagent run:5 could not be saved (record-append-failed). Check the session store",
			),
		);
		assert.equal(error.retryable, true);
	});

	test("a failed hold names the child and is retryable (#4326)", () => {
		const error = new ReleasedChildError("hold-failed", { childName: "worker-9" });
		assert.ok(
			error.message.startsWith(
				"Sends to released subagent worker-9 cannot be held (hold-failed). Check that Intercom is connected",
			),
		);
		assert.equal(error.retryable, true);
	});

	test("toJSON carries the code, hint, retryability and fields, and survives a JSON round trip (#4326)", () => {
		const fields = { childId: "run:6", state: "released" };
		const error = new ReleasedChildError("record-append-failed", fields);
		const copy = JSON.parse(JSON.stringify(error));
		assert.deepEqual(copy, {
			name: "ReleasedChildError",
			code: "record-append-failed",
			message: error.message,
			hint: error.hint,
			retryable: true,
			fields,
		});
		assert.equal(isReleasedChildError(copy), true);
	});
});

describe("isReleasedChildError", () => {
	test("an instance is recognized even when its name was changed (#4326)", () => {
		const error = new ReleasedChildError("hold-failed", {});
		Object.defineProperty(error, "name", { value: "Renamed" });
		assert.equal(isReleasedChildError(error), true);
	});

	test("null and undefined are not released-child errors (#4326)", () => {
		assert.equal(isReleasedChildError(null), false);
		assert.equal(isReleasedChildError(undefined), false);
	});

	test("a structural copy needs both the right name and a known code (#4326)", () => {
		assert.equal(isReleasedChildError({ name: "ReleasedChildError", code: "hold-failed" }), true);
		assert.equal(isReleasedChildError({ name: "OtherError", code: "hold-failed" }), false);
		assert.equal(isReleasedChildError({ name: "ReleasedChildError", code: "unknown-code" }), false);
		assert.equal(isReleasedChildError({ name: "ReleasedChildError", code: 7 }), false);
		assert.equal(isReleasedChildError({ name: "ReleasedChildError" }), false);
		assert.equal(isReleasedChildError(new Error("x")), false);
	});
});
