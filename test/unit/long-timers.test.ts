import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
	setLongInterval,
	setLongTimeout,
	setWallTimeoutAt,
	sleepFor,
	sleepUntil,
} from "../../packages/timers/src/index.js";

const NATIVE_LIMIT_MS = 2_147_483_647;
const LONG_WAIT_MS = 3_000_000_000;

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

test("a late timer chunk uses the remaining deadline rather than waiting the original balance (#6807)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const clock = vi.spyOn(performance, "now").mockReturnValue(0);
	const done = vi.fn();
	const pending = sleepUntil(LONG_WAIT_MS).then(done);

	clock.mockReturnValue(LONG_WAIT_MS - 10);
	await vi.advanceTimersByTimeAsync(NATIVE_LIMIT_MS);
	assert.equal(done.mock.calls.length, 0);
	await vi.advanceTimersByTimeAsync(9);
	assert.equal(done.mock.calls.length, 0);
	clock.mockReturnValue(LONG_WAIT_MS);
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(done.mock.calls.length, 1);
	await pending;
});

test("abort clears the pending chunk as soon as a long wait is cancelled (#6807)", async () => {
	vi.useFakeTimers();
	const controller = new AbortController();
	const reason = new Error("Esc");
	const pending = sleepFor(LONG_WAIT_MS, { signal: controller.signal });
	await vi.advanceTimersByTimeAsync(100);
	assert.equal(vi.getTimerCount(), 1);

	controller.abort(reason);
	assert.equal(vi.getTimerCount(), 0);
	await assert.rejects(pending, (error) => error === reason);
});

test("Infinity waits without arming a timer, and still rejects on abort (#6807)", async () => {
	vi.useFakeTimers();
	const controller = new AbortController();
	const pending = sleepFor(Infinity, { signal: controller.signal });
	assert.equal(vi.getTimerCount(), 0);

	controller.abort();
	await assert.rejects(pending, { name: "AbortError" });
});

test("clearing a long interval stops it after its first callback (#6807)", async () => {
	vi.useFakeTimers();
	const tick = vi.fn();
	const interval = setLongInterval(tick, LONG_WAIT_MS);
	await vi.advanceTimersByTimeAsync(LONG_WAIT_MS - 1);
	assert.equal(tick.mock.calls.length, 0);
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(tick.mock.calls.length, 1);
	interval.clear();
	await vi.advanceTimersByTimeAsync(LONG_WAIT_MS);
	assert.equal(tick.mock.calls.length, 1);
});

test("negative and NaN delays run on the next timer turn, and a fractional delay does not fire early (#6807)", async () => {
	vi.useFakeTimers();
	const fired: string[] = [];
	setLongTimeout(() => fired.push("negative"), -100);
	setLongTimeout(() => fired.push("NaN"), NaN);
	setLongTimeout(() => fired.push("fractional"), 2.5);
	assert.deepEqual(fired, []);
	await vi.advanceTimersByTimeAsync(2);
	assert.deepEqual(fired, ["negative", "NaN"]);
	await vi.advanceTimersByTimeAsync(1);
	assert.deepEqual(fired, ["negative", "NaN", "fractional"]);
});

test("wall deadlines catch up after wake without expiring monotonic waits (#6807)", async () => {
	vi.useFakeTimers();
	const wall = vi.fn();
	const relative = vi.fn();
	setWallTimeoutAt(wall, Date.now() + LONG_WAIT_MS);
	setLongTimeout(relative, LONG_WAIT_MS);

	await vi.advanceTimersByTimeAsync(1);
	assert.equal(wall.mock.calls.length, 0);
	vi.setSystemTime(Date.now() + LONG_WAIT_MS);
	await vi.advanceTimersByTimeAsync(1_000);
	assert.equal(wall.mock.calls.length, 1);
	assert.equal(relative.mock.calls.length, 0);
});

test("a backwards wall-clock jump cannot expire a lease before its timestamp (#6807)", async () => {
	vi.useFakeTimers();
	const start = Date.now();
	const expired = vi.fn();
	setWallTimeoutAt(expired, start + 3_000);
	await vi.advanceTimersByTimeAsync(1_000);
	vi.setSystemTime(start - 1_000);
	await vi.advanceTimersByTimeAsync(3_999);
	assert.equal(expired.mock.calls.length, 0);
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(expired.mock.calls.length, 1);
});
