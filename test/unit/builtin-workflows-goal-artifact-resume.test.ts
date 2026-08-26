import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { test } from "vitest";
import { createGoalLedger, writeGoalLedger } from "../../packages/workflows/builtin/goal-ledger.js";
import { consecutiveBlockerTurns, reduceGoalDecision } from "../../packages/workflows/builtin/goal-reducer.js";
import { createGoalArtifactDirectory, runGoalWorkflow } from "../../packages/workflows/builtin/goal-runner.js";
import type { GoalLedger, ReviewRecord } from "../../packages/workflows/builtin/goal-types.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import {
	createCheckpointIdGenerator,
	createToolPrimitive,
} from "../../packages/workflows/src/durable/tool-primitive.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { taskReadInstruction } from "../../packages/workflows/src/runs/foreground/executor-task-prompts.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { ENV_WORKFLOW_ARTIFACT_DIR } from "../../packages/workflows/src/shared/workflow-artifacts.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

const posix = (value: string): string => value.replaceAll("\\", "/");

function blockingReview(turn: number): ReviewRecord {
	return {
		findings: [],
		overall_correctness: "patch is incorrect",
		overall_explanation: "blocked",
		overall_confidence_score: 0.9,
		goal_oracle_satisfied: false,
		requirements_traceability: [],
		receipt_assessment: "receipt inspected",
		verification_remaining: "blocked",
		stop_review_loop: false,
		reviewer_error: null,
		decision: "continue",
		evidence: [],
		gaps: [],
		blocker: "X",
		confidence_score: 0.9,
		explanation: "blocked",
		turn,
		reviewer: "completion-reviewer",
		artifact_path: "/tmp/review.json",
		parsed: true,
		approved: false,
		parse_diagnostics: [],
		convergence_decision: {
			parsed: true,
			approved: false,
			stopReviewLoop: false,
			nextAction: "implementation",
			finalActionRemaining: false,
			diagnostics: [],
		},
	};
}

test("a fresh-id workflow continuation reads a replayed producer artifact without rerunning the producer", async () => {
	const root = await mkdtemp(join(tmpdir(), "goal-artifact-workflow-resume-"));
	const previousRoot = process.env[ENV_WORKFLOW_ARTIFACT_DIR];
	process.env[ENV_WORKFLOW_ARTIFACT_DIR] = root;
	const backend = new InMemoryDurableBackend();
	let producerRuns = 0;
	let consumerRuns = 0;
	let receiptPath: string | undefined;
	const definition = workflow({
		name: "goal-artifact-resume-regression",
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		run: async (ctx) => {
			const artifactDir = await createGoalArtifactDirectory(ctx);
			receiptPath = join(artifactDir, "orchestrator-receipt.md");
			await ctx.task("artifact-producer", {
				prompt: "produce durable receipt",
				output: receiptPath,
				outputMode: "file-only",
			});
			const consumer = await ctx.task("artifact-consumer", {
				prompt: "review durable receipt",
				reads: [receiptPath],
			});
			return { result: consumer.text };
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
							if (text.includes("produce durable receipt")) {
								producerRuns += 1;
								assert.ok(receiptPath);
								await writeFile(receiptPath, "durable receipt", "utf8");
								return "durable receipt";
							}
							consumerRuns += 1;
							throw new Error("source consumer interrupted");
						},
					},
				},
			},
		);
		assert.equal(sourceResult.status, "failed");
		const source = sourceStore.runs().find((candidate) => candidate.id === sourceResult.runId);
		assert.ok(source);
		const sourceReceiptPath = receiptPath;
		assert.ok(sourceReceiptPath);
		assert.equal(await readFile(sourceReceiptPath, "utf8"), "durable receipt");

		const continuationResult = await run(
			definition,
			{},
			{
				store: createStore(),
				durableBackend: backend,
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters: {
					prompt: {
						prompt: async (text) => {
							if (text.includes("produce durable receipt")) producerRuns += 1;
							else consumerRuns += 1;
							return text;
						},
					},
				},
			},
		);

		assert.equal(continuationResult.status, "completed", continuationResult.error);
		assert.notEqual(continuationResult.runId, sourceResult.runId);
		assert.equal(receiptPath, sourceReceiptPath);
		assert.equal(producerRuns, 1);
		assert.equal(consumerRuns, 2);
		assert.equal(continuationResult.stages.find((stage) => stage.name === "artifact-producer")?.replayed, true);
		assert.match(continuationResult.result?.result ?? "", /review durable receipt/);
	} finally {
		if (previousRoot === undefined) delete process.env[ENV_WORKFLOW_ARTIFACT_DIR];
		else process.env[ENV_WORKFLOW_ARTIFACT_DIR] = previousRoot;
		await rm(root, { recursive: true, force: true });
	}
});

