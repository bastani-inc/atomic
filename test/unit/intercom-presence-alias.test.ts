import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveIntercomPresenceName } from "../../packages/intercom/intercom-utils.js";
import { resolveIntercomSessionTarget } from "../../packages/subagents/src/intercom/intercom-bridge.js";

const SESSION_ID_ENV = "ATOMIC_INTERCOM_SESSION_ID";

test("uses the full session ID for an unnamed presence alias", () => {
	assert.equal(
		resolveIntercomPresenceName(undefined, "session-019f0000-aaaa-7bbb-8ccc-dddddddddddd"),
		"subagent-chat-019f0000-aaaa-7bbb-8ccc-dddddddddddd",
	);
});

test("prefers a trimmed explicit session name for the presence alias", () => {
	assert.equal(resolveIntercomPresenceName("  planner  ", "session-019f0000-aaaa-7bbb-8ccc-dddddddddddd"), "planner");
});

test("keeps unnamed presence and subagent target aliases identical", () => {
	const previous = process.env[SESSION_ID_ENV];
	delete process.env[SESSION_ID_ENV];
	try {
		const sessionId = "session-019f0000-aaaa-7bbb-8ccc-dddddddddddd";
		assert.equal(
			resolveIntercomPresenceName(undefined, sessionId),
			resolveIntercomSessionTarget(undefined, sessionId),
		);
	} finally {
		if (previous === undefined) delete process.env[SESSION_ID_ENV];
		else process.env[SESSION_ID_ENV] = previous;
	}
});
