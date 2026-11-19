import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { restoreOnSessionStart, type SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { effectiveRunStatus } from "../../packages/workflows/src/shared/returned-run-status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { adoptWorkflowHostStore } from "../../packages/workflows/src/shared/store-factory.js";
import type { WorkflowFailureCode } from "../../packages/workflows/src/shared/store-types.js";
import { WORKFLOW_INFRASTRUCTURE_FAULTS } from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import { panelItemsFromSnapshot } from "../../packages/workflows/src/tui/panel-runs.js";

/** Restores `entries` as a session start does, keeping finished and blocked runs. */
function restore(entries: SessionEntry[]) {
	const store = createStore();
	restoreOnSessionStart({ getEntries: () => entries }, { resumeInFlight: "never", persistRuns: true }, store);
	const run = store.runs()[0];
	assert.ok(run);
	return run;
}

const start: SessionEntry = {
	id: "e1",
	type: "workflow.run.start",
	payload: { runId: "r1", name: "wf", inputs: {}, ts: 1 },
};
const stageStart: SessionEntry = {
	id: "e2",
	type: "workflow.stage.start",
	payload: { runId: "r1", stageId: "s1", name: "build", parentIds: [], ts: 2 },
};

/** Every failure code a run can record: the type requires each one here. */
const EVERY_FAILURE_CODE: Readonly<Record<WorkflowFailureCode, true>> = {
	login_required: true,
	auth_timeout: true,
	missing_api_key: true,
	invalid_api_key: true,
	forbidden_config: true,
	unknown_model: true,
	rate_limited: true,
	quota_limited: true,
	provider_unavailable: true,
	pending_stage_delivery_failed: true,
	session_unavailable: true,
	worker_lost: true,
	worker_cleanup_unconfirmed: true,
	worker_retry_limit: true,
	worker_startup_failed: true,
	stale_work_lease: true,
	intercom_unavailable: true,
	storage_unavailable: true,
	process_cleanup_unconfirmed: true,
	cancelled: true,
	unknown: true,
};

describe("a restored session keeps every recorded failure code", () => {
	test.each(Object.keys(EVERY_FAILURE_CODE) as WorkflowFailureCode[])(
		"a run that ended on %s keeps the code",
		(code) => {
			const run = restore([
				start,
				{
					id: "e2",
					type: "workflow.run.end",
					payload: {
						runId: "r1",
						status: "failed",
						error: "it failed",
						failureKind: "unknown",
						failureCode: code,
						ts: 2,
					},
				},
			]);
			assert.equal(run.failureCode, code);
		},
	);

	test.each([...WORKFLOW_INFRASTRUCTURE_FAULTS])("a stage and a run that failed on %s keep the code", (code) => {
		const run = restore([
			start,
			stageStart,
			{
				id: "e3",
				type: "workflow.stage.end",
				payload: {
					runId: "r1",
					stageId: "s1",
					status: "failed",
					error: "the pool failed",
					failureKind: "unknown",
					failureCode: code,
					failureRecoverability: "recoverable",
					failureDisposition: "terminal_failed",
				},
			},
			{
				id: "e4",
				type: "workflow.run.end",
				payload: {
					runId: "r1",
					status: "failed",
					error: "the pool failed",
					failureKind: "unknown",
					failureCode: code,
					failureRecoverability: "recoverable",
					failureDisposition: "terminal_failed",
					failedStageId: "s1",
					resumable: true,
					ts: 3,
				},
			},
		]);
		assert.equal(run.stages[0]?.failureCode, code, "stage");
		assert.equal(run.failureCode, code, "run");
	});

	test("a run blocked on a stage whose session store stayed unreachable keeps session_unavailable", () => {
		const code: WorkflowFailureCode = "session_unavailable";
		const run = restore([
			start,
			stageStart,
			{
				id: "e3",
				type: "workflow.run.blocked",
				payload: {
					runId: "r1",
					failedStageId: "s1",
					error: 'Cannot rehydrate stage "build"',
					failureKind: "unknown",
					failureCode: code,
					failureMessage: 'Cannot rehydrate stage "build"',
					failureRecoverability: "recoverable",
					failureDisposition: "active_blocked",
					resumable: true,
					ts: 3,
				},
			},
		]);
		assert.ok(run.blockedAt !== undefined);
		assert.equal(run.failureCode, code);
		assert.equal(effectiveRunStatus(run), "blocked", "it reads as blocked after the restart too");
	});

	test("a code this version does not know is still dropped", () => {
		const run = restore([
			start,
			{
				id: "e2",
				type: "workflow.run.end",
				payload: {
					runId: "r1",
					status: "failed",
					error: "x",
					failureKind: "unknown",
					failureCode: "from_the_future",
					ts: 2,
				},
			},
		]);
		assert.equal(run.failureCode, undefined);
	});
});

describe("a restored block", () => {
	test("a re-adopted store keeps a previously restored block resting in the panel (#5534)", () => {
		const scope = {};
		const { store } = adoptWorkflowHostStore(scope);
		// Older restores kept the block time and recoverability, but not a disposition.
		store.recordRunStart({
			id: "legacy",
			name: "legacy",
			inputs: {},
			status: "running",
			startedAt: 1,
			stages: [],
			toolNodes: [],
			blockedAt: 2,
			resumable: true,
			failureKind: "provider",
			failureRecoverability: "recoverable",
			failedStageId: "build",
			error: "provider unavailable",
		});
		const retained = store.run("legacy");
		const reloaded = adoptWorkflowHostStore(scope).store;
		assert.equal(reloaded, store);
		assert.equal(reloaded.run("legacy"), retained);
		assert.equal(
			panelItemsFromSnapshot(reloaded.graphSnapshot()).find((item) => item.id === "run:legacy")?.state,
			"paused",
		);
	});

	test("recorded without its disposition still reads as blocked: every run.blocked entry records an active block", () => {
		const run = restore([
			start,
			stageStart,
			{
				id: "e3",
				type: "workflow.run.blocked",
				payload: {
					runId: "r1",
					failedStageId: "s1",
					error: "the provider is overloaded",
					failureKind: "provider",
					failureRecoverability: "recoverable",
					resumable: true,
					ts: 3,
				},
			},
		]);
		assert.equal(run.failureDisposition, "active_blocked");
		assert.equal(effectiveRunStatus(run), "blocked");
	});
});
