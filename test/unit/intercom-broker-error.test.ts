import assert from "node:assert/strict";
import {
	IntercomBrokerError,
	IntercomBrokerSuccessorTimeoutError,
	isIntercomBrokerError,
	isIntercomBrokerSuccessorTimeoutError,
	isRetryableIntercomBrokerError,
	rehydrateIntercomBrokerError,
	type SerializedIntercomBrokerError,
	serializeIntercomBrokerError,
} from "@bastani/atomic";
import { test } from "vitest";
import { rehydrateError, serializeError } from "../../packages/workflows/src/shared/error-codec.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const FIELDS = { timeoutMs: 10_000, elapsedMs: 10_500, attempts: 14 };
const HINT = "Run `atomic intercom restart` to replace the broker, then resume the run or retry.";

/** A successor timeout's JSON form, as it reads after crossing a process boundary. */
function serialized(): SerializedIntercomBrokerError {
	const error = new IntercomBrokerSuccessorTimeoutError(FIELDS, { cause: new Error("read ECONNRESET") });
	return JSON.parse(JSON.stringify(serializeIntercomBrokerError(error))) as SerializedIntercomBrokerError;
}

/** A member of the family that a later version may send, which this version does not know. */
const FUTURE: SerializedIntercomBrokerError = {
	name: "IntercomBrokerFutureError",
	code: "broker-future",
	message: "Something new failed at the broker (broker-future). Do the new thing.",
	hint: "Do the new thing.",
	retryable: true,
	fields: { attempts: [1, 2], phase: "later" },
};

test("an Intercom broker successor timeout serializes its fields and rehydrates as itself with the given cause (#4496)", () => {
	const form = serialized();
	assert.deepEqual(form, {
		name: "IntercomBrokerSuccessorTimeoutError",
		code: "broker-successor-timeout",
		message: new IntercomBrokerSuccessorTimeoutError(FIELDS).message,
		hint: HINT,
		retryable: true,
		fields: { phase: "registration", ...FIELDS },
	});

	const cause = new Error("read ECONNRESET");
	const rebuilt = rehydrateIntercomBrokerError(form, cause);

	assert.ok(rebuilt instanceof IntercomBrokerSuccessorTimeoutError);
	assert.deepEqual({ timeoutMs: rebuilt.timeoutMs, elapsedMs: rebuilt.elapsedMs, attempts: rebuilt.attempts }, FIELDS);
	assert.equal(rebuilt.phase, "registration");
	assert.equal(rebuilt.message, form.message);
	assert.equal(rebuilt.cause, cause);
	assert.equal(Object.hasOwn(rehydrateIntercomBrokerError(form), "cause"), false);
});

test("a successor timeout copy whose fields do not fit its class rehydrates as the family base with its own name (#4496)", () => {
	const form = serialized();
	const fits = rehydrateIntercomBrokerError({ ...form, fields: { ...form.fields, elapsedMs: 0 } });
	assert.ok(fits instanceof IntercomBrokerSuccessorTimeoutError);
	for (const fields of [
		{ ...form.fields, phase: "connection" },
		{ ...form.fields, timeoutMs: "10000" },
		{ ...form.fields, elapsedMs: -1 },
		{ ...form.fields, attempts: 1.5 },
		{ phase: "registration" },
		undefined,
	]) {
		const rebuilt = rehydrateIntercomBrokerError({ ...form, fields });
		assert.equal(rebuilt.constructor, IntercomBrokerError, JSON.stringify(fields));
		assert.equal(rebuilt.name, "IntercomBrokerSuccessorTimeoutError");
		assert.equal(rebuilt.code, "broker-successor-timeout");
		assert.deepEqual(rebuilt.fields, fields ?? {});
		assert.equal(isIntercomBrokerSuccessorTimeoutError(rebuilt), false, JSON.stringify(fields));
		assert.ok(isIntercomBrokerError(rebuilt));
	}
	assert.equal(rehydrateIntercomBrokerError({ ...form, code: "broker-future" }).constructor, IntercomBrokerError);
	assert.equal(
		rehydrateIntercomBrokerError({ ...form, name: "IntercomBrokerError" }).constructor,
		IntercomBrokerError,
	);
});

test("a family member this version does not know crosses the worker codec as the family base with its facts (#4496)", () => {
	const rebuilt = rehydrateError({ ...FUTURE, family: "intercom-broker" });

	assert.equal(rebuilt.constructor, IntercomBrokerError);
	assert.ok(rebuilt instanceof IntercomBrokerError);
	assert.ok(isIntercomBrokerError(rebuilt));
	assert.equal(rebuilt.name, FUTURE.name);
	assert.equal(rebuilt.code, FUTURE.code);
	assert.equal(rebuilt.message, FUTURE.message);
	assert.equal(rebuilt.hint, FUTURE.hint);
	assert.equal(rebuilt.retryable, true);
	assert.deepEqual(rebuilt.fields, FUTURE.fields);
	assert.equal(isRetryableIntercomBrokerError(rebuilt), true);
	// A second hop carries the facts the receiver could not interpret.
	assert.deepEqual(serializeError(rebuilt).fields, FUTURE.fields);
	assert.equal(serializeError(rebuilt).family, "intercom-broker");
});

