import assert from "node:assert/strict";
import { test } from "vitest";
import {
	findStorageWriteLockTimeoutError,
	isRetryableStorageError,
	isStorageConfigError,
	isStorageUnsupportedOperationError,
	isStorageWriteLockTimeoutError,
	isStorageWriterQueueDegradedError,
	isStorageWriterQueueUnusableError,
	rehydrateStorageError,
	type SerializedStorageError,
	StorageAdapterLoadError,
	StorageConfigError,
	StorageError,
	StorageInvalidTextError,
	StorageOutcomeUnknownError,
	StoragePayloadTooLargeError,
	StoragePrefixError,
	StorageRollbackError,
	StorageSchemaVersionError,
	StorageTransactionClosedError,
	StorageUnavailableError,
	StorageUnsupportedOperationError,
	StorageWriteLockTimeoutError,
	StorageWriterQueueDegradedError,
	StorageWriterQueueUnusableError,
	StoreClosedError,
	serializeStorageError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import { isSqliteBusy } from "../../packages/coding-agent/src/core/storage/write-ahead-log.js";

const descriptor = { adapter: "node-sqlite", location: "/data/journal.sqlite" };

function busy(): Error {
	return Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5, errstr: "busy" });
}

function viaJson(serialized: SerializedStorageError): SerializedStorageError {
	return JSON.parse(JSON.stringify(serialized)) as SerializedStorageError;
}

test("a write-lock timeout renders what failed, who held the lock, its code, and the remedy", () => {
	const error = new StorageWriteLockTimeoutError(
		descriptor,
		{ timeoutMs: 30_000, elapsedMs: 30_012, phase: "queued", holderPid: 4242, holderHeldMs: 31_000 },
		busy(),
	);
	assert.equal(
		error.message,
		"Storage unavailable: node-sqlite at /data/journal.sqlite: database is locked; gave up after 30012 ms waiting for the write lock in the writers' queue, held all that time by process 4242 (which took it 31000 ms ago) with no other connection committing (write-lock-timeout). Another process holds the database's write lock without committing; check that process (it may be stopped or starved of CPU), or pass a longer lockWaitMs. Retrying later is safe",
	);
	assert.equal(error.name, "StorageWriteLockTimeoutError");
	assert.ok(error.message.endsWith(error.hint));
	const acquiring = new StorageWriteLockTimeoutError(descriptor, { timeoutMs: 5, elapsedMs: 6, phase: "acquiring" });
	assert.ok(acquiring.message.includes("gave up after 6 ms waiting for the write lock, held all that time with no"));
	const unknownAge = new StorageWriteLockTimeoutError(descriptor, {
		timeoutMs: 5,
		elapsedMs: 6,
		phase: "acquiring",
		holderPid: 7,
	});
	assert.ok(unknownAge.message.includes("held all that time by process 7 with no"));
	assert.equal(unknownAge.holderHeldMs, undefined);
	assert.equal(Object.hasOwn(unknownAge, "holderHeldMs"), false);
	assert.equal(Object.hasOwn(acquiring, "holderPid"), false, "absent facts are left out, not set to undefined");
	assert.equal(Object.hasOwn(acquiring, "holderHeldMs"), false);
});

test("the writers'-queue degradation names its reason and the remedy", () => {
	const error = new StorageWriterQueueDegradedError(descriptor, "watch-unavailable", new Error("ENOSPC"));
	assert.ok(isStorageWriterQueueDegradedError(error));
	assert.equal(error.code, "writer-queue-degraded");
	assert.equal(error.reason, "watch-unavailable");
	assert.equal(error.adapter, "node-sqlite");
	assert.equal(error.location, "/data/journal.sqlite");
	assert.equal(
		error.message,
		"Storage writers' queue degraded: node-sqlite at /data/journal.sqlite (writer-queue-degraded, watch-unavailable). Writers still take the lock in turn but notice a released lock by polling; check file-watch limits (fs.inotify.max_user_instances and max_user_watches on Linux)",
	);
	assert.ok(error.message.endsWith(error.hint));
	assert.equal(isRetryableStorageError(error), false);
});

