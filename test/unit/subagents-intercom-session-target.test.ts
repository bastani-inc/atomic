import assert from "node:assert/strict";
import { test } from "vitest";
import {
	resolveIntercomBridge,
	resolveIntercomSessionTarget,
} from "../../packages/subagents/src/intercom/intercom-bridge.js";

const SESSION_ID_ENV = "ATOMIC_INTERCOM_SESSION_ID";

test("prefers the session's own connected Intercom id over a duplicate-prone display name", () => {
	const previous = process.env[SESSION_ID_ENV];
	// Another session in this process connected last: its id is never this session's.
	process.env[SESSION_ID_ENV] = "another-session-id";
	try {
		assert.equal(
			resolveIntercomSessionTarget("shared-name", "atomic-session-id", "broker-session-id"),
			"broker-session-id",
		);
		assert.equal(resolveIntercomSessionTarget("shared-name", "atomic-session-id"), "shared-name");
	} finally {
		if (previous === undefined) delete process.env[SESSION_ID_ENV];
		else process.env[SESSION_ID_ENV] = previous;
	}
});
test("uses the full session ID for an unnamed Intercom alias", () => {
	const previous = process.env[SESSION_ID_ENV];
	delete process.env[SESSION_ID_ENV];
	try {
		const sessionId = "session-019f0000-aaaa-7bbb-8ccc-dddddddddddd";
		assert.equal(
			resolveIntercomSessionTarget(undefined, sessionId),
			"subagent-chat-019f0000-aaaa-7bbb-8ccc-dddddddddddd",
		);
	} finally {
		if (previous === undefined) delete process.env[SESSION_ID_ENV];
		else process.env[SESSION_ID_ENV] = previous;
	}
});

test("detects Atomic's bundled Intercom extension in a source checkout", () => {
	const bridge = resolveIntercomBridge({
		config: undefined,
		context: "fresh",
		orchestratorTarget: "parent",
		cwd: process.cwd(),
	});
	assert.equal(bridge.active, true);
	assert.match(bridge.extensionDir, /packages[/\\]intercom$/);
});
