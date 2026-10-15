import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	DBOS_ADMISSION_TIMEOUT_MS,
	DbosDependencyError,
	dbosAdmissionContext,
} from "../../packages/workflows/src/durable/dbos-admission.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { resetDbosLifecycleForTests } from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

afterEach(() => {
	vi.useRealTimers();
	setDurableBackend(undefined);
	resetDbosLifecycleForTests();
});

// #3072 / #3074: both continuation sites must skip unavailable database cleanup.
for (const sourceStatus of ["blocked", "failed"] as const) {
	for (const mode of ["frozen", "refusing"] as const) {
		test(`${sourceStatus} continuation skips cleanup after ${mode} admission and leaves source resumable`, async () => {
			vi.useFakeTimers();
			const sourceId = testRunId("resume-unavailable-source");
			const sdk = createMockSdk();
			let outage = false;
			const reads = vi.fn();
			const backend = new DbosDurableBackend({
				...sdk,
				listStepRecords: async (id) => {
					if (!outage) return sdk.listStepRecords(id);
					reads(id);
					if (mode === "refusing") throw new DbosDependencyError();
					const signal = dbosAdmissionContext.getStore();
					assert.ok(signal);
					return new Promise<never>((_, reject) =>
						signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
					);
				},
				retrieveWorkflow: async (id) => {
					if (!outage) return sdk.retrieveWorkflow(id);
					reads(id);
					return new Promise<never>(() => {});
				},
				listAllWorkflows: async () => {
					if (!outage) return sdk.listAllWorkflows();
					reads();
					return new Promise<never>(() => {});
				},
			});
			backend.registerWorkflow({
				workflowId: sourceId,
				name: "resume-flow",
				inputs: {},
				createdAt: 1,
				status: sourceStatus,
				completedCheckpoints: 1,
				resumable: true,
			});
			await backend.flush(sourceId);
			setDurableBackend(backend);
			const store = createStore();
			store.recordRunStart({
				id: sourceId,
				name: "resume-flow",
				inputs: {},
				status: "running",
				toolNodes: [],
				stages: [],
				startedAt: 1,
			});
			const failure = {
				failedStageId: "only",
				failureKind: "auth" as const,
				failureRecoverability: "recoverable" as const,
				failureDisposition: sourceStatus === "blocked" ? ("active_blocked" as const) : ("terminal_failed" as const),
				failureMessage: "login required",
				resumable: true as const,
			};
			store.recordStageStart(sourceId, {
				id: "only",
				name: "only",
				status: "failed",
				parentIds: [],
				toolEvents: [],
				...failure,
			});
			if (sourceStatus === "blocked") store.recordRunBlocked(sourceId, "login required", failure);
			else store.recordRunEnd(sourceId, "failed", undefined, "login required", failure);
			const source = structuredClone(store.runs()[0]);
			const author = vi.fn(async () => ({}));
			const definition = workflow({ name: "resume-flow", description: "", inputs: {}, outputs: {}, run: author });
			const runtime = createExtensionRuntime({
				registry: createRegistry([definition]),
				store,
				jobs: createJobTracker(),
			});
			// A second attempt also proves the active-blocked claim was released.
			for (let attempt = 0; attempt < 2; attempt++) {
				outage = true;
				let settled = false;
				let continuationId = "";
				const pending = runtime
					.resumeFailedRun(sourceId, undefined, {
						onRunAccepted: (id) => {
							continuationId = id;
						},
					})
					.then((result) => {
						settled = true;
						return result;
					});
				await vi.advanceTimersByTimeAsync(DBOS_ADMISSION_TIMEOUT_MS);
				assert.equal(
					settled,
					true,
					`resume exceeded admission bound; cleanup reads=${JSON.stringify(reads.mock.calls)}`,
				);
				const result = await pending;
				assert.equal(result.ok, false);
				if (result.ok) assert.fail("unavailable admission cannot succeed");
				assert.equal(result.reason, "insufficient_state");
				assert.match(result.message, /No executor was launched/u);
				assert.match(result.message, /Workflow database (admission timed out|unavailable during admission)/u);
				assert.equal(continuationId, "");
				assert.deepEqual(
					store.runs().find((entry) => entry.id === sourceId),
					source,
				);
			}
			assert.equal(reads.mock.calls.length, 2, "only the two bounded admission reads, no cleanup reads");
			assert.equal(author.mock.calls.length, 0);
			assert.deepEqual(sdk.state.deletions, []);
			assert.equal(backend.getWorkflow(sourceId)?.status, sourceStatus);
			assert.equal(backend.getWorkflow(sourceId)?.resumable, true);
			assert.equal(vi.getTimerCount(), 0);
		});
	}
}