test("each way the writers' queue degrades has its own remedy", () => {
	const hints = (["watch-unavailable", "wake-failed", "stale-ticket-kept"] as const).map((reason) => {
		const error = new StorageWriterQueueDegradedError(descriptor, reason);
		assert.equal(error.reason, reason);
		assert.ok(error.message.includes(`(writer-queue-degraded, ${reason})`));
		assert.ok(error.message.endsWith(error.hint));
		return error.hint;
	});
	assert.equal(new Set(hints).size, 3);
	assert.match(hints[0]!, /file-watch limits/);
	assert.match(hints[1]!, /readable and writable/);
	assert.match(hints[2]!, /remove them by hand/);
});

test("a storage configuration error keeps its message without a hint and has a stable code", () => {
	const error = new StorageConfigError("cli", "--storage", "selection-required");
	assert.equal(error.message, "Invalid storage configuration: --storage (selection-required)");
	assert.equal(error.code, "invalid-config");
	assert.equal(error.name, "StorageConfigError");
	assert.equal(error.hint, undefined);
	assert.equal(Object.hasOwn(error, "hint"), false);
});

test("guards match instances, structural copies from another realm, and nothing else", () => {
	const timeout = new StorageWriteLockTimeoutError(descriptor, { timeoutMs: 1, elapsedMs: 1, phase: "queued" });
	assert.ok(isStorageWriteLockTimeoutError(timeout));
	assert.ok(isStorageWriteLockTimeoutError({ name: "StorageWriteLockTimeoutError", code: "write-lock-timeout" }));
	assert.equal(isStorageWriteLockTimeoutError({ name: "StorageWriteLockTimeoutError", code: "other" }), false);
	assert.equal(isStorageWriteLockTimeoutError({ name: "Other", code: "write-lock-timeout" }), false);
	assert.equal(isStorageWriteLockTimeoutError(new StorageUnavailableError(descriptor, busy())), false);
	assert.equal(isStorageWriteLockTimeoutError(null), false);
	assert.equal(isStorageWriteLockTimeoutError("write-lock-timeout"), false);
	assert.ok(isStorageConfigError({ name: "StorageConfigError", code: "invalid-config" }));
	assert.equal(isStorageConfigError({ name: "StorageConfigError" }), false);
	assert.ok(
		isStorageUnsupportedOperationError({ name: "StorageUnsupportedOperationError", code: "unsupported-operation" }),
	);
	assert.equal(isStorageUnsupportedOperationError(timeout), false);
	assert.ok(
		isStorageWriterQueueDegradedError({ name: "StorageWriterQueueDegradedError", code: "writer-queue-degraded" }),
	);
	assert.equal(isStorageWriterQueueDegradedError(timeout), false);
	const impostor = Object.assign(function StorageConfigError() {}, { code: "invalid-config" });
	assert.equal(impostor.name, "StorageConfigError");
	assert.equal(isStorageConfigError(impostor), false, "only objects pass the structural check");
});

test("retryability and the timeout are found anywhere in a bounded cause chain", () => {
	const timeout = new StorageWriteLockTimeoutError(descriptor, { timeoutMs: 1, elapsedMs: 1, phase: "queued" });
	let wrapped: Error = timeout;
	for (let depth = 1; depth < 8; depth++) wrapped = new Error(`layer ${depth}`, { cause: wrapped });
	assert.equal(findStorageWriteLockTimeoutError(wrapped), timeout);
	assert.ok(isRetryableStorageError(wrapped));
	const tooDeep = new Error("layer 8", { cause: wrapped });
	assert.equal(findStorageWriteLockTimeoutError(tooDeep), undefined);
	assert.equal(isRetryableStorageError(tooDeep), false);
	const cyclic = new Error("cycle");
	Object.assign(cyclic, { cause: cyclic });
	assert.equal(findStorageWriteLockTimeoutError(cyclic), undefined);
	assert.equal(isRetryableStorageError(cyclic), false);
	assert.equal(isRetryableStorageError({ name: "StorageWriteLockTimeoutError", code: "write-lock-timeout" }), false);
	assert.equal(isRetryableStorageError(new StorageUnavailableError(descriptor, busy())), false);
	assert.equal(isRetryableStorageError(undefined), false);
	assert.equal(findStorageWriteLockTimeoutError(null), undefined);
	assert.equal(isRetryableStorageError(null), false);
	const carrier = Object.assign(() => {}, { cause: timeout });
	assert.equal(findStorageWriteLockTimeoutError(carrier), undefined, "only objects' causes are followed");
	assert.equal(isRetryableStorageError(carrier), false);
});

