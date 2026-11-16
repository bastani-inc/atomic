import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { test, vi } from "vitest";
import { SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { CheckpointShipping } from "../../packages/workflows/src/workers/checkpoint-shipping.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import type { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import { sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import {
	binding,
	COORDINATOR_TEST_TIMEOUT_MS,
	childPath,
	fanOut,
	fixture,
	satellite,
} from "../helpers/workflow-shared-pool-coordinator.js";

vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => async () => {},
}));

useTemporaryAgentDir();

test(
	"a worker host releases the local checkpoint state of a claim it puts back unplaced (#4768)",
	async () => {
		const f = await fixture("shipping-unplaced-claim", { workspace: binding, leaseMs: 2_000 });
		const restored = join(f.directory, "restored");
		mkdirSync(restored);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		let host: PoolCoordinator | undefined;
		const calls: string[] = [];
		const hold = CheckpointShipping.prototype.hold;
		vi.spyOn(CheckpointShipping.prototype, "hold").mockImplementation(async function (
			this: CheckpointShipping,
			...args: Parameters<CheckpointShipping["hold"]>
		) {
			calls.push(`hold ${args[0].generation}`);
			return hold.apply(this, args);
		});
		const release = CheckpointShipping.prototype.release;
		vi.spyOn(CheckpointShipping.prototype, "release").mockImplementation(function (
			this: CheckpointShipping,
			...args: Parameters<CheckpointShipping["release"]>
		) {
			const work = args[0];
			calls.push(`release ${typeof work === "string" ? "any" : work.generation}`);
			return release.apply(this, args);
		});
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			const root = await f.root();
			let restores = 0;
			host = await satellite(
				f,
				{
					...root,
					config: { ...root.config, checkpointShipping: { intervalMs: 2_000, maxBatch: 64, maxLagMs: 30_000 } },
				},
				{
					restore: async () => {
						restores++;
						if (restores === 1) throw new Error("the remote is unreachable");
						return restored;
					},
				},
			);
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
			assert.equal(restores, 2);
			assert.equal(calls[0], "release 1", `the unplaced claim is released before the next attempt holds: ${calls}`);
			assert.equal(calls[1], "hold 1", `${calls}`);
		} finally {
			vi.restoreAllMocks();
			await host?.stopSatellite();
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a worker host holds nothing locally for a claim whose workspace still restores, even when its watchdog renews it (#4768)",
	async () => {
		const f = await fixture("shipping-restoring-claim", { workspace: binding, leaseMs: 2_000 });
		const restored = join(f.directory, "restored");
		mkdirSync(restored);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		let host: PoolCoordinator | undefined;
		let failing = false;
		let restoring = false;
		let inspectedWhileRestoring = 0;
		const health: string[] = [];
		// The host's watchdog finds the claim's lease lapsed while its workspace restores, and renews it.
		const inspect = SqlPoolQueue.prototype.inspect;
		vi.spyOn(SqlPoolQueue.prototype, "inspect").mockImplementation(async function (
			this: SqlPoolQueue,
			...args: Parameters<SqlPoolQueue["inspect"]>
		) {
			const rows = await inspect.apply(this, args);
			if (!restoring || this !== (host as unknown as { queue?: SqlPoolQueue } | undefined)?.queue) return rows;
			inspectedWhileRestoring++;
			return rows.map((row) => (row.state === "leased" ? { ...row, expiresAt: 0 } : row));
		});
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			const root = await f.root();
			let restores = 0;
			host = await satellite(
				f,
				{
					...root,
					config: { ...root.config, checkpointShipping: { intervalMs: 2_000, maxBatch: 64, maxLagMs: 30_000 } },
				},
				{
					restore: async () => {
						restores++;
						if (restores > 1) return restored;
						while (!failing) await sleep(10);
						restoring = true;
						while (inspectedWhileRestoring < 3) await sleep(25);
						restoring = false;
						throw new Error("the remote is unreachable");
					},
				},
				[],
				"host-b",
				1,
				health,
			);
			// Every write to the host's local journal fails, so each attempt it holds there reports it.
			const shipping = (host as unknown as { shipping: { shard: { database: SqliteDatabase } } }).shipping;
			shipping.shard.database.transaction = (() =>
				Promise.reject(new Error("database or disk is full"))) as SqliteDatabase["transaction"];
			failing = true;
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
			assert.equal(restores, 2);
			assert.deepEqual(
				health.filter((message) => /local journal failed for work/.test(message)).length,
				1,
				`only the attempt that ran held the local journal: ${health.join("\n")}`,
			);
		} finally {
			vi.restoreAllMocks();
			await host?.stopSatellite();
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
