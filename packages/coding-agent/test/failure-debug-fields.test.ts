import assert from "node:assert/strict";
import { test } from "vitest";
import { failureDebugFields } from "../src/core/debug.ts";

test("a failure a fallback absorbed is named by class, code, message and first cause (#4660)", () => {
	const cause = new TypeError("lower level");
	const error = Object.assign(new Error("top level", { cause }), { code: "git-failed" });
	assert.deepEqual(failureDebugFields(error), {
		name: "Error",
		code: "git-failed",
		message: "top level",
		cause: "TypeError: lower level",
	});
	assert.deepEqual(failureDebugFields(new RangeError("plain")), {
		name: "RangeError",
		code: undefined,
		message: "plain",
		cause: undefined,
	});
	assert.deepEqual(failureDebugFields(Object.assign(new Error("n"), { code: 7, cause: "text" })), {
		name: "Error",
		code: 7,
		message: "n",
		cause: "text",
	});
	assert.deepEqual(failureDebugFields("not an error"), { message: "not an error" });
});
