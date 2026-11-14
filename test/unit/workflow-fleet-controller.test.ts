import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "vitest";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { SqlFleetStore } from "../../packages/workflows/src/durable/journal/sql-fleet.js";
import type { RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import type { ProvisionedHost, WorkerHostProvisioner } from "../../packages/workflows/src/workers/autoscaler.js";
import {
	startWorkflowFleetController,
	type WorkflowFleetController,
	type WorkflowFleetEvent,
} from "../../packages/workflows/src/workers/fleet-controller.js";
import { isWorkerPlacementConfigError } from "../../packages/workflows/src/workers/placement-errors.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { sleep } from "../helpers/runtime.js";

const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
/** A short controller tick, so a lease (three ticks) expires within the test. */
const TICK_MS = 100;

let directory: string;
const journals: RunJournal[] = [];
const controllers: WorkflowFleetController[] = [];
beforeEach(() => {
	directory = makeLibsqlDirectory();
});
afterEach(async () => {
	await Promise.all(controllers.splice(0).map((controller) => controller.stop()));
	await Promise.all(journals.splice(0).map((journal) => journal.close()));
	await removeLibsqlDirectory(directory);
});

function selection() {
	return { adapter: libsql, options: { url: pathToFileURL(join(directory, "shared.db")).href }, prefix: "acme_" };
}

async function openStore(): Promise<SqlFleetStore> {
	const journal = await resolveRunJournal({ journal: selection(), agentDir: join(directory, "agent") });
	journals.push(journal);
	return SqlFleetStore.open(journal);
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
): Promise<WorkflowFleetController> {
	const started = await startWorkflowFleetController({
		journal: selection(),
		agentDir: join(directory, `controller-${controllers.length}`),
		provisioner,
		tickMs: TICK_MS,
		onEvent: (event) => events.push(event),
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
	},
);

test.skipIf(process.platform === "win32")(
	"the fleet keeps the last 1000 events (#4768)",
	async () => {
		const store = await openStore();
		const fence = { holder: "A", epoch: 1 };
		await store.acquire("A", undefined, 60_000);
		for (let index = 0; index < 1_005; index++) await store.record(fence, { kind: "scale-up", reason: `${index}` });
		const kept = await store.recent(2_000);
		assert.equal(kept.length, 1_000);
		assert.equal(kept[0]!.reason, "5");
		assert.equal(kept.at(-1)!.reason, "1004");
	},
	60_000,
);

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
