import assert from "node:assert/strict";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { Pool } from "pg";
import { test } from "vitest";
import { boundedAdmission, DbosDependencyError } from "../../packages/workflows/src/durable/dbos-admission.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { DbosOwnerFence } from "../../packages/workflows/src/durable/dbos-owner-fence.js";
import { createRealDbosHandle, type DbosStatic } from "../../packages/workflows/src/durable/dbos-sdk-handle.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { type ManagedResult, RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";

// Protects admission's ordering, not the internals of the workflow runner: a
// delayed identity marker must settle before ownership metadata is enrolled.
test("production root markers settle before enrollment without retaining admission pool slots", async () => {
	const home = new RealPostgresHome();
	const listener = await reserveListener();
	const finish = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const finishNever = Promise.withResolvers<void>();
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
			systemDatabasePool: fence.protectPool(sql),
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
		assert.equal(
			(
				await control.query(
					"SELECT count(*)::int AS count FROM dbos.workflow_status WHERE starts_with(workflow_uuid,$1)",
					[`${failedId}:checkpoint:__atomic_metadata`],
				)
			).rows[0].count,
			0,
			"aborted marker settlement must not leave half-enrolled metadata",
		);
		await handle.startWorkflow(orphan, "orphan", {});
		const restored = new DbosDurableBackend(handle);
		assert.equal((await restored.hydrateWorkflowForInspection(orphan)).kind, "malformed");
		assert.equal(restored.getWorkflow(orphan), undefined);
		assert.equal(restored.isWorkflowLoadable(orphan), false);
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
}, 180_000);
