/**
 * Tests that detached workflow runs route HIL through the store-backed
 * background UI adapter — never through the supplied (pi.ui-backed) one.
 *
 * Bug fixed:
 *   When a workflow stage called ctx.ui.editor/confirm/input/select, the
 *   background workflow opened a pi.ui modal that stole focus from the
 *   chat editor. These tests prove the fix:
 *     - runDetached ignores opts.ui (pi.ui adapter is never called from BG)
 *     - ctx.ui calls land as PendingPrompts on the run snapshot
 *     - Resolving the prompt via the store resumes the workflow body
 *
 * These cover the contract the graph viewer overlay relies on to surface
 * HIL without blocking the main chat.
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { runDetached } from "../../src/runs/background/runner.js";
import { createStore } from "../../src/shared/store.js";
import { createCancellationRegistry } from "../../src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../src/runs/background/job-tracker.js";
import { defineWorkflow } from "../../src/workflows/define-workflow.js";
import type { WorkflowUIAdapter } from "../../src/shared/types.js";

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

async function waitForPendingPrompt(
  store: ReturnType<typeof createStore>,
  runId: string,
  timeoutMs = 1000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = store.runs().find((r) => r.id === runId);
    if (run?.pendingPrompt) return run.pendingPrompt.id;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`pending prompt did not appear on run ${runId}`);
}

describe("runDetached — HIL never reaches pi.ui adapter", () => {
  test("ctx.ui.editor records PendingPrompt; pi.ui.editor spy not called", async () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    const piUi = makeUISpy();

    const def = defineWorkflow("hil-editor-bg")
      .run(async (ctx) => {
        const edited = await ctx.ui.editor("seed text");
        return { edited };
      })
      .compile();

    const accepted = runDetached(def, {}, { store, cancellation, jobs, ui: piUi });
    const promptId = await waitForPendingPrompt(store, accepted.runId);
    const prompt = store.runs().find((r) => r.id === accepted.runId)?.pendingPrompt;
    assert.equal(prompt?.kind, "editor");
    assert.equal(prompt?.initial, "seed text");
    assert.equal(piUi.editorCalls.length, 0, "pi.ui.editor must not be invoked from a detached run");

    store.resolvePendingPrompt(accepted.runId, promptId, "user-edited");

    // Wait for the run to settle.
    await waitForRunEnded(store, accepted.runId);
    const run = store.runs().find((r) => r.id === accepted.runId);
    assert.equal(run?.status, "completed");
    assert.deepEqual(run?.result, { edited: "user-edited" });
  });

  test("ctx.ui.confirm + ctx.ui.input route through the store, not pi.ui", async () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const jobs = createJobTracker();
    const piUi = makeUISpy();

    const def = defineWorkflow("hil-mixed-bg")
      .run(async (ctx) => {
        const proceed = await ctx.ui.confirm("ok?");
        const name = await ctx.ui.input("your name");
        return { proceed, name };
      })
      .compile();

    const accepted = runDetached(def, {}, { store, cancellation, jobs, ui: piUi });

    const firstId = await waitForPendingPrompt(store, accepted.runId);
    assert.equal(
      store.runs().find((r) => r.id === accepted.runId)?.pendingPrompt?.kind,
      "confirm",
    );
    store.resolvePendingPrompt(accepted.runId, firstId, true);

    const secondId = await waitForPendingPrompt(store, accepted.runId);
    assert.equal(
      store.runs().find((r) => r.id === accepted.runId)?.pendingPrompt?.kind,
      "input",
    );
    store.resolvePendingPrompt(accepted.runId, secondId, "ada");

    await waitForRunEnded(store, accepted.runId);
    const run = store.runs().find((r) => r.id === accepted.runId);
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
      .run(async (ctx) => {
        await ctx.ui.input("will be killed");
        return { unreached: true };
      })
      .compile();

    const accepted = runDetached(def, {}, { store, cancellation, jobs });
    await waitForPendingPrompt(store, accepted.runId);
    // Interrupt via the cancellation registry (mirrors `/workflow interrupt <id>`).
    cancellation.abort(accepted.runId, "user kill");
    await waitForRunEnded(store, accepted.runId);
    const run = store.runs().find((r) => r.id === accepted.runId);
    assert.notEqual(run?.status, "completed");
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