test("the family base keeps what it is given and nothing else (#4496)", () => {
	const bare = new IntercomBrokerError("broker-future", "Something new failed.");
	assert.equal(bare.name, "IntercomBrokerError");
	assert.equal(bare.hint, undefined);
	assert.equal(bare.retryable, false);
	assert.deepEqual(bare.fields, {});
	assert.equal(Object.hasOwn(bare, "cause"), false);
	assert.deepEqual(serializeIntercomBrokerError(bare), {
		name: "IntercomBrokerError",
		code: "broker-future",
		message: "Something new failed.",
		retryable: false,
		fields: {},
	});

	const plain = rehydrateIntercomBrokerError({ ...FUTURE, retryable: false, hint: undefined, fields: undefined });
	assert.equal(plain.retryable, false);
	assert.equal(plain.hint, undefined);
	assert.deepEqual(plain.fields, {});
	assert.equal(isRetryableIntercomBrokerError(plain), false);
});

test("a timeout that crossed the worker codec is still a retryable Intercom broker error (#4496)", () => {
	const original = new IntercomBrokerSuccessorTimeoutError(FIELDS, { cause: new Error("read ECONNRESET") });
	const rebuilt = rehydrateError(JSON.parse(JSON.stringify(serializeError(original))));

	assert.ok(rebuilt instanceof IntercomBrokerSuccessorTimeoutError, String(rebuilt));
	assert.equal(rebuilt.retryable, true);
	assert.equal(isRetryableIntercomBrokerError(rebuilt), true);
	assert.equal(isRetryableIntercomBrokerError(new Error("stage failed", { cause: rebuilt })), true);
});

test("retryability is read down the cause chain for eight links (#4496)", () => {
	const nested = (error: Error, links: number): Error =>
		links === 0 ? error : nested(new Error(`link ${links}`, { cause: error }), links - 1);
	const timeout = new IntercomBrokerSuccessorTimeoutError(FIELDS);

	assert.equal(isRetryableIntercomBrokerError(nested(timeout, 8)), true);
	assert.equal(isRetryableIntercomBrokerError(nested(timeout, 9)), false);
	assert.equal(isRetryableIntercomBrokerError(new IntercomBrokerError("broker-future", "m")), false);
	assert.equal(isRetryableIntercomBrokerError(new Error("m")), false);
	assert.equal(isRetryableIntercomBrokerError(undefined), false);
	assert.equal(isRetryableIntercomBrokerError(null), false);
	assert.equal(isRetryableIntercomBrokerError(new Error("m", { cause: null })), false);
});

test("a copy that kept its name, code and facts is recognized; one that did not is not (#4496)", () => {
	const copy = JSON.parse(JSON.stringify(new IntercomBrokerSuccessorTimeoutError(FIELDS))) as object;
	assert.ok(isIntercomBrokerSuccessorTimeoutError(copy));
	assert.ok(isIntercomBrokerError(copy));
	assert.equal(isIntercomBrokerSuccessorTimeoutError({ ...copy, code: "broker-routing-timeout" }), false);
	assert.equal(isIntercomBrokerSuccessorTimeoutError({ ...copy, name: "Error" }), false);
	assert.equal(isIntercomBrokerSuccessorTimeoutError({ ...copy, timeoutMs: "10000" }), false);
	assert.ok(isIntercomBrokerError({ name: "IntercomBrokerError", code: "broker-successor-timeout" }));
	assert.equal(isIntercomBrokerError({ name: "IntercomBrokerError", code: "broker-future" }), false);
	assert.equal(isIntercomBrokerError({ name: "Error", code: "broker-successor-timeout" }), false);
	for (const value of [
		new Error("broker-successor-timeout"),
		null,
		undefined,
		"IntercomBrokerSuccessorTimeoutError",
	]) {
		assert.equal(isIntercomBrokerSuccessorTimeoutError(value), false, String(value));
		assert.equal(isIntercomBrokerError(value), false, String(value));
	}
});

test("an instance is recognized by its class first, even one whose name was changed (#4496)", () => {
	const renamed = Object.assign(new IntercomBrokerSuccessorTimeoutError(FIELDS), { name: "Error" });
	const renamedBase = Object.assign(new IntercomBrokerError("broker-future", "m"), { name: "Error" });

	assert.ok(isIntercomBrokerSuccessorTimeoutError(renamed));
	assert.ok(isIntercomBrokerError(renamed));
	assert.ok(isIntercomBrokerError(renamedBase));
});
