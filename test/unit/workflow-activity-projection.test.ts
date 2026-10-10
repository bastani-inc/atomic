import assert from "node:assert/strict";
import type { WorkflowRootActivity } from "@bastani/atomic";
import { test } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot, ToolNodeSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	projectWorkflowActivity as projectWithGraph,
	type WorkflowActivityInput,
	type WorkflowActivityOwnership,
	workflowActivityNodeKey,
} from "../../packages/workflows/src/shared/workflow-activity.js";

/** Root state semantics only; graph topology has its own coverage below. */
function projectWorkflowActivity(input: WorkflowActivityInput): WorkflowRootActivity[] {
	return projectWithGraph(input).map(({ graph, ...root }) => root);
}

function stage(id: string, status: StageSnapshot["status"] = "running", parentIds: string[] = []): StageSnapshot {
	return { id, name: id, status, parentIds, toolEvents: [] };
}

function tool(id = "tool"): ToolNodeSnapshot {
	return {
		kind: "tool",
		id,
		name: id,
		argsHash: "hash",
		ordinal: 0,
		parentIds: [],
		status: "running",
		attachable: false,
	};
}

function run(patch: Partial<RunSnapshot> = {}): RunSnapshot {
	return { id: "root", name: "workflow", inputs: {}, status: "running", startedAt: 0, stages: [], ...patch };
}

function ownership(patch: Partial<WorkflowActivityOwnership> = {}): WorkflowActivityOwnership {
	return {
		ownerSessionId: "session",
		executingStageIds: new Set<string>(),
		executingToolNodeIds: new Set<string>(),
		stoppingRunIds: new Set<string>(),
		retryingStageIds: new Set<string>(),
		acknowledgedFailureRunIds: new Set<string>(),
		...patch,
	};
}

function project(runs: RunSnapshot[], patch: Partial<WorkflowActivityOwnership> = {}): WorkflowRootActivity[] {
	return projectWorkflowActivity({ snapshot: { runs, notices: [], version: 0 }, ownership: ownership(patch) });
}

function activity(patch: Partial<WorkflowRootActivity> = {}): WorkflowRootActivity {
	return {
		rootRunId: "root",
		ownerSessionId: "session",
		state: "idle",
		reason: "quiescent",
		activeExecutionCount: 0,
		actionableBlockCount: 0,
		needsAttention: false,
		...patch,
	};
}

const prompt = { id: "prompt", kind: "confirm" as const, message: "Private prompt", createdAt: 0 };
const executing = { state: "working", reason: "executing", activeExecutionCount: 1 } as const;
const waiting = { state: "blocked", reason: "awaiting_input", actionableBlockCount: 1, needsAttention: true } as const;

test("settled failure needs attention without claiming a user decision wait", () => {
	for (const status of ["failed", "blocked"] as const) {
		const stopped = run({
			status,
			endedAt: 1,
			resumable: true,
			failureRecoverability: "recoverable",
			failureDisposition: "active_blocked",
		});
		assert.deepEqual(project([stopped]), [activity({ needsAttention: true })]);
		assert.deepEqual(project([stopped], { acknowledgedFailureRunIds: new Set(["root"]) }), [activity()]);
		assert.deepEqual(project([{ ...stopped, pendingPrompt: prompt }]), [activity(waiting)]);
		assert.equal(stopped.status, status, "pane activity must not rewrite the failed outcome");
	}
});

test("settled budget stops still require approval while unrelated execution remains working", () => {
	const stopped = run({ status: "blocked", endedAt: 1, budgetState: { systemOwnedStop: true } });
	assert.deepEqual(project([stopped]), [
		activity({ state: "blocked", reason: "manual_intervention", actionableBlockCount: 1, needsAttention: true }),
	]);
	const failed = run({ status: "failed", endedAt: 1 });
	const sibling = run({ id: "child", parentRunId: "root", stages: [stage("live")] });
	assert.deepEqual(
		project([failed, sibling], { executingStageIds: new Set([workflowActivityNodeKey("child", "live")]) }),
		[activity({ ...executing, needsAttention: true })],
	);
});
// #2891: a tool-only workflow contributes execution without an agent stage.
test("workflow activity projects owned tool-only execution", () => {
	assert.deepEqual(
		project([run({ toolNodes: [tool()] })], {
			executingToolNodeIds: new Set([workflowActivityNodeKey("root", "tool")]),
		}),
		[activity(executing)],
	);
});

