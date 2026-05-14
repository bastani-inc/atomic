/**
 * Manual visual preview — renders the GraphView overlay to stdout so you
 * can eyeball the styling. Not part of the test suite.
 *
 * Run:  node --experimental-transform-types --import ./test/support/register-loader.mjs test/manual/render-preview.ts [width] [scenario]
 *   scenario ∈ "active" (default) | "empty" | "compact" | "completed" | "failed"
 */
import type { Store } from "../../src/shared/store.js";
import type {
  StoreSnapshot,
  RunSnapshot,
  StageSnapshot,
} from "../../src/shared/store-types.js";
import { GraphView } from "../../src/tui/graph-view.js";
import { deriveGraphTheme } from "../../src/tui/graph-theme.js";

function stage(
  id: string,
  status: StageSnapshot["status"],
  parents: string[] = [],
  startedAgo?: number,
  durationMs?: number,
): StageSnapshot {
  return {
    id,
    name: id,
    status,
    parentIds: parents,
    toolEvents: [],
    startedAt: startedAgo != null ? Date.now() - startedAgo : undefined,
    durationMs,
    result: status === "completed" ? `result of ${id}` : undefined,
  };
}

function activeRun(): RunSnapshot {
  return {
    id: "run-abc123def",
    name: "deep-research-codebase",
    inputs: { prompt: "How does session persistence work?" },
    status: "running",
    startedAt: Date.now() - 42_000,
    stages: [
      stage("scout", "completed", [], 42_000, 12_000),
      stage("auth-specialist", "completed", ["scout"], 30_000, 9_000),
      stage("db-specialist", "running", ["scout"], 30_000),
      stage("api-specialist", "pending", ["scout"]),
      stage("aggregator", "pending", ["auth-specialist", "db-specialist", "api-specialist"]),
    ],
  };
}

function completedRun(): RunSnapshot {
  return {
    id: "run-done-001",
    name: "summarize-pr",
    inputs: { pr_url: "https://example.com/pr/42" },
    status: "completed",
    startedAt: Date.now() - 65_000,
    durationMs: 64_000,
    stages: [stage("summarize", "completed", [], 65_000, 64_000)],
  };
}

function failedRun(): RunSnapshot {
  return {
    id: "run-fail-007",
    name: "ralph",
    inputs: { prompt: "Migrate db" },
    status: "failed",
    startedAt: Date.now() - 12_000,
    durationMs: 11_500,
    error: "ECONNRESET while talking to provider",
    stages: [
      stage("plan", "completed", [], 12_000, 4_000),
      { ...stage("execute", "failed", ["plan"], 8_000, 7_000), error: "ECONNRESET" },
    ],
  };
}

function bigRun(): RunSnapshot {
  return {
    id: "run-large-9000",
    name: "wide-pipeline",
    inputs: {},
    status: "running",
    startedAt: Date.now() - 8_000,
    stages: [
      stage("root", "completed", [], 8_000, 1_000),
      stage("a", "running", ["root"], 7_000),
      stage("b", "running", ["root"], 7_000),
      stage("c", "running", ["root"], 7_000),
      stage("d", "pending", ["root"]),
      stage("e", "pending", ["root"]),
      stage("f", "pending", ["root"]),
      stage("g", "pending", ["root"]),
      stage("h", "pending", ["root"]),
      stage("final", "pending", ["a", "b", "c", "d", "e", "f", "g", "h"]),
    ],
  };
}

const scenarios: Record<string, RunSnapshot | null> = {
  active: activeRun(),
  empty: null,
  compact: bigRun(),
  completed: completedRun(),
  failed: failedRun(),
};

const width = Number(process.argv[2] ?? 96);
const scenarioKey = process.argv[3] ?? "active";
const run = scenarios[scenarioKey];

const snap: StoreSnapshot = { runs: run ? [run] : [], notices: [], version: 1 };
const store: Store = {
  runs: () => snap.runs as RunSnapshot[],
  notices: () => [],
  activeRunId: () => run?.id ?? null,
  recordRunStart: () => {},
  recordStageStart: () => {},
  recordToolStart: () => {},
  recordToolEnd: () => {},
  recordStageEnd: () => {},
  recordStageAwaitingInput: () => false,
  recordRunEnd: () => false,
  recordNotice: () => {},
  ackNotice: () => false,
  recordPendingPrompt: () => false,
  resolvePendingPrompt: () => false,
  awaitPendingPrompt: () => Promise.reject(new Error("preview stub")),
  recordStageSession: () => false,
  recordStageAttachable: () => false,
  recordStageAttached: () => false,
  recordStageBlocked: () => false,
  recordStageUnblocked: () => false,
  recordStageNotice: () => false,
  recordStagePaused: () => false,
  recordStageResumed: () => false,
  recordRunPaused: () => false,
  recordRunResumed: () => false,
  snapshot: () => snap,
  clear: () => {},
  subscribe: () => () => {},
};

const view = new GraphView({
  mode: "overlay",
  runId: run?.id ?? null,
  store,
  graphTheme: deriveGraphTheme({}),
  onClose: () => {},
});

const lines = view.render(width);

process.stdout.write(`\n=== overlay  scenario=${scenarioKey}  width=${width} ===\n\n`);
for (const line of lines) process.stdout.write(line + "\n");
process.stdout.write("\n=== end ===\n");

view.dispose();
