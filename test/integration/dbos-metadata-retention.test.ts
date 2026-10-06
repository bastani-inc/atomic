import assert from "node:assert/strict";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { Pool, type QueryResult } from "pg";
import { test } from "vitest";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { classifyLatestMetadata, encodeMetadata } from "../../packages/workflows/src/durable/dbos-metadata.js";
import { DbosOwnerFence } from "../../packages/workflows/src/durable/dbos-owner-fence.js";
import { createRealDbosHandle, type DbosStatic } from "../../packages/workflows/src/durable/dbos-sdk-handle.js";
import { ScopedDurableBackend } from "../../packages/workflows/src/durable/scoped-backend.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { type ManagedResult, RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";

const REAL_METADATA_RETENTION_TIMEOUT_MS = 180_000;

test(
	"compacts owned metadata and sibling delivery state without duplicate payloads and restores the latest snapshot (#3467)",
	async () => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		let fence: DbosOwnerFence | undefined;
		let sdkPool: Pool | undefined;
		let control: Pool | undefined;
		let launched = false;
		try {
			const { url } = await home.client(listener.port).request<ManagedResult>("ensure");
			const endpoint = new URL(url);
			endpoint.pathname = "/postgres";
			const ownerPool = new Pool({ connectionString: endpoint.href });
			const owner = `atomic-db-${crypto.randomUUID()}`;
			fence = new DbosOwnerFence(
				() => ownerPool,
				owner,
				() => ownerPool.end(),
			);
			sdkPool = fence.protectPool(new Pool({ connectionString: endpoint.href }));
			control = new Pool({ connectionString: endpoint.href });
			const main = DBOS.registerWorkflow(
				async (_name: string, _inputs: Record<string, WorkflowSerializableValue>) => null,
				{ name: "atomicWorkflowHandle" },
			);
			const checkpoint = DBOS.registerWorkflow(
				async (_id: string, _step: string, output: WorkflowSerializableValue) => output,
				{ name: "atomicWorkflowCheckpoint" },
			);
			DBOS.setConfig({
				name: "retention3467",
				systemDatabasePool: sdkPool,
				systemDatabaseUrl: endpoint.href,
				runAdminServer: false,
				executorID: owner,
			});
			await DBOS.launch();
			launched = true;
			const handle = createRealDbosHandle(DBOS as unknown as DbosStatic, main, checkpoint, fence);
			const root = crypto.randomUUID();
			await handle.startWorkflow(root, "bounded", {});
			for (let index = 0; index < 2; index++) {
				await (
					await DBOS.startWorkflow(checkpoint, {
						workflowID: `${root}:checkpoint:__atomic_metadata:${index}:legacy`,
					})(
						root,
						"legacy",
						encodeMetadata({
							workflowId: root,
							name: "bounded",
							inputs: {},
							status: "paused",
							createdAt: 1,
							updatedAt: index,
							completedCheckpoints: 0,
							pendingPrompts: 0,
							promptReservationEpoch: "epoch",
							ownerExecutorId: owner,
							label: "legacy",
						}),
					)
				).getResult();
			}
			for (let index = 1; index <= 60; index++) {
				await handle.recordStepOutput(
					root,
					`__atomic_metadata:${index}:snapshot`,
					encodeMetadata({
						workflowId: root,
						name: "bounded",
						inputs: {},
						status: "paused",
						createdAt: 1,
						updatedAt: index,
						completedCheckpoints: index,
						pendingPrompts: 0,
						promptReservationEpoch: "epoch",
						ownerExecutorId: owner,
						label: `latest-${index}`,
					}),
				);
				const rows: QueryResult<{ count: number; bytes: number; inputs: number }> = await control.query(
					"SELECT count(*)::int AS count, sum(octet_length(output))::int AS bytes, count(inputs)::int AS inputs FROM dbos.workflow_status WHERE starts_with(workflow_uuid,$1)",
					[`${root}:checkpoint:__atomic_metadata:`],
				);
				assert.equal(rows.rows[0].count, 1);
				assert.equal(rows.rows[0].inputs, 0);
				assert.ok(rows.rows[0].bytes < 1500);
			}
			const current = classifyLatestMetadata(await handle.listStepRecords(root), root);
			assert.ok(current.kind === "current");
			assert.equal(current.metadata.label, "latest-60");
			const retained = (await handle.listStepRecords(root))[0]!;
			await assert.rejects(
				fence.compactMetadata(
					{ root, actor: owner, owner, generation: current.generation - 1 },
					`${root}:checkpoint:${retained.stepName}`,
				),
				/ownership generation changed/,
			);
			assert.equal((await handle.listStepRecords(root)).length, 1);
			const fresh = new DbosDurableBackend(handle);
			await fresh.hydrateWorkflow(root);
			assert.equal(fresh.getWorkflow(root)?.label, "latest-60");
			const blocked = await control.query("DELETE FROM dbos.workflow_status WHERE starts_with(workflow_uuid,$1)", [
				`${root}:checkpoint:__atomic_metadata:`,
			]);
			assert.equal(blocked.rowCount, 0);
			assert.equal((await handle.listStepRecords(root)).length, 1);
			assert.equal(
				(await control.query("SELECT count(*)::int AS count FROM dbos.atomic_guard_rows WHERE root=$1", [root]))
					.rows[0].count,
				2,
			);
			let firstBytes = 0;
			for (let index = 0; index < 120; index++) {
				const childId = `child-${index}`;
				const scoped = new ScopedDurableBackend(fresh, { rootWorkflowId: root, scopePrefix: childId });
				assert.equal(
					await scoped.persistPendingStageMessages(childId, [
						{
							runId: childId,
							id: "message",
							stageKey: "review",
							status: "delivered",
							queuedAt: "now",
							from: { id: "sender", name: "sender" },
							message: { id: "message", timestamp: 1, content: { text: "amendment".repeat(20) } },
						},
					]),
					true,
				);
				const rows: QueryResult<{ count: number; bytes: number; inputs: number }> = await control.query(
					"SELECT count(*)::int AS count, sum(octet_length(output))::int AS bytes, count(inputs)::int AS inputs FROM dbos.workflow_status WHERE starts_with(workflow_uuid,$1)",
					[`${root}:checkpoint:__atomic_metadata:`],
				);
				assert.equal(rows.rows[0].count, 1);
				assert.equal(rows.rows[0].inputs, 0);
				if (index === 49) firstBytes = rows.rows[0].bytes;
				if (index >= 50) assert.ok(rows.rows[0].bytes < firstBytes + 1_000);
			}
			const restored = new DbosDurableBackend(handle);
			await restored.hydrateWorkflow(root);
			assert.equal(restored.getWorkflow(root)?.pendingStageMessages?.length, 50);
			assert.equal((await restored.readSettledPendingStageMessage(root, "message", "child-0"))?.status, "delivered");
		} finally {
			try {
				if (launched) await DBOS.shutdown({ deregister: true });
				await Promise.all([fence?.close(), sdkPool?.ended ? undefined : sdkPool?.end(), control?.end()]);
			} finally {
				try {
					await home.cleanup();
				} finally {
					await listener.close();
				}
			}
		}
	},
	REAL_METADATA_RETENTION_TIMEOUT_MS,
);
