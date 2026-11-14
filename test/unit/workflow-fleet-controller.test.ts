import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "vitest";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { SqlFleetStore } from "../../packages/workflows/src/durable/journal/sql-fleet.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import type { Lease, RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import type { ProvisionedHost, WorkerHostProvisioner } from "../../packages/workflows/src/workers/autoscaler.js";
import {
	checkFleetOptions,
	FleetController,
	joinHosts,
	startWorkflowFleetController,
	type WorkflowFleetController,
	type WorkflowFleetEvent,
} from "../../packages/workflows/src/workers/fleet-controller.js";
import { isWorkerPlacementConfigError } from "../../packages/workflows/src/workers/placement-errors.js";
import {
	startWorkflowWorkerHost,
	type WorkflowWorkerHostEvent,
} from "../../packages/workflows/src/workers/worker-host.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { sleep } from "../helpers/runtime.js";

const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
/** A short controller tick, so a lease (three ticks) expires within the test. */
const TICK_MS = 100;

let directory: string;
const journals: RunJournal[] = [];
const controllers: WorkflowFleetController[] = [];
/** Worker hosts a test started, stopped whether or not it passed. */
const hosts: { stop(): Promise<void> }[] = [];
beforeEach(() => {
	directory = makeLibsqlDirectory();
});
afterEach(async () => {
	await Promise.all(controllers.splice(0).map((controller) => controller.stop()));
	await Promise.all(hosts.splice(0).map((host) => host.stop().catch(() => {})));
	await Promise.all(journals.splice(0).map((journal) => journal.close()));
	await removeLibsqlDirectory(directory);
});

function selection() {
	return { adapter: libsql, options: { url: pathToFileURL(join(directory, "shared.db")).href }, prefix: "acme_" };
}

async function openJournal(): Promise<RunJournal> {
	const journal = await resolveRunJournal({ journal: selection(), agentDir: join(directory, "agent") });
	journals.push(journal);
	return journal;
}

async function openStore(): Promise<SqlFleetStore> {
	return SqlFleetStore.open(await openJournal());
}

