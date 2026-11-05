import assert from "node:assert/strict";
import { test } from "vitest";
import {
	DebugConfigError,
	DebugError,
	DebugLogUnwritableError,
	isDebugConfigError,
	isDebugError,
	isDebugLogUnwritableError,
	rehydrateDebugError,
	type SerializedDebugError,
	serializeDebugError,
} from "../../packages/coding-agent/src/core/debug-errors.js";

test("every debug error survives a round trip across a process boundary as the same class (#4360)", () => {
	const through = (error: DebugError) => rehydrateDebugError(JSON.parse(JSON.stringify(serializeDebugError(error))));
	const unwritable = through(
		new DebugLogUnwritableError("/logs/atomic-debug.log", { cause: new TypeError("EACCES") }),
	);
	assert.ok(unwritable instanceof DebugLogUnwritableError);
	assert.equal(isDebugLogUnwritableError(unwritable), true);
	assert.deepEqual(
		{ code: unwritable.code, path: unwritable.path, hint: unwritable.hint, retryable: unwritable.retryable },
		{
			code: "debug-log-unwritable",
			path: "/logs/atomic-debug.log",
			hint: "Make /logs writable, or turn debug mode off.",
			retryable: false,
		},
	);
	assert.ok(unwritable.cause instanceof Error);
	assert.deepEqual(
		{ name: unwritable.cause.name, message: unwritable.cause.message },
		{ name: "TypeError", message: "EACCES" },
	);
	const config = through(new DebugConfigError({ source: "rpc", received: "string" }));
	assert.ok(config instanceof DebugConfigError);
	assert.equal(isDebugConfigError(config), true);
	assert.deepEqual(
		{
			code: config.code,
			source: config.source,
			field: config.field,
			received: config.received,
			hint: config.hint,
		},
		{ code: "invalid-setting", source: "rpc", field: "enabled", received: "string", hint: "Pass true or false." },
	);
	assert.deepEqual(config.fields(), { source: "rpc", field: "enabled", received: "string" });
	assert.equal(config.cause, undefined);
	assert.deepEqual(new DebugError("invalid-setting", "m", "h").fields(), {});
	const plainCause = through(new DebugLogUnwritableError("/x/log", { cause: "disk gone" }));
	assert.deepEqual(
		{ name: (plainCause.cause as Error).name, message: (plainCause.cause as Error).message },
		{ name: "Error", message: "disk gone" },
	);
});

test("an unknown debug error arrives as the family base with its name, code, fields and retryability kept (#4360)", () => {
	const foreign = rehydrateDebugError({
		name: "DebugQuotaError",
		code: "quota",
		message: "Quota (quota). Wait.",
		hint: "Wait.",
		retryable: true,
		fields: { limit: "3" },
		cause: {
			name: "DebugLogUnwritableError",
			code: "debug-log-unwritable",
			message: "m",
			hint: "h",
			retryable: false,
			fields: { path: "/a/b" },
		},
	});
	assert.ok(foreign instanceof DebugError);
	assert.equal(isDebugError(foreign), true);
	assert.deepEqual(
		{
			name: foreign.name,
			code: foreign.code,
			message: foreign.message,
			hint: foreign.hint,
			retryable: foreign.retryable,
		},
		{ name: "DebugQuotaError", code: "quota", message: "Quota (quota). Wait.", hint: "Wait.", retryable: true },
	);
	assert.deepEqual(foreign.fields(), { limit: "3" });
	assert.ok(foreign.cause instanceof DebugLogUnwritableError);
	for (const [name, fields] of [
		["DebugLogUnwritableError", {}],
		["DebugConfigError", { source: "cli", received: "string" }],
		["DebugConfigError", { source: "rpc" }],
	] as const) {
		const malformed = rehydrateDebugError({ name, code: "x", message: "m", hint: "h", retryable: false, fields });
		assert.equal(malformed instanceof DebugLogUnwritableError || malformed instanceof DebugConfigError, false, name);
		assert.equal(malformed.name, name, "kept as the family base");
	}
	assert.ok(
		rehydrateDebugError({
			name: "DebugConfigError",
			code: "invalid-setting",
			message: "m",
			hint: "h",
			retryable: false,
			fields: { source: "sdk", received: "number" },
		}) instanceof DebugConfigError,
	);
});

test("a serialized cause chain stops after eight errors (#4360)", () => {
	let error = new DebugLogUnwritableError("/0/log");
	for (let index = 1; index < 12; index += 1) error = new DebugLogUnwritableError(`/${index}/log`, { cause: error });
	let serialized: SerializedDebugError | undefined = serializeDebugError(error);
	let depth = 0;
	while (serialized !== undefined) {
		depth += 1;
		serialized = serialized.cause as SerializedDebugError | undefined;
	}
	assert.equal(depth, 8);
	let rehydrated: unknown = rehydrateDebugError(serializeDebugError(error));
	let count = 0;
	while (rehydrated instanceof DebugLogUnwritableError) {
		count += 1;
		rehydrated = rehydrated.cause;
	}
	assert.equal(count, 8);
});

test("an error without a cause is sent without one (#4360)", () => {
	assert.equal("cause" in serializeDebugError(new DebugConfigError({ source: "sdk", received: "number" })), false);
	assert.equal("cause" in serializeDebugError(new DebugLogUnwritableError("/x/log")), false);
	assert.equal(rehydrateDebugError(serializeDebugError(new DebugLogUnwritableError("/x/log"))).cause, undefined);
});
