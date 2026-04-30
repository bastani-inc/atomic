/**
 * Ralph workflow for OpenCode — plan → orchestrate → review loop.
 *
 * Each sub-agent invocation spawns its own visible session in the graph,
 * so users can see each iteration's progress in real time. The loop
 * terminates when:
 *   - `max_loops` iterations have completed (defaults to {@link DEFAULT_MAX_LOOPS}), OR
 *   - Both parallel reviewer passes return `overall_correctness === "patch is correct"`.
 *
 * On a failed review the merged findings are formatted into a markdown
 * brief by {@link formatReviewForReplan} and fed into the next iteration's
 * planner, which is responsible for validating, deduping, and clustering
 * them into shared root causes before revising the RFC.
 *
 * The reviewer stages use the OpenCode SDK's structured output
 * (`format: { type: "json_schema" }`) to guarantee the review result
 * matches the {@link ReviewResultSchema}.
 *
 * Run: atomic workflow -n ralph -a opencode "<your spec>"
 */

import { defineWorkflow } from "../../../index.ts";

import {
  buildPlannerPrompt,
  buildOrchestratorPrompt,
  buildCodeSimplifierPrompt,
  buildInfraDiscoveryPrompts,
  buildReviewPrompt,
  filterActionable,
  formatReviewForReplan,
  mergeReviewResults,
  REVIEW_RESULT_JSON_SCHEMA,
  type ReviewResult,
  type StructuredReviewResult,
} from "../helpers/prompts.ts";
import { hasActionableFindings } from "../helpers/review.ts";
import { captureBranchChangeset } from "../helpers/git.ts";

const DEFAULT_MAX_LOOPS = 10;

/** Concatenate the text-typed parts of an OpenCode response. */
function extractResponseText(
  parts: Array<{ type: string; [key: string]: unknown }>,
): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { type: string; text: string }).text)
    .join("\n");
}

/**
 * Extract a {@link StructuredReviewResult} from an OpenCode prompt response.
 *
 * The OpenCode SDK places the SDK-validated structured output on the
 * AssistantMessage as `structured` (see `@opencode-ai/sdk` v2 types.gen.d.ts
 * — AssistantMessage.structured). Returns `structured: null` whenever the
 * SDK did not produce a validated object so {@link mergeReviewResults}
 * treats the pass as unknown/actionable.
 */
function extractReview(
  data: { info?: Record<string, unknown>; parts: Array<{ type: string; [key: string]: unknown }> },
): StructuredReviewResult {
  const raw = extractResponseText(data.parts);

  const structuredOutput = data.info?.structured;
  if (structuredOutput && typeof structuredOutput === "object") {
    return {
      structured: filterActionable(structuredOutput as ReviewResult),
      raw,
    };
  }

  return { structured: null, raw };
}