async function until(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

/** A provisioner with no hosts, which counts its calls and fails while `failing` is set. */
function fakeProvisioner(): WorkerHostProvisioner & { failing: boolean; lists: number } {
	const fake = {
		kind: "fake",
		failing: false,
		lists: 0,
		async list(): Promise<readonly ProvisionedHost[]> {
			fake.lists++;
			if (fake.failing) throw new Error("quota exceeded");
			return [];
		},
		async scaleTo() {},
		async drain() {},
	};
	return fake;
}

async function controller(
	provisioner: WorkerHostProvisioner,
	events: WorkflowFleetEvent[] = [],
	policy: Omit<Parameters<typeof startWorkflowFleetController>[0], "provisioner"> = {},
): Promise<WorkflowFleetController> {
	const started = await startWorkflowFleetController({
		journal: selection(),
		agentDir: join(directory, `controller-${controllers.length}`),
		provisioner,
		tickMs: TICK_MS,
		onEvent: (event) => events.push(event),
		...policy,
	});
	controllers.push(started);
	return started;
}

test.skipIf(process.platform === "win32")(
	"the controller lease fences a controller that lost it: its events and drain requests are refused (#4768)",
	async () => {
		const [a, b] = [await openStore(), await openStore()];
		assert.deepEqual(await a.acquire("A", undefined, 300), { held: true, epoch: 1 });
		assert.deepEqual(await b.acquire("B", undefined, 300), { held: false, holder: "A", epoch: 1 });
		assert.deepEqual(await a.acquire("A", 1, 300), { held: true, epoch: 1 }, "the holder renews at its epoch");
		await sleep(350);
		// A stopped renewing: B takes over with the next epoch, and A's next renewal finds it gone.
		assert.deepEqual(await b.acquire("B", undefined, 300), { held: true, epoch: 2 });
		assert.deepEqual(await a.acquire("A", 1, 300), { held: false, holder: "B", epoch: 2 });
		assert.equal(await a.record({ holder: "A", epoch: 1 }, { kind: "scale-up", reason: "stale" }), false);
		assert.equal(await a.requestDrain({ holder: "A", epoch: 1 }, "host-1", "vm-1"), false);
		assert.equal(
			await b.record({ holder: "B", epoch: 2 }, { kind: "scale-up", target: 2, live: 1, reason: "fresh" }),
			true,
		);
		assert.deepEqual(
			(await b.recent(10)).map((event) => [event.kind, event.reason, event.target, event.live]),
			[["scale-up", "fresh", 2, 1]],
		);
		// A stale release leaves the new holder's lease alone.
		await a.release({ holder: "A", epoch: 1 });
		assert.deepEqual(await a.acquire("C", undefined, 60_000), { held: false, holder: "B", epoch: 2 });
		await b.release({ holder: "B", epoch: 2 });
		assert.deepEqual(await a.acquire("C", undefined, 60_000), { held: true, epoch: 3 });
		// The holder's lease, not the one a contender would take, says when it expires.
		await sleep(350);
		assert.deepEqual(await b.acquire("D", undefined, 1), { held: false, holder: "C", epoch: 3 });
	},
);

test.skipIf(process.platform === "win32")("the fleet keeps the last 1000 events (#4768)", async () => {
	const store = await openStore();
	const fence = { holder: "A", epoch: 1 };
	await store.acquire("A", undefined, 60_000);
	for (let index = 0; index < 1_005; index++) await store.record(fence, { kind: "scale-up", reason: `${index}` });
	const kept = await store.recent(2_000);
	assert.equal(kept.length, 1_000);
	assert.equal(kept[0]!.reason, "5");
	assert.equal(kept.at(-1)!.reason, "1004");
});

test.skipIf(process.platform === "win32")(
	"of two controllers one is active; when it stops the other takes over with a higher epoch (#4768)",
	async () => {
		const [first, second] = [fakeProvisioner(), fakeProvisioner()];
		const a = await controller(first);
		const b = await controller(second);
		await until("one controller to lead and the other to stand by", () => {
			const roles = [a.status().role, b.status().role].sort();
			return roles[0] === "active" && roles[1] === "standby";
		});
		// Over several lease periods the two never lead at once, and only the active one calls its provisioner.
		const deadline = Date.now() + 10 * TICK_MS;
		while (Date.now() < deadline) {
			assert.notDeepEqual([a.status().role, b.status().role], ["active", "active"]);
			await sleep(10);
		}
		const [active, standby, standbyProvisioner] = a.status().role === "active" ? [a, b, second] : [b, a, first];
		assert.equal(standbyProvisioner.lists, 0, "a standby controller never calls its provisioner");
		const epoch = active.status().epoch!;
		await active.stop();
		assert.equal(active.status().role, "stopped");
		await until("the standby controller to take over", () => standby.status().role === "active");
		assert.ok(standby.status().epoch! > epoch);
		await until("the new leader to call its provisioner", () => standbyProvisioner.lists > 0);
	},
);

test.skipIf(process.platform === "win32")(
	"a controller that died without releasing the lease is replaced once the lease expires (#4768)",
	async () => {
		const store = await openStore();
		assert.deepEqual(await store.acquire("dead", undefined, 3 * TICK_MS), { held: true, epoch: 1 });
		const started = Date.now();
		const replacement = await controller(fakeProvisioner());
		await until("the replacement to take over", () => replacement.status().role === "active");
		assert.ok(Date.now() - started >= 3 * TICK_MS - 50, "not before the dead holder's lease expired");
		assert.equal(replacement.status().epoch, 2);
	},
);

test.skipIf(process.platform === "win32")(
	"provisioner errors degrade the controller with growing backoff, are recorded, and recover; nothing throws (#4768)",
	async () => {
		const provisioner = fakeProvisioner();
		provisioner.failing = true;
		const events: WorkflowFleetEvent[] = [];
		const running = await controller(provisioner, events);
		await until("two failed ticks", () => events.filter((event) => event.kind === "degraded").length >= 2);
		const degraded = events.filter((event) => event.kind === "degraded");
		assert.equal(degraded[0]!.kind === "degraded" && degraded[0].error.message, "quota exceeded");
		const waits = degraded.map((event) => (event.kind === "degraded" ? event.retryInMs : 0));
		assert.ok(waits[1]! > waits[0]! / 2, `the waits back off: ${waits.join(", ")}`);
		assert.equal(running.status().degraded?.error.message, "quota exceeded");
		const store = await openStore();
		const recorded = await store.recent(10);
		assert.ok(recorded.some((event) => event.kind === "error" && event.error === "Error: quota exceeded"));
		provisioner.failing = false;
		await until("the controller to recover", () => events.some((event) => event.kind === "recovered"));
		assert.equal(running.status().degraded, undefined);
	},
);

test.skipIf(process.platform === "win32")(
	"the controller scales up to the demand of a shared root's queue once, and records why (#4768)",
	async () => {
		const journal = await openJournal();
		await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
		const lease = ((await journal.acquire("root", "coordinator")) as { lease: Lease }).lease;
		const queue = await openSqlPoolQueue(journal);
		await queue.initialize(lease, 60_000);
		const shared = await SqlSharedPool.open(journal, queue);
		await shared.publishConfig(lease, {
			definitions: [],
			leaseMs: 60_000,
			heartbeatMs: 15_000,
			startupTimeoutMs: 60_000,
			claimWindowMs: 60_000,
		});
		for (const name of ["a", "b", "c"]) {
			const { work, boundary } = poolWorkFixture(name);
			await queue.enqueue(lease, work, boundary);
		}
		const hosts: ProvisionedHost[] = [];
		const targets: number[] = [];
		const provisioner: WorkerHostProvisioner = {
			kind: "fake",
			async list() {
				return [...hosts];
			},
			async scaleTo(target) {
				targets.push(target);
				while (hosts.length < target) hosts.push({ id: `vm-${hosts.length}`, state: "pending", since: Date.now() });
			},
			async drain() {},
		};
		const events: WorkflowFleetEvent[] = [];
		const running = await controller(provisioner, events, {
			workersPerHost: 2,
			scaleUpQueueDepth: 0,
			scaleUpDelayMs: 0,
		});
		await until("a scale-up", () => targets.length > 0);
		// Booting hosts count: later ticks add none.
		await sleep(5 * TICK_MS);
		assert.deepEqual(targets, [2]);
		assert.deepEqual(
			events.filter((event) => event.kind === "scale-up"),
			[{ kind: "scale-up", target: 2, desired: 2, live: 0 }],
		);
		assert.deepEqual([running.status().target, running.status().live, running.status().pending], [2, 0, 2]);
		const recorded = (await SqlFleetStore.open(journal).then((store) => store.recent(10))).filter(
			(event) => event.kind === "scale-up",
		);
		assert.deepEqual(
			recorded.map((event) => [event.target, event.live, event.reason]),
			[[2, 0, "3 ready, 0 live and 0 pending hosts: scaleTo(2)"]],
		);
	},
);

test.skipIf(process.platform === "win32")(
	"the controller drains an idle worker host matched by its provider id, then removes it from the provider (#4768)",
	async () => {
		const hostEvents: WorkflowWorkerHostEvent[] = [];
		const host = await startWorkflowWorkerHost({
			journal: selection(),
			agentDir: join(directory, "host"),
			maxWorkers: 1,
			hostId: "h1",
			providerId: "vm-1",
			restore: false,
			onEvent: (event) => hostEvents.push(event),
		});
		hosts.push(host);
		const removed: string[] = [];
		const provisioner: WorkerHostProvisioner = {
			kind: "fake",
			async list() {
				return removed.includes("vm-1") ? [] : [{ id: "vm-1", state: "running", since: 0 }];
			},
			async scaleTo() {
				assert.fail("an idle fleet adds no host");
			},
			async drain(id) {
				removed.push(id);
			},
		};
		const events: WorkflowFleetEvent[] = [];
		await controller(provisioner, events, { idleDrainMs: 0 });
		await host.closed;
		assert.deepEqual(hostEvents, [{ kind: "drain-requested" }]);
		await until("the host's removal", () => removed.length > 0);
		assert.deepEqual(removed, ["vm-1"]);
		assert.deepEqual(
			events.filter((event) => event.kind === "drain-requested" || event.kind === "removed"),
			[
				{ kind: "drain-requested", id: "vm-1", host: "h1" },
				{ kind: "removed", id: "vm-1", reason: "drained" },
			],
		);
		const store = await openStore();
		await until("the drain request to be cleared", async () => (await store.snapshot()).drains.length === 0);
		const recorded = await store.recent(10);
		assert.deepEqual(
			recorded.filter((event) => event.kind !== "active").map((event) => [event.kind, event.reason]),
			[
				["drain", "vm-1 (h1) idle, above the target of 0"],
				["remove", "vm-1: drained"],
			],
		);
	},
);

test.skipIf(process.platform === "win32")(
	"a controller that loses its lease during a slow provider call aborts it and makes no further call (#4768)",
	async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let listSignal: AbortSignal | undefined;
		const scaled: number[] = [];
		const provisioner: WorkerHostProvisioner = {
			kind: "slow",
			async list(signal) {
				listSignal = signal;
				await gate;
				return [];
			},
			async scaleTo(target) {
				scaled.push(target);
			},
			async drain() {},
		};
		const running = await controller(provisioner, [], { minHosts: 1 });
		await until("the slow list call", () => listSignal !== undefined);
		const epoch = running.status().epoch!;
		// Another controller takes the lease over while the call runs, as one would once a stalled holder's lease expired.
		const journal = await openJournal();
		await sqlPoolStorage(journal)!.transaction((tx) =>
			tx.run("UPDATE acme_wf_runs_fleet_controller SET holder = 'other', epoch = epoch + 1"),
		);
		assert.ok(epoch > 0);
		await until("the call to be aborted", () => listSignal!.aborted);
		release();
		await until("the controller to stand by", () => running.status().role === "standby");
		assert.deepEqual(scaled, [], "a controller that lost its lease never scales");
	},
);

