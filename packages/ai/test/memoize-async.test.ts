import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { memoizeAsync } from "../src/utils/memoize-async.js";

describe("memoizeAsync", () => {
	it("clears a rejected flight before callers observe the rejection so immediate retry in catch starts a fresh load", async () => {
		let calls = 0;
		const load = memoizeAsync(async () => {
			calls += 1;
			if (calls === 1) throw new Error("transient-1");
			return `ok-${calls}`;
		});

		const first = load();
		let second: Promise<string> | undefined;
		let recovered: string | undefined;
		try {
			await first;
			assert.fail("first call must reject");
		} catch (error) {
			assert.match(String(error), /transient-1/);
			assert.equal(load.peek(), undefined);
			second = load();
			assert.notEqual(second, first);
			recovered = await second;
		}

		assert.equal(recovered, "ok-2");
		assert.equal(load.peek(), "ok-2");
		assert.equal(await load(), "ok-2");
		assert.equal(calls, 2);
	});

	it("coalesces concurrent callers onto one flight and lets concurrent waiters retry cleanly", async () => {
		let calls = 0;
		let rejectFirst!: (error: Error) => void;
		let resolveSecond!: (value: string) => void;
		const load = memoizeAsync<string>(() => {
			calls += 1;
			if (calls === 1) {
				return new Promise((_resolve, reject) => {
					rejectFirst = reject;
				});
			}
			return new Promise((resolve) => {
				resolveSecond = resolve;
			});
		});

		const p1 = load();
		const p2 = load();
		assert.equal(p1, p2);
		assert.equal(calls, 1);

		const retry = p1.catch(() => load());
		const observed = p2.catch((err) => `err:${(err as Error).message}`);
		rejectFirst(new Error("boom"));

		assert.equal(await observed, "err:boom");
		const p3 = load();
		assert.equal(calls, 2);
		resolveSecond("recovered");
		assert.equal(await retry, "recovered");
		assert.equal(await p3, "recovered");
		assert.equal(calls, 2);
	});

	it("turns synchronous throws into rejected promises without poisoning the cache", async () => {
		let calls = 0;
		const load = memoizeAsync<string>(() => {
			calls += 1;
			if (calls === 1) throw new Error("sync-fail");
			return Promise.resolve("ok");
		});

		const first = load();
		await assert.rejects(() => first, /sync-fail/);
		assert.equal(load.peek(), undefined);
		assert.equal(await load(), "ok");
		assert.equal(load.peek(), "ok");
		assert.equal(calls, 2);
	});

	it("never lets a superseded flight after reset() clobber a newer flight or populate peek()", async () => {
		let calls = 0;
		let resolve1!: (value: string) => void;
		let reject2!: (error: Error) => void;
		let resolve3!: (value: string) => void;
		const load = memoizeAsync<string>(() => {
			calls += 1;
			if (calls === 1) {
				return new Promise((resolve) => {
					resolve1 = resolve;
				});
			}
			if (calls === 2) {
				return new Promise((_resolve, reject) => {
					reject2 = reject;
				});
			}
			return new Promise((resolve) => {
				resolve3 = resolve;
			});
		});

		const f1 = load();
		load.reset();
		const f2 = load();
		resolve1("stale-1");
		assert.equal(await f1, "stale-1");
		assert.equal(load.peek(), undefined);

		load.reset();
		const f3 = load();
		reject2(new Error("stale-2"));
		await assert.rejects(() => f2, /stale-2/);
		assert.equal(load(), f3);
		resolve3("fresh-3");
		assert.equal(await f3, "fresh-3");
		assert.equal(load.peek(), "fresh-3");
		assert.equal(calls, 3);
	});

	it("respects shouldCache for uncacheable sentinels, throwing predicates, and cached values", async () => {
		let calls = 0;
		const load = memoizeAsync<string | null>(
			async () => {
				calls += 1;
				if (calls === 1) return null;
				if (calls === 2) return "bad-predicate";
				return "good";
			},
			{
				shouldCache: (value) => {
					if (value === "bad-predicate") throw new Error("predicate-error");
					return value !== null;
				},
			},
		);

		assert.equal(await load(), null);
		assert.equal(load.peek(), undefined);
		await assert.rejects(() => load(), /predicate-error/);
		assert.equal(load.peek(), undefined);
		assert.equal(await load(), "good");
		assert.equal(load.peek(), "good");
		assert.equal(await load(), "good");
		assert.equal(calls, 3);
	});
});
