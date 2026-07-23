import { test } from "bun:test";
import assert from "node:assert/strict";
import { createRetryScheduler } from "../../packages/subagents/src/runs/background/result-retry-scheduler.js";

test("retry scheduler uses capped exponential one-shot delays and clear resets progress", () => {
	const queued: Array<{ delay: number; callback: () => void; cleared: boolean }> = [];
	const timers = {
		setTimeout: ((callback: () => void, delay: number) => {
			const timer = { delay, callback, cleared: false, unref() {} };
			queued.push(timer);
			return timer;
		}) as never,
		clearTimeout: ((timer: { cleared: boolean }) => { timer.cleared = true; }) as never,
	};
	const scheduler = createRetryScheduler(timers, 250, 1_000);
	for (const expected of [250, 500, 1_000, 1_000]) {
		assert.equal(scheduler.schedule("result.json", () => {}), true);
		assert.equal(queued.at(-1)?.delay, expected);
		assert.equal(scheduler.schedule("result.json", () => {}), false, "only one recheck may be active per file");
		queued.at(-1)?.callback();
	}
	assert.equal(scheduler.attempt("result.json"), 4);
	scheduler.clear("result.json");
	assert.equal(scheduler.attempt("result.json"), 0);
	assert.equal(scheduler.schedule("result.json", () => {}), true);
	assert.equal(queued.at(-1)?.delay, 250);
});

test("clear and clearAll cancel pending one-shot retries", () => {
	const queued: Array<{ callback: () => void; cleared: boolean }> = [];
	const timers = {
		setTimeout: ((callback: () => void) => {
			const timer = { callback, cleared: false, unref() {} };
			queued.push(timer);
			return timer;
		}) as never,
		clearTimeout: ((timer: { cleared: boolean }) => { timer.cleared = true; }) as never,
	};
	const scheduler = createRetryScheduler(timers, 1, 10);
	scheduler.schedule("one", () => {});
	scheduler.schedule("two", () => {});
	scheduler.clear("one");
	scheduler.clearAll();
	assert.deepEqual(queued.map((timer) => timer.cleared), [true, true]);
	assert.equal(scheduler.has("one"), false);
	assert.equal(scheduler.has("two"), false);
});
