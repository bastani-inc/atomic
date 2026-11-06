import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, vi } from "vitest";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { isStaleWorkLeaseError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import type { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import { workspaceAffinityKey } from "../../packages/workflows/src/workers/workspace-binding.js";
import { sleep } from "../helpers/runtime.js";
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

/** A worker host's claim on a bound child and on its root while the child's workspace restores (#4310). */

test(
	"a host keeps a bound child's lease through a restore longer than the lease, and puts back work whose restore failed (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-slow-restore", { workspace: binding, leaseMs: 2_000 });
		const restored = join(f.directory, "restored");
		mkdirSync(restored);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		let host: PoolCoordinator | undefined;
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			const root = await f.root();
			const failures: Error[] = [];
			let restores = 0;
			// The journal refuses to record the backoff and to clear it: the host backs off and runs the child all the same.
			vi.spyOn(SqlSharedPool.prototype, "recordRestoreBackoff").mockRejectedValueOnce(new Error("recording failed"));
			vi.spyOn(SqlSharedPool.prototype, "clearRestoreBackoff").mockRejectedValueOnce(new Error("clearing failed"));
			host = await satellite(
				f,
				root,
				{
					restore: async () => {
						restores++;
						// The first restore fails; the second takes twice the child's work lease.
						if (restores === 1) throw new Error("the remote is unreachable");
						await sleep(4_000);
						return restored;
					},
				},
				failures,
			);
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
			assert.deepEqual(
				failures.map((failure) => failure.message),
				["the remote is unreachable", "recording failed", "clearing failed"],
				"the failed restore is reported as the host's placement failure, and so are the backoff records that failed",
			);
			assert.equal(restores, 2, "a restore that outlasts the work lease is not run again");
			assert.deepEqual(
				f.claims().map(([claimer, , cwd]) => [claimer, cwd]),
				[["host-b", restored]],
				"the child ran once, at the restored path",
			);
			assert.deepEqual(
				(await f.shared.stageWorkspaces("root")).map((record) => record.generation),
				[1],
				"the failed restore was no attempt of the child (#4416)",
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

test(
	"a host whose root's lease moves during a restore hands out nothing and stops serving it (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-restore-lost", { workspace: binding, leaseMs: 2_000 });
		const restored = join(f.directory, "restored");
		mkdirSync(restored);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent } = await fanOut(1)(child as never);
		let host: PoolCoordinator | undefined;
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			const root = await f.root();
			const failures: Error[] = [];
			let restoring = false;
			host = await satellite(
				f,
				root,
				{
					restore: async () => {
						restoring = true;
						await sleep(3_000);
						return restored;
					},
				},
				failures,
				"host-b",
				1,
			);
			while (!restoring) await sleep(25);
			const state = (await f.hostJournal.leaseState("root"))!;
			assert.equal((await f.hostJournal.takeover("root", "next-incarnation", state.holderId)).status, "acquired");
			while (!host.detached) await sleep(25);
			await sleep(500);
			assert.deepEqual(f.claims(), [], "the restored child was never handed to a worker");
			assert.ok(
				failures.length > 0 && failures.every((failure) => failure.name === "StaleLeaseError"),
				String(failures),
			);
		} finally {
			await host?.stopSatellite().catch(() => {});
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a host whose attempt is replaced during a restore hands it out to no worker and says why (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-restore-replaced", { workspace: binding, leaseMs: 2_000 });
		const restored = join(f.directory, "restored");
		mkdirSync(restored);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent } = await fanOut(1)(child as never);
		let host: PoolCoordinator | undefined;
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			const root = await f.root();
			const failures: Error[] = [];
			let restoring = false;
			let restoredAt: number | undefined;
			host = await satellite(
				f,
				root,
				{
					restore: async () => {
						if (restoring) {
							await sleep(5_000);
							return restored;
						}
						restoring = true;
						await sleep(3_000);
						restoredAt = Date.now();
						return restored;
					},
				},
				failures,
				"host-b",
				1,
			);
			while (!restoring) await sleep(25);
			const storage = sqlPoolStorage(f.hostJournal)!;
			await storage.transaction((tx) =>
				tx.run(`UPDATE ${storage.tables.runs}_work SET generation = generation + 1 WHERE state = 'leased'`),
			);
			while (restoredAt === undefined) await sleep(25);
			await sleep(300);
			assert.deepEqual(f.claims(), [], "the replaced attempt was never handed to a worker");
			assert.equal(failures.length, 1);
			const [refusal] = failures;
			assert.ok(isStaleWorkLeaseError(refusal), String(refusal));
			assert.equal(refusal.reason, "generation-mismatch");
			assert.equal(
				await f.shared.restoreFailure(workspaceAffinityKey(binding)),
				undefined,
				"a replaced attempt is no failed restore: the host does not back off from the binding (#4416)",
			);
			assert.equal(host.detached, false, "the root's lease held: the host keeps serving it");
		} finally {
			await host?.stopSatellite().catch(() => {});
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
