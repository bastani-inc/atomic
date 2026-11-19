import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { resolveResumeTarget } from "../src/modes/interactive/resume-catalog.ts";

const sessionId = "12345678-1111-4111-8111-111111111111";

function session(id: string, path = `/sessions/${id}.jsonl`): SessionInfo {
	return {
		path,
		id,
		cwd: "/project",
		created: new Date(10),
		modified: new Date(20),
		messageCount: 2,
		firstMessage: "Session objective",
		allMessagesText: "Session objective",
	};
}

test("direct resume resolves session ids and unique prefixes (#5256)", () => {
	const chat = session(sessionId);
	for (const id of [sessionId, sessionId.slice(0, 8)]) {
		assert.deepEqual(resolveResumeTarget(id, [chat]), { kind: "session", session: chat });
	}
});

test("direct resume refuses ambiguity between sessions (#5256)", () => {
	const chat = session(sessionId);
	const other = session("12345678-2222-4222-8222-222222222222");
	assert.deepEqual(resolveResumeTarget("12345678", [chat, other]), { kind: "ambiguous", matches: [chat, other] });
	assert.deepEqual(resolveResumeTarget(sessionId, [chat, other]), { kind: "session", session: chat });
});

test("direct resume does not accept flags or unsupported truncated identifiers (#5256)", () => {
	const chat = session(sessionId);
	assert.deepEqual(resolveResumeTarget(`${sessionId} --flag`, [chat]), { kind: "invalid" });
	assert.deepEqual(resolveResumeTarget(sessionId.slice(0, 12), [chat]), { kind: "invalid" });
	assert.deepEqual(resolveResumeTarget("ffffffff", [chat]), { kind: "not_found" });
});