test("live author continuation stays working after its tool settles, but not while parked or recovered", () => {
	const completedTool = { ...tool(), status: "completed" as const };
	const live = { liveRunIds: new Set(["root"]) };
	assert.deepEqual(project([run({ toolNodes: [completedTool] })], live), [
		activity({ state: "working", reason: "automatic_continuation" }),
	]);
	assert.deepEqual(project([run({ toolNodes: [completedTool] })]), [activity()]);
	assert.deepEqual(
		project(
			[
				run({
					toolNodes: [completedTool],
					stages: [{ ...stage("prompt", "awaiting_input"), pendingPrompt: prompt }],
				}),
			],
			live,
		),
		[activity(waiting)],
	);
	assert.deepEqual(project([run({ status: "paused", toolNodes: [completedTool] })], live), [
		activity({ reason: "paused" }),
	]);
	assert.deepEqual(project([run({ status: "completed", toolNodes: [completedTool] })], live), [activity()]);
	assert.deepEqual(project([run({ toolNodes: [completedTool] })], { ...live, stoppingRunIds: new Set(["root"]) }), [
		activity(),
	]);
});

test("a live run stays working between node admissions and settles, but not when parked or recovered (#3556)", () => {
	const live = { liveRunIds: new Set(["root"]) };
	const continuing = activity({ state: "working", reason: "automatic_continuation" });
	const first = { ...tool("first"), status: "completed" as const };
	const admitted = (parentIds: string[]) => ({ ...tool("next"), status: "pending" as const, parentIds });

	// A tool node is admitted pending before its executor is recorded.
	assert.deepEqual(project([run({ toolNodes: [admitted([])] })], live), [continuing]);
	assert.deepEqual(project([run({ toolNodes: [first, admitted(["first"])] })], live), [continuing]);
	assert.deepEqual(project([run({ toolNodes: [{ ...first, status: "cached" }, admitted(["first"])] })], live), [
		continuing,
	]);
	assert.deepEqual(
		project([run({ toolNodes: [{ ...tool("first"), status: "running" }, admitted(["first"])] })], live),
		[activity()],
	);
	assert.deepEqual(project([run({ toolNodes: [admitted([])] })]), [activity()]);
	assert.deepEqual(project([run({ status: "paused", toolNodes: [admitted([])] })], live), [
		activity({ reason: "paused" }),
	]);
	assert.deepEqual(project([run({ toolNodes: [admitted([])] })], { ...live, stoppingRunIds: new Set(["root"]) }), [
		activity(),
	]);

	// A replayed or failed tool settles; the run either continues or ends, never idles in between.
	assert.deepEqual(project([run({ toolNodes: [{ ...first, status: "cached" }] })], live), [continuing]);
	assert.deepEqual(project([run({ toolNodes: [{ ...first, status: "failed" }] })], live), [continuing]);
	assert.deepEqual(project([run({ toolNodes: [{ ...first, status: "failed" }] })]), [activity()]);
	assert.deepEqual(
		project([run({ status: "failed", endedAt: 1, toolNodes: [{ ...first, status: "failed" }] })], live),
		[activity({ needsAttention: true })],
	);
});

test("a live run stays working while its nested workflow boundary has no executor, unless something waits (#3556)", () => {
	const live = { liveRunIds: new Set(["root"]) };
	const boundary = (patch: Partial<StageSnapshot> = {}): StageSnapshot => ({
		...stage("workflow:child", "running"),
		workflowChildRun: { alias: "child", workflow: "child", runId: "child-run" },
		...patch,
	});
	const before = { ...tool("before"), status: "completed" as const };
	const parent = run({ toolNodes: [before], stages: [boundary()] });
	const child = (patch: Partial<RunSnapshot> = {}) =>
		run({ id: "child-run", parentRunId: "root", rootRunId: "root", ...patch });
	const continuing = activity({ state: "working", reason: "automatic_continuation" });

	// Child not live yet, and child finished before the parent's boundary stage settled.
	assert.deepEqual(project([parent, child()], live), [continuing]);
	assert.deepEqual(project([parent, child({ status: "completed" })], live), [continuing]);
	assert.deepEqual(project([parent]), [activity()]);
	// A wait inside the child, or a pause, is not hidden behind the boundary.
	assert.deepEqual(project([parent, child({ pendingPrompt: prompt })], live), [activity(waiting)]);
	assert.deepEqual(project([parent, child({ stages: [stage("ask", "awaiting_input")] })], live), [activity(waiting)]);
	assert.deepEqual(project([{ ...parent, status: "paused" }, child({ status: "paused" })], live), [
		activity({ reason: "paused" }),
	]);
});

