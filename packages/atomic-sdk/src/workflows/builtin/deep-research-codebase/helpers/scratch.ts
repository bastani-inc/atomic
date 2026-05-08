/**
 * Deterministic synthesis of per-partition explorer scratch files.
 *
 * Each partition is investigated by four specialist sub-agents dispatched
 * directly via the provider SDK's `agent` parameter:
 *
 *   - codebase-locator           → file index for the partition
 *   - codebase-pattern-finder    → reusable code patterns in the partition
 *   - codebase-analyzer          → how the most relevant impl files work
 *   - codebase-online-researcher → external library docs (when central)
 *
 * Rather than spawn a fifth "synthesizer" LLM stage just to concatenate four
 * markdown sections, we do that synthesis in plain TypeScript here. This keeps
 * the per-partition cost at exactly four LLM calls and avoids burning tokens
 * on a step whose output is fully determined by its inputs.
 *
 * The file we write is the canonical handoff to the aggregator — it MUST keep
 * the heading shape that buildAggregatorPrompt() promises ("Scope / Files in
 * Scope / How It Works / Patterns / External References / Out-of-Partition
 * References"), or the aggregator will look for sections that don't exist.
 *
 * §5.6 Scratch Synthesis Upgrade: when codegraphHealthy is true the "Callers"
 * and "Impact" sections are produced DETERMINISTICALLY by calling
 * cg.getCallers(symbolId) and cg.getImpactRadius(symbolId, depth) from the
 * @colbymchenry/codegraph library API. When unhealthy these sections are
 * omitted (fallback = the aggregator's LLM stage covers them from raw text).
 *
 * NOTE: the codegraph library exposes getCallers(nodeId, maxDepth?) returning
 * Array<{node, edge}> and getImpactRadius(nodeId, maxDepth?) returning
 * Subgraph — names verified against
 * node_modules/@colbymchenry/codegraph/dist/index.d.ts.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { CodeGraph, Edge, Node, Subgraph } from "@colbymchenry/codegraph";
import type { PartitionUnit } from "./scout.ts";

type BaseExplorerSections = {
  index: number;
  total: number;
  partition: PartitionUnit[];
  /** Full assistant text from the codebase-locator sub-agent. */
  locatorOutput: string;
  /** Full assistant text from the codebase-pattern-finder sub-agent. */
  patternsOutput: string;
  /** Full assistant text from the codebase-analyzer sub-agent. */
  analyzerOutput: string;
  /** Full assistant text from the codebase-online-researcher sub-agent. */
  onlineOutput: string;
};

/**
 * When `codegraphHealthy` is true the synthesis pipeline calls
 * `cg.getCallers` / `cg.getImpactRadius` for deterministic "Callers" /
 * "Impact" sections. The caller (orchestrator) opens the CodeGraph handle
 * once and threads it through here. When false those sections are omitted —
 * the aggregator's LLM stage covers them from raw specialist text.
 */
export type ExplorerSections =
  | (BaseExplorerSections & { codegraphHealthy: true; graph: CodeGraph })
  | (BaseExplorerSections & { codegraphHealthy: false });

/**
 * Build the discriminated-union tail of an `ExplorerSections` value from a
 * possibly-null CodeGraph handle. Used by orchestrators to keep the explorer
 * synthesis call site free of inline ternaries.
 */
export function graphHealth(
  graph: CodeGraph | null,
):
  | { codegraphHealthy: true; graph: CodeGraph }
  | { codegraphHealthy: false } {
  return graph !== null
    ? { codegraphHealthy: true, graph }
    : { codegraphHealthy: false };
}

/** Heuristic: detect the "no external research applicable" sentinel. */
function isOnlineSkip(output: string): boolean {
  return /\(\s*no external research applicable\s*\)/i.test(output);
}

// ---------------------------------------------------------------------------
// §5.6 — Deterministic Callers / Impact synthesis via CodeGraph library API
// ---------------------------------------------------------------------------

/**
 * Extract symbol IDs referenced inside specialist output text.
 *
 * Specialists embed codegraph symbol references in the form
 * `[symbol:<id>]` when codegraph MCP tools are available. This helper
 * collects those IDs so we can drive deterministic graph queries without
 * restructuring the rest of the pipeline.
 *
 * Example match: `[symbol:abc123def456]`
 */
export function extractSymbolIds(text: string): string[] {
  const seen = new Set<string>();
  const pattern = /\[symbol:([a-zA-Z0-9_\-:/.]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[1] !== undefined) seen.add(match[1]);
  }
  return Array.from(seen);
}

/**
 * Render a markdown table subsection. Returns the empty-state stub when
 * `rows` is empty so callers don't have to special-case it.
 */
function renderTableSubsection(
  heading: string,
  emptyMessage: string,
  headers: [string, string, string],
  rows: string[],
): string {
  if (rows.length === 0) {
    return [`### ${heading}`, `_(${emptyMessage})_`, ``].join("\n");
  }
  const [h1, h2, h3] = headers;
  const sep = headers.map(() => "------").join("|");
  return [
    `### ${heading}`,
    `| ${h1} | ${h2} | ${h3} |`,
    `|${sep}|`,
    rows.join("\n"),
    ``,
  ].join("\n");
}

