import assert from "node:assert/strict";
import type { Pool } from "pg";
import { test } from "vitest";
import { configureAdmissionDatabase } from "../../packages/workflows/src/durable/dbos-admission-config.js";
import { importDbosSdk } from "../../packages/workflows/src/durable/dbos-backend.js";
import { encodeMetadata } from "../../packages/workflows/src/durable/dbos-metadata.js";
import { requestDbosPoolSize } from "../../packages/workflows/src/durable/dbos-pool-size.js";
import { getDbosProcessOwner, resetDbosProcessOwner } from "../../packages/workflows/src/durable/dbos-process-owner.js";
import { createRealDbosHandle } from "../../packages/workflows/src/durable/dbos-sdk-handle.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { type ManagedResult, RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";

const REAL_CONFIGURED_POOL_SIZE_TIMEOUT_MS = 180_000;

test(
	"configured pool size is honored by DBOS SQL while concurrent admissions and checkpoints complete",
	async () => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		const sdk = await importDbosSdk();
		let sql: Pool | undefined;
		let launched = false;
		resetDbosProcessOwner();
		try {
			const { url } = await home.client(listener.port).request<ManagedResult>("ensure");
			const endpoint = new URL(url);
			endpoint.pathname = "/postgres";
			requestDbosPoolSize(2);
			const main = sdk.registerWorkflow(
				async (_name: string, inputs: Record<string, WorkflowSerializableValue>) => inputs,
				{ name: "atomicWorkflowHandle" },
			);
			const checkpoint = sdk.registerWorkflow(
				async (_id: string, _step: string, output: WorkflowSerializableValue) => output,
				{ name: "atomicWorkflowCheckpoint" },
			);
			const owner = `atomic-db-${crypto.randomUUID()}`;
			const database = configureAdmissionDatabase(
				{
					setConfig(config) {
						sql = config.systemDatabasePool;
						sdk.setConfig(config);
					},
					launch: () => sdk.launch(),
				},
				{
					name: "configured-pool-size",
					systemDatabaseUrl: endpoint.href,
					executorID: owner,
					runAdminServer: false,
					logger: { info() {}, debug() {}, warn() {}, error() {} },
				},
			);
			assert.equal(sql?.options.max, 2);
			await database.launch();
			launched = true;
			const fence = getDbosProcessOwner().executorFence;
			assert.ok(fence);
			const handle = createRealDbosHandle(sdk, main, checkpoint, fence);
			const roots = Array.from({ length: 5 }, () => crypto.randomUUID());
			await Promise.all(
				roots.map(async (id) => {
					await handle.startWorkflow(id, "pooled", {});
					await handle.recordStepOutput(
						id,
						"__atomic_metadata:10:snapshot",
						encodeMetadata({
							workflowId: id,
							name: "pooled",
							inputs: {},
							status: "paused",
							createdAt: 1,
							updatedAt: 10,
							completedCheckpoints: 0,
							pendingPrompts: 0,
							promptReservationEpoch: "epoch",
							ownerExecutorId: owner,
						}),
					);
					await handle.recordStepOutput(id, "checkpoint", id);
				}),
			);
			for (const id of roots) assert.equal((await handle.readStepRecord!(id, "checkpoint"))?.output, id);
			assert.equal(sql?.options.max, 2);
			await database.checkReady();
		} finally {
			try {
				if (launched) await sdk.shutdown({ deregister: true });
				else await sql?.end();
				await Promise.all([...(getDbosProcessOwner().executorFences ?? [])].map((fence) => fence.close()));
			} finally {
				resetDbosProcessOwner();
				try {
					await home.cleanup();
				} finally {
					await listener.close();
				}
			}
		}
	},
	REAL_CONFIGURED_POOL_SIZE_TIMEOUT_MS,
);