test("each storage error survives a JSON round trip as the same class with its fields and cause", () => {
	const errors: StorageError[] = [
		new StorageWriteLockTimeoutError(
			descriptor,
			{ timeoutMs: 600_000, elapsedMs: 600_004, phase: "queued", holderPid: 31, holderHeldMs: 700_000 },
			busy(),
		),
		new StorageWriteLockTimeoutError(descriptor, { timeoutMs: 10, elapsedMs: 11, phase: "acquiring" }),
		new StorageConfigError("sdk", "groupCommitHoldMs", "non-negative-finite-number-required", "Pass a number"),
		new StorageConfigError("env", "ATOMIC_STORAGE", "invalid-json"),
		new StorageConfigError("settings", "storage", "invalid-selection"),
		new StorageConfigError("cli", "--storage", "selection-required"),
		new StorageUnsupportedOperationError({ adapter: "custom", location: "remote://db" }, "getWriterQueueStats"),
		new StorageWriterQueueDegradedError(
			descriptor,
			"wake-failed",
			Object.assign(new Error("EACCES"), { code: "EACCES" }),
		),
		new StorageWriterQueueDegradedError(descriptor, "watch-unavailable"),
		new StorageWriterQueueDegradedError(
			descriptor,
			"stale-ticket-kept",
			Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" }),
		),
		new StorageUnsupportedOperationError({ adapter: "custom", location: "remote://db" }, "getWriterQueueDegradation"),
		new StorageWriterQueueUnusableError(
			descriptor,
			Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
		),
		new StorageWriterQueueUnusableError(descriptor, "not an error"),
		new StorageUnavailableError(descriptor, busy(), "database is locked (SQLite code 5)"),
		new StorageUnavailableError(descriptor, undefined),
		new StoreClosedError(descriptor),
		new StorageTransactionClosedError(),
		new StorageRollbackError(
			new Error("conflict"),
			Object.assign(new Error("no transaction is active"), { errcode: 1 }),
		),
		new StorageInvalidTextError(3),
		new StorageSchemaVersionError("sessions", 9, 2),
		new StorageSchemaVersionError("journal", "v9", 3),
		new StorageSchemaVersionError("journal", null, 3),
		new StoragePrefixError("bad prefix", "pattern"),
		new StoragePrefixError("wf_", "reserved"),
		new StorageAdapterLoadError("@libsql/client", new Error("Cannot find module '@libsql/client'")),
		new StorageOutcomeUnknownError("journal", "run-1", "append:7"),
		new StoragePayloadTooLargeError(1024, 4096),
	];
	for (const error of errors) {
		const rehydrated = rehydrateStorageError(viaJson(serializeStorageError(error)));
		assert.equal(rehydrated.constructor, error.constructor, error.name);
		assert.equal(rehydrated.name, error.name);
		assert.equal(rehydrated.message, error.message);
		const facts = (failure: Error) =>
			Object.fromEntries(
				Object.entries(failure).map(([key, value]) => [key, value instanceof Error ? value.message : value]),
			);
		assert.deepEqual(facts(rehydrated), facts(error), `${error.name} fields`);
		const causeText = (failure: Error) =>
			failure.cause instanceof Error
				? failure.cause.message
				: failure.cause === undefined
					? undefined
					: String(failure.cause);
		assert.equal(causeText(rehydrated), causeText(error), `${error.name} cause`);
	}
	const [timeout] = errors;
	const serialized = serializeStorageError(timeout!);
	assert.equal(serialized.code, "write-lock-timeout");
	assert.deepEqual(serialized.fields, {
		adapter: "node-sqlite",
		location: "/data/journal.sqlite",
		retryable: true,
		timeoutMs: 600_000,
		elapsedMs: 600_004,
		phase: "queued",
		holderPid: 31,
		holderHeldMs: 700_000,
	});
	assert.equal(serialized.cause?.code, "ERR_SQLITE_ERROR");
	const back = rehydrateStorageError(viaJson(serialized));
	assert.equal((back.cause as { code?: string }).code, "ERR_SQLITE_ERROR");
	assert.ok(back instanceof StorageWriteLockTimeoutError && back instanceof StorageUnavailableError);
	assert.ok(isStorageWriteLockTimeoutError(back));
	assert.ok(isRetryableStorageError(back));
	assert.ok(isSqliteBusy(back.cause), "the driver's SQLite code survives");
	assert.equal((back.cause as Error).name, "Error");
});

