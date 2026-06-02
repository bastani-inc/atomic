/**
 * Tests that detached workflow runs route HIL through store-backed workflow
 * prompt nodes — never through the supplied (pi.ui-backed) adapter.
 *
 * Bug fixed:
 *   When a workflow stage called ctx.ui.editor/confirm/input/select, the
 *   background workflow opened a pi.ui modal that stole focus from the
 *   chat editor. These tests prove the current contract:
 *     - runDetached ignores opts.ui (pi.ui adapter is never called from BG)
 *     - ctx.ui calls land as PendingPrompts on synthetic workflow prompt nodes
 *     - Resolving the stage-local prompt via the store resumes the workflow body
 *
 * These cover the node-local HIL contract used by the graph viewer: the graph
 * stays visible, awaiting prompt nodes are attachable, and the legacy run-level
 * prompt overlay remains unused for normal detached workflow ctx.ui calls.
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";
import { Type } from "typebox";
import type { WorkflowUIAdapter } from "../../packages/workflows/src/shared/types.js";

interface UISpy extends WorkflowUIAdapter {
  inputCalls: string[];
  confirmCalls: string[];
  selectCalls: Array<{ message: string; options: readonly string[] }>;
  editorCalls: Array<string | undefined>;
}

function makeUISpy(): UISpy {
  const inputCalls: string[] = [];
  const confirmCalls: string[] = [];
  const selectCalls: Array<{ message: string; options: readonly string[] }> = [];
  const editorCalls: Array<string | undefined> = [];
  return {
    inputCalls,
    confirmCalls,
    selectCalls,
    editorCalls,
    async input(prompt: string): Promise<string> {
      inputCalls.push(prompt);
      return "FROM-PI-UI";
    },
    async confirm(message: string): Promise<boolean> {
      confirmCalls.push(message);
      return true;
    },
    async select<T extends string>(message: string, options: readonly T[]): Promise<T> {
      selectCalls.push({ message, options });
      return options[0];
    },
    async editor(initial?: string): Promise<string> {
      editorCalls.push(initial);
      return "FROM-PI-UI-EDITOR";
    },
  };
}

async function waitForStagePendingPrompt(
  store: ReturnType<typeof createStore>,
  runId: string,
  timeoutMs = 1000,
): Promise<{ stageId: string; promptId: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = store.runs().find((r) => r.id === runId);
    const stage = run?.stages.find((candidate) => candidate.pendingPrompt !== undefined);
    if (stage?.pendingPrompt) return { stageId: stage.id, promptId: stage.pendingPrompt.id };
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`stage pending prompt did not appear on run ${runId}`);
}

describe("runDetached — HIL never reaches pi.ui adapter", () => {
  test("non-interactive execution uses unavailable ctx.ui instead of prompt nodes", async () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();

    const def = defineWorkflow("hil-headless-bg")
      .output("unreached", Type.Optional(Type.Any()))
      .run(async (ctx) => {
        await ctx.ui.confirm("ok?");
        return { unreached: true };
      })
      .compile();

    const accepted = runDetached(def, {}, { store, cancellation, jobs, executionMode: "non_interactive" });
    await waitForRunEnded(store, accepted.runId);
    const run = store.runs().find((r) => r.id === accepted.runId);

    assert.equal(run?.status, "failed");
    assert.match(run?.error ?? "", /ctx\.ui\.confirm is unavailable/);
    assert.equal(run?.stages.length, 0);
  });

  test("ctx.ui.editor records an attachable prompt node; pi.ui.editor spy not called", async () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    const piUi = makeUISpy();

    const def = defineWorkflow("hil-editor-bg")
      .output("edited", Type.Optional(Type.Any()))
      .run(async (ctx) => {
        const edited = await ctx.ui.editor("seed text");
        return { edited };
      })
      .compile();

    const accepted = runDetached(def, {}, { store, cancellation, jobs, ui: piUi });
    const { stageId, promptId } = await waitForStagePendingPrompt(store, accepted.runId);
    const runWhilePrompting = store.runs().find((r) => r.id === accepted.runId);
    const stage = runWhilePrompting?.stages.find((s) => s.id === stageId);
    assert.equal(runWhilePrompting?.pendingPrompt, undefined);
    assert.equal(stage?.name, "editor");
    assert.equal(stage?.status, "awaiting_input");
    assert.equal(stage?.attachable, true);
    assert.equal(stage?.pendingPrompt?.kind, "editor");
    assert.equal(stage?.pendingPrompt?.initial, "seed text");
    assert.equal(piUi.editorCalls.length, 0, "pi.ui.editor must not be invoked from a detached run");

    store.resolveStagePendingPrompt(accepted.runId, stageId, promptId, "user-edited");

    // Wait for the run to settle.
    await waitForRunEnded(store, accepted.runId);
    const run = store.runs().find((r) => r.id === accepted.runId);
    assert.equal(run?.status, "completed");
    assert.deepEqual(run?.result, { edited: "user-edited" });
    assert.equal(run?.stages.find((s) => s.id === stageId)?.result, undefined);
  });

  test("ctx.ui.confirm + ctx.ui.input route through prompt nodes, not pi.ui", async () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    const piUi = makeUISpy();

    const def = defineWorkflow("hil-mixed-bg")
      .output("proceed", Type.Optional(Type.Any()))
      .output("name", Type.Optional(Type.Any()))
      .run(async (ctx) => {
        const proceed = await ctx.ui.confirm("ok?");
        const name = await ctx.ui.input("your name");
        return { proceed, name };
      })
      .compile();

    const accepted = runDetached(def, {}, { store, cancellation, jobs, ui: piUi });

    const first = await waitForStagePendingPrompt(store, accepted.runId);
    let run = store.runs().find((r) => r.id === accepted.runId);
    const firstStage = run?.stages.find((s) => s.id === first.stageId);
    assert.equal(run?.pendingPrompt, undefined);
    assert.equal(firstStage?.name, "confirm");
    assert.equal(firstStage?.pendingPrompt?.kind, "confirm");
    store.resolveStagePendingPrompt(accepted.runId, first.stageId, first.promptId, true);

    const second = await waitForStagePendingPrompt(store, accepted.runId);
    run = store.runs().find((r) => r.id === accepted.runId);
    const secondStage = run?.stages.find((s) => s.id === second.stageId);
    assert.equal(run?.pendingPrompt, undefined);
    assert.equal(secondStage?.name, "input");
    assert.equal(secondStage?.pendingPrompt?.kind, "input");
    assert.deepEqual(secondStage?.parentIds, [first.stageId]);
    store.resolveStagePendingPrompt(accepted.runId, second.stageId, second.promptId, "ada");

    await waitForRunEnded(store, accepted.runId);
    run = store.runs().find((r) => r.id === accepted.runId);
    assert.equal(run?.status, "completed");
    assert.deepEqual(run?.result, { proceed: true, name: "ada" });
    assert.equal(piUi.confirmCalls.length, 0);
    assert.equal(piUi.inputCalls.length, 0);
  });

  test("killing the run rejects any outstanding HIL awaiter", async () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();

    const def = defineWorkflow("hil-killed-bg")
      .output("unreached", Type.Optional(Type.Any()))
      .run(async (ctx) => {
        await ctx.ui.input("will be killed");
        return { unreached: true };
      })
      .compile();

    const accepted = runDetached(def, {}, { store, cancellation, jobs });
    const prompt = await waitForStagePendingPrompt(store, accepted.runId);
    // Interrupt via the cancellation registry (mirrors `/workflow interrupt <id>`).
    cancellation.abort(accepted.runId, "user kill");
    await waitForRunEnded(store, accepted.runId);
    const run = store.runs().find((r) => r.id === accepted.runId);
    assert.notEqual(run?.status, "completed");
    const promptStage = run?.stages.find((stage) => stage.id === prompt.stageId);
    assert.equal(promptStage?.status, "skipped");
    assert.equal(promptStage?.skippedReason, "run-aborted");
    assert.equal(promptStage?.pendingPrompt, undefined);
    assert.notEqual(promptStage?.attachable, true);
  });

  test("ctx.ui prompt nodes settle between upstream and downstream task stages", async () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();

    const def = defineWorkflow("hil-parentage-bg")
      .output("proceed", Type.Optional(Type.Any()))
      .run(async (ctx) => {
        await ctx.stage("before").prompt("before task");
        const proceed = await ctx.ui.confirm("continue?");
        await ctx.stage("after").prompt(proceed ? "after yes" : "after no");
        return { proceed };
      })
      .compile();

    const accepted = runDetached(def, {}, {
      store,
      cancellation,
      jobs,
      adapters: { prompt: { prompt: async (text) => `ok:${text}` } },
    });

    const prompt = await waitForStagePendingPrompt(store, accepted.runId);
    const promptingRun = store.runs().find((r) => r.id === accepted.runId);
    const promptStage = promptingRun?.stages.find((s) => s.id === prompt.stageId);
    assert.equal(promptStage?.name, "confirm");
    assert.deepEqual(
      promptStage?.parentIds.map((id) => promptingRun?.stages.find((s) => s.id === id)?.name),
      ["before"],
    );

    store.resolveStagePendingPrompt(accepted.runId, prompt.stageId, prompt.promptId, true);
    await waitForRunEnded(store, accepted.runId);

    const stages = store.runs().find((r) => r.id === accepted.runId)?.stages ?? [];
    assert.deepEqual(stages.map((stage) => stage.name), ["before", "confirm", "after"]);
    assert.deepEqual(stages.find((stage) => stage.name === "after")?.parentIds, [prompt.stageId]);
    assert.equal(stages.find((stage) => stage.name === "confirm")?.status, "completed");
    assert.equal(stages.find((stage) => stage.name === "confirm")?.result, undefined);
  });
});

async function waitForRunEnded(
  store: ReturnType<typeof createStore>,
  runId: string,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = store.runs().find((r) => r.id === runId);
    if (run?.endedAt !== undefined) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`run ${runId} did not end in time`);
}