test.skipIf(process.platform === "win32")(
	"a root's controller asks its idle hosts to drain when it stops, without waiting idleDrainMs (#4768)",
	async () => {
		const hostEvents: WorkflowWorkerHostEvent[] = [];
		const host = await startWorkflowWorkerHost({
			journal: selection(),
			agentDir: join(directory, "host"),
			maxWorkers: 1,
			hostId: "h1",
			providerId: "vm-1",
			restore: false,
			onEvent: (event) => hostEvents.push(event),
		});
		hosts.push(host);
		const provisioner: WorkerHostProvisioner = {
			kind: "fake",
			async list() {
				return [{ id: "vm-1", state: "running", since: 0 }];
			},
			async scaleTo() {},
			async drain() {},
		};
		const journal = await openJournal();
		const rootController = new FleetController(journal, { provisioner, tickMs: TICK_MS, drainIdleOnStop: true });
		controllers.push(rootController);
		await until("the controller to lead", () => rootController.status().role === "active");
		const store = await openStore();
		await until("the host to register", async () => (await store.snapshot()).hosts.length === 1);
		await sleep(3 * TICK_MS);
		assert.deepEqual(hostEvents, [], "the default idleDrainMs keeps the idle host while the controller runs");
		await rootController.stop();
		await host.closed;
		assert.deepEqual(hostEvents, [{ kind: "drain-requested" }]);
	},
);

