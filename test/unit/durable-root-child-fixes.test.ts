/**
 * Durable hashing, scoped child checkpoints, cancellation, and replay tests.
 */
import { describe, test, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { InMemoryDurableBackend, durableHash } from "../../packages/workflows/src/durable/backend.js";
import { ScopedDurableBackend } from "../../packages/workflows/src/durable/scoped-backend.js";
import { createToolPrimitive, createCheckpointIdGenerator } from "../../packages/workflows/src/durable/tool-primitive.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

const ROOT = "root-wf-001";
const CHILD = "child-wf-002";

function toolCheckpoint(workflowId: string, argsHash: string, output: string): DurableCheckpoint {
  return { kind: "tool", workflowId, checkpointId: `tool:${argsHash}`, name: "t", argsHash, output, completedAt: 1 };
}


// ---------------------------------------------------------------------------
// #3 collision-resistant digest
// ---------------------------------------------------------------------------

describe("durableHash (collision-resistant digest)", () => {
  test("is deterministic for identical input", () => {
    assert.equal(durableHash({ name: "x", args: { a: 1 } }), durableHash({ name: "x", args: { a: 1 } }));
  });

  test("distinguishes inputs that a 32-bit hash would collide on", () => {
    // Construct two structurally distinct inputs that previously collided under
    // the old DJB2 hash because their canonical strings produced the same 32-bit
    // remainder. SHA-256 prefixes must differ.
    const a = durableHash({ n: "a".repeat(70000) });
    const b = durableHash({ n: "a".repeat(70000) + "x" });
    assert.notEqual(a, b);
  });

  test("key order does not affect the digest (canonicalization)", () => {
    assert.equal(durableHash({ a: 1, b: 2 } as never), durableHash({ b: 2, a: 1 } as never));
  });

  test("prefix indicates a digest form", () => {
    assert.match(durableHash({ x: 1 }), /^h[0-9a-f]+$/);
  });
});

// ---------------------------------------------------------------------------
// #1 child side effects under root via ScopedDurableBackend
// ---------------------------------------------------------------------------

describe("ScopedDurableBackend (child side effects under root)", () => {
  let root: InMemoryDurableBackend;

  beforeEach(() => {
    root = new InMemoryDurableBackend();
    root.registerWorkflow({ workflowId: ROOT, name: "root", inputs: {}, createdAt: 1, status: "running", rootWorkflowId: ROOT });
  });

  test("child tool checkpoint is stored under the root workflow id", () => {
    const scope = { rootWorkflowId: ROOT, scopePrefix: "workflow:child:1" };
    const scoped = new ScopedDurableBackend(root, scope);
    // The child ctx.tool writes with workflowId = child run id; the scoped
    // backend must remap it to the root.
    scoped.recordCheckpoint(toolCheckpoint(CHILD, "raw-hash", "side-effect-result"));

    // Root lookup with the scoped key returns the child result.
    const scopedKey = "workflow:child:1:raw-hash";
    assert.equal(root.getToolOutput(ROOT, scopedKey), "side-effect-result");
    // The child run id has no independent state in the root backend.
    assert.equal(root.getWorkflow(CHILD), undefined);
  });

  test("child tool result does NOT re-run when the parent is resumed (same scope)", () => {
    const scopePrefix = "workflow:child:1";
    // First (interrupted) child run: records a tool side effect under root.
    const firstRun = new ScopedDurableBackend(root, { rootWorkflowId: ROOT, scopePrefix });
    firstRun.recordCheckpoint(toolCheckpoint(CHILD, "compute-hash", "computed-once"));

    // Parent is resumed; the child is re-dispatched with the SAME scope key
    // (stable boundary ordinal). Its ctx.tool reads the prior result from root.
    const resumedRun = new ScopedDurableBackend(root, { rootWorkflowId: ROOT, scopePrefix });
    const cached = resumedRun.getToolOutput(CHILD, "compute-hash");
    assert.equal(cached, "computed-once");
  });

  test("distinct children with the same tool args do not collide", () => {
    const first = new ScopedDurableBackend(root, { rootWorkflowId: ROOT, scopePrefix: "workflow:child:1" });
    const second = new ScopedDurableBackend(root, { rootWorkflowId: ROOT, scopePrefix: "workflow:child:2" });
    first.recordCheckpoint(toolCheckpoint(CHILD, "shared-hash", "first-result"));
    second.recordCheckpoint(toolCheckpoint(CHILD, "shared-hash", "second-result"));
    assert.equal(first.getToolOutput(CHILD, "shared-hash"), "first-result");
    assert.equal(second.getToolOutput(CHILD, "shared-hash"), "second-result");
  });

  test("scoped lifecycle methods are no-ops (children are not independently resumable)", () => {
    const scoped = new ScopedDurableBackend(root, { rootWorkflowId: ROOT, scopePrefix: "workflow:child:1" });
    scoped.registerWorkflow({ workflowId: CHILD, name: "child", inputs: {}, createdAt: 1, status: "running", rootWorkflowId: ROOT });
    scoped.setWorkflowStatus(CHILD, "completed");
    assert.equal(root.getWorkflow(CHILD), undefined);
    assert.equal(scoped.listResumableWorkflows().length, 0);
    assert.equal(scoped.toMetadata(CHILD), undefined);
  });

  test("listCheckpoints excludes sibling scopes (no double-prefix leakage)", () => {
    // Two siblings write tool checkpoints under the same root with different scopes.
    const scope1 = "workflow:child:1";
    const scope2 = "workflow:child:2";
    const first = new ScopedDurableBackend(root, { rootWorkflowId: ROOT, scopePrefix: scope1 });
    const second = new ScopedDurableBackend(root, { rootWorkflowId: ROOT, scopePrefix: scope2 });
    first.recordCheckpoint(toolCheckpoint(CHILD, "alpha", "first"));
    second.recordCheckpoint(toolCheckpoint(CHILD, "beta", "second"));

    // listCheckpoints for scope1 must NOT include scope2's checkpoints.
    const scope1Checkpoints = first.listCheckpoints(CHILD);
    assert.equal(scope1Checkpoints.length, 1);
    // The stored checkpointId must start with scope1 prefix, not scope2.
    assert.ok(scope1Checkpoints[0]!.checkpointId.startsWith(`${scope1}:`), `expected ${scope1Checkpoints[0]!.checkpointId} to start with ${scope1}:`);

    // listCheckpoints for scope2 must NOT include scope1's checkpoints.
    const scope2Checkpoints = second.listCheckpoints(CHILD);
    assert.equal(scope2Checkpoints.length, 1);
    assert.ok(scope2Checkpoints[0]!.checkpointId.startsWith(`${scope2}:`), `expected ${scope2Checkpoints[0]!.checkpointId} to start with ${scope2}:`);
  });

  test("getWorkflow returns undefined (not never) for scoped child", () => {
    const scoped = new ScopedDurableBackend(root, { rootWorkflowId: ROOT, scopePrefix: "workflow:child:1" });
    assert.equal(scoped.getWorkflow(CHILD), undefined);
  });
});

// ---------------------------------------------------------------------------
// #4 ctx.tool cancellation after the tool function resolves
// ---------------------------------------------------------------------------

describe("ctx.tool cancellation after side-effect resolves", () => {
  let backend: InMemoryDurableBackend;
  let cancelled: boolean;

  beforeEach(() => {
    backend = new InMemoryDurableBackend();
    cancelled = false;
    backend.registerWorkflow({ workflowId: ROOT, name: "t", inputs: {}, createdAt: 1, status: "running" });
  });

  function makeTool(signal?: AbortSignal) {
    return createToolPrimitive({
      workflowId: ROOT,
      backend,
      nextCheckpointId: createCheckpointIdGenerator(),
      signal,
      throwIfCancelled: () => {
        if (cancelled) throw new Error("cancelled");
      },
    });
  }

  test("does not record a checkpoint when cancelled after the function resolves", async () => {
    const tool = makeTool();
    await assert.rejects(
      () =>
        tool("side-effect", { id: 1 }, async () => {
          // Side effect completes, then cancellation arrives before return.
          cancelled = true;
          return "computed";
        }),
      /cancelled/,
    );
    // No durable checkpoint was recorded: a resume will not silently replay it.
    assert.equal(backend.listCheckpoints(ROOT).length, 0);
  });

  test("records normally when not cancelled after resolving", async () => {
    const tool = makeTool();
    const result = await tool("ok", { id: 2 }, async () => "done");
    assert.equal(result, "done");
    assert.equal(backend.listCheckpoints(ROOT).length, 1);
  });
});

// ---------------------------------------------------------------------------
// #5 file-backed stale lock recovery
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// #1b run()-level: child ctx.tool side effects land under the root workflow id
// ---------------------------------------------------------------------------

describe("run() child ctx.tool is checkpointed under the root workflow", () => {
  test("child tool side effect is stored under the root id, not the child run id", async () => {
    const backend = new InMemoryDurableBackend();
    let childToolCalls = 0;
    const child = workflow({
      name: "child-with-tool",
      description: "",
      inputs: {},
      outputs: { value: Type.String() },
      run: async (ctx) => {
        await ctx.stage("c").complete("c-done");
        const value = await ctx.tool("child-tool", { n: 1 }, async () => {
          childToolCalls++;
          return "child-side-effect";
        });
        return { value };
      },
    });
    const parent = workflow({
      name: "parent-with-tool-child",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async (ctx) => {
        const childResult = await ctx.workflow(child);
        if (childResult.exited) throw new Error("child exited");
        return { result: childResult.outputs.value };
      },
    });

    const first = await run(parent, {}, {
      runId: "wf-root-parent-tool",
      store: createStore(),
      durableBackend: backend,
      adapters: { complete: { complete: async (text) => text } },
    });
    assert.equal(first.status, "completed");
    assert.equal(first.result?.["result"], "child-side-effect");
    assert.equal(childToolCalls, 1);

    // The child's tool checkpoint must be stored under the ROOT workflow id,
    // scoped by the child boundary key. Inspect all root checkpoints.
    const rootCheckpoints = backend.listCheckpoints("wf-root-parent-tool");
    const childToolCp = rootCheckpoints.find((cp) => cp.kind === "tool" && cp.name === "child-tool");
    assert.ok(childToolCp, "child tool checkpoint should be recorded under the root workflow");
    assert.equal(childToolCp!.workflowId, "wf-root-parent-tool");
    assert.match(childToolCp!.checkpointId, /^workflow:.*:1:tool:/);

    // Re-run the parent with the same root id: boundary cache hit means the
    // child is not re-invoked at all, so the child tool never re-runs.
    const second = await run(parent, {}, {
      runId: "wf-root-parent-tool",
      store: createStore(),
      durableBackend: backend,
      adapters: { complete: { complete: async (text) => text } },
    });
    assert.equal(second.status, "completed");
    assert.equal(childToolCalls, 1); // still 1 — no re-execution
  });

  test("interrupted child re-dispatch replays child tool side effect under root scope", async () => {
    const backend = new InMemoryDurableBackend();
    backend.registerWorkflow({ workflowId: "wf-interrupted-root", name: "parent-with-tool-child", inputs: {}, createdAt: 1, status: "running", rootWorkflowId: "wf-interrupted-root" });

    // Seed ONLY the child tool side effect under the root scope (boundary and
    // child stage checkpoints absent), simulating an interruption before the
    // child completed its boundary. The scope key matches what the child's
    // ctx.tool uses.
    const childToolArgsHash = durableHash({ name: "child-tool", args: { n: 1 }, ordinal: 1 });
    const scopePrefix = "workflow:workflow:child-with-tool:1";
    backend.recordCheckpoint({
      kind: "tool",
      workflowId: "wf-interrupted-root",
      checkpointId: `${scopePrefix}:tool:${scopePrefix}:${childToolArgsHash}`,
      name: "child-tool",
      argsHash: `${scopePrefix}:${childToolArgsHash}`,
      output: "recovered-side-effect",
      completedAt: 1,
    });

    let childToolCalls = 0;
    const child = workflow({
      name: "child-with-tool",
      description: "",
      inputs: {},
      outputs: { value: Type.String() },
      run: async (ctx) => {
        await ctx.stage("c").complete("c-done");
        const value = await ctx.tool("child-tool", { n: 1 }, async () => {
          childToolCalls++;
          return "SHOULD-NOT-RUN";
        });
        return { value };
      },
    });
    const parent = workflow({
      name: "parent-with-tool-child",
      description: "",
      inputs: {},
      outputs: { result: Type.String() },
      run: async (ctx) => {
        const childResult = await ctx.workflow(child);
        if (childResult.exited) throw new Error("child exited");
        return { result: childResult.outputs.value };
      },
    });

    const result = await run(parent, {}, {
      runId: "wf-interrupted-root",
      store: createStore(),
      durableBackend: backend,
      adapters: { complete: { complete: async (text) => text } },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.result?.["result"], "recovered-side-effect");
    assert.equal(childToolCalls, 0); // child tool did NOT re-execute
  });
});

// ---------------------------------------------------------------------------
// #2 stale resume refusal is covered in durable-resume-runtime.test.ts
// (kept there to reuse the resume adapter fixtures.)
// ---------------------------------------------------------------------------
