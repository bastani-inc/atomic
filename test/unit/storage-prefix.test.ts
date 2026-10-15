import assert from "node:assert/strict";
import { test } from "vitest";
import { StoragePrefixError, StorageSchemaVersionError } from "../../packages/coding-agent/src/core/storage/errors.js";
import {
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
