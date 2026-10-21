import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { Credential } from "@bastani/pi-ai";
import { afterEach, test, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "../../../test/helpers/runtime.ts";
import { TEST_TIMEOUT_MS } from "../../../test/helpers/test-timeout.ts";
import { OAUTH_REFRESH_LOCK_HOLD_MS } from "../../ai/src/auth/resolve.ts";
import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";

const PROVIDER = "openai-1";

/** Fake time advanced per step while the holder keeps the lock; real file-system work for the locks runs between steps. */
const FAKE_CLOCK_STEP_MS = 1_000;

/** Real event-loop turns given to lock file I/O after each fake-clock step. */
const IO_TURNS_PER_STEP = 5;

/** Bounded real-time waits in one test; each gets an equal share of the per-test budget. */
const BOUNDED_WAITS_PER_TEST = 3;

/**
 * Real (unfaked) time a wait gives lock file I/O to reach the state it expects. Lock I/O runs on the libuv
 * threadpool, which a loaded CI runner can delay far beyond any fixed number of event-loop turns, so waits are
 * bounded in real time. Splitting the per-test budget makes a stuck wait fail with its own message, not a timeout.
 */
const LOCK_IO_SETTLE_MS = TEST_TIMEOUT_MS / (BOUNDED_WAITS_PER_TEST + 1);

const rotated: Credential = { type: "oauth", access: "fake-access-2", refresh: "fake-refresh-2", expires: 1 };

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function letLockIoRun(): Promise<void> {
	for (let turn = 0; turn < IO_TURNS_PER_STEP; turn++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

async function advanceFakeClock(ms: number): Promise<void> {
	for (let elapsed = 0; elapsed < ms; elapsed += FAKE_CLOCK_STEP_MS) {
		await vi.advanceTimersByTimeAsync(FAKE_CLOCK_STEP_MS);
		await letLockIoRun();
	}
}

/**
 * Lets real lock I/O run until `reached()` holds, failing after LOCK_IO_SETTLE_MS of real time. With
 * `fireSleepingTimers`, a fake timer that is pending while no I/O is in flight (a poll sleep) is fired, so fake
 * time advances only as far as the code under test actually sleeps, never ahead of its file-system work.
 */
async function waitUntil(reached: () => boolean, what: string, fireSleepingTimers = false): Promise<void> {
	const deadline = performance.now() + LOCK_IO_SETTLE_MS;
	while (!reached()) {
		assert.ok(performance.now() < deadline, `${what} within ${LOCK_IO_SETTLE_MS} ms`);
		await letLockIoRun();
		if (fireSleepingTimers && !reached() && vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
	}
}

type Settled = { state: "pending" } | { state: "fulfilled" } | { state: "rejected"; error: Error };

function track(promise: Promise<object>): { readonly current: Settled } {
	const tracked: { current: Settled } = { current: { state: "pending" } };
	promise.then(
		() => {
			tracked.current = { state: "fulfilled" };
		},
		(error: Error) => {
			tracked.current = { state: "rejected", error };
		},
	);
	return tracked;
}

/** Another session holding the provider lock (heartbeating it) until `release` is called. */
async function holdProviderLock(authPath: string) {
	let holding = false;
	const release = gate();
	const done = new FileAuthStorageBackend(authPath).modifyProviderAsync(PROVIDER, async () => {
		holding = true;
		await release.promise;
		return rotated;
	});
	await waitUntil(() => holding, "the holder takes the free provider lock");
	return { release: release.release, done: track(done), settled: done.catch(() => undefined) };
}

afterEach(() => {
	vi.useRealTimers();
});

test("a session waiting for the provider lock outlasts a holder that keeps it for the whole refresh hold", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const directory = makeTempDirectory("oauth-provider-lock-wait-");
	const authPath = `${directory}/auth.json`;
	const holder = await holdProviderLock(authPath);
	try {
		let seen: Credential | undefined;
		const waiter = track(
			new FileAuthStorageBackend(authPath).modifyProviderAsync(PROVIDER, async (current) => {
				seen = current;
				return undefined;
			}),
		);

		await advanceFakeClock(OAUTH_REFRESH_LOCK_HOLD_MS);
		assert.deepEqual(
			waiter.current,
			{ state: "pending" },
			"the waiter gave up while the holder was still refreshing",
		);

		holder.release();
		await waitUntil(() => holder.done.current.state !== "pending", "the holder commits and releases the lock");
		assert.deepEqual(holder.done.current, { state: "fulfilled" });
		await waitUntil(() => waiter.current.state !== "pending", "the waiter takes the released lock", true);
		assert.deepEqual(waiter.current, { state: "fulfilled" });
		assert.deepEqual(seen, rotated, "the waiter reads the credential the holder committed");
	} finally {
		holder.release();
		await holder.settled;
		vi.useRealTimers();
		removeTempDirectory(directory);
	}
});

test("a session waiting for the provider lock stops waiting when its lock wait is cancelled", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const directory = makeTempDirectory("oauth-provider-lock-cancel-");
	const authPath = `${directory}/auth.json`;
	const holder = await holdProviderLock(authPath);
	try {
		const lockWait = new AbortController();
		const reason = new Error("caller stopped waiting");
		let ran = false;
		const timersBeforeWaiter = vi.getTimerCount();
		const waiter = track(
			new FileAuthStorageBackend(authPath).modifyProviderAsync(
				PROVIDER,
				async () => {
					ran = true;
					return undefined;
				},
				lockWait.signal,
			),
		);
		// The waiter found the lock held and is sleeping until its next poll.
		await waitUntil(() => vi.getTimerCount() > timersBeforeWaiter, "the waiter starts polling the held lock");

		// No fake time passes: the cancellation must end the poll sleep itself, not wait for it to elapse.
		lockWait.abort(reason);
		await waitUntil(() => waiter.current.state !== "pending", "the cancelled waiter stops waiting");

		assert.equal(waiter.current.state, "rejected");
		assert.equal(waiter.current.state === "rejected" ? waiter.current.error : undefined, reason);
		assert.equal(ran, false);
	} finally {
		holder.release();
		await holder.settled;
		vi.useRealTimers();
		removeTempDirectory(directory);
	}
});