// #2891: RFC 5.3 state precedence and ownership, rather than historical status.
test("workflow activity state table", () => {
	const cases: {
		name: string;
		run: RunSnapshot;
		ownership?: Partial<WorkflowActivityOwnership>;
		expected: Partial<WorkflowRootActivity>;
	}[] = [
		{
			name: "owned agent",
			run: run({ stages: [stage("agent")] }),
			ownership: { executingStageIds: new Set([workflowActivityNodeKey("root", "agent")]) },
			expected: executing,
		},
		{ name: "historical running stage", run: run({ stages: [stage("agent")] }), expected: {} },
		{ name: "historical running tool", run: run({ toolNodes: [tool()] }), expected: {} },
		{
			name: "runnable handoff",
			run: run({ stages: [stage("done", "completed"), stage("next", "pending", ["done"])] }),
			expected: { state: "working", reason: "automatic_continuation" },
		},
		{
			name: "initial runnable stage",
			run: run({ stages: [stage("next", "pending")] }),
			expected: { state: "working", reason: "automatic_continuation" },
		},
		{
			name: "incomplete parent",
			run: run({ stages: [stage("parent"), stage("next", "pending", ["parent"])] }),
			expected: {},
		},
		{ name: "missing parent", run: run({ stages: [stage("next", "pending", ["missing"])] }), expected: {} },
		{
			name: "tool parent completed",
			run: run({ stages: [stage("next", "pending", ["tool"])], toolNodes: [{ ...tool(), status: "completed" }] }),
			expected: { state: "working", reason: "automatic_continuation" },
		},
		{
			name: "retry backoff",
			run: run({ stages: [stage("agent")] }),
			ownership: { retryingStageIds: new Set([workflowActivityNodeKey("root", "agent")]) },
			expected: { state: "working", reason: "retrying" },
		},
		{
			name: "stop drain",
			run: run({ status: "cancelled", toolNodes: [tool()] }),
			ownership: {
				executingToolNodeIds: new Set([workflowActivityNodeKey("root", "tool")]),
				stoppingRunIds: new Set(["root"]),
			},
			expected: { ...executing, reason: "stopping" },
		},
		{
			name: "stop drained",
			run: run({ status: "cancelled", stages: [stage("next", "pending")] }),
			ownership: { stoppingRunIds: new Set(["root"]) },
			expected: {},
		},
		{
			name: "parked own prompt",
			run: run({ stages: [{ ...stage("agent", "awaiting_input"), pendingPrompt: prompt }] }),
			ownership: { executingStageIds: new Set([workflowActivityNodeKey("root", "agent")]) },
			expected: waiting,
		},
		{
			name: "prompt alone without status change",
			run: run({ stages: [{ ...stage("agent"), pendingPrompt: prompt }] }),
			ownership: { executingStageIds: new Set([workflowActivityNodeKey("root", "agent")]) },
			expected: waiting,
		},
		{ name: "stage awaiting input", run: run({ stages: [stage("agent", "awaiting_input")] }), expected: waiting },
		{ name: "run prompt", run: run({ pendingPrompt: prompt }), expected: waiting },
		{
			name: "independent parallel branch",
			run: run({ stages: [stage("wait", "awaiting_input"), stage("agent")] }),
			ownership: {
				executingStageIds: new Set([
					workflowActivityNodeKey("root", "wait"),
					workflowActivityNodeKey("root", "agent"),
				]),
			},
			expected: { ...executing, actionableBlockCount: 1, needsAttention: true },
		},
		{
			name: "run prompt and independent tool",
			run: run({ pendingPrompt: prompt, toolNodes: [tool()] }),
			ownership: { executingToolNodeIds: new Set([workflowActivityNodeKey("root", "tool")]) },
			expected: { ...executing, actionableBlockCount: 1, needsAttention: true },
		},
		{
			name: "failed",
			run: run({ status: "failed" }),
			expected: { state: "blocked", reason: "manual_intervention", actionableBlockCount: 1, needsAttention: true },
		},
		{
			name: "blocked",
			run: run({ status: "blocked" }),
			expected: { state: "blocked", reason: "manual_intervention", actionableBlockCount: 1, needsAttention: true },
		},
		{
			name: "failure acknowledged",
			run: run({ status: "failed" }),
			ownership: { acknowledgedFailureRunIds: new Set(["root"]) },
			expected: {},
		},
		{
			name: "paused",
			run: run({ status: "paused", stages: [stage("next", "pending")] }),
			expected: { reason: "paused" },
		},
		{
			name: "paused still draining",
			run: run({ status: "paused", toolNodes: [tool()] }),
			ownership: { executingToolNodeIds: new Set([workflowActivityNodeKey("root", "tool")]) },
			expected: executing,
		},
		{ name: "completed", run: run({ status: "completed" }), expected: {} },
		{ name: "cancelled", run: run({ status: "cancelled" }), expected: {} },
		{ name: "killed", run: run({ status: "killed" }), expected: {} },
		{ name: "skipped stage", run: run({ stages: [stage("skip", "skipped")] }), expected: {} },
		{
			name: "skipped parent is not completed",
			run: run({ stages: [stage("skip", "skipped"), stage("next", "pending", ["skip"])] }),
			expected: {},
		},
	];
	for (const scenario of cases) {
		assert.deepEqual(project([scenario.run], scenario.ownership), [activity(scenario.expected)], scenario.name);
	}
});