test("a fresh-id continuation replays the complete Goal artifact root and reads the source artifact", async () => {
	const root = await mkdtemp(join(tmpdir(), "goal-artifact-resume-"));
	const previousRoot = process.env[ENV_WORKFLOW_ARTIFACT_DIR];
	process.env[ENV_WORKFLOW_ARTIFACT_DIR] = root;
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({ workflowId: "source-run", name: "goal", inputs: {}, createdAt: 1, status: "failed" });
	backend.registerWorkflow({
		workflowId: "continuation-run",
		name: "goal",
		inputs: {},
		createdAt: 2,
		status: "running",
	});
	try {
		const sourceTool = createToolPrimitive({
			workflowId: "source-run",
			backend,
			nextCheckpointId: createCheckpointIdGenerator(),
			throwIfCancelled: () => {},
		});
		const sourceArtifactDir = await createGoalArtifactDirectory({ runId: "source-run", tool: sourceTool });
		const restartedSourceTool = createToolPrimitive({
			workflowId: "source-run",
			backend,
			nextCheckpointId: createCheckpointIdGenerator(),
			throwIfCancelled: () => {},
		});
		const replayedInSource = await createGoalArtifactDirectory({ runId: "source-run", tool: restartedSourceTool });
		assert.equal(replayedInSource, sourceArtifactDir, "a restarted run must replay the random artifact segment");
		assert.match(posix(sourceArtifactDir), /\/runs\/source-run\/artifact-[^/]+$/);

		const stageArtifact = join(sourceArtifactDir, "orchestrator-receipt.md");
		await writeFile(stageArtifact, "durable receipt", "utf8");

		const continuationTool = createToolPrimitive({
			workflowId: "continuation-run",
			checkpointSourceWorkflowId: "source-run",
			backend,
			nextCheckpointId: createCheckpointIdGenerator(),
			throwIfCancelled: () => {},
		});
		const continuationArtifactDir = await createGoalArtifactDirectory({
			runId: "continuation-run",
			tool: continuationTool,
		});
		assert.equal(continuationArtifactDir, sourceArtifactDir);
		assert.equal(
			taskReadInstruction({ prompt: "review", reads: [stageArtifact] }),
			`[Read from: ${stageArtifact}]\n\n`,
		);
		assert.equal(await readFile(stageArtifact, "utf8"), "durable receipt");
	} finally {
		if (previousRoot === undefined) delete process.env[ENV_WORKFLOW_ARTIFACT_DIR];
		else process.env[ENV_WORKFLOW_ARTIFACT_DIR] = previousRoot;
		await rm(root, { recursive: true, force: true });
	}
});

