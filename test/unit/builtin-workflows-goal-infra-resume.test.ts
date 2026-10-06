import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { test } from "vitest";
import { runGoalWorkflow } from "../../packages/workflows/builtin/goal-runner.js";
import type { GoalLedger, ReviewDecision } from "../../packages/workflows/builtin/goal-types.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { ENV_WORKFLOW_ARTIFACT_DIR } from "../../packages/workflows/src/shared/workflow-artifacts.js";

const completeReview = JSON.stringify({
	findings: [],
	overall_correctness: "patch is correct",
	overall_explanation: "focused checks pass",
	overall_confidence_score: 0.99,
	goal_oracle_satisfied: true,
	requirements_traceability: [{ requirement: "finish", status: "proven", evidence: "focused check" }],
	receipt_assessment: "verified",
	verification_remaining: "none",
	stop_review_loop: true,
	reviewer_error: null,
});

for (const interruptedStage of ["orchestrator-1", "completion-reviewer-1"] as const) {
	test(`Goal resumes an interrupted ${interruptedStage} without a human verdict (#3466)`, async () => {
		const root = await mkdtemp(join(tmpdir(), "goal-infra-resume-"));
		const previousRoot = process.env[ENV_WORKFLOW_ARTIFACT_DIR];
		process.env[ENV_WORKFLOW_ARTIFACT_DIR] = root;
		const backend = new InMemoryDurableBackend();
		const calls: string[] = [];
		let artifactDir = "";
		let receiptPath = "";
		const definition = workflow({
			name: "goal-infra-resume",
			description: "",
			inputs: {},
			outputs: { status: Type.String() },
			run: async (ctx) => {
				const result = await runGoalWorkflow(
					{
						...ctx,
						inputs: {
							objective: "finish",
							max_turns: 1,
							base_branch: "origin/main",
							git_worktree_dir: "",
							create_pr: false,
						},
						tool: async (name, args, fn) => {
							const result = await ctx.tool(name, args, fn);
							if (name === "artifact-root") artifactDir = String(result);
							return result;
						},
						task: (name, options) => {
							if (name.startsWith("orchestrator-")) receiptPath = String(options.output);
							return ctx.task(name, { ...options, model: "test/model", prompt: `STAGE:${name}` });
						},
						parallel: async (steps, options) => {
							const results = await ctx.parallel(
								steps.map((step) => ({
									...step,
									schema: undefined,
									model: "test/model",
									task: `STAGE:${step.name}`,
								})),
								options,
							);
							return results.map((result) => ({
								...result,
								structured: JSON.parse(result.text) as ReviewDecision,
							}));
						},
					},
					{ createPr: false, workflowStartCwd: process.cwd() },
				);
				assert.ok(result.status);
				return { status: result.status };
			},
		});
		try {
			const sourceStore = createStore();
			const sourceResult = await run(
				definition,
				{},
				{
					store: sourceStore,
					durableBackend: backend,
					adapters: {
						prompt: {
							prompt: async (text) => {
								const name = text.match(/STAGE:([^\s]+)/u)?.[1] ?? "";
								calls.push(name);
								if (name === interruptedStage)
									throw new Error("durable checkpoint timeout: database connection lost");
								if (name.startsWith("orchestrator-")) await writeFile(receiptPath, "receipt", "utf8");
								return name.includes("reviewer") ? completeReview : "receipt";
							},
						},
					},
				},
			);
			assert.equal(
				sourceResult.status,
				"failed",
				"stage failures must escape Goal rather than complete as needs_human",
			);
			const interrupted = JSON.parse(
				await readFile(join(artifactDir, "goal-ledger-state.json"), "utf8"),
			) as GoalLedger;
			assert.equal(interrupted.status, "active");
			assert.deepEqual(interrupted.decisions, []);
			assert.deepEqual(interrupted.reviews, []);
			const source = sourceStore.runs().find((candidate) => candidate.id === sourceResult.runId);
			assert.ok(source);
			const resumed = await run(
				definition,
				{},
				{
					store: createStore(),
					durableBackend: backend,
					continuation: { source, resumeFromStageId: source.failedStageId },
					adapters: {
						prompt: {
							prompt: async (text) => {
								const name = text.match(/STAGE:([^\s]+)/u)?.[1] ?? "";
								calls.push(name);
								if (name.startsWith("orchestrator-")) await writeFile(receiptPath, "receipt", "utf8");
								return name.includes("reviewer") ? completeReview : "receipt";
							},
						},
					},
				},
			);
			assert.equal(resumed.status, "completed", resumed.error);
			assert.equal(resumed.result?.status, "complete");
			assert.equal(calls.filter((name) => name === interruptedStage).length, 2);
			if (interruptedStage === "completion-reviewer-1") {
				assert.equal(calls.filter((name) => name === "orchestrator-1").length, 1);
				assert.equal(resumed.stages.find((stage) => stage.name === "orchestrator-1")?.replayed, true);
			}
			const finished = JSON.parse(await readFile(join(artifactDir, "goal-ledger-state.json"), "utf8")) as GoalLedger;
			assert.equal(finished.goal_id, interrupted.goal_id);
			assert.equal(finished.receipts.length, 1);
			assert.equal(finished.reviews.length, 3);
			assert.deepEqual(
				finished.decisions.map((decision) => decision.decision),
				["complete"],
			);
			if (interruptedStage === "completion-reviewer-1") {
				assert.equal(finished.lifecycle.filter((event) => event.event === "work_turn_started").length, 1);
			}
		} finally {
			if (previousRoot === undefined) delete process.env[ENV_WORKFLOW_ARTIFACT_DIR];
			else process.env[ENV_WORKFLOW_ARTIFACT_DIR] = previousRoot;
			await rm(root, { recursive: true, force: true });
		}
	});
}
