import assert from "node:assert/strict";
import { ToolDetachmentError } from "@bastani/atomic";
import { test } from "vitest";
import { isSessionClosedError } from "../../packages/workflows/src/engine/session-closed-error.js";

test("a ToolDetachmentError with code session-closed counts as a closed host session, directly or as a cause (#4309)", () => {
	const closed = new ToolDetachmentError("session-closed", { sessionId: "session-1" });

	assert.equal(isSessionClosedError(closed), true);
	assert.equal(isSessionClosedError(new Error("resume failed", { cause: closed })), true);
	// A copy from another realm or process, recognized by name and code.
	const copy = Object.assign(new Error("Session is closed"), { name: "ToolDetachmentError", code: "session-closed" });
	assert.equal(isSessionClosedError(copy), true);
});

test("other ToolDetachmentError codes are not a closed host session (#4309)", () => {
	for (const code of ["session-busy", "unknown-tool-call", "invalid-policy", "context-detached"] as const)
		assert.equal(isSessionClosedError(new ToolDetachmentError(code, { sessionId: "session-1" })), false, code);
	assert.equal(isSessionClosedError(Object.assign(new Error("closed"), { code: "session-closed" })), false);
});