// #2891: descendants contribute once to their root, not separate root reports.
test("workflow activity folds nested descendants into roots in snapshot order", () => {
	const root = run();
	const child = run({ id: "child", parentRunId: "root", stages: [stage("wait", "awaiting_input")] });
	const grandchild = run({ id: "grandchild", parentRunId: "child", stages: [stage("agent")] });
	const explicit = run({ id: "explicit", rootRunId: "root", toolNodes: [tool()] });
	const other = run({ id: " other root ", status: "completed" });
	assert.deepEqual(
		project([grandchild, other, child, root, explicit], {
			executingStageIds: new Set([workflowActivityNodeKey("grandchild", "agent")]),
			executingToolNodeIds: new Set([workflowActivityNodeKey("explicit", "tool")]),
		}),
		[
			activity({ ...executing, activeExecutionCount: 2, actionableBlockCount: 1, needsAttention: true }),
			activity({ rootRunId: " other root " }),
		],
	);
});

// #2891: parked execution resumes only when its human wait is answered.
test("workflow activity follows prompt answer, pause, stop drain and acknowledgement transitions", () => {
	const agent: StageSnapshot = { ...stage("agent", "awaiting_input"), pendingPrompt: prompt };
	const current = run({ stages: [agent] });
	const owned = { executingStageIds: new Set([workflowActivityNodeKey("root", "agent")]) };
	assert.deepEqual(project([current], owned), [activity(waiting)]);
	agent.pendingPrompt = undefined;
	agent.status = "running";
	assert.deepEqual(project([current], owned), [activity(executing)]);
	current.status = "paused";
	assert.deepEqual(project([current]), [activity({ reason: "paused" })]);
	current.status = "running";
	assert.deepEqual(project([current], owned), [activity(executing)]);
	current.status = "cancelled";
	assert.deepEqual(project([current], { ...owned, stoppingRunIds: new Set(["root"]) }), [
		activity({ ...executing, reason: "stopping" }),
	]);
	assert.deepEqual(project([current], { stoppingRunIds: new Set(["root"]) }), [activity()]);
	current.status = "failed";
	assert.equal(project([current])[0].state, "blocked");
	assert.deepEqual(project([current], { acknowledgedFailureRunIds: new Set(["root"]) }), [activity()]);
	assert.equal(current.status, "failed", "acknowledgement must not rewrite the outcome");
});

// #2891: every call returns a complete replacement, never mutable accumulated deltas.
test("workflow activity is deterministic and returns independent full replacements", () => {
	for (let count = 0; count < 24; count++) {
		const stages = Array.from({ length: count }, (_, index) =>
			stage(` raw stage ${index} `, index % 3 === 0 ? "awaiting_input" : "running"),
		);
		const snapshot = {
			runs: [run({ stages }), run({ id: "other", status: "completed" })],
			notices: [],
			version: count,
		};
		const owned = ownership({
			ownerSessionId: " session raw ",
			executingStageIds: new Set(stages.map((stage) => workflowActivityNodeKey("root", stage.id))),
		});
		const before = structuredClone({ snapshot, ownership: owned });
		const first = projectWorkflowActivity({ snapshot, ownership: owned });
		const second = projectWorkflowActivity({ snapshot, ownership: owned });
		assert.deepEqual(first, second);
		assert.notEqual(first, second);
		assert.notEqual(first[0], second[0]);
		assert.equal(first[0].activeExecutionCount, count - Math.ceil(count / 3));
		assert.equal(first[0].actionableBlockCount, Math.ceil(count / 3));
		assert.equal(first[0].ownerSessionId, " session raw ");
		first[0].activeExecutionCount = 999;
		assert.deepEqual(projectWorkflowActivity({ snapshot, ownership: owned }), second);
		assert.deepEqual({ snapshot, ownership: owned }, before);
	}
	assert.deepEqual(project([]), []);
});

// #2891: retained prompts in inactive snapshots do not create new attention obligations.
test("paused and terminal roots stay idle without draining execution", () => {
	for (const status of ["paused", "completed", "cancelled", "killed"] as const) {
		assert.deepEqual(project([run({ status, pendingPrompt: prompt, stages: [stage("wait", "awaiting_input")] })]), [
			activity({ reason: status === "paused" ? "paused" : "quiescent" }),
		]);
	}
});