test.skipIf(process.platform === "win32")(
	"a root's controller stops within its final-pass bound when the provider never answers (#4768)",
	async () => {
		let lists = 0;
		const provisioner: WorkerHostProvisioner = {
			kind: "hung",
			// The first list answers; every later one never does.
			list: () => (lists++ === 0 ? Promise.resolve([]) : new Promise<never>(() => {})),
			async scaleTo() {},
			async drain() {},
		};
		const journal = await openJournal();
		const rootController = new FleetController(journal, { provisioner, tickMs: 60_000, drainIdleOnStop: true });
		controllers.push(rootController);
		await until("the first tick", () => lists === 1 && rootController.status().target !== undefined);
		const started = Date.now();
		await rootController.stop();
		assert.ok(Date.now() - started < 15_000, `stop took ${Date.now() - started} ms`);
		assert.equal(lists, 2);
	},
);

test("startWorkflowFleetController refuses a provisioner without its methods, and a policy whose caps cannot hold (#4768)", async () => {
	const refused = async (options: Parameters<typeof startWorkflowFleetController>[0], field: string) => {
		await assert.rejects(startWorkflowFleetController(options), (error: Error) => {
			assert.ok(isWorkerPlacementConfigError(error), error.message);
			assert.equal(error.field, field);
			return true;
		});
	};
	const provisioner = fakeProvisioner();
	await refused(
		{ provisioner: { kind: "x", list: provisioner.list } as unknown as WorkerHostProvisioner },
		"provisioner.provisioner",
	);
	await refused({ provisioner, tickMs: 0 }, "provisioner.tickMs");
	await refused({ provisioner, minHosts: 5, maxHosts: 2 }, "provisioner.minHosts");
});

