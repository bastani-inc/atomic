import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
	armDeferredHostCompileCacheFlush,
	flushDeferredHostCompileCache,
} from "../src/utils/deferred-compile-cache-flush.ts";

afterEach(() => {
	// Ensure no armed state leaks between tests.
	flushDeferredHostCompileCache(() => {});
});

describe("deferred host compile-cache flush", () => {
	test("is a no-op when not armed", () => {
		let calls = 0;
		assert.equal(
			flushDeferredHostCompileCache(() => {
				calls++;
			}),
			false,
		);
		assert.equal(calls, 0);
	});

	test("flushes exactly once after being armed, and later calls are no-ops until re-armed", () => {
		let calls = 0;
		const flush = () => {
			calls++;
		};
		armDeferredHostCompileCacheFlush();
		armDeferredHostCompileCacheFlush();
		assert.equal(flushDeferredHostCompileCache(flush), true);
		assert.equal(calls, 1);
		assert.equal(flushDeferredHostCompileCache(flush), false);
		assert.equal(calls, 1);

		armDeferredHostCompileCacheFlush();
		assert.equal(flushDeferredHostCompileCache(flush), true);
		assert.equal(calls, 2);
	});
});
