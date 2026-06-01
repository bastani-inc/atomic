/**
 * Phase C tests — executor single-stage and related behaviors.
 * Covers:
 *  - Single-stage workflow with injected prompt adapter returns output + records store run/stage events.
 *  - Required/default input resolution.
 *  - Missing prompt adapter error.
 *  - Missing complete adapter error.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { run, resolveInputs } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function promptAdapter(fn: (text: string) => Promise<string> | string = (t) => `ok:${t}`) {
  return { prompt: { prompt: async (t: string) => fn(t) } };
}

// ---------------------------------------------------------------------------
// resolveInputs — unit level
// ---------------------------------------------------------------------------

describe("resolveInputs — Phase C", () => {
  test("applies default when key absent", () => {
    const r = resolveInputs({ msg: { type: "text", default: "hello" } }, {});
    assert.equal(r["msg"], "hello");
  });

  test("provided value overrides default", () => {
    const r = resolveInputs({ msg: { type: "text", default: "hello" } }, { msg: "world" });
    assert.equal(r["msg"], "world");
  });

  test("boolean false is preserved and not overridden by default", () => {
    const r = resolveInputs({ flag: { type: "boolean", default: true } }, { flag: false });
    assert.equal(r["flag"], false);
  });

  test("number default applied", () => {
    const r = resolveInputs({ count: { type: "number", default: 7 } }, {});
    assert.equal(r["count"], 7);
  });

  test("required field present — no throw", () => {
    const r = resolveInputs({ q: { type: "text", required: true } }, { q: "value" });
    assert.equal(r["q"], "value");
  });

  test("required field absent — throws with field name", () => {
    assert.throws(() => resolveInputs({ q: { type: "text", required: true } }, {}), { message: 'atomic-workflows: required input "q" not provided', });
  });

  test("multiple required fields — throws on first missing", () => {
    assert.throws(() =>
      resolveInputs(
        {
          a: { type: "text", required: true },
          b: { type: "text", required: true },
        },
        { a: "present" },
      ), { message: 'atomic-workflows: required input "b" not provided' });
  });

  test("optional field with no default and not provided — stays undefined", () => {
    const r = resolveInputs({ x: { type: "text" } }, {});
    assert.equal(r["x"], undefined);
  });
});

// ---------------------------------------------------------------------------
// Single-stage workflow — core Phase C requirement
// ---------------------------------------------------------------------------

describe("executor single-stage — Phase C", () => {
  test("returns completed status and stage output", async () => {
    const def = defineWorkflow("phaseC-single")
      .output("out", { type: "unknown" })
      .run(async (ctx) => {
        const out = await ctx.stage("main-stage").prompt("do work");
        return { out };
      })
      .compile();

    const result = await run(def, {}, {
      adapters: promptAdapter((t) => `result:${t}`),
      store: createStore(),
    });

    assert.equal(result.status, "completed");
    assert.equal(result.result?.["out"], "result:do work");
  });

  test("returned stages array has length 1 with correct name", async () => {
    const def = defineWorkflow("phaseC-stages-len")
      .run(async (ctx) => {
        await ctx.stage("the-stage").prompt("x");
        return {};
      })
      .compile();

    const result = await run(def, {}, { adapters: promptAdapter(), store: createStore() });
    assert.equal(result.stages.length, 1);
    assert.equal(result.stages[0]?.name, "the-stage");
  });

  test("stage status is completed after successful run", async () => {
    const def = defineWorkflow("phaseC-stage-status")
      .run(async (ctx) => {
        await ctx.stage("s").prompt("go");
        return {};
      })
      .compile();

    const result = await run(def, {}, { adapters: promptAdapter(), store: createStore() });
    assert.equal(result.stages[0]?.status, "completed");
  });

  test("store records run snapshot as completed", async () => {
    const store = createStore();
    const def = defineWorkflow("phaseC-store-run")
      .output("done", { type: "unknown" })
      .run(async (ctx) => {
        await ctx.stage("step").prompt("task");
        return { done: true };
      })
      .compile();

    await run(def, {}, { adapters: promptAdapter(), store });

    const snap = store.snapshot();
    assert.equal(snap.runs.length, 1);
    assert.equal(snap.runs[0]?.status, "completed");
    assert.equal(snap.runs[0]?.result?.["done"], true);
  });

  test("store records stage snapshot with completed status", async () => {
    const store = createStore();
    const def = defineWorkflow("phaseC-store-stage")
      .run(async (ctx) => {
        await ctx.stage("my-step").prompt("something");
        return {};
      })
      .compile();

    await run(def, {}, { adapters: promptAdapter(), store });

    const snap = store.snapshot();
    const stage = snap.runs[0]?.stages[0];
    assert.equal(stage?.name, "my-step");
    assert.equal(stage?.status, "completed");
  });

  test("onRunStart + onRunEnd callbacks fire", async () => {
    const events: string[] = [];
    const def = defineWorkflow("phaseC-callbacks")
      .run(async (ctx) => {
        await ctx.stage("s").prompt("x");
        return {};
      })
      .compile();

    await run(def, {}, {
      adapters: promptAdapter(),
      store: createStore(),
      onRunStart: () => events.push("runStart"),
      onRunEnd: () => events.push("runEnd"),
    });

    assert.ok(events.includes("runStart"));
    assert.ok(events.includes("runEnd"));
  });

  test("onStageStart + onStageEnd callbacks fire", async () => {
    const events: string[] = [];
    const def = defineWorkflow("phaseC-stage-callbacks")
      .run(async (ctx) => {
        await ctx.stage("s").prompt("x");
        return {};
      })
      .compile();

    await run(def, {}, {
      adapters: promptAdapter(),
      store: createStore(),
      onStageStart: () => events.push("stageStart"),
      onStageEnd: () => events.push("stageEnd"),
    });

    assert.ok(events.includes("stageStart"));
    assert.ok(events.includes("stageEnd"));
  });

  test("runId is a non-empty string", async () => {
    const def = defineWorkflow("phaseC-runid")
      .run(async (ctx) => {
        await ctx.stage("s").prompt("x");
        return {};
      })
      .compile();

    const result = await run(def, {}, { adapters: promptAdapter(), store: createStore() });
    assert.equal(typeof result.runId, "string");
    assert.ok(result.runId.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Input resolution via executor
// ---------------------------------------------------------------------------

describe("executor input resolution — Phase C", () => {
  test("schema default flows into ctx.inputs", async () => {
    const def = defineWorkflow("phaseC-defaults")
      .input("greeting", { type: "text", default: "hi" })
      .output("greeting", { type: "unknown" })
      .run(async (ctx) => {
        await ctx.stage("read-default").prompt("x");
        return { greeting: ctx.inputs["greeting"] };
      })
      .compile() as WorkflowDefinition;

    const result = await run(def, {}, { adapters: promptAdapter(), store: createStore() });
    assert.equal(result.status, "completed");
    assert.equal(result.result?.["greeting"], "hi");
  });

  test("caller-provided value takes precedence over default", async () => {
    const def = defineWorkflow("phaseC-override")
      .input("name", { type: "text", default: "default-name" })
      .output("name", { type: "unknown" })
      .run(async (ctx) => {
        await ctx.stage("read-override").prompt("x");
        return { name: ctx.inputs["name"] };
      })
      .compile() as WorkflowDefinition;

    const result = await run(def, { name: "custom" }, {
      adapters: promptAdapter(),
      store: createStore(),
    });

    assert.equal(result.result?.["name"], "custom");
  });

  test("missing required input rejects before run starts", async () => {
    const def = defineWorkflow("phaseC-required")
      .input("query", { type: "text", required: true })
      .run(async (_ctx) => ({}))
      .compile() as WorkflowDefinition;

    await assert.rejects(run(def, {}, { store: createStore() }), { message: 'atomic-workflows: required input "query" not provided', });
  });
});

// ---------------------------------------------------------------------------
// Adapter missing errors — Phase C
// ---------------------------------------------------------------------------

describe("executor adapter errors — Phase C", () => {
  test("complete adapters absent — stage fails with complete-specific error message", async () => {
    const def = defineWorkflow("phaseC-no-complete")
      .run(async (ctx) => {
        await ctx.stage("s").complete("summarize");
        return {};
      })
      .compile();

    const result = await run(def, {}, { adapters: {}, store: createStore() });
    assert.equal(result.status, "failed");
    assert.ok(
      result.error!.includes(
        "ctx.complete requires either RunOpts.adapters.complete or RunOpts.adapters.agentSession",
      ),
    );
  });


  test("stage snapshot has failed status when adapter is absent", async () => {
    const def = defineWorkflow("phaseC-stage-fail-snap")
      .run(async (ctx) => {
        await ctx.stage("bad-stage").complete("go");
        return {};
      })
      .compile();

    const result = await run(def, {}, { adapters: {}, store: createStore() });
    const bad = result.stages.find((s) => s.name === "bad-stage");
    assert.equal(bad?.status, "failed");
    assert.notEqual(bad?.error, undefined);
  });
});

// ---------------------------------------------------------------------------
// Stage result propagation
// ---------------------------------------------------------------------------

describe("stage result propagation — Phase C", () => {
  test("adapter response is returned as stage result", async () => {
    const def = defineWorkflow("phaseC-result-prop")
      .output("answer", { type: "unknown" })
      .run(async (ctx) => {
        const answer = await ctx.stage("qa").prompt("what is 2+2?");
        return { answer };
      })
      .compile();

    const result = await run(def, {}, {
      adapters: promptAdapter(() => "4"),
      store: createStore(),
    });

    assert.equal(result.result?.["answer"], "4");
  });

  test("stage snapshot result field matches adapter response", async () => {
    const def = defineWorkflow("phaseC-snap-result")
      .run(async (ctx) => {
        await ctx.stage("compute").prompt("input");
        return {};
      })
      .compile();

    const result = await run(def, {}, {
      adapters: promptAdapter(() => "computed-value"),
      store: createStore(),
    });

    assert.equal(result.stages[0]?.result, "computed-value");
  });
});
