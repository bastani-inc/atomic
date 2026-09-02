/**
 * Workflow tool `status` run-listing tests.
 *
 * Covers the refined no-runId `status` action: concise per-run summaries
 * (status, timing, active stages, awaiting-input prompts), statusFilter
 * support for the run listing, and the agent-visible text/json output.
 */
import { beforeEach, describe, test } from "vitest";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import type { WorkflowRunStatusSummary } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import {
	pendingWorkflowStageStatus,
	workflowBoundarySegments,
} from "../../packages/workflows/src/shared/pending-stage-status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { statusIcon } from "../../packages/workflows/src/tui/status-helpers.js";
import {
	assert,
	createExtensionRuntime,
	createRegistry,
	installSlashDispatchTestHooks,
	makeExecuteWorkflowTool,
	makeInflightRun,
	recordTerminalRun,
	registerWorkflowCommand,
	renderResult,
	store,
} from "./slash-dispatch-utils.js";

installSlashDispatchTestHooks();

// Other test files in the same bun process may leave retained terminal runs
// in the module-singleton store; start each listing test from a clean slate.
beforeEach(() => {
	store.clear();
});

type StatusListing = {
	action: "status";
	filter: string;
	runs: WorkflowRunStatusSummary[];
	snapshots: Array<{ id: string }>;
};

function makeToolHandler() {
	const registry = createRegistry([]);
	const runtime = createExtensionRuntime({ registry });
	return makeExecuteWorkflowTool(runtime, () => undefined);
}

function recordRunningRunWithStages(runId: string): void {
	store.recordRunStart({
		...makeInflightRun(runId),
		name: "release-docs",
		startedAt: Date.now() - 5_000,
	});
	store.recordStageStart(runId, {
		id: `${runId}-stage-verify`,
		name: "verify",
		status: "running",
		parentIds: [],
		toolEvents: [],
		startedAt: Date.now() - 4_000,
	});
	store.recordStageStart(runId, {
		id: `${runId}-stage-approve`,
		name: "approve",
		status: "awaiting_input",
		parentIds: [],
		toolEvents: [],
		awaitingInputSince: Date.now() - 1_000,
		pendingPrompt: {
			id: "prompt-1",
			kind: "confirm",
			message: "Approve the release plan?",
			createdAt: Date.now() - 1_000,
		},
	});
}

