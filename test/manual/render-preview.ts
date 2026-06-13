/**
 * Manual visual preview — renders the GraphView overlay to stdout so you
 * can eyeball the styling. Not part of the test suite.
 *
 * Run: bun test/manual/render-preview.ts [width] [scenario] [rows]
 *   scenario ∈ "active" (default) | "empty" | "compact" | "completed" |
 *              "failed" | "chain" | "fanout-even" | "fanout-odd" |
 *              "fanin" | "stages"
 */
import type { Store } from "../../packages/workflows/src/shared/store.js";
import type {
  StoreSnapshot,
  RunSnapshot,
  StageSnapshot,
} from "../../packages/workflows/src/shared/store-types.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";

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

function chainRun(): RunSnapshot {
  return {
    id: "run-chain-001",
    name: "chain-proof",
    inputs: {},
    status: "running",
    startedAt: Date.now() - 18_000,
    stages: [
      stage("discover", "completed", [], 18_000, 2_000),
      stage("plan", "completed", ["discover"], 16_000, 4_000),
      stage("implement", "running", ["plan"], 12_000),
      stage("verify", "pending", ["implement"]),
      stage("report", "pending", ["verify"]),
    ],
  };
}

function fanoutEvenRun(): RunSnapshot {
  return {
    id: "run-fanout-even",
    name: "fanout-even-proof",
    inputs: {},
    status: "running",
    startedAt: Date.now() - 15_000,
    stages: [
      stage("root", "completed", [], 15_000, 1_000),
      stage("api", "running", ["root"], 14_000),
      stage("db", "running", ["root"], 14_000),
      stage("ui", "pending", ["root"]),
      stage("docs", "pending", ["root"]),
    ],
  };
}

function fanoutOddRun(): RunSnapshot {
  return {
    id: "run-fanout-odd",
    name: "fanout-odd-proof",
    inputs: {},
    status: "running",
    startedAt: Date.now() - 15_000,
    stages: [
      stage("root", "completed", [], 15_000, 1_000),
      stage("linux", "running", ["root"], 14_000),
      stage("macos", "pending", ["root"]),
      stage("windows", "pending", ["root"]),
    ],
  };
}

function faninRun(): RunSnapshot {
  return {
    id: "run-fanin-001",
    name: "fanin-proof",
    inputs: {},
    status: "running",
    startedAt: Date.now() - 25_000,
    stages: [
      stage("spec", "completed", [], 25_000, 2_000),
      stage("frontend", "completed", ["spec"], 23_000, 8_000),
      stage("backend", "running", ["spec"], 23_000),
      stage("tests", "completed", ["spec"], 23_000, 5_000),
      stage("merge-review", "pending", ["frontend", "backend", "tests"]),
    ],
  };
}

const scenarios: Record<string, RunSnapshot | null> = {
  active: activeRun(),
  empty: null,
  compact: bigRun(),
  completed: completedRun(),
  failed: failedRun(),
  chain: chainRun(),
  "fanout-even": fanoutEvenRun(),
  "fanout-odd": fanoutOddRun(),
  fanin: faninRun(),
  stages: faninRun(),
};

const width = Number(process.argv[2] ?? 96);
const scenarioKey = process.argv[3] ?? "active";
const rows = Number(process.argv[4] ?? 32);
const run = scenarios[scenarioKey];

const snap: StoreSnapshot = { runs: run ? [run] : [], notices: [], version: 1 };
const store: Store = {
  runs: () => snap.runs as RunSnapshot[],
  notices: () => [],
  activeRunId: () => run?.id ?? null,
  recordRunStart: () => {},
  recordStageStart: () => {},
  recordStageWorkflowChildRun: () => false,
  recordToolStart: () => {},
  recordToolEnd: () => {},
  recordStageEnd: () => {},
  recordStageAwaitingInput: () => false,
  recordStageInputRequest: () => false,
  clearStageInputRequest: () => false,
  recordRunBlocked: () => false,
  recordRunEnd: () => false,
  removeRun: () => false,
  recordNotice: () => {},
  ackNotice: () => false,
  recordPendingPrompt: () => false,
  resolvePendingPrompt: () => false,
  awaitPendingPrompt: () => Promise.reject(new Error("preview stub")),
  recordStagePendingPrompt: () => false,
  resolveStagePendingPrompt: () => false,
  awaitStagePendingPrompt: () => Promise.reject(new Error("preview stub")),
  recordStagePromptAnswer: () => false,
  recordStagePromptDraft: () => false,
  getStagePromptDraft: () => undefined,
  clearStagePromptDraft: () => false,
  getStagePromptAnswer: () => undefined,
  clearStagePromptAnswer: () => {},
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
  getViewportRows: () => rows,
});

if (scenarioKey === "stages") {
  view.handleInput("/");
}

const lines = view.render(width);

process.stdout.write(`\n=== overlay  scenario=${scenarioKey}  width=${width}  rows=${rows} ===\n\n`);
for (const line of lines) process.stdout.write(line + "\n");
process.stdout.write("\n=== end ===\n");

view.dispose();
