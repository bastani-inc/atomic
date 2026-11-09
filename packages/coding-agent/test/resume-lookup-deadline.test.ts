import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { isResumeCatalogTimeoutError, isRetryableResumeError } from "../src/core/resume/errors.ts";
import { withResumeLookupDeadline } from "../src/core/resume/not-found.ts";

const target = { subject: "session" as const, id: "abc", storage: "libsql" };

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

for (const outcome of ["resolve", "reject"] as const) {
	test(`the lookup deadline clears its own timer after ${outcome} without touching other timers (#4329)`, async () => {
		let unrelatedCalls = 0;
		setTimeout(() => unrelatedCalls++, 2000);
		const schedule = vi.spyOn(globalThis, "setTimeout");
		const clear = vi.spyOn(globalThis, "clearTimeout");
		const failure = new TypeError("x");
		const lookup = outcome === "resolve" ? Promise.resolve(7) : Promise.reject(failure);
		const pending = withResumeLookupDeadline(lookup, target, 1000);
		const timer = schedule.mock.results[0].value;
		if (outcome === "resolve") assert.equal(await pending, 7);
		else await assert.rejects(pending, (error) => error === failure);
		assert.ok(clear.mock.calls.some(([handle]) => handle === timer));
		assert.equal(vi.getTimerCount(), 1);
		await vi.advanceTimersByTimeAsync(2000);
		assert.equal(unrelatedCalls, 1);
		assert.equal(vi.getTimerCount(), 0);
	});
}

test("the lookup stays pending until its deadline and fails typed and retryable (#4329)", async () => {
	let unrelatedCalls = 0;
	setTimeout(() => unrelatedCalls++, 1000);
	setTimeout(() => unrelatedCalls++, 1000);
	const schedule = vi.spyOn(globalThis, "setTimeout");
	const clear = vi.spyOn(globalThis, "clearTimeout");
	let settled = false;
	const pending = withResumeLookupDeadline(new Promise<never>(() => {}), target, 40).then(
		() => assert.fail("the lookup never answers"),
		(error: unknown) => {
			settled = true;
			return error;
		},
	);
	const timer = schedule.mock.results[0].value;
	await vi.advanceTimersByTimeAsync(39);
	assert.equal(settled, false);
	assert.equal(
		clear.mock.calls.some(([handle]) => handle === timer),
		false,
	);
	await vi.advanceTimersByTimeAsync(1);
	const error = await pending;
	assert.ok(isResumeCatalogTimeoutError(error));
	assert.deepEqual(
		[error.code, error.retryable, error.phase, error.timeoutMs, error.elapsedMs, error.id, error.storage],
		["catalog-timeout", true, "catalog-lookup", 40, 40, "abc", "libsql"],
	);
	assert.ok(isRetryableResumeError(error));
	assert.match(error.message, /^Cannot look up the session abc: the storage \(libsql\) did not answer within 40 ms/);
	assert.ok(clear.mock.calls.some(([handle]) => handle === timer));
	await vi.advanceTimersByTimeAsync(960);
	assert.equal(unrelatedCalls, 2);
	assert.equal(vi.getTimerCount(), 0);
});
