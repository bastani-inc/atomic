import assert from "node:assert/strict";
import { AgentSessionBusyError, isAgentSessionBusyError } from "@bastani/atomic";
import { test } from "vitest";
import {
	IntercomRuntimeInactiveError,
	isIntercomRuntimeInactiveError,
} from "../../packages/intercom/runtime-inactive-error.js";

test("guards recognize an instance by its prototype even without its own name and code (#4327)", () => {
	const classes: readonly (readonly [(value: unknown) => boolean, abstract new (...args: never[]) => Error])[] = [
		[isAgentSessionBusyError, AgentSessionBusyError],
		[isIntercomRuntimeInactiveError, IntercomRuntimeInactiveError],
	];
	for (const [guard, type] of classes) assert.equal(guard(Object.create(type.prototype)), true, type.name);
});

test("the session's busy refusal and Intercom's inactive runtime are typed for the pool to act on (#4327)", () => {
	const busy = new AgentSessionBusyError();
	assert.equal(busy.name, "AgentSessionBusyError");
	assert.equal(busy.code, "agent_session_busy");
	assert.equal(busy.hint, "Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
	assert.equal(
		busy.message,
		"Agent is already processing: the session is running a turn (agent_session_busy). Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
	);
	assert.equal(isAgentSessionBusyError(busy), true);
	assert.equal(isAgentSessionBusyError({ name: "AgentSessionBusyError", code: "agent_session_busy" }), true);
	assert.equal(isAgentSessionBusyError({ name: "AgentSessionBusyError", code: "other" }), false);
	assert.equal(isAgentSessionBusyError({ name: "Error", code: "agent_session_busy" }), false);
	assert.equal(isAgentSessionBusyError(new Error("Agent is already processing")), false);
	assert.equal(isAgentSessionBusyError(null), false);
	assert.equal(isAgentSessionBusyError("AgentSessionBusyError"), false);

	const ended = new Error("the session context ended");
	const inactive = new IntercomRuntimeInactiveError({ cause: ended });
	assert.equal(inactive.name, "IntercomRuntimeInactiveError");
	assert.equal(inactive.code, "intercom_unavailable");
	assert.equal(inactive.cause, ended);
	assert.ok(inactive.hint.length > 0);
	assert.equal(
		inactive.message,
		`Intercom runtime no longer active: its session context ended (intercom_unavailable). ${inactive.hint}`,
	);
	assert.equal(isIntercomRuntimeInactiveError(inactive), true);
	assert.equal(isIntercomRuntimeInactiveError({ ...inactive }), true, "recognized by name and code on a copy");
	assert.equal(isIntercomRuntimeInactiveError({ name: "IntercomRuntimeInactiveError", code: "x" }), false);
	assert.equal(isIntercomRuntimeInactiveError({ name: "X", code: "intercom_unavailable" }), false);
	assert.equal(isIntercomRuntimeInactiveError(new Error("Intercom runtime no longer active")), false);
	assert.equal(isIntercomRuntimeInactiveError(undefined), false);
	assert.equal(isIntercomRuntimeInactiveError(null), false);
});

test("the session's busy-refusal guard rejects values that are not objects (#4327)", () => {
	for (const value of [undefined, null, "AgentSessionBusyError", 7, true])
		assert.equal(isAgentSessionBusyError(value), false, String(value));
	assert.equal(isAgentSessionBusyError({ name: "AgentSessionBusyError", code: "agent_session_busy" }), true);
});
