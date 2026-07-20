import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import type { WorkflowRunContext, WorkflowSerializableValue } from "../src/shared/types.js";
import { renderFilterPrompt, renderFinalShortlistPrompt, renderGeneratorPrompt, renderJudgePrompt } from "./generate-and-filter-prompts.js";

const filterSchema = Type.Object({
  shortlist: Type.Array(Type.String()),
  discarded: Type.Array(Type.Object({ path: Type.String(), reason: Type.String() }, { additionalProperties: false })),
}, { additionalProperties: false });
const judgeSchema = Type.Object({ shortlist: Type.Array(Type.String()), rationale: Type.String() }, { additionalProperties: false });
type FilterDecision = Static<typeof filterSchema>;
type JudgeDecision = Static<typeof judgeSchema>;
type Inputs = { readonly prompt: string; readonly num_candidates: number; readonly shortlist_size: number; readonly use_judge: boolean; readonly max_concurrency: number } & Record<string, WorkflowSerializableValue>;
export type GenerateAndFilterResult = {
  readonly result: string;
  readonly shortlist: string[];
  readonly candidate_artifact_paths: string[];
  readonly filter_path: string;
  readonly judge_path: string | null;
  readonly final_path: string;
  readonly artifact_dir: string;
  readonly manifest_path: string;
};
function isRecord(value: WorkflowSerializableValue): value is Record<string, WorkflowSerializableValue> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function strings(value: WorkflowSerializableValue | undefined): value is string[] { return Array.isArray(value) && value.every((entry) => typeof entry === "string"); }
function filterDecision(value: WorkflowSerializableValue | undefined): FilterDecision | undefined {
  if (value === undefined || !isRecord(value) || !strings(value.shortlist) || !Array.isArray(value.discarded)) return undefined;
  const valid = value.discarded.every((entry) => isRecord(entry) && typeof entry.path === "string" && typeof entry.reason === "string");
  return valid ? value as FilterDecision : undefined;
}
function judgeDecision(value: WorkflowSerializableValue | undefined): JudgeDecision | undefined {
  return value !== undefined && isRecord(value) && strings(value.shortlist) && typeof value.rationale === "string" ? value as JudgeDecision : undefined;
}

export async function runGenerateAndFilter(ctx: WorkflowRunContext<Inputs>): Promise<GenerateAndFilterResult> {
  const root = join(ctx.cwd ?? process.cwd(), ".atomic", "workflows", "runs", `generate-and-filter-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(root, { recursive: true });
  const candidatePaths = Array.from({ length: ctx.inputs.num_candidates }, (_, index) => join(root, `candidate-${index + 1}.md`));
  const shortlistLimit = Math.min(ctx.inputs.shortlist_size, ctx.inputs.num_candidates);
  await ctx.parallel(candidatePaths.map((path, index) => ({
    name: `generate-${index + 1}`, prompt: renderGeneratorPrompt(ctx.inputs.prompt, index + 1), context: "fresh" as const,
    output: path, outputMode: "file-only" as const,
  })), { concurrency: ctx.inputs.max_concurrency, failFast: false });
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({ task: ctx.inputs.prompt, candidate_artifact_paths: candidatePaths }, null, 2));

  const filterPath = join(root, "filter.json");
  const filtered = await ctx.task("dedupe-and-filter", {
    prompt: renderFilterPrompt(ctx.inputs.prompt, candidatePaths, shortlistLimit), context: "fresh",
    reads: [manifestPath, ...candidatePaths], schema: filterSchema, output: filterPath, outputMode: "file-only",
  });
  const selectCandidates = (paths: readonly string[]): string[] => [...new Set(paths.filter((path) => candidatePaths.includes(path)))].slice(0, shortlistLimit);
  const fallbackShortlist = candidatePaths.slice(0, shortlistLimit);
  const filteredShortlist = selectCandidates(filterDecision(filtered.structured)?.shortlist ?? []);
  let shortlist = filteredShortlist.length > 0 ? filteredShortlist : fallbackShortlist;
  let judgePath: string | null = null;
  let decisionPath = filterPath;
  if (ctx.inputs.use_judge) {
    judgePath = join(root, "judge.json");
    const judged = await ctx.task("judge", {
      prompt: renderJudgePrompt(ctx.inputs.prompt, filterPath, shortlistLimit), context: "fresh",
      reads: [filterPath, ...shortlist], schema: judgeSchema, output: judgePath, outputMode: "file-only",
    });
    const judgedShortlist = selectCandidates(judgeDecision(judged.structured)?.shortlist ?? []);
    shortlist = judgedShortlist.length > 0 ? judgedShortlist : shortlist;
    decisionPath = judgePath;
  }
  const finalPath = join(root, "shortlist.md");
  await ctx.task("final-shortlist", {
    prompt: renderFinalShortlistPrompt(ctx.inputs.prompt, decisionPath), context: "fresh",
    reads: [decisionPath, ...shortlist], output: finalPath, outputMode: "file-only",
  });
  return { result: await readFile(finalPath, "utf8"), shortlist, candidate_artifact_paths: candidatePaths, filter_path: filterPath, judge_path: judgePath, final_path: finalPath, artifact_dir: root, manifest_path: manifestPath };
}
