import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { isWorkflowRunResumable } from "../../packages/workflows/src/durable/resume-eligibility.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { workflowPolicyFromContext } from "../../packages/workflows/src/extension/workflow-policy.js";
import { handleRunControlCommand } from "../../packages/workflows/src/extension/workflow-run-control-command.js";
import { workflowResumeAction } from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { workflowRunResumeCandidate } from "../../packages/workflows/src/shared/workflow-artifacts.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const sourceId = testRunId("ended-blocked-reviewer");

afterEach(() => {
	store.clear();
	setDurableBackend(undefined);
});

async function setupReviewerResume(overrides: Partial<RunSnapshot> = {}) {
	const backend = await createMemoryTestBackend();
	setDurableBackend(backend);
	const definition = workflow({
		name: "ended-blocked-reviewer",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const prepared = await ctx.stage("prepare").prompt("prepare");
			await ctx.stage("evidence-reviewer").prompt(`review:${prepared}`);
			await ctx.stage("finish").prompt("finish");
			return {};
		},
	});
	store.recordRunStart({
		id: sourceId,
		name: definition.name,
		inputs: {},
		status: "blocked",
		startedAt: 1,
		endedAt: 2,
		blockedAt: 2,
		resumable: true,
		failureRecoverability: "recoverable",
		failureDisposition: "active_blocked",
		failureMessage: "CleanupFailed",
		failedStageId: "reviewer-source",
		toolNodes: [],
		stages: [
			{
				id: "prepare-source",
				name: "prepare",
				replayKey: "stage:prepare:1",
				status: "completed",
				parentIds: [],
				toolEvents: [],
				result: "retained preparation",
			},
			{
				id: "reviewer-source",
				name: "evidence-reviewer",
				replayKey: "stage:evidence-reviewer:1",
				status: "failed",
				parentIds: ["prepare-source"],
				toolEvents: [],
				error: "CleanupFailed",
				failureRecoverability: "recoverable",
				failureDisposition: "active_blocked",
			},
		],
		...overrides,
	});
	await backend.commitWorkflowRegistration({
		workflowId: sourceId,
		name: definition.name,
		inputs: {},
		createdAt: 1,
		status: "blocked",
		resumable: true,
	});
	const calls: string[] = [];
	const jobs = createJobTracker();
	const runtime = createExtensionRuntime({
		store,
		registry: createRegistry([definition]),
		jobs,
		adapters: {
			prompt: {
				prompt: async (text) => {
					calls.push(text);
					return "done";
				},
			},
		},
	});
	return { backend, calls, jobs, runtime };
}

// #3106: checkpoint continuation retains the execution identity.
test("tool resumes an ended recoverable blocked root at its failed reviewer without repeating completed work", async () => {
	const { backend, calls, jobs, runtime } = await setupReviewerResume();
	const result = await workflowResumeAction(
		{ action: "resume", runId: sourceId },
		{ getRuntime: () => runtime, policy: workflowPolicyFromContext(), ensureWorkflowResourcesLoaded() {} },
	);
	assert.ok(result.action === "resume");
	assert.equal(result.status, "running", JSON.stringify(result));
	assert.equal(result.runId, sourceId);
	await jobs.get(result.runId)?.promise;
	assert.deepEqual(calls, ["review:retained preparation", "finish"], JSON.stringify(store.runs()));
	const continuation = store.runs().find((run) => run.id === result.runId);
	assert.equal(continuation?.status, "completed");
	assert.equal(continuation?.resumedFromRunId, sourceId);
	assert.equal(continuation?.stages.find((stage) => stage.name === "prepare")?.replayed, true);
	assert.equal(backend.getWorkflow(sourceId)?.status, "completed");
});

test.each(["blocked", "failed", "killed"] as const)(
	"tool reports not_resumable %s snapshots as no-op, not success",
	async (status) => {
		const { calls, jobs, runtime } = await setupReviewerResume({ status, resumable: false });
		const result = await workflowResumeAction(
			{ action: "resume", runId: sourceId },
			{ getRuntime: () => runtime, policy: workflowPolicyFromContext(), ensureWorkflowResourcesLoaded() {} },
		);
		assert.ok(result.action === "resume");
		assert.equal(result.status, "noop", JSON.stringify(result));
		assert.match(result.message ?? "", /not resumable/);
		assert.equal(result.runId, sourceId);
		assert.deepEqual(calls, []);
		assert.deepEqual(jobs.runIds(), []);
		assert.equal(store.runs().length, 1);
	},
);

async function resumeCommand(runtime: ReturnType<typeof createExtensionRuntime>) {
	const messages: string[] = [];
	const errors: string[] = [];
	await handleRunControlCommand(
		"resume",
		[sourceId],
		{ hasUI: false, ui: { notify() {} } },
		{ info: (message) => messages.push(message), error: (message) => errors.push(message) },
		{
			pi: {},
			overlay: { open() {}, close() {}, toggle() {} },
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded() {},
		},
	);
	return { messages, errors };
}

