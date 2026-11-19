import assert from "node:assert/strict";
import { test } from "vitest";
import { closeEach, withCleanup } from "../../packages/coding-agent/src/core/storage/cleanup.js";

test("cleanup runs once after the body; a failed cleanup is the error only when the body succeeded (#4325)", async () => {
	const order: string[] = [];
	assert.equal(
		await withCleanup(
			async () => {
				order.push("body");
				return 7;
			},
			async () => {
				order.push("cleanup");
			},
		),
		7,
	);
	assert.deepEqual(order, ["body", "cleanup"]);
	const bodyFailure = new Error("body failed");
	const cleanupFailure = new Error("cleanup failed");
	const both = await withCleanup(
		async () => {
			throw bodyFailure;
		},
		async () => {
			throw cleanupFailure;
		},
	).catch((error: Error) => error);
	assert.equal(both, bodyFailure);
	assert.equal((both as Error & { cleanupCause?: unknown }).cleanupCause, cleanupFailure);
	let cleaned = 0;
	const bodyOnly = await withCleanup(
		async () => {
			throw bodyFailure;
		},
		async () => {
			cleaned++;
		},
	).catch((error: Error) => error);
	assert.deepEqual([bodyOnly, cleaned], [bodyFailure, 1]);
	await assert.rejects(
		withCleanup(
			async () => 1,
			async () => {
				throw cleanupFailure;
			},
		),
		(error: Error) => error === cleanupFailure,
	);
});

test("closing several databases closes all of them and reports every failure (#4325)", async () => {
	const closed: string[] = [];
	const database = (name: string, failure?: Error) => ({
		async close() {
			closed.push(name);
			if (failure !== undefined) throw failure;
		},
	});
	await closeEach([database("a"), database("b")]);
	assert.deepEqual(closed, ["a", "b"]);
	const first = new Error("first");
	await assert.rejects(closeEach([database("c", first), database("d")]), (error: Error) => error === first);
	const second = new Error("second");
	await assert.rejects(closeEach([database("e", first), database("f", second)]), (error: Error) => {
		assert.ok(error instanceof AggregateError);
		assert.deepEqual(error.errors, [first, second]);
		assert.equal(error.message, "2 journal store databases failed to close");
		return true;
	});
	assert.deepEqual(closed, ["a", "b", "c", "d", "e", "f"]);
});