test("a replayed Goal turn preserves its ledger without duplicating receipts or reviews", async () => {
	const root = await mkdtemp(join(tmpdir(), "goal-ledger-replay-"));
	const artifactDir = join(root, "runs", "source-run", "artifact-fixed");
	await mkdir(artifactDir, { recursive: true });
	const reviewerDecision = {
		findings: [],
		overall_correctness: "patch is correct" as const,
		overall_explanation: "all focused checks pass",
		overall_confidence_score: 0.99,
		goal_oracle_satisfied: true,
		requirements_traceability: [{ requirement: "preserve artifacts", status: "proven" as const, evidence: "test" }],
		receipt_assessment: "receipt verified",
		verification_remaining: "none",
		stop_review_loop: true,
		reviewer_error: null,
	};
	const runOnce = async () => {
		const ctx = makeMockCtx(
			{
				objective: "literal objective",
				acceptance_criteria: "literal criteria",
				max_turns: 1,
				base_branch: "origin/main",
				git_worktree_dir: process.cwd(),
				create_pr: false,
			},
			{
				runId: "continuation-run",
				tool: (name) => (name === "artifact-root" ? artifactDir : undefined),
				task: (name) =>
					name.includes("reviewer")
						? { text: JSON.stringify(reviewerDecision), structured: reviewerDecision }
						: "implementation receipt",
			},
		);
		return runGoalWorkflow(ctx, { createPr: false, workflowStartCwd: process.cwd() });
	};
	try {
		await runOnce();
		const first = JSON.parse(await readFile(join(artifactDir, "goal-ledger.json"), "utf8")) as {
			goal_id: string;
			receipts: readonly object[];
			reviews: readonly object[];
		};
		assert.equal(first.receipts.length, 1);
		assert.equal(first.reviews.length, 3);

		await runOnce();
		const replayed = JSON.parse(await readFile(join(artifactDir, "goal-ledger.json"), "utf8")) as typeof first;
		assert.equal(replayed.goal_id, first.goal_id);
		assert.equal(replayed.receipts.length, 1);
		assert.equal(replayed.reviews.length, 3);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("createGoalLedger preserves every existing durable ledger collection", async () => {
	const root = await mkdtemp(join(tmpdir(), "goal-ledger-existing-"));
	const artifactDir = join(root, "runs", "source-run", "artifact-fixed");
	await mkdir(artifactDir, { recursive: true });
	try {
		const created = await createGoalLedger("literal objective", "literal criteria", artifactDir);
		const review = blockingReview(4);
		const seeded: GoalLedger = {
			...created.ledger,
			goal_id: "ORIGINAL-GOAL-ID",
			turns: 4,
			receipts: [{ turn: 2, stage: "orchestrator", artifact_path: "receipt.md", summary: "kept" }],
			reviews: [review],
			blockers: [{ turn: 3, blocker: "kept", reviewers: [review.reviewer] }],
			decisions: [
				{
					...review.convergence_decision,
					turn: 4,
					decision: "continue",
					reason: "kept",
					complete_votes: 0,
					review_quorum: 2,
				},
			],
			lifecycle: [
				...created.ledger.lifecycle,
				{
					turn: 4,
					event: "status_decided",
					status: "active",
					at: "2026-08-26T00:00:00.000Z",
					summary: "kept",
				},
			],
			reverification: [
				{
					finding: {
						finding: {
							title: "[P2] kept",
							body: "kept",
							confidence_score: 0.6,
							objective_alignment: "required_by_objective",
							priority: 2,
							code_location: { absolute_file_path: "/repo/file.ts", line_range: { start: 1, end: 1 } },
						},
						reviewers: [review.reviewer],
						blocking: true,
					},
					verdict: "confirmed",
					meanScore: 8,
					perRepeat: [8, 8, 8],
					evidence: ["kept"],
				},
			],
			convergence: [
				{
					unresolvedBlockingCount: 1,
					meanFindingConfidence: 0.6,
					fractionProven: 0.5,
					demotions: 0,
					usage: {
						calls: 1,
						input: 2,
						output: 3,
						cacheRead: 4,
						cacheWrite: 5,
						cost: 0.01,
						turns: 1,
						cacheHitRate: 0.5,
					},
				},
			],
		};
		await writeGoalLedger(created.ledgerPath, seeded);

		const resumed = await createGoalLedger("replacement objective", "replacement criteria", artifactDir);
		assert.equal(resumed.ledger.goal_id, "ORIGINAL-GOAL-ID");
		assert.equal(resumed.ledger.objective, "literal objective");
		assert.deepEqual(resumed.ledger.receipts, seeded.receipts);
		assert.deepEqual(resumed.ledger.reviews, seeded.reviews);
		assert.deepEqual(resumed.ledger.blockers, seeded.blockers);
		assert.deepEqual(resumed.ledger.decisions, seeded.decisions);
		assert.deepEqual(resumed.ledger.lifecycle, seeded.lifecycle);
		assert.deepEqual(resumed.ledger.reverification, seeded.reverification);
		assert.deepEqual(resumed.ledger.convergence, seeded.convergence);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Goal ledger reload preserves non-consecutive blocker turns without an early blocked decision", async () => {
	const root = await mkdtemp(join(tmpdir(), "goal-ledger-blocker-turns-"));
	try {
		const created = await createGoalLedger("literal objective", "literal criteria", root);
		created.ledger.turns = 5;
		created.ledger.blockers.push(
			{ turn: 2, blocker: "X", reviewers: ["completion-reviewer"] },
			{ turn: 5, blocker: "X", reviewers: ["completion-reviewer"] },
		);
		await writeGoalLedger(created.ledgerPath, created.ledger);

		const resumed = await createGoalLedger("replacement objective", "replacement criteria", root);
		assert.equal(resumed.ledger.goal_id, created.ledger.goal_id);
		assert.deepEqual(
			resumed.ledger.blockers.map((blocker) => blocker.turn),
			[2, 5],
		);
		assert.equal(
			consecutiveBlockerTurns(
				[...resumed.ledger.blockers, { turn: 2, blocker: "X", reviewers: ["completion-reviewer"] }],
				"X",
				2,
			),
			1,
		);
		const outcome = reduceGoalDecision(resumed.ledger, [blockingReview(2)], {
			turn: 2,
			maxTurns: 5,
			reviewQuorum: 2,
			blockerThreshold: 3,
			nextActionOnComplete: "finish",
		});
		assert.equal(outcome.status, "active");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Goal ledger write and reload preserves every non-dense turn exactly", async () => {
	const root = await mkdtemp(join(tmpdir(), "goal-ledger-round-trip-"));
	try {
		const created = await createGoalLedger("literal objective", "literal criteria", root);
		const review = blockingReview(7);
		created.ledger.turns = 11;
		created.ledger.receipts.push({ turn: 3, stage: "orchestrator", artifact_path: "receipt.md", summary: "kept" });
		created.ledger.reviews.push(review);
		created.ledger.blockers.push({ turn: 5, blocker: "X", reviewers: [review.reviewer] });
		created.ledger.decisions.push({
			...review.convergence_decision,
			turn: 9,
			decision: "continue",
			reason: "kept",
			complete_votes: 0,
			review_quorum: 2,
		});
		created.ledger.lifecycle.push({
			turn: 11,
			event: "status_decided",
			status: "active",
			at: "2026-08-26T00:00:00.000Z",
			summary: "kept",
		});
		await writeGoalLedger(created.ledgerPath, created.ledger);

		const resumed = await createGoalLedger("replacement objective", "replacement criteria", root);
		assert.equal(resumed.ledger.turns, 11);
		assert.deepEqual(
			resumed.ledger.receipts.map((value) => value.turn),
			[3],
		);
		assert.deepEqual(
			resumed.ledger.reviews.map((value) => value.turn),
			[7],
		);
		assert.deepEqual(
			resumed.ledger.blockers.map((value) => value.turn),
			[5],
		);
		assert.deepEqual(
			resumed.ledger.decisions.map((value) => value.turn),
			[9],
		);
		assert.deepEqual(
			resumed.ledger.lifecycle.map((value) => value.turn),
			[0, 11],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a legacy model-visible ledger without authoritative state starts a fresh ledger", async () => {
	const root = await mkdtemp(join(tmpdir(), "goal-ledger-legacy-"));
	try {
		const ledgerPath = join(root, "goal-ledger.json");
		await writeFile(
			ledgerPath,
			`${JSON.stringify(
				{
					goal_id: "LEGACY",
					objective: "legacy",
					acceptance_criteria: "legacy",
					status: "active",
					created_at: "legacy",
					updated_at: "legacy",
					receipts: [{ stage: "orchestrator", artifact_path: "receipt.md", summary: "legacy" }],
					reviews: [],
					blockers: [{ blocker: "X", reviewers: ["completion-reviewer"] }],
					decisions: [],
					lifecycle: [],
					reverification: [],
					convergence: [],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const created = await createGoalLedger("fresh objective", "fresh criteria", root);
		assert.notEqual(created.ledger.goal_id, "LEGACY");
		assert.equal(created.ledger.objective, "fresh objective");
		assert.deepEqual(created.ledger.receipts, []);
		assert.deepEqual(created.ledger.blockers, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("Goal ledger contents and artifact paths stay inside the supplied fresh-run directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "goal-ledger-directory-"));
	try {
		const artifactDir = join(root, "runs", "fresh-run", "artifact-fixed");
		await mkdir(artifactDir, { recursive: true });
		const { ledger, ledgerPath } = await createGoalLedger("literal objective", "literal criteria", artifactDir);
		assert.equal(ledgerPath, join(artifactDir, "goal-ledger.json"));
		assert.equal(ledger.objective, "literal objective");
		assert.equal(ledger.acceptance_criteria, "literal criteria");
		assert.deepEqual(ledger.receipts, []);
		const visibleContents = await readFile(ledgerPath, "utf8");
		const stored = JSON.parse(visibleContents) as {
			objective: string;
			acceptance_criteria: string;
			turns?: never;
		};
		assert.equal(stored.objective, "literal objective");
		assert.equal(stored.acceptance_criteria, "literal criteria");
		assert.equal("turns" in stored, false);
		assert.doesNotMatch(visibleContents, /"turn":/u);
		assert.equal(
			visibleContents,
			`${JSON.stringify(
				{
					goal_id: ledger.goal_id,
					objective: ledger.objective,
					acceptance_criteria: ledger.acceptance_criteria,
					status: ledger.status,
					created_at: ledger.created_at,
					updated_at: ledger.updated_at,
					receipts: [],
					reviews: [],
					blockers: [],
					decisions: [],
					lifecycle: ledger.lifecycle.map(({ turn: _turn, ...event }) => event),
					reverification: [],
					convergence: [],
				},
				null,
				2,
			)}\n`,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("an interrupted authoritative ledger write cannot strand a continuation", async () => {
	const root = await mkdtemp(join(tmpdir(), "goal-ledger-torn-"));
	try {
		const artifactDir = join(root, "artifacts");
		await mkdir(artifactDir, { recursive: true });
		const created = await createGoalLedger("literal objective", "literal criteria", artifactDir);
		created.ledger.turns = 7;
		await writeGoalLedger(created.ledgerPath, created.ledger);

		const statePath = `${created.ledgerPath.replace(/\.json$/u, "")}-state.json`;
		const authoritative = await readFile(statePath, "utf8");
		assert.equal((JSON.parse(authoritative) as GoalLedger).turns, 7);

		// The publish path renames a fully written file into place, so a partial
		// authoritative file can only predate that guarantee. It must degrade to a
		// fresh ledger rather than aborting the continuation in JSON.parse.
		await writeFile(statePath, authoritative.slice(0, 31), { encoding: "utf8" });
		const continued = await createGoalLedger("literal objective", "literal criteria", artifactDir);
		assert.equal(continued.ledger.turns, 0);
		assert.equal(continued.ledger.objective, "literal objective");

		// Writing again republishes a complete, parseable authoritative file.
		continued.ledger.turns = 2;
		await writeGoalLedger(continued.ledgerPath, continued.ledger);
		assert.equal((JSON.parse(await readFile(statePath, "utf8")) as GoalLedger).turns, 2);

		// No temporary publish files are left behind in the artifact directory.
		const leftovers = (await readdir(artifactDir)).filter((entry) => entry.endsWith(".tmp"));
		assert.deepEqual(leftovers, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