// #2891: recoverable blocks retain run.status=running in the real store.
test("workflow activity recognizes recoverable manual intervention without rewriting run status", () => {
	const blocked = run({ blockedAt: 0, failureDisposition: "active_blocked", stages: [stage("agent", "blocked")] });
	assert.deepEqual(project([blocked]), [
		activity({ state: "blocked", reason: "manual_intervention", actionableBlockCount: 1, needsAttention: true }),
	]);
	assert.deepEqual(project([blocked], { acknowledgedFailureRunIds: new Set(["root"]) }), [activity()]);
	assert.equal(blocked.status, "running");
});

// #2891: tool hashes are run-local, so ownership must include the run id.
test("workflow activity isolates identical tool ids in different roots", () => {
	const first = run({ id: "first", toolNodes: [tool("tool:hash")] });
	const historical = run({ id: "historical", toolNodes: [tool("tool:hash")] });
	assert.deepEqual(project([first, historical], { executingToolNodeIds: new Set(["tool:hash"]) }), [
		activity({ rootRunId: "first" }),
		activity({ rootRunId: "historical" }),
	]);
	assert.equal(workflowActivityNodeKey("first", "tool:hash"), "first:tool:hash");
	assert.equal(workflowActivityNodeKey(" raw run ", " raw:node "), " raw run : raw:node ");
	assert.equal(workflowActivityNodeKey("", ""), ":");
	assert.deepEqual(project([first, historical], { executingToolNodeIds: new Set(["first:tool:hash"]) }), [
		activity({ ...executing, rootRunId: "first" }),
		activity({ rootRunId: "historical" }),
	]);
});

// #2891: stage execution and backoff use the same run-qualified addressing as tools.
test("workflow activity qualifies stage execution and retry ownership", () => {
	const first = run({ id: "first", stages: [stage("agent")] });
	const historical = run({ id: "historical", stages: [stage("agent")] });
	for (const field of ["executingStageIds", "retryingStageIds"] as const) {
		assert.deepEqual(project([first, historical], { [field]: new Set(["agent"]) }), [
			activity({ rootRunId: "first" }),
			activity({ rootRunId: "historical" }),
		]);
		assert.deepEqual(
			project([first, historical], { [field]: new Set([workflowActivityNodeKey("first", "agent")]) }),
			[
				activity({
					rootRunId: "first",
					state: "working",
					reason: field === "executingStageIds" ? "executing" : "retrying",
					activeExecutionCount: field === "executingStageIds" ? 1 : 0,
				}),
				activity({ rootRunId: "historical" }),
			],
		);
	}
});

// #2891: stopping a workflow boundary must not suppress handoffs outside its subtree.
test("workflow activity preserves independent handoffs while a child stops", () => {
	const cases = [
		{ target: "root", stopping: "child", runnable: true },
		{ target: "sibling", stopping: "child", runnable: true },
		{ target: "child", stopping: "child", runnable: false },
		{ target: "grandchild", stopping: "child", runnable: false },
		{ target: "grandchild", stopping: "root", runnable: false },
	];
	for (const scenario of cases) {
		for (const withWait of [false, true]) {
			const store = createStore();
			store.recordRunStart(run());
			// Descendant-before-parent order must not affect control scope.
			store.recordRunStart(run({ id: "grandchild", parentRunId: "child", rootRunId: "root" }));
			store.recordRunStart(run({ id: "child", parentRunId: "root", rootRunId: "root" }));
			store.recordRunStart(run({ id: "sibling", parentRunId: "root", rootRunId: "root" }));
			store.recordStageStart(scenario.target, stage("done"));
			store.recordStageStart(scenario.target, stage("next", "pending", ["done"]));
			store.recordStageEnd(scenario.target, { ...stage("done", "completed"), endedAt: 1 });
			if (withWait) {
				store.recordRunStart(run({ id: "waiter", parentRunId: "root", rootRunId: "root" }));
				store.recordStageStart("waiter", stage("wait"));
				assert.equal(store.recordStageAwaitingInput("waiter", "wait", true), true);
			}
			const owned = ownership({ stoppingRunIds: new Set([scenario.stopping]) });
			const attention = { actionableBlockCount: withWait ? 1 : 0, needsAttention: withWait };
			for (const paused of [false, true]) {
				if (paused) store.recordRunPaused(scenario.stopping);
				const snapshot = store.graphSnapshot();
				const before = structuredClone(snapshot);
				assert.deepEqual(
					projectWorkflowActivity({ snapshot, ownership: owned }),
					[
						activity({
							...attention,
							state: scenario.runnable ? "working" : withWait ? "blocked" : "idle",
							reason: scenario.runnable
								? "automatic_continuation"
								: withWait
									? "awaiting_input"
									: paused
										? "paused"
										: "quiescent",
						}),
					],
					JSON.stringify({ ...scenario, withWait, paused }),
				);
				assert.deepEqual(snapshot, before);
			}
		}
	}
});

