import { join } from "node:path";
import type { WorkflowTaskResult } from "../src/shared/types.js";
import { reviewDecisionSchema } from "./goal-schemas.js";
import {
  DEFAULT_BLOCKER_THRESHOLD,
  DEFAULT_MAX_TURNS,
  DEFAULT_REVIEW_QUORUM,
  type GoalWorkflowOutputs,
  type ReviewRecord,
} from "./goal-types.js";
import { writeReviewArtifact, writeReviewRoundArtifact } from "./goal-artifacts.js";
import { appendLifecycleEvent, createGoalLedger, writeGoalLedger } from "./goal-ledger.js";
import {
  collectRemainingWork,
  reduceGoalDecision,
} from "./goal-reducer.js";
import { formatReviewReport, renderFinalReport } from "./goal-reports.js";
import {
  reviewDecisionFromResult,
  reviewerErrorDecision,
  reviewDecisionToRecord,
} from "./goal-review.js";
import {
  WORKER_PREFLIGHT_CONTRACT,
  WORKER_RECEIPT_CONTRACT,
  goalRunnerTools,
  renderForkedGoalWorkerPrompt,
  renderGoalContinuationPrompt,
  renderReviewerPrompt,
} from "./goal-prompts.js";

function positiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  const floored = Math.floor(value);
  return floored >= 1 ? floored : fallback;
}

type ForkContinuationOptions = {
  readonly context?: "fork";
  readonly forkFromSessionFile?: string;
};

function forkContinuationOptions(
  sessionFile: string | undefined,
): ForkContinuationOptions {
  return sessionFile === undefined || sessionFile.length === 0
    ? {}
    : { context: "fork", forkFromSessionFile: sessionFile };
}

