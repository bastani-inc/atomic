import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	MAINTENANCE_INTERVAL_MS,
	MAINTENANCE_STALE_AFTER_MS,
	OUTBOX_BACKUP_POLL_INTERVAL_MS,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { CROSS_NODE_WAIT_MS, cluster, type Node, runCleanups } from "./intercom-multinode-broker-routing-helpers.js";

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setInterval"] });
});

afterEach(async () => {
	vi.useRealTimers();
	await runCleanups();
});

/** How many times each node pruned the shared state, and how many times it swept for lost recipients' asks. */
function watch(nodes: readonly Node[]) {
	const counts = nodes.map(() => ({ prunes: 0, sweeps: 0 }));
	nodes.forEach((node, index) => {
		const { outbox, pendingAsks } = node.opened.state;
		const prune = outbox.prune.bind(outbox);
		vi.spyOn(outbox, "prune").mockImplementation((...args) => {
			counts[index]!.prunes++;
			return prune(...args);
		});
		const listEnded = pendingAsks.listEnded.bind(pendingAsks);
		vi.spyOn(pendingAsks, "listEnded").mockImplementation((...args) => {
			counts[index]!.sweeps++;
			return listEnded(...args);
		});
	});
	return {
		prunes: () => counts.map((count) => count.prunes),
		sweeps: () => counts.map((count) => count.sweeps),
	};
}

/** Moves the clock one maintenance interval on and waits until `expected` maintenances ran in all. */
async function maintenanceRuns(prunes: () => number[], expected: number): Promise<number[]> {
	vi.advanceTimersByTime(MAINTENANCE_INTERVAL_MS);
	return vi.waitFor(
		() => {
			const counted = prunes();
			assert.equal(
				counted.reduce((sum, each) => sum + each, 0),
				expected,
			);
			return counted;
		},
		{ timeout: CROSS_NODE_WAIT_MS },
	);
}

/** Lets the maintenance checks under way finish: each is a read, and a maintenance a few statements more. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 200));
}

/** Ages the maintenance lease, as if its holder stopped `ageMs` ago. */
async function ageMaintenanceLease(node: Node, ageMs: number): Promise<void> {
	await node.database.run(
		"UPDATE mn_intercom_leases SET renewed_at = renewed_at - ? WHERE kind = 'maintenance'",
		ageMs,
	);
}

test("one broker of the swarm maintains the shared state each interval, and stays the maintainer while it runs", async () => {
	const nodes = await cluster(3);
	const counts = watch(nodes);
	// Backup polls on every broker prune nothing.
	vi.advanceTimersByTime(MAINTENANCE_INTERVAL_MS - OUTBOX_BACKUP_POLL_INTERVAL_MS);
	await vi.waitFor(() => assert.ok(counts.sweeps().every((sweeps) => sweeps > 0)), { timeout: CROSS_NODE_WAIT_MS });
	assert.deepEqual(counts.prunes(), [0, 0, 0]);

	vi.advanceTimersByTime(OUTBOX_BACKUP_POLL_INTERVAL_MS);
	const first = await vi.waitFor(
		() => {
			const counted = counts.prunes();
			assert.equal(
				counted.reduce((sum, each) => sum + each, 0),
				1,
			);
			return counted;
		},
		{ timeout: CROSS_NODE_WAIT_MS },
	);
	await settle();
	assert.deepEqual(counts.prunes(), first, "only one broker maintains");
	const maintainer = first.indexOf(1);

	const second = await maintenanceRuns(counts.prunes, 2);
	await settle();
	assert.deepEqual(counts.prunes(), second);
	assert.equal(second[maintainer], 2, "the maintainer keeps the lease");
});

test("a maintainer that stops without giving the lease up is replaced once its lease goes stale", async () => {
	const nodes = await cluster(3);
	const counts = watch(nodes);
	const first = await maintenanceRuns(counts.prunes, 1);
	const maintainer = first.indexOf(1);
	const crashed = nodes[maintainer]!;
	// It stops without releasing anything, as a broker that is killed does.
	vi.spyOn(crashed.opened.state.leases, "release").mockResolvedValue({ status: "released" });
	await crashed.router.close();

	// While its lease is live, no one else maintains.
	vi.advanceTimersByTime(MAINTENANCE_INTERVAL_MS);
	await settle();
	assert.deepEqual(counts.prunes(), first);

	await ageMaintenanceLease(nodes[0]!, MAINTENANCE_STALE_AFTER_MS + 1_000);
	const after = await maintenanceRuns(counts.prunes, 2);
	await settle();
	assert.deepEqual(counts.prunes(), after, "one broker took over");
	assert.equal(after[maintainer], 1, "the stopped broker did not run again");
});

test("a maintainer that closes frees the lease for the next broker at once", async () => {
	const nodes = await cluster(2);
	const counts = watch(nodes);
	const first = await maintenanceRuns(counts.prunes, 1);
	const maintainer = first.indexOf(1);
	await nodes[maintainer]!.router.close();

	const after = await maintenanceRuns(counts.prunes, 2);
	assert.equal(after[1 - maintainer], 1, "the other broker took over without waiting for the lease to go stale");
});
