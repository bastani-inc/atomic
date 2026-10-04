import assert from "node:assert/strict";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { Pool } from "pg";
import { test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { durableHash } from "../../packages/workflows/src/durable/backend.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { encodeMetadata } from "../../packages/workflows/src/durable/dbos-metadata.js";
import { DbosOwnerFence } from "../../packages/workflows/src/durable/dbos-owner-fence.js";
import { createRealDbosHandle, type DbosStatic } from "../../packages/workflows/src/durable/dbos-sdk-handle.js";
import { FOREIGN_LIVE_WORKFLOW_WINDOW_MS } from "../../packages/workflows/src/durable/resume-eligibility.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { inspectTargetedDurableWorkflow } from "../../packages/workflows/src/durable/targeted-inspection.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { type ManagedResult, RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";
import { sleep } from "../helpers/runtime.js";
import { mockSession } from "../unit/executor-shared.js";

const REAL_CRASHED_RESUME_TIMEOUT_MS = 180_000;
const RUN_SETTLEMENT_TIMEOUT_MS = 10_000;
const WORKFLOW_NAME = "crashed-resume-claim";

const definition = workflow({
	name: WORKFLOW_NAME,
	description: "",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await ctx.tool("once", {}, async () => "duplicate-effect");
		return {};
	},
});

interface DatabaseGeneration {
	readonly backend: DbosDurableBackend;
	readonly raw: ReturnType<typeof createRealDbosHandle>;
	readonly fence: DbosOwnerFence;
	readonly actor: string;
	readonly stop: () => Promise<void>;
}

async function databaseGeneration(options: {
	connectionString: string;
	connectionTimeoutMillis: number;
	statement_timeout: number;
}): Promise<DatabaseGeneration> {
	const ownership = new Pool(options);
	const sql = new Pool(options);
	const actor = `atomic-db-${crypto.randomUUID()}`;
	const fence = new DbosOwnerFence(
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
	DBOS.setConfig({
		name: "crashed-resume-claim3424",
		systemDatabasePool: fence.protectPool(sql),
		systemDatabaseUrl: options.connectionString,
		runAdminServer: false,
		executorID: crypto.randomUUID(),
	});
	await DBOS.launch();
	return {
		backend: new DbosDurableBackend(createRealDbosHandle(DBOS as unknown as DbosStatic, main, checkpoint, fence)),
		raw: createRealDbosHandle(DBOS as unknown as DbosStatic, main, checkpoint),
		fence,
		actor,
		stop: async () => {
			await DBOS.shutdown({ deregister: true });
			await Promise.all([fence.close(), sql.ended ? undefined : sql.end()]);
		},
	};
}

function recordOnceToolCheckpoint(backend: DbosDurableBackend, workflowId: string, completedAt: number): void {
	const argsHash = durableHash({ name: "once", args: {}, ordinal: 1 });
	backend.recordCheckpoint({
		kind: "tool",
		workflowId,
		checkpointId: `tool:${argsHash}`,
		name: "once",
		argsHash,
		output: "first-process-effect",
		completedAt,
		topology: {
			version: 1,
			nodeId: "tool:once",
			ordinal: 1,
			order: 1,
			parentIds: [],
			startedAt: completedAt - 10,
			endedAt: completedAt,
			run: { runId: workflowId, runName: WORKFLOW_NAME },
		},
	});
}

async function settledRun(store: ReturnType<typeof createStore>, workflowId: string) {
	const deadline = Date.now() + RUN_SETTLEMENT_TIMEOUT_MS;
	while (store.runs().find((run) => run.id === workflowId)?.endedAt === undefined) {
		assert.ok(Date.now() < deadline, "resumed run never settled");
		await sleep(20);
	}
	return store.runs().find((run) => run.id === workflowId);
}

function resumeDeps(backend: DbosDurableBackend, store: ReturnType<typeof createStore>) {
	return {
		registry: createRegistry([definition]),
		baseRunOpts: { store, adapters: { agentSession: { create: async () => mockSession() } } },
		durableBackend: backend,
	};
}

test.each(["retained owner row", "missing owner row", "missing owner row with live owner"])(
	"explicit resume after a host restart with %s preserves fenced ownership and checkpoints (#3424)",
	async (ownerState) => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		let generation: DatabaseGeneration | undefined;
		let liveOwner: DbosOwnerFence | undefined;
		try {
			const { url } = await home.client(listener.port).request<ManagedResult>("ensure");
			const endpoint = new URL(url);
			endpoint.pathname = "/postgres";
			const options = { connectionString: endpoint.href, connectionTimeoutMillis: 3_000, statement_timeout: 10_000 };
			const workflowId = crypto.randomUUID();
			let producerClock = Date.now() - 2 * FOREIGN_LIVE_WORKFLOW_WINDOW_MS;
			const producedAt = producerClock;
			const clock = vi.spyOn(Date, "now").mockImplementation(() => producerClock++);
			try {
				generation = await databaseGeneration(options);
				generation.backend.registerWorkflow({
					workflowId,
					name: WORKFLOW_NAME,
					inputs: {},
					createdAt: producedAt,
					status: "running",
				});
				recordOnceToolCheckpoint(generation.backend, workflowId, producedAt);
				await generation.backend.flush(workflowId);
				const observer = new Pool(options);
				try {
					const row = await observer.query<{ owner: string }>(
						"SELECT owner FROM dbos.atomic_owner_generation WHERE root = $1",
						[workflowId],
					);
					assert.equal(row.rows[0]?.owner, generation.actor, "new 0.9.26 admission projects its metadata owner");
				} finally {
					await observer.end();
				}
			} finally {
				clock.mockRestore();
			}
			const originalActor = generation.actor;
			await generation.stop();
			if (ownerState !== "retained owner row") {
				const observer = new Pool(options);
				try {
					await observer.query("DELETE FROM dbos.atomic_owner_generation WHERE root = $1", [workflowId]);
					assert.equal(
						(await observer.query("SELECT root FROM dbos.atomic_owner_generation WHERE root = $1", [workflowId]))
							.rowCount,
						0,
					);
				} finally {
					await observer.end();
				}
			}

			generation = await databaseGeneration(options);
			const restarted = generation.backend;
			await restarted.hydrateWorkflow(workflowId);
			const inspected = await inspectTargetedDurableWorkflow(restarted, workflowId);
			assert.equal(inspected.kind, "found");
			if (inspected.kind === "found") assert.equal(inspected.detail.status, "crashed");
			if (ownerState === "missing owner row with live owner") {
				const ownership = new Pool(options);
				liveOwner = new DbosOwnerFence(
					() => ownership,
					originalActor,
					() => ownership.end(),
				);
				await liveOwner.write(workflowId, async () => {});
				const recordsBefore = await generation.raw.listStepRecords(workflowId);
				const refusedStore = createStore();
				const refused = await resumeDurableWorkflow(
					workflowId,
					resumeDeps(restarted, refusedStore),
					restarted.listResumableWorkflows(),
				);
				assert.equal(refused.ok, false);
				assert.match(refused.message, /still holds its workflow database ownership connection/);
				assert.deepEqual(await generation.raw.listStepRecords(workflowId), recordsBefore);
				assert.equal(refusedStore.runs().length, 0);
				await liveOwner.close();
			}

			const store = createStore();
			const resumed = await resumeDurableWorkflow(
				workflowId,
				resumeDeps(restarted, store),
				restarted.listResumableWorkflows(),
			);
			assert.deepEqual({ ok: resumed.ok, message: resumed.message }, { ok: true, message: resumed.message });
			const terminal = await settledRun(store, workflowId);
			assert.equal(terminal?.status, "completed");
			assert.equal(terminal?.toolNodes?.[0]?.status, "cached");
		} finally {
			try {
				await liveOwner?.close();
				await generation?.stop();
			} finally {
				try {
					await home.cleanup();
				} finally {
					await listener.close();
				}
			}
		}
	},
	REAL_CRASHED_RESUME_TIMEOUT_MS,
);

test.each(["atomic-legacy-executor", undefined])(
	"explicit resume after restart with unverifiable metadata owner %s names the stale state and recovery path (#3424)",
	async (legacyExecutor) => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		let generation: DatabaseGeneration | undefined;
		try {
			const { url } = await home.client(listener.port).request<ManagedResult>("ensure");
			const endpoint = new URL(url);
			endpoint.pathname = "/postgres";
			const options = { connectionString: endpoint.href, connectionTimeoutMillis: 3_000, statement_timeout: 10_000 };
			const workflowId = crypto.randomUUID();
			generation = await databaseGeneration(options);
			await generation.raw.startWorkflow(workflowId, WORKFLOW_NAME, {});
			await DBOS.retrieveWorkflow(workflowId).getResult();
			const legacyUpdatedAt = Date.now() - 2 * FOREIGN_LIVE_WORKFLOW_WINDOW_MS;
			await generation.raw.recordStepOutput(
				workflowId,
				`__atomic_metadata:${legacyUpdatedAt}:legacy`,
				encodeMetadata({
					workflowId,
					name: WORKFLOW_NAME,
					inputs: {},
					status: "running",
					ownerExecutorId: legacyExecutor,
					modelOwner: "old-session",
					createdAt: legacyUpdatedAt - 1,
					updatedAt: legacyUpdatedAt,
					completedCheckpoints: 1,
					pendingPrompts: 0,
					promptReservationEpoch: "epoch",
				}),
			);
			await generation.stop();

			generation = await databaseGeneration(options);
			const restarted = generation.backend;
			await restarted.hydrateWorkflow(workflowId);
			const recordsBefore = await generation.raw.listStepRecords(workflowId);

			const inspected = await inspectTargetedDurableWorkflow(restarted, workflowId);
			assert.equal(inspected.kind, "found");
			if (inspected.kind === "found") {
				assert.equal(inspected.detail.status, "crashed");
				assert.match(
					inspected.detail.resumeGuidance ?? "",
					legacyExecutor === undefined ? /missing ownerExecutorId/ : /unfenced executor/,
				);
				if (legacyExecutor === undefined) {
					assert.match(inspected.detail.resumeGuidance ?? "", /known-good workflow database backup/);
					assert.doesNotMatch(inspected.detail.resumeGuidance ?? "", /session\.workflows\.resume/);
				}
			}

			const store = createStore();
			const refused = await resumeDurableWorkflow(
				workflowId,
				resumeDeps(restarted, store),
				restarted.listResumableWorkflows(),
			);
			assert.equal(refused.ok, false);
			assert.doesNotMatch(refused.message, /changed while resume was pending/);
			assert.match(
				refused.message,
				legacyExecutor === undefined ? /missing ownerExecutorId/ : /atomic-legacy-executor/,
			);
			assert.doesNotMatch(refused.message, /predates/);
			if (legacyExecutor === undefined) {
				assert.match(refused.message, /known-good workflow database backup/);
				assert.match(refused.message, /SDK controlled recovery is unavailable/);
				assert.doesNotMatch(refused.message, /session\.workflows\.resume/);
			} else assert.match(refused.message, /legacyRecovery/);
			assert.deepEqual(
				await generation.raw.listStepRecords(workflowId),
				recordsBefore,
				"a refused claim must not write to the unfenced owner's root",
			);
			assert.equal(store.runs().length, 0, "a refused claim must not launch an executor");
		} finally {
			try {
				await generation?.stop();
			} finally {
				try {
					await home.cleanup();
				} finally {
					await listener.close();
				}
			}
		}
	},
	REAL_CRASHED_RESUME_TIMEOUT_MS,
);
