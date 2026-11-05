import assert from "node:assert/strict";
import { test } from "vitest";
import {
	AgentRehydrateError,
	rehydrateAgentRehydrateError,
	serializeAgentRehydrateError,
} from "../src/core/agent-rehydrate-errors.ts";

test("a cause of a known family is carried as that family alone, not also as a plain nested cause (#4326)", () => {
	const inner = new AgentRehydrateError(
		"session-busy",
		{ sessionId: "s-1", activity: "streaming" },
		{ cause: new Error("root") },
	);
	const outer = new AgentRehydrateError("release-failed", { sessionId: "s-1" }, { cause: inner });
	const cause = serializeAgentRehydrateError(outer).cause;
	assert.equal(cause?.family?.kind, "agent-rehydrate");
	assert.equal(Object.hasOwn(cause ?? {}, "cause"), false, "the family's own serialized error carries its cause");
});

test("a plain cause comes back with only the properties it had (#4326)", () => {
	const plain = Object.assign(new Error("disk is full"), { code: "ENOSPC" });
	const retryable = Object.assign(new Error("try later"), { retryable: false });
	for (const [cause, expected] of [
		[plain, { code: "ENOSPC", retryable: undefined }],
		[retryable, { code: undefined, retryable: false }],
	] as const) {
		const outer = new AgentRehydrateError("wake-failed", { wakeKey: "k" }, { cause });
		const back = rehydrateAgentRehydrateError(serializeAgentRehydrateError(outer)).cause as Error & {
			code?: string;
			retryable?: boolean;
		};
		assert.equal(back.message, cause.message);
		assert.equal(back.code, expected.code);
		assert.equal(back.retryable, expected.retryable);
		assert.equal(Object.hasOwn(back, "code"), expected.code !== undefined);
		assert.equal(Object.hasOwn(back, "retryable"), expected.retryable !== undefined);
	}
});
