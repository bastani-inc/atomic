import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	DBOS_LAUNCH_LOCK_KEY,
	type LaunchLockClient,
	withDbosLaunchLock,
} from "../../packages/workflows/src/durable/dbos-launch-lock.js";

class FakeAdvisoryLocks {
	holder: object | undefined;
	readonly queries: string[] = [];

	connect(): LaunchLockClient {
		const session = {};
		let ended = false;
		return {
			query: async (text: string, values?: readonly unknown[]) => {
				assert.equal(ended, false, "query after end");
				this.queries.push(text);
				assert.deepEqual(values, [DBOS_LAUNCH_LOCK_KEY]);
				if (text.includes("pg_try_advisory_lock")) {
					const acquired = this.holder === undefined || this.holder === session;
					if (acquired) this.holder = session;
					return { rows: [{ locked: acquired }] };
				}
				if (text.includes("pg_advisory_unlock")) {
					if (this.holder === session) this.holder = undefined;
					return { rows: [{ locked: false }] };
				}
				throw new Error(`unexpected query ${text}`);
			},
			end: async () => {
				ended = true;
				if (this.holder === session) this.holder = undefined;
			},
		};
	}
}

const fastPolling = { pollIntervalMs: 5, maxWaitMs: 2_000 } as const;

describe("DBOS launch advisory lock", () => {
	test("serializes concurrent launches against the same database", async () => {
		const locks = new FakeAdvisoryLocks();
		const timeline: string[] = [];
		const launch = (name: string) => async () => {
			timeline.push(`${name}:start`);
			await new Promise((resolve) => setTimeout(resolve, 30));
			timeline.push(`${name}:end`);
		};

		await Promise.all(
			["a", "b", "c"].map((name) =>
				withDbosLaunchLock("postgresql://db/x", launch(name), {
					...fastPolling,
					connect: async () => locks.connect(),
				}),
			),
		);

		for (let index = 0; index < timeline.length; index += 2) {
			const [start, end] = [timeline[index], timeline[index + 1]];
			assert.equal(start?.split(":")[0], end?.split(":")[0], `overlapping launches: ${timeline.join(", ")}`);
		}
		assert.equal(locks.holder, undefined);
	});

	test("polls with pg_try_advisory_lock and never blocks in pg_advisory_lock", async () => {
		const locks = new FakeAdvisoryLocks();
		const other = locks.connect();
		await other.query("SELECT pg_try_advisory_lock($1) AS locked", [DBOS_LAUNCH_LOCK_KEY]);
		setTimeout(() => void other.end(), 40);

		await withDbosLaunchLock("postgresql://db/x", async () => {}, {
			...fastPolling,
			connect: async () => locks.connect(),
		});

		assert.ok(locks.queries.filter((query) => query.includes("pg_try_advisory_lock")).length > 2);
		assert.equal(
			locks.queries.some((query) => /pg_advisory_lock\(/.test(query)),
			false,
		);
	});

	test("releases the lock and closes the connection when launch fails", async () => {
		const locks = new FakeAdvisoryLocks();
		let ended = false;

		await assert.rejects(
			withDbosLaunchLock(
				"postgresql://db/x",
				async () => {
					throw new Error("launch failed");
				},
				{
					...fastPolling,
					connect: async () => {
						const client = locks.connect();
						return {
							query: client.query,
							end: async () => {
								ended = true;
								await client.end();
							},
						};
					},
				},
			),
			/launch failed/,
		);

		assert.equal(ended, true);
		assert.equal(locks.holder, undefined);
		assert.ok(locks.queries.some((query) => query.includes("pg_advisory_unlock")));
	});

	test("launches without the lock when the lock connection cannot be opened", async () => {
		let launched = false;

		await withDbosLaunchLock(
			"postgresql://db/x",
			async () => {
				launched = true;
			},
			{
				...fastPolling,
				connect: async () => {
					throw new Error("ECONNREFUSED");
				},
			},
		);

		assert.equal(launched, true);
	});

	test("launches without the lock after the bounded wait", async () => {
		const locks = new FakeAdvisoryLocks();
		const stuck = locks.connect();
		await stuck.query("SELECT pg_try_advisory_lock($1) AS locked", [DBOS_LAUNCH_LOCK_KEY]);
		let launched = false;
		const started = performance.now();

		await withDbosLaunchLock(
			"postgresql://db/x",
			async () => {
				launched = true;
			},
			{ pollIntervalMs: 5, maxWaitMs: 60, connect: async () => locks.connect() },
		);

		assert.equal(launched, true);
		assert.ok(performance.now() - started >= 60);
		await stuck.end();
	});
});
