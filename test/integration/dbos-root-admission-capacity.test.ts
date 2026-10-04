import assert from "node:assert/strict";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { Pool } from "pg";
import { test } from "vitest";
import { importDbosSdk } from "../../packages/workflows/src/durable/dbos-backend.js";
import { DbosOwnerFence } from "../../packages/workflows/src/durable/dbos-owner-fence.js";
import { createRealDbosHandle } from "../../packages/workflows/src/durable/dbos-sdk-handle.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { type ManagedResult, RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";

const REAL_ROOT_ADMISSION_CAPACITY_TIMEOUT_MS = 180_000;
const CONTROL_RESPONSE_TIMEOUT_MS = 5_000;
const FENCE_POOL_CAPACITY = 3;

async function responsive<T>(operation: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("unfinished roots blocked admission or control")),
					CONTROL_RESPONSE_TIMEOUT_MS,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

test(
	"unfinished roots beyond fence pool capacity leave admission, inspection and recovery responsive (#3419)",
	async () => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		let fence: DbosOwnerFence | undefined;
		let observer: DbosOwnerFence | undefined;
		let sqlPool: Pool | undefined;
		let launched = false;
		let finishRoots!: () => void;
		const completion = new Promise<void>((resolve) => {
			finishRoots = resolve;
		});
		const admissions: Promise<void>[] = [];
		const rootIds = Array.from({ length: FENCE_POOL_CAPACITY + 2 }, () => crypto.randomUUID());
		try {
			const { url } = await home.client(listener.port).request<ManagedResult>("ensure");
			const endpoint = new URL(url);
			endpoint.pathname = "/postgres";
			const connectionString = endpoint.href;
			const ownerPool = new Pool({ connectionString, max: FENCE_POOL_CAPACITY, connectionTimeoutMillis: 3_000 });
			const observerPool = new Pool({ connectionString, connectionTimeoutMillis: 3_000 });
			const executorId = `atomic-db-${crypto.randomUUID()}`;
			fence = new DbosOwnerFence(
				() => ownerPool,
				executorId,
				() => ownerPool.end(),
			);
			observer = new DbosOwnerFence(
				() => observerPool,
				`atomic-db-${crypto.randomUUID()}`,
				() => observerPool.end(),
			);
			sqlPool = new Pool({ connectionString, connectionTimeoutMillis: 3_000 });
			const root = DBOS.registerWorkflow(
				async (_name: string, inputs: Record<string, WorkflowSerializableValue>) => {
					await completion;
					return inputs;
				},
				{ name: "atomicWorkflowHandle" },
			);
			const checkpoint = DBOS.registerWorkflow(
				async (_id: string, _step: string, output: WorkflowSerializableValue) => output,
				{
					name: "atomicWorkflowCheckpoint",
				},
			);
			DBOS.setConfig({
				name: "capacity3419",
				systemDatabaseUrl: connectionString,
				systemDatabasePool: fence.protectPool(sqlPool),
				executorID: executorId,
				runAdminServer: false,
			});
			await DBOS.launch();
			launched = true;
			const handle = createRealDbosHandle(await importDbosSdk(), root, checkpoint, fence);
			for (const id of rootIds) admissions.push(handle.startWorkflow(id, "blocked", {}));
			await responsive(Promise.all(admissions));
			for (const id of rootIds) assert.equal((await responsive(handle.retrieveWorkflow(id)))?.status, "PENDING");
			assert.equal(await responsive(fence.liveness(executorId)), "alive");
			assert.equal(await responsive(observer.recover(executorId, async () => true)), undefined);
			await responsive(handle.recordStepOutput(rootIds[0], "completed", "preserved"));
			assert.equal((await responsive(handle.readStepRecord!(rootIds[0], "completed")))?.output, "preserved");
			await responsive(handle.cancelWorkflow(rootIds[0]));
			assert.equal((await responsive(handle.retrieveWorkflow(rootIds[0])))?.status, "CANCELLED");
			finishRoots();
			await Promise.allSettled(rootIds.map((id) => DBOS.retrieveWorkflow(id).getResult()));
			await fence.close();
			assert.equal(await responsive(observer.recover(executorId, async () => true)), true);
		} finally {
			finishRoots();
			await Promise.allSettled(admissions);
			try {
				if (launched) await DBOS.shutdown();
				else await sqlPool?.end();
				await Promise.all([fence?.close(), observer?.close()]);
			} finally {
				try {
					await home.cleanup();
				} finally {
					await listener.close();
				}
			}
		}
	},
	REAL_ROOT_ADMISSION_CAPACITY_TIMEOUT_MS,
);
