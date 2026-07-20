import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import type { WorkflowRunContext, WorkflowSerializableValue } from "../src/shared/types.js";
import { renderReducerPrompt, renderRepairPrompt, renderVerifierPrompt, renderWorkerPrompt } from "./adversarial-verification-prompts.js";

const verifierSchema = Type.Object({
  verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
  evidence: Type.Array(Type.String()),
  blocking_findings: Type.Array(Type.String()),
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
};

function structured<T extends WorkflowSerializableValue>(value: WorkflowSerializableValue | undefined, guard: (candidate: WorkflowSerializableValue) => candidate is T): T | undefined {
  return value !== undefined && guard(value) ? value : undefined;
}
function isRecord(value: WorkflowSerializableValue): value is Record<string, WorkflowSerializableValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isVerifier(value: WorkflowSerializableValue): value is VerifierDecision {
  return isRecord(value) && (value.verdict === "pass" || value.verdict === "fail") && Array.isArray(value.evidence) && value.evidence.every((item) => typeof item === "string") && Array.isArray(value.blocking_findings) && value.blocking_findings.every((item) => typeof item === "string");
}
function isReducer(value: WorkflowSerializableValue): value is ReducerDecision {
  return isRecord(value) && (value.decision === "accept" || value.decision === "reject" || value.decision === "repair") && typeof value.rationale === "string" && Array.isArray(value.remaining_work) && value.remaining_work.every((item) => typeof item === "string");
}

export async function runAdversarialVerification(ctx: WorkflowRunContext<Inputs>): Promise<AdversarialVerificationResult> {
  const root = join(ctx.cwd ?? process.cwd(), ".atomic", "workflows", "runs", `adversarial-verification-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(root, { recursive: true });
  const rubricPath = join(root, "rubric.md");
  const candidatePath = join(root, "candidate.md");
  await writeFile(rubricPath, ["# Verification rubric", "- The candidate satisfies the literal task.", "- Important claims cite observable evidence.", "- Relevant validation is executed and reported.", "- No blocking correctness, safety, or completeness gap remains."].join("\n"));
  await ctx.task("worker", { prompt: renderWorkerPrompt(ctx.inputs.task), context: "fresh", output: candidatePath, outputMode: "file-only" });

  let repairsCompleted = 0;
  let reviewReportPath = join(root, "review-0.json");
  let verifierArtifactPaths: string[] = [];
  let decision: ReducerDecision = { decision: "reject", rationale: "No valid reducer decision was produced.", remaining_work: ["Reducer did not return a valid structured decision."] };
  for (;;) {
    verifierArtifactPaths = Array.from({ length: ctx.inputs.verifier_count }, (_, index) => join(root, `verification-${repairsCompleted}-${index + 1}.json`));
    const reports = await ctx.parallel(verifierArtifactPaths.map((path, index) => ({
      name: `verifier-${repairsCompleted}-${index + 1}`,
      prompt: renderVerifierPrompt(ctx.inputs.task, candidatePath, rubricPath),
      context: "fresh" as const,
      reads: [candidatePath, rubricPath],
      schema: verifierSchema,
      output: path,
      outputMode: "file-only" as const,
    })), { concurrency: Math.min(ctx.inputs.verifier_count, 4), failFast: false });
    const validReports = reports.map((report) => structured(report.structured, isVerifier)).filter((report): report is VerifierDecision => report !== undefined);
    const allVerifiersPassed = validReports.length === ctx.inputs.verifier_count && validReports.every((report) => report.verdict === "pass");
    await writeFile(join(root, `verification-summary-${repairsCompleted}.json`), JSON.stringify(validReports, null, 2));
    reviewReportPath = join(root, `review-${repairsCompleted}.json`);
    const reduced = await ctx.task(`reducer-${repairsCompleted}`, {
      prompt: renderReducerPrompt(ctx.inputs.task, candidatePath, verifierArtifactPaths, repairsCompleted, ctx.inputs.max_repairs),
      context: "fresh", reads: [candidatePath, rubricPath, ...verifierArtifactPaths], schema: reducerSchema,
      output: reviewReportPath, outputMode: "file-only",
    });
    decision = structured(reduced.structured, isReducer) ?? decision;
    if (decision.decision === "accept" && !allVerifiersPassed) {
      const remaining = validReports.flatMap((report) => report.blocking_findings);
      decision = repairsCompleted < ctx.inputs.max_repairs
        ? { decision: "repair", rationale: "Independent verification did not unanimously pass.", remaining_work: remaining }
        : { decision: "reject", rationale: "Independent verification did not pass before the repair bound was exhausted.", remaining_work: remaining };
    }
    if (decision.decision === "repair" && repairsCompleted >= ctx.inputs.max_repairs) {
      decision = { ...decision, decision: "reject", rationale: `${decision.rationale} Repair bound exhausted.` };
    }
    if (decision.decision !== "repair") break;
    repairsCompleted += 1;
    await ctx.task(`repair-${repairsCompleted}`, { prompt: renderRepairPrompt(ctx.inputs.task, candidatePath, reviewReportPath), context: "fresh", reads: [candidatePath, reviewReportPath], output: candidatePath, outputMode: "file-only" });
  }
  const approved = decision.decision === "accept";
  return { result: decision.rationale, approved, repairs_completed: repairsCompleted, candidate_path: candidatePath, review_report_path: reviewReportPath, verifier_artifact_paths: verifierArtifactPaths, artifact_dir: root, remaining_work: approved ? [] : decision.remaining_work };
}
