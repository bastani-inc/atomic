/**
 * Background-workflow widget: model + thinking-level transparency.
 *
 * Split out of widget-rendering.test.ts to keep each test file within the
 * 500-line gate. Covers the widget's model segment: the active stage's
 * `<model> <thinking> [fast]` (mirroring the main-session footer) and the
 * deduped, capped list rendered when parallel stages use differing models.
 *
 * cross-ref: src/tui/widget-model-label.ts · src/tui/widget.ts `metaLine`
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { renderWidgetLines } from "../../packages/workflows/src/tui/widget.js";
import type {
  StoreSnapshot,
  RunSnapshot,
  StageSnapshot,
} from "../../packages/workflows/src/shared/store-types.js";

function makeStage(
  id: string,
  name: string,
  status: StageSnapshot["status"],
  extra?: { model?: string; thinkingLevel?: string; fastMode?: boolean },
): StageSnapshot {
  return {
    id,
    name,
    status,
    parentIds: [],
    toolEvents: [],
    ...(extra?.model !== undefined ? { model: extra.model } : {}),
    ...(extra?.thinkingLevel !== undefined ? { thinkingLevel: extra.thinkingLevel } : {}),
    ...(extra?.fastMode !== undefined ? { fastMode: extra.fastMode } : {}),
  };
}

function makeRun(
  id: string,
  name: string,
  status: RunSnapshot["status"],
  stages: StageSnapshot[] = [],
  startedAt = Date.now() - 5000,
): RunSnapshot {
  return { id, name, inputs: {}, status, stages, startedAt };
}

function makeSnap(runs: RunSnapshot[]): StoreSnapshot {
  return { runs, notices: [], version: 1 };
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

describe("renderWidgetLines — model + thinking level", () => {
  test("running single-stage task shows the active stage's model", () => {
    const run = makeRun("t1xxxxxx", "wf-model", "running", [
      makeStage("s1", "task", "running", { model: "openai/gpt-5" }),
    ]);
    const metaLine = renderWidgetLines(makeSnap([run]), 120).map(stripAnsi)[2]!;
    assert.ok(metaLine.includes("single"), "keeps the mode segment");
    assert.ok(metaLine.includes("openai/gpt-5"), `model shown, got: ${metaLine}`);
  });

  test("appends the thinking level after the model when set", () => {
    const run = makeRun("t2xxxxxx", "wf-think", "running", [
      makeStage("s1", "task", "running", { model: "openai/gpt-5", thinkingLevel: "high" }),
    ]);
    const metaLine = renderWidgetLines(makeSnap([run]), 120).map(stripAnsi)[2]!;
    assert.ok(metaLine.includes("openai/gpt-5 high"), `model + thinking shown, got: ${metaLine}`);
  });

  test("omits the thinking level when off (mirrors main footer)", () => {
    const run = makeRun("t3xxxxxx", "wf-off", "running", [
      makeStage("s1", "task", "running", { model: "openai/gpt-5", thinkingLevel: "off" }),
    ]);
    const metaLine = renderWidgetLines(makeSnap([run]), 120).map(stripAnsi)[2]!;
    assert.ok(metaLine.includes("openai/gpt-5"), "model still shown");
    assert.ok(!metaLine.includes("off"), `"off" level is not rendered, got: ${metaLine}`);
  });

  test("chain surfaces the currently running stage's model", () => {
    const run = makeRun("t4xxxxxx", "wf-chain", "running", [
      makeStage("s1", "scout", "completed", { model: "anthropic/haiku" }),
      makeStage("s2", "worker", "running", { model: "anthropic/opus", thinkingLevel: "medium" }),
      makeStage("s3", "finish", "pending"),
    ]);
    const metaLine = renderWidgetLines(makeSnap([run]), 160).map(stripAnsi)[2]!;
    assert.ok(metaLine.includes("chain"), "reads as a chain");
    assert.ok(metaLine.includes("anthropic/opus medium"), `running stage model wins, got: ${metaLine}`);
    assert.ok(!metaLine.includes("haiku"), "does not show a completed earlier stage's model");
  });

  test("omits the model segment entirely when no stage has recorded one", () => {
    const run = makeRun("t5xxxxxx", "wf-none", "running", [
      makeStage("s1", "task", "running"),
    ]);
    const metaLine = renderWidgetLines(makeSnap([run]), 120).map(stripAnsi)[2]!;
    // Unchanged shape: mode (· progress) · duration, no stray separators.
    assert.ok(metaLine.includes("single"), "still shows mode");
    assert.doesNotMatch(metaLine, /· ·/, "no empty model segment");
  });

  test("running fast-tier task appends the fast marker (footer parity)", () => {
    const run = makeRun("t6xxxxxx", "wf-fast", "running", [
      makeStage("s1", "task", "running", { model: "openai/gpt-5.1-codex", thinkingLevel: "high", fastMode: true }),
    ]);
    const metaLine = renderWidgetLines(makeSnap([run]), 120).map(stripAnsi)[2]!;
    assert.ok(
      metaLine.includes("openai/gpt-5.1-codex high fast"),
      `fast marker appended after model + thinking, got: ${metaLine}`,
    );
  });

  test("parallel stages on different models list them deduped and capped", () => {
    const run = makeRun("t7xxxxxx", "wf-fan", "running", [
      makeStage("s1", "a", "running", { model: "openai/gpt-5" }),
      makeStage("s2", "b", "running", { model: "anthropic/opus" }),
      makeStage("s3", "c", "running", { model: "anthropic/haiku" }),
      makeStage("s4", "d", "pending"),
    ]);
    const metaLine = renderWidgetLines(makeSnap([run]), 160).map(stripAnsi)[2]!;
    assert.ok(metaLine.includes("parallel"), `reads as parallel, got: ${metaLine}`);
    // Provider-stripped, first two shown, remainder collapsed to +1.
    assert.ok(metaLine.includes("gpt-5, opus +1"), `deduped + capped, got: ${metaLine}`);
    assert.ok(!metaLine.includes("openai/"), "provider prefix stripped in the parallel list");
    assert.ok(!metaLine.includes("haiku"), "third model collapses into +1");
  });

  test("parallel stages on the SAME model show the single model form", () => {
    const run = makeRun("t8xxxxxx", "wf-same", "running", [
      makeStage("s1", "a", "running", { model: "openai/gpt-5" }),
      makeStage("s2", "b", "running", { model: "openai/gpt-5" }),
    ]);
    const metaLine = renderWidgetLines(makeSnap([run]), 120).map(stripAnsi)[2]!;
    assert.ok(metaLine.includes("parallel"), "still reads as parallel (2 concurrent stages)");
    // One distinct model → keep the full provider id, no comma list, no +N.
    assert.ok(metaLine.includes("openai/gpt-5"), `single model form, got: ${metaLine}`);
    assert.doesNotMatch(metaLine, /\+\d/, "no +N when only one distinct model");
  });
});
