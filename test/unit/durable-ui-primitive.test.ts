/**
 * Tests for the durable ctx.ui wrapper.
 *
 * Verifies completed user responses are cached durably and replayed on resume
 * without re-asking the user.
 *
 * cross-ref: issue #1498 — durable ctx.ui response/pending prompt state.
 */
import { describe, test, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { InMemoryDurableBackend, durableHash } from "../../packages/workflows/src/durable/backend.js";
import { createCheckpointIdGenerator } from "../../packages/workflows/src/durable/tool-primitive.js";
import { wrapUiWithDurable } from "../../packages/workflows/src/durable/ui-primitive.js";
import type { WorkflowCustomUiFactory, WorkflowUIContext } from "../../packages/workflows/src/shared/authoring-contract-ui.js";

const WORKFLOW_ID = "wf-ui-test-001";

function makeBaseUi(overrides: Partial<WorkflowUIContext> = {}): WorkflowUIContext & { calls: Record<string, number> } {
  const calls: Record<string, number> = { input: 0, confirm: 0, select: 0, editor: 0, custom: 0 };
  return {
    calls,
    async input(_prompt: string) { calls.input++; return "raw-input"; },
    async confirm(_message: string) { calls.confirm++; return true; },
    async select<T extends string>(_message: string, _options: readonly T[]): Promise<T> { calls.select++; return "opt-a" as T; },
    async editor(_initial?: string) { calls.editor++; return "edited-text"; },
    async custom<T>(_factory: unknown, _options?: unknown): Promise<T> { calls.custom++; return "custom-result" as unknown as T; },
    ...overrides,
  };
}

/** A factory stub typed to satisfy WorkflowCustomUiFactory<T> (never invoked by the mock base). */
function customFactory(): WorkflowCustomUiFactory<string> {
  // The mock base.custom never calls this; the cast keeps the test type-clean.
  return (() => ({})) as unknown as WorkflowCustomUiFactory<string>;
}

describe("wrapUiWithDurable", () => {
  let backend: InMemoryDurableBackend;

  beforeEach(() => {
    backend = new InMemoryDurableBackend();
    backend.registerWorkflow({
      workflowId: WORKFLOW_ID,
      name: "ui-test",
      inputs: {},
      createdAt: Date.now(),
      status: "running",
    });
  });

  function wrap(base: WorkflowUIContext): WorkflowUIContext {
    return wrapUiWithDurable(base, {
      workflowId: WORKFLOW_ID,
      backend,
      nextCheckpointId: createCheckpointIdGenerator(),
    });
  }

  test("caches input response and does not re-ask on resume", async () => {
    const baseA = makeBaseUi();
    const uiA = wrap(baseA);
    const resA = await uiA.input("What is your name?");
    assert.equal(resA, "raw-input");
    assert.equal(baseA.calls.input, 1);

    // Resume: new UI wrapper, same backend, same prompt.
    const baseB = makeBaseUi();
    const uiB = wrap(baseB);
    const resB = await uiB.input("What is your name?");
    assert.equal(resB, "raw-input");
    assert.equal(baseB.calls.input, 0); // base was NOT called
  });

  test("caches confirm response", async () => {
    const ui = wrap(makeBaseUi());
    assert.equal(await ui.confirm("Proceed?"), true);
    const hit = backend.getUiResponse(WORKFLOW_ID, durableHash({ kind: "confirm", message: "Proceed?" }));
    assert.equal(hit, true);
  });

  test("caches select response", async () => {
    const ui = wrap(makeBaseUi());
    const choice = await ui.select("Pick one", ["opt-a", "opt-b"]);
    assert.equal(choice, "opt-a");
    const hit = backend.getUiResponse(WORKFLOW_ID, durableHash({ kind: "select", message: "Pick one" }));
    assert.equal(hit, "opt-a");
  });

  test("different prompt messages produce different cache keys", async () => {
    const base = makeBaseUi();
    const ui = wrap(base);
    await ui.input("Question 1");
    await ui.input("Question 2");
    assert.equal(base.calls.input, 2);
  });

  test("custom prompt cached by replayIdentity", async () => {
    const baseA = makeBaseUi();
    const uiA = wrap(baseA);
    const factory = customFactory();
    await uiA.custom(factory, { replayIdentity: "design-picker" });

    // Resume: same replayIdentity returns cached result without invoking base.
    const baseB = makeBaseUi();
    const uiB = wrap(baseB);
    const result = await uiB.custom(factory, { replayIdentity: "design-picker" });
    assert.equal(result, "custom-result");
    assert.equal(baseB.calls.custom, 0);
  });

  test("transparent when no cached response exists", async () => {
    const base = makeBaseUi();
    const ui = wrap(base);
    // No prior cache — must delegate to base.
    assert.equal(await ui.input("fresh question"), "raw-input");
    assert.equal(base.calls.input, 1);
  });
});
