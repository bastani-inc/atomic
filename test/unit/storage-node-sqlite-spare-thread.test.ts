import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as realSleep } from "node:timers/promises";
import { afterEach, test, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * While a connection is open, one thread is started ahead of the next open, so that open does not wait for a thread to
 * start (#5376). There is never more than one, and none is left once every connection closed.
 */

/** How long, in real milliseconds, a test waits for a thread to start or exit; far more than either takes. */
const THREAD_WAIT_MS = 10_000;

const threads = vi.hoisted(() => ({ started: 0, live: new Set<object>() }));

vi.mock("node:worker_threads", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:worker_threads")>();
	class CountedWorker extends actual.Worker {
		constructor(...args: ConstructorParameters<typeof actual.Worker>) {
			super(...args);
			threads.started += 1;
			threads.live.add(this);
			this.once("exit", () => threads.live.delete(this));
		}
	}
	return { ...actual, Worker: CountedWorker };
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(done: () => boolean, what: string): Promise<void> {
	const started = performance.now();
	while (!done() && performance.now() - started < THREAD_WAIT_MS) await realSleep(1);
	assert.ok(done(), what);
}

async function adapter() {
	// The test setup loads the adapter before this file's counted threads apply; load it again with them.
	vi.resetModules();
	return import("../../packages/coding-agent/src/core/storage/node-sqlite.js");
}

function directory(): string {
	const made = makeTempDirectory("node-sqlite-spare-");
	cleanups.push(() => removeTempDirectory(made));
	return made;
}

test("a connection opened while another is open takes the thread started ahead of it, and none is left once stopped (#5376)", async () => {
	const { openNodeSqliteDatabase, stopSpareConnectionThread } = await adapter();
	cleanups.push(stopSpareConnectionThread);
	const where = directory();
	threads.started = 0;
	const first = await openNodeSqliteDatabase(join(where, "first.sqlite"));
	await until(() => threads.started === 2, "a thread was started ahead of the next open");
	const second = await openNodeSqliteDatabase(join(where, "second.sqlite"));
	assert.equal(await second.get<{ one: number }>("SELECT 1 AS one").then((row) => row?.one), 1);
	// The second open took the thread started ahead of it; one more is started for the open after it, never two.
	await until(() => threads.started === 3, "one thread was started ahead of the open after it");
	await realSleep(50);
	assert.equal(threads.started, 3, "never more than one thread is started ahead");
	await first.close();
	await second.close();
	assert.equal(threads.live.size, 1, "the thread started ahead waits for a while after the last close");
	await stopSpareConnectionThread();
	assert.equal(threads.live.size, 0, "stopping it leaves no thread");
});

test("an open soon after the last close takes the thread started ahead of it, and none is left once it waited its time (#5376)", async () => {
	const { openNodeSqliteDatabase, SPARE_THREAD_IDLE_MS, stopSpareConnectionThread } = await adapter();
	cleanups.push(stopSpareConnectionThread);
	const where = directory();
	const only = await openNodeSqliteDatabase(join(where, "only.sqlite"));
	await until(() => threads.live.size === 2, "a thread was started ahead of the next open");
	await only.close();
	assert.equal(threads.live.size, 1);
	threads.started = 0;
	const again = await openNodeSqliteDatabase(join(where, "again.sqlite"));
	assert.equal(threads.live.size >= 1 && threads.started <= 1, true, "the open took the waiting thread");
	await until(() => threads.started === 1, "one thread was started ahead of the open after it");
	await again.close();
	await realSleep(SPARE_THREAD_IDLE_MS);
	await until(() => threads.live.size === 0, "no thread is left once the thread started ahead waited its time");
});
