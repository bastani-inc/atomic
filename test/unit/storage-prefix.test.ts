import assert from "node:assert/strict";
import { test } from "vitest";
import {
	rehydrateStorageError,
	StoragePrefixError,
	StorageSchemaVersionError,
	serializeStorageError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	POSTGRES_MAX_STORAGE_PREFIX_LENGTH,
	POSTGRES_STORAGE_IDENTIFIER_SUFFIXES,
	renderStorageIdentifiers,
	validateStoragePrefix,
} from "../../packages/coding-agent/src/core/storage/prefix.js";
import { assertStorageSchemaVersion } from "../../packages/coding-agent/src/core/storage/schema.js";

test("storage prefixes preserve valid text and reject invalid or reserved names", () => {
	for (const prefix of ["", "a", "_", "Tenant_123", "SQLITE", "sqlitex_"]) {
		assert.equal(validateStoragePrefix(prefix), prefix);
	}
	assert.equal(validateStoragePrefix(), "");
	for (const prefix of ["1x", "-", "a.b", "a b", "a\n", "a\0", "é", 'x";']) {
		assert.throws(
			() => validateStoragePrefix(prefix),
			(error: Error) => {
				assert.ok(error instanceof StoragePrefixError);
				assert.equal(error.prefix, prefix);
				assert.equal(error.reason, "pattern");
				return true;
			},
		);
	}
	for (const prefix of ["sqlite_", "SQLITE_a", "SqlItE_"]) {
		assert.throws(
			() => validateStoragePrefix(prefix),
			(error: Error) => {
				assert.ok(error instanceof StoragePrefixError);
				assert.equal(error.prefix, prefix);
				assert.equal(error.reason, "reserved");
				return true;
			},
		);
	}
});

test("a PostgreSQL prefix leaves room for the longest identifier Atomic creates (#5067)", () => {
	const longest = Math.max(...POSTGRES_STORAGE_IDENTIFIER_SUFFIXES.map((suffix) => suffix.length));
	assert.equal(POSTGRES_MAX_STORAGE_PREFIX_LENGTH, 63 - longest);
	// Prefixes of up to 24 characters worked before #5067: a new name too long for them must be shorter instead.
	assert.ok(POSTGRES_MAX_STORAGE_PREFIX_LENGTH >= 24, String(POSTGRES_MAX_STORAGE_PREFIX_LENGTH));
	const allowed = "p".repeat(POSTGRES_MAX_STORAGE_PREFIX_LENGTH);
	assert.equal(validateStoragePrefix(allowed, "postgres"), allowed);
	for (const prefix of [`${allowed}x`, "p".repeat(24).concat("_"), "p".repeat(32).concat("_")]) {
		assert.throws(
			() => validateStoragePrefix(prefix, "postgres"),
			(error: Error) => {
				assert.ok(error instanceof StoragePrefixError);
				assert.equal(error.prefix, prefix);
				assert.equal(error.reason, "too-long");
				assert.equal(
					error.message,
					`Invalid storage prefix: too-long (PostgreSQL allows at most ${POSTGRES_MAX_STORAGE_PREFIX_LENGTH} characters)`,
				);
				const copy = rehydrateStorageError(serializeStorageError(error));
				assert.ok(copy instanceof StoragePrefixError);
				assert.equal(copy.reason, "too-long");
				return true;
			},
		);
		// SQLite has no identifier limit.
		assert.equal(validateStoragePrefix(prefix, "sqlite"), prefix);
		assert.equal(validateStoragePrefix(prefix), prefix);
	}
	// The pattern is checked first, whatever the length.
	assert.throws(() => validateStoragePrefix("1".repeat(40), "postgres"), { reason: "pattern" });
});

test("a storage prefix error keeps its reason, limit and message across processes (#5067)", () => {
	for (const error of [
		new StoragePrefixError("1x", "pattern"),
		new StoragePrefixError("sqlite_", "reserved"),
		new StoragePrefixError("p".repeat(30), "too-long", 17),
	]) {
		const copy = rehydrateStorageError(serializeStorageError(error));
		assert.ok(copy instanceof StoragePrefixError);
		assert.equal(copy.prefix, error.prefix);
		assert.equal(copy.reason, error.reason);
		assert.equal(copy.maxLength, error.maxLength);
		assert.equal(copy.message, error.message);
	}
	assert.equal(new StoragePrefixError("1x", "pattern").message, "Invalid storage prefix: pattern");
	assert.equal(new StoragePrefixError("1x", "pattern").maxLength, undefined);
	assert.equal(
		new StoragePrefixError("p".repeat(30), "too-long", 17).message,
		"Invalid storage prefix: too-long (PostgreSQL allows at most 17 characters)",
	);
});

test("storage identifier rendering keeps fixed domains and immutable caller maps", () => {
	const tables = { meta: "meta", runs: "runs", events: "events", leases: "leases" } as const;
	assert.deepEqual(renderStorageIdentifiers("journal", tables), {
		meta: "wf_meta",
		runs: "wf_runs",
		events: "wf_events",
		leases: "wf_leases",
	});
	const names = renderStorageIdentifiers(
		"sessions",
		{ meta: "meta", sessions: "sessions", entries: "entries" },
		"Tenant_",
	);
	assert.deepEqual(names, {
		meta: "Tenant_session_meta",
		sessions: "Tenant_session_sessions",
		entries: "Tenant_session_entries",
	});
	assert.ok(Object.isFrozen(names));
	assert.equal(tables.meta, "meta");
	assert.equal(renderStorageIdentifiers("journal", tables, "other_").meta, "other_wf_meta");
});

test("schema versions are checked without coercion or migration", () => {
	assertStorageSchemaVersion("sessions", 1, 1);
	for (const found of [0, 2, -1, 1n, "1", null]) {
		assert.throws(
			() => assertStorageSchemaVersion("sessions", found, 1),
			(error: Error) => {
				assert.ok(error instanceof StorageSchemaVersionError);
				assert.equal(error.domain, "sessions");
				assert.equal(error.found, found);
				assert.equal(error.supported, 1);
				return true;
			},
		);
	}
});
