import assert from "node:assert/strict";
import { StorageUnavailableError } from "@bastani/atomic/storage";
import { test } from "vitest";
import { retryWithinLease } from "../../packages/workflows/src/workers/lease-outage.js";

const refused = () =>
	new StorageUnavailableError(
		{ adapter: "libsql", location: "http://127.0.0.1:1" },
		Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
	);

test("a request the storage refuses is sent again while the attempt's lease lasts, and fails once it is gone (#4768)", async () => {
	let sends = 0;
	const value = await retryWithinLease(
		async () => {
			if (++sends < 4) throw refused();
			return "taken";
		},
		() => true,
	);
	assert.equal(value, "taken");
	assert.equal(sends, 4);
	sends = 0;
	let left = 2;
	await assert.rejects(
		retryWithinLease(
			async () => {
				sends++;
				throw refused();
			},
			() => left-- > 0,
		),
		StorageUnavailableError,
	);
	assert.equal(sends, 3);
});

test("a failure that is not the storage refusing goes to the caller at once (#4768)", async () => {
	let sends = 0;
	await assert.rejects(
		retryWithinLease(
			async () => {
				sends++;
				throw new Error("Pool checkpoint identity conflict");
			},
			() => true,
		),
		/identity conflict/,
	);
	assert.equal(sends, 1);
});
