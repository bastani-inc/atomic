import assert from "node:assert/strict";
import {
	IntercomRoutingError,
	IntercomRoutingMismatchError,
	IntercomRoutingTimeoutError,
	IntercomRoutingUnavailableError,
	isIntercomRoutingError,
	isIntercomRoutingMismatchError,
	isIntercomRoutingTimeoutError,
	isIntercomRoutingUnavailableError,
	isRetryableIntercomRoutingError,
} from "@bastani/atomic";
import { test } from "vitest";

test("each routing error carries its stable code, safe fields and hint, and belongs to one family (#4320)", () => {
	const mismatch = new IntercomRoutingMismatchError("implicit-default-on-remote-broker", "default");
	assert.deepEqual(
		[mismatch.name, mismatch.code, mismatch.reason, mismatch.group, mismatch.retryable],
		[
			"IntercomRoutingMismatchError",
			"broker-routing-mismatch",
			"implicit-default-on-remote-broker",
			"default",
			false,
		],
	);
	const unavailable = new IntercomRoutingUnavailableError("unsupported", "broker_status");
	assert.deepEqual(
		[unavailable.name, unavailable.code, unavailable.reason, unavailable.phase, unavailable.retryable],
		["IntercomRoutingUnavailableError", "broker-routing-unavailable", "unsupported", "broker_status", true],
	);
	const timeout = new IntercomRoutingTimeoutError({ timeoutMs: 5000, elapsedMs: 5003, phase: "broker_status" });
	assert.deepEqual(
		[timeout.name, timeout.code, timeout.timeoutMs, timeout.elapsedMs, timeout.phase, timeout.retryable],
		["IntercomRoutingTimeoutError", "broker-routing-timeout", 5000, 5003, "broker_status", true],
	);
	for (const error of [mismatch, unavailable, timeout]) {
		assert.ok(error instanceof IntercomRoutingError);
		assert.equal(isIntercomRoutingError(error), true);
		assert.ok(error.hint.length > 0);
	}
	assert.match(
		new IntercomRoutingMismatchError("shared-storage-not-on-broker", "default").hint,
		/atomic intercom restart/,
	);
	assert.match(unavailable.hint, /atomic intercom restart/);
	assert.match(timeout.hint, /atomic intercom restart/);
});

test("the guards recognise errors across realms by name and code, and only mismatches are terminal (#4320)", () => {
	const wire = (name: string, code: string) => ({ name, code });
	assert.equal(isIntercomRoutingMismatchError(wire("IntercomRoutingMismatchError", "broker-routing-mismatch")), true);
	assert.equal(
		isIntercomRoutingUnavailableError(wire("IntercomRoutingUnavailableError", "broker-routing-unavailable")),
		true,
	);
	assert.equal(isIntercomRoutingTimeoutError(wire("IntercomRoutingTimeoutError", "broker-routing-timeout")), true);
	assert.equal(isIntercomRoutingError(wire("IntercomRoutingTimeoutError", "broker-routing-timeout")), true);
	assert.equal(isIntercomRoutingMismatchError(wire("IntercomRoutingMismatchError", "other")), false);
	assert.equal(isIntercomRoutingMismatchError(wire("Other", "broker-routing-mismatch")), false);
	assert.equal(isIntercomRoutingError(null), false);
	assert.equal(
		isRetryableIntercomRoutingError(new IntercomRoutingMismatchError("implicit-default-on-remote-broker", "default")),
		false,
	);
	assert.equal(
		isRetryableIntercomRoutingError(new IntercomRoutingUnavailableError("malformed", "broker_status")),
		true,
	);
	assert.equal(
		isRetryableIntercomRoutingError(
			new IntercomRoutingTimeoutError({ timeoutMs: 1, elapsedMs: 1, phase: "broker_status" }),
		),
		true,
	);
});

test("retryability is read through bounded cause chains of wrappers, and a wrapped mismatch stays terminal (#4320)", () => {
	const timeout = new IntercomRoutingTimeoutError({ timeoutMs: 1, elapsedMs: 1, phase: "broker_status" });
	const unavailable = new IntercomRoutingUnavailableError("unsupported", "broker_status");
	const mismatch = new IntercomRoutingMismatchError("implicit-default-on-remote-broker", "default");
	const wrap = (cause: Error, depth: number): Error =>
		Array.from({ length: depth }).reduce<Error>((inner) => new Error("wrapper", { cause: inner }), cause);
	assert.equal(isRetryableIntercomRoutingError(wrap(timeout, 3)), true);
	assert.equal(isRetryableIntercomRoutingError(wrap(unavailable, 8)), true);
	const nonRetryableOuter = new IntercomRoutingError("broker-routing-mismatch", "outer", {
		hint: "Inspect the underlying failure.",
		retryable: false,
		cause: timeout,
	});
	assert.equal(isRetryableIntercomRoutingError(nonRetryableOuter), true);
	assert.equal(isRetryableIntercomRoutingError(wrap(mismatch, 3)), false);
	assert.equal(isRetryableIntercomRoutingError(wrap(timeout, 9)), false);
	assert.equal(isRetryableIntercomRoutingError(new Error("unrelated")), false);
	const first = new Error("first");
	const second = new Error("second", { cause: first });
	first.cause = second;
	assert.equal(isRetryableIntercomRoutingError(first), false);
});
