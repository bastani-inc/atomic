import assert from "node:assert/strict";
import {
	IntercomRoutingChangedError,
	IntercomRoutingError,
	IntercomRoutingMismatchError,
	IntercomRoutingTimeoutError,
	IntercomRoutingUnavailableError,
	isIntercomRoutingChangedError,
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

test("a routing change refusal is a retryable family member recognised across realms (#4320)", () => {
	const changed = new IntercomRoutingChangedError(false);
	assert.deepEqual(
		[changed.name, changed.code, changed.expectedAcrossMachines, changed.retryable],
		["IntercomRoutingChangedError", "broker-routing-changed", false, true],
	);
	assert.ok(changed instanceof IntercomRoutingError);
	assert.equal(
		isIntercomRoutingChangedError({ name: "IntercomRoutingChangedError", code: "broker-routing-changed" }),
		true,
	);
	assert.equal(isIntercomRoutingChangedError({ name: "IntercomRoutingChangedError", code: "other" }), false);
	assert.equal(isRetryableIntercomRoutingError(new Error("wrapper", { cause: changed })), true);
	assert.match(changed.hint, /atomic intercom restart/);
});

const KNOWN_ROUTING_NAMES = [
	["IntercomRoutingMismatchError", "broker-routing-mismatch"],
	["IntercomRoutingUnavailableError", "broker-routing-unavailable"],
	["IntercomRoutingTimeoutError", "broker-routing-timeout"],
	["IntercomRoutingChangedError", "broker-routing-changed"],
] as const;

const GUARDS = {
	family: isIntercomRoutingError,
	mismatch: isIntercomRoutingMismatchError,
	unavailable: isIntercomRoutingUnavailableError,
	timeout: isIntercomRoutingTimeoutError,
	changed: isIntercomRoutingChangedError,
} as const;

function routingInstances() {
	return {
		mismatch: new IntercomRoutingMismatchError("implicit-default-on-remote-broker", "default"),
		unavailable: new IntercomRoutingUnavailableError("unsupported", "broker_status"),
		timeout: new IntercomRoutingTimeoutError({ timeoutMs: 1, elapsedMs: 1, phase: "broker_status" }),
		changed: new IntercomRoutingChangedError(true),
	} as const;
}

test("the family base is named for the family and records a cause only when it was given one (#4320)", () => {
	const options = { hint: "Inspect it.", retryable: false };
	const base = new IntercomRoutingError("broker-routing-mismatch", "base failure", options);
	assert.equal(base.name, "IntercomRoutingError");
	assert.equal(base.retryable, false);
	assert.equal("cause" in base, false);
	const cause = new Error("lower level");
	assert.equal(new IntercomRoutingError("broker-routing-mismatch", "wrapped", { ...options, cause }).cause, cause);
});

test("every guard answers false, without throwing, for values that are not objects (#4320)", () => {
	for (const [name, guard] of Object.entries(GUARDS)) {
		for (const value of [null, undefined, "IntercomRoutingTimeoutError", 7, true, Symbol("routing")]) {
			assert.equal(guard(value), false, `${name} guard for ${String(value)}`);
		}
	}
	assert.equal(isRetryableIntercomRoutingError(null), false);
	assert.equal(isRetryableIntercomRoutingError(undefined), false);
});

test("each guard accepts a foreign object with the class's own name and code, and nothing else (#4320)", () => {
	for (const [name, code] of KNOWN_ROUTING_NAMES) {
		const foreign = { name, code };
		const accepted = Object.entries(GUARDS)
			.filter(([, guard]) => guard(foreign))
			.map(([key]) => key);
		assert.deepEqual(
			accepted.sort(),
			["family", name.replace("IntercomRouting", "").replace("Error", "").toLowerCase()].sort(),
			name,
		);
	}
});

test("a foreign object is not in the family unless both its name and its code belong to it (#4320)", () => {
	for (const [name, code] of KNOWN_ROUTING_NAMES) {
		assert.equal(isIntercomRoutingError({ name, code: "broker-routing-other" }), false, `${name} with a wrong code`);
		assert.equal(isIntercomRoutingError({ name: "SomethingElse", code }), false, `${code} with a wrong name`);
		assert.equal(isIntercomRoutingError({ name: 42, code }), false, `${code} with a numeric name`);
		assert.equal(isIntercomRoutingError({ code }), false, `${code} without a name`);
		assert.equal(isIntercomRoutingError({ name, code: 42 }), false, `${name} with a numeric code`);
		assert.equal(isIntercomRoutingError({ name }), false, `${name} without a code`);
	}
});

test("a concrete guard rejects the other concrete classes and a wrong name or code (#4320)", () => {
	const INSTANCES = routingInstances();
	const concrete = ["mismatch", "unavailable", "timeout", "changed"] as const;
	for (const target of concrete) {
		for (const other of concrete) {
			assert.equal(GUARDS[target](INSTANCES[other]), target === other, `${target} guard for a ${other} error`);
		}
		assert.equal(GUARDS.family(INSTANCES[target]), true);
	}
	for (const [name, code] of KNOWN_ROUTING_NAMES) {
		for (const target of concrete) {
			const matches = INSTANCES[target].code === code;
			assert.equal(GUARDS[target]({ name, code: "other" }), false);
			assert.equal(GUARDS[target]({ name: "Other", code }), false);
			assert.equal(GUARDS[target]({ name, code }), matches && INSTANCES[target].name === name);
		}
	}
});

test("a family error whose class name was changed by bundling is still recognised as a family member (#4320)", () => {
	class MangledRoutingError extends IntercomRoutingError {
		override readonly name = "t" as const;
	}
	const mangled = new MangledRoutingError("broker-routing-mismatch", "mangled", { hint: "Hint.", retryable: false });
	assert.equal(isIntercomRoutingError(mangled), true);
	assert.equal(isIntercomRoutingError({ name: "t", code: "broker-routing-mismatch" }), false);
	assert.equal(isIntercomRoutingMismatchError(mangled), false);
});

test("the retry helper stops at a cause that is null or not an object, without throwing (#4320)", () => {
	assert.equal(isRetryableIntercomRoutingError(new Error("wrapper", { cause: null })), false);
	assert.equal(isRetryableIntercomRoutingError(new Error("wrapper", { cause: "text" })), false);
	assert.equal(isRetryableIntercomRoutingError(new Error("wrapper", { cause: undefined })), false);
	assert.equal(isRetryableIntercomRoutingError({ cause: { cause: null } }), false);
});

test("each routing error renders what failed, the code and one hint, as the UX contract (#4320)", () => {
	const INSTANCES = routingInstances();
	const hintOnce = (error: IntercomRoutingError) => error.message.split(error.hint).length - 1;
	const mismatch = new IntercomRoutingMismatchError("implicit-default-on-remote-broker", "default");
	assert.equal(
		mismatch.message,
		'The Intercom broker now routes across machines, but this session joined it as a single-machine session in the "default" group, which every teammate\'s session on the shared database could address (broker-routing-mismatch). Restart this session so it joins its project group, or set ATOMIC_INTERCOM_GROUP to choose its group.',
	);
	assert.equal(
		INSTANCES.unavailable.message,
		"The Intercom broker did not report its routing state (broker_status: unsupported), so this session cannot tell whether it routes across machines (broker-routing-unavailable). Run `atomic intercom restart` to replace the broker, then retry.",
	);
	assert.equal(
		new IntercomRoutingTimeoutError({ timeoutMs: 5000, elapsedMs: 5003, phase: "broker_status" }).message,
		"The Intercom broker did not report its routing state within 5000 ms (broker_status), so this session cannot tell whether it routes across machines (broker-routing-timeout). Run `atomic intercom restart` to replace the broker, then retry.",
	);
	assert.equal(
		INSTANCES.changed.message,
		"The Intercom broker changed how it routes between this session's check and its registration, so the registration was refused before it took effect (broker-routing-changed). The session checks the broker again and retries; run `atomic intercom restart` if it keeps failing.",
	);
	for (const error of [mismatch, ...Object.values(INSTANCES)]) {
		assert.equal(hintOnce(error), 1, error.name);
		assert.ok(error.message.includes(`(${error.code})`), error.name);
	}
});

test("a mismatch names the group and the fix for its reason, and an unavailable error names its phase and reason (#4320)", () => {
	const group = "project:acme/alpha";
	const sharedStorage = new IntercomRoutingMismatchError("shared-storage-not-on-broker", group);
	assert.equal(sharedStorage.reason, "shared-storage-not-on-broker");
	assert.ok(sharedStorage.message.includes(`"${group}"`));
	assert.ok(sharedStorage.message.includes("(broker-routing-mismatch)"));
	assert.ok(sharedStorage.message.endsWith(sharedStorage.hint));
	assert.match(sharedStorage.hint, /atomic intercom restart/);
	assert.doesNotMatch(sharedStorage.message, /undefined/);

	const implicit = new IntercomRoutingMismatchError("implicit-default-on-remote-broker", group);
	assert.ok(implicit.message.includes(`"${group}"`));
	assert.doesNotMatch(implicit.message, /undefined/);
	assert.match(implicit.hint, /ATOMIC_INTERCOM_GROUP/);
	assert.notEqual(implicit.hint, sharedStorage.hint);

	const malformedAtRegister = new IntercomRoutingUnavailableError("malformed", "register");
	assert.deepEqual([malformedAtRegister.reason, malformedAtRegister.phase], ["malformed", "register"]);
	assert.ok(malformedAtRegister.message.includes("register: malformed"));
	assert.ok(malformedAtRegister.message.endsWith(malformedAtRegister.hint));
});
