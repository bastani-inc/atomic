/**
 * Shared orchestration helpers used by the three SDK index.ts variants
 * (claude / copilot / opencode). Keeping these in one place prevents the
 * variants from drifting on cross-cutting concerns like file I/O fallbacks,
 * batch-failure logging, partition-path construction, and explorer synthesis.
 */

import CodeGraph from "@colbymchenry/codegraph";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  SUBAGENT_TYPE,
  type Layer1Task,
  type Layer2Task,
} from "./batching.ts";
import {
  buildAnalyzerPrompt,
  buildLocatorPrompt,
  buildOnlineResearcherPrompt,
  buildPatternFinderPrompt,
  wrapPromptForTaskDispatch,
} from "./prompts.ts";
import { graphHealth, writeExplorerScratchFile } from "./scratch.ts";
import type { PartitionUnit, SourceFile } from "./scout.ts";

/** Read a file as UTF-8, returning empty string if missing or unreadable. */
export async function safeReadFile(absPath: string): Promise<string> {
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
export function logBatchRejections(
  label: string,
  results: PromiseSettledResult<unknown>[],
): void {
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(
        `[deep-research-codebase] ${label} batch ${i + 1} failed:`,
        r.reason,
      );
    }
  });
}

/**
 * Resolve the file count and LOC the workflow should use for partitioning,
 * and emit the standard "[deep-research-codebase] CodeGraph: file walk via …"
 * log line.
 *
 * When CodeGraph is healthy we prefer its file walk for the file count, but
 * `FileRecord` has no `lineCount` field — every entry's `loc` is 0 — so we
 * fall back to scout's `wc -l` total in that case. When CodeGraph is absent
 * scout's totals are used directly.
 */
export function resolveEffectiveCounts(opts: {
  graph: CodeGraph | null;
  fileWalk: SourceFile[];
  scoutTotalFiles: number;
  scoutTotalLoc: number;
}): { effectiveFiles: number; effectiveLoc: number } {
  const cgFileCount = opts.fileWalk.length;
  const cgTotalLoc = opts.fileWalk.reduce((s, f) => s + f.loc, 0);
  const usingGraph = opts.graph !== null;

  console.log(
    usingGraph
      ? `[deep-research-codebase] CodeGraph: file walk via cg.getFiles (${cgFileCount} files)`
      : `[deep-research-codebase] CodeGraph: file walk via git ls-files (${opts.scoutTotalFiles} files)`,
  );

  return {
    effectiveFiles: usingGraph ? cgFileCount : opts.scoutTotalFiles,
    effectiveLoc:
      usingGraph && cgTotalLoc === 0 ? opts.scoutTotalLoc : cgTotalLoc,
  };
}

/** Per-partition output paths consumed by Layer 1/2 specialists and synthesis. */
export type PartitionPaths = {
  locator: string;
  patternFinder: string;
  analyzer: string;
  online: string;
  explorer: string;
};

/** Build the per-partition output-path table once. Indexed by partition position. */
export function buildPartitionPaths(
  scratchDir: string,
  count: number,
): PartitionPaths[] {
  return Array.from({ length: count }, (_, idx) => {
    const i = idx + 1;
    return {
      locator: path.join(scratchDir, `locator-${i}.md`),
      patternFinder: path.join(scratchDir, `pattern-finder-${i}.md`),
      analyzer: path.join(scratchDir, `analyzer-${i}.md`),
      online: path.join(scratchDir, `online-${i}.md`),
      explorer: path.join(scratchDir, `explorer-${i}.md`),
    };
  });
}

/** Wave 1 task list (locator + pattern-finder per partition). */
export function buildLayer1Tasks(
  partitions: PartitionUnit[][],
  paths: PartitionPaths[],
): Layer1Task[] {
  return partitions.flatMap((partition, idx) => {
    const i = idx + 1;
    const p = paths[idx]!;
    return [
      { kind: "locator", partitionIndex: i, partition, outputPath: p.locator },
      {
        kind: "pattern-finder",
        partitionIndex: i,
        partition,
        outputPath: p.patternFinder,
      },
    ];
  });
}

/** Wave 2 task list (analyzer + online-researcher per partition). */
export function buildLayer2Tasks(
  partitions: PartitionUnit[][],
  paths: PartitionPaths[],
  locatorOutputs: Map<number, string>,
): Layer2Task[] {
  return partitions.flatMap((partition, idx) => {
    const i = idx + 1;
    const p = paths[idx]!;
    const locatorOutput = locatorOutputs.get(i) ?? "";
    return [
      {
        kind: "analyzer",
        partitionIndex: i,
        partition,
        outputPath: p.analyzer,
        locatorOutput,
      },
      {
        kind: "online-researcher",
        partitionIndex: i,
        partition,
        outputPath: p.online,
        locatorOutput,
      },
    ];
  });
}

/**
 * Read every partition's locator output into a 1-indexed map. Missing files
 * collapse to "" via safeReadFile so partial Wave-1 failures don't abort
 * Wave-2 prompt construction.
 */
