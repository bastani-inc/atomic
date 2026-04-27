/**
 * Ralph workflow for Claude Code — plan → orchestrate → review loop.
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
 * The reviewer stages run **headless** via the Claude Agent SDK with
 * `outputFormat: { type: "json_schema", schema: REVIEW_RESULT_JSON_SCHEMA }`,
 * so the SDK validates {@link ReviewResultSchema} before returning. The
 * validated object is read from `s.session.lastStructuredOutput` — no text
 * parsing required. Running the reviewers headless (no tmux pane) keeps the
 * graph focused on stages the user cares about and lets the SDK enforce the
 * schema without TUI round-trips.
 *
 * Run: atomic workflow -n ralph -a claude "<your spec>"
 */

import { defineWorkflow, extractAssistantText } from "../../../index.ts";

import {
  buildPlannerPrompt,
  buildOrchestratorPrompt,
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

// The orchestrator stage implements the actual code changes and can run for
// a very long time on large tasks. Completion is detected via session file
// watching for idle and result events from Claude's own SDK — no manual
// timeout is needed.

/**
 * Turn the SDK's validated structured_output (plus raw transcript text) into a
 * {@link StructuredReviewResult}. When the SDK failed to validate the schema
 * (`error_max_structured_output_retries`) `structured_output` is absent and
 * we propagate `null` so {@link mergeReviewResults} treats the pass as
 * unknown/actionable.
 */
function extractReview(
  structuredOutput: unknown,
  rawText: string,
): StructuredReviewResult {
  if (structuredOutput && typeof structuredOutput === "object") {
    return {
      structured: filterActionable(structuredOutput as ReviewResult),
      raw: rawText,
    };
  }
  return { structured: null, raw: rawText };
}

export default defineWorkflow({
  name: "ralph",
  source: import.meta.path,
  description: "Plan → orchestrate → review loop with bounded iteration",
  inputs: [
    {
      name: "prompt",
      type: "text",
      required: true,
      description: "task prompt",
    },
    {
      name: "max_loops",
      type: "integer",
      description: "maximum number of plan/orchestrate/review iterations",
      default: DEFAULT_MAX_LOOPS,
    },
  ],
})
  .for("claude")
  .run(async (ctx) => {
    const prompt = ctx.inputs.prompt ?? "";
    const maxLoops = ctx.inputs.max_loops ?? DEFAULT_MAX_LOOPS;
    let reviewReport = "";

    for (let iteration = 1; iteration <= maxLoops; iteration++) {
      // ── Plan ────────────────────────────────────────────────────────────
      await ctx.stage(
        { name: `planner-${iteration}` },
        {
          chatFlags: [
            "--agent",
            "planner",
            "--allow-dangerously-skip-permissions",
            "--dangerously-skip-permissions",
          ],
        },
        {},
        async (s) => {
          await s.session.query(
            buildPlannerPrompt(prompt, {
              iteration,
              reviewReport: reviewReport || undefined,
            }),
          );
          s.save(s.sessionId);
        },
      );

      // ── Orchestrate ─────────────────────────────────────────────────────
      await ctx.stage(
        { name: `orchestrator-${iteration}` },
        {
          chatFlags: [
            "--agent",
            "orchestrator",
            "--allow-dangerously-skip-permissions",
            "--dangerously-skip-permissions",
          ],
        },
        {},
        async (s) => {
          await s.session.query(buildOrchestratorPrompt(prompt));
          s.save(s.sessionId);
        },
      );

      // ── Infrastructure Discovery (three parallel sub-agent stages) ────
      const changeset = await captureBranchChangeset();
      const discoveryPrompts = buildInfraDiscoveryPrompts();

      const [locatorResult, analyzerResult, patternResult] = await Promise.all([
        ctx.stage(
          { name: `infra-locate-${iteration}`, headless: true },
          {},
          {},
          async (s) => {
            const result = await s.session.query(discoveryPrompts.locator, {
              agent: "codebase-locator",
              permissionMode: "bypassPermissions",
              allowDangerouslySkipPermissions: true,
            });
            s.save(s.sessionId);
            return extractAssistantText(result, 0);
          },
        ),
        ctx.stage(
          { name: `infra-analyze-${iteration}`, headless: true },
          {},
          {},
          async (s) => {
            const result = await s.session.query(discoveryPrompts.analyzer, {
              agent: "codebase-analyzer",
              permissionMode: "bypassPermissions",
              allowDangerouslySkipPermissions: true,
            });
            s.save(s.sessionId);
            return extractAssistantText(result, 0);
          },
        ),
        ctx.stage(
          { name: `infra-patterns-${iteration}`, headless: true },
          {},
          {},
          async (s) => {
            const result = await s.session.query(
              discoveryPrompts.patternFinder,
              {
                agent: "codebase-pattern-finder",
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
              },
            );
            s.save(s.sessionId);
            return extractAssistantText(result, 0);
          },
        ),
      ]);

      const discoveryContext = [
        "### Infrastructure Files (codebase-locator)\n\n" +
          locatorResult.result,
        "### Infrastructure Analysis (codebase-analyzer)\n\n" +
          analyzerResult.result,
        "### Build & Test Patterns (codebase-pattern-finder)\n\n" +
          patternResult.result,
      ].join("\n\n---\n\n");

      // ── Review (two parallel headless passes with schema enforcement) ──
      const reviewPrompt = buildReviewPrompt(prompt, {
        changeset,
        iteration,
        discoveryContext,
      });

      const runReviewer = (name: string) =>
        ctx.stage(
          { name, headless: true },
          {},
          {},
          async (s) => {
            const result = await s.session.query(reviewPrompt, {
              agent: "reviewer",
              permissionMode: "bypassPermissions",
              allowDangerouslySkipPermissions: true,
              outputFormat: {
                type: "json_schema",
                schema: REVIEW_RESULT_JSON_SCHEMA,
              },
            });
            s.save(s.sessionId);
            return extractReview(
              s.session.lastStructuredOutput,
              extractAssistantText(result, 0),
            );
          },
        );

      const [reviewA, reviewB] = await Promise.all([
        runReviewer(`reviewer-${iteration}-a`),
        runReviewer(`reviewer-${iteration}-b`),
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
