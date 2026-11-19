import assert from "node:assert/strict";
import { test } from "vitest";
import { withCleanup } from "../../packages/coding-agent/src/core/storage/cleanup.js";

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
