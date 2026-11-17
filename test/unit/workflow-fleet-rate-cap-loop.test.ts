import assert from "node:assert/strict";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { test, vi } from "vitest";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRateBuckets } from "../../packages/workflows/src/durable/journal/sql-rate-buckets.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import { FleetController } from "../../packages/workflows/src/workers/fleet-controller.js";
import { FleetRateLimiter } from "../../packages/workflows/src/workers/fleet-rate-limits.js";
import type { ProvisionedHost, WorkerHostProvisioner } from "../../packages/workflows/src/workers/fleet-types.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";

const clock = vi.hoisted(() => ({ now: 1_800_000_000_000 }));
vi.mock("node:sqlite", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:sqlite")>();
	class FleetClockDatabase extends actual.DatabaseSync {
		constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
			super(...args);
			this.function("unixepoch", { varargs: true }, () => clock.now / 1_000);
			this.function("julianday", { varargs: true }, () => clock.now / 86_400_000 + 2_440_587.5);
		}
	}
	return { ...actual, DatabaseSync: FleetClockDatabase };
});

for (const initialHosts of [3, 8]) {
	test(`a fleet starting with ${initialHosts} hosts follows real token-waiting traffic with the default growth delay and through failover (#4768)`, async () => {
		clock.now = 1_800_000_000_000;
		vi.useFakeTimers({
			toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		});
		vi.setSystemTime(clock.now);
		const database = await openNodeSqliteDatabase(":memory:");
		const journal = await SqlRunJournal.open(database);
		const controllers: FleetController[] = [];
		const limiters: FleetRateLimiter[] = [];
		try {
			await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: clock.now, status: "running" });
			const acquired = await journal.acquire("root", "owner");
			if (acquired.status !== "acquired") assert.fail("root lease was not acquired");
			const lease = acquired.lease;
			const queue = await openSqlPoolQueue(journal);
			await queue.initialize(lease, 600_000);
			const shared = await SqlSharedPool.open(journal, queue);
			const limits = { p: { requestsPerMinute: 60, burst: 1, prefetch: 1 } };
			await shared.publishConfig(lease, {
				definitions: [],
				leaseMs: 600_000,
				heartbeatMs: 15_000,
				startupTimeoutMs: 60_000,
				claimWindowMs: 60_000,
				rateLimits: limits,
			});
			for (let index = 0; index < 80; index++) {
				const { work, boundary } = poolWorkFixture(`child-${index}`);
				await queue.enqueue(lease, work, boundary);
			}
			const buckets = await SqlRateBuckets.open(journal);
			const hosts: ProvisionedHost[] = [];
			const workers: {
				worker: string;
				limiter: FleetRateLimiter;
				due: number;
				work: NonNullable<Awaited<ReturnType<typeof queue.claim>>>;
				active: boolean;
			}[] = [];
			const report = async (index: number) =>
				shared.reportHost({
					host: `h${index}`,
					providerId: `vm${index}`,
					labels: {},
					git: "unavailable",
					restore: false,
					workers: 4,
					maxWorkers: 4,
					busy: workers.filter((worker) => worker.active && worker.worker.startsWith(`h${index}/`)).length,
					roots: ["root"],
				});
			const add = async (target: number) => {
				while (hosts.length < target) {
					const index = hosts.length;
					hosts.push({ id: `vm${index}`, state: "running", since: clock.now });
					const limiter = new FleetRateLimiter({
						store: buckets,
						limits,
						slots: 4,
						shareCooldowns: false,
						applyCooldowns: () => {},
					});
					limiters.push(limiter);
					for (let slot = 0; slot < 4; slot++) {
						const worker = `h${index}/w${slot}`;
						const work = await queue.claim(lease, worker, [poolWorkFixture().work], 600_000);
						assert.ok(work);
						workers.push({ worker, work, limiter, due: clock.now, active: true });
					}
					await report(index);
				}
			};
			await add(initialHosts);
			const targets: number[] = [];
			const provisioner: WorkerHostProvisioner = {
				kind: "closed-loop",
				async list() {
					return [...hosts];
				},
				async scaleTo(target) {
					targets.push(target);
					await add(target);
				},
				async drain() {},
			};
			const start = () => {
				const controller = new FleetController(journal, {
					provisioner,
					maxHosts: 20,
					workersPerHost: 4,
					idleDrainMs: 600_000,
					drainIdleOnStop: true,
				});
				controllers.push(controller);
				return controller;
			};
			const leader = start();
			await vi.advanceTimersByTimeAsync(0);
			const advance = async (seconds: number) => {
				for (let second = 0; second < seconds; second++) {
					clock.now += 1_000;
					await vi.advanceTimersByTimeAsync(1_000);
					for (const worker of workers) {
						if (!worker.active || worker.due > clock.now) continue;
						const wait = await worker.limiter.acquire("p", "m", worker.worker);
						worker.due = clock.now + (wait > 0 ? wait : 10_000);
					}
					await Promise.all(limiters.map((limiter) => limiter.poll()));
					if (clock.now % 10_000 === 0) for (let index = 0; index < hosts.length; index++) await report(index);
				}
			};
			await advance(120);
			assert.deepEqual(targets, [], "history warms before the default 20-second delay can over-provision");
			assert.equal(leader.status().rateCapHosts, 3, "60 calls/minute feed ten workers calling once per ten seconds");
			assert.equal(leader.status().target, 3, "extra leased workers waiting for tokens cannot raise the cap");
			const standby = start();
			await vi.advanceTimersByTimeAsync(0);
			await advance(70);
			assert.equal(standby.status().role, "standby");
			await leader.stop();
			await advance(10);
			assert.equal(standby.status().role, "active");
			assert.equal(standby.status().rateCapHosts, 3);
			assert.deepEqual(targets, [], "takeover keeps the standby's observations rather than growing uncapped");
			if (initialHosts > 3) {
				for (const worker of workers.slice(12)) {
					worker.active = false;
					worker.limiter.releaseWorker(worker.worker);
					await queue.complete(lease, worker.work, {
						runId: worker.work.childRunId,
						status: "completed",
						stages: [],
						toolNodes: [],
					});
				}
				await standby.stop();
				for (let index = 3; index < initialHosts; index++)
					assert.equal(
						await shared.drainRequested(`h${index}`, `vm${index}`),
						true,
						"the final idle drain uses the rate cap, not the deep queue's uncapped target",
					);
			}
		} finally {
			await Promise.all(controllers.map((controller) => controller.stop()));
			await Promise.all(limiters.map((limiter) => limiter.close()));
			await journal.close();
			await database.close();
			vi.useRealTimers();
		}
	});
}