function normalizeBranchInput(
  value: string | undefined,
  fallback: string,
): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;

  const looksLikeSafeGitRef =
    /^(?!-)(?!.*(?:\.\.|@\{|\/\/|\.lock(?:\/|$)))[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(
      trimmed,
    );
  return looksLikeSafeGitRef ? trimmed : fallback;
}
  type GoalRunnerContext = {
  readonly inputs: {
    readonly objective: string;
    readonly max_turns?: number;
    readonly base_branch?: string;
  };
  task(name: string, options: object): Promise<WorkflowTaskResult>;
  parallel(
    steps: readonly object[],
    options: { readonly task: string; readonly failFast: false },
  ): Promise<WorkflowTaskResult[]>;
};

export async function runGoalWorkflow(ctx: unknown): Promise<GoalWorkflowOutputs> {
  const goalContext = ctx as GoalRunnerContext;
    const inputs = goalContext.inputs;
    const objective = inputs.objective.trim();
    if (!objective) {
      throw new Error("goal requires an objective input.");
    }

    const maxTurns = positiveInteger(inputs.max_turns, DEFAULT_MAX_TURNS);
    const reviewQuorum = DEFAULT_REVIEW_QUORUM;
    const blockerThreshold = Math.min(DEFAULT_BLOCKER_THRESHOLD, maxTurns);
    const comparisonBaseBranch = normalizeBranchInput(inputs.base_branch, "origin/main");
    const { ledger, ledgerPath, artifactDir } = await createGoalLedger(objective);

    const workerModelConfig = {
      model: "openai-codex/gpt-5.5:medium",
      fallbackModels: [
          "github-copilot/gpt-5.5:medium",
          "openai/gpt-5.5:medium",
          "github-copilot/claude-opus-4.8 (1m):medium",
          "anthropic/claude-opus-4-8:medium",
      ],
      tools: goalRunnerTools,
    };

    const reviewerModelConfig = {
      model: "anthropic/claude-fable-5:xhigh",
      fallbackModels: [
          "openai-codex/gpt-5.5:xhigh",
          "github-copilot/gpt-5.5:xhigh",
          "openai/gpt-5.5:xhigh",
          "github-copilot/claude-opus-4.8 (1m):xhigh",
          "anthropic/claude-opus-4-8:xhigh"
      ],
      tools: goalRunnerTools,
      schema: reviewDecisionSchema,
    };

    let latestReviews: ReviewRecord[] = [];
    let latestReviewArtifactPaths: string[] = [];
    let latestReviewReportPath: string | undefined;
    let terminalRemainingWork: string | undefined;
    let previousWorkerSessionFile: string | undefined;

    for (let turn = 1; turn <= maxTurns && ledger.status === "active"; turn += 1) {
      appendLifecycleEvent(ledger, "work_turn_started", `Worker turn ${turn} started.`, turn);
      await writeGoalLedger(ledgerPath, ledger);

      const workTurnPath = join(artifactDir, `work-turn-${turn}.md`);
      const workerForkOptions = forkContinuationOptions(previousWorkerSessionFile);
      const workerPrompt = workerForkOptions.forkFromSessionFile === undefined
        ? [
            renderGoalContinuationPrompt(
              ledger,
              ledgerPath,
              turn,
              maxTurns,
              blockerThreshold,
              latestReviewArtifactPaths,
            ),
            "",
            "Project setup guidance:",
            WORKER_PREFLIGHT_CONTRACT,
            "",
            "Guidance:",
            WORKER_RECEIPT_CONTRACT,
            "",
            "Return Markdown with headings: Progress made, Files changed, Commands run, Evidence, Blockers, Ready for review, Remaining work.",
          ].join("\n")
        : renderForkedGoalWorkerPrompt(
            ledger,
            ledgerPath,
            turn,
            maxTurns,
            blockerThreshold,
            latestReviewArtifactPaths,
          );

      let worker: WorkflowTaskResult;
      try {
        worker = await goalContext.task(`work-turn-${turn}`, {
          prompt: workerPrompt,
          reads: [ledgerPath, ...latestReviewArtifactPaths],
          output: workTurnPath,
          outputMode: "file-only",
          ...workerModelConfig,
          ...workerForkOptions,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        terminalRemainingWork = `Worker turn ${turn} failed before producing a receipt: ${message}`;
        latestReviews = [];
        latestReviewArtifactPaths = [];
        latestReviewReportPath = undefined;
        ledger.turns = turn;
        ledger.status = "needs_human";
        ledger.decisions.push({
          turn,
          decision: "needs_human",
          reason: terminalRemainingWork,
          complete_votes: 0,
          review_quorum: reviewQuorum,
        });
        appendLifecycleEvent(ledger, "status_decided", terminalRemainingWork, turn);
        await writeGoalLedger(ledgerPath, ledger);
        break;
      }

      previousWorkerSessionFile = worker.sessionFile;
      ledger.turns = turn;
      ledger.receipts.push({
        turn,
        stage: worker.name ?? worker.stageName,
        artifact_path: workTurnPath,
        summary: `Worker receipt artifact for turn ${turn}: ${workTurnPath}`,
      });
      appendLifecycleEvent(ledger, "receipt_recorded", `Worker turn ${turn} receipt recorded.`, turn);
      await writeGoalLedger(ledgerPath, ledger);

      const reviewerStep = (
        name: string,
        reviewerRole: string,
        focus: string,
      ) => ({
        name,
        task: renderReviewerPrompt({
          reviewerRole,
          focus,
          objective,
          ledgerPath,
          workTurnPath,
          comparisonBaseBranch,
          turn,
          reviewQuorum,
          blockerThreshold,
        }),
        reads: [ledgerPath, workTurnPath],
        ...reviewerModelConfig,
      });

      const reviewerSteps = [
        reviewerStep(
          `completion-reviewer-${turn}`,
          "Completion Reviewer: verify the full objective and every explicit requirement are satisfied by current state.",
          "Map the objective to concrete requirements. Mark complete only if every required deliverable, invariant, command, artifact, and referenced spec item is proven by current evidence.",
        ),
        reviewerStep(
          `evidence-reviewer-${turn}`,
          "Evidence Reviewer: validate receipts, commands, tests, and artifacts rather than trusting summaries.",
          "Inspect whether receipts are current, relevant, and broad enough. Mark continue when validation is missing, stale, indirect, or narrower than the objective.",
        ),
        reviewerStep(
          `risk-reviewer-${turn}`,
          "Risk Reviewer: hunt for hidden gaps, regressions, unresolved blockers, and unsafe completion claims.",
          "Look for untested edge cases, scope shrinkage, repository convention violations, unsafe assumptions, and blockers that are real repeated impasses rather than ordinary remaining work.",
        ),
      ];

      let reviewResults: WorkflowTaskResult[];
      try {
        reviewResults = await goalContext.parallel(reviewerSteps, {
          task: objective,
          failFast: false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const structured = reviewerErrorDecision(message);
        reviewResults = [
          {
            name: `reviewer-error-${turn}`,
            stageName: `reviewer-error-${turn}`,
            text: JSON.stringify(structured, null, 2),
            structured,
          },
        ];
      }

      latestReviews = await Promise.all(reviewResults.map(async (result) => {
        const reviewerName = result.name ?? result.stageName;
        const parsed = reviewDecisionFromResult(result) ??
          reviewerErrorDecision(
            `Reviewer ${reviewerName} returned no structured decision.`,
          );
        const reviewArtifactPath = await writeReviewArtifact(
          artifactDir,
          turn,
          reviewerName,
          parsed,
          result.text,
        );
        return reviewDecisionToRecord({
          turn,
          reviewer: reviewerName,
          artifactPath: reviewArtifactPath,
          decision: parsed,
        });
      }));
      latestReviewArtifactPaths = latestReviews.map((review) => review.artifact_path);
      latestReviewReportPath = await writeReviewRoundArtifact(
        artifactDir,
        turn,
        latestReviews,
      );
      ledger.reviews.push(...latestReviews);
      appendLifecycleEvent(
        ledger,
        "reviews_recorded",
        `Recorded ${latestReviews.length} reviewer decisions for turn ${turn}.`,
        turn,
      );

      const reducerOutcome = reduceGoalDecision(ledger, latestReviews, {
        turn,
        maxTurns,
        reviewQuorum,
        blockerThreshold,
      });
      if (reducerOutcome.blockerObservation !== undefined) {
        ledger.blockers.push(reducerOutcome.blockerObservation);
      }
      ledger.decisions.push(reducerOutcome.decision);
      ledger.status = reducerOutcome.status;
      appendLifecycleEvent(
        ledger,
        "status_decided",
        reducerOutcome.decision.reason,
        turn,
      );
      await writeGoalLedger(ledgerPath, ledger);
    }

    const remainingWork = ledger.status === "complete"
      ? "none"
      : terminalRemainingWork ?? collectRemainingWork(latestReviews);
    const finalReport = renderFinalReport(ledger, ledgerPath, remainingWork);
    const reviewReport = formatReviewReport(latestReviews);

    return {
      result: finalReport,
      status: ledger.status,
      approved: ledger.status === "complete",
      goal_id: ledger.goal_id,
      objective: ledger.objective,
      ledger_path: ledgerPath,
      turns_completed: ledger.turns,
      iterations_completed: ledger.turns,
      receipts: ledger.receipts,
      remaining_work: remainingWork,
      review_report: reviewReport,
      ...(latestReviewReportPath !== undefined ? { review_report_path: latestReviewReportPath } : {}),
    };
}
