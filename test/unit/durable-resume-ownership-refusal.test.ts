import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { durableHash } from "../../packages/workflows/src/durable/backend.js";
import { DbosDurableBackend, type DbosWorkflowClaim } from "../../packages/workflows/src/durable/dbos-backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { FOREIGN_LIVE_WORKFLOW_WINDOW_MS } from "../../packages/workflows/src/durable/resume-eligibility.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { inspectTargetedDurableWorkflow } from "../../packages/workflows/src/durable/targeted-inspection.js";
import { createStore, store } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";
import { mockSession } from "./executor-shared.js";

const WORKFLOW_NAME = "ownership-refusal";

beforeEach(() => store.clear());
afterEach(() => {
	store.clear();
	setDurableBackend(undefined);
	vi.restoreAllMocks();
});

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

async function crashedRunRecoveredBy(
	claim: (callback: () => Promise<boolean>) => Promise<DbosWorkflowClaim>,
	ownerLiveness: "alive" | "dead" | "unknown",
) {
	let clock = 10_000;
	vi.spyOn(Date, "now").mockImplementation(() => clock);
	const workflowId = testRunId("ownership-refusal");
	const sdk = createMockSdk();
	const crashedOwner = new DbosDurableBackend(sdk, { executorId: "crashed-owner" });
	crashedOwner.registerWorkflow({ workflowId, name: WORKFLOW_NAME, inputs: {}, createdAt: clock, status: "running" });
	const argsHash = durableHash({ name: "once", args: {}, ordinal: 1 });
	crashedOwner.recordCheckpoint({
		kind: "tool",
		workflowId,
		checkpointId: `tool:${argsHash}`,
		name: "once",
		argsHash,
		output: "first-process-effect",
		completedAt: clock,
		topology: {
			version: 1,
			nodeId: "tool:once",
			ordinal: 1,
			order: 1,
			parentIds: [],
			startedAt: clock - 10,
			endedAt: clock,
			run: { runId: workflowId, runName: WORKFLOW_NAME },
		},
	});
	await crashedOwner.flush();
	clock += FOREIGN_LIVE_WORKFLOW_WINDOW_MS + 1;

	const fencedSdk = {
		...sdk,
		withWorkflowClaim: (_id: string, callback: () => Promise<boolean>) => claim(callback),
		ownerLiveness: async () => ownerLiveness,
	};
	const recoverer = new DbosDurableBackend(fencedSdk, { executorId: "recoverer" });
	await recoverer.hydrateWorkflow(workflowId);
	const runStore = createStore();
	const resume = () =>
		resumeDurableWorkflow(
			workflowId,
			{
				registry: createRegistry([definition]),
				baseRunOpts: { store: runStore, adapters: { agentSession: { create: async () => mockSession() } } },
				durableBackend: recoverer,
			},
			recoverer.listResumableWorkflows(),
		);
	return { workflowId, sdk, recoverer, runStore, resume };
}

describe("resume ownership claim refusals", () => {
	test("an unfenced owner is named with its recovery path instead of a stale-list message (#3424)", async () => {
		const run = await crashedRunRecoveredBy(
			async () => ({ kind: "refused", reason: "unfenced_owner", ownerExecutorId: "crashed-owner" }),
			"unknown",
		);
		const stepsBefore = [...run.sdk.state.steps.entries()];

		const inspected = await inspectTargetedDurableWorkflow(run.recoverer, run.workflowId);
		assert.equal(inspected.kind, "found");
		if (inspected.kind === "found") {
			assert.equal(inspected.detail.status, "crashed");
			assert.match(inspected.detail.resumeGuidance ?? "", /unfenced executor identity/);
			assert.match(inspected.detail.resumeGuidance ?? "", /legacyRecovery/);
		}

		const refused = await run.resume();
		assert.equal(refused.ok, false);
		if (refused.ok) return;
		assert.equal(refused.reason, "owned_elsewhere");
		assert.match(refused.message, /crashed-owner/);
		assert.match(refused.message, /unfenced executor identity/);
		assert.match(refused.message, /legacyRecovery: \{ olderWorkersStopped: true \}/);
		assert.doesNotMatch(refused.message, /changed while resume was pending/);
		assert.deepEqual([...run.sdk.state.steps.entries()], stepsBefore, "a refused claim must not write");
		assert.deepEqual(run.sdk.state.resumes, []);
		assert.equal(run.runStore.runs().length, 0, "a refused claim must not launch an executor");
	});

	test("missing owner metadata names backup recovery rather than an unavailable SDK option (#3424)", async () => {
		const run = await crashedRunRecoveredBy(
			async () => ({ kind: "refused", reason: "unfenced_owner", ownerExecutorId: undefined }),
			"unknown",
		);
		const refused = await run.resume();
		assert.equal(refused.ok, false);
		assert.match(refused.message, /missing ownerExecutorId/);
		assert.match(refused.message, /known-good workflow database backup/);
		assert.match(refused.message, /SDK controlled recovery is unavailable/);
		assert.doesNotMatch(refused.message, /session\.workflows\.resume/);
		assert.equal(run.runStore.runs().length, 0);
		assert.deepEqual(run.sdk.state.resumes, []);
	});

	test("a fenced owner that still holds its connection is named instead of a stale-list message (#3424)", async () => {
		const run = await crashedRunRecoveredBy(
			async () => ({ kind: "refused", reason: "owner_active", ownerExecutorId: "atomic-db-owner" }),
			"dead",
		);

		const refused = await run.resume();
		assert.equal(refused.ok, false);
		if (refused.ok) return;
		assert.equal(refused.reason, "owned_elsewhere");
		assert.match(refused.message, /atomic-db-owner/);
		assert.match(refused.message, /still holds its workflow database ownership connection/);
		assert.deepEqual(run.sdk.state.resumes, []);
	});

	test("a claim lost to a concurrent change still reports that the workflow changed (#3424)", async () => {
		const run = await crashedRunRecoveredBy(async () => ({ kind: "attempted", claimed: false }), "dead");

		const refused = await run.resume();
		assert.equal(refused.ok, false);
		if (refused.ok) return;
		assert.equal(refused.reason, "stale");
		assert.match(refused.message, /changed while resume was pending/);
		assert.equal(run.recoverer.transitionRefusal(run.workflowId), undefined);
		assert.equal(run.runStore.runs().length, 0);
	});

	test("a later successful claim clears the earlier refusal (#3424)", async () => {
		let refuse = true;
		const run = await crashedRunRecoveredBy(
			async (callback) =>
				refuse
					? { kind: "refused", reason: "owner_active", ownerExecutorId: "atomic-db-owner" }
					: { kind: "attempted", claimed: await callback() },
			"dead",
		);
		assert.equal((await run.resume()).ok, false);
		assert.equal(run.recoverer.transitionRefusal(run.workflowId)?.reason, "owner_active");

		refuse = false;
		const resumed = await run.resume();
		assert.equal(resumed.ok, true);
		assert.equal(run.recoverer.transitionRefusal(run.workflowId), undefined);
	});
});