/** Render the deterministic "Callers" subsection for one symbol. */
function renderCallersSubsection(
  symbolId: string,
  callers: Array<{ node: Node; edge: Edge }>,
): string {
  const rows = callers.map(({ node, edge }) => {
    const loc = edge.line != null ? `:${edge.line}` : "";
    return `| \`${node.qualifiedName}\` | ${node.kind} | \`${node.filePath}${loc}\` |`;
  });
  return renderTableSubsection(
    `Callers of \`${symbolId}\``,
    "no callers found in graph",
    ["Caller", "Kind", "Location"],
    rows,
  );
}

/** Render the deterministic "Impact" subsection for one symbol. */
function renderImpactSubsection(symbolId: string, subgraph: Subgraph): string {
  const rows = Array.from(subgraph.nodes.values()).map(
    (n) => `| \`${n.qualifiedName}\` | ${n.kind} | \`${n.filePath}\` |`,
  );
  return renderTableSubsection(
    `Impact of \`${symbolId}\``,
    "no impacted nodes found in graph",
    ["Symbol", "Kind", "File"],
    rows,
  );
}

/** Maximum graph traversal depth for impact radius queries. */
const IMPACT_DEPTH = 3;

/**
 * Query CodeGraph for callers and impact of every symbol ID found in the
 * specialist outputs. Returns combined markdown for the two deterministic
 * sections, or null if no symbol IDs were found.
 *
 * The caller (orchestrator) owns the graph lifecycle — do NOT open or close
 * inside this function.
 */
async function buildDeterministicGraphSections(
  graph: CodeGraph,
  symbolIds: string[],
): Promise<string | null> {
  if (symbolIds.length === 0) return null;
  const callersParts: string[] = [];
  const impactParts: string[] = [];
  for (const id of symbolIds) {
    callersParts.push(renderCallersSubsection(id, graph.getCallers(id)));
    impactParts.push(renderImpactSubsection(id, graph.getImpactRadius(id, IMPACT_DEPTH)));
  }
  return [
    `## Callers`,
    `<!-- Source: deterministic CodeGraph library API (getCallers) -->`,
    ...callersParts,
    `## Impact`,
    `<!-- Source: deterministic CodeGraph library API (getImpactRadius depth=${IMPACT_DEPTH}) -->`,
    ...impactParts,
  ].join("\n");
}

// ---------------------------------------------------------------------------

/** Render the base markdown sections deterministically (sync portion). */
function renderBaseMarkdown(sections: ExplorerSections): string {
  const scope = sections.partition
    .map(
      (u) =>
        `\`${u.path}/\` (${u.fileCount} files, ${u.loc.toLocaleString()} LOC)`,
    )
    .join(", ");

  const lines: string[] = [
    `# Partition ${sections.index} of ${sections.total} — Findings`,
    ``,
    `## Scope`,
    scope,
    ``,
    `## Files in Scope`,
    `<!-- Source: codebase-locator sub-agent -->`,
    sections.locatorOutput.trim() || "_(no files located)_",
    ``,
    `## How It Works`,
    `<!-- Source: codebase-analyzer sub-agent -->`,
    sections.analyzerOutput.trim() || "_(no analysis produced)_",
    ``,
    `## Patterns`,
    `<!-- Source: codebase-pattern-finder sub-agent -->`,
    sections.patternsOutput.trim() || "_(no patterns surfaced)_",
    ``,
  ];

  // Only include the External References section when the online researcher
  // actually returned external findings — its skip sentinel would otherwise
  // pollute the aggregator's view of "evidence collected".
  if (
    sections.onlineOutput.trim().length > 0 &&
    !isOnlineSkip(sections.onlineOutput)
  ) {
    lines.push(
      `## External References`,
      `<!-- Source: codebase-online-researcher sub-agent -->`,
      sections.onlineOutput.trim(),
      ``,
    );
  }

  // Out-of-partition references live in the analyzer output already, but we
  // surface a brief pointer for the aggregator's cross-stitching pass.
  lines.push(
    `## Out-of-Partition References`,
    `Look for the **Out-of-Partition References** subsection inside the`,
    `"How It Works" section above — that is where the analyzer flagged files`,
    `outside this partition that other partitions should examine.`,
    ``,
  );

  return lines.join("\n");
}

/**
 * Render the markdown body deterministically.
 *
 * When `codegraphHealthy` is true, "Callers" and "Impact" sections are
 * appended via the CodeGraph library API (§5.6 healthy branch). Otherwise
 * those sections are omitted — the aggregator's LLM stage covers them from
 * raw specialist text (§5.6 unhealthy branch).
 */
export async function renderExplorerMarkdown(
  sections: ExplorerSections,
): Promise<string> {
  let md = renderBaseMarkdown(sections);

  if (sections.codegraphHealthy) {
    const allText = [
      sections.locatorOutput,
      sections.patternsOutput,
      sections.analyzerOutput,
    ].join("\n");
    const symbolIds = extractSymbolIds(allText);
    const graphSections = await buildDeterministicGraphSections(
      sections.graph,
      symbolIds,
    );
    if (graphSections != null) md += graphSections;
  }

  return md;
}

/**
 * Write a partition's deterministic scratch file. Returns the absolute path so
 * the caller can record it in the explorer manifest the aggregator reads.
 */
export async function writeExplorerScratchFile(
  scratchPath: string,
  sections: ExplorerSections,
): Promise<string> {
  const abs = path.resolve(scratchPath);
  const md = await renderExplorerMarkdown(sections);
  await writeFile(abs, md, "utf8");
  return abs;
}
