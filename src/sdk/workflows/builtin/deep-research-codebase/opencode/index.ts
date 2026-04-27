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
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  getCodebaseRoot,
  partitionUnits,
  scoutCodebase,
} from "../helpers/scout.ts";
import {
  calculateExplorerCount,
  explainHeuristic,
} from "../helpers/heuristic.ts";
import {
  buildAggregatorPrompt,
  buildAnalyzerPrompt,
  buildBatchOrchestratorPrompt,
  buildHistoryAnalyzerPrompt,
  buildHistoryLocatorPrompt,
  buildLocatorPrompt,
  buildOnlineResearcherPrompt,
  buildPatternFinderPrompt,
  buildScoutPrompt,
  slugifyPrompt,
  wrapPromptForTaskDispatch,
} from "../helpers/prompts.ts";
import { writeExplorerScratchFile } from "../helpers/scratch.ts";
import {
  chunkBatches,
  MAX_TASKS_PER_BATCH,
  SUBAGENT_TYPE,
  type Layer1Task,
  type Layer2Task,
} from "../helpers/batching.ts";

/** Filter for text parts only — non-text parts produce [object Object]. */
function extractResponseText(
  parts: Array<{ type: string; [key: string]: unknown }>,
): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { type: string; text: string }).text)
    .join("\n");
}

/** Read a file as UTF-8, returning empty string if missing or unreadable. */
async function safeReadFile(absPath: string): Promise<string> {
  try {
    return await readFile(absPath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Log Promise.allSettled rejection reasons to stderr so an all-failed wave
 * leaves a debugging trail instead of silently producing an empty report.
 */
function logBatchRejections(
  label: string,
  results: PromiseSettledResult<unknown>[],
): void {
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r?.status === "rejected") {
      console.error(`[deep-research-codebase] ${label} batch ${i + 1} failed:`, r.reason);
    }
  }
}

export default defineWorkflow({
  name: "deep-research-codebase",
  source: import.meta.path,
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

    // ── Stage 1a: codebase-scout ‖ Stage 1b: research-history pipeline ────
    const [scout, historyOverview] = await Promise.all([
      ctx.stage(
        {
          name: "codebase-scout",
          description:
            "Map codebase, count LOC, partition for parallel specialists",
        },
        {},
        { title: "codebase-scout" },
        async (s) => {
          const data = scoutCodebase(root);
          if (data.units.length === 0) {
            throw new Error(
              `deep-research-codebase: scout found no source files under ${root}. ` +
                `Run from inside a code repository, or verify your files use a ` +
                `recognized programming-language extension (sourced from GitHub ` +
                `Linguist + sql/graphql/proto).`,
            );
          }

          const targetCount = calculateExplorerCount(data.totalLoc);
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
                  totalLoc: data.totalLoc,
                  totalFiles: data.totalFiles,
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
            totalLoc: data.totalLoc,
            totalFiles: data.totalFiles,
            tree: data.tree,
            partitions,
            explorerCount: actualCount,
            scratchDir,
            heuristicNote: explainHeuristic(data.totalLoc, actualCount),
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
          { title: "history-locator" },
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
          { title: "history-analyzer" },
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
    const partitionPaths = partitions.map((_, idx) => {
      const i = idx + 1;
      return {
        locator: path.join(scratchDir, `locator-${i}.md`),
        patternFinder: path.join(scratchDir, `pattern-finder-${i}.md`),
        analyzer: path.join(scratchDir, `analyzer-${i}.md`),
        online: path.join(scratchDir, `online-${i}.md`),
        explorer: path.join(scratchDir, `explorer-${i}.md`),
      };
    });

    const wave1Tasks: Layer1Task[] = partitions.flatMap((partition, idx) => {
      const i = idx + 1;
      const paths = partitionPaths[idx]!;
      return [
        {
          kind: "locator" as const,
          partitionIndex: i,
          partition,
          outputPath: paths.locator,
        },
        {
          kind: "pattern-finder" as const,
          partitionIndex: i,
          partition,
          outputPath: paths.patternFinder,
        },
      ];
    });

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
          { title: `wave1-batch-${batchNumber}` },
          async (s) => {
            const taskSpecs = batch.map((t) => {
              const builder =
                t.kind === "locator" ? buildLocatorPrompt : buildPatternFinderPrompt;
              const specialistPrompt = builder({
                question: prompt,
                partition: t.partition,
                scoutOverview,
                index: t.partitionIndex,
                total: explorerCount,
              });
              return {
                subagentType: SUBAGENT_TYPE[t.kind],
                outputPath: t.outputPath,
                prompt: wrapPromptForTaskDispatch({
                  specialistPrompt,
                  outputPath: t.outputPath,
                  agentLabel: t.kind.toUpperCase().replaceAll("-", "_"),
                }),
              };
            });

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

    const locatorOutputs: Map<number, string> = new Map();
    await Promise.all(
      partitions.map(async (_p, idx) => {
        const i = idx + 1;
        locatorOutputs.set(i, await safeReadFile(partitionPaths[idx]!.locator));
      }),
    );

    const wave2Tasks: Layer2Task[] = partitions.flatMap((partition, idx) => {
      const i = idx + 1;
      const paths = partitionPaths[idx]!;
      const locatorOutput = locatorOutputs.get(i) ?? "";
      return [
        {
          kind: "analyzer" as const,
          partitionIndex: i,
          partition,
          outputPath: paths.analyzer,
          locatorOutput,
        },
        {
          kind: "online-researcher" as const,
          partitionIndex: i,
          partition,
          outputPath: paths.online,
          locatorOutput,
        },
      ];
    });

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
          { title: `wave2-batch-${batchNumber}` },
          async (s) => {
            const taskSpecs = batch.map((t) => {
              const specialistPrompt =
                t.kind === "analyzer"
                  ? buildAnalyzerPrompt({
                      question: prompt,
                      partition: t.partition,
                      locatorOutput: t.locatorOutput,
                      scoutOverview,
                      index: t.partitionIndex,
                      total: explorerCount,
                    })
                  : buildOnlineResearcherPrompt({
                      question: prompt,
                      partition: t.partition,
                      locatorOutput: t.locatorOutput,
                      index: t.partitionIndex,
                      total: explorerCount,
                    });
              return {
                subagentType: SUBAGENT_TYPE[t.kind],
                outputPath: t.outputPath,
                prompt: wrapPromptForTaskDispatch({
                  specialistPrompt,
                  outputPath: t.outputPath,
                  agentLabel: t.kind.toUpperCase().replaceAll("-", "_"),
                }),
              };
            });

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
    const explorerHandles = await Promise.all(
      partitions.map(async (partition, idx) => {
        const i = idx + 1;
        const paths = partitionPaths[idx]!;

        const [locatorOutput, patternsOutput, analyzerOutput, onlineOutput] =
          await Promise.all([
            Promise.resolve(locatorOutputs.get(i) ?? ""),
            safeReadFile(paths.patternFinder),
            safeReadFile(paths.analyzer),
            safeReadFile(paths.online),
          ]);

        await writeExplorerScratchFile(paths.explorer, {
          index: i,
          total: explorerCount,
          partition,
          locatorOutput,
          patternsOutput,
          analyzerOutput,
          onlineOutput,
        });

        return { index: i, scratchPath: paths.explorer, partition };
      }),
    );

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
      { title: "aggregator" },
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
  })
  .compile();
