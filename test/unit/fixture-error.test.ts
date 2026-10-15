import assert from "node:assert/strict";
import { test } from "vitest";
import { deserializeFixtureError, serializeFixtureError } from "../helpers/fixture-error.js";

test("fixture RPC preserves nested shutdown failures and their error codes", () => {
	const failure = Object.assign(new Error("cannot release storage"), { code: "EBUSY" });
	const component = new Error("storage", { cause: failure });
	const shutdown = Object.assign(new AggregateError([component], "Session shutdown failed"), {
		code: "ShutdownFailed",
	});
	const received = deserializeFixtureError(JSON.parse(JSON.stringify(serializeFixtureError(shutdown))));
	assert.ok(received instanceof AggregateError);
	assert.equal(received.message, shutdown.message);
	assert.equal(received.stack, shutdown.stack);
	assert.ok("code" in received);
	assert.equal(received.code, "ShutdownFailed");
	const nested = received.errors[0];
	assert.ok(nested instanceof Error);
	assert.equal(nested.message, "storage");
	assert.ok(nested.cause instanceof Error);
	assert.equal(nested.cause.message, failure.message);
	assert.ok("code" in nested.cause);
	assert.equal(nested.cause.code, "EBUSY");
});
