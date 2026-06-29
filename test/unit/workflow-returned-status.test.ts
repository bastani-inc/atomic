import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";

describe("workflow returned status outputs", () => {
  test("failed result.status makes the run fail instead of completing successfully", async () => {
    const store = createStore();
    const def = workflow({
      name: "returned-failed-status",
      description: "",
      inputs: {},
      outputs: {
        status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("blocked")]),
        summary: Type.String(),
      },
      run: async (ctx) => {
        await ctx.stage("work").complete("done");
        return { status: "failed" as const, summary: "deterministic gate failed" };
      },
    });

    const result = await run(def, {}, { store, adapters: { complete: { complete: async (text) => text } } });
    const snapshot = store.runs().find((candidate) => candidate.id === result.runId);

    assert.equal(result.status, "failed");
    assert.equal(snapshot?.status, "failed");
    assert.equal(result.error, "deterministic gate failed");
    assert.deepEqual(result.result, { status: "failed", summary: "deterministic gate failed" });
    assert.deepEqual(snapshot?.result, { status: "failed", summary: "deterministic gate failed" });
  });

  test("blocked result.status makes the run blocked instead of completing successfully", async () => {
    const store = createStore();
    const def = workflow({
      name: "returned-blocked-status",
      description: "",
      inputs: {},
      outputs: {
        status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("blocked")]),
        summary: Type.String(),
      },
      run: async (ctx) => {
        await ctx.stage("work").complete("done");
        return { status: "blocked" as const, summary: "required checks are pending" };
      },
    });

    const result = await run(def, {}, { store, adapters: { complete: { complete: async (text) => text } } });
    const snapshot = store.runs().find((candidate) => candidate.id === result.runId);

    assert.equal(result.status, "blocked");
    assert.equal(snapshot?.status, "blocked");
    assert.equal(result.error, undefined);
    assert.deepEqual(result.result, { status: "blocked", summary: "required checks are pending" });
  });
});