test("checkFleetOptions refuses each part of a provisioner that is missing, and a tickMs below 1 (#4768)", () => {
	const valid = { kind: "k", list: async () => [], scaleTo: async () => {}, drain: async () => {} };
	const refused = (provisioner: unknown, field = "provisioner.provisioner", tickMs?: number) =>
		assert.throws(
			() =>
				checkFleetOptions({
					provisioner: provisioner as WorkerHostProvisioner,
					...(tickMs === undefined ? {} : { tickMs }),
				}),
			(error: Error & { field?: string; source?: string; code?: string }) => {
				assert.deepEqual([error.field, error.source, error.code], [field, "sdk", "invalid-option"]);
				return true;
			},
		);
	refused(undefined);
	refused(null);
	refused("provider");
	refused({ ...valid, kind: 1 });
	refused({ ...valid, list: undefined });
	refused({ ...valid, scaleTo: undefined });
	refused({ ...valid, drain: undefined });
	refused(valid, "provisioner.tickMs", 0);
	refused(valid, "provisioner.tickMs", 1.5);
	assert.deepEqual(checkFleetOptions({ provisioner: valid, tickMs: 1 }).tickMs, 1);
	assert.deepEqual(checkFleetOptions({ provisioner: valid }).tickMs, 10_000);
	assert.match(
		(() => {
			try {
				checkFleetOptions({ provisioner: {} as WorkerHostProvisioner });
				return "";
			} catch (error) {
				return (error as Error).message;
			}
		})(),
		/a WorkerHostProvisioner: a kind, and list, scaleTo and drain methods/,
	);
});

test("joinHosts matches provider hosts to registered hosts by provider id or host id, with their leases and drains (#4768)", () => {
	const joined = joinHosts(
		[
			{ id: "vm-1", state: "running", since: 1 },
			{ id: "vm-2", hostId: "h2", state: "running", since: 2 },
			{ id: "vm-3", state: "pending", since: 3 },
			{ id: "vm-4", hostId: "h4", state: "running", since: 4 },
		],
		{
			roots: [],
			hosts: [
				{ host: "h1", providerId: "vm-1", live: true, leased: 2 },
				{ host: "h2", live: true, leased: 0 },
				{ host: "h4", live: false, leased: 0 },
				{ host: "other", providerId: "vm-9", live: true, leased: 0 },
			],
			drains: [{ host: "h1", providerId: "vm-1" }, { host: "h2" }, { host: "gone", providerId: "vm-3" }],
			leased: new Map([
				["h1", 2],
				["h4", 1],
			]),
		},
	);
	assert.deepEqual(joined, [
		{
			view: { id: "vm-1", state: "running", since: 1, registered: true, leased: 2, draining: true },
			hostId: "h1",
			drainHosts: ["h1"],
		},
		{
			view: { id: "vm-2", state: "running", since: 2, registered: true, leased: 0, draining: true },
			hostId: "h2",
			drainHosts: ["h2"],
		},
		{
			view: { id: "vm-3", state: "pending", since: 3, registered: false, leased: 0, draining: true },
			drainHosts: ["gone"],
		},
		{
			view: { id: "vm-4", state: "running", since: 4, registered: false, leased: 1, draining: false },
			hostId: "h4",
			drainHosts: [],
		},
	]);
});

