import assert from "node:assert/strict";
import { isAgentSessionBusyError } from "@bastani/atomic";
import { test } from "vitest";

test("the session's busy-refusal guard rejects values that are not objects (#4327)", () => {
	for (const value of [undefined, null, "AgentSessionBusyError", 7, true])
		assert.equal(isAgentSessionBusyError(value), false, String(value));
	assert.equal(isAgentSessionBusyError({ name: "AgentSessionBusyError", code: "agent_session_busy" }), true);
});