export async function readLocatorOutputs(
  paths: PartitionPaths[],
): Promise<Map<number, string>> {
  const outputs = new Map<number, string>();
  await Promise.all(
    paths.map(async (p, idx) => {
      outputs.set(idx + 1, await safeReadFile(p.locator));
    }),
  );
  return outputs;
}

/** Per-task envelope handed to the batch dispatcher's Task tool. */
export type TaskSpec = {
  subagentType: string;
  outputPath: string;
  prompt: string;
};

/** Wrap a built specialist prompt + task into the dispatch envelope. */
function wrapTaskSpec(
  task: Layer1Task | Layer2Task,
  specialistPrompt: string,
): TaskSpec {
  return {
    subagentType: SUBAGENT_TYPE[task.kind],
    outputPath: task.outputPath,
    prompt: wrapPromptForTaskDispatch({
      specialistPrompt,
      outputPath: task.outputPath,
      agentLabel: task.kind.toUpperCase().replaceAll("-", "_"),
    }),
  };
}

/** Build a Wave 1 (locator | pattern-finder) task spec for the dispatcher. */
export function buildLayer1TaskSpec(opts: {
  task: Layer1Task;
  question: string;
  scoutOverview: string;
  total: number;
}): TaskSpec {
  const { task: t, question, scoutOverview, total } = opts;
  const builder =
    t.kind === "locator" ? buildLocatorPrompt : buildPatternFinderPrompt;
  return wrapTaskSpec(
    t,
    builder({
      question,
      partition: t.partition,
      scoutOverview,
      index: t.partitionIndex,
      total,
    }),
  );
}

/** Build a Wave 2 (analyzer | online-researcher) task spec for the dispatcher. */
export function buildLayer2TaskSpec(opts: {
  task: Layer2Task;
  question: string;
  scoutOverview: string;
  total: number;
}): TaskSpec {
  const { task: t, question, scoutOverview, total } = opts;
  const specialistPrompt =
    t.kind === "analyzer"
      ? buildAnalyzerPrompt({
          question,
          partition: t.partition,
          locatorOutput: t.locatorOutput,
          scoutOverview,
          index: t.partitionIndex,
          total,
        })
      : buildOnlineResearcherPrompt({
          question,
          partition: t.partition,
          locatorOutput: t.locatorOutput,
          index: t.partitionIndex,
          total,
        });
  return wrapTaskSpec(t, specialistPrompt);
}

export type ExplorerHandle = {
  index: number;
  scratchPath: string;
  partition: PartitionUnit[];
};

/**
 * Per partition: read the four specialist scratch files and write the
 * consolidated explorer scratch file the aggregator consumes. Locator output
 * is reused from the wave-2 prep map instead of re-reading from disk. Missing
 * files fall back to "" so partial batch failures degrade gracefully.
 */
export async function synthesizeExplorerHandles(opts: {
  partitions: PartitionUnit[][];
  paths: PartitionPaths[];
  locatorOutputs: Map<number, string>;
  explorerCount: number;
  graph: CodeGraph | null;
}): Promise<ExplorerHandle[]> {
  const tail = graphHealth(opts.graph);
  return Promise.all(
    opts.partitions.map(async (partition, idx) => {
      const i = idx + 1;
      const p = opts.paths[idx]!;
      const [patternsOutput, analyzerOutput, onlineOutput] = await Promise.all([
        safeReadFile(p.patternFinder),
        safeReadFile(p.analyzer),
        safeReadFile(p.online),
      ]);
      await writeExplorerScratchFile(p.explorer, {
        index: i,
        total: opts.explorerCount,
        partition,
        locatorOutput: opts.locatorOutputs.get(i) ?? "",
        patternsOutput,
        analyzerOutput,
        onlineOutput,
        ...tail,
      });
      return { index: i, scratchPath: p.explorer, partition };
    }),
  );
}

/**
 * Open the workflow-scope CodeGraph handle (read-only) when preflight reported
 * a healthy graph. Any throw is logged and degraded to `null` — the workflow
 * proceeds with the legacy file walk. preflight already verified the graph
 * exists; an open-throw here is a transient race we tolerate, not a bug.
 */
export async function openGraphForRun(
  root: string,
  healthy: boolean,
): Promise<CodeGraph | null> {
  if (!healthy) {
    console.log("[codegraph] skipped — using legacy file walk");
    return null;
  }
  try {
    const graph = await CodeGraph.open(root, { readOnly: true });
    console.log("[codegraph] handle opened (readOnly)");
    return graph;
  } catch (e) {
    console.warn(
      `[codegraph] open failed after healthy preflight: ${(e as Error).message}; falling back to legacy file walk`,
    );
    return null;
  }
}

/**
 * Close the workflow-scope CodeGraph handle. Errors are logged but never
 * propagate — a close throw must not mask a successful workflow return value.
 * No-op when the handle is null (preflight unhealthy or open guarded-failed).
 */
export function closeGraph(graph: CodeGraph | null): void {
  if (graph === null) return;
  try {
    graph.close();
    console.log("[codegraph] handle closed");
  } catch (e) {
    console.error(
      `[codegraph] close failed (ignored): ${(e as Error).message}`,
    );
  }
}
