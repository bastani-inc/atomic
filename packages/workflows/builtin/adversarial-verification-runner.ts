import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import type { WorkflowRunContext, WorkflowSerializableValue } from "../src/shared/types.js";
import { renderReducerPrompt, renderRepairPrompt, renderVerifierPrompt, renderWorkerPrompt } from "./adversarial-verification-prompts.js";
import { stableArtifactRoot } from "./pattern-artifact-root.js";
import { aggregateVerification, type VerificationReport } from "./verification-aggregate.js";

/** Extra verifier rounds allowed when a round fails the parse quorum. */
const MAX_INDETERMINATE_RETRIES = 1;

const verifierSchema = Type.Object({
  verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
  evidence: Type.Array(Type.String()),
  blocking_findings: Type.Array(Type.String()),
  veto_findings: Type.Array(Type.String()),
}, { additionalProperties: false });
const reducerSchema = Type.Object({
  decision: Type.Union([Type.Literal("accept"), Type.Literal("reject"), Type.Literal("repair")]),
  rationale: Type.String(),
  remaining_work: Type.Array(Type.String()),
}, { additionalProperties: false });

type VerifierDecision = Static<typeof verifierSchema>;
type ReducerDecision = Static<typeof reducerSchema>;
type Inputs = { readonly task: string; readonly verifier_count: number; readonly max_repairs: number } & Record<string, WorkflowSerializableValue>;
export type AdversarialVerificationResult = {
  readonly result: string;
  readonly approved: boolean;
  readonly repairs_completed: number;
  readonly candidate_path: string;
  readonly review_report_path: string;
  readonly verifier_artifact_paths: string[];
  readonly artifact_dir: string;
  readonly remaining_work: string[];
  readonly verification_score: number;
};

function structured<T extends WorkflowSerializableValue>(value: WorkflowSerializableValue | undefined, guard: (candidate: WorkflowSerializableValue) => candidate is T): T | undefined {
  return value !== undefined && guard(value) ? value : undefined;
}
function isRecord(value: WorkflowSerializableValue): value is Record<string, WorkflowSerializableValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isVerifier(value: WorkflowSerializableValue): value is VerifierDecision {
  return isRecord(value) && (value.verdict === "pass" || value.verdict === "fail") && Array.isArray(value.evidence) && value.evidence.every((item) => typeof item === "string") && Array.isArray(value.blocking_findings) && value.blocking_findings.every((item) => typeof item === "string") && Array.isArray(value.veto_findings) && value.veto_findings.every((item) => typeof item === "string");
}
function toVerificationReport(report: VerifierDecision): VerificationReport {
  // One criterion until the rubric is split into independent criteria; the
  // binary verdict is the normalized score this aggregation averages.
  return { criterion: "rubric", score: report.verdict === "pass" ? 1 : 0, blocking_findings: report.blocking_findings, veto_findings: report.veto_findings };
}
function isReducer(value: WorkflowSerializableValue): value is ReducerDecision {
  return isRecord(value) && (value.decision === "accept" || value.decision === "reject" || value.decision === "repair") && typeof value.rationale === "string" && Array.isArray(value.remaining_work) && value.remaining_work.every((item) => typeof item === "string");
}

