import assert from "node:assert/strict";
import type { Credential } from "@bastani/pi-ai";
import { afterEach, test, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "../../../test/helpers/runtime.ts";
import { OAUTH_REFRESH_LOCK_HOLD_MS } from "../../ai/src/auth/resolve.ts";
import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";

const PROVIDER = "openai-1";

/** Fake time advanced per step; real file-system work for the locks runs between steps. */
const FAKE_CLOCK_STEP_MS = 1_000;

/** Real event-loop turns given to lock file I/O after each fake-clock step. */
const IO_TURNS_PER_STEP = 5;

/** Steps allowed for a released lock to reach the waiter: its longest poll interval is a few seconds. */
const MAX_STEPS_UNTIL_ACQUIRED = 60;

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
	const holding = gate();
	const release = gate();
	const done = new FileAuthStorageBackend(authPath).modifyProviderAsync(PROVIDER, async () => {
		holding.release();
		await release.promise;
		return rotated;
	});
	while (!(await Promise.race([holding.promise.then(() => true), letLockIoRun().then(() => false)]))) {
		await vi.advanceTimersByTimeAsync(0);
	}
	return { release: release.release, done };
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
		for (let step = 0; step < MAX_STEPS_UNTIL_ACQUIRED && waiter.current.state === "pending"; step++) {
			await advanceFakeClock(FAKE_CLOCK_STEP_MS);
		}
		assert.deepEqual(waiter.current, { state: "fulfilled" });
		assert.deepEqual(seen, rotated, "the waiter reads the credential the holder committed");
	} finally {
		holder.release();
		await holder.done.catch(() => undefined);
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
		await advanceFakeClock(FAKE_CLOCK_STEP_MS);

		lockWait.abort(reason);
		await advanceFakeClock(FAKE_CLOCK_STEP_MS);

		assert.equal(waiter.current.state, "rejected");
		assert.equal(waiter.current.state === "rejected" ? waiter.current.error : undefined, reason);
		assert.equal(ran, false);
	} finally {
		holder.release();
		await holder.done.catch(() => undefined);
		vi.useRealTimers();
		removeTempDirectory(directory);
	}
});
