import assert from "node:assert/strict";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { Pool } from "pg";
import { test } from "vitest";
import {
	boundedAdmission,
	DbosDependencyError,
	dbosAdmissionContext,
} from "../../packages/workflows/src/durable/dbos-admission.js";
import { fenceDbosAdmissionPool } from "../../packages/workflows/src/durable/dbos-admission-pool.js";
import { reconcileDbosAdmission } from "../../packages/workflows/src/durable/dbos-admission-recovery.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { DbosOwnerFence } from "../../packages/workflows/src/durable/dbos-owner-fence.js";
import { createRealDbosHandle, type DbosStatic } from "../../packages/workflows/src/durable/dbos-sdk-handle.js";
import { inspectTargetedDurableWorkflow } from "../../packages/workflows/src/durable/targeted-inspection.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { type ManagedResult, RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";

const REAL_POSTGRES_ROOT_MARKER_SETTLEMENT_TIMEOUT_MS = 180_000;

// Protects admission's ordering, not the internals of the workflow runner: a
// delayed identity marker must settle before ownership metadata is enrolled.
// DBOS runs on the production admission pool (`fenceDbosAdmissionPool` under the
// owner fence), so an abandoned admission's marker inherits its expired signal.
test(
	"production root markers settle before enrollment without retaining admission pool slots",
	async () => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		const finish = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const finishNever = Promise.withResolvers<void>();
		const neverReturned = Promise.withResolvers<void>();
		let count = 0;
		let fence: DbosOwnerFence | undefined;
		let sql: Pool | undefined;
		let control: Pool | undefined;
		let launched = false;
		const admissions: Promise<void>[] = [];
		try {
			const { url } = await home.client(listener.port).request<ManagedResult>("ensure");
			const endpoint = new URL(url);
			endpoint.pathname = "/postgres";
			const config = { connectionString: endpoint.href, max: 3, connectionTimeoutMillis: 3_000 };
			// Metadata compaction also borrows ownership clients; constrain the DBOS
			// execution pool independently to exercise marker settlement capacity.
			const ownership = new Pool({ ...config, max: 12 });
			sql = new Pool(config);
			control = new Pool(config);
			const executorId = `atomic-db-${crypto.randomUUID()}`;
			fence = new DbosOwnerFence(
				() => ownership,
				executorId,
				() => ownership.end(),
			);
			const root = DBOS.registerWorkflow(
				async (name: string, inputs: Record<string, WorkflowSerializableValue>) => {
					if (name === "delayed") {
						if (++count === 5) started.resolve();
						await finish.promise;
					} else if (name === "never") {
						await finishNever.promise;
						neverReturned.resolve();
					}
					return inputs;
				},
				{ name: "atomicWorkflowHandle" },
			);
			const checkpoint = DBOS.registerWorkflow(
				async (_id: string, _step: string, output: WorkflowSerializableValue) => output,
				{ name: "atomicWorkflowCheckpoint" },
			);
			DBOS.setConfig({
				name: "marker-settlement",
				systemDatabaseUrl: endpoint.href,
				systemDatabasePool: fence.protectPool(fenceDbosAdmissionPool(sql)),
				executorID: executorId,
				runAdminServer: false,
			});
			await DBOS.launch();
			launched = true;
			const handle = createRealDbosHandle(DBOS as unknown as DbosStatic, root, checkpoint, fence, [], {
				settleRootMarker: true,
			});
			const backend = new DbosDurableBackend(handle);
			const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
			for (const workflowId of ids)
				admissions.push(
					backend.admitWorkflow(
						workflowId,
						{ workflowId, name: "delayed", inputs: {}, status: "running", createdAt: Date.now() },
						AbortSignal.timeout(10_000),
					),
				);
			await boundedAdmission(() => started.promise, undefined, 5_000);
			assert.equal(
				(
					await control.query(
						"SELECT count(*)::int AS count FROM dbos.workflow_status WHERE name='atomicWorkflowCheckpoint'",
					)
				).rows[0].count,
				0,
				"metadata must not enroll before root settlement",
			);
			assert.equal(
				(
					await control.query(
						"SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name LIKE 'atomic-guard:%' AND state='idle in transaction'",
					)
				).rows[0].count,
				0,
				"settlement must not hold admission locks or clients",
			);
			finish.resolve();
			await Promise.all(admissions);
			for (const id of ids) assert.equal((await handle.retrieveWorkflow(id))?.status, "SUCCESS");

			// A successfully published marker without metadata (the crash window) is
			// not a user run and cannot be hydrated for resume.
			const orphan = crypto.randomUUID();
			const failedId = crypto.randomUUID();
			await assert.rejects(
				boundedAdmission(
					(signal) =>
						backend.admitWorkflow(
							failedId,
							{ workflowId: failedId, name: "never", inputs: {}, status: "running", createdAt: Date.now() },
							signal,
						),
					undefined,
					3_000,
					"Root marker admission deadline expired.",
				),
				(error: unknown) =>
					error instanceof DbosDependencyError && error.message.includes("Root marker admission deadline expired"),
			);
			const db = control;
			const metadataRows = async (id: string): Promise<number> =>
				(
					await db.query(
						"SELECT count(*)::int AS count FROM dbos.workflow_status WHERE starts_with(workflow_uuid,$1)",
						[`${id}:checkpoint:__atomic_metadata`],
					)
				).rows[0].count;
			const rootStatus = async (id: string): Promise<string | undefined> =>
				(await db.query("SELECT status FROM dbos.workflow_status WHERE workflow_uuid=$1", [id])).rows[0]?.status;
			assert.equal(
				await metadataRows(failedId),
				0,
				"aborted marker settlement must not leave half-enrolled metadata",
			);
			assert.equal(await rootStatus(failedId), "PENDING");

			// The abandoned marker's own continuation now returns, but the admission
			// pool refuses its outcome write under the expired admission signal.
			finishNever.resolve();
			await boundedAdmission(() => neverReturned.promise, undefined, 5_000);
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			assert.equal(await rootStatus(failedId), "PENDING", "an abandoned marker cannot persist its outcome");

			// Neither a same-ID retry nor admission recovery may enroll that root:
			// both wait on the never-settling marker and fail at their own deadline.
			const expired = (error: unknown) =>
				error instanceof DbosDependencyError && error.message.includes("Retry admission deadline expired");
			await assert.rejects(
				boundedAdmission(
					(signal) =>
						backend.admitWorkflow(
							failedId,
							{ workflowId: failedId, name: "never", inputs: {}, status: "running", createdAt: Date.now() },
							signal,
						),
					undefined,
					3_000,
					"Retry admission deadline expired.",
				),
				expired,
			);
			assert.equal(backend.isAdmissionUnavailable(failedId), true, "the identity stays a bounded retry target");
			await assert.rejects(
				boundedAdmission(
					(signal) =>
						dbosAdmissionContext.run(signal, () =>
							reconcileDbosAdmission(
								handle,
								{
									workflowId: failedId,
									name: "never",
									inputs: {},
									status: "running",
									completedCheckpoints: 0,
									pendingPrompts: 0,
									createdAt: Date.now(),
									promptReservationEpoch: crypto.randomUUID(),
									updatedAt: Date.now(),
									ownerExecutorId: executorId,
								},
								true,
							),
						),
					undefined,
					3_000,
					"Retry admission deadline expired.",
				),
				expired,
			);
			assert.equal(await metadataRows(failedId), 0, "a never-settled root is never enrolled");
			assert.equal(await rootStatus(failedId), "PENDING");
			await handle.startWorkflow(orphan, "orphan", {});
			const restored = new DbosDurableBackend(handle);
			assert.equal((await restored.hydrateWorkflowForInspection(orphan)).kind, "absent");
			assert.equal(restored.getWorkflow(orphan), undefined);
			assert.equal(restored.isWorkflowLoadable(orphan), false);
			const inspected = await inspectTargetedDurableWorkflow(restored, orphan);
			assert.equal(inspected.kind, "absent");
			assert.ok("message" in inspected);
			assert.match(inspected.message, /Run not found:/);
			const catalog = await restored.prepareWorkflowCatalog();
			assert.ok(!catalog.inspectableIds?.includes(orphan));
			assert.ok(!catalog.resumable.some((entry) => entry.workflowId === orphan));
			assert.ok(!catalog.completed.some((entry) => entry.workflowId === orphan));

			// Checkpoints without metadata are damaged retained state, not an
			// unadmitted marker. They must still fail closed as malformed.
			const incomplete = crypto.randomUUID();
			await handle.startWorkflow(incomplete, "incomplete", {});
			await handle.recordStepOutput(incomplete, "tool:retained", "retained");
			assert.equal((await restored.hydrateWorkflowForInspection(incomplete)).kind, "malformed");
		} finally {
			finish.resolve();
			finishNever.resolve();
			await Promise.allSettled(admissions);
			try {
				if (launched) await DBOS.shutdown();
				else await sql?.end();
				await control?.end();
				await fence?.close();
			} finally {
				await home.cleanup();
				await listener.close();
			}
		}
	},
	REAL_POSTGRES_ROOT_MARKER_SETTLEMENT_TIMEOUT_MS,
);
