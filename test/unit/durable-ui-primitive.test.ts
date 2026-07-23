/**
 * Tests for the durable ctx.ui wrapper.
 *
 * Verifies completed user responses are cached durably and replayed on resume
 * without re-asking the user.
 *
 * cross-ref: issue #1498 — durable ctx.ui response/pending prompt state.
 */
import { describe, test, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { createCheckpointIdGenerator } from "../../packages/workflows/src/durable/tool-primitive.js";
import { wrapUiWithDurable } from "../../packages/workflows/src/durable/ui-primitive.js";
import { ScopedDurableBackend } from "../../packages/workflows/src/durable/scoped-backend.js";
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
function customFactory<T = string>(): WorkflowCustomUiFactory<T> {
  // The mock base.custom never calls this; the component is only for typing.
  return () => ({ render: () => [], invalidate: () => undefined });
}

async function promptInputAtStableCallsite(ui: WorkflowUIContext, message: string): Promise<string> {
  return ui.input(message);
}

async function promptCustomAtStableCallsite<T>(
  ui: WorkflowUIContext,
  factory: WorkflowCustomUiFactory<T>,
  replayIdentity: string,
): Promise<T> {
  return ui.custom(factory, { replayIdentity });
}

async function promptAtFirstAuthorCallsite(ui: WorkflowUIContext): Promise<string> {
  return ui.input("identical descriptor");
}

async function promptAtSecondAuthorCallsite(ui: WorkflowUIContext): Promise<string> {
  return ui.input("identical descriptor");
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
    const resA = await promptInputAtStableCallsite(uiA, "What is your name?");
    assert.equal(resA, "raw-input");
    assert.equal(baseA.calls.input, 1);

    // Resume: new UI wrapper, same backend, same prompt.
    const baseB = makeBaseUi();
    const uiB = wrap(baseB);
    const resB = await promptInputAtStableCallsite(uiB, "What is your name?");
    assert.equal(resB, "raw-input");
    assert.equal(baseB.calls.input, 0); // base was NOT called
  });

  test("clears a replayed pending slot when its answer checkpoint already exists", async () => {
    const baseA = makeBaseUi();
    assert.equal(await promptInputAtStableCallsite(wrap(baseA), "checkpointed before cleanup"), "raw-input");
    const checkpoint = backend.listCheckpoints(WORKFLOW_ID)[0]!;
    backend = new InMemoryDurableBackend();
    backend.registerWorkflow({
      workflowId: WORKFLOW_ID, name: "ui-test", inputs: {}, createdAt: 1,
      status: "running", pendingPrompts: 1,
    });
    backend.recordCheckpoint(checkpoint);
    assert.equal(backend.getWorkflow(WORKFLOW_ID)?.pendingPrompts, 1);

    const baseB = makeBaseUi();
    assert.equal(await promptInputAtStableCallsite(wrap(baseB), "checkpointed before cleanup"), "raw-input");
    assert.equal(baseB.calls.input, 0);
    assert.equal(backend.getWorkflow(WORKFLOW_ID)?.pendingPrompts, 0);
  });

  test("caches confirm response", async () => {
    const ui = wrap(makeBaseUi());
    assert.equal(await ui.confirm("Proceed?"), true);
    const hit = backend.listCheckpoints(WORKFLOW_ID).find((cp) => cp.kind === "ui" && cp.promptKind === "confirm");
    assert.equal(hit?.kind === "ui" ? hit.response : undefined, true);
  });

  test("caches select response", async () => {
    const ui = wrap(makeBaseUi());
    const choice = await ui.select("Pick one", ["opt-a", "opt-b"]);
    assert.equal(choice, "opt-a");
    const hit = backend.listCheckpoints(WORKFLOW_ID).find((cp) => cp.kind === "ui" && cp.promptKind === "select");
    assert.equal(hit?.kind === "ui" ? hit.response : undefined, "opt-a");
  });

  test("same prompt repeated in one run uses ordinal-specific cache keys", async () => {
    const base = makeBaseUi({ async input() { base.calls.input++; return `answer-${base.calls.input}`; } });
    const ui = wrap(base);
    assert.equal(await promptInputAtStableCallsite(ui, "Question"), "answer-1");
    assert.equal(await promptInputAtStableCallsite(ui, "Question"), "answer-2");
    assert.equal(base.calls.input, 2);

    const resumedBase = makeBaseUi();
    const resumed = wrap(resumedBase);
    assert.equal(await promptInputAtStableCallsite(resumed, "Question"), "answer-1");
    assert.equal(await promptInputAtStableCallsite(resumed, "Question"), "answer-2");
    assert.equal(resumedBase.calls.input, 0);
  });

  test("replays identical descriptors by author callsite when scheduling reverses", async () => {
    const originalBase = makeBaseUi({
      async input() {
        originalBase.calls.input++;
        return originalBase.calls.input === 1 ? "answer-for-first" : "answer-for-second";
      },
    });
    const original = wrap(originalBase);
    assert.equal(await promptAtFirstAuthorCallsite(original), "answer-for-first");
    assert.equal(await promptAtSecondAuthorCallsite(original), "answer-for-second");

    const replayBase = makeBaseUi({
      async input() { throw new Error("durable replay must not delegate"); },
    });
    const replay = wrap(replayBase);
    assert.equal(await promptAtSecondAuthorCallsite(replay), "answer-for-second");
    assert.equal(await promptAtFirstAuthorCallsite(replay), "answer-for-first");
    assert.equal(replayBase.calls.input, 0);
  });

  test("select options participate in prompt identity", async () => {
    const base = makeBaseUi({ async select<T extends string>(_message: string, options: readonly T[]) { base.calls.select++; return options[base.calls.select - 1] ?? options[0]!; } });
    const ui = wrap(base);
    assert.equal(await ui.select("Pick", ["a", "b"]), "a");
    assert.equal(await ui.select("Pick", ["x", "y"]), "y");
    assert.equal(base.calls.select, 2);
  });

  test("custom prompt cached by replayIdentity", async () => {
    const baseA = makeBaseUi();
    const uiA = wrap(baseA);
    const factory = customFactory();
    await promptCustomAtStableCallsite(uiA, factory, "design-picker");

    // Resume: same replayIdentity returns cached result without invoking base.
    const baseB = makeBaseUi();
    const uiB = wrap(baseB);
    const result = await promptCustomAtStableCallsite(uiB, factory, "design-picker");
    assert.equal(result, "custom-result");
    assert.equal(baseB.calls.custom, 0);
  });

  test("custom prompt caches void response", async () => {
    const factory = customFactory<void>();
    const baseA = makeBaseUi({
      async custom<T>(): Promise<T> {
        baseA.calls.custom++;
        return undefined as T;
      },
    });
    const uiA = wrap(baseA);
    const first = await promptCustomAtStableCallsite(uiA, factory, "void-picker");
    assert.equal(first, undefined);
    assert.equal(baseA.calls.custom, 1);

    const baseB = makeBaseUi({
      async custom<T>(): Promise<T> {
        baseB.calls.custom++;
        return "should-not-run" as T;
      },
    });
    const uiB = wrap(baseB);
    const replayed = await promptCustomAtStableCallsite(uiB, factory, "void-picker");
    assert.equal(replayed, undefined);
    assert.equal(baseB.calls.custom, 0);
  });

  test.serial("replays one checkpoint when process cwd changes", async () => {
    const originalCwd = process.cwd();
    const firstBase = makeBaseUi({ async input() { firstBase.calls.input++; return "stable-answer"; } });
    assert.equal(await promptInputAtStableCallsite(wrap(firstBase), "same prompt across cwd"), "stable-answer");
    assert.equal(firstBase.calls.input, 1);

    try {
      process.chdir(tmpdir());
      const replayBase = makeBaseUi({ async input() { replayBase.calls.input++; return "must-not-delegate"; } });
      assert.equal(await promptInputAtStableCallsite(wrap(replayBase), "same prompt across cwd"), "stable-answer");
      assert.equal(replayBase.calls.input, 0);
      assert.equal(backend.listCheckpoints(WORKFLOW_ID).length, 1);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("transparent when no cached response exists", async () => {
    const base = makeBaseUi();
    const ui = wrap(base);
    // No prior cache — must delegate to base.
    assert.equal(await ui.input("fresh question"), "raw-input");
    assert.equal(base.calls.input, 1);
  });

  test("same-named grandchildren beneath different parents own distinct pending reservations", async () => {
    const parentA = new ScopedDurableBackend(backend, { rootWorkflowId: WORKFLOW_ID, scopePrefix: "workflow:parent-a:1" });
    const parentB = new ScopedDurableBackend(backend, { rootWorkflowId: WORKFLOW_ID, scopePrefix: "workflow:parent-b:1" });
    const grandchildA = new ScopedDurableBackend(parentA, { rootWorkflowId: WORKFLOW_ID, scopePrefix: "workflow:shared-grandchild:1" });
    const grandchildB = new ScopedDurableBackend(parentB, { rootWorkflowId: WORKFLOW_ID, scopePrefix: "workflow:shared-grandchild:1" });
    const answerA = Promise.withResolvers<string>();
    const answerB = Promise.withResolvers<string>();
    const uiA = wrapUiWithDurable(makeBaseUi({ input: () => answerA.promise }), {
      workflowId: "grandchild-a", backend: grandchildA, nextCheckpointId: createCheckpointIdGenerator(),
    });
    const uiB = wrapUiWithDurable(makeBaseUi({ input: () => answerB.promise }), {
      workflowId: "grandchild-b", backend: grandchildB, nextCheckpointId: createCheckpointIdGenerator(),
    });

    const pendingA = promptInputAtStableCallsite(uiA, "identical nested prompt");
    const pendingB = promptInputAtStableCallsite(uiB, "identical nested prompt");
    await Promise.resolve();
    assert.equal(backend.getWorkflow(WORKFLOW_ID)?.pendingPrompts, 2);
    answerA.resolve("answer-a");
    answerB.resolve("answer-b");
    assert.deepEqual(await Promise.all([pendingA, pendingB]), ["answer-a", "answer-b"]);
    assert.equal(backend.getWorkflow(WORKFLOW_ID)?.pendingPrompts, 0);
  });

  test("nested sibling custom prompts list and replay only their parent-prefixed checkpoints", async () => {
    const parentA = new ScopedDurableBackend(backend, { rootWorkflowId: WORKFLOW_ID, scopePrefix: "workflow:parent-a:1" });
    const parentB = new ScopedDurableBackend(backend, { rootWorkflowId: WORKFLOW_ID, scopePrefix: "workflow:parent-b:1" });
    const grandchildA = new ScopedDurableBackend(parentA, { rootWorkflowId: WORKFLOW_ID, scopePrefix: "workflow:shared-grandchild:1" });
    const grandchildB = new ScopedDurableBackend(parentB, { rootWorkflowId: WORKFLOW_ID, scopePrefix: "workflow:shared-grandchild:1" });
    const factory = customFactory<string>();
    const firstA = makeBaseUi({ async custom<T>() { firstA.calls.custom++; return "answer-a" as T; } });
    const firstB = makeBaseUi({ async custom<T>() { firstB.calls.custom++; return "answer-b" as T; } });
    const makeNestedUi = (base: WorkflowUIContext, scoped: ScopedDurableBackend, workflowId: string) => wrapUiWithDurable(base, {
      workflowId, backend: scoped, nextCheckpointId: createCheckpointIdGenerator(),
    });

    assert.equal(await promptCustomAtStableCallsite(makeNestedUi(firstA, grandchildA, "grandchild-a"), factory, "shared-picker"), "answer-a");
    assert.equal(await promptCustomAtStableCallsite(makeNestedUi(firstB, grandchildB, "grandchild-b"), factory, "shared-picker"), "answer-b");
    assert.equal(grandchildA.listCheckpoints("grandchild-a").length, 1);
    assert.equal(grandchildB.listCheckpoints("grandchild-b").length, 1);

    const replayA = makeBaseUi({ async custom<T>() { replayA.calls.custom++; return "wrong-a" as T; } });
    const replayB = makeBaseUi({ async custom<T>() { replayB.calls.custom++; return "wrong-b" as T; } });
    assert.equal(await promptCustomAtStableCallsite(makeNestedUi(replayB, grandchildB, "grandchild-b-replay"), factory, "shared-picker"), "answer-b");
    assert.equal(await promptCustomAtStableCallsite(makeNestedUi(replayA, grandchildA, "grandchild-a-replay"), factory, "shared-picker"), "answer-a");
    assert.deepEqual([replayA.calls.custom, replayB.calls.custom], [0, 0]);
  });

  test("counts nested workflow prompts at the durable root without underflow", async () => {
    const rootWaiter = Promise.withResolvers<string>();
    const childWaiter = Promise.withResolvers<string>();
    const rootUi = wrap(makeBaseUi({ input: () => rootWaiter.promise }));
    const childBackend = new ScopedDurableBackend(backend, {
      rootWorkflowId: WORKFLOW_ID,
      scopePrefix: "workflow:child:1",
    });
    const childUi = wrapUiWithDurable(makeBaseUi({ input: () => childWaiter.promise }), {
      workflowId: "child-run",
      backend: childBackend,
      nextCheckpointId: createCheckpointIdGenerator(),
    });

    const rootPrompt = rootUi.input("root question");
    const childPrompt = childUi.input("child question");
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(backend.getWorkflow(WORKFLOW_ID)?.pendingPrompts, 2);

    childWaiter.resolve("child answer");
    rootWaiter.resolve("root answer");
    assert.equal(await childPrompt, "child answer");
    assert.equal(await rootPrompt, "root answer");
    assert.equal(backend.getWorkflow(WORKFLOW_ID)?.pendingPrompts, 0);
    assert.equal(backend.listCheckpoints(WORKFLOW_ID).length, 2);

    backend.adjustPendingPrompts(WORKFLOW_ID, -1);
    assert.equal(backend.getWorkflow(WORKFLOW_ID)?.pendingPrompts, 0);
  });

  test("reuses a persisted scoped-child prompt reservation after restart", async () => {
    const rootBackend = new InMemoryDurableBackend();
    rootBackend.registerWorkflow({
      workflowId: WORKFLOW_ID,
      name: "ui-test",
      inputs: {},
      createdAt: 1,
      status: "running",
      pendingPrompts: 1,
    });
    const scopedBackend = new ScopedDurableBackend(rootBackend, {
      rootWorkflowId: WORKFLOW_ID,
      scopePrefix: "workflow:child:restart:1",
    });
    const answer = Promise.withResolvers<string>();
    const childUi = wrapUiWithDurable(makeBaseUi({ input: () => answer.promise }), {
      workflowId: "restarted-child-run",
      backend: scopedBackend,
      nextCheckpointId: createCheckpointIdGenerator(),
    });

    const pending = childUi.input("child pending from prior process");
    await Promise.resolve();
    assert.equal(rootBackend.getWorkflow(WORKFLOW_ID)?.pendingPrompts, 1);
    answer.resolve("answered after restart");
    assert.equal(await pending, "answered after restart");
    assert.equal(rootBackend.getWorkflow(WORKFLOW_ID)?.pendingPrompts, 0);
    assert.equal(rootBackend.listCheckpoints(WORKFLOW_ID).length, 1);
  });

  test("counts concurrent unresolved prompts until checkpoint or rejection settles", async () => {
    const first = Promise.withResolvers<string>();
    const second = Promise.withResolvers<string>();
    let calls = 0;
    const base = makeBaseUi({
      async input() {
        base.calls.input++;
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      },
    });
    const ui = wrap(base);

    const firstPrompt = ui.input("first");
    await Promise.resolve();
    const secondPrompt = ui.input("second");
    await Promise.resolve();

    assert.equal(backend.getWorkflow(WORKFLOW_ID)?.pendingPrompts, 2);
    first.resolve("answered");
    assert.equal(await firstPrompt, "answered");
    assert.equal(backend.getWorkflow(WORKFLOW_ID)?.pendingPrompts, 1);
    assert.equal(backend.listCheckpoints(WORKFLOW_ID).length, 1);

    second.reject(new Error("prompt aborted"));
    await assert.rejects(secondPrompt, /prompt aborted/);
    assert.equal(backend.getWorkflow(WORKFLOW_ID)?.pendingPrompts, 0);
    assert.equal(backend.listCheckpoints(WORKFLOW_ID).length, 1);
  });
});
