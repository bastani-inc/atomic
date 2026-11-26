import assert from "node:assert/strict";
import { test } from "vitest";
import {
	isRetryableStorageError,
	isStorageError,
	isStorageTransientError,
	rehydrateStorageError,
	type SerializedStorageError,
	STORAGE_TRANSIENT_ERROR_CODES,
	StorageError,
	StorageTransientError,
	StorageUnavailableError,
	serializeStorageError,
} from "../../packages/coding-agent/src/core/storage/errors.js";

const descriptor = { adapter: "postgres", location: "http://127.0.0.1:8080" };

function viaJson(serialized: SerializedStorageError): SerializedStorageError {
	return JSON.parse(JSON.stringify(serialized)) as SerializedStorageError;
}

test("a transient storage failure renders the failed call, its code, and the remedy (#4383)", () => {
	const error = new StorageTransientError(
		descriptor,
		{ code: "stream-expired", outcome: "not-applied", attempts: 5 },
		new Error("The stream has expired due to inactivity"),
	);
	assert.equal(
		error.message,
		"Storage unavailable: postgres at http://127.0.0.1:8080: the database server call failed on attempt 5 (stream-expired). Check that the database server is reachable and that this process is not stopped or starved of CPU, then retry; nothing was written",
	);
	assert.ok(error.message.endsWith(error.hint));
});

test("a transient storage failure is a retryable StorageUnavailableError with its facts as fields (#4383)", () => {
	const cause = new Error("connect ECONNREFUSED");
	const notApplied = new StorageTransientError(
		descriptor,
		{ code: "connection-refused", outcome: "not-applied", attempts: 3 },
		cause,
	);
	assert.ok(notApplied instanceof StorageUnavailableError);
	assert.equal(notApplied.name, "StorageTransientError");
	assert.equal(notApplied.code, "connection-refused");
	assert.equal(notApplied.outcome, "not-applied");
	assert.equal(notApplied.attempts, 3);
	assert.equal(notApplied.retryable, true);
	assert.equal(notApplied.adapter, "postgres");
	assert.equal(notApplied.location, "http://127.0.0.1:8080");
	assert.equal(notApplied.cause, cause);
	assert.equal(
		notApplied.hint,
		"Check that the database server is reachable and that this process is not stopped or starved of CPU, then retry; nothing was written",
	);

	const unknown = new StorageTransientError(descriptor, { code: "connection-lost", outcome: "unknown", attempts: 1 });
	assert.equal(unknown.outcome, "unknown");
	assert.equal(
		unknown.hint,
		"Check that the database server is reachable; the write may have been applied, so read it back before retrying a write that is not idempotent",
	);
	assert.ok(unknown.message.includes("failed on attempt 1 (connection-lost). Check that"));
	assert.equal(unknown.cause, undefined);
});

test("a transient failure on the way to the database server names that hop, not the server (#5473)", () => {
	const hop = {
		name: "the proxy http://proxy.example:3128",
		failure:
			"the proxy http://proxy.example:3128 could not be reached for the tunnel to db.example.com:5432 (ECONNREFUSED)",
	};
	const notApplied = new StorageTransientError(descriptor, {
		code: "connection-refused",
		outcome: "not-applied",
		attempts: 2,
		hop,
	});
	assert.equal(
		notApplied.message,
		"Storage unavailable: postgres at http://127.0.0.1:8080: the proxy http://proxy.example:3128 could not be reached for the tunnel to db.example.com:5432 (ECONNREFUSED) on attempt 2 (connection-refused). Check that the proxy http://proxy.example:3128 is reachable and that this process is not stopped or starved of CPU, then retry; nothing was written",
	);
	assert.ok(notApplied.message.endsWith(notApplied.hint));
	assert.equal(notApplied.hop, hop.name);
	assert.equal(notApplied.hopFailure, hop.failure);

	const unknown = new StorageTransientError(descriptor, {
		code: "connection-lost",
		outcome: "unknown",
		attempts: 1,
		hop,
	});
	assert.equal(
		unknown.hint,
		"Check that the proxy http://proxy.example:3128 is reachable; the write may have been applied, so read it back before retrying a write that is not idempotent",
	);

	// It crosses a process boundary with the same message.
	const rehydrated = rehydrateStorageError(viaJson(serializeStorageError(notApplied)));
	assert.ok(rehydrated instanceof StorageTransientError);
	assert.equal(rehydrated.message, notApplied.message);
	assert.equal(rehydrated.hint, notApplied.hint);
	assert.deepEqual([rehydrated.hop, rehydrated.hopFailure], [hop.name, hop.failure]);

	// A failure at the server itself keeps naming the server.
	const server = new StorageTransientError(descriptor, {
		code: "connection-refused",
		outcome: "not-applied",
		attempts: 1,
	});
	assert.equal(server.hop, undefined);
	assert.ok(server.message.includes(": the database server call failed on attempt 1 (connection-refused)."));
});

