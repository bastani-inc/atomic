/**
 * deep-research-codebase / copilot
 *
 * Copilot replica of the Claude deep-research-codebase workflow with the
 * same **batched** Task-tool fan-out. Specialist sub-agents run inside batch
 * sessions: each batch is a single `ctx.stage()` whose orchestrator turn
 * dispatches up to MAX_TASKS_PER_BATCH (≈10) specialists in parallel via
 * Copilot's `agent` tool (alias `Task`, see Copilot subagents docs).
 * Research-history specialists remain as their own sequential sub-pipeline.
 *
 * See claude/index.ts for the full design rationale and topology diagram.
 *
 * Copilot-specific concerns baked in (see references/failure-modes.md):
 *
 *   • F1 — Copilot's last assistant turn is often empty when the agent ends
 *     on a tool call. Batch sessions don't read `getAssistantText` for the
 *     orchestrator output (sub-agents write to disk; the orchestrator's text
 *     reply is just a short tally), so this is no longer load-bearing for
 *     Stage 2 — but the history pipeline still depends on it.
 *
 *   • F5 — every `ctx.stage()` is a FRESH session. Batch session prompts
 *     embed everything the orchestrator needs (per-task subagent_type,
 *     output path, and verbatim specialist prompt) in the first turn.
 *
 *   • F6 — orchestrator prompt requires a single-line tally as the trailing
 *     turn so transcripts are never empty.
 *
 *   • F9 — `s.save()` receives `SessionEvent[]` from `s.session.getMessages()`.
 */

import { defineWorkflow } from "../../../index.ts";
import type { SessionEvent } from "@github/copilot-sdk";
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
  closeGraph,
  logBatchRejections,
  openGraphForRun,
  readLocatorOutputs,
  resolveEffectiveCounts,
  synthesizeExplorerHandles,
} from "../helpers/orchestration.ts";
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

/**
 * Concatenate every top-level assistant turn's non-empty content. The final
 * `assistant.message` of a Copilot turn is often empty when the agent ends
 * on a tool call (F1), and sub-agent traffic is signalled by `parentToolCallId`.
 * Used for the history pipeline only — batch sessions don't need this since
 * sub-agents write to disk.
 */
function getAssistantText(messages: SessionEvent[]): string {
  return messages
    .filter(
      (m): m is Extract<SessionEvent, { type: "assistant.message" }> =>
        m.type === "assistant.message" && !m.data.parentToolCallId,
    )
    .map((m) => m.data.content)
    .filter((c) => c.length > 0)
    .join("\n\n");
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
  .for("copilot")
  .run(async (ctx) => {
    const prompt = ctx.inputs.prompt ?? "";
    const root = getCodebaseRoot();
    const startedAt = new Date();
    const isoDate = startedAt.toISOString().slice(0, 10);
    const slug = slugifyPrompt(prompt);

    // ── Preflight: CodeGraph health check ─────────────────────────────────
    const preflightResult: PreflightResult = await preflight(root);
    logPreflightResult(preflightResult);

    // ── CodeGraph lifecycle (§5.4) ────────────────────────────────────────
    // Open a single read-only handle when healthy; null otherwise. Threaded
    // into listSourceFiles + writeExplorerScratchFile so every downstream
    // consumer shares one open connection.
    const graph = await openGraphForRun(root, preflightResult.codegraphHealthy);

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
        {},
        async (s) => {
          // Use listSourceFiles (CodeGraph-aware) for file counts + LOC;
          // fall back to scoutCodebase for tree + partition units since
          // buildPartitionUnits/renderTree are internal to scout.ts.
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

          await s.session.send({
            prompt: buildScoutPrompt({
              question: prompt,
              tree: data.tree,
              totalLoc: effectiveLoc,
              totalFiles: effectiveFiles,
              explorerCount: actualCount,
              partitionPreview: partitions,
            }),
          });
          // F9: Copilot takes SessionEvent[], not a session ID.
          s.save(await s.session.getMessages());

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
          { agent: "codebase-research-locator" },
          async (s) => {
            await s.session.send({
              prompt: buildHistoryLocatorPrompt({ question: prompt }),
            });
            const messages = await s.session.getMessages();
            s.save(messages);
            return getAssistantText(messages);
          },
        );

        const historyAnalyzer = await ctx.stage(
          {
            name: "history-analyzer",
            headless: true,
            description: "Synthesize prior research (codebase-research-analyzer)",
          },
          {},
          { agent: "codebase-research-analyzer" },
          async (s) => {
            await s.session.send({
              prompt: buildHistoryAnalyzerPrompt({
                question: prompt,
                locatorOutput: historyLocator.result,
              }),
            });
            const messages = await s.session.getMessages();
            s.save(messages);
            return getAssistantText(messages);
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
    // pins the dispatcher to the `orchestrator` agent (.github/agents/
    // orchestrator.md) — its system prompt is purpose-built to delegate
    // everything via the `agent`/Task tool, so the dispatcher cannot wander
    // off and start doing the specialists' work itself.

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
          { agent: "orchestrator" },
          async (s) => {
            const taskSpecs = batch.map((task) =>
              buildLayer1TaskSpec({
                task,
                question: prompt,
                scoutOverview,
                total: explorerCount,
              }),
            );

            await s.session.send({
              prompt: buildBatchOrchestratorPrompt({
                wave: 1,
                batchIndex: batchNumber,
                totalBatches: wave1Batches.length,
                tasks: taskSpecs,
              }),
            });
            s.save(await s.session.getMessages());
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
          { agent: "orchestrator" },
          async (s) => {
            const taskSpecs = batch.map((task) =>
              buildLayer2TaskSpec({
                task,
                question: prompt,
                scoutOverview,
                total: explorerCount,
              }),
            );

            await s.session.send({
              prompt: buildBatchOrchestratorPrompt({
                wave: 2,
                batchIndex: batchNumber,
                totalBatches: wave2Batches.length,
                tasks: taskSpecs,
              }),
            });
            s.save(await s.session.getMessages());
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
      {},
      async (s) => {
        await s.session.send({
          prompt: buildAggregatorPrompt({
            question: prompt,
            totalLoc,
            totalFiles,
            explorerCount,
            explorerFiles: explorerHandles,
            finalPath,
            scoutOverview,
            historyOverview,
          }),
        });
        s.save(await s.session.getMessages());
      },
    );

    } finally {
      closeGraph(graph);
    }
  })
  .compile();
