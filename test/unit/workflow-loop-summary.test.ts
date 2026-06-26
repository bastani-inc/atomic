import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { buildWorkflowLoopSummary } from "../../packages/workflows/src/tui/workflow-loop-summary.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

function stage(
  id: string,
  name: string,
  status: StageSnapshot["status"] = "pending",
  parentIds: readonly string[] = [],
): StageSnapshot {
  return { id, name, status, parentIds, toolEvents: [] };
}

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: overrides.id ?? "run-1",
    name: overrides.name ?? "custom",
    inputs: overrides.inputs ?? {},
    status: overrides.status ?? "running",
    stages: overrides.stages ?? [],
    startedAt: overrides.startedAt ?? 1_000,
    endedAt: overrides.endedAt,
    result: overrides.result,
  };
}

describe("buildWorkflowLoopSummary", () => {
  test("summarizes simple sequential workflows", () => {
    const summary = buildWorkflowLoopSummary(run({
      stages: [stage("s1", "scout", "completed"), stage("s2", "plan", "running", ["s1"])],
    }));

    assert.equal(summary.oneLine, "Loop: scout → plan");
    assert.deepEqual(summary.phases, ["scout", "plan"]);
  });

  test("groups parallel fan-out and reviewer suffix names", () => {
    const summary = buildWorkflowLoopSummary(run({
      stages: [
        stage("root", "orchestrator", "completed"),
        stage("ra", "reviewer-a", "running", ["root"]),
        stage("rb", "reviewer-b", "running", ["root"]),
        stage("rc", "reviewer-c", "running", ["root"]),
      ],
    }));

    assert.match(summary.oneLine, /orchestrator → review ×3/);
    assert.doesNotMatch(summary.oneLine, /parallel/);
    assert.match(summary.detailLines.join("\n"), /review ×3 parallel/);
    assert.match(summary.detailLines.join("\n"), /parallel phases/);
  });

  test("keeps mixed parallel names compact", () => {
    const summary = buildWorkflowLoopSummary(run({
      stages: [
        stage("partition", "partition", "completed"),
        stage("locator-1", "locator-1", "running", ["partition"]),
        stage("pattern-1", "pattern-1", "running", ["partition"]),
      ],
    }));

    assert.match(summary.oneLine, /partition → locator\/pattern/);
    assert.match(summary.detailLines.join("\n"), /locator\/pattern parallel/);
  });

  test("collapses custom parallel specialist family suffixes", () => {
    const summary = buildWorkflowLoopSummary(run({
      stages: [
        stage("root", "partition", "completed"),
        stage("api-locator", "api-locator", "running", ["root"]),
        stage("api-pattern", "api-pattern", "running", ["root"]),
        stage("api-online", "api-online", "running", ["root"]),
      ],
    }));

    assert.match(summary.oneLine, /partition → api ×3/);
    assert.doesNotMatch(summary.oneLine, /api-locator\/api-pattern\/api-online/);
    assert.match(summary.detailLines.join("\n"), /api ×3 parallel/);
  });

  test("detects bounded loops from max_loops, max_turns, and max_refinements", () => {
    assert.match(buildWorkflowLoopSummary(run({
      name: "ralph",
      inputs: { max_loops: 10 },
      stages: [stage("orch2", "orchestrator-2", "running")],
    })).oneLine, /↻ 8 rounds remain/);

    assert.match(buildWorkflowLoopSummary(run({
      name: "goal",
      inputs: { max_turns: 4 },
      stages: [stage("turn1", "work-turn-1", "completed"), stage("turn2", "work-turn-2", "running")],
    })).oneLine, /↻ 2 turns remain/);

    assert.match(buildWorkflowLoopSummary(run({
      name: "open-claude-design",
      inputs: { max_refinements: 3 },
      result: { refinements_completed: 1 },
    })).oneLine, /↻ 2 refinements remain/);

    const designLoop = buildWorkflowLoopSummary(run({
      name: "open-claude-design",
      inputs: { max_refinements: 3 },
      stages: [
        stage("generate-1", "generate-1", "completed"),
        stage("user-feedback-1", "user-feedback-1", "completed", ["generate-1"]),
        stage("generate-2", "generate-2", "running", ["user-feedback-1"]),
      ],
    })).oneLine;
    assert.match(designLoop, /generate\/feedback · ↻ 1 refinements remain → export/);
  });

  test("chooses bounded-loop input by deterministic semantic priority", () => {
    const summary = buildWorkflowLoopSummary(run({
      inputs: { max_loops: 9, max_turns: 4, max_iterations: 8 },
      result: { turns_completed: 1, iterations_completed: 6 },
      stages: [stage("turn", "work-turn-1", "running")],
    }));

    assert.match(summary.oneLine, /↻ 3 turns remain/);
    assert.doesNotMatch(summary.oneLine, /rounds|iterations/);
  });

  test("uses built-in workflow fallback phases before stages are known", () => {
    assert.match(buildWorkflowLoopSummary(run({ name: "deep-research-codebase" })).oneLine, /scout \+ history-locator → history-analyzer → partition/);
    const noReferences = buildWorkflowLoopSummary(run({ name: "open-claude-design", inputs: { discover_references: false } })).oneLine;
    assert.match(noReferences, /discovery → design-system ×3 → generate\/feedback → export/);
    assert.doesNotMatch(noReferences, /references/);
  });

  test("keeps planned built-in phases visible during early live runs", () => {
    assert.match(buildWorkflowLoopSummary(run({
      name: "goal",
      inputs: { max_turns: 4, create_pr: true },
      stages: [stage("turn", "work-turn-1", "running")],
    })).oneLine, /work-turn → review ×3 · ↻ 3 turns remain · PR if complete/);

    assert.match(buildWorkflowLoopSummary(run({
      name: "ralph",
      inputs: { max_loops: 10 },
      stages: [stage("prompt", "research-prompt-refinement-1", "running")],
    })).oneLine, /prompt-refine → research → orchestrator → review ×3 · ↻ 10 rounds remain/);

    const design = buildWorkflowLoopSummary(run({
      name: "open-claude-design",
      inputs: { max_refinements: 3 },
      stages: [stage("discovery", "discovery", "running")],
    })).oneLine;
    assert.match(design, /discovery → design-system ×3 → references → generate\/feedback · ↻ 3 refinements remain → export/);
  });

  test("uses actual built-in goal phase names and PR completion wording", () => {
    const summary = buildWorkflowLoopSummary(run({
      name: "goal",
      inputs: { max_turns: 4, create_pr: true },
      stages: [
        stage("turn", "work-turn-1", "completed"),
        stage("completion", "completion-reviewer-1", "running", ["turn"]),
        stage("evidence", "evidence-reviewer-1", "running", ["turn"]),
        stage("risk", "risk-reviewer-1", "running", ["turn"]),
      ],
    })).oneLine;

    assert.match(summary, /work-turn → review ×3/);
    assert.match(summary, /PR if complete/);
    assert.doesNotMatch(summary, /completion-reviewer|evidence-reviewer|risk-reviewer|PR if approved/);
  });

  test("summarizes deep-research partition waves by partition count", () => {
    const stages: StageSnapshot[] = [
      stage("scout", "codebase-scout", "completed"),
      stage("history", "history-locator", "completed"),
      stage("partition", "partition", "completed"),
    ];
    for (let i = 1; i <= 3; i++) {
      stages.push(stage(`locator-${i}`, `locator-${i}`, "completed", ["partition"]));
      stages.push(stage(`pattern-${i}`, `pattern-finder-${i}`, "completed", ["partition"]));
      stages.push(stage(`analyzer-${i}`, `analyzer-${i}`, "running", [`locator-${i}`]));
      stages.push(stage(`online-${i}`, `online-researcher-${i}`, "running", [`locator-${i}`]));
    }
    stages.push(stage("aggregator", "aggregator", "pending"));
    const summary = buildWorkflowLoopSummary(run({ name: "deep-research-codebase", stages })).oneLine;

    assert.match(summary, /scout \+ history → partition → locator\/pattern ×3 → analyzer\/online ×3 → aggregator/);
    assert.doesNotMatch(summary, /×6|pattern-finder|online-researcher/);
  });

  test("groups root-level parallel fan-out without treating suffixes as loop turns", () => {
    const summary = buildWorkflowLoopSummary(run({
      inputs: { max_loops: 5 },
      stages: [
        stage("worker-1", "worker-1", "completed"),
        stage("worker-2", "worker-2", "running"),
        stage("worker-3", "worker-3", "pending"),
      ],
    }));

    assert.match(summary.oneLine, /Loop: worker ×3 · ↻ 5 rounds remain/);
    assert.match(summary.detailLines.join("\n"), /worker ×3 parallel/);

    const mixedNames = buildWorkflowLoopSummary(run({
      stages: [stage("scout", "scout", "completed"), stage("history", "history-locator", "running")],
    }));
    assert.match(mixedNames.oneLine, /scout\/history/);
    assert.match(mixedNames.detailLines.join("\n"), /parallel/);
    assert.doesNotMatch(mixedNames.oneLine, /scout → history/);
  });

  test("counts generic sequential bounded loop suffixes", () => {
    assert.match(buildWorkflowLoopSummary(run({
      inputs: { max_iterations: 5 },
      stages: [
        stage("cycle-1", "cycle-1", "completed"),
        stage("cycle-2", "cycle-2", "running", ["cycle-1"]),
      ],
    })).oneLine, /↻ 3 iterations remain/);

    assert.match(buildWorkflowLoopSummary(run({
      inputs: { max_loops: 4 },
      stages: [
        stage("draft-1", "draft-1", "completed"),
        stage("draft-2", "draft-2", "running", ["draft-1"]),
      ],
    })).oneLine, /↻ 2 rounds remain/);
  });

  test("keeps open-claude-design refinement hint before export when compressed", () => {
    const line = buildWorkflowLoopSummary(run({
      name: "open-claude-design",
      inputs: { max_refinements: 3 },
      result: { refinements_completed: 1 },
    }), { width: 64 }).oneLine;

    assert.ok(visibleWidth(line) <= 64, line);
    assert.match(line, /generate\/feedback · ↻ 2 left → export/);
    assert.doesNotMatch(line, /export · ↻ 2 left/);
  });

  test("reports no-stage custom runs without fake future stages", () => {
    const summary = buildWorkflowLoopSummary(run({ stages: [] }));
    assert.equal(summary.oneLine, "Loop: waiting for stages");
    assert.deepEqual(summary.phases, []);
  });

  test("covers terminal and non-terminal statuses without changing phase derivation", () => {
    for (const status of ["completed", "failed", "blocked", "awaiting_input", "cancelled", "skipped"] as const) {
      const stageStatus = status === "cancelled" ? "skipped" : status === "awaiting_input" ? "awaiting_input" : status === "completed" || status === "failed" || status === "blocked" || status === "skipped" ? status : "pending";
      const summary = buildWorkflowLoopSummary(run({
        status: status === "awaiting_input" ? "running" : status,
        stages: [stage("s", "worker-1", stageStatus)],
      }));
      assert.match(summary.oneLine, /Loop: worker/);
    }
  });

  test("fits overflow deterministically at multiple widths", () => {
    const source = run({
      inputs: { max_loops: 10, create_pr: true },
      stages: [
        stage("p", "prompt-refinement-1"),
        stage("r", "research-1", "completed", ["p"]),
        stage("o", "orchestrator-2", "running", ["r"]),
        stage("a", "reviewer-a", "running", ["o"]),
        stage("b", "reviewer-b", "running", ["o"]),
        stage("c", "reviewer-c", "running", ["o"]),
      ],
    });

    for (const width of [32, 56, 96]) {
      const line = buildWorkflowLoopSummary(source, { width }).oneLine;
      assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    }
    assert.match(buildWorkflowLoopSummary(source, { width: 56 }).oneLine, /Loop: \d+ phases|…|↻ 8 left/);
  });
});
