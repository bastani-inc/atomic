import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, test, vi } from "vitest";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { SqlFleetStore } from "../../packages/workflows/src/durable/journal/sql-fleet.js";
import type { RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import type { ProvisionedHost, WorkerHostProvisioner } from "../../packages/workflows/src/workers/autoscaler.js";
import { FleetController } from "../../packages/workflows/src/workers/fleet-controller.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { sleep } from "../helpers/runtime.js";

const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
/** A short controller tick, so a lease (three ticks) expires within the test. */
const TICK_MS = 100;
/** The controller's lease: three ticks. */
const LEASE_MS = 3 * TICK_MS;
/** How far the controller host's clock steps back, as an NTP correction might. */
const STEP_BACK_MS = 10_000;
/** How far the controller host's clock steps forward: past the boot timeout. */
const STEP_FORWARD_MS = 10 * 60_000;

let directory: string;
const journals: RunJournal[] = [];
const controllers: FleetController[] = [];
beforeEach(() => {
	directory = makeLibsqlDirectory();
});
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(controllers.splice(0).map((controller) => controller.stop()));
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

async function until(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!(await check())) {
		if (performance.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

/** Steps this process's wall clock by `ms` from now on, as an NTP step would. */
function stepClock(ms: number): void {
	const realNow = Date.now.bind(Date);
	vi.spyOn(Date, "now").mockImplementation(() => realNow() + ms);
}

test.skipIf(process.platform === "win32")(
	"a controller whose clock steps back stops acting before another controller takes its lease (#5058)",
	async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let listSignal: AbortSignal | undefined;
		const calls: string[] = [];
		const provisioner: WorkerHostProvisioner = {
			kind: "slow",
			async list(signal) {
				if (listSignal !== undefined) calls.push("list");
				listSignal = signal;
				await gate;
				return [];
			},
			async scaleTo(target) {
				calls.push(`scaleTo(${target})`);
			},
			async drain(id) {
				calls.push(`drain(${id})`);
			},
		};
		const a = new FleetController(await openJournal(), { provisioner, tickMs: TICK_MS, minHosts: 1 });
		controllers.push(a);
		await until("A to lead and list its hosts", () => listSignal !== undefined);
		// A loses the database, so its renewals fail, while its provider calls still work; its clock steps back.
		const store = (a as unknown as { store: SqlFleetStore }).store;
		store.acquire = () => Promise.reject(new Error("database unreachable"));
		const lostAt = performance.now();
		stepClock(-STEP_BACK_MS);
		let abortedAt: number | undefined;
		listSignal!.addEventListener("abort", () => {
			abortedAt = performance.now();
		});

		// The lease, on the database's clock, expires and B takes it over.
		const b = await SqlFleetStore.open(await openJournal());
		await until("B to take the lease", async () => (await b.acquire("B", undefined, LEASE_MS)).held);
		assert.equal(listSignal!.aborted, true, "A aborted its provider call before B took the lease");
		assert.ok(abortedAt! - lostAt < LEASE_MS, `A stopped within its lease (${abortedAt! - lostAt} ms)`);

		release();
		await sleep(5 * TICK_MS);
		assert.deepEqual(calls, [], "A made no provider call after it may have lost the lease");
	},
);

test.skipIf(process.platform === "win32")(
	"a forward clock step does not remove a host that is still booting (#5058)",
	async () => {
		const drained: string[] = [];
		const booting: ProvisionedHost = { id: "vm-1", state: "pending", since: Date.now() };
		let lists = 0;
		const provisioner: WorkerHostProvisioner = {
			kind: "fake",
			async list() {
				lists++;
				return [booting];
			},
			async scaleTo() {},
			async drain(id) {
				drained.push(id);
			},
		};
		const a = new FleetController(await openJournal(), {
			provisioner,
			tickMs: TICK_MS,
			minHosts: 1,
			bootTimeoutMs: 60_000,
		});
		controllers.push(a);
		await until("A to see the booting host", () => lists >= 2);

		stepClock(STEP_FORWARD_MS);
		const seen = lists;
		await until("A to tick a few more times", () => lists >= seen + 3);

		assert.deepEqual(drained, [], "the booting host was not removed as a boot failure");
		assert.equal(a.status().pending, 1);
	},
);
