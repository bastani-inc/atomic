import assert from "node:assert/strict";
import type { WorkflowRootActivity } from "@bastani/atomic";
import { describe, test } from "vitest";
import { parseInteractiveEngineMessage } from "../../packages/coding-agent/src/modes/interactive-engine/protocol.js";
import {
	buildWorkflowStatusListing,
	runMatchesStatusFilter,
	summarizeRunSnapshot,
} from "../../packages/workflows/src/extension/workflow-status-summary.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	projectWorkflowActivity,
	type WorkflowActivityOwnership,
	workflowActivityNodeKey,
} from "../../packages/workflows/src/shared/workflow-activity.js";

const WAIT = { kind: "tool", since: 0, toolCalls: [{ toolCallId: "call-1", toolName: "wait_for_ci" }] } as const;

function stage(id: string, status: StageSnapshot["status"]): StageSnapshot {
	return {
		id,
		name: id,
		status,
		parentIds: [],
		toolEvents: [],
		...(status === "suspended" ? { wait: WAIT } : {}),
	};
}

function run(id: string, stages: StageSnapshot[], patch: Partial<RunSnapshot> = {}): RunSnapshot {
	return { id, name: id, inputs: {}, status: "running", startedAt: 0, toolNodes: [], stages, ...patch };
}

function ownership(patch: Partial<WorkflowActivityOwnership> = {}): WorkflowActivityOwnership {
	return {
		ownerSessionId: "session",
		liveRunIds: new Set(["root"]),
		executingStageIds: new Set<string>(),
		executingToolNodeIds: new Set<string>(),
		stoppingRunIds: new Set<string>(),
		retryingStageIds: new Set<string>(),
		acknowledgedFailureRunIds: new Set<string>(),
		...patch,
	};
}

/** The root's state, reason and counts, without its graph. */
function rootActivity(
	runs: RunSnapshot[],
	patch: Partial<WorkflowActivityOwnership> = {},
): Omit<WorkflowRootActivity, "graph"> {
	const [root] = projectWorkflowActivity({ snapshot: { runs, notices: [], version: 0 }, ownership: ownership(patch) });
	assert.ok(root !== undefined);
	const { graph: _graph, ...rest } = root;
	return rest;
}

describe("runs with suspended stages in the status listing (#4309, #4589)", () => {
	test("a run summary counts its suspended stages", () => {
		assert.equal(
			summarizeRunSnapshot(run("r", [stage("a", "suspended"), stage("b", "suspended"), stage("c", "running")]))
				.suspendedCount,
			2,
		);
		assert.equal(summarizeRunSnapshot(run("r", [stage("a", "running")])).suspendedCount, 0);
	});

	test("statusFilter suspended lists the runs with a suspended stage, as awaiting_input lists runs with a prompt", () => {
		const waiting = run("suspended", [stage("a", "suspended"), stage("b", "completed")], { startedAt: 2 });
		const prompting = run("prompting", [stage("a", "awaiting_input")], { startedAt: 1 });
		const busy = run("busy", [stage("a", "running")], { startedAt: 3 });
		const snapshots = [waiting, prompting, busy];

		assert.deepEqual(
			buildWorkflowStatusListing(snapshots, "suspended", 10).runs.map((summary) => summary.runId),
			["suspended"],
		);
		assert.deepEqual(
			buildWorkflowStatusListing(snapshots, "awaiting_input", 10).runs.map((summary) => summary.runId),
			["prompting"],
		);
		assert.equal(runMatchesStatusFilter(summarizeRunSnapshot(waiting, 10), "running"), true);
		assert.equal(runMatchesStatusFilter(summarizeRunSnapshot(busy, 10), "suspended"), false);
	});
});

describe("root activity of a run whose stages wait (#4309)", () => {
	test("a live run whose stages all wait is working, waiting, not idle", () => {
		assert.deepEqual(rootActivity([run("root", [stage("a", "suspended"), stage("b", "suspended")])]), {
			rootRunId: "root",
			ownerSessionId: "session",
			state: "working",
			reason: "waiting",
			activeExecutionCount: 0,
			actionableBlockCount: 0,
			needsAttention: false,
		});
	});

	test("an executing stage keeps the root executing, and a prompt beside a waiting stage still needs attention", () => {
		const executing = rootActivity([run("root", [stage("a", "suspended"), stage("b", "running")])], {
			executingStageIds: new Set([workflowActivityNodeKey("root", "b")]),
		});
		assert.equal(executing.reason, "executing");
		assert.equal(executing.activeExecutionCount, 1);

		const prompting = rootActivity([run("root", [stage("a", "suspended"), stage("b", "awaiting_input")])]);
		assert.equal(prompting.state, "working");
		assert.equal(prompting.reason, "waiting");
		assert.equal(prompting.actionableBlockCount, 1);
		assert.equal(prompting.needsAttention, true);
	});

	test("a running stage that executes nothing does not make the root wait as a suspended one does (#4589)", () => {
		const activity = rootActivity([run("root", [stage("a", "running")])]);

		assert.notEqual(activity.reason, "waiting");
		assert.equal(rootActivity([run("root", [stage("a", "suspended")])]).reason, "waiting");
	});

	test("a waiting stage of a run that is not live here, stopping, or not running does not make the root work", () => {
		const waiting = [stage("a", "suspended")];
		assert.equal(rootActivity([run("root", waiting)], { liveRunIds: new Set() }).state, "idle");
		assert.equal(rootActivity([run("root", waiting)], { stoppingRunIds: new Set(["root"]) }).reason, "quiescent");
		assert.equal(rootActivity([run("root", waiting, { status: "paused" })]).reason, "paused");
	});

	test("the interactive engine protocol carries a root that is working because its stages wait", () => {
		const root = rootActivity([run("root", [stage("a", "suspended")])]);
		const message = parseInteractiveEngineMessage(
			JSON.stringify({
				type: "engine_workflow_activity",
				frame: { kind: "changed", cursor: { epoch: "e", revision: 1 }, root },
			}),
		);
		assert.deepEqual(message, {
			type: "engine_workflow_activity",
			frame: { kind: "changed", cursor: { epoch: "e", revision: 1 }, root },
		});
	});
});