// #2891: per-stage pause does not pause the run while another stage still executes.
test("workflow activity retains a paused stage after its parallel sibling completes", () => {
	for (const status of ["completed", "cancelled", "killed", "failed"] as const) {
		const store = createStore();
		store.recordRunStart(run({ stages: [stage("paused"), stage("sibling")] }));
		assert.equal(store.recordStagePaused("root", "paused", 1), true);
		assert.deepEqual(
			projectWorkflowActivity({
				snapshot: store.graphSnapshot(),
				ownership: ownership({ executingStageIds: new Set([workflowActivityNodeKey("root", "sibling")]) }),
			}),
			[activity(executing)],
		);
		store.recordStageEnd("root", { ...stage("sibling", "completed"), endedAt: 2 });
		const snapshot = store.graphSnapshot();
		const before = structuredClone(snapshot);
		assert.equal(snapshot.runs[0].status, "running");
		assert.deepEqual(
			snapshot.runs[0].stages.map((stage) => stage.status),
			["paused", "completed"],
		);
		assert.deepEqual(projectWorkflowActivity({ snapshot, ownership: ownership() }), [activity({ reason: "paused" })]);
		assert.deepEqual(snapshot, before);
		assert.deepEqual(store.graphSnapshot(), before);
		// Retained paused stages must not overwrite a terminal outcome or its acknowledgement.
		store.recordRunEnd("root", status);
		assert.deepEqual(
			projectWorkflowActivity({
				snapshot: store.graphSnapshot(),
				ownership: ownership({ acknowledgedFailureRunIds: new Set(["root"]) }),
			}),
			[activity()],
		);
		assert.equal(store.runs()[0].status, status);
		assert.deepEqual(
			store.runs()[0].stages.map((stage) => stage.status),
			["paused", "completed"],
		);
	}
});

// #2891: a paused stage retains its prompt, but it is not actionable until resume.
test("workflow activity suspends a retained prompt across pause and sibling completion", () => {
	const store = createStore();
	store.recordRunStart(run({ stages: [stage("agent"), stage("sibling")] }));
	const executingStageIds = new Set([
		workflowActivityNodeKey("root", "agent"),
		workflowActivityNodeKey("root", "sibling"),
	]);
	const owned = ownership({ executingStageIds });
	const assertActivity = (expected: Partial<WorkflowRootActivity>) => {
		const snapshot = store.graphSnapshot();
		const before = structuredClone({ snapshot, ownership: owned });
		assert.deepEqual(projectWorkflowActivity({ snapshot, ownership: owned }), [activity(expected)]);
		assert.deepEqual({ snapshot, ownership: owned }, before);
		assert.deepEqual(store.graphSnapshot(), before.snapshot);
	};
	assertActivity({ ...executing, activeExecutionCount: 2 });
	assert.equal(store.recordStagePendingPrompt("root", "agent", prompt), true);
	assertActivity({ ...executing, actionableBlockCount: 1, needsAttention: true });

	assert.equal(store.recordStagePaused("root", "agent", 1), true);
	assertActivity(executing);
	store.recordStageEnd("root", { ...stage("sibling", "completed"), endedAt: 2 });
	// Completion is not proof of released ownership: independent work may still drain.
	assertActivity(executing);
	executingStageIds.delete(workflowActivityNodeKey("root", "sibling"));
	assertActivity({ reason: "paused" });
	const paused = store.graphSnapshot().runs[0];
	assert.equal(paused.status, "running");
	assert.deepEqual(
		paused.stages.map((stage) => stage.status),
		["paused", "completed"],
	);
	assert.deepEqual(paused.stages[0].pendingPrompt, prompt);

	// An independent active wait still needs attention while the first stage is paused.
	store.recordStageStart("root", stage("waiter"));
	assert.equal(store.recordStagePendingPrompt("root", "waiter", { ...prompt, id: "other-prompt" }), true);
	assertActivity(waiting);
	assert.equal(store.resolveStagePendingPrompt("root", "waiter", "other-prompt", true), true);
	store.recordStageEnd("root", { ...stage("waiter", "completed"), endedAt: 3 });
	assertActivity({ reason: "paused" });

	assert.equal(store.recordStageResumed("root", "agent", 4), true);
	assert.equal(store.graphSnapshot().runs[0].stages[0].status, "running");
	assert.deepEqual(store.graphSnapshot().runs[0].stages[0].pendingPrompt, prompt);
	assertActivity(waiting);
	assert.equal(store.resolveStagePendingPrompt("root", "agent", prompt.id, true), true);
	assertActivity(executing);
});

