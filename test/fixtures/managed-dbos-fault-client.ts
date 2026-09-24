import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { embeddedPostgresHealth } from "../../packages/workflows/src/durable/dbos-embedded-postgres.js";
import { shutdownDbos } from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import { managedPostgresMetadata } from "../../packages/workflows/src/durable/dbos-postgres-ownership.js";
import { initializeDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import {
	workflowQuitAction,
	workflowResumeAction,
} from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { INTERACTIVE_WORKFLOW_POLICY } from "../../packages/workflows/src/shared/types.js";
import { sleep } from "../helpers/runtime.js";

const home = process.env.ATOMIC_FAULT_TEST_HOME;
assert.ok(home && resolve(homedir()) === resolve(home), "requires disposable HOME");
assert.notEqual(process.getuid?.(), 0, "root uses shared /var/lib; refuse fault injection");
assert.equal(process.env.DBOS_SYSTEM_DATABASE_URL, undefined, "must use managed production pools");
const base = join(home, ".atomic", "postgres");
let backend: DbosDurableBackend | undefined;
let runId: string | undefined;
let completedCalls = 0;
let frontierCalls = 0;
const definition = workflow({
	name: "managed-pool-fault",
	description: "Real managed DBOS reconnection #3072/#3074",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("completed", {}, async () => {
			completedCalls++;
			return "persisted";
		});
		await ctx.tool("frontier", {}, async ({ signal }) => {
			frontierCalls++;
			if (frontierCalls === 1) {
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			}
			return "done";
		});
		return {};
	},
});
const runtime = createExtensionRuntime({ definitions: [definition], store });
async function until(predicate: () => boolean, label: string) {
	const deadline = Date.now() + 20_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, label);
		await sleep(20);
	}
}
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
	const { id, command, sql } = JSON.parse(line) as { id: number; command: string; sql?: string };
	try {
		let result: object = {};
		if (command === "warm") {
			const initialized = await initializeDurableBackend((message) => {
				throw new Error(message);
			});
			assert.ok(initialized instanceof DbosDurableBackend);
			backend = initialized;
			({ runId } = runDetached(definition, {}, { store }));
			await until(() => frontierCalls === 1, "completed checkpoint was not written");
			const job = jobTracker.get(runId);
			assert.ok(job);
			await backend.flush(runId);
			const paused = await workflowQuitAction({ action: "quit", runId });
			assert.equal(paused.action, "quit");
			assert.equal(paused.status, "paused", JSON.stringify(paused));
			await job.promise;
			await backend.flush(runId);
			assert.equal(completedCalls, 1);
			result = { runId, metadata: managedPostgresMetadata(base, 18, false) };
		} else if (command === "metadata") {
			// Disk-only observation: do not call ensure, doctor, recover or construct a SQL client.
			result = { metadata: managedPostgresMetadata(base, 18, false) };
		} else if (command === "health-diagnostics") {
			// Read-only: observing a failure must not trigger recovery.
			const failure = embeddedPostgresHealth()?.lastFailure;
			result = { lastFailure: failure?.stack ?? failure?.message };
		} else if (command === "resume") {
			assert.ok(backend && runId);
			const resumed = await workflowResumeAction(
				{ action: "resume", runId },
				{
					getRuntime: () => runtime,
					policy: INTERACTIVE_WORKFLOW_POLICY,
					ensureWorkflowResourcesLoaded: async () => {},
				},
			);
			assert.equal(resumed.action, "resume");
			assert.notEqual(resumed.status, "noop", JSON.stringify(resumed));
			await until(
				() => store.runs().find((run) => run.id === runId)?.status === "completed",
				"resume did not complete",
			);
			await backend.flush(runId);
			assert.equal(completedCalls, 1, "recovery repeated completed author work");
			result = { runId, completedCalls, metadata: managedPostgresMetadata(base, 18, false) };
		} else if (command === "inspect-peer") {
			assert.ok(backend && runId);
			assert.ok(sql && sql !== runId);
			// This process has never cached the peer run. Hydration uses its pre-outage DBOS pool.
			await backend.hydrateWorkflow(sql);
			assert.equal(backend.getWorkflow(sql)?.status, "completed");
			assert.ok(
				backend.listCheckpoints(sql).some((checkpoint) => checkpoint.kind === "tool" && checkpoint.name === "completed"),
			);
			result = { persisted: true };
		} else if (command === "exit") {
			await shutdownDbos();
			console.log(JSON.stringify({ id, result }));
			process.exit(0);
		} else throw new Error(`Unknown command ${command}`);
		console.log(JSON.stringify({ id, result }));
	} catch (error) {
		console.log(JSON.stringify({ id, error: error instanceof Error ? error.stack : String(error) }));
	}
}