export default defineWorkflow({
  name: "ralph",
  source: import.meta.path,
  description: "Plan → orchestrate → review loop with bounded iteration",
  inputs: [
    { name: "prompt", type: "text", required: true, description: "task prompt" },
    {
      name: "max_loops",
      type: "integer",
      description: "maximum number of plan/orchestrate/review iterations",
      default: DEFAULT_MAX_LOOPS,
    },
  ],
})
  .for("opencode")
  .run(async (ctx) => {
    const prompt = ctx.inputs.prompt ?? "";
    const maxLoops = ctx.inputs.max_loops ?? DEFAULT_MAX_LOOPS;
    let reviewReport = "";

    for (let iteration = 1; iteration <= maxLoops; iteration++) {
      // ── Plan ────────────────────────────────────────────────────────────
      const planner = await ctx.stage(
        { name: `planner-${iteration}` },
        {},
        { title: `planner-${iteration}` },
        async (s) => {
          const result = await s.client.session.prompt({
            sessionID: s.session.id,
            parts: [
              {
                type: "text",
                text: buildPlannerPrompt(prompt, {
                  iteration,
                  reviewReport: reviewReport || undefined,
                }),
              },
            ],
            agent: "planner",
          });
          s.save(result.data!);
          return extractResponseText(result.data!.parts);
        },
      );

      // ── Orchestrate ─────────────────────────────────────────────────────
      await ctx.stage(
        { name: `orchestrator-${iteration}` },
        {},
        { title: `orchestrator-${iteration}` },
        async (s) => {
          const result = await s.client.session.prompt({
            sessionID: s.session.id,
            parts: [
              {
                type: "text",
                text: buildOrchestratorPrompt(prompt, {
                  plannerNotes: planner.result,
                }),
              },
            ],
            agent: "orchestrator",
          });
          s.save(result.data!);
        },
      );

      // ── Code Simplifier ───────────────────────────────────────────────
      await ctx.stage(
        { name: `code-simplifier-${iteration}` },
        {},
        { title: `code-simplifier-${iteration}` },
        async (s) => {
          const result = await s.client.session.prompt({
            sessionID: s.session.id,
            parts: [
              {
                type: "text",
                text: buildCodeSimplifierPrompt(prompt, {
                  plannerNotes: planner.result,
                }),
              },
            ],
            agent: "code-simplifier",
          });
          s.save(result.data!);
        },
      );

      // ── Infrastructure Discovery (three parallel sub-agent stages) ────
      const changeset = await captureBranchChangeset();
      const discoveryPrompts = buildInfraDiscoveryPrompts();

      const [locatorResult, analyzerResult, patternResult] = await Promise.all([
        ctx.stage(
          { name: `infra-locate-${iteration}`, headless: true },
          {},
          { title: `infra-locate-${iteration}` },
          async (s) => {
            const result = await s.client.session.prompt({
              sessionID: s.session.id,
              parts: [{ type: "text", text: discoveryPrompts.locator }],
              agent: "codebase-locator",
            });
            s.save(result.data!);
            return extractResponseText(result.data!.parts);
          },
        ),
        ctx.stage(
          { name: `infra-analyze-${iteration}`, headless: true },
          {},
          { title: `infra-analyze-${iteration}` },
          async (s) => {
            const result = await s.client.session.prompt({
              sessionID: s.session.id,
              parts: [{ type: "text", text: discoveryPrompts.analyzer }],
              agent: "codebase-analyzer",
            });
            s.save(result.data!);
            return extractResponseText(result.data!.parts);
          },
        ),
        ctx.stage(
          { name: `infra-patterns-${iteration}`, headless: true },
          {},
          { title: `infra-patterns-${iteration}` },
          async (s) => {
            const result = await s.client.session.prompt({
              sessionID: s.session.id,
              parts: [{ type: "text", text: discoveryPrompts.patternFinder }],
              agent: "codebase-pattern-finder",
            });
            s.save(result.data!);
            return extractResponseText(result.data!.parts);
          },
        ),
      ]);

      const discoveryContext = [
        "### Infrastructure Files (codebase-locator)\n\n" + locatorResult.result,
        "### Infrastructure Analysis (codebase-analyzer)\n\n" + analyzerResult.result,
        "### Build & Test Patterns (codebase-pattern-finder)\n\n" + patternResult.result,
      ].join("\n\n---\n\n");

      // ── Review (two parallel passes) ────────────────────────────────────
      const reviewPrompt = buildReviewPrompt(prompt, {
        changeset,
        iteration,
        discoveryContext,
      });

      const reviewStage = async (name: string) =>
        ctx.stage(
          { name },
          {},
          { title: name },
          async (s) => {
            const result = await s.client.session.prompt({
              sessionID: s.session.id,
              parts: [{ type: "text", text: reviewPrompt }],
              agent: "reviewer",
              format: {
                type: "json_schema" as const,
                schema: REVIEW_RESULT_JSON_SCHEMA,
              },
            });
            s.save(result.data!);
            return extractReview(
              result.data! as {
                info?: Record<string, unknown>;
                parts: Array<{ type: string; [key: string]: unknown }>;
              },
            );
          },
        );

      const [reviewA, reviewB] = await Promise.all([
        reviewStage(`reviewer-${iteration}-a`),
        reviewStage(`reviewer-${iteration}-b`),
      ]);

      const merged = mergeReviewResults(reviewA.result, reviewB.result);
      const parsed = merged.structured;
      const reviewRaw = merged.raw;

      // Both reviewers agree the code is clean → done
      if (!hasActionableFindings(parsed, reviewRaw)) break;

      // Findings exist — format them for the next iteration's planner.
      reviewReport = formatReviewForReplan(parsed, reviewRaw);
    }
  })
  .compile();
