import assert from "node:assert/strict";
import {
	IntercomBrokerSuccessorTimeoutError,
	isIntercomBrokerSuccessorTimeoutError,
	rehydrateIntercomBrokerSuccessorTimeoutError,
	serializeIntercomBrokerSuccessorTimeoutError,
} from "@bastani/atomic";
import { test } from "vitest";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const FIELDS = { timeoutMs: 10_000, elapsedMs: 10_500, attempts: 14 };

function serialized() {
	return JSON.parse(
		JSON.stringify(
			serializeIntercomBrokerSuccessorTimeoutError(
				new IntercomBrokerSuccessorTimeoutError(FIELDS, { cause: new Error("read ECONNRESET") }),
			),
		),
	) as ReturnType<typeof serializeIntercomBrokerSuccessorTimeoutError>;
}

test("an Intercom broker successor timeout serializes its fields and rehydrates as itself with the given cause (#4496)", () => {
	const form = serialized();
	assert.deepEqual(form.fields, { phase: "registration", ...FIELDS });
	assert.equal(form.name, "IntercomBrokerSuccessorTimeoutError");
	assert.equal(form.code, "broker-successor-timeout");
	assert.equal(form.retryable, true);
	assert.equal(form.hint, "Run `atomic intercom restart` to replace the broker, then resume the run or retry.");

	const cause = new Error("read ECONNRESET");
	const rebuilt = rehydrateIntercomBrokerSuccessorTimeoutError(form, cause);

	assert.ok(rebuilt instanceof IntercomBrokerSuccessorTimeoutError);
	assert.ok(isIntercomBrokerSuccessorTimeoutError(rebuilt));
	assert.deepEqual({ timeoutMs: rebuilt.timeoutMs, elapsedMs: rebuilt.elapsedMs, attempts: rebuilt.attempts }, FIELDS);
	assert.equal(rebuilt.message, form.message);
	assert.equal(rebuilt.cause, cause);
	assert.equal(Object.hasOwn(rehydrateIntercomBrokerSuccessorTimeoutError(form) ?? {}, "cause"), false);
});

test("a copy that kept its name and code is recognized; one that did not is not (#4496)", () => {
	assert.ok(isIntercomBrokerSuccessorTimeoutError(serialized()));
	assert.equal(isIntercomBrokerSuccessorTimeoutError({ ...serialized(), code: "broker-routing-timeout" }), false);
	assert.equal(isIntercomBrokerSuccessorTimeoutError({ ...serialized(), name: "Error" }), false);
	assert.equal(isIntercomBrokerSuccessorTimeoutError(new Error("broker-successor-timeout")), false);
	assert.equal(isIntercomBrokerSuccessorTimeoutError(null), false);
	assert.equal(isIntercomBrokerSuccessorTimeoutError(undefined), false);
	assert.equal(isIntercomBrokerSuccessorTimeoutError("IntercomBrokerSuccessorTimeoutError"), false);
});

test("an instance is recognized by its class first, even one whose name was changed (#4496)", () => {
	const renamed = Object.assign(new IntercomBrokerSuccessorTimeoutError(FIELDS), { name: "Error" });

	assert.ok(isIntercomBrokerSuccessorTimeoutError(renamed));
});

test("a copy whose fields are not whole non-negative numbers is not rehydrated (#4496)", () => {
	const form = serialized();
	assert.ok(rehydrateIntercomBrokerSuccessorTimeoutError({ ...form, fields: { ...form.fields, elapsedMs: 0 } }));
	for (const fields of [
		undefined,
		null,
		{ ...form.fields, timeoutMs: "10000" },
		{ ...form.fields, elapsedMs: -1 },
		{ ...form.fields, attempts: 1.5 },
		{ phase: "registration" },
	])
		assert.equal(
			rehydrateIntercomBrokerSuccessorTimeoutError({ ...form, fields }),
			undefined,
			JSON.stringify(fields),
		);
	assert.equal(
		rehydrateIntercomBrokerSuccessorTimeoutError({ ...form, code: "pending_stage_route_timeout" }),
		undefined,
	);
});
