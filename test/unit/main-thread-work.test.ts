import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "vitest";
import { longestMainThreadBlockMs } from "../helpers/main-thread-work.js";

const BLOCK_LIMIT_MS = 50;
const BLOCKING_WORK_MS = 80;
const MICROTASK_SEGMENTS = 4;
const OUTSIDE_WORK_DELAY_MS = 10;

function blockMainThread(durationMs: number): void {
	const end = performance.now() + durationMs;
	while (performance.now() < end) {}
}

test("main-thread work excludes warm-up activity outside the requested operation (#5324)", async () => {
	const beforeWork = sleep(OUTSIDE_WORK_DELAY_MS).then(() => blockMainThread(BLOCKING_WORK_MS));
	const blockedMs = await longestMainThreadBlockMs(async () => {});
	await beforeWork;
	assert.ok(blockedMs < BLOCK_LIMIT_MS, `unrelated warm-up was counted as ${blockedMs} ms of work`);
});

test("main-thread work still detects a blocking operation (#5324)", async () => {
	const blockedMs = await longestMainThreadBlockMs(async () => {
		blockMainThread(BLOCKING_WORK_MS);
	});
	assert.ok(blockedMs >= BLOCK_LIMIT_MS, `only ${blockedMs} ms of blocking work was recorded`);
});

test("main-thread work accumulates microtasks until the event loop can run (#5324)", async () => {
	const blockedMs = await longestMainThreadBlockMs(async () => {
		for (let index = 0; index < MICROTASK_SEGMENTS; index++) {
			blockMainThread(BLOCKING_WORK_MS / MICROTASK_SEGMENTS);
			await Promise.resolve();
		}
	});
	assert.ok(blockedMs >= BLOCK_LIMIT_MS, `only ${blockedMs} ms of a starving microtask chain was recorded`);
});

test("main-thread work does not count asynchronous waiting as blocking (#5324)", async () => {
	const blockedMs = await longestMainThreadBlockMs(async () => {
		await sleep(BLOCKING_WORK_MS);
	});
	assert.ok(blockedMs < BLOCK_LIMIT_MS, `${blockedMs} ms of asynchronous waiting was counted as blocking`);
});
