import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { ConcurrencyLimiter, createRunLimiter } from "../../packages/workflows/src/runs/shared/concurrency.js";

describe("ConcurrencyLimiter", () => {
	test("throws for limit < 1", () => {
		assert.throws(() => new ConcurrencyLimiter(0), { message: /positive integer/ });
		assert.throws(() => new ConcurrencyLimiter(-1), { message: /positive integer/ });
	});

	test("throws for non-integer limit", () => {
		assert.throws(() => new ConcurrencyLimiter(1.5), { message: /positive integer/ });
	});

	test("exposes limit, running, queued properties", async () => {
		const lim = new ConcurrencyLimiter(2);
		assert.equal(lim.limit, 2);
		assert.equal(lim.running, 0);
		assert.equal(lim.queued, 0);

		await lim.acquire();
		assert.equal(lim.running, 1);
		lim.release();
		assert.equal(lim.running, 0);
	});

	test("allows up to limit concurrent acquires without blocking", async () => {
		const lim = new ConcurrencyLimiter(3);
		await lim.acquire();
		await lim.acquire();
		await lim.acquire();
		assert.equal(lim.running, 3);
		assert.equal(lim.queued, 0);
		lim.release();
		lim.release();
		lim.release();
		assert.equal(lim.running, 0);
	});

	test("queues acquires beyond limit", async () => {
		const lim = new ConcurrencyLimiter(1);

		await lim.acquire(); // fills the only slot

		let resolved = false;
		const waiter = lim.acquire().then(() => {
			resolved = true;
		});

		// Before release — waiter should not have resolved yet
		await Promise.resolve(); // flush microtasks
		assert.equal(resolved, false);
		assert.equal(lim.queued, 1);

		lim.release(); // unblock the waiter

		await waiter;
		assert.equal(resolved, true);
		assert.equal(lim.running, 1); // slot handed directly to waiter
		lim.release();
		assert.equal(lim.running, 0);
	});

	test("run() wraps acquire/release around async fn", async () => {
		const lim = new ConcurrencyLimiter(2);
		const order: string[] = [];

		await Promise.all([
			lim.run(async () => {
				order.push("a");
				return "a";
			}),
			lim.run(async () => {
				order.push("b");
				return "b";
			}),
		]);

		assert.ok(order.includes("a"));
		assert.ok(order.includes("b"));
		assert.equal(lim.running, 0);
	});

	test("run() releases slot even when fn throws", async () => {
		const lim = new ConcurrencyLimiter(1);

		await assert.rejects(
			lim.run(async () => {
				throw new Error("boom");
			}),
			{ message: /boom/ },
		);

		assert.equal(lim.running, 0);

		// Slot should be available again
		const result = await lim.run(async () => "ok");
		assert.equal(result, "ok");
	});

	test("enforces serialization with limit=1", async () => {
		const lim = new ConcurrencyLimiter(1);
		const concurrentPeak = { value: 0 };
		let active = 0;
		let maxSeen = 0;

		const task = async (): Promise<void> => {
			await lim.acquire();
			active++;
			maxSeen = Math.max(maxSeen, active);
			// yield to allow other tasks to interleave if limit is broken
			await new Promise<void>((r) => setTimeout(r, 1));
			active--;
			lim.release();
		};

		await Promise.all([task(), task(), task()]);
		concurrentPeak.value = maxSeen;

		assert.equal(concurrentPeak.value, 1);
	});

	test("enforces limit=2 — never exceeds two concurrent tasks", async () => {
		const lim = new ConcurrencyLimiter(2);
		let active = 0;
		let maxSeen = 0;

		const task = async (): Promise<void> => {
			await lim.acquire();
			active++;
			maxSeen = Math.max(maxSeen, active);
			await new Promise<void>((r) => setTimeout(r, 1));
			active--;
			lim.release();
		};

		await Promise.all([task(), task(), task(), task(), task()]);

		assert.ok(maxSeen <= 2);
	});
});

describe("createRunLimiter", () => {
	test("uses provided defaultConcurrency", () => {
		const lim = createRunLimiter(3);
		assert.equal(lim.limit, 3);
	});

	test("defaults to 4 when no value provided", () => {
		const lim = createRunLimiter();
		assert.equal(lim.limit, 4);
	});

	test("defaults to 4 when undefined", () => {
		const lim = createRunLimiter(undefined);
		assert.equal(lim.limit, 4);
	});
});