// #2891: removing root history does not release its descendants' runtime stop ownership.
test("workflow activity preserves stop draining after the root snapshot is removed", () => {
	for (const kind of ["stage", "tool"] as const) {
		const store = createStore();
		const rootRunId = "11111111-1111-4111-8111-111111111111";
		const childRunId = "22222222-2222-4222-8222-222222222222";
		const nodeId = " raw:node ";
		store.recordRunStart(run({ id: rootRunId }));
		store.recordRunStart(
			run({
				id: childRunId,
				parentRunId: rootRunId,
				rootRunId,
				...(kind === "stage" ? { stages: [stage(nodeId)] } : { toolNodes: [tool(nodeId)] }),
			}),
		);
		const executingIds = new Set([workflowActivityNodeKey(childRunId, nodeId)]);
		const stoppingRunIds = new Set([rootRunId]);
		const owned = ownership({
			[kind === "stage" ? "executingStageIds" : "executingToolNodeIds"]: executingIds,
			stoppingRunIds,
		});
		const assertActivity = (expected: Partial<WorkflowRootActivity>) => {
			const snapshot = store.graphSnapshot();
			const before = structuredClone({ snapshot, ownership: owned });
			assert.deepEqual(projectWorkflowActivity({ snapshot, ownership: owned }), [
				activity({ rootRunId, ...expected }),
			]);
			assert.deepEqual({ snapshot, ownership: owned }, before);
			assert.deepEqual(store.graphSnapshot(), before.snapshot);
		};
		assertActivity({ ...executing, reason: "stopping" });
		const childBeforeRemoval = structuredClone(store.graphSnapshot().runs[1]);
		assert.equal(store.removeRun(rootRunId), true);
		assert.deepEqual(store.graphSnapshot().runs, [childBeforeRemoval]);
		assertActivity({ ...executing, reason: "stopping" });
		stoppingRunIds.clear();
		assertActivity(executing);
		stoppingRunIds.add(rootRunId);
		assertActivity({ ...executing, reason: "stopping" });
		executingIds.clear();
		assertActivity({});
		assert.deepEqual(store.graphSnapshot().runs, [childBeforeRemoval]);
	}
});

// #2891: retained parent identity preserves stop ownership after intermediate history is removed.
test("workflow activity preserves stop draining after an intermediate ancestor is removed", () => {
	for (const kind of ["stage", "tool"] as const) {
		for (const accessor of ["snapshot", "graphSnapshot"] as const) {
			const store = createStore();
			const rootRunId = "11111111-1111-4111-8111-111111111111";
			const middleRunId = "22222222-2222-4222-8222-222222222222";
			const leafRunId = "33333333-3333-4333-8333-333333333333";
			const nodeId = " raw:node ";
			store.recordRunStart(run({ id: rootRunId }));
			store.recordRunStart(run({ id: middleRunId, parentRunId: rootRunId, rootRunId }));
			store.recordRunStart(
				run({
					id: leafRunId,
					parentRunId: middleRunId,
					rootRunId,
					...(kind === "stage" ? { stages: [stage(nodeId)] } : { toolNodes: [tool(nodeId)] }),
				}),
			);
			const executingIds = new Set([workflowActivityNodeKey(leafRunId, nodeId)]);
			const stoppingRunIds = new Set([middleRunId]);
			const owned = ownership({
				[kind === "stage" ? "executingStageIds" : "executingToolNodeIds"]: executingIds,
				stoppingRunIds,
			});
			const assertActivity = (expected: Partial<WorkflowRootActivity>) => {
				const snapshot = store[accessor]();
				const before = structuredClone({ snapshot, ownership: owned });
				const result = projectWorkflowActivity({ snapshot, ownership: owned });
				assert.deepEqual(result, [activity({ rootRunId, ...expected })], `${kind}/${accessor}`);
				assert.deepEqual({ snapshot, ownership: owned }, before);
				assert.deepEqual(store[accessor](), before.snapshot);
				return result;
			};
			const beforeRemoval = assertActivity({ ...executing, reason: "stopping" });
			const remainingRuns = structuredClone(store[accessor]().runs.filter((run) => run.id !== middleRunId));
			const ownershipBeforeRemoval = structuredClone(owned);
			assert.equal(store.removeRun(middleRunId), true);
			assert.deepEqual(store[accessor]().runs, remainingRuns);
			assert.deepEqual(owned, ownershipBeforeRemoval);
			const afterRemoval = assertActivity({ ...executing, reason: "stopping" });
			assert.deepEqual(afterRemoval, beforeRemoval);
			assert.notEqual(afterRemoval[0], beforeRemoval[0]);
			stoppingRunIds.clear();
			assertActivity(executing);
			stoppingRunIds.add(middleRunId);
			assertActivity({ ...executing, reason: "stopping" });
			executingIds.clear();
			assertActivity({});
			assert.deepEqual(store[accessor]().runs, remainingRuns);
		}
	}
});

