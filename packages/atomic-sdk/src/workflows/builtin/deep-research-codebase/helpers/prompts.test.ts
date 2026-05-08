import { test, expect } from "bun:test";
import { buildScoutPrompt, buildAggregatorPrompt } from "./prompts.ts";
import type { PartitionUnit } from "./scout.ts";

const unit: PartitionUnit = {
  path: "src",
  loc: 100,
  fileCount: 5,
  files: ["src/index.ts"],
};

test("buildScoutPrompt embeds ast-grep tooling paragraph", () => {
  const result = buildScoutPrompt({
    question: "Where is auth handled?",
    tree: "src/\n  index.ts",
    totalLoc: 100,
    totalFiles: 5,
    explorerCount: 1,
    partitionPreview: [[unit]],
  });

  expect(result).toContain("ast-grep");
  expect(result).toContain("scout has no MCP tools");
});

test("buildAggregatorPrompt preserves Callers/Impact verbatim instruction", () => {
  const result = buildAggregatorPrompt({
    question: "How does auth work?",
    totalLoc: 1000,
    totalFiles: 50,
    explorerCount: 2,
    explorerFiles: [
      { index: 1, scratchPath: "/tmp/p1.md", partition: [unit] },
      { index: 2, scratchPath: "/tmp/p2.md", partition: [unit] },
    ],
    finalPath: "/tmp/research.md",
    scoutOverview: "Overview of auth.",
    historyOverview: "Prior art on auth.",
  });

  // METHOD block must instruct to preserve Callers/Impact verbatim
  expect(result).toContain("## Callers");
  expect(result).toContain("## Impact");
  expect(result).toContain("Preserve them verbatim");

  // OUTPUT_FORMAT must include the deterministic section slot
  expect(result).toContain("## Callers & Impact (Deterministic)");
});
