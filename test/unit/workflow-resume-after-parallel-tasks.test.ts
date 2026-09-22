import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import { runGoalWorkflow } from "../../packages/workflows/builtin/goal-runner.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import type { WorkflowTaskOptions, WorkflowTaskStep } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import {
	appendProseTurn,
	type CreateAgentSessionOptions,
	createStore,
	mockSession,
	type StageSessionRuntime,
	structuredOutputMockSession,
	type WorkflowDefinition,
} from "./executor-shared.js";

afterEach(() => {
	setDurableBackend(undefined);
});

const approvingReview = {
	findings: [],
	overall_correctness: "patch is correct",
	overall_explanation: "all focused checks pass",
	overall_confidence_score: 0.99,
	goal_oracle_satisfied: true,
	requirements_traceability: [{ requirement: "fix the defect", status: "proven", evidence: "focused test" }],
	receipt_assessment: "receipt verified",
	verification_remaining: "none",
	stop_review_loop: true,
	reviewer_error: null,
};

/** Keep Goal's authored task shapes but pin stage models, so no router call is needed. */
function withoutAutoModel<T extends WorkflowTaskOptions | WorkflowTaskStep>(options: T): T {
	const { model: _model, ...rest } = options;
	return rest as T;
}

describe("resume after a completed ctx.parallel", () => {
	test("replays the parallel fan-in and re-executes only the failed downstream task (#3207)", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const executions: string[] = [];
		let failPullRequest = true;
		const definition = workflow({
			name: "resume-after-parallel-tasks",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => {
				await ctx.tool("artifact-root", { workflow: "goal" }, async () => "artifacts");
				await ctx.task("orchestrator", { prompt: "orchestrator" });
				await ctx.parallel(
					[
						{ name: "completion-reviewer", prompt: "completion-reviewer" },
						{ name: "evidence-reviewer", prompt: "evidence-reviewer" },
						{ name: "risk-reviewer", prompt: "risk-reviewer" },
					],
					{ failFast: true },
				);
				const pullRequest = await ctx.task("pull-request", { prompt: "pull-request" });
				return { result: pullRequest.text };
			},
		});
		const adapters = {
			prompt: {
				prompt: async (text: string) => {
					executions.push(text);
					if (text === "pull-request" && failPullRequest) throw new Error("HTTP 429 quota exceeded");
					return `${text} done`;
				},
			},
		};
		const store = createStore();
		const first = await run(definition, {}, { store, durableBackend: backend, adapters });
		assert.equal(first.status, "running", first.error);
		const source = store.runs().find((candidate) => candidate.id === first.runId);
		assert.ok(source);
		assert.equal(source.failureRecoverability, "recoverable");
		assert.equal(source.stages.find((stage) => stage.id === source.failedStageId)?.name, "pull-request");
		backend.registerWorkflow({
			workflowId: source.id,
			name: definition.name,
			inputs: {},
			createdAt: 1,
			status: "blocked",
			resumable: true,
		});

		failPullRequest = false;
		executions.length = 0;
		const jobs = createJobTracker();
		const runtime = createExtensionRuntime({ registry: createRegistry([definition]), store, jobs, adapters });
		const resumed = await runtime.resumeFailedRun(source.id);
		assert.equal(resumed.ok, true, resumed.ok ? undefined : resumed.message);
		if (!resumed.ok) return;
		await jobs.get(resumed.runId)?.promise;
		const continuation = store.runs().find((candidate) => candidate.id === resumed.runId);
		assert.ok(continuation);
		assert.equal(continuation.status, "completed", continuation.error);
		assert.deepEqual(continuation.result, { result: "pull-request done" });
		assert.deepEqual(executions, ["pull-request"], "only the failed downstream task may re-execute");

		const byName = new Map(continuation.stages.map((stage) => [stage.name, stage]));
		const reviewerIds = ["completion-reviewer", "evidence-reviewer", "risk-reviewer"].map(
			(name) => byName.get(name)?.id,
		);
		assert.deepEqual([...(byName.get("pull-request")?.parentIds ?? [])].sort(), [...reviewerIds].sort());
	});

	test("a Goal whose pull-request stage failed after reviewer approval resumes by replaying its turns (#3207)", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const sessions: string[] = [];
		let failPullRequest = true;
		const definition = workflow({
			name: "goal-pull-request-resume",
			description: "",
			inputs: {
				objective: Type.String(),
				max_turns: Type.Number({ default: 1 }),
				base_branch: Type.String({ default: "origin/main" }),
				git_worktree_dir: Type.String({ default: "" }),
				create_pr: Type.Boolean({ default: true }),
			},
			outputs: { status: Type.Optional(Type.String()), pr_report: Type.Optional(Type.String()) },
			run: async (ctx) => {
				const outputs = await runGoalWorkflow(
					{
						inputs: ctx.inputs,
						runId: ctx.runId,
						tool: ctx.tool,
						task: (name, options) => ctx.task(name, withoutAutoModel(options)),
						parallel: (steps, options) => ctx.parallel(steps.map(withoutAutoModel), options),
					},
					{ createPr: true, workflowStartCwd: process.cwd() },
				);
				return { status: outputs.status, pr_report: outputs.pr_report };
			},
		});
		const adapters = {
			agentSession: {
				async create(options: CreateAgentSessionOptions): Promise<StageSessionRuntime> {
					if (options.customTools?.some((tool) => tool.name === "structured_output")) {
						sessions.push("reviewer");
						return structuredOutputMockSession(options, approvingReview);
					}
					const session = mockSession();
					return {
						...session,
						async prompt(text: string) {
							const stage = text.includes("You are the sub-agent orchestrator")
								? "orchestrator"
								: "pull-request";
							sessions.push(stage);
							if (stage === "pull-request" && failPullRequest) throw new Error("HTTP 429 quota exceeded");
							appendProseTurn(session.messages);
						},
						getLastAssistantText: () => "prose answer without the tool",
					};
				},
			},
		};
		const inputs = {
			objective: "fix the defect",
			max_turns: 1,
			base_branch: "origin/main",
			git_worktree_dir: "",
			create_pr: true,
		};
		const store = createStore();
		const first = await run(definition, inputs, { store, durableBackend: backend, adapters });
		assert.equal(first.status, "running", first.error);
		assert.deepEqual(sessions, ["orchestrator", "reviewer", "reviewer", "reviewer", "pull-request"]);
		const source = store.runs().find((candidate) => candidate.id === first.runId);
		assert.ok(source);
		assert.equal(source.failureRecoverability, "recoverable");
		assert.equal(source.resumable, true);
		assert.equal(source.stages.find((stage) => stage.id === source.failedStageId)?.name, "pull-request");
		backend.registerWorkflow({
			workflowId: source.id,
			name: definition.name,
			inputs,
			createdAt: 1,
			status: "blocked",
			resumable: true,
		});

		failPullRequest = false;
		sessions.length = 0;
		const jobs = createJobTracker();
		const runtime = createExtensionRuntime({
			registry: createRegistry([definition as unknown as WorkflowDefinition]),
			store,
			jobs,
			adapters,
		});
		const resumed = await runtime.resumeFailedRun(source.id);
		assert.equal(resumed.ok, true, resumed.ok ? undefined : resumed.message);
		if (!resumed.ok) return;
		await jobs.get(resumed.runId)?.promise;
		const continuation = store.runs().find((candidate) => candidate.id === resumed.runId);
		assert.ok(continuation);
		assert.equal(continuation.status, "completed", continuation.error);
		assert.equal(continuation.result?.status, "complete");
		assert.deepEqual(sessions, ["pull-request"], "completed turn stages must replay from checkpoints");

		const byName = new Map(continuation.stages.map((stage) => [stage.name, stage]));
		const reviewerIds = ["completion-reviewer-1", "evidence-reviewer-1", "risk-reviewer-1"].map(
			(name) => byName.get(name)?.id,
		);
		assert.equal(reviewerIds.includes(undefined), false);
		assert.deepEqual([...(byName.get("pull-request")?.parentIds ?? [])].sort(), [...reviewerIds].sort());

		// Replaying the completed run again reuses every checkpoint, including the pull-request.
		sessions.length = 0;
		const replayed = await run(definition, inputs, {
			runId: source.id,
			store: createStore(),
			durableBackend: backend,
			adapters,
		});
		assert.equal(replayed.status, "completed", replayed.error);
		assert.deepEqual(sessions, []);
	});
});
