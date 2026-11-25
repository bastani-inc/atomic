import assert from "node:assert/strict";

export const SHA = /\b[0-9a-f]{40}\b/g;

export async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	assert.fail("expected a rejection");
}
