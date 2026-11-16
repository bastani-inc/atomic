import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { checkpointKey, type PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { poolDurableJournal } from "../../packages/workflows/src/workers/pool-journal.js";
import type { FakeWorker } from "../helpers/fake-pool-worker.js";
import { openCoordinator, SOURCE } from "../helpers/pool-coordinator.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const forked = vi.hoisted((): FakeWorker[] => []);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { FakeWorker } = await import("../helpers/fake-pool-worker.js");
	return {
		...actual,
		fork(_modulePath: string, args: readonly string[], options: ForkOptions) {
			const worker = new FakeWorker(4_000_000 + forked.length, args, options);
			forked.push(worker);
			return worker;
		},
	};
});

afterEach(() => {
	forked.length = 0;
});

test("a host whose local journal cannot open starts its pool and commits checkpoints directly (#4768)", async () => {
	const directory = makeTempDirectory("shipping-startup-");
	const stateDirectory = join(directory, "state");
	mkdirSync(stateDirectory);
	writeFileSync(join(stateDirectory, "ship"), "not a directory");
	const journal = await resolveRunJournal({ journal: { path: join(directory, "shared.sqlite") } });
	const host = openCoordinator();
	try {
		await journal.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
		const acquired = await journal.acquire("root", "holder");
		assert.equal(acquired.status, "acquired");
		if (acquired.status !== "acquired") assert.fail("root lease was not acquired");
		await host.command({
			kind: "prepare",
			root: "root",
			lease: acquired.lease,
			options: {
				durable: poolDurableJournal(journal),
				shared: {
					stateDirectory,
					host: "host-a",
					claimWindowMs: 60_000,
					checkpointShipping: { intervalMs: 2_000, maxBatch: 64, maxLagMs: 30_000 },
				},
				workers: 1,
				leaseMs: 60_000,
				heartbeatMs: 15_000,
				startupTimeoutMs: 30_000,
				workerEntry: "fake-worker",
			},
		});
		const starting = host.command({ kind: "start", sources: [SOURCE], cwd: directory, publish: false });
		while (forked.length === 0) await sleep(5);
		const worker = forked[0]!;
		await worker.request({ kind: "ready" });
		await starting;
		const { work, boundary } = poolWorkFixture();
		await host.command({
			kind: "enqueue",
			descriptor: { ...work, definition: `${SOURCE.path}#${SOURCE.exportName}`, digest: SOURCE.digest },
			boundary,
		});
		const claim = await worker.request({ kind: "claim" });
		assert.equal(claim.error, undefined);
		const held = claim.value as PoolWork;
		assert.ok(held);
		for (const suffix of ["a", "b"]) {
			const checkpoint: DurableToolCheckpoint = {
				kind: "tool",
				name: `tool-${suffix}`,
				output: {},
				workflowId: "root",
				checkpointId: `${held.scope}:${suffix}`,
				argsHash: `${held.scope}:args-${suffix}`,
				completedAt: 1,
				topology: {
					version: 1,
					nodeId: `tool-${suffix}`,
					ordinal: suffix === "a" ? 0 : 1,
					order: suffix === "a" ? 0 : 1,
					parentIds: [],
					run: boundary.topology!.boundary!.child,
				},
			};
			const committed = await worker.request({
				kind: "commit",
				operation: `commit-${suffix}`,
				mutation: { kind: "checkpoint", checkpoint },
			});
			assert.equal(committed.error, undefined);
			assert.ok(committed.value);
			assert.ok(await journal.readKey("root", checkpointKey(checkpoint)));
		}
		const health = host.events.filter((event) => event.kind === "health");
		assert.equal(health.length, 1);
		assert.match(health[0]!.message, /checkpoint shipping.*local journal.*shared journal/);
	} finally {
		await host.command({ kind: "close" });
		await host.coordinator.shutdown();
		await journal.close();
		removeTempDirectory(directory);
	}
});
