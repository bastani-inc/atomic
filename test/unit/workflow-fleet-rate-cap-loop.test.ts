import assert from "node:assert/strict";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import { test, vi } from "vitest";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { readFleetRateUsage, SqlRateBuckets } from "../../packages/workflows/src/durable/journal/sql-rate-buckets.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import { FleetController } from "../../packages/workflows/src/workers/fleet-controller.js";
import { FleetRateCap } from "../../packages/workflows/src/workers/fleet-rate-cap.js";
import { FleetRateLimiter } from "../../packages/workflows/src/workers/fleet-rate-limits.js";
import type { ProvisionedHost, WorkerHostProvisioner } from "../../packages/workflows/src/workers/fleet-types.js";
import { registerSqlPoolStorage as registerOlderStorage } from "../fixtures/shared-pool-0.9.88/durable/journal/internal.js";
import { SqlRateBuckets as OlderRateBuckets } from "../fixtures/shared-pool-0.9.88/durable/journal/sql-rate-buckets.js";
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

for (const [initialHosts, unusedScope, bootMs, restoreMs] of [
	[3, false, 0, 0],
	[8, false, 0, 0],
	[1, false, 0, 0],
	[1, true, 0, 0],
	[0, false, 90_000, 0],
	[0, false, 150_000, 0],
	[0, false, 30_000, 90_000],
	[0, false, 30_000, 150_000],
	[0, false, 30_000, 30_000],
	[0, false, 0, 90_000],
] as const) {
	test(`a fleet starting with ${initialHosts} hosts${unusedScope ? " and an unused quota" : ""}${bootMs ? ` and a ${bootMs / 1_000}-second host boot` : ""}${restoreMs ? ` and a ${restoreMs / 1_000}-second leased restore` : ""} follows real token-waiting traffic with the default growth delay and through failover (#4768)`, async () => {
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
			await queue.initialize(lease, 3_600_000);
			const shared = await SqlSharedPool.open(journal, queue);
			const limits = {
				p: { requestsPerMinute: 60, burst: 1, prefetch: 1 },
				...(unusedScope ? { q: { requestsPerMinute: 60, burst: 1, prefetch: 1 } } : {}),
			};
			await shared.publishConfig(lease, {
				definitions: [],
				leaseMs: 3_600_000,
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
				started: boolean;
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
			const boot = async () => {
				for (const [index, host] of hosts.entries()) {
					if (host.state !== "pending" || clock.now - host.since < bootMs) continue;
					hosts[index] = { ...host, state: "running" };
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
						const work = await queue.claim(lease, worker, [poolWorkFixture().work], 3_600_000);
						assert.ok(work);
						if (restoreMs === 0) await queue.heartbeat(lease, work, 3_600_000, async () => {});
						workers.push({
							worker,
							work,
							limiter,
							due: clock.now + restoreMs,
							started: restoreMs === 0,
							active: true,
						});
					}
					await report(index);
				}
			};
			const add = async (target: number) => {
				while (hosts.length < target) hosts.push({ id: `vm${hosts.length}`, state: "pending", since: clock.now });
				await boot();
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
					idleDrainMs: 3_600_000,
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
					await boot();
					if (initialHosts === 0 && !workers.some((worker) => worker.started))
						assert.ok(
							hosts.length <= 1,
							"only one bootstrap host may exist before the first child starts drawing",
						);
					for (const worker of workers) {
						if (!worker.active || worker.due > clock.now) continue;
						if (!worker.started) {
							await queue.heartbeat(lease, worker.work, 3_600_000, async () => {});
							worker.started = true;
						}
						const wait = await worker.limiter.acquire("p", "m", worker.worker);
						worker.due = clock.now + (wait > 0 ? wait : 10_000);
					}
					await Promise.all(limiters.map((limiter) => limiter.poll()));
					if (clock.now % 10_000 === 0)
						for (const [index, host] of hosts.entries()) if (host.state === "running") await report(index);
				}
			};
			const settlingSeconds = bootMs + restoreMs > 0 ? (2 * (bootMs + restoreMs)) / 1_000 + 180 : 120;
			await advance(unusedScope ? 600 : settlingSeconds);
			assert.ok(
				targets.every((target) => target <= 3),
				"startup cannot grow beyond the quota's capacity",
			);
			if (initialHosts <= 1) assert.equal(hosts.length, 3, "the quota can feed three hosts after boot and warm-up");
			else assert.deepEqual(targets, [], "history warms before the default 20-second delay can over-provision");
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
			if (initialHosts <= 1)
				assert.ok(
					targets.every((target) => target <= 3),
					"takeover keeps the standby's observations rather than growing uncapped",
				);
			else assert.deepEqual(targets, [], "takeover never adds hosts to an already quota-sized fleet");
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

test("an unused quota needs a full running observation minute again after its roots stop running children (#4768)", () => {
	const cap = new FleetRateCap();
	const root = { leased: 8, ready: 80, blocked: false, rateScopes: ["p"] };
	const observe = (now: number, leased: number) => {
		cap.observe(
			[{ scope: "p", now, acquired: 0, waitingMs: 0, intervalMs: 1_000 }],
			[{ ...root, leased, started: leased }],
		);
	};
	for (let now = 0; now <= 20_000; now += 10_000) observe(now, 8);
	for (let now = 30_000; now <= 90_000; now += 10_000) {
		observe(now, 0);
		assert.equal(cap.limit(4, 2), 2, "time without a running child cannot expire the hold");
	}
	for (let now = 100_000; now <= 140_000; now += 10_000) {
		observe(now, 8);
		assert.equal(cap.limit(4, 2), 2, "resumed work must finish the new observation minute");
	}
	observe(150_000, 8);
	assert.equal(cap.limit(4, 2), 22, "an unused quota releases its hold once roots run for the full minute");
});

for (const [upgraded, countedCalls] of [
	[false, false],
	[true, false],
	[true, true],
] as const) {
	test(`older hosts drawing tokens cannot freeze a fleet${upgraded ? " after the counter upgrade" : " before the counter upgrade"}${countedCalls ? " alongside counted calls" : ""} (#4768)`, async () => {
		clock.now = 1_800_000_000_000;
		const database = await openNodeSqliteDatabase(":memory:");
		const journal = await SqlRunJournal.open(database);
		try {
			// A 0.9.88 host's node-sqlite connections sent no batches: its writes went as transactions (#5376).
			const { batch: _unbatched, ...older088 } = sqlPoolStorage(journal)!;
			registerOlderStorage(journal, older088);
			const older = await OlderRateBuckets.open(journal);
			const current = upgraded ? await SqlRateBuckets.open(journal) : undefined;
			const cap = new FleetRateCap();
			const roots = [{ leased: 8, started: 8, ready: 80, blocked: false, rateScopes: ["p"] }];
			const shape = { intervalMs: 100, burst: 60 };
			assert.deepEqual(await older.acquire("p", 50, shape), { granted: 50 });
			cap.observe(await readFleetRateUsage(journal), roots);
			assert.equal(cap.limit(4, 2), 2);
			for (let seconds = 10; seconds <= 300; seconds += 10) {
				clock.now += 10_000;
				assert.deepEqual(await older.acquire("p", 50, shape), { granted: 50 });
				if (countedCalls) assert.deepEqual(await current!.acquire("p", 1), { granted: 1 });
				cap.observe(await readFleetRateUsage(journal), roots);
				assert.equal(cap.limit(4, 2), 22, `uncounted draws at ${seconds}s cannot restrict the full queue demand`);
			}
		} finally {
			await journal.close();
			await database.close();
		}
	});
}