test("a storage error this version does not know rehydrates as a StorageError with its name, code, hint, and fields", () => {
	const serialized: SerializedStorageError = {
		name: "StorageFutureError",
		code: "future-code",
		message: "Something new (future-code). Do the new thing",
		hint: "Do the new thing",
		fields: { region: "eu", attempts: 3, final: true },
		cause: { name: "TypeError", message: "inner", fields: { errno: -2 } },
	};
	const error = rehydrateStorageError(viaJson(serialized));
	assert.ok(error instanceof StorageError);
	assert.equal(error.name, "StorageFutureError");
	assert.equal(error.message, serialized.message);
	assert.deepEqual(
		{ ...error },
		{
			name: "StorageFutureError",
			code: "future-code",
			hint: "Do the new thing",
			region: "eu",
			attempts: 3,
			final: true,
		},
	);
	assert.ok(error.cause instanceof Error && !(error.cause instanceof StorageError));
	assert.equal((error.cause as Error).name, "TypeError");
	assert.equal((error.cause as { errno?: number }).errno, -2);
	assert.equal(serializeStorageError(error).name, "StorageFutureError");
});

test("serialization keeps only scalar facts, never non-error causes as objects, and bounds the chain", () => {
	const error = new StorageError("outer", { cause: "plain text cause" });
	Object.assign(error, { nested: { secret: "x" }, list: [1], count: Number.NaN, ok: true });
	const serialized = serializeStorageError(error);
	assert.deepEqual(serialized.fields, { ok: true });
	assert.deepEqual(serialized.cause, { name: "Error", message: "plain text cause", fields: {} });
	let deep: Error = new Error("root");
	for (let depth = 0; depth < 20; depth++) deep = new Error(`wrap ${depth}`, { cause: deep });
	let chain: SerializedStorageError | undefined = serializeStorageError(new StorageError("top", { cause: deep }));
	let length = 0;
	for (; chain !== undefined; chain = chain.cause) length += 1;
	assert.equal(length, 8);
	let rehydrated: unknown = rehydrateStorageError(serializeStorageError(new StorageError("top", { cause: deep })));
	length = 0;
	for (; rehydrated instanceof Error; rehydrated = rehydrated.cause) length += 1;
	assert.equal(length, 8);
});

test("rehydration keeps every result in the storage family and fills facts a sender left out", () => {
	const top = rehydrateStorageError({ name: "Error", message: "plain", fields: {} });
	assert.ok(top instanceof StorageError, "the top of the chain is always a storage error");
	assert.equal(top.name, "Error");
	const nested = rehydrateStorageError({
		name: "StorageFutureError",
		message: "outer",
		fields: {},
		cause: { name: "StorageUnavailableError", message: "Storage unavailable: x", fields: { adapter: "a" } },
	});
	assert.ok(nested.cause instanceof StorageUnavailableError, "a known storage cause comes back as its class");
	assert.deepEqual([nested.cause.adapter, nested.cause.location], ["a", "unknown"]);
	const unknownCause = rehydrateStorageError({
		name: "StorageFutureError",
		message: "outer",
		fields: {},
		cause: { name: "StorageOtherFutureError", message: "inner", fields: {} },
	});
	assert.ok(unknownCause.cause instanceof StorageError, "an unknown storage-named cause stays in the family");
	assert.equal((unknownCause.cause as StorageError).name, "StorageOtherFutureError");
	const bare = rehydrateStorageError({
		name: "StorageWriteLockTimeoutError",
		code: "write-lock-timeout",
		message: "",
		fields: { phase: 7, timeoutMs: "5" },
	});
	assert.ok(bare instanceof StorageWriteLockTimeoutError);
	assert.deepEqual(
		[bare.adapter, bare.location, bare.timeoutMs, bare.elapsedMs, bare.phase],
		["unknown", "unknown", 0, 0, "acquiring"],
	);
	const config = rehydrateStorageError({ name: "StorageConfigError", message: "", fields: { source: "nowhere" } });
	assert.ok(config instanceof StorageConfigError);
	assert.deepEqual([config.source, config.field, config.reason, config.hint], ["sdk", "", "", undefined]);
	const degraded = rehydrateStorageError({ name: "StorageWriterQueueDegradedError", message: "", fields: {} });
	assert.ok(degraded instanceof StorageWriterQueueDegradedError);
	assert.equal(degraded.reason, "watch-unavailable");
});

