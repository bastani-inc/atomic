/**
 * deep-research-codebase / claude
 *
 * A deterministically-orchestrated, distributed codebase researcher built on
 * the Claude Agent SDK with **batched** Task-tool fan-out. Specialist
 * sub-agents (codebase-locator / codebase-pattern-finder / codebase-analyzer
 * / codebase-online-researcher) run inside batch sessions: each batch is a
 * single `ctx.stage()` whose orchestrator turn dispatches up to
 * MAX_TASKS_PER_BATCH (≈10) specialists in parallel via the Task tool.
 * Research-history specialists (codebase-research-locator /
 * codebase-research-analyzer) remain as their own small pipeline since they
 * have a strict sequential dependency and run only twice per workflow.
 *
 * Why batched Task-tool dispatch instead of one ctx.stage per specialist:
 *
 *   • SDK-level fan-out scales by codebase size — at 5K LOC per partition
 *     and 4 specialists per partition, a 750K-LOC codebase would otherwise
 *     spawn 600 `claude` subprocesses. Batches of 10 cap that at ~60 SDK
 *     sessions, with each session internally fanning out via Task tool.
 *
 *   • ~10 parallel Task tool sub-agents per single message is the practical
 *     ceiling before rate limits, context contention, and degraded
 *     coordination kick in (no documented hard cap; tunable in
 *     helpers/batching.ts).
 *
 *   • Sub-agents still run in ISOLATED contexts — Task tool gives every
 *     sub-agent its own conversation window, so the locator's file index
 *     doesn't pollute the analyzer the way it would inside a shared
 *     conversation. (multi-agent-patterns swarm isolation.)
 *
 *   • The orchestrator's turn does NOT grow linearly with sub-agent count:
 *     each Task sub-agent writes its verbatim findings to a per-task scratch
 *     file and returns just "DONE", so the orchestrator collects N short
 *     confirmations rather than N transcripts (filesystem-context skill).
 *
 *   • Failure isolation is preserved at two levels: (1) Promise.allSettled
 *     around the batches means one failed batch doesn't abort siblings;
 *     (2) inside a batch, the orchestrator is instructed not to retry
 *     failed Task sub-agents — the synthesis step tolerates missing files.
 *
 *   • Synthesis remains plain TypeScript (`renderExplorerMarkdown` in
 *     helpers/scratch.ts) — no extra LLM call just to concatenate sections.
 *
 * Topology:
 *
 *           ┌─→ codebase-scout (visible)
 *   parent ─┤
 *           └─→ history-locator → history-analyzer (headless)
 *                                       │
 *                                       ▼
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │  Wave 1 (locator + pattern-finder, no inter-deps):                    │
 *   │     wave1-batch-1  ∥  wave1-batch-2  ∥  ...  (Promise.allSettled)     │
 *   │       └── each batch session: orchestrator dispatches ≤10 Task        │
 *   │           sub-agents in one assistant message; each writes to disk    │
 *   │                                       │                                │
 *   │                                       ▼                                │
 *   │  TS reads locator-i.md files from disk for Layer 2 prompts            │
 *   │                                       │                                │
 *   │                                       ▼                                │
 *   │  Wave 2 (analyzer + online-researcher, embed locator output):         │
 *   │     wave2-batch-1  ∥  wave2-batch-2  ∥  ...  (Promise.allSettled)     │
 *   │                                       │                                │
 *   │                                       ▼                                │
 *   │  Per partition i: TS reads 4 specialist files + writes explorer-i.md  │
 *   └──────────────────────────────────────────────────────────────────────┘
 *                                       │
 *                                       ▼
 *                                  aggregator (visible)
 *
 * Batch sessions are headless (transparent to the workflow graph). Visible
 * nodes: parent → [codebase-scout] → aggregator.
 */

import { defineWorkflow, extractAssistantText } from "../../../index.ts";
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
  CODEGRAPH_EXPLORER_FACTOR,
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
 * Shared SDK options for every sub-agent dispatch. `permissionMode` +
 * `allowDangerouslySkipPermissions` are required so the headless sub-agents
 * can use Read/Grep/Glob/Bash/Write/Task without prompting (we are running
 * unattended).
 */
const SUBAGENT_OPTS = {
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
} as const;

