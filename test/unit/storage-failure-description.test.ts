import assert from "node:assert/strict";
import { describeStorageFailure, StorageConfigError, StorageError } from "@bastani/atomic/storage";
import { test } from "vitest";

/** `message` with `fields` and `cause`. */
function failure(message: string, fields: Record<string, string | number> = {}, cause?: Error): Error {
	return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), fields);
}

test("a storage failure is shown as its first line, its innermost cause's first line, and the innermost code (#5113)", () => {
	assert.equal(
		describeStorageFailure(failure("Storage unavailable: postgres at db  \n    at stack")),
		"Storage unavailable: postgres at db",
	);
	assert.equal(
		describeStorageFailure(
			failure(
				"Storage unavailable: postgres at db  \nat x",
				{},
				failure("outer", { code: "OUTER" }, failure("  refused  \nat y", { code: 7 })),
			),
		),
		"Storage unavailable: postgres at db: refused (OUTER)",
	);
	assert.equal(
		describeStorageFailure(failure("Storage unavailable: refused", {}, failure("refused", { code: "ECONNREFUSED" }))),
		"Storage unavailable: refused (ECONNREFUSED)",
	);
	assert.equal(
		describeStorageFailure(
			failure("Storage unavailable (ECONNREFUSED)", {}, failure("refused", { code: "ECONNREFUSED" })),
		),
		"Storage unavailable (ECONNREFUSED): refused",
	);
	assert.equal(
		describeStorageFailure(
			failure("Storage unavailable", {}, new StorageConfigError("sdk", "auth", "auth-unavailable")),
		),
		"Storage unavailable: Invalid storage configuration: auth (auth-unavailable)",
	);
	assert.equal(
		describeStorageFailure(
			failure(
				"Storage unavailable",
				{},
				new StorageError("pool", {
					cause: new StorageConfigError("sdk", "auth", "auth-unavailable", "Install it"),
				}),
			),
		),
		"Storage unavailable: Invalid storage configuration: auth (auth-unavailable). Install it",
	);
});

test("a storage failure's cause chain is followed eight causes deep, also when it is a cycle (#5113)", () => {
	let chain: Error = failure("level 10");
	for (let level = 9; level >= 0; level--) chain = failure(`level ${level}`, {}, chain);
	assert.equal(describeStorageFailure(chain), "level 0: level 8");
	const first = failure("first");
	const second = failure("second", { code: "LOOP" }, first);
	first.cause = second;
	assert.equal(describeStorageFailure(first), "first (LOOP)");
});