test("a numeric driver code is kept as text, and non-scalar codes and hints are left out", () => {
	const cause = Object.assign(new Error("disk full"), { code: 13, hint: { not: "text" } });
	const serialized = serializeStorageError(new StorageError("outer", { cause }));
	assert.equal(serialized.cause?.code, "13");
	assert.equal(serialized.cause?.hint, undefined);
	assert.equal(serializeStorageError(new StorageError("no code")).code, undefined);
	const objectCode = Object.assign(new StorageError("object code"), { code: { nested: true } });
	assert.equal(serializeStorageError(objectCode).code, undefined);
});

test("rehydration bounds a cause chain deeper than the serializer would send, and leaves out absent code and hint", () => {
	let serialized: SerializedStorageError = { name: "Error", message: "root", fields: {} };
	for (let depth = 0; depth < 12; depth++)
		serialized = { name: "Error", message: `wrap ${depth}`, fields: {}, cause: serialized };
	let rehydrated: unknown = rehydrateStorageError(serialized);
	let length = 0;
	for (; rehydrated instanceof Error; rehydrated = rehydrated.cause) length += 1;
	assert.equal(length, 8);
	const plain = rehydrateStorageError({ name: "StoragePlainError", message: "plain", fields: {} });
	assert.equal(Object.hasOwn(plain, "code"), false);
	assert.equal(Object.hasOwn(plain, "hint"), false);
});

test("a writers' queue it cannot use renders what failed, the errno, its code, and the remedy (#4316)", () => {
	const cause = Object.assign(new Error("EACCES: permission denied, scandir '/data/journal.sqlite-writers'"), {
		code: "EACCES",
	});
	const error = new StorageWriterQueueUnusableError(descriptor, cause);
	assert.ok(error instanceof StorageUnavailableError);
	assert.ok(isStorageWriterQueueUnusableError(error));
	assert.ok(
		isStorageWriterQueueUnusableError({ name: "StorageWriterQueueUnusableError", code: "writer-queue-unusable" }),
	);
	assert.equal(isStorageWriterQueueUnusableError(new StorageUnavailableError(descriptor, cause)), false);
	assert.deepEqual(
		[error.name, error.code, error.errno, error.adapter, error.location, error.cause],
		[
			"StorageWriterQueueUnusableError",
			"writer-queue-unusable",
			"EACCES",
			"node-sqlite",
			"/data/journal.sqlite",
			cause,
		],
	);
	assert.equal(
		error.message,
		"Storage unavailable: node-sqlite at /data/journal.sqlite: the writers' queue next to the database is unusable: EACCES: permission denied, scandir '/data/journal.sqlite-writers' (writer-queue-unusable). Make the writers' queue directory next to the database (<file>-writers) readable and writable for every process that writes the database",
	);
	assert.ok(error.message.endsWith(error.hint));
	assert.equal(Object.hasOwn(new StorageWriterQueueUnusableError(descriptor, new Error("no code")), "errno"), false);
	assert.equal(isRetryableStorageError(error), false);
});

