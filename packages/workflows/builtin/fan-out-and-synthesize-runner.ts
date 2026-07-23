import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { WorkflowRunContext, WorkflowSerializableValue, WorkflowTaskStep } from "../src/shared/types.js";
import { branchPrompt, partitionPrompt, synthesisPrompt } from "./fan-out-and-synthesize-prompts.js";
import { stableArtifactRoot } from "./pattern-artifact-root.js";

const partitionSchema = Type.Object({
  partitions: Type.Array(Type.Object({
    label: Type.String({ minLength: 1 }),
    objective: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 12 }),
}, { additionalProperties: false });

type Inputs = {
  readonly prompt: string;
  readonly max_branches: number;
  readonly max_concurrency: number;
} & Record<string, WorkflowSerializableValue>;
type Partition = { readonly label: string; readonly objective: string };
export type FanOutAndSynthesizeResult = {
  readonly result: string;
  readonly partitions: string[];
  readonly branch_artifact_paths: string[];
  readonly synthesis_path: string;
  readonly artifact_dir: string;
  readonly manifest_path: string;
};

function safeName(value: string, index: number): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${String(index + 1).padStart(2, "0")}-${normalized || "branch"}`;
}
async function artifactText(path: string, fallback: string): Promise<string> {
  try { return await readFile(path, "utf8"); } catch { return fallback; }
}
function parsedPartitions(value: WorkflowSerializableValue | undefined, limit: number, prompt: string): Partition[] {
  if (typeof value !== "object" || value === null || !("partitions" in value) || !Array.isArray(value.partitions)) {
    return [{ label: "whole-task", objective: prompt }];
  }
  const result: Partition[] = [];
  for (const candidate of value.partitions) {
    if (typeof candidate !== "object" || candidate === null || !("label" in candidate) || !("objective" in candidate)) continue;
    const label = String(candidate.label).trim();
    const objective = String(candidate.objective).trim();
    if (label !== "" && objective !== "") result.push({ label, objective });
    if (result.length >= limit) break;
  }
  return result.length > 0 ? result : [{ label: "whole-task", objective: prompt }];
}

export async function runFanOutAndSynthesize(ctx: WorkflowRunContext<Inputs>): Promise<FanOutAndSynthesizeResult> {
  const artifactDir = await stableArtifactRoot(ctx, "fan-out-and-synthesize");
  const plan = await ctx.task("partition", {
    prompt: partitionPrompt(ctx.inputs.prompt, ctx.inputs.max_branches),
    schema: partitionSchema,
    context: "fresh",
  });
  const partitions = parsedPartitions(plan.structured, ctx.inputs.max_branches, ctx.inputs.prompt);
  const partitionPath = join(artifactDir, "partition-plan.json");
  await writeFile(partitionPath, JSON.stringify({ task: ctx.inputs.prompt, partitions }, null, 2));

  const branchPaths = partitions.map((partition, index) => join(artifactDir, `branch-${safeName(partition.label, index)}.md`));
  const steps: WorkflowTaskStep[] = partitions.map((partition, index) => ({
    name: `branch-${safeName(partition.label, index)}`,
    prompt: branchPrompt({ prompt: ctx.inputs.prompt, ...partition }),
    context: "fresh",
    reads: [partitionPath],
    output: branchPaths[index]!,
    outputMode: "file-only",
  }));
  await ctx.parallel(steps, { concurrency: Math.min(ctx.inputs.max_concurrency, partitions.length), failFast: false });

  const manifestPath = join(artifactDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    task: ctx.inputs.prompt,
    partition_plan: partitionPath,
    branches: partitions.map((partition, index) => ({ ...partition, artifact_path: branchPaths[index] })),
  }, null, 2));
  const synthesisPath = join(artifactDir, "synthesis.md");
  const synthesis = await ctx.task("synthesize", {
    prompt: synthesisPrompt(ctx.inputs.prompt, manifestPath),
    context: "fresh",
    reads: [manifestPath, ...branchPaths],
    output: synthesisPath,
    outputMode: "file-only",
  });
  return {
    result: await artifactText(synthesisPath, synthesis.text),
    partitions: partitions.map((partition) => partition.label),
    branch_artifact_paths: branchPaths,
    synthesis_path: synthesisPath,
    artifact_dir: artifactDir,
    manifest_path: manifestPath,
  };
}
