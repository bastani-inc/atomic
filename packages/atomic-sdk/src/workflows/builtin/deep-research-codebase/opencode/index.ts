/**
 * deep-research-codebase / opencode
 *
 * OpenCode replica of the Claude deep-research-codebase workflow with the
 * same **batched** Task-tool fan-out. Specialist sub-agents run inside batch
 * sessions: each batch is a single `ctx.stage()` whose orchestrator turn
 * dispatches up to MAX_TASKS_PER_BATCH (≈10) specialists in parallel via
 * OpenCode's `task` tool. The default agent must have `task: "allow"` in
 * its permission ruleset (see `.opencode/agents/worker.md` for the
 * canonical example).
 *
 * See claude/index.ts for the full design rationale and topology diagram.
 *
 * OpenCode-specific concerns baked in (see references/failure-modes.md):
 *
 *   • F3 — `result.data!.parts` is heterogenous. Batch sessions don't read
 *     `extractResponseText` for orchestrator output (sub-agents write to
 *     disk; the orchestrator reply is just a short tally), but the history
 *     pipeline still uses it.
 *
 *   • F5 — every `ctx.stage()` is a FRESH session. Batch session prompts
 *     embed everything the orchestrator needs in the first turn.
 *
 *   • F6 — orchestrator prompt requires a single-line tally as the trailing
 *     turn so transcripts are never empty.
 *
 *   • F9 — `s.save()` receives the unwrapped `{ info, parts }` payload from
 *     `result.data!`.
 */

import { defineWorkflow } from "../../../index.ts";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  getCodebaseRoot,
  listSourceFiles,
  partitionUnits,
  scoutCodebase,
} from "../helpers/scout.ts";
import {
  buildLayer1TaskSpec,
  buildLayer1Tasks,
  buildLayer2TaskSpec,
  buildLayer2Tasks,
  buildPartitionPaths,
  logBatchRejections,
  readLocatorOutputs,
  resolveEffectiveCounts,
  synthesizeExplorerHandles,
} from "../helpers/orchestration.ts";
import CodeGraph from "@colbymchenry/codegraph";
import {
  calculateExplorerCount,
  explainHeuristic,
} from "../helpers/heuristic.ts";
import {
  buildAggregatorPrompt,
  buildBatchOrchestratorPrompt,
  buildHistoryAnalyzerPrompt,
  buildHistoryLocatorPrompt,
  buildScoutPrompt,
  slugifyPrompt,
} from "../helpers/prompts.ts";
import {
  logPreflightResult,
  preflight,
  type PreflightResult,
} from "../helpers/preflight.ts";
import { chunkBatches, MAX_TASKS_PER_BATCH } from "../helpers/batching.ts";

/** Filter for text parts only — non-text parts produce [object Object]. */
function extractResponseText(
  parts: Array<{ type: string; [key: string]: unknown }>,
): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { type: string; text: string }).text)
    .join("\n");
}