test("a failed rollback and an attached cleanup failure travel with the error they belong to", () => {
	const rollbackCause = Object.assign(new Error("cannot rollback - no transaction is active"), { errcode: 1 });
	const rollback = rehydrateStorageError(
		viaJson(serializeStorageError(new StorageRollbackError(busy(), rollbackCause))),
	);
	assert.ok(rollback instanceof StorageRollbackError);
	assert.ok(isSqliteBusy(rollback.cause), "the original failure");
	assert.ok(rollback.rollbackCause instanceof Error);
	assert.equal(rollback.rollbackCause.message, rollbackCause.message);
	assert.equal((rollback.rollbackCause as { errcode?: number }).errcode, 1);
	const opening = new StorageUnavailableError(descriptor, busy(), "database is locked (SQLite code 5)");
	Object.defineProperty(opening, "cleanupCause", {
		value: Object.assign(new Error("close failed"), { code: "EIO" }),
		configurable: true,
	});
	const rehydrated = rehydrateStorageError(viaJson(serializeStorageError(opening)));
	assert.ok(rehydrated instanceof StorageUnavailableError);
	assert.equal(rehydrated.message, opening.message);
	assert.ok(rehydrated.cleanupCause instanceof Error);
	assert.equal(rehydrated.cleanupCause.message, "close failed");
	assert.equal((rehydrated.cleanupCause as { code?: string }).code, "EIO");
	assert.equal(Object.keys(rehydrated).includes("cleanupCause"), false, "attached as the provider attaches it");
	assert.equal(Object.hasOwn(rehydrateStorageError(viaJson(serializeStorageError(rollback))), "cleanupCause"), false);
});

test("a schema version found as a bigint or binary value comes back as null; scalar values come back as sent", () => {
	for (const [found, back] of [
		[5n, null],
		[new Uint8Array([1]), null],
		[7, 7],
		["v7", "v7"],
	] as const) {
		const error = rehydrateStorageError(
			viaJson(serializeStorageError(new StorageSchemaVersionError("journal", found, 3))),
		);
		assert.ok(error instanceof StorageSchemaVersionError);
		assert.equal(error.found, back);
	}
});

test("each storage class rebuilt without the facts its sender left out gets empty or zero defaults", () => {
	const bare = (name: string) => rehydrateStorageError({ name, message: "", fields: {} });
	const schema = bare("StorageSchemaVersionError");
	assert.ok(schema instanceof StorageSchemaVersionError);
	assert.deepEqual([schema.domain, schema.found, schema.supported], ["", null, 0]);
	const prefix = bare("StoragePrefixError");
	assert.ok(prefix instanceof StoragePrefixError);
	assert.deepEqual([prefix.prefix, prefix.reason], ["", "pattern"]);
	const load = bare("StorageAdapterLoadError");
	assert.ok(load instanceof StorageAdapterLoadError);
	assert.equal(load.module, "");
	const outcome = bare("StorageOutcomeUnknownError");
	assert.ok(outcome instanceof StorageOutcomeUnknownError);
	assert.deepEqual([outcome.domain, outcome.id, outcome.key], ["", "", ""]);
	const invalid = bare("StorageInvalidTextError");
	assert.ok(invalid instanceof StorageInvalidTextError);
	assert.equal(invalid.parameterIndex, 0);
	const payload = bare("StoragePayloadTooLargeError");
	assert.ok(payload instanceof StoragePayloadTooLargeError);
	assert.deepEqual([payload.limitBytes, payload.actualBytes], [0, 0]);
	const unusable = bare("StorageWriterQueueUnusableError");
	assert.ok(unusable instanceof StorageWriterQueueUnusableError);
	assert.deepEqual([unusable.adapter, unusable.location, unusable.errno], ["unknown", "unknown", undefined]);
});

test("an operation or degradation reason this version does not know rehydrates as the first one it knows", () => {
	const operation = rehydrateStorageError({
		name: "StorageUnsupportedOperationError",
		message: "",
		fields: { operation: "getFutureThing" },
	});
	assert.ok(operation instanceof StorageUnsupportedOperationError);
	assert.equal(operation.operation, "getWriterQueueStats");
	const degraded = rehydrateStorageError({
		name: "StorageWriterQueueDegradedError",
		message: "",
		fields: { reason: "future-reason" },
	});
	assert.ok(degraded instanceof StorageWriterQueueDegradedError);
	assert.equal(degraded.reason, "watch-unavailable");
});