test.skipIf(process.platform === "win32")(
	"status follows the lease: starting, active with its epoch and plan, standby, then stopped and released at once (#4768)",
	async () => {
		const events: WorkflowFleetEvent[] = [];
		const store = await openStore();
		assert.deepEqual(await store.acquire("other", undefined, 60_000), { held: true, epoch: 1 });
		const running = await controller(fakeProvisioner(), events);
		assert.deepEqual(running.status(), { role: "starting", holder: running.holder, provisioner: "fake" });
		await until("standby", () => running.status().role === "standby");
		await sleep(3 * TICK_MS);
		assert.deepEqual(running.status(), { role: "standby", holder: running.holder, provisioner: "fake" });
		assert.deepEqual(events, [{ kind: "standby", holder: "other" }], "standby is reported once");
		await store.release({ holder: "other", epoch: 1 });
		await until("active", () => running.status().target !== undefined);
		assert.deepEqual(running.status(), {
			role: "active",
			holder: running.holder,
			provisioner: "fake",
			epoch: 2,
			target: 0,
			live: 0,
			pending: 0,
		});
		assert.deepEqual(events.at(-1), { kind: "active", epoch: 2 });
		assert.ok(
			(await store.recent(10)).some((event) => event.reason === `${running.holder} took the controller lease`),
		);
		assert.match(running.holder, /^.+\/\d+\/[0-9a-f]{8}$/);
		await running.stop();
		assert.deepEqual(running.status(), { role: "stopped", holder: running.holder, provisioner: "fake" });
		// The lease was released: a controller with a long lease takes it at once.
		assert.deepEqual(await store.acquire("next", undefined, 60_000), { held: true, epoch: 3 });
	},
);

test.skipIf(process.platform === "win32")(
	"a degraded controller keeps when its failures began, and records a long error cut to 1 KiB (#4768)",
	async () => {
		const events: WorkflowFleetEvent[] = [];
		const provisioner: WorkerHostProvisioner = {
			kind: "long",
			list: () => Promise.reject("x".repeat(2_000)),
			async scaleTo() {},
			async drain() {},
		};
		const running = await controller(provisioner, events);
		await until("a failed tick", () => running.status().degraded !== undefined);
		const since = running.status().degraded!.since;
		const first = events.find((event) => event.kind === "degraded");
		assert.ok(first?.kind === "degraded");
		assert.equal(first.error.name, "Error");
		assert.equal(first.error.message, `${"x".repeat(1_024)}…`);
		await until("a second failed tick", () => running.status().degraded!.failures >= 2);
		assert.equal(running.status().degraded!.since, since);
		const store = await openStore();
		const recorded = (await store.recent(10)).find((event) => event.kind === "error");
		assert.deepEqual(
			[recorded?.reason, recorded?.error],
			["long provisioner or journal call failed", `Error: ${"x".repeat(1_024)}…`],
		);
	},
);

test.skipIf(process.platform === "win32")(
	"a controller that is not a root's leaves its idle hosts serving when it stops (#4768)",
	async () => {
		const hostEvents: WorkflowWorkerHostEvent[] = [];
		const host = await startWorkflowWorkerHost({
			journal: selection(),
			agentDir: join(directory, "host"),
			maxWorkers: 1,
			hostId: "h1",
			providerId: "vm-1",
			restore: false,
			onEvent: (event) => hostEvents.push(event),
		});
		hosts.push(host);
		const provisioner: WorkerHostProvisioner = {
			kind: "fake",
			async list() {
				return [{ id: "vm-1", state: "running", since: 0 }];
			},
			async scaleTo() {},
			async drain() {},
		};
		const running = await controller(provisioner);
		const store = await openStore();
		await until("the host to register", async () => (await store.snapshot()).hosts.length === 1);
		await until("the controller to lead", () => running.status().live === 1);
		await running.stop();
		// The host reports and reads drain requests at least every 5 s.
		await sleep(6_000);
		assert.deepEqual(hostEvents, []);
		assert.deepEqual((await store.snapshot()).drains, []);
	},
);