// #2891: a draining branch must not relabel its independently executing sibling.
test("workflow activity reports stopping only after independent sibling execution finishes", () => {
	const store = createStore();
	store.recordRunStart(run());
	store.recordRunStart(run({ id: "a", parentRunId: "root", rootRunId: "root", toolNodes: [tool()] }));
	store.recordRunStart(run({ id: "b", parentRunId: "root", rootRunId: "root", stages: [stage("agent")] }));
	const executingStageIds = new Set([workflowActivityNodeKey("b", "agent")]);
	const owned = ownership({
		executingStageIds,
		executingToolNodeIds: new Set([workflowActivityNodeKey("a", "tool")]),
		stoppingRunIds: new Set(["a"]),
	});
	const phases = [
		{ siblingCompleted: false, expected: { ...executing, activeExecutionCount: 2 } },
		{ siblingCompleted: true, expected: { ...executing, reason: "stopping" as const } },
	];
	for (const phase of phases) {
		if (phase.siblingCompleted) {
			store.recordStageEnd("b", { ...stage("agent", "completed"), endedAt: 1 });
			executingStageIds.clear();
		}
		const snapshot = store.graphSnapshot();
		const before = structuredClone({ snapshot, ownership: owned });
		assert.deepEqual(projectWorkflowActivity({ snapshot, ownership: owned }), [activity(phase.expected)]);
		assert.deepEqual({ snapshot, ownership: owned }, before);
		assert.deepEqual(store.graphSnapshot(), before.snapshot);
	}
});

test("workflow activity projects each root's expanded graph with nested child runs (#3476)", () => {
	const root = run({
		stages: [
			{ ...stage("plan", "completed"), executionOrder: 0 },
			{
				...stage("child", "running", ["plan"]),
				executionOrder: 2,
				workflowChildRun: { runId: "child-run", alias: "child", workflow: "child" },
			},
			{
				...stage("ask", "awaiting_input", ["plan"]),
				executionOrder: 3,
				pendingPrompt: { ...prompt, kind: "select", choices: ["a"] },
			},
		],
		toolNodes: [{ ...tool("fetch"), parentIds: ["plan"], executionOrder: 1, ordinal: 4 }],
	});
	const child = run({
		id: "child-run",
		parentRunId: "root",
		parentStageId: "child",
		rootRunId: "root",
		stages: [stage("inner", "pending")],
	});
	const [activity] = projectWithGraph({
		snapshot: { runs: [root, child], notices: [], version: 0 },
		ownership: ownership(),
	});
	assert.deepEqual(activity?.graph, {
		nodes: [
			{
				kind: "stage",
				id: "plan",
				runId: "root",
				nodeId: "plan",
				name: "plan",
				status: "completed",
				parentIds: [],
				executionOrder: 0,
				depth: 0,
			},
			{
				kind: "tool",
				id: "fetch",
				runId: "root",
				nodeId: "fetch",
				name: "fetch",
				status: "running",
				parentIds: ["plan"],
				executionOrder: 1,
				depth: 0,
				ordinal: 4,
			},
			{
				kind: "stage",
				id: "child-run:inner",
				runId: "child-run",
				nodeId: "inner",
				name: "inner",
				status: "pending",
				parentIds: ["plan"],
				depth: 1,
			},
			{
				kind: "stage",
				id: "ask",
				runId: "root",
				nodeId: "ask",
				name: "ask",
				status: "awaiting_input",
				parentIds: ["plan"],
				executionOrder: 3,
				depth: 0,
				pendingPrompt: { id: "prompt", kind: "select", message: "Private prompt", choices: ["a"], createdAt: 0 },
			},
		],
	});
	assert.deepEqual(JSON.parse(JSON.stringify(activity?.graph)), activity?.graph, "graph must be JSON-serializable");
});

test("workflow activity graph carries run-level prompts with their owning run (#3476)", () => {
	const child = run({ id: "child-run", parentRunId: "root", rootRunId: "root", pendingPrompt: prompt });
	const [withPrompt] = projectWithGraph({
		snapshot: { runs: [run({ stages: [stage("plan")] }), child], notices: [], version: 0 },
		ownership: ownership(),
	});
	assert.deepEqual(withPrompt?.graph?.runPrompts, [{ ...prompt, runId: "child-run" }]);

	const [withoutPrompt] = projectWithGraph({
		snapshot: { runs: [run({ stages: [stage("plan")] })], notices: [], version: 0 },
		ownership: ownership(),
	});
	assert.equal(withoutPrompt?.graph !== undefined && "runPrompts" in withoutPrompt.graph, false);
});
