import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type {
  WorkflowRunContext,
  WorkflowSerializableObject,
  WorkflowSerializableValue,
  WorkflowTaskResult,
} from "../src/shared/types.js";
import {
  renderCompletionPrompt,
  renderEvaluationPrompt,
  renderIterationPrompt,
} from "./loop-until-done-prompts.js";
import { stableArtifactRoot } from "./pattern-artifact-root.js";

const evaluationSchema = Type.Object({
  done: Type.Boolean(),
  summary: Type.String(),
  new_findings: Type.Array(Type.String()),
  failures: Type.Array(Type.String()),
  validation_evidence: Type.Array(Type.String()),
  remaining_work: Type.String(),
}, { additionalProperties: false });

type LoopInputs = {
  readonly prompt: string;
  readonly max_iterations: number;
} & Record<string, WorkflowSerializableValue>;

type Evaluation = {
  readonly done: boolean;
  readonly summary: string;
  readonly newFindings: readonly string[];
  readonly failures: readonly string[];
  readonly validationEvidence: readonly string[];
  readonly remainingWork: string;
};
type LedgerEntry = {
  readonly iteration: number;
  readonly artifact_path: string;
  readonly evaluation_artifact_path: string;
  readonly summary: string;
  readonly findings: readonly string[];
  readonly failures: readonly string[];
  readonly validation_evidence: readonly string[];
  readonly done: boolean;
  readonly remaining_work: string;
};
function serializableObject(
  value: WorkflowSerializableValue | undefined,
): WorkflowSerializableObject | undefined {
  if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  return value as WorkflowSerializableObject;
}

function stringArray(value: WorkflowSerializableValue | undefined): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function evaluationFrom(result: WorkflowTaskResult): Evaluation {
  const value = serializableObject(result.structured);
  if (value === undefined) {
    throw new Error(`loop-until-done: evaluator ${result.stageName} did not return a structured decision`);
  }
  const done = value.done;
  const summary = value.summary;
  const newFindings = stringArray(value.new_findings);
  const failures = stringArray(value.failures);
  const validationEvidence = stringArray(value.validation_evidence);
  const remainingWork = value.remaining_work;
  if (typeof done !== "boolean" || typeof summary !== "string" ||
      newFindings === undefined || failures === undefined || validationEvidence === undefined ||
      typeof remainingWork !== "string") {
    throw new Error(`loop-until-done: evaluator ${result.stageName} returned an invalid decision`);
  }
  return { done, summary, newFindings, failures, validationEvidence, remainingWork };
}

async function writeLedger(path: string, task: string, maxIterations: number, status: string,
  entries: readonly LedgerEntry[]): Promise<void> {
  await writeFile(path, `${JSON.stringify({
    task,
    max_iterations: maxIterations,
    status,
    iterations_completed: entries.length,
    entries,
  }, null, 2)}\n`);
}

export async function runLoopUntilDone(ctx: WorkflowRunContext<LoopInputs>) {
  const artifactDir = await stableArtifactRoot(ctx, "loop-until-done");
  const iterationsDir = join(artifactDir, "iterations");
  const evaluationsDir = join(artifactDir, "evaluations");
  await mkdir(iterationsDir, { recursive: true });
  await mkdir(evaluationsDir, { recursive: true });
  const ledgerPath = join(artifactDir, "progress-ledger.json");
  const entries: LedgerEntry[] = [];
  const iterationArtifactPaths: string[] = [];
  const evaluationArtifactPaths: string[] = [];
  await writeLedger(ledgerPath, ctx.inputs.prompt, ctx.inputs.max_iterations, "active", entries);

  for (let iteration = 1; iteration <= ctx.inputs.max_iterations; iteration += 1) {
    const iterationPath = join(iterationsDir, `iteration-${iteration}.md`);
    const evaluationPath = join(evaluationsDir, `evaluation-${iteration}.json`);
    iterationArtifactPaths.push(iterationPath);
    evaluationArtifactPaths.push(evaluationPath);
    await ctx.task(`iteration-${iteration}`, {
      prompt: renderIterationPrompt({
        task: ctx.inputs.prompt,
        iteration,
        maxIterations: ctx.inputs.max_iterations,
        ledgerPath,
      }),
      context: "fresh",
      reads: [ledgerPath, ...(iteration > 1 ? [iterationArtifactPaths[iteration - 2]!] : [])],
      output: iterationPath,
      outputMode: "file-only",
    });
    const evaluator = await ctx.task(`evaluate-${iteration}`, {
      prompt: renderEvaluationPrompt({
        task: ctx.inputs.prompt,
        iteration,
        ledgerPath,
        iterationPath,
      }),
      context: "fresh",
      reads: [ledgerPath, iterationPath],
      schema: evaluationSchema,
      output: evaluationPath,
      outputMode: "file-only",
    });
    const decision = evaluationFrom(evaluator);
    entries.push({
      iteration,
      artifact_path: iterationPath,
      evaluation_artifact_path: evaluationPath,
      summary: decision.summary,
      findings: decision.newFindings,
      failures: decision.failures,
      validation_evidence: decision.validationEvidence,
      done: decision.done,
      remaining_work: decision.remainingWork,
    });
    await writeLedger(
      ledgerPath,
      ctx.inputs.prompt,
      ctx.inputs.max_iterations,
      decision.done ? "complete" : "active",
      entries,
    );
    if (decision.done) {
      const resultPath = join(artifactDir, "result.md");
      const final = await ctx.task("completion-summary", {
        prompt: renderCompletionPrompt({ task: ctx.inputs.prompt, ledgerPath, iterationPath }),
        context: "fresh",
        reads: [ledgerPath, iterationPath],
        output: resultPath,
      });
      return {
        result: final.text,
        status: "complete" as const,
        iterations_completed: iteration,
        ledger_path: ledgerPath,
        iteration_artifact_paths: iterationArtifactPaths,
        evaluation_artifact_paths: evaluationArtifactPaths,
        result_path: resultPath,
        remaining_work: "",
        artifact_dir: artifactDir,
      };
    }
  }

  const last = entries.at(-1)!;
  await writeLedger(ledgerPath, ctx.inputs.prompt, ctx.inputs.max_iterations, "failed", entries);
  return {
    result: `Iteration limit exhausted after ${ctx.inputs.max_iterations} iterations. Inspect ${ledgerPath}.`,
    status: "failed" as const,
    iterations_completed: ctx.inputs.max_iterations,
    ledger_path: ledgerPath,
    iteration_artifact_paths: iterationArtifactPaths,
    evaluation_artifact_paths: evaluationArtifactPaths,
    result_path: ledgerPath,
    remaining_work: last.remaining_work,
    artifact_dir: artifactDir,
  };
}