test("CLI reports not_resumable from live stage control as an error, not a successful resume", async () => {
	const { calls, runtime } = await setupReviewerResume({
		resumable: false,
		stages: [{ id: "stale-paused", name: "stale-paused", status: "paused", parentIds: [], toolEvents: [] }],
	});
	const result = await resumeCommand(runtime);
	assert.match(result.errors.join("\n"), /not resumable/);
	assert.deepEqual(result.messages, []);
	assert.deepEqual(calls, []);
	assert.equal(store.runs().length, 1);
});

test("tool reports a blocked snapshot without a recoverable continuation as no-op", async () => {
	const { calls, runtime } = await setupReviewerResume({
		resumable: undefined,
		failureRecoverability: undefined,
	});
	const result = await workflowResumeAction(
		{ action: "resume", runId: sourceId },
		{ getRuntime: () => runtime, policy: workflowPolicyFromContext(), ensureWorkflowResourcesLoaded() {} },
	);
	assert.ok(result.action === "resume");
	assert.equal(result.status, "noop", JSON.stringify(result));
	assert.equal(result.runId, sourceId);
	assert.deepEqual(calls, []);
	assert.equal(store.runs()[0]?.status, "blocked");
});

test("CLI continues the exact ended blocked root through the real runtime", async () => {
	const { runtime, calls, jobs } = await setupReviewerResume();
	const result = await resumeCommand(runtime);
	assert.deepEqual(result.errors, []);
	assert.match(result.messages.join("\n"), /Resuming durable/);
	assert.match(result.messages.join("\n"), new RegExp(sourceId));
	const [continuationId] = jobs.runIds();
	assert.ok(continuationId);
	await jobs.get(continuationId)?.promise;
	assert.deepEqual(calls, ["review:retained preparation", "finish"]);
	assert.equal(store.runs().find((run) => run.id === continuationId)?.resumedFromRunId, sourceId);
	assert.equal(store.runs().find((run) => run.id === continuationId)?.status, "completed");
});

test("runtime admits one ended blocked continuation and refuses a duplicate", async () => {
	const { runtime, jobs, calls } = await setupReviewerResume();
	assert.equal(isWorkflowRunResumable(workflowRunResumeCandidate(store.runs()[0]!)), true);
	const results = await Promise.all([runtime.resumeFailedRun(sourceId), runtime.resumeFailedRun(sourceId)]);
	const accepted = results.filter((result) => result.ok);
	assert.equal(accepted.length, 1);
	assert.equal(results.filter((result) => !result.ok && result.reason === "not_resumable").length, 1);
	await jobs.get(accepted[0]!.runId)?.promise;
	assert.deepEqual(calls, ["review:retained preparation", "finish"], JSON.stringify(store.runs()));
	assert.equal(store.runs().find((run) => run.id === sourceId)?.status, "completed");
	assert.equal(
		isWorkflowRunResumable(workflowRunResumeCandidate(store.runs().find((run) => run.id === sourceId)!)),
		false,
	);
	assert.equal((await runtime.resumeFailedRun(sourceId)).ok, false);
});

test("runtime does not turn a quit blocked root into a fresh continuation", async () => {
	const { runtime, calls, jobs } = await setupReviewerResume({ exitReason: "quit" });
	const result = await runtime.resumeFailedRun(sourceId);
	assert.equal(result.ok, false, JSON.stringify(result));
	if (result.ok) return;
	assert.equal(result.reason, "not_resumable");
	assert.deepEqual(calls, []);
	assert.deepEqual(jobs.runIds(), []);
});

test("ended blocked eligibility still requires durable state, artifacts, and recoverability; killed always wins", async () => {
	await setupReviewerResume();
	const candidate = workflowRunResumeCandidate(store.runs()[0]!);
	assert.equal(isWorkflowRunResumable(candidate), true);
	assert.equal(isWorkflowRunResumable({ ...candidate, hasDurableCheckpoint: false }), false);
	assert.equal(isWorkflowRunResumable({ ...candidate, artifactsIntact: false }), false);
	assert.equal(isWorkflowRunResumable({ ...candidate, failureRecoverability: "non_recoverable" }), false);
	assert.equal(isWorkflowRunResumable({ ...candidate, resumable: false }), false);
	assert.equal(isWorkflowRunResumable({ ...candidate, status: "running", budgetSystemOwnedStop: false }), false);
	assert.equal(isWorkflowRunResumable({ ...candidate, status: "running", budgetSystemOwnedStop: true }), true);
	assert.equal(
		isWorkflowRunResumable({ ...candidate, status: "killed", exitReason: "quit", budgetSystemOwnedStop: true }),
		false,
	);
});