export default defineWorkflow({
  name: "deep-research-codebase",
  description:
    "Deterministic deep codebase research: scout → per-partition specialist sub-agents → aggregator",
  inputs: [
    {
      name: "prompt",
      type: "text",
      required: true,
      description: "research question",
    },
  ],
})
  .for("opencode")
  .run(async (ctx) => {
    const prompt = ctx.inputs.prompt ?? "";
    const root = getCodebaseRoot();
    const startedAt = new Date();
    const isoDate = startedAt.toISOString().slice(0, 10);
    const slug = slugifyPrompt(prompt);

    // ── Preflight: CodeGraph health + uv availability ────────────────────
    const preflightResult: PreflightResult = await preflight(root);
    logPreflightResult(preflightResult);

    // ── CodeGraph lifecycle (§5.4): open once, close in finally ──────────
    const graph: CodeGraph | null = preflightResult.codegraphHealthy
      ? await CodeGraph.open(root, { readOnly: true })
      : null;
    console.log(
      graph !== null
        ? "[codegraph] handle opened (readOnly)"
        : "[codegraph] skipped — using legacy file walk",
    );

    try {
    // ── Stage 1a: codebase-scout ‖ Stage 1b: research-history pipeline ────
    const [scout, historyOverview] = await Promise.all([
      ctx.stage(
        {
          name: "codebase-scout",
          description:
            "Map codebase, count LOC, partition for parallel specialists",
        },
        {},
        {
          title: "codebase-scout",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        },
        async (s) => {
          const [fileWalk, data] = await Promise.all([
            listSourceFiles(root, { graph }),
            Promise.resolve(scoutCodebase(root)),
          ]);

          if (data.units.length === 0) {
            throw new Error(
              `deep-research-codebase: scout found no source files under ${root}. ` +
                `Run from inside a code repository, or verify your files use a ` +
                `recognized programming-language extension (sourced from GitHub ` +
                `Linguist + sql/graphql/proto).`,
            );
          }

          const { effectiveFiles, effectiveLoc } = resolveEffectiveCounts({
            graph,
            fileWalk,
            scoutTotalFiles: data.totalFiles,
            scoutTotalLoc: data.totalLoc,
          });

          const targetCount = calculateExplorerCount(effectiveLoc, {
            codegraphHealthy: preflightResult.codegraphHealthy,
          });
          const partitions = partitionUnits(data.units, targetCount);
          const actualCount = partitions.length;

          const scratchDir = path.join(
            root,
            "research",
            "docs",
            `.deep-research-${startedAt.getTime()}`,
          );
          await mkdir(scratchDir, { recursive: true });

          const result = await s.client.session.prompt({
            sessionID: s.session.id,
            parts: [
              {
                type: "text",
                text: buildScoutPrompt({
                  question: prompt,
                  tree: data.tree,
                  totalLoc: effectiveLoc,
                  totalFiles: effectiveFiles,
                  explorerCount: actualCount,
                  partitionPreview: partitions,
                }),
              },
            ],
          });
          // F9: OpenCode takes the unwrapped { info, parts } object.
          s.save(result.data!);

          return {
            root,
            totalLoc: effectiveLoc,
            totalFiles: effectiveFiles,
            tree: data.tree,
            partitions,
            explorerCount: actualCount,
            scratchDir,
            heuristicNote: explainHeuristic(effectiveLoc, actualCount),
          };
        },
      ),
      // research-history pipeline: sequential locator → analyzer, both headless.
      (async (): Promise<string> => {
        const historyLocator = await ctx.stage(
          {
            name: "history-locator",
            headless: true,
            description: "Locate prior research docs (codebase-research-locator)",
          },
          {},
          {
            title: "history-locator",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          },
          async (s) => {
            const result = await s.client.session.prompt({
              sessionID: s.session.id,
              parts: [
                {
                  type: "text",
                  text: buildHistoryLocatorPrompt({
                    question: prompt,
                  }),
                },
              ],
              agent: "codebase-research-locator",
            });
            s.save(result.data!);
            return extractResponseText(result.data!.parts);
          },
        );

        const historyAnalyzer = await ctx.stage(
          {
            name: "history-analyzer",
            headless: true,
            description: "Synthesize prior research (codebase-research-analyzer)",
          },
          {},
          {
            title: "history-analyzer",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          },
          async (s) => {
            const result = await s.client.session.prompt({
              sessionID: s.session.id,
              parts: [
                {
                  type: "text",
                  text: buildHistoryAnalyzerPrompt({
                    question: prompt,
                    locatorOutput: historyLocator.result,
                  }),
                },
              ],
              agent: "codebase-research-analyzer",
            });
            s.save(result.data!);
            return extractResponseText(result.data!.parts);
          },
        );

        return historyAnalyzer.result;
      })(),
    ]);

    const { partitions, explorerCount, scratchDir, totalLoc, totalFiles } =
      scout.result;

    const scoutOverview = (await ctx.transcript(scout)).content;

    // ── Stage 2: batched specialist fan-out ───────────────────────────────
    //
    // Same two-wave batched design as claude/index.ts. Each batch session
    // pins the dispatcher to the `orchestrator` agent (.opencode/agents/
    // orchestrator.md) — its system prompt is purpose-built to delegate
    // everything via the `task` tool, so the dispatcher cannot wander off
    // and start doing the specialists' work itself.

    // Per-partition output paths, computed once and reused across both wave
    // task-list construction and synthesis.
    const partitionPaths = buildPartitionPaths(scratchDir, partitions.length);

    const wave1Tasks = buildLayer1Tasks(partitions, partitionPaths);
    const wave1Batches = chunkBatches(wave1Tasks, MAX_TASKS_PER_BATCH);

    const wave1Results = await Promise.allSettled(
      wave1Batches.map((batch, batchIdx) => {
        const batchNumber = batchIdx + 1;
        return ctx.stage(
          {
            name: `wave1-batch-${batchNumber}`,
            headless: true,
            description: `Layer 1 dispatch (${batch.length} tasks)`,
          },
          {},
          {
            title: `wave1-batch-${batchNumber}`,
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          },
          async (s) => {
            const taskSpecs = batch.map((task) =>
              buildLayer1TaskSpec({
                task,
                question: prompt,
                scoutOverview,
                total: explorerCount,
              }),
            );

            const result = await s.client.session.prompt({
              sessionID: s.session.id,
              parts: [
                {
                  type: "text",
                  text: buildBatchOrchestratorPrompt({
                    wave: 1,
                    batchIndex: batchNumber,
                    totalBatches: wave1Batches.length,
                    tasks: taskSpecs,
                  }),
                },
              ],
              agent: "orchestrator",
            });
            s.save(result.data!);
          },
        );
      }),
    );
    logBatchRejections("wave1", wave1Results);

    const locatorOutputs = await readLocatorOutputs(partitionPaths);

    const wave2Tasks = buildLayer2Tasks(partitions, partitionPaths, locatorOutputs);
    const wave2Batches = chunkBatches(wave2Tasks, MAX_TASKS_PER_BATCH);

    const wave2Results = await Promise.allSettled(
      wave2Batches.map((batch, batchIdx) => {
        const batchNumber = batchIdx + 1;
        return ctx.stage(
          {
            name: `wave2-batch-${batchNumber}`,
            headless: true,
            description: `Layer 2 dispatch (${batch.length} tasks)`,
          },
          {},
          {
            title: `wave2-batch-${batchNumber}`,
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          },
          async (s) => {
            const taskSpecs = batch.map((task) =>
              buildLayer2TaskSpec({
                task,
                question: prompt,
                scoutOverview,
                total: explorerCount,
              }),
            );

            const result = await s.client.session.prompt({
              sessionID: s.session.id,
              parts: [
                {
                  type: "text",
                  text: buildBatchOrchestratorPrompt({
                    wave: 2,
                    batchIndex: batchNumber,
                    totalBatches: wave2Batches.length,
                    tasks: taskSpecs,
                  }),
                },
              ],
              agent: "orchestrator",
            });
            s.save(result.data!);
          },
        );
      }),
    );
    logBatchRejections("wave2", wave2Results);

    // Synthesis: read all four specialist files per partition and write the
    // consolidated explorer scratch file. Missing files fall back to "" so
    // partial batch failures degrade gracefully.
    const explorerHandles = await synthesizeExplorerHandles({
      partitions,
      paths: partitionPaths,
      locatorOutputs,
      explorerCount,
      graph,
    });

    // ── Stage 3: aggregator ───────────────────────────────────────────────
    const finalPath = path.join(
      root,
      "research",
      "docs",
      `${isoDate}-${slug}.md`,
    );

    await ctx.stage(
      {
        name: "aggregator",
        description:
          "Synthesize partition findings + history into final research doc",
      },
      {},
      {
        title: "aggregator",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      },
      async (s) => {
        const result = await s.client.session.prompt({
          sessionID: s.session.id,
          parts: [
            {
              type: "text",
              text: buildAggregatorPrompt({
                question: prompt,
                totalLoc,
                totalFiles,
                explorerCount,
                explorerFiles: explorerHandles,
                finalPath,
                scoutOverview,
                historyOverview,
              }),
            },
          ],
        });
        s.save(result.data!);
      },
    );
    } finally {
      if (graph !== null) {
        graph.close();
        console.log("[codegraph] handle closed");
      }
    }
  })
  .compile();
