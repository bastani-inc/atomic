import assert from "node:assert/strict";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { Pool } from "pg";
import { test, vi } from "vitest";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { encodeCheckpoint } from "../../packages/workflows/src/durable/dbos-envelope.js";
import { encodeMetadata } from "../../packages/workflows/src/durable/dbos-metadata.js";
import { DbosOwnerFence } from "../../packages/workflows/src/durable/dbos-owner-fence.js";
import { createRealDbosHandle, type DbosStatic } from "../../packages/workflows/src/durable/dbos-sdk-handle.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { type ManagedResult, RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";
import { sleep } from "../helpers/runtime.js";

const REAL_CONTROLLED_ENROLLMENT_TIMEOUT_MS = 180_000;
const NATIVE_QUEUE_SETTLEMENT_MS = 10_000;

test(
	"controlled legacy enrollment drains old SQL and isolates native queued rows while preserving checkpoints (#3419)",
	async () => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		let sql: Pool | undefined;
		let control: Pool | undefined;
		let fence: DbosOwnerFence | undefined;
		let launched = false;
		try {
			const { url } = await home.client(listener.port).request<ManagedResult>("ensure");
			const endpoint = new URL(url);
			endpoint.pathname = "/postgres";
			const options = { connectionString: endpoint.href, connectionTimeoutMillis: 3_000, statement_timeout: 10_000 };
			sql = new Pool(options);
			control = new Pool(options);
			const ownership = new Pool(options);
			const actor = `atomic-db-${crypto.randomUUID()}`;
			fence = new DbosOwnerFence(
				() => ownership,
				actor,
				() => ownership.end(),
			);
			const main = DBOS.registerWorkflow(
				async (_name: string, inputs: Record<string, WorkflowSerializableValue>) => inputs,
				{ name: "atomicWorkflowHandle" },
			);
			const checkpoint = DBOS.registerWorkflow(
				async (_id: string, _step: string, output: WorkflowSerializableValue) => output,
				{ name: "atomicWorkflowCheckpoint" },
			);
			const unrelated = DBOS.registerWorkflow(async () => DBOS.runStep(async () => "queue replay"), {
				name: "unrelatedWorkflow",
			});
			DBOS.setConfig({
				name: "enrollment3419",
				systemDatabasePool: sql,
				systemDatabaseUrl: endpoint.href,
				runAdminServer: false,
				executorID: crypto.randomUUID(),
			});
			await DBOS.launch();
			launched = true;
			const raw = createRealDbosHandle(DBOS as unknown as DbosStatic, main, checkpoint);
			const backend = new DbosDurableBackend(
				createRealDbosHandle(DBOS as unknown as DbosStatic, main, checkpoint, fence),
			);
			const id = crypto.randomUUID();
			await raw.startWorkflow(id, "legacy", {});
			await DBOS.retrieveWorkflow(id).getResult();
			await raw.recordStepOutput(
				id,
				"__atomic_metadata:10:legacy",
				encodeMetadata({
					workflowId: id,
					name: "legacy",
					inputs: {},
					status: "running",
					ownerExecutorId: "legacy-executor",
					modelOwner: "old-session",
					createdAt: 1,
					updatedAt: 10,
					completedCheckpoints: 0,
					pendingPrompts: 0,
					promptReservationEpoch: "epoch",
				}),
			);
			await DBOS.shutdown();
			launched = false;
			sql = new Pool(options);
			DBOS.setConfig({
				name: "enrollment3419",
				systemDatabasePool: fence.protectPool(sql),
				systemDatabaseUrl: endpoint.href,
				runAdminServer: false,
				executorID: crypto.randomUUID(),
			});
			await DBOS.launch();
			launched = true;
			assert.equal(
				(await control.query("SELECT count(*)::int AS count FROM dbos.atomic_guard_protocol")).rows[0].count,
				1,
			);
			await backend.hydrateWorkflowForInspection(id);
			assert.equal(backend.getWorkflow(id)?.modelOwner, "old-session");
			const old = await control.connect();
			let enrollment: Promise<boolean> | undefined;
			try {
				await old.query("BEGIN");
				await old.query(
					"UPDATE dbos.workflow_status SET status='CANCELLED', application_version=NULL WHERE workflow_uuid=$1",
					[id],
				);
				let enrolled = false;
				enrollment = backend
					.enrollLegacyWorkflow(id, { olderWorkersStopped: true, modelOwner: "new-session" })
					.then((result) => {
						enrolled = true;
						return result;
					});
				const blockedDeadline = Date.now() + NATIVE_QUEUE_SETTLEMENT_MS;
				while (
					!(
						await control.query<{ blocked: boolean }>(
							"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') AS blocked",
							[`atomic-sql:${id}`],
						)
					).rows[0].blocked
				) {
					assert.ok(Date.now() < blockedDeadline, "enrollment never reached the outstanding SQL transaction");
					await sleep(20);
				}
				assert.equal(enrolled, false, "enrollment must wait until old actual SQL releases its root transaction");
				await old.query("COMMIT");
				assert.equal(await enrollment, true);
			} finally {
				await old.query("ROLLBACK");
				old.release(true);
				await enrollment;
			}
			assert.equal(backend.getWorkflow(id)?.modelOwner, "new-session");
			assert.equal(backend.getWorkflow(id)?.status, "blocked");
			assert.equal(backend.getWorkflow(id)?.ownerExecutorId, actor);
			const before = await raw.listStepRecords(id);
			await control.query(
				"CREATE TABLE dbos.test_native_attempts(id text); CREATE FUNCTION dbos.test_observe_native() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN IF NEW.status='PENDING' AND OLD.status='ENQUEUED' AND current_setting('atomic.row_authority',true) = 'null' THEN INSERT INTO dbos.test_native_attempts VALUES(NEW.workflow_uuid); END IF; RETURN NEW; END $$; CREATE TRIGGER aaa_native_observer BEFORE UPDATE ON dbos.workflow_status FOR EACH ROW EXECUTE FUNCTION dbos.test_observe_native()",
			);
			const projected = (
				await control.query<{ generation: string }>(
					"SELECT generation FROM dbos.atomic_owner_generation WHERE root=$1",
					[id],
				)
			).rows[0];
			const activeSql = sql;
			const activeFence = fence;
			await activeFence.write(id, () =>
				activeFence.withRowAuthority(
					{ root: id, actor, owner: actor, generation: Number(projected.generation) },
					async () => {
						await activeSql.query(
							"UPDATE dbos.workflow_status SET status='ENQUEUED', queue_name='_dbos_internal_queue' WHERE workflow_uuid=$1",
							[id],
						);
					},
				),
			);
			const ordinaryId = crypto.randomUUID();
			await (await DBOS.startWorkflow(unrelated, { workflowID: ordinaryId })()).getResult();
			await control.query("UPDATE dbos.workflow_status SET status='CANCELLED' WHERE workflow_uuid=$1", [ordinaryId]);
			await DBOS.resumeWorkflows([id, ordinaryId]);
			await DBOS.retrieveWorkflow(ordinaryId).getResult();
			const deadline = Date.now() + NATIVE_QUEUE_SETTLEMENT_MS;
			while (
				(
					await control.query<{ status: string }>(
						"SELECT status FROM dbos.workflow_status WHERE workflow_uuid=$1",
						[ordinaryId],
					)
				).rows[0]?.status !== "SUCCESS"
			) {
				assert.ok(Date.now() < deadline, "unrelated native queued workflow did not finish");
				await sleep(20);
			}
			assert.equal(
				(
					await control.query<{ status: string }>(
						"SELECT status FROM dbos.workflow_status WHERE workflow_uuid=$1",
						[id],
					)
				).rows[0].status,
				"ENQUEUED",
			);
			assert.ok(
				(
					await control.query<{ attempts: number }>(
						"SELECT count(*)::int AS attempts FROM dbos.test_native_attempts WHERE id=$1",
						[id],
					)
				).rows[0].attempts >= 1,
				"the actual actorless SDK queue must attempt the enrolled NULL-version root",
			);
			assert.deepEqual(
				await raw.listStepRecords(id),
				before,
				"native queued recovery must not append or alter enrolled legacy checkpoints",
			);
			assert.equal(
				await backend.enrollLegacyWorkflow(id, { olderWorkersStopped: true, modelOwner: "another" }),
				false,
			);
			await activeFence.write(id, () =>
				activeFence.withRowAuthority(
					{ root: id, actor, owner: actor, generation: Number(projected.generation) },
					async () => {
						await activeSql.query(
							"INSERT INTO dbos.workflow_status(workflow_uuid,name,status) VALUES($1,'atomicWorkflowCheckpoint','PENDING')",
							[`${id}:checkpoint:recoverable`],
						);
					},
				),
			);
			const owned = createRealDbosHandle(DBOS as unknown as DbosStatic, main, checkpoint, activeFence);
			await owned.startWorkflow(id, "legacy", {});
			await owned.resumeWorkflow(id);
			const replayed = encodeCheckpoint({
				kind: "tool",
				workflowId: id,
				checkpointId: "recoverable",
				name: "tool",
				argsHash: "recoverable",
				output: "replayed",
				completedAt: 1,
			});
			await owned.recordStepOutput(id, "recoverable", replayed);
			assert.deepEqual((await owned.readStepRecord!(id, "recoverable"))?.output, replayed);
			await owned.recordStepOutput(id, "recoverable", "must not replace completed work");
			assert.deepEqual((await owned.readStepRecord!(id, "recoverable"))?.output, replayed);
			const clock = vi.spyOn(Date, "now").mockReturnValue(1);
			try {
				await backend.recordCheckpointAsync({
					kind: "tool",
					workflowId: id,
					checkpointId: "monotonic",
					name: "tool",
					argsHash: "monotonic",
					args: {},
					output: "saved",
					completedAt: 1,
				});
				assert.equal(backend.getToolOutput(id, "monotonic"), "saved");
			} finally {
				clock.mockRestore();
			}
			assert.equal(backend.getWorkflow(id)?.legacyRecoveryPending, true);
			const priorRecords = await raw.listStepRecords(id);
			await activeFence.close();
			const successorPool = new Pool(options);
			const successorActor = `atomic-db-${crypto.randomUUID()}`;
			fence = new DbosOwnerFence(
				() => successorPool,
				successorActor,
				() => successorPool.end(),
			);
			const resumed = new DbosDurableBackend(
				createRealDbosHandle(DBOS as unknown as DbosStatic, main, checkpoint, fence),
			);
			await resumed.hydrateWorkflowForInspection(id);
			assert.equal(resumed.getWorkflow(id)?.legacyRecoveryPending, true);
			assert.equal(
				await resumed.enrollLegacyWorkflow(id, { olderWorkersStopped: true, modelOwner: "successor-session" }),
				true,
			);
			assert.equal(resumed.getWorkflow(id)?.legacyRecoveryPending, true);
			assert.equal(resumed.getWorkflow(id)?.ownerExecutorId, successorActor);
			assert.equal(
				await resumed.transitionWorkflowStatus(
					id,
					["blocked"],
					"running",
					undefined,
					true,
					undefined,
					"successor-session",
				),
				true,
			);
			assert.equal(resumed.getWorkflow(id)?.legacyRecoveryPending, undefined);
			for (const record of priorRecords)
				assert.deepEqual(
					(await raw.listStepRecords(id)).find((saved) => saved.stepName === record.stepName),
					record,
				);
		} finally {
			try {
				if (launched) await DBOS.shutdown({ deregister: true });
				await Promise.all([fence?.close(), sql?.ended ? undefined : sql?.end(), control?.end()]);
			} finally {
				try {
					await home.cleanup();
				} finally {
					await listener.close();
				}
			}
		}
	},
	REAL_CONTROLLED_ENROLLMENT_TIMEOUT_MS,
);
