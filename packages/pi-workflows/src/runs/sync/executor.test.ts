import { test, expect, describe } from "bun:test";
import { run, resolveInputs } from "./executor.js";
import { createStore } from "../../store.js";
import { defineWorkflow } from "../../workflows/define-workflow.js";

// ---------------------------------------------------------------------------
// resolveInputs
// ---------------------------------------------------------------------------

describe("resolveInputs", () => {
  test("applies defaults for missing optional inputs", () => {
    const result = resolveInputs(
      {
        foo: { type: "text", default: "bar" },
        count: { type: "number", default: 42 },
      },
      {},
    );
    expect(result["foo"]).toBe("bar");
    expect(result["count"]).toBe(42);
  });

  test("passes through provided values", () => {
    const result = resolveInputs(
      { foo: { type: "text", default: "bar" } },
      { foo: "override" },
    );
    expect(result["foo"]).toBe("override");
  });

  test("does not override provided value with default", () => {
    const result = resolveInputs(
      { flag: { type: "boolean", default: false } },
      { flag: true },
    );
    expect(result["flag"]).toBe(true);
  });

  test("throws for missing required input", () => {
    expect(() =>
      resolveInputs(
        { prompt: { type: "text", required: true } },
        {},
      ),
    ).toThrow('pi-workflows: required input "prompt" not provided');
  });

  test("does not throw when required input is provided", () => {
    const result = resolveInputs(
      { prompt: { type: "text", required: true } },
      { prompt: "hello" },
    );
    expect(result["prompt"]).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// executor.run
// ---------------------------------------------------------------------------

describe("executor.run", () => {
  test("runs single-stage workflow with prompt adapter", async () => {
    const def = defineWorkflow("test-wf")
      .run(async (ctx) => {
        const result = await ctx.stage("stage-one").prompt("do the thing");
        return { result };
      })
      .compile();

    const wfResult = await run(def, {}, {
      adapters: { prompt: { prompt: async (text) => `response to: ${text}` } },
      store: createStore(),
    });

    expect(wfResult.status).toBe("completed");
    expect(wfResult.result?.["result"]).toBe("response to: do the thing");
    expect(wfResult.stages).toHaveLength(1);
    expect(wfResult.stages[0]?.name).toBe("stage-one");
    expect(wfResult.stages[0]?.status).toBe("completed");
  });

  test("runs parallel stages", async () => {
    const def = defineWorkflow("parallel-wf")
      .run(async (ctx) => {
        const [a, b] = await Promise.all([
          ctx.stage("stage-a").prompt("a"),
          ctx.stage("stage-b").prompt("b"),
        ]);
        const c = await ctx.stage("stage-c").prompt("c");
        return { a, b, c };
      })
      .compile();

    const wfResult = await run(def, {}, {
      adapters: { prompt: { prompt: async (text) => `r:${text}` } },
      store: createStore(),
    });

    expect(wfResult.status).toBe("completed");
    expect(wfResult.stages).toHaveLength(3);

    // stage-c should have stage-a and stage-b as parents
    const stageC = wfResult.stages.find((s) => s.name === "stage-c");
    expect(stageC).toBeDefined();
    expect(stageC?.parentIds).toHaveLength(2);
  });

  test("records lifecycle callbacks", async () => {
    const def = defineWorkflow("lifecycle-wf")
      .run(async (ctx) => {
        await ctx.stage("my-stage").prompt("x");
        return { done: true };
      })
      .compile();

    const events: string[] = [];
    const testStore = createStore();

    const wfResult = await run(def, {}, {
      adapters: { prompt: { prompt: async () => "ok" } },
      store: testStore,
      onRunStart: () => events.push("runStart"),
      onStageStart: () => events.push("stageStart"),
      onStageEnd: () => events.push("stageEnd"),
      onRunEnd: () => events.push("runEnd"),
    });

    expect(wfResult.status).toBe("completed");
    expect(events).toContain("runStart");
    expect(events).toContain("stageStart");
    expect(events).toContain("stageEnd");
    expect(events).toContain("runEnd");
  });

  test("returns failed status when stage throws", async () => {
    const def = defineWorkflow("fail-wf")
      .run(async (ctx) => {
        await ctx.stage("bad").prompt("x");
        return {};
      })
      .compile();

    const wfResult = await run(def, {}, {
      adapters: {
        prompt: {
          prompt: async () => {
            throw new Error("stage error");
          },
        },
      },
      store: createStore(),
    });

    expect(wfResult.status).toBe("failed");
    expect(wfResult.error).toContain("stage error");
  });

  test("stage snapshot records failed status when stage throws", async () => {
    const def = defineWorkflow("fail-stage-wf")
      .run(async (ctx) => {
        await ctx.stage("bad-stage").prompt("x");
        return {};
      })
      .compile();

    const wfResult = await run(def, {}, {
      adapters: {
        prompt: {
          prompt: async () => {
            throw new Error("explode");
          },
        },
      },
      store: createStore(),
    });

    expect(wfResult.status).toBe("failed");
    const badStage = wfResult.stages.find((s) => s.name === "bad-stage");
    expect(badStage?.status).toBe("failed");
    expect(badStage?.error).toContain("explode");
  });

  test("subagent throws clear error when adapter absent", async () => {
    const def = defineWorkflow("sa-wf")
      .run(async (ctx) => {
        await ctx.stage("s").subagent({ agent: "foo", task: "bar" });
        return {};
      })
      .compile();

    const wfResult = await run(def, {}, { store: createStore() });
    expect(wfResult.status).toBe("failed");
    expect(wfResult.error).toContain("pi-subagents");
  });

  test("complete throws clear error when adapter absent", async () => {
    const def = defineWorkflow("complete-wf")
      .run(async (ctx) => {
        await ctx.stage("s").complete("summarize this");
        return {};
      })
      .compile();

    const wfResult = await run(def, {}, { store: createStore() });
    expect(wfResult.status).toBe("failed");
    expect(wfResult.error).toContain("complete adapter not configured");
  });

  test("resolves inputs with schema defaults", async () => {
    const def = defineWorkflow("inputs-wf")
      .input("greeting", { type: "text", default: "hello" })
      .run(async (ctx) => {
        const greeting = ctx.stage("greet").prompt(String(ctx.inputs["greeting"]));
        return { out: await greeting };
      })
      .compile();

    const wfResult = await run(def as import("../../shared/types.js").WorkflowDefinition, {}, {
      adapters: { prompt: { prompt: async (text) => text } },
      store: createStore(),
    });

    expect(wfResult.status).toBe("completed");
    expect(wfResult.result?.["out"]).toBe("hello");
  });

  test("throws for missing required input before run starts", async () => {
    const def = defineWorkflow("required-wf")
      .input("query", { type: "text", required: true })
      .run(async (_ctx) => ({}))
      .compile();

    // resolveInputs throws synchronously, but run() wraps it as async rejection
    await expect(run(def as import("../../shared/types.js").WorkflowDefinition, {}, { store: createStore() })).rejects.toThrow(
      'pi-workflows: required input "query" not provided',
    );
  });

  test("store receives correct snapshots", async () => {
    const testStore = createStore();
    const def = defineWorkflow("store-wf")
      .run(async (ctx) => {
        await ctx.stage("step-one").prompt("go");
        return { ok: true };
      })
      .compile();

    const wfResult = await run(def, {}, {
      adapters: { prompt: { prompt: async () => "done" } },
      store: testStore,
    });

    expect(wfResult.status).toBe("completed");

    const snap = testStore.snapshot();
    expect(snap.runs).toHaveLength(1);
    expect(snap.runs[0]?.status).toBe("completed");
    expect(snap.runs[0]?.stages).toHaveLength(1);
    expect(snap.runs[0]?.stages[0]?.status).toBe("completed");
  });

  test("sequential stages: correct parent chain", async () => {
    const def = defineWorkflow("seq-wf")
      .run(async (ctx) => {
        await ctx.stage("s1").prompt("one");
        await ctx.stage("s2").prompt("two");
        await ctx.stage("s3").prompt("three");
        return {};
      })
      .compile();

    const wfResult = await run(def, {}, {
      adapters: { prompt: { prompt: async (t) => t } },
      store: createStore(),
    });

    expect(wfResult.status).toBe("completed");
    expect(wfResult.stages).toHaveLength(3);

    const s1 = wfResult.stages.find((s) => s.name === "s1");
    const s2 = wfResult.stages.find((s) => s.name === "s2");
    const s3 = wfResult.stages.find((s) => s.name === "s3");

    expect(s1?.parentIds).toEqual([]);
    expect(s2?.parentIds).toHaveLength(1);
    expect(s3?.parentIds).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// HIL adapter injection
// ---------------------------------------------------------------------------

describe("executor.run — HIL adapter injection", () => {
  test("ctx.ui.input delegates to injected adapter", async () => {
    let capturedPrompt: string | undefined;
    const uiAdapter = {
      input: async (prompt: string) => { capturedPrompt = prompt; return "user-input"; },
      confirm: async (_message: string) => false,
      select: async <T extends string>(_message: string, options: readonly T[]) => options[0] as T,
      editor: async (_initial?: string) => "",
    };

    const def = defineWorkflow("hil-input-wf")
      .run(async (ctx) => {
        const value = await ctx.ui.input("What is your name?");
        return { value };
      })
      .compile();

    const wfResult = await run(def, {}, { ui: uiAdapter, store: createStore() });

    expect(wfResult.status).toBe("completed");
    expect(wfResult.result?.["value"]).toBe("user-input");
    expect(capturedPrompt).toBe("What is your name?");
  });

  test("ctx.ui.confirm delegates to injected adapter", async () => {
    const uiAdapter = {
      input: async (_prompt: string) => "",
      confirm: async (_message: string) => true,
      select: async <T extends string>(_message: string, options: readonly T[]) => options[0] as T,
      editor: async (_initial?: string) => "",
    };

    const def = defineWorkflow("hil-confirm-wf")
      .run(async (ctx) => {
        const ok = await ctx.ui.confirm("Continue?");
        return { ok };
      })
      .compile();

    const wfResult = await run(def, {}, { ui: uiAdapter, store: createStore() });

    expect(wfResult.status).toBe("completed");
    expect(wfResult.result?.["ok"]).toBe(true);
  });

  test("ctx.ui.select delegates to injected adapter", async () => {
    const uiAdapter = {
      input: async (_prompt: string) => "",
      confirm: async (_message: string) => false,
      select: async <T extends string>(_message: string, options: readonly T[]) => options[1] as T,
      editor: async (_initial?: string) => "",
    };

    const def = defineWorkflow("hil-select-wf")
      .run(async (ctx) => {
        const choice = await ctx.ui.select("Pick one", ["a", "b", "c"] as const);
        return { choice };
      })
      .compile();

    const wfResult = await run(def, {}, { ui: uiAdapter, store: createStore() });

    expect(wfResult.status).toBe("completed");
    expect(wfResult.result?.["choice"]).toBe("b");
  });

  test("ctx.ui.editor delegates to injected adapter", async () => {
    const uiAdapter = {
      input: async (_prompt: string) => "",
      confirm: async (_message: string) => false,
      select: async <T extends string>(_message: string, options: readonly T[]) => options[0] as T,
      editor: async (initial?: string) => `edited: ${initial ?? ""}`,
    };

    const def = defineWorkflow("hil-editor-wf")
      .run(async (ctx) => {
        const content = await ctx.ui.editor("draft");
        return { content };
      })
      .compile();

    const wfResult = await run(def, {}, { ui: uiAdapter, store: createStore() });

    expect(wfResult.status).toBe("completed");
    expect(wfResult.result?.["content"]).toBe("edited: draft");
  });

  test("fallback rejects ctx.ui.input with precise missing-adapter error", async () => {
    const def = defineWorkflow("fallback-input-wf")
      .run(async (ctx) => {
        await ctx.ui.input("hello");
        return {};
      })
      .compile();

    const wfResult = await run(def, {}, { store: createStore() });

    expect(wfResult.status).toBe("failed");
    expect(wfResult.error).toBe(
      "pi-workflows: HIL ctx.ui.input is unavailable because pi runtime did not provide a UI adapter",
    );
  });

  test("fallback rejects ctx.ui.confirm with precise missing-adapter error", async () => {
    const def = defineWorkflow("fallback-confirm-wf")
      .run(async (ctx) => {
        await ctx.ui.confirm("sure?");
        return {};
      })
      .compile();

    const wfResult = await run(def, {}, { store: createStore() });

    expect(wfResult.status).toBe("failed");
    expect(wfResult.error).toBe(
      "pi-workflows: HIL ctx.ui.confirm is unavailable because pi runtime did not provide a UI adapter",
    );
  });

  test("fallback rejects ctx.ui.select with precise missing-adapter error", async () => {
    const def = defineWorkflow("fallback-select-wf")
      .run(async (ctx) => {
        await ctx.ui.select("pick", ["x"] as const);
        return {};
      })
      .compile();

    const wfResult = await run(def, {}, { store: createStore() });

    expect(wfResult.status).toBe("failed");
    expect(wfResult.error).toBe(
      "pi-workflows: HIL ctx.ui.select is unavailable because pi runtime did not provide a UI adapter",
    );
  });

  test("fallback rejects ctx.ui.editor with precise missing-adapter error", async () => {
    const def = defineWorkflow("fallback-editor-wf")
      .run(async (ctx) => {
        await ctx.ui.editor();
        return {};
      })
      .compile();

    const wfResult = await run(def, {}, { store: createStore() });

    expect(wfResult.status).toBe("failed");
    expect(wfResult.error).toBe(
      "pi-workflows: HIL ctx.ui.editor is unavailable because pi runtime did not provide a UI adapter",
    );
  });

  test("no HIL: existing run behavior unchanged when no HIL used", async () => {
    const def = defineWorkflow("no-hil-wf")
      .run(async (ctx) => {
        const r = await ctx.stage("s").prompt("go");
        return { r };
      })
      .compile();

    const wfResult = await run(def, {}, {
      adapters: { prompt: { prompt: async () => "ok" } },
      store: createStore(),
    });

    expect(wfResult.status).toBe("completed");
    expect(wfResult.result?.["r"]).toBe("ok");
  });
});