test("the transient-failure guard matches instances and copies with a known code only (#4383)", () => {
	for (const code of STORAGE_TRANSIENT_ERROR_CODES) {
		const error = new StorageTransientError(descriptor, { code, outcome: "not-applied", attempts: 1 });
		assert.ok(isStorageTransientError(error), code);
		assert.ok(isStorageTransientError({ name: "StorageTransientError", code }), `copy with ${code}`);
		assert.ok(isStorageError({ name: "StorageTransientError", code }), `storage error copy with ${code}`);
	}
	assert.deepEqual(STORAGE_TRANSIENT_ERROR_CODES, [
		"stream-expired",
		"transaction-timeout",
		"connection-refused",
		"connection-lost",
		"lock-conflict",
		"read-only-server",
	]);
	assert.equal(isStorageTransientError({ name: "StorageTransientError", code: "busy" }), false);
	assert.equal(isStorageTransientError({ name: "StorageUnavailableError", code: "stream-expired" }), false);
	assert.equal(isStorageTransientError(new StorageUnavailableError(descriptor, undefined)), false);
	assert.equal(isStorageTransientError(undefined), false);
	assert.equal(isStorageError({ name: "StorageTransientError", code: "busy" }), false);
});

test("a transient failure anywhere in the cause chain is retryable; a copy that says otherwise is not (#4383)", () => {
	const transient = new StorageTransientError(descriptor, {
		code: "connection-lost",
		outcome: "unknown",
		attempts: 1,
	});
	assert.ok(isRetryableStorageError(transient));
	assert.ok(
		isRetryableStorageError(new Error("append failed", { cause: new Error("wrapped", { cause: transient }) })),
	);
	assert.ok(isRetryableStorageError({ name: "StorageTransientError", code: "stream-expired", retryable: true }));
	assert.equal(
		isRetryableStorageError({ name: "StorageTransientError", code: "stream-expired", retryable: false }),
		false,
	);
	assert.equal(isRetryableStorageError(new StorageUnavailableError(descriptor, transient.cause)), false);
});

test("a transient failure crosses a process boundary as the same class with its fields and cause (#4383)", () => {
	const original = new StorageTransientError(
		descriptor,
		{ code: "transaction-timeout", outcome: "not-applied", attempts: 2 },
		Object.assign(new Error("Transaction timed out"), { code: "TRANSACTION_TIMEOUT" }),
	);
	const serialized = viaJson(serializeStorageError(original));
	assert.equal(serialized.code, "transaction-timeout");
	assert.equal(serialized.hint, original.hint);
	assert.deepEqual(serialized.fields, {
		adapter: "postgres",
		location: "http://127.0.0.1:8080",
		outcome: "not-applied",
		attempts: 2,
		retryable: true,
	});
	const rehydrated = rehydrateStorageError(serialized);
	assert.ok(rehydrated instanceof StorageTransientError);
	assert.ok(isStorageTransientError(rehydrated));
	assert.ok(isRetryableStorageError(rehydrated));
	assert.deepEqual(
		[rehydrated.code, rehydrated.outcome, rehydrated.attempts, rehydrated.adapter, rehydrated.location],
		["transaction-timeout", "not-applied", 2, "postgres", "http://127.0.0.1:8080"],
	);
	assert.equal(rehydrated.message, original.message);
	assert.equal(rehydrated.hint, original.hint);
	assert.equal((rehydrated.cause as Error).message, "Transaction timed out");
	assert.equal((rehydrated.cause as { code?: unknown }).code, "TRANSACTION_TIMEOUT");

	const unknown = rehydrateStorageError(
		viaJson(
			serializeStorageError(
				new StorageTransientError(descriptor, { code: "connection-lost", outcome: "unknown", attempts: 1 }),
			),
		),
	) as StorageTransientError;
	assert.deepEqual([unknown.code, unknown.outcome, unknown.attempts], ["connection-lost", "unknown", 1]);
});

test("a transient failure rehydrates conservatively from partial fields, and an unknown code keeps its name (#4383)", () => {
	const partial = rehydrateStorageError({
		name: "StorageTransientError",
		code: "stream-expired",
		message: "Storage unavailable: postgres at somewhere",
		fields: { outcome: "maybe" },
	}) as StorageTransientError;
	assert.ok(partial instanceof StorageTransientError);
	assert.equal(partial.outcome, "unknown", "an outcome it cannot read is not taken as not-applied");
	assert.equal(partial.attempts, 1);
	assert.equal(partial.adapter, "unknown");

	const newer = rehydrateStorageError({
		name: "StorageTransientError",
		code: "server-restarting",
		message: "Storage unavailable: postgres at somewhere",
		fields: { outcome: "not-applied", attempts: 4 },
	});
	assert.equal(newer instanceof StorageTransientError, false);
	assert.ok(newer instanceof StorageError);
	assert.equal(newer.name, "StorageTransientError");
	assert.equal((newer as { code?: unknown }).code, "server-restarting");
	assert.equal((newer as { attempts?: unknown }).attempts, 4);
});
