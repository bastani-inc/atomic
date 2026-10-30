import assert from "node:assert/strict";
import { test } from "vitest";
import {
	ExtensionStartupError,
	isTransientExtensionStartupFailure,
} from "../../packages/coding-agent/src/core/extension-startup-failure.js";
import { IntercomBrokerRetiringError } from "../../packages/intercom/recoverable-disconnect.js";

/**
 * A stage whose Intercom `session_start` lost the race with a retiring broker is retried like one that timed out:
 * a fresh session finds the replacement broker. The classification reads the wording that reaches `session_start`.
 */
const startupFailure = (message: string) =>
	new ExtensionStartupError([{ extensionPath: "intercom", event: "session_start", message }]);

test("a broker that refused the registration as retiring is a transient startup failure", () => {
	assert.equal(isTransientExtensionStartupFailure(startupFailure(new IntercomBrokerRetiringError().message)), true);
});

test("a broker that went away before it registered the session is a transient startup failure", () => {
	const lost = new IntercomBrokerRetiringError(
		"Intercom broker went away before it registered this session: Connection closed before registration",
	);
	assert.equal(isTransientExtensionStartupFailure(startupFailure(lost.message)), true);
});

test("an unrelated startup failure is not", () => {
	assert.equal(isTransientExtensionStartupFailure(startupFailure("Invalid supervisor authorization")), false);
});
