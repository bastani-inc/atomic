import assert from "node:assert/strict";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { Pool } from "pg";
import { test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { DbosOwnerFence } from "../../packages/workflows/src/durable/dbos-owner-fence.js";
import { createRealDbosHandle, type DbosStatic } from "../../packages/workflows/src/durable/dbos-sdk-handle.js";
import { forkDurableWorkflow } from "../../packages/workflows/src/durable/fork-workflow.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { type ManagedResult, RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";

const REAL_WORKFLOW_FORK_TIMEOUT_MS = 180_000;

test(
	"PostgreSQL publishes complete forks but never interrupted checkpoint copies (#3577)",
	async () => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		let pool: Pool | undefined;
		let fence: DbosOwnerFence | undefined;
		let launched = false;
		try {
			const { url } = await home.client(listener.port).request<ManagedResult>("ensure");
			const endpoint = new URL(url);
			endpoint.pathname = "/postgres";
			const options = { connectionString: endpoint.href, connectionTimeoutMillis: 3_000, statement_timeout: 10_000 };
			pool = new Pool(options);
			const ownership = new Pool(options);
			fence = new DbosOwnerFence(
				() => ownership,
				`atomic-db-${crypto.randomUUID()}`,
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
				name: "fork3577",
				systemDatabasePool: fence.protectPool(pool),
				systemDatabaseUrl: endpoint.href,
				runAdminServer: false,
				executorID: crypto.randomUUID(),
			});
			await DBOS.launch();
			launched = true;
			const handle = createRealDbosHandle(DBOS as unknown as DbosStatic, main, checkpoint, fence);
			const backend = new DbosDurableBackend(handle);
			const sourceId = crypto.randomUUID();
			let calls = 0;
			let fail = true;
			const definition = workflow({
				name: "copy",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					for (const name of ["first", "second"]) {
						await ctx.tool(name, {}, async () => {
							calls++;
							return "saved";
						});
					}
					if (fail) throw new Error("interrupted after tools");
					return {};
				},
			});
			await run(definition, {}, { runId: sourceId, durableBackend: backend, cwd: "/source", store: createStore() });
			await backend.flush(sourceId);
			assert.equal(calls, 2);
			const source = backend.getWorkflow(sourceId)!;
			const original = backend.recordCheckpointAsync.bind(backend);
			let interruptedId: string | undefined;
			const copy = vi.spyOn(backend, "recordCheckpointAsync").mockImplementation(async (entry) => {
				interruptedId = entry.workflowId;
				if (entry.kind === "tool" && entry.name === "second") throw new Error("copy interrupted");
				await original(entry);
			});
			try {
				await assert.rejects(forkDurableWorkflow(backend, source, "/target", undefined), /copy interrupted/);
			} finally {
				copy.mockRestore();
			}
			assert.ok(interruptedId);
			await backend.flush(interruptedId);
			const reloaded = new DbosDurableBackend(handle);
			await reloaded.hydrateWorkflowForInspection(interruptedId);
			assert.equal(reloaded.getWorkflow(interruptedId)?.resumable, false);
			assert.equal(reloaded.listCheckpoints(interruptedId).length, 1);
			assert.ok(!reloaded.listResumableWorkflows().some((entry) => entry.workflowId === interruptedId));
			const completedId = await forkDurableWorkflow(backend, source, "/target", undefined);
			await reloaded.hydrateWorkflowForInspection(completedId);
			assert.equal(reloaded.getWorkflow(completedId)?.resumable, true);
			assert.equal(reloaded.listCheckpoints(completedId).length, backend.listCheckpoints(sourceId).length);
			assert.equal(
				reloaded
					.listCheckpoints(completedId)
					.filter((entry) => entry.kind === "tool" && ["first", "second"].includes(entry.name)).length,
				2,
			);
			assert.ok(reloaded.listResumableWorkflows().some((entry) => entry.workflowId === completedId));
			fail = false;
			const jobs = createJobTracker();
			const resumed = await resumeDurableWorkflow(completedId, {
				registry: createRegistry().register(definition),
				durableBackend: reloaded,
				jobs,
				baseRunOpts: { store: createStore(), cwd: "/target" },
			});
			assert.ok(resumed.ok, resumed.message);
			await jobs.get(resumed.runId)?.promise;
			await reloaded.flush(completedId);
			assert.equal(reloaded.getWorkflow(completedId)?.status, "completed", reloaded.getWorkflow(completedId)?.error);
			assert.equal(calls, 2, "resuming the published fork must not repeat completed tool side effects");
		} finally {
			try {
				if (launched) await DBOS.shutdown({ deregister: true });
				await fence?.close();
				if (pool && !pool.ended) await pool.end();
			} finally {
				try {
					await home.cleanup();
				} finally {
					await listener.close();
				}
			}
		}
	},
	REAL_WORKFLOW_FORK_TIMEOUT_MS,
);