describe("workflow tool status run listing", () => {
	test.sequential("status without runId lists session runs with concise summaries, in-flight first", async () => {
		const activeId = `status-listing-active-${Date.now()}`;
		recordRunningRunWithStages(activeId);
		recordTerminalRun(`status-listing-done-${Date.now()}`, "completed", {
			startedAt: Date.now() - 60_000,
		});
		const handler = makeToolHandler();

		const result = (await handler({ action: "status" }, {} as never)) as StatusListing;

		assert.equal(result.action, "status");
		assert.equal(result.filter, "all");
		assert.equal(result.runs.length, 2);
		// In-flight run sorts before the ended run despite starting later.
		const active = result.runs[0]!;
		assert.equal(active.runId, activeId);
		assert.equal("runIdPrefix" in active, false);
		assert.equal(active.name, "release-docs");
		assert.equal(active.status, "running");
		assert.equal(active.endedAt, undefined);
		assert.ok(active.elapsedMs >= 0);
		assert.deepEqual(active.activeStages.map((stage) => stage.name).sort(), ["approve", "verify"]);
		assert.equal(active.awaitingInputCount, 1);
		assert.equal(active.awaitingInput.length, 1);
		const awaiting = active.awaitingInput[0]!;
		assert.equal(awaiting.stageId, `${activeId}-stage-approve`);
		assert.equal(awaiting.stageName, "approve");
		assert.equal(awaiting.promptId, "prompt-1");
		assert.equal(awaiting.promptKind, "confirm");
		assert.equal(awaiting.message, "Approve the release plan?");

		const terminal = result.runs[1]!;
		assert.equal(terminal.status, "completed");
		assert.notEqual(terminal.endedAt, undefined);
		assert.equal(terminal.awaitingInputCount, 0);

		// Snapshots stay aligned with the summaries (same runs, same order).
		assert.deepEqual(
			result.snapshots.map((snapshot) => snapshot.id),
			result.runs.map((run) => run.runId),
		);
	});

	test.sequential("statusFilter filters the run listing by run status", async () => {
		const activeId = `status-filter-active-${Date.now()}`;
		const doneId = `status-filter-done-${Date.now()}`;
		recordRunningRunWithStages(activeId);
		recordTerminalRun(doneId, "completed", { startedAt: Date.now() - 60_000 });
		const handler = makeToolHandler();

		const running = (await handler({ action: "status", statusFilter: "running" }, {} as never)) as StatusListing;
		assert.equal(running.filter, "running");
		assert.deepEqual(
			running.runs.map((run) => run.runId),
			[activeId],
		);
		assert.deepEqual(
			running.snapshots.map((snapshot) => snapshot.id),
			[activeId],
		);

		const completed = (await handler({ action: "status", statusFilter: "completed" }, {} as never)) as StatusListing;
		assert.equal(completed.filter, "completed");
		assert.deepEqual(
			completed.runs.map((run) => run.runId),
			[doneId],
		);

		const failed = (await handler({ action: "status", statusFilter: "failed" }, {} as never)) as StatusListing;
		assert.deepEqual(failed.runs, []);
		assert.deepEqual(failed.snapshots, []);
	});

	test.sequential("statusFilter awaiting_input selects runs with a pending stage prompt", async () => {
		const awaitingId = `status-filter-awaiting-${Date.now()}`;
		const plainId = `status-filter-plain-${Date.now()}`;
		recordRunningRunWithStages(awaitingId);
		store.recordRunStart(makeInflightRun(plainId));
		const handler = makeToolHandler();

		const result = (await handler(
			{ action: "status", statusFilter: "awaiting_input" },
			{} as never,
		)) as StatusListing;

		assert.equal(result.filter, "awaiting_input");
		assert.deepEqual(
			result.runs.map((run) => run.runId),
			[awaitingId],
		);
		assert.equal(result.runs[0]!.awaitingInputCount, 1);
	});

	test.sequential("status rendering attributes a run-level prompt in a hidden child without exposing it in JSON", async () => {
		const rootId = `status-nested-root-${Date.now()}`;
		const childId = `status-nested-child-${Date.now()}`;
		store.recordRunStart(makeInflightRun(rootId));
		store.recordRunStart({
			...makeInflightRun(childId),
			parentRunId: rootId,
			rootRunId: rootId,
			pendingPrompt: {
				id: "nested-prompt",
				kind: "confirm",
				message: "Continue nested workflow?",
				createdAt: Date.now(),
			},
		});
		const result = await makeToolHandler()({ action: "status" }, {} as never);
		const text = renderWorkflowToolContent(result, { action: "status" });
		const summaryLine = text.split("\n").find((line) => line.startsWith("[1]"));
		assert.notEqual(summaryLine, undefined);
		assert.match(summaryLine!, new RegExp(`${statusIcon("awaiting_input")}.*${rootId}`));

		const json = renderWorkflowToolContent(result, { action: "status", format: "json" });
		assert.doesNotMatch(json, new RegExp(childId));
	});

	test.sequential("status text output is a concise per-run listing; json format returns structured data", async () => {
		const activeId = `status-content-active-${Date.now()}`;
		recordRunningRunWithStages(activeId);
		const handler = makeToolHandler();
		const result = await handler({ action: "status" }, {} as never);

		const text = renderWorkflowToolContent(result, { action: "status" });
		assert.match(text, /action: status/);
		assert.match(text, /filter: all/);
		assert.match(text, /runs: 1 \(1 in flight\)/);
		// Concise summary line includes the full run id so it remains actionable without truncation.
		const summaryLine = text.split("\n").find((line) => line.startsWith("[1]"));
		assert.notEqual(summaryLine, undefined);
		assert.ok(summaryLine!.includes(activeId));
		assert.match(summaryLine!, /release-docs/);
		assert.match(summaryLine!, /running/);
		assert.match(summaryLine!, /awaiting input \(1\): approve/);
		assert.match(summaryLine!, new RegExp(statusIcon("awaiting_input")));

		// The rendered result keeps the point-in-time snapshot even when the live store resolves the prompt later.
		const liveStage = store.runs().find((run) => run.id === activeId)?.stages[1];
		assert.notEqual(liveStage, undefined);
		liveStage!.status = "running";
		liveStage!.pendingPrompt = undefined;
		assert.equal(renderWorkflowToolContent(result, { action: "status" }), text);
		// Full identifiers remain actionable through the supported prompt and control paths.
		assert.match(text, new RegExp(`runId: ${activeId}`));
		assert.match(text, new RegExp(`${activeId}-stage-approve`));
		assert.match(text, /promptId: prompt-1/);
		assert.match(text, /workflow answer answers pending prompts/);
		assert.match(text, /workflow resume controls paused runs/);
		assert.ok(
			text.includes(
				"Ordinary Intercom handles free-form workflow-stage communication at workflow:<rootRunId>/<segment>[/<segment>...]",
			),
		);
		assert.match(text, /live stage delivery is immediate/);
		assert.match(text, /known pending stage `send` queues before its first model turn/);
		assert.match(text, /`ask` requires a live reply-capable stage/);
		assert.doesNotMatch(text, /workflow send/i);
		assert.doesNotMatch(text, /send also takes stageId\/promptId/);

		const json = renderWorkflowToolContent(result, {
			action: "status",
			format: "json",
		});
		const parsed = JSON.parse(json) as StatusListing;
		assert.equal(parsed.action, "status");
		assert.equal(parsed.filter, "all");
		assert.equal(parsed.runs.length, 1);
		assert.equal(parsed.runs[0]!.runId, activeId);
		assert.equal(parsed.runs[0]!.awaitingInput[0]!.promptId, "prompt-1");
		assert.equal(parsed.snapshots.length, 1);
	});

	test.sequential("status hint states each Intercom coaching rule exactly once", async () => {
		const runId = `status-hint-${Date.now()}`;
		store.recordRunStart({ ...makeInflightRun(runId), name: "hint-status" });
		const result = await makeToolHandler()({ action: "status" }, {} as never);
		const text = renderWorkflowToolContent(result, { action: "status" });
		for (const rule of [
			"live stage delivery is immediate",
			"a known pending stage `send` queues before its first model turn",
			"`ask` requires a live reply-capable stage",
		]) {
			assert.equal(text.split(rule).length - 1, 1, `expected one occurrence of ${rule}`);
		}
	});

	test.sequential("/workflow status preserves deliverable pending-stage targets through the graph projection", async () => {
		const runId = "aaaaaaaa-1111-4111-8111-111111111111";
		store.recordRunStart({
			...makeInflightRun(runId),
			name: "projected-pending-status",
			stages: [
				{
					id: "review-a",
					name: "review",
					status: "pending",
					parentIds: [],
					toolEvents: [],
					pendingStageDeliveryAvailable: true,
				},
			],
		});
		const { sent, workflowCmd } = await registerWorkflowCommand();

		await workflowCmd.options.handler("status", { hasUI: false, ui: { notify: () => undefined } });

		const message = sent.find((entry) => (entry.details as { kind?: string } | undefined)?.kind === "status");
		assert.ok(message, "expected the real slash handler to emit a status surface");
		assert.equal(store.graphSnapshot().runs[0]?.stages[0]?.pendingStageDeliveryAvailable, true);
		assert.match(message.content ?? "", new RegExp(`workflow:${runId}/review-a`));
		assert.doesNotMatch(message.content ?? "", /review \(review-a\) · delivery unavailable/);
	});
	test.sequential("status text enumerates pending stages with canonical Intercom targets and truthful delivery capability", async () => {
		const runId = `status-pending-${Date.now()}`;
		store.recordRunStart({ ...makeInflightRun(runId), name: "pending-status" });
		for (const [id, available] of [
			["review-a", true],
			["review-b", true],
			["offline", false],
		] as const) {
			store.recordStageStart(runId, {
				id,
				name: id.startsWith("review") ? "review" : "offline",
				status: "pending",
				parentIds: [],
				toolEvents: [],
				pendingStageDeliveryAvailable: available,
			});
		}
		store.recordStageStart(runId, {
			id: "legacy",
			name: "legacy",
			status: "pending",
			parentIds: [],
			toolEvents: [],
		});
		for (let index = 0; index < 8; index++) {
			store.recordStageStart(runId, {
				id: `extra-${index}`,
				name: `extra-${index}`,
				status: "pending",
				parentIds: [],
				toolEvents: [],
				pendingStageDeliveryAvailable: true,
			});
		}

		const result = await makeToolHandler()({ action: "status" }, {} as never);
		const text = renderWorkflowToolContent(result, { action: "status" });
		assert.match(
			text,
			new RegExp(
				`pending stage: review \\(review-a\\) lifecycle=pending pendingStageDeliveryAvailable=true Intercom target=workflow:${runId}/review-a`,
			),
		);
		assert.match(
			text,
			new RegExp(
				`pending stage: review \\(review-b\\) lifecycle=pending pendingStageDeliveryAvailable=true Intercom target=workflow:${runId}/review-b`,
			),
		);
		assert.match(
			text,
			/pending stage: offline \(offline\) lifecycle=pending pendingStageDeliveryAvailable=false Intercom target=unavailable/,
		);
		assert.match(
			text,
			/pending stage: legacy \(legacy\) lifecycle=pending pendingStageDeliveryAvailable=false Intercom target=unavailable/,
		);
		assert.doesNotMatch(text, new RegExp(`workflow:${runId}/(offline|legacy)`));
		assert.match(text, /… 2 more pending stages; use status with runId/);
		assert.doesNotMatch(text, new RegExp(`workflow:${runId}/extra-(6|7)`));
		assert.match(text, /pending stage `send` queues before its first model turn/);
		assert.match(text, /`ask` requires a live reply-capable stage/);
	});

	test.sequential("status text singularizes exactly one pending stage omitted by its bound", async () => {
		const runId = `status-pending-overflow-${Date.now()}`;
		store.recordRunStart({
			...makeInflightRun(runId),
			name: "pending-overflow-status",
			stages: Array.from({ length: 11 }, (_, index) => ({
				id: `review-${index}`,
				name: `review-${index}`,
				status: "pending" as const,
				parentIds: [],
				toolEvents: [],
				pendingStageDeliveryAvailable: true,
			})),
		});

		const result = await makeToolHandler()({ action: "status" }, {} as never);
		const text = renderWorkflowToolContent(result, { action: "status" });
		assert.match(text, /… 1 more pending stage; use status with runId/);
		assert.doesNotMatch(text, /… 1 more pending stages/);
	});

	test.sequential("terminated runs never advertise pending-stage targets on tool, list, or detail surfaces", async () => {
		const runId = "ffffffff-1111-4111-8111-111111111111";
		const target = `workflow:${runId}/review-a`;
		store.recordRunStart({
			...makeInflightRun(runId),
			name: "failed-pending-status",
			stages: [
				{
					id: "review-a",
					name: "review",
					status: "pending",
					parentIds: [],
					toolEvents: [],
					pendingStageDeliveryAvailable: true,
				},
			],
		});
		store.recordRunEnd(runId, "failed", undefined, "boom");
		const handler = makeToolHandler();

		const result = await handler({ action: "status" }, {} as never);
		const toolText = renderWorkflowToolContent(result, { action: "status" });
		const listText = renderResult(result, { plain: true, width: 160 });
		const detailResult = await handler({ action: "status", runId }, {} as never);
		const detailText = renderResult(detailResult, { plain: true, width: 160 });

		for (const rendered of [toolText, listText, detailText]) {
			assert.doesNotMatch(rendered, new RegExp(target));
		}
		assert.match(
			toolText,
			/pending stage: review \(review-a\) lifecycle=pending pendingStageDeliveryAvailable=false Intercom target=unavailable/,
		);
		assert.match(listText, /pending: review \(review-a\) · delivery unavailable/);
		assert.match(detailText, /pending id {6}review-a · delivery unavailable/);
	});
	test.sequential("nested pending stages render the exact canonical target published by the Intercom roster", async () => {
		const rootRunId = "11111111-1111-4111-8111-111111111111";
		const childRunId = "22222222-2222-4222-8222-222222222222";
		const rootStageId = "root-review";
		const childStageId = "child-review";
		store.recordRunStart({
			...makeInflightRun(rootRunId),
			name: "root workflow",
			stages: [
				{
					id: rootStageId,
					name: "review",
					status: "pending",
					parentIds: [],
					toolEvents: [],
					pendingStageDeliveryAvailable: true,
				},
				{
					id: "child-boundary",
					name: "workflow:child",
					status: "running",
					parentIds: [],
					toolEvents: [],
					replayKey: "workflow:child:1",
					workflowChildRun: { alias: "child", workflow: "child workflow", runId: childRunId },
				},
			],
		});
		store.recordRunStart({
			...makeInflightRun(childRunId),
			name: "child workflow",
			parentRunId: rootRunId,
			parentStageId: "child-boundary",
			rootRunId,
			stages: [
				{
					id: childStageId,
					name: "review",
					status: "pending",
					parentIds: [],
					toolEvents: [],
					pendingStageDeliveryAvailable: true,
				},
			],
		});

		const routes: Array<{
			runId: string;
			stages: Array<{ stageId: string; target: string }>;
		}> = [];
		const dispose = registerPendingStageIntercomBridge(
			{
				events: {
					emit(event, payload) {
						if (event === "atomic:workflow-pending-stage-route") routes.push(payload as (typeof routes)[number]);
					},
				},
			},
			store,
		);
		const childRosterTarget = routes
			.find((route) => route.runId === childRunId)
			?.stages.find((stage) => stage.stageId === childStageId)?.target;
		dispose();
		// D8 clarification: the advertised target is depth-faithful — the child boundary's
		// stage name is the middle segment, not the child run id shortcut.
		assert.equal(childRosterTarget, `workflow:${rootRunId}/workflow:child/${childStageId}`);

		const handler = makeToolHandler();
		const result = await handler({ action: "status" }, {} as never);
		const toolText = renderWorkflowToolContent(result, { action: "status" });
		const listText = renderResult(result, { plain: true, width: 200 });
		const detailResult = await handler({ action: "status", runId: rootRunId }, {} as never);
		const detailText = renderResult(detailResult, { plain: true, width: 200 });

		for (const rendered of [toolText, listText]) {
			assert.ok(rendered.includes(`review (${childStageId})`), rendered);
		}
		for (const rendered of [toolText, listText, detailText]) {
			assert.ok(rendered.includes(childRosterTarget), rendered);
			assert.ok(!rendered.includes(`${rootRunId}:${childRunId}:${childStageId}`), rendered);
		}
		assert.match(toolText, new RegExp(`review \\(${rootStageId}\\).*workflow:${rootRunId}/${rootStageId}`));
	});

	test.sequential("nested pending stages stop advertising targets when their owning child run terminates", async () => {
		const advertisedTargets: string[] = [];
		const missingUnavailableLabels: string[] = [];
		for (const [index, terminalStatus] of ["failed", "cancelled", "killed", "completed"].entries()) {
			store.clear();
			const rootRunId = `${index + 1}1111111-1111-4111-8111-111111111111`;
			const childRunId = `${index + 5}2222222-2222-4222-8222-222222222222`;
			const childStageId = "child-review";
			store.recordRunStart({
				...makeInflightRun(rootRunId),
				name: "root workflow",
				stages: [
					{
						id: "child-boundary",
						name: "workflow:child",
						status: "running",
						parentIds: [],
						toolEvents: [],
						replayKey: "workflow:child:1",
						workflowChildRun: { alias: "child", workflow: "child workflow", runId: childRunId },
					},
				],
			});
			store.recordRunStart({
				...makeInflightRun(childRunId),
				name: "child workflow",
				parentRunId: rootRunId,
				parentStageId: "child-boundary",
				rootRunId,
				stages: [
					{
						id: childStageId,
						name: "review",
						status: "pending",
						parentIds: [],
						toolEvents: [],
						pendingStageDeliveryAvailable: true,
					},
				],
			});
			store.recordRunEnd(childRunId, terminalStatus as "failed" | "cancelled" | "killed" | "completed");

			const handler = makeToolHandler();
			const listingResult = await handler({ action: "status" }, {} as never);
			const rootDetailResult = await handler({ action: "status", runId: rootRunId }, {} as never);
			const childDetailResult = await handler({ action: "status", runId: childRunId }, {} as never);
			const target = `workflow:${rootRunId}/${childRunId}/${childStageId}`;
			const surfaces = {
				concise: renderWorkflowToolContent(listingResult, { action: "status" }),
				toolCard: renderResult(listingResult, { plain: true, width: 200 }),
				rootDetail: renderResult(rootDetailResult, { plain: true, width: 200 }),
				childDetail: renderResult(childDetailResult, { plain: true, width: 200 }),
			};
			for (const [surface, rendered] of Object.entries(surfaces)) {
				if (rendered.includes(target)) advertisedTargets.push(`${terminalStatus}:${surface}`);
				if (!rendered.includes("delivery unavailable") && !rendered.includes("Intercom target=unavailable")) {
					missingUnavailableLabels.push(`${terminalStatus}:${surface}`);
				}
			}
		}

		assert.deepEqual(advertisedTargets, []);
		assert.deepEqual(missingUnavailableLabels, []);
	});

	test.sequential("status text output reports an empty filtered listing", async () => {
		const handler = makeToolHandler();
		const result = await handler({ action: "status", statusFilter: "paused" }, {} as never);
		const text = renderWorkflowToolContent(result, {
			action: "status",
			statusFilter: "paused",
		});
		assert.match(text, /runs: none \(statusFilter: paused\)/);
	});
});

