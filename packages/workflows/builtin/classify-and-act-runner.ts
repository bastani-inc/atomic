import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { WorkflowRunContext, WorkflowSerializableValue } from "../src/shared/types.js";
import { actionPrompt, classifierPrompt } from "./classify-and-act-prompts.js";

export const classificationSchema = Type.Object({
  category: Type.String({ description: "One category copied verbatim from the supplied list." }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  rationale: Type.String(),
}, { additionalProperties: false });

type Inputs = {
  readonly prompt: string;
  readonly categories: readonly string[];
  readonly confidence_threshold: number;
} & Record<string, WorkflowSerializableValue>;

export type ClassifyAndActResult = {
  readonly result: string;
  readonly category: string;
  readonly confidence: number;
  readonly action: string;
  readonly classification_path: string;
  readonly action_path: string;
  readonly artifact_dir: string;
};

function safeName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized || "fallback";
}
function actionTools(category: string): readonly string[] {
  const normalized = category.toLowerCase();
  if (normalized.includes("implement") || normalized.includes("fix") || normalized.includes("code")) {
    return ["read", "edit", "write", "bash"];
  }
  if (normalized.includes("research")) return ["read", "web_search", "fetch_content"];
  return ["read"];
}


async function artifactText(path: string, fallback: string): Promise<string> {
  try { return await readFile(path, "utf8"); } catch { return fallback; }
}

/**
 * Resolve a low-confidence or unlisted classification. Interactive runs ask the
 * user; headless/non-interactive runs (where ctx.ui rejects) deterministically
 * fall back to the exact proposed category when it is listed, else the first
 * configured category, so the workflow still produces its declared outputs.
 */
async function resolveFallbackCategory(
  ctx: WorkflowRunContext<Inputs>,
  exactCategory: string | undefined,
): Promise<{ category: string; fallbackMode: "interactive_select" | "deterministic" }> {
  try {
    const category = await ctx.ui.select("Classification is uncertain. Choose the action category.", ctx.inputs.categories);
    return { category, fallbackMode: "interactive_select" };
  } catch {
    return { category: exactCategory ?? ctx.inputs.categories[0]!, fallbackMode: "deterministic" };
  }
}

export async function runClassifyAndAct(ctx: WorkflowRunContext<Inputs>): Promise<ClassifyAndActResult> {
  const cwd = ctx.cwd ?? process.cwd();
  const artifactDir = join(cwd, ".atomic", "workflows", "runs", `classify-and-act-${randomUUID()}`);
  await mkdir(artifactDir, { recursive: true });
  const classified = await ctx.task("classifier", {
    prompt: classifierPrompt(ctx.inputs.prompt, ctx.inputs.categories),
    schema: classificationSchema,
    context: "fresh",
    tools: [],
  });
  const value = classified.structured;
  const proposedCategory = typeof value === "object" && value !== null && "category" in value
    ? String(value.category) : "";
  const confidenceValue = typeof value === "object" && value !== null && "confidence" in value
    ? value.confidence : 0;
  const confidence = typeof confidenceValue === "number" && Number.isFinite(confidenceValue)
    ? Math.max(0, Math.min(1, confidenceValue)) : 0;
  const rationale = typeof value === "object" && value !== null && "rationale" in value
    ? String(value.rationale) : "Classifier did not provide a usable structured rationale.";
  const exactCategory = ctx.inputs.categories.find((category) => category === proposedCategory);
  const needsFallback = exactCategory === undefined || confidence < ctx.inputs.confidence_threshold;
  const fallback = needsFallback ? await resolveFallbackCategory(ctx, exactCategory) : undefined;
  const category = fallback?.category ?? exactCategory!;

  const classificationPath = join(artifactDir, "classification.json");
  await writeFile(classificationPath, JSON.stringify({
    proposed_category: proposedCategory,
    selected_category: category,
    confidence,
    threshold: ctx.inputs.confidence_threshold,
    rationale,
    fallback_used: needsFallback,
    fallback_mode: fallback?.fallbackMode ?? "none",
  }, null, 2));

  const actionPath = join(artifactDir, `action-${safeName(category)}.md`);
  const action = await ctx.task(`action-${safeName(category)}`, {
    tools: actionTools(category),
    prompt: actionPrompt({ prompt: ctx.inputs.prompt, category, classificationPath }),
    context: "fresh",
    reads: [classificationPath],
    output: actionPath,
    outputMode: "file-only",
  });
  const result = await artifactText(actionPath, action.text);
  return { result, category, confidence, action: action.stageName, classification_path: classificationPath, action_path: actionPath, artifact_dir: artifactDir };
}
