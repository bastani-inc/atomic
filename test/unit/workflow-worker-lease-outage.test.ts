import assert from "node:assert/strict";
import { StorageUnavailableError } from "@bastani/atomic/storage";
import { test } from "vitest";
import { rehydrateError, serializeError } from "../../packages/workflows/src/shared/error-codec.js";
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
	// The lease is asked after each refusal and again before the next send.
	assert.equal(sends, 2);
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

test("a statement the database cannot run is not sent again, even after crossing a process boundary (#4768)", async () => {
	const tooBig = new StorageUnavailableError(
		{ adapter: "libsql", location: "http://127.0.0.1:1" },
		Object.assign(new Error("SQLITE_TOOBIG: string or blob too big"), { code: "SQLITE_TOOBIG" }),
	);
	for (const error of [tooBig, rehydrateError(serializeError(tooBig))]) {
		let sends = 0;
		await assert.rejects(
			retryWithinLease(
				async () => {
					sends++;
					throw error;
				},
				() => true,
			),
		);
		assert.equal(sends, 1);
	}
	// A busy lock, as it arrives from the coordinator, is sent again.
	let sends = 0;
	const busy = rehydrateError(serializeError(refused()));
	await retryWithinLease(
		async () => {
			if (++sends < 3) throw busy;
		},
		() => true,
	);
	assert.equal(sends, 3);
});

test("a response the server refuses as too large is not sent again, and a request refused past the handoff bound goes to the caller (#4768)", async () => {
	const tooLarge = new StorageUnavailableError(
		{ adapter: "libsql", location: "http://127.0.0.1:1" },
		Object.assign(new Error("RESPONSE_TOO_LARGE: Response is too large"), { code: "RESPONSE_TOO_LARGE" }),
	);
	let sends = 0;
	await assert.rejects(
		retryWithinLease(
			async () => {
				sends++;
				throw rehydrateError(serializeError(tooLarge));
			},
			() => true,
		),
	);
	assert.equal(sends, 1);
	sends = 0;
	await assert.rejects(
		retryWithinLease(
			async () => {
				sends++;
				throw refused();
			},
			() => true,
			"a commit request",
			300,
		),
		StorageUnavailableError,
	);
	assert.ok(sends >= 2, `sent ${sends} times`);
});

test("a request is not sent again once what allowed it ended during the wait before the next send (#4768)", async () => {
	let sends = 0;
	const answers = [true, false];
	await assert.rejects(
		retryWithinLease(
			async () => {
				sends++;
				throw refused();
			},
			() => answers.shift() ?? false,
		),
		StorageUnavailableError,
	);
	assert.equal(sends, 1);
});