/**
 * SDK options for batch sessions. Pin the dispatcher to the `orchestrator`
 * agent (.claude/agents/orchestrator.md) — its system prompt is purpose-built
 * to delegate everything to sub-agents via the Task tool, and its tool list
 * (`Bash, Agent, Edit, Grep, Glob, Read, Task*`) excludes Write/etc., so the
 * dispatcher cannot wander off and start doing the specialists' work itself.
 * The orchestrator agent definition pins `model: opus`; override here to
 * Sonnet if the per-batch dispatcher cost matters more than reliability.
 */
const BATCH_DISPATCHER_OPTS = {
  ...SUBAGENT_OPTS,
  agent: "orchestrator",
} as const;

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
  .for("claude")
  .run(async (ctx) => {
    const prompt = ctx.inputs.prompt ?? "";
    const root = getCodebaseRoot();
    const startedAt = new Date();
    const isoDate = startedAt.toISOString().slice(0, 10);
    const slug = slugifyPrompt(prompt);

    // ── Preflight: CodeGraph health + uv availability ─────────────────────
    const preflightResult: PreflightResult = await preflight(root);
    logPreflightResult(preflightResult);

    // ── CodeGraph lifecycle (§5.4) ────────────────────────────────────────
    // Open one read-only handle for the whole workflow run; thread it through
    // listSourceFiles + writeExplorerScratchFile so synthesis shares one
    // connection. Closed in the finally block below regardless of errors.
    const graph = await openGraphForRun(root, preflightResult.codegraphHealthy);

    try {
    // ── Stage 1a: codebase-scout (visible) ‖ Stage 1b: research-history pipeline (headless) ──
    //
    // Both pipelines are independent of each other and must complete before
    // any explorer fan-out — explorers depend on `scout.result.partitions`
    // and the aggregator embeds the history overview as supplementary
    // context. We wrap the history sub-pipeline (locator → analyzer) in an
    // IIFE so Promise.all sees it as a single awaitable.
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
          const heuristicSuffix = preflightResult.codegraphHealthy
            ? `, factor=${CODEGRAPH_EXPLORER_FACTOR}`
            : "";
          console.log(
            `[deep-research-codebase] Heuristic: explorerCount=${targetCount} (codegraphHealthy=${preflightResult.codegraphHealthy}${heuristicSuffix})`,
          );
          const partitions = partitionUnits(data.units, targetCount);
          const actualCount = partitions.length;

          const scratchDir = path.join(
            root,
            "research",
            "docs",
            `.deep-research-${startedAt.getTime()}`,
          );
          await mkdir(scratchDir, { recursive: true });

          await s.session.query(
            buildScoutPrompt({
              question: prompt,
              tree: data.tree,
              totalLoc: effectiveLoc,
              totalFiles: effectiveFiles,
              explorerCount: actualCount,
              partitionPreview: partitions,
            }),
          );
          s.save(s.sessionId);

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
      // Research-history pipeline: locator → analyzer, both headless. The
      // analyzer needs the locator's verbatim output, so this is sequential
      // INSIDE the IIFE while remaining parallel TO the codebase scout.
      (async (): Promise<string> => {
        const historyLocator = await ctx.stage(
          {
            name: "history-locator",
            headless: true,
            description: "Locate prior research docs (codebase-research-locator)",
          },
          {},
          {},
          async (s) => {
            const result = await s.session.query(
              buildHistoryLocatorPrompt({ question: prompt }),
              { agent: "codebase-research-locator", ...SUBAGENT_OPTS },
            );
            s.save(s.sessionId);
            return extractAssistantText(result, 0);
          },
        );

        const historyAnalyzer = await ctx.stage(
          {
            name: "history-analyzer",
            headless: true,
            description: "Synthesize prior research (codebase-research-analyzer)",
          },
          {},
          {},
          async (s) => {
            const result = await s.session.query(
              buildHistoryAnalyzerPrompt({
                question: prompt,
                locatorOutput: historyLocator.result,
              }),
              { agent: "codebase-research-analyzer", ...SUBAGENT_OPTS },
            );
            s.save(s.sessionId);
            return extractAssistantText(result, 0);
          },
        );

        return historyAnalyzer.result;
      })(),
    ]);

    const { partitions, explorerCount, scratchDir, totalLoc, totalFiles } =
      scout.result;

    // Pull the scout transcript ONCE so every per-partition specialist can
    // embed the architectural orientation in its prompt. The scout has
    // completed by the time we get here (we're past Promise.all), so this
    // read is safe (failure-modes F13).
    const scoutOverview = (await ctx.transcript(scout)).content;

    // ── Stage 2: batched specialist fan-out ───────────────────────────────
    //
    // Two waves, each chunked into batches of MAX_TASKS_PER_BATCH (≈10):
    //
    //   Wave 1: locator + pattern-finder (no inter-task dependencies)
    //   Wave 2: analyzer + online-researcher (read locator output from disk)
    //
    // Each batch is a single headless ctx.stage whose orchestrator turn
    // dispatches all of its tasks via the Task tool in one assistant
    // message. Specialists write their verbatim findings to per-task
    // scratch files; the orchestrator only sees per-task "DONE" tokens, so
    // batch session context stays bounded by O(tasks_per_batch). Synthesis
    // reads the per-task files from disk.

    // Per-partition output paths, computed once and reused across both wave
    // task-list construction and synthesis. Specialists write these;
    // synthesis reads them.
    const partitionPaths = buildPartitionPaths(scratchDir, partitions.length);

    // Wave 1 task list — flat across partitions and specialist kinds so the
    // chunker can fill batches uniformly. Mixed-kind batches are fine: the
    // Task tool's `subagent_type` is set per call inside the orchestrator.
    const wave1Tasks = buildLayer1Tasks(partitions, partitionPaths);
    const wave1Batches = chunkBatches(wave1Tasks, MAX_TASKS_PER_BATCH);

    // Wave 1: dispatch all batches in parallel. allSettled so a single batch
    // failure doesn't abort siblings — synthesis tolerates missing files.
    // Rejection reasons are logged so an empty report is debuggable; without
    // this, an all-failed wave would silently produce a confidently empty doc.
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
          {},
          async (s) => {
            const taskSpecs = batch.map((task) =>
              buildLayer1TaskSpec({
                task,
                question: prompt,
                scoutOverview,
                total: explorerCount,
              }),
            );

            await s.session.query(
              buildBatchOrchestratorPrompt({
                wave: 1,
                batchIndex: batchNumber,
                totalBatches: wave1Batches.length,
                tasks: taskSpecs,
              }),
              BATCH_DISPATCHER_OPTS,
            );
            s.save(s.sessionId);
          },
        );
      }),
    );
    logBatchRejections("wave1", wave1Results);

    // Read locator outputs from disk for Wave 2 prompts. Layer 2 specialists
    // embed the locator's verbatim output rather than re-discovering it.
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
          {},
          async (s) => {
            const taskSpecs = batch.map((task) =>
              buildLayer2TaskSpec({
                task,
                question: prompt,
                scoutOverview,
                total: explorerCount,
              }),
            );

            await s.session.query(
              buildBatchOrchestratorPrompt({
                wave: 2,
                batchIndex: batchNumber,
                totalBatches: wave2Batches.length,
                tasks: taskSpecs,
              }),
              BATCH_DISPATCHER_OPTS,
            );
            s.save(s.sessionId);
          },
        );
      }),
    );
    logBatchRejections("wave2", wave2Results);

    // Synthesis: read all four specialist files per partition, then write
    // the consolidated explorer scratch file the aggregator consumes.
    // Missing files fall back to "" so the synthesis tolerates partial
    // batch failures — the aggregator's prompt already handles empty
    // sections via _(no … produced)_ placeholders in renderExplorerMarkdown.
    const explorerHandles = await synthesizeExplorerHandles({
      partitions,
      paths: partitionPaths,
      locatorOutputs,
      explorerCount,
      graph,
    });

    // ── Stage 3: aggregator (visible) ─────────────────────────────────────
    //
    // Reads each partition's deterministic scratch file by PATH so the
    // aggregator's own context stays bounded by N filenames + the short
    // scout/history overviews — not by N inlined transcripts (filesystem-
    // context skill).
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
        await s.session.query(
          buildAggregatorPrompt({
            question: prompt,
            totalLoc,
            totalFiles,
            explorerCount,
            explorerFiles: explorerHandles,
            finalPath,
            scoutOverview,
            historyOverview,
          }),
        );
        s.save(s.sessionId);
      },
    );
    } finally {
      closeGraph(graph);
    }
  })
  .compile();
