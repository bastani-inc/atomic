import assert from "node:assert/strict";
import { test } from "vitest";
import {
	isRetryableStorageError,
	largestValueBytes,
	payloadTooLargeKind,
	rehydrateStorageError,
	type SerializedStorageError,
	StoragePayloadTooLargeError,
	StorageUnavailableError,
	serializeStorageError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import { createSqliteDatabase } from "../../packages/coding-agent/src/core/storage/sqlite-facade.js";

const descriptor = { adapter: "libsql", location: "http://127.0.0.1:8080" };

test("payload limits are recognized from each driver's own codes, never from other failures (#4954)", () => {
	const failure = (fields: Record<string, unknown>, message = "failed") => Object.assign(new Error(message), fields);
	assert.equal(payloadTooLargeKind(failure({ code: "SQLITE_TOOBIG" })), "value");
	assert.equal(payloadTooLargeKind(failure({ code: "ARGS_INVALID" }, "string or blob too big")), "value");
	assert.equal(payloadTooLargeKind(failure({ code: "ARGS_INVALID" }, "wrong number of arguments")), undefined);
	assert.equal(payloadTooLargeKind(failure({ code: "RESPONSE_TOO_LARGE" })), "response");
	assert.equal(payloadTooLargeKind(failure({ code: "54000" })), "value");
	// node:sqlite's primary and extended result codes; 5 (busy) and 1 (error) are not limits.
	assert.equal(payloadTooLargeKind(failure({ errcode: 18 })), "value");
	assert.equal(payloadTooLargeKind(failure({ errcode: 18 + 256 })), "value");
	assert.equal(payloadTooLargeKind(failure({ errcode: 5 })), undefined);
	assert.equal(payloadTooLargeKind(failure({ code: "SQLITE_BUSY" })), undefined);
	// A driver error wraps the server's.
	assert.equal(
		payloadTooLargeKind(new Error("batch failed", { cause: failure({ code: "RESPONSE_TOO_LARGE" }) })),
		"response",
	);
	// The message of `ARGS_INVALID` decides; a code alone, or a message that is not text, does not.
	assert.equal(payloadTooLargeKind({ code: "ARGS_INVALID", message: 1 }), undefined);
	assert.equal(payloadTooLargeKind({ message: "string or blob too big" }), undefined);
	// Causes are followed eight deep, no further.
	const wrapped = (depth: number) => {
		let error: Error = failure({ code: "SQLITE_TOOBIG" });
		for (let level = 0; level < depth; level++) error = new Error(`level ${level}`, { cause: error });
		return error;
	};
	assert.equal(payloadTooLargeKind(wrapped(7)), "value");
	assert.equal(payloadTooLargeKind(wrapped(8)), undefined);
	assert.equal(payloadTooLargeKind(undefined), undefined);
	assert.equal(payloadTooLargeKind("SQLITE_TOOBIG"), undefined);
});

test("the largest bound value is measured in bytes, UTF-8 for text (#4954)", () => {
	assert.equal(largestValueBytes([]), 0);
	assert.equal(largestValueBytes([1, null, 2n]), 0);
	assert.equal(largestValueBytes(["é", new Uint8Array(1), "abc"]), 3);
	assert.equal(largestValueBytes(["😀", new Uint8Array(5)]), 5);
});

test("a payload too large names the size and the limit, is permanent, and crosses a process boundary (#4954)", () => {
	const value = new StoragePayloadTooLargeError(5_000_000, 6_000_000, { descriptor, cause: new Error("too big") });
	assert.equal(
		value.message,
		"Storage payload too large: libsql at http://127.0.0.1:8080: the backend refused a value of 6,000,000 bytes larger than it stores; the limit is 5,000,000 bytes per value or row (payload-too-large). Retrying does not help: store less in one value, or raise the backend's limit (sqld: max_row_size, --max-response-size).",
	);
	assert.ok(!(value instanceof StorageUnavailableError));
	assert.equal(isRetryableStorageError(value), false);
	assert.deepEqual([value.code, value.kind, value.retryable], ["payload-too-large", "value", false]);

	const response = new StoragePayloadTooLargeError(10_000_000, 0, { kind: "response" });
	assert.equal(
		response.message,
		"Storage payload too large: the backend refused to return a response larger than it allows; the limit is 10,000,000 bytes per response (payload-too-large). Retrying does not help: store less in one value, or raise the backend's limit (sqld: max_row_size, --max-response-size).",
	);
	assert.equal(response.adapter, undefined);
	const unknownLimit = new StoragePayloadTooLargeError(0, 0);
	assert.match(unknownLimit.message, /refused a value larger than it stores; over its limit per value or row/);

	const serialized = JSON.parse(JSON.stringify(serializeStorageError(value))) as SerializedStorageError;
	assert.equal(serialized.code, "payload-too-large");
	const rehydrated = rehydrateStorageError(serialized);
	assert.ok(rehydrated instanceof StoragePayloadTooLargeError);
	assert.deepEqual(
		[rehydrated.kind, rehydrated.limitBytes, rehydrated.actualBytes, rehydrated.adapter, rehydrated.location],
		["value", 5_000_000, 6_000_000, "libsql", "http://127.0.0.1:8080"],
	);
	assert.equal(rehydrated.message, value.message);
	assert.equal((rehydrated.cause as Error).message, "too big");
	const rehydratedResponse = rehydrateStorageError(serializeStorageError(response));
	assert.ok(rehydratedResponse instanceof StoragePayloadTooLargeError);
	assert.deepEqual([rehydratedResponse.kind, rehydratedResponse.adapter], ["response", undefined]);
});

test("a driver call refused as too large fails typed with the driver's limit and the largest bound value (#4954)", async () => {
	const tooBig = () => Object.assign(new Error("string or blob too big"), { code: "ARGS_INVALID" });
	const database = createSqliteDatabase({
		descriptor,
		payloadLimits: { value: 5_000_000 },
		execute: () => {
			throw tooBig();
		},
		executeMultiple: () => {
			throw tooBig();
		},
		beginTransaction: () => ({
			execute: () => {
				throw tooBig();
			},
			executeMultiple: () => undefined,
			commit: () => undefined,
			rollback: () => undefined,
		}),
		batch: () => {
			throw tooBig();
		},
		close: () => undefined,
	});
	const check =
		(actualBytes: number, limitBytes = 5_000_000) =>
		(error: unknown) => {
			assert.ok(error instanceof StoragePayloadTooLargeError);
			assert.deepEqual([error.limitBytes, error.actualBytes, error.adapter], [limitBytes, actualBytes, "libsql"]);
			return true;
		};
	await assert.rejects(database.run("INSERT INTO t VALUES (?, ?)", "abc", new Uint8Array(7)), check(7));
	await assert.rejects(database.exec("SELECT 1"), check(0));
	await assert.rejects(
		database.transaction((tx) => tx.run("INSERT INTO t VALUES (?)", new Uint8Array(9))),
		check(9),
	);
	await assert.rejects(
		database.batch!([
			{ sql: "INSERT INTO t VALUES (?)", params: [new Uint8Array(4)] },
			{ sql: "INSERT INTO t VALUES (?)", params: ["x".repeat(11)] },
		]),
		check(11),
	);
	await database.close();

	const unlimited = createSqliteDatabase({
		descriptor,
		execute: () => {
			throw Object.assign(new Error("Response is too large"), { code: "RESPONSE_TOO_LARGE" });
		},
		executeMultiple: () => undefined,
		beginTransaction: () => {
			throw new Error("unused");
		},
		close: () => undefined,
	});
	await assert.rejects(unlimited.all("SELECT data FROM t"), (error: unknown) => {
		assert.ok(error instanceof StoragePayloadTooLargeError);
		assert.deepEqual([error.kind, error.limitBytes, error.actualBytes], ["response", 0, 0]);
		return true;
	});
	await unlimited.close();
});