export async function runAdversarialVerification(ctx: WorkflowRunContext<Inputs>): Promise<AdversarialVerificationResult> {
  const root = await stableArtifactRoot(ctx, "adversarial-verification");
  const rubricPath = join(root, "rubric.md");
  const candidatePath = join(root, "candidate.md");
  await writeFile(rubricPath, ["# Verification rubric", "- The candidate satisfies the literal task.", "- Important claims cite observable evidence.", "- Relevant validation is executed and reported with commands run and observed output.", "- File findings cite file:line evidence where applicable.", "- No blocking correctness, safety, or completeness gap remains."].join("\n"));
  await ctx.task("worker", { prompt: renderWorkerPrompt(ctx.inputs.task), context: "fresh", output: candidatePath, outputMode: "file-only" });

  let repairsCompleted = 0;
  let attempt = 0;
  let verificationScore = 0;
  let reviewReportPath!: string;
  let verifierArtifactPaths: string[] = [];
  let decision: ReducerDecision = { decision: "reject", rationale: "No valid reducer decision was produced.", remaining_work: ["Reducer did not return a valid structured decision."] };
  for (;;) {
    verifierArtifactPaths = Array.from({ length: ctx.inputs.verifier_count }, (_, index) => join(root, `verification-${repairsCompleted}-${attempt}-${index + 1}.json`));
    const reports = await ctx.parallel(verifierArtifactPaths.map((path, index) => ({
      name: `verifier-${repairsCompleted}-${attempt}-${index + 1}`,
      prompt: renderVerifierPrompt(ctx.inputs.task, candidatePath, rubricPath),
      context: "fresh" as const,
      reads: [candidatePath, rubricPath],
      schema: verifierSchema,
      output: path,
      outputMode: "file-only" as const,
    })), { concurrency: Math.min(ctx.inputs.verifier_count, 4), failFast: false });
    const validReports = reports.map((report) => structured(report.structured, isVerifier)).filter((report): report is VerifierDecision => report !== undefined);
    const outcome = aggregateVerification(validReports.map(toVerificationReport), verifierArtifactPaths.length);
    await writeFile(join(root, `verification-summary-${repairsCompleted}-${attempt}.json`), JSON.stringify(validReports, null, 2));
    if (outcome.outcome === "indeterminate") {
      // Too few reports parsed to decide anything. Retry the round under fresh
      // node and artifact names — the topology must stay acyclic — and never
      // charge a repair for what is a verification-harness failure.
      if (attempt < MAX_INDETERMINATE_RETRIES) {
        attempt += 1;
        continue;
      }
      verificationScore = 0;
      reviewReportPath = join(root, `review-${repairsCompleted}.json`);
      decision = {
        decision: "reject",
        rationale: `Verification could not be completed: only ${outcome.parsed} of ${outcome.expected} verifier reports parsed after ${MAX_INDETERMINATE_RETRIES + 1} attempts, below the parse quorum. This is a verification infrastructure failure, not a judgment about candidate quality.`,
        remaining_work: ["Independent verification produced no usable quorum of parseable verifier reports."],
      };
      await writeFile(reviewReportPath, JSON.stringify(decision, null, 2));
      break;
    }
    verificationScore = outcome.score;
    reviewReportPath = join(root, `review-${repairsCompleted}.json`);
    const reduced = await ctx.task(`reducer-${repairsCompleted}`, {
      prompt: renderReducerPrompt(ctx.inputs.task, candidatePath, verifierArtifactPaths, repairsCompleted, ctx.inputs.max_repairs),
      context: "fresh", reads: [candidatePath, rubricPath, ...verifierArtifactPaths], schema: reducerSchema,
      output: reviewReportPath, outputMode: "file-only",
    });
    decision = structured(reduced.structured, isReducer) ?? decision;
    if (decision.decision === "accept" && outcome.outcome !== "pass") {
      const remaining = [...outcome.blocking_findings];
      const rationale = outcome.reason === "veto"
        ? "Independent verification recorded an unconditional veto finding."
        : outcome.reason === "criterion_floor"
          ? `Independent verification failed a per-criterion floor at score ${outcome.score}.`
          : `Independent verification scored ${outcome.score}, below the pass threshold.`;
      decision = repairsCompleted < ctx.inputs.max_repairs
        ? { decision: "repair", rationale, remaining_work: remaining }
        : { decision: "reject", rationale: `${rationale} Repair bound exhausted.`, remaining_work: remaining };
    }
    if (decision.decision === "repair" && repairsCompleted >= ctx.inputs.max_repairs) {
      decision = { ...decision, decision: "reject", rationale: `${decision.rationale} Repair bound exhausted.` };
    }
    if (decision.decision !== "repair") break;
    repairsCompleted += 1;
    attempt = 0;
    await ctx.task(`repair-${repairsCompleted}`, { prompt: renderRepairPrompt(ctx.inputs.task, candidatePath, reviewReportPath), context: "fresh", reads: [candidatePath, reviewReportPath], output: candidatePath, outputMode: "file-only" });
  }
  const approved = decision.decision === "accept";
  return { result: decision.rationale, approved, repairs_completed: repairsCompleted, candidate_path: candidatePath, review_report_path: reviewReportPath, verifier_artifact_paths: verifierArtifactPaths, artifact_dir: root, remaining_work: approved ? [] : decision.remaining_work, verification_score: verificationScore };
}