describe("pending stage status target form", () => {
	test("advertises the depth-faithful target when the boundary chain is available", () => {
		// Regression: review round 2, D8 clarification — status surfaces print the
		// depth-faithful target (one boundary segment per ancestor hop) when the run
		// snapshots are available, and keep the flat run-id shortcut otherwise.
		const rootRunId = "4ac72924-c452-4e5f-9e63-2435722109f7";
		const childRunId = "22222222-2222-4222-8222-222222222222";
		const store = createStore();
		store.recordRunStart({
			id: rootRunId,
			name: "root",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "child-boundary",
					name: "workflow:child",
					status: "running",
					parentIds: [],
					toolEvents: [],
					replayKey: "workflow:child:1",
				},
			],
			startedAt: 1,
		});
		store.recordRunStart({
			id: childRunId,
			name: "child",
			inputs: {},
			status: "running",
			parentRunId: rootRunId,
			parentStageId: "child-boundary",
			rootRunId,
			stages: [
				{
					id: "reviewer-id",
					name: "reviewer",
					status: "pending",
					parentIds: [],
					toolEvents: [],
					replayKey: "stage:reviewer:1",
					pendingStageDeliveryAvailable: true,
				},
			],
			startedAt: 2,
		});
		const [child] = store.runs().filter((run) => run.id === childRunId);
		assert.ok(child);
		const reviewerStage = child.stages[0]!;
		const withChain = pendingWorkflowStageStatus(
			child,
			reviewerStage,
			() => "running",
			(runId) => workflowBoundarySegments(store.runs(), runId),
		);
		assert.equal(withChain?.target, `workflow:${rootRunId}/workflow:child/reviewer-id`);
		const withoutChain = pendingWorkflowStageStatus(child, reviewerStage, () => "running");
		assert.equal(withoutChain?.target, `workflow:${rootRunId}/${childRunId}/reviewer-id`);
	});
});
