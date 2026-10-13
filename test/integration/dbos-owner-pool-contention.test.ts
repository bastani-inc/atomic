import assert from "node:assert/strict";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { Pool } from "pg";
import { test } from "vitest";
import { encodeMetadata } from "../../packages/workflows/src/durable/dbos-metadata.js";
import { DbosOwnerFence } from "../../packages/workflows/src/durable/dbos-owner-fence.js";
import { createRealDbosHandle, type DbosStatic } from "../../packages/workflows/src/durable/dbos-sdk-handle.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { type ManagedResult, RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";

const REAL_OWNER_POOL_CONTENTION_TIMEOUT_MS = 180_000;
const POOL_SIZE = 2;

test(
	"concurrent metadata admissions, checkpoints and legacy adoption queue at minimum pool capacity",
	async () => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		let sql: Pool | undefined;
		let fence: DbosOwnerFence | undefined;
		let launched = false;
		try {
			const { url } = await home.client(listener.port).request<ManagedResult>("ensure");
			const endpoint = new URL(url);
			endpoint.pathname = "/postgres";
			const options = { connectionString: endpoint.href, max: POOL_SIZE, connectionTimeoutMillis: 3_000 };
			const ownership = new Pool(options);
			const owner = `atomic-db-${crypto.randomUUID()}`;
			const sqlPool = new Pool(options);
			fence = new DbosOwnerFence(
				() => ownership,
				owner,
				() => ownership.end(),
				() => sqlPool,
			);
			sql = fence.protectPool(sqlPool);
			const main = DBOS.registerWorkflow(
				async (_name: string, inputs: Record<string, WorkflowSerializableValue>) => inputs,
				{ name: "atomicWorkflowHandle" },
			);
			const checkpoint = DBOS.registerWorkflow(
				async (_id: string, _step: string, output: WorkflowSerializableValue) => output,
				{ name: "atomicWorkflowCheckpoint" },
			);
			DBOS.setConfig({
				name: "owner-pool-contention",
				systemDatabasePool: sql,
				systemDatabaseUrl: endpoint.href,
				runAdminServer: false,
				executorID: owner,
			});
			await DBOS.launch();
			launched = true;
			const raw = createRealDbosHandle(DBOS as unknown as DbosStatic, main, checkpoint);
			const handle = createRealDbosHandle(DBOS as unknown as DbosStatic, main, checkpoint, fence);
			const metadata = (id: string, ownerExecutorId = owner) =>
				encodeMetadata({
					workflowId: id,
					name: "queued",
					inputs: {},
					status: "paused",
					createdAt: 1,
					updatedAt: 10,
					completedCheckpoints: 0,
					pendingPrompts: 0,
					promptReservationEpoch: "epoch",
					ownerExecutorId,
				});
			const legacy = crypto.randomUUID();
			await raw.startWorkflow(legacy, "legacy", {});
			await raw.recordStepOutput(
				legacy,
				"__atomic_metadata:10:legacy",
				encodeMetadata({
					workflowId: legacy,
					name: "legacy",
					inputs: {},
					status: "blocked",
					resumable: true,
					legacyRecoveryPending: true,
					ownerExecutorId: `atomic-db-${crypto.randomUUID()}`,
					createdAt: 1,
					updatedAt: 10,
					completedCheckpoints: 0,
					pendingPrompts: 0,
					promptReservationEpoch: "epoch",
				}),
			);
			const roots = Array.from({ length: POOL_SIZE + 3 }, () => crypto.randomUUID());
			await Promise.all([
				...roots.map(async (id) => {
					await handle.startWorkflow(id, "queued", {});
					await handle.recordStepOutput(id, "__atomic_metadata:10:snapshot", metadata(id));
					await handle.recordStepOutput(id, "checkpoint", { preserved: id });
				}),
				handle.enrollLegacyWorkflow!(legacy, "new-session").then((adopted) =>
					assert.equal(adopted?.ownerExecutorId, owner),
				),
			]);
			for (const id of roots) {
				assert.deepEqual((await handle.readStepRecord!(id, "checkpoint"))?.output, { preserved: id });
				assert.equal(
					(await handle.listStepRecords(id)).filter((record) => record.stepName.startsWith("__atomic_metadata"))
						.length,
					1,
				);
			}
			assert.equal(sql.options.max, POOL_SIZE);
			assert.equal(ownership.options.max, POOL_SIZE);
			// A failed compaction still rejects, rolls back, and returns the transaction checkout.
			await assert.rejects(
				fence.write(roots[0], () =>
					fence!.compactMetadata(
						{ root: roots[0], actor: owner, owner, generation: 10 },
						`${roots[0]}:checkpoint:__atomic_metadata:missing`,
					),
				),
			);
			await handle.recordStepOutput(roots[0], "after-failure", "available");
			assert.equal((await handle.readStepRecord!(roots[0], "after-failure"))?.output, "available");
			assert.equal(await fence.liveness(owner), "alive");
		} finally {
			try {
				if (launched) await DBOS.shutdown();
				else await sql?.end();
				await fence?.close();
			} finally {
				try {
					await home.cleanup();
				} finally {
					await listener.close();
				}
			}
		}
	},
	REAL_OWNER_POOL_CONTENTION_TIMEOUT_MS,
);
