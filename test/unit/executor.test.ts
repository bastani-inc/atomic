import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, runChain, runParallel, runTask, resolveInputs } from "../../src/runs/foreground/executor.js";
import { createStore } from "../../src/shared/store.js";
import { defineWorkflow } from "../../src/workflows/define-workflow.js";
import type { AgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

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
    assert.equal(result["foo"], "bar");
    assert.equal(result["count"], 42);
  });

  test("passes through provided values", () => {
    const result = resolveInputs(
      { foo: { type: "text", default: "bar" } },
      { foo: "override" },
    );
    assert.equal(result["foo"], "override");
  });

  test("does not override provided value with default", () => {
    const result = resolveInputs(
      { flag: { type: "boolean", default: false } },
      { flag: true },
    );
    assert.equal(result["flag"], true);
  });

  test("throws for missing required input", () => {
    assert.throws(() =>
      resolveInputs(
        { prompt: { type: "text", required: true } },
        {},
      ), { message: 'pi-workflows: required input "prompt" not provided' });
  });

  test("does not throw when required input is provided", () => {
    const result = resolveInputs(
      { prompt: { type: "text", required: true } },
      { prompt: "hello" },
    );
    assert.equal(result["prompt"], "hello");
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

    assert.equal(wfResult.status, "completed");
    assert.equal(wfResult.result?.["result"], "response to: do the thing");
    assert.equal(wfResult.stages.length, 1);
    assert.equal(wfResult.stages[0]?.name, "stage-one");
    assert.equal(wfResult.stages[0]?.status, "completed");
  });

  test("ctx.task creates a tracked stage and returns reusable previous output", async () => {
    const seenPrompts: string[] = [];
    const def = defineWorkflow("task-wf")
      .run(async (ctx) => {
        const scout = await ctx.task("scout", { prompt: "scout repo" });
        const planner = await ctx.task("planner", {
          prompt: "plan from {previous}",
          previous: scout,
        });
        return { scout: scout.text, planner: planner.text };
      })
      .compile();

    const wfResult = await run(def, {}, {
      adapters: {
        prompt: {
          prompt: async (text) => {
            seenPrompts.push(text);
            return text === "scout repo" ? "scout findings" : "planner output";
          },
        },
      },
      store: createStore(),
    });

    assert.equal(wfResult.status, "completed");
    assert.equal(wfResult.result?.["scout"], "scout findings");
    assert.equal(wfResult.result?.["planner"], "planner output");
    assert.deepEqual(seenPrompts, ["scout repo", "plan from scout findings"]);
    assert.deepEqual(wfResult.stages.map((s) => s.name), ["scout", "planner"]);
  });

  test("ctx.task appends named previous output when no placeholder is present", async () => {
    const seenPrompts: string[] = [];
    const def = defineWorkflow("task-context-wf")
      .run(async (ctx) => {
        const first = await ctx.task("first", { prompt: "first" });
        await ctx.task("second", {
          prompt: "second",
          previous: [first, { name: "notes", text: "manual notes" }],
        });
        return { done: true };
      })
      .compile();

    const wfResult = await run(def, {}, {
      adapters: {
        prompt: {
          prompt: async (text) => {
            seenPrompts.push(text);
            return text === "first" ? "first output" : "second output";
          },
        },
      },
      store: createStore(),
    });

    assert.equal(wfResult.status, "completed");
    assert.match(seenPrompts[1]!, /Context:/);
    assert.match(seenPrompts[1]!, /--- first ---\nfirst output/);
    assert.match(seenPrompts[1]!, /--- notes ---\nmanual notes/);
  });

  test("ctx.chain follows pi-subagents direct-command previous defaults", async () => {
    const seenPrompts: string[] = [];
    const def = defineWorkflow("task-chain-wf")
      .run(async (ctx) => {
        const results = await ctx.chain([
          { name: "scout" },
          { name: "planner" },
          { name: "worker", task: "implement from {previous}" },
        ], { task: "analyze auth" });
        return { final: results.at(-1)?.text };
      })
      .compile();

    const wfResult = await run(def, {}, {
      adapters: {
        prompt: {
          prompt: async (text) => {
            seenPrompts.push(text);
            return `out:${seenPrompts.length}`;
          },
        },
      },
      store: createStore(),
    });

    assert.equal(wfResult.status, "completed");
    assert.deepEqual(seenPrompts, ["analyze auth", "out:1", "implement from out:2"]);
    assert.equal(wfResult.result?.["final"], "out:3");
  });

  test("ctx.parallel follows pi-subagents direct-command shared task fallback", async () => {
    const seenPrompts: string[] = [];
    const def = defineWorkflow("task-parallel-wf")
      .run(async (ctx) => {
        const results = await ctx.parallel([
          { name: "frontend", task: "audit UI" },
          { name: "backend" },
        ]);
        return { count: results.length };
      })
      .compile();

    const wfResult = await run(def, {}, {
      adapters: {
        prompt: {
          prompt: async (text) => {
            seenPrompts.push(text);
            return `out:${text}`;
          },
        },
      },
      store: createStore(),
    });

    assert.equal(wfResult.status, "completed");
    assert.deepEqual(seenPrompts.sort(), ["audit UI", "audit UI"]);
    assert.equal(wfResult.result?.["count"], 2);
  });

  test("ctx.task forwards createAgentSession options to the SDK session", async () => {
    const calls: CreateAgentSessionOptions[] = [];
    const def = defineWorkflow("task-session-options-wf")
      .run(async (ctx) => {
        const result = await ctx.task("scout", {
          task: "inspect",
          cwd: "/repo",
          tools: ["read"],
          noTools: "builtin",
          thinkingLevel: "high",
        });
        return { text: result.text };
      })
      .compile();

    const wfResult = await run(def, {}, {
      adapters: {
        agentSession: {
          async create(options) {
            calls.push(options);
            return mockSession();
          },
        },
      },
      store: createStore(),
    });

    assert.equal(wfResult.status, "completed");
    assert.equal(calls[0]?.cwd, "/repo");
    assert.deepEqual(calls[0]?.tools, ["read"]);
    assert.equal(calls[0]?.noTools, "builtin");
    assert.equal(calls[0]?.thinkingLevel, "high");
  });

  test("ctx.task applies maxOutput truncation to reusable task output", async () => {
    const def = defineWorkflow("task-max-output-wf")
      .run(async (ctx) => {
        const result = await ctx.task("summarizer", {
          task: "summarize",
          maxOutput: { lines: 1, bytes: 8 },
        });
        return { text: result.text };
      })
      .compile();

    const wfResult = await run(def, {}, {
      adapters: {
        prompt: {
          prompt: async () => "first line\nsecond line",
        },
      },
      store: createStore(),
    });

    assert.equal(wfResult.status, "completed");
    assert.match(String(wfResult.result?.["text"]), /^first li\n\n\[workflow output truncated/);
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

    assert.equal(wfResult.status, "completed");
    assert.equal(wfResult.stages.length, 3);

    // stage-c should have stage-a and stage-b as parents
    const stageC = wfResult.stages.find((s) => s.name === "stage-c");
    assert.notEqual(stageC, undefined);
    assert.equal(stageC?.parentIds.length, 2);
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

    assert.equal(wfResult.status, "completed");
    assert.ok(events.includes("runStart"));
    assert.ok(events.includes("stageStart"));
    assert.ok(events.includes("stageEnd"));
    assert.ok(events.includes("runEnd"));
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

    assert.equal(wfResult.status, "failed");
    assert.ok(wfResult.error!.includes("stage error"));
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

    assert.equal(wfResult.status, "failed");
    const badStage = wfResult.stages.find((s) => s.name === "bad-stage");
    assert.equal(badStage?.status, "failed");
    assert.ok(badStage?.error!.includes("explode"));
  });

  test("subagent throws clear error when adapter absent", async () => {
    const def = defineWorkflow("sa-wf")
      .run(async (ctx) => {
        await ctx.stage("s").subagent({ agent: "foo", task: "bar" });
        return {};
      })
      .compile();

    const wfResult = await run(def, {}, { store: createStore() });
    assert.equal(wfResult.status, "failed");
    assert.ok(wfResult.error!.includes("pi task delegation"));
  });

  test("complete throws clear error when adapter absent", async () => {
    const def = defineWorkflow("complete-wf")
      .run(async (ctx) => {
        await ctx.stage("s").complete("summarize this");
        return {};
      })
      .compile();

    const wfResult = await run(def, {}, { store: createStore() });
    assert.equal(wfResult.status, "failed");
    assert.ok(wfResult.error!.includes("complete adapter not configured"));
  });

  test("resolves inputs with schema defaults", async () => {
    const def = defineWorkflow("inputs-wf")
      .input("greeting", { type: "text", default: "hello" })
      .run(async (ctx) => {
        const greeting = ctx.stage("greet").prompt(String(ctx.inputs["greeting"]));
        return { out: await greeting };
      })
      .compile();

    const wfResult = await run(def as import("../../src/shared/types.js").WorkflowDefinition, {}, {
      adapters: { prompt: { prompt: async (text) => text } },
      store: createStore(),
    });

    assert.equal(wfResult.status, "completed");
    assert.equal(wfResult.result?.["out"], "hello");
  });

  test("throws for missing required input before run starts", async () => {
    const def = defineWorkflow("required-wf")
      .input("query", { type: "text", required: true })
      .run(async (_ctx) => ({}))
      .compile();

    // resolveInputs throws synchronously, but run() wraps it as async rejection
    await assert.rejects(run(def as import("../../src/shared/types.js").WorkflowDefinition, {}, { store: createStore() }), { message: 'pi-workflows: required input "query" not provided', });
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

    assert.equal(wfResult.status, "completed");

    const snap = testStore.snapshot();
    assert.equal(snap.runs.length, 1);
    assert.equal(snap.runs[0]?.status, "completed");
    assert.equal(snap.runs[0]?.stages.length, 1);
    assert.equal(snap.runs[0]?.stages[0]?.status, "completed");
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

    assert.equal(wfResult.status, "completed");
    assert.equal(wfResult.stages.length, 3);

    const s1 = wfResult.stages.find((s) => s.name === "s1");
    const s2 = wfResult.stages.find((s) => s.name === "s2");
    const s3 = wfResult.stages.find((s) => s.name === "s3");

    assert.deepEqual(s1?.parentIds, []);
    assert.equal(s2?.parentIds.length, 1);
    assert.equal(s3?.parentIds.length, 1);
  });
});

describe("direct SDK helpers", () => {
  test("runTask executes through the workflow runtime and returns WorkflowDetails", async () => {
    const details = await runTask(
      { name: "scout", prompt: "inspect repo", thinkingLevel: "high" },
      {
        adapters: {
          prompt: {
            prompt: async (text) => `done:${text}`,
          },
        },
        store: createStore(),
      },
    );

    assert.equal(details.mode, "single");
    assert.equal(details.action, "run");
    assert.equal(details.status, "completed");
    assert.equal(details.results?.[0]?.name, "scout");
    assert.equal(details.results?.[0]?.text, "done:inspect repo");
    assert.ok(details.runId);
  });

  test("runTask direct items forward createAgentSession options to the SDK session", async () => {
    const calls: CreateAgentSessionOptions[] = [];
    const details = await runTask(
      {
        name: "scout",
        prompt: "inspect repo",
        cwd: "/repo",
        tools: ["read"],
        noTools: "builtin",
        thinkingLevel: "high",
      },
      {},
      {
        adapters: {
          agentSession: {
            async create(options) {
              calls.push(options);
              return mockSession();
            },
          },
        },
        store: createStore(),
      },
    );

    assert.equal(details.mode, "single");
    assert.equal(details.status, "completed");
    assert.equal(calls[0]?.cwd, "/repo");
    assert.deepEqual(calls[0]?.tools, ["read"]);
    assert.equal(calls[0]?.noTools, "builtin");
    assert.equal(calls[0]?.thinkingLevel, "high");
  });

  test("runTask direct options expose context and sessionDir", async () => {
    const calls: CreateAgentSessionOptions[] = [];
    const sessionDir = mkdtempSync(join(tmpdir(), "atomic-workflow-session-dir-"));
    const details = await runTask(
      { name: "scout", task: "inspect repo" },
      { context: "fork", sessionDir },
      {
        adapters: {
          agentSession: {
            async create(options) {
              calls.push(options);
              return mockSession();
            },
          },
        },
        store: createStore(),
      },
    );

    assert.equal(details.context, "fork");
    assert.notEqual(calls[0]?.sessionManager, undefined);
  });

  test("runTask writes output artifacts and records them in WorkflowDetails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-workflow-output-"));
    const output = join(dir, "review.md");

    const details = await runTask(
      { name: "reviewer", task: "write report", output },
      {
        adapters: {
          prompt: {
            prompt: async (text) => `done:${text}`,
          },
        },
        store: createStore(),
      },
    );

    assert.equal(readFileSync(output, "utf8"), "done:write report");
    assert.ok(details.artifacts?.some((artifact) =>
      artifact.kind === "output" &&
      artifact.path === output &&
      artifact.taskName === "reviewer",
    ));
  });

  test("runTask outputMode=file-only omits inline task text but still writes the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-workflow-output-"));
    const output = join(dir, "file-only.md");

    const details = await runTask(
      { name: "reviewer", task: "write private report", output, outputMode: "file-only" },
      {
        adapters: {
          prompt: {
            prompt: async (text) => `done:${text}`,
          },
        },
        store: createStore(),
      },
    );

    assert.equal(readFileSync(output, "utf8"), "done:write private report");
    assert.equal(details.results?.[0]?.text, "");
  });

  test("runParallel expands count and keeps repeated task names unique", async () => {
    const seen: string[] = [];
    const details = await runParallel(
      [{ name: "reviewer", task: "review", count: 2 }],
      {},
      {
        adapters: {
          prompt: {
            prompt: async (text) => {
              seen.push(text);
              return `out:${seen.length}`;
            },
          },
        },
        store: createStore(),
      },
    );

    assert.equal(details.mode, "parallel");
    assert.equal(details.status, "completed");
    assert.deepEqual(details.results?.map((result) => result.name), ["reviewer-1", "reviewer-2"]);
    assert.deepEqual(seen.sort(), ["review", "review"]);
  });

  test("runParallel namespaces repeated output paths when count expands a task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-workflow-output-"));
    const output = join(dir, "review.md");

    const details = await runParallel(
      [{ name: "reviewer", task: "review", count: 2, output }],
      {},
      {
        adapters: {
          prompt: {
            prompt: async (_text, meta) => `out:${meta?.stageName ?? "unknown"}`,
          },
        },
        store: createStore(),
      },
    );

    const artifactPaths = details.artifacts
      ?.filter((artifact) => artifact.kind === "output")
      .map((artifact) => artifact.path)
      .sort();
    assert.deepEqual(artifactPaths, [
      join(dir, "review-1.md"),
      join(dir, "review-2.md"),
    ]);
    assert.equal(readFileSync(join(dir, "review-1.md"), "utf8"), "out:reviewer-1");
    assert.equal(readFileSync(join(dir, "review-2.md"), "utf8"), "out:reviewer-2");
  });

  test("runChain supports sequential steps and parallel groups with previous handoff defaults", async () => {
    const prompts: string[] = [];
    const details = await runChain(
      [
        { name: "researcher" },
        {
          parallel: [
            { name: "reviewer-a" },
            { name: "reviewer-b", task: "check {previous}" },
          ],
        },
        { name: "planner", task: "plan {previous}" },
      ],
      { task: "map workflow api" },
      {
        adapters: {
          prompt: {
            prompt: async (text) => {
              prompts.push(text);
              return `out:${prompts.length}`;
            },
          },
        },
        store: createStore(),
      },
    );

    assert.equal(details.mode, "chain");
    assert.equal(details.status, "completed");
    assert.deepEqual(details.results?.map((result) => result.name), [
      "researcher",
      "reviewer-a",
      "reviewer-b",
      "planner",
    ]);
    assert.equal(prompts[0], "map workflow api");
    assert.ok(prompts.includes("out:1"));
    assert.ok(prompts.includes("check out:1"));
    assert.match(prompts[3]!, /^plan /);
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

    assert.equal(wfResult.status, "completed");
    assert.equal(wfResult.result?.["value"], "user-input");
    assert.equal(capturedPrompt, "What is your name?");
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

    assert.equal(wfResult.status, "completed");
    assert.equal(wfResult.result?.["ok"], true);
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

    assert.equal(wfResult.status, "completed");
    assert.equal(wfResult.result?.["choice"], "b");
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

    assert.equal(wfResult.status, "completed");
    assert.equal(wfResult.result?.["content"], "edited: draft");
  });

  test("fallback rejects ctx.ui.input with precise missing-adapter error", async () => {
    const def = defineWorkflow("fallback-input-wf")
      .run(async (ctx) => {
        await ctx.ui.input("hello");
        return {};
      })
      .compile();

    const wfResult = await run(def, {}, { store: createStore() });

    assert.equal(wfResult.status, "failed");
    assert.equal(wfResult.error, "pi-workflows: HIL ctx.ui.input is unavailable because pi runtime did not provide a UI adapter",);
  });

  test("fallback rejects ctx.ui.confirm with precise missing-adapter error", async () => {
    const def = defineWorkflow("fallback-confirm-wf")
      .run(async (ctx) => {
        await ctx.ui.confirm("sure?");
        return {};
      })
      .compile();

    const wfResult = await run(def, {}, { store: createStore() });

    assert.equal(wfResult.status, "failed");
    assert.equal(wfResult.error, "pi-workflows: HIL ctx.ui.confirm is unavailable because pi runtime did not provide a UI adapter",);
  });

  test("fallback rejects ctx.ui.select with precise missing-adapter error", async () => {
    const def = defineWorkflow("fallback-select-wf")
      .run(async (ctx) => {
        await ctx.ui.select("pick", ["x"] as const);
        return {};
      })
      .compile();

    const wfResult = await run(def, {}, { store: createStore() });

    assert.equal(wfResult.status, "failed");
    assert.equal(wfResult.error, "pi-workflows: HIL ctx.ui.select is unavailable because pi runtime did not provide a UI adapter",);
  });

  test("fallback rejects ctx.ui.editor with precise missing-adapter error", async () => {
    const def = defineWorkflow("fallback-editor-wf")
      .run(async (ctx) => {
        await ctx.ui.editor();
        return {};
      })
      .compile();

    const wfResult = await run(def, {}, { store: createStore() });

    assert.equal(wfResult.status, "failed");
    assert.equal(wfResult.error, "pi-workflows: HIL ctx.ui.editor is unavailable because pi runtime did not provide a UI adapter",);
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

    assert.equal(wfResult.status, "completed");
    assert.equal(wfResult.result?.["r"], "ok");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle persistence — appendEntry ordering
// ---------------------------------------------------------------------------

describe("executor.run — lifecycle persistence", () => {
  function makePersistence() {
    const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const persistence = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        calls.push({ type, payload });
        return `entry-${calls.length}`;
      },
      setLabel(_entryId: string, _label: string): void {},
    };
    return { persistence, calls };
  }

  test("appends ordered run.start → stage.start → stage.end → run.end on success", async () => {
    const { persistence, calls } = makePersistence();

    const def = defineWorkflow("persist-wf")
      .run(async (ctx) => {
        await ctx.stage("s1").prompt("go");
        return { ok: true };
      })
      .compile();

    const wfResult = await run(def, {}, {
      adapters: { prompt: { prompt: async () => "done" } },
      store: createStore(),
      persistence,
    });

    assert.equal(wfResult.status, "completed");

    const types = calls.map((c) => c.type);
    assert.deepEqual(types, [
      "workflow.run.start",
      "workflow.stage.start",
      "workflow.stage.end",
      "workflow.run.end",
    ]);
  });

  test("run.start payload contains runId, name, inputs, ts", async () => {
    const { persistence, calls } = makePersistence();

    const def = defineWorkflow("payload-wf")
      .run(async (_ctx) => ({}))
      .compile();

    const wfResult = await run(def, { x: 1 }, {
      store: createStore(),
      persistence,
    });

    const runStart = calls.find((c) => c.type === "workflow.run.start");
    assert.notEqual(runStart, undefined);
    assert.equal(runStart?.payload["runId"], wfResult.runId);
    assert.equal(runStart?.payload["name"], "payload-wf");
    assert.deepEqual(runStart?.payload["inputs"], { x: 1 }) // TODO: was toMatchObject — may need subset check;
    assert.equal(typeof runStart?.payload["ts"], "number");
  });

  test("stage.start payload contains runId, stageId, name, parentIds", async () => {
    const { persistence, calls } = makePersistence();

    const def = defineWorkflow("stage-payload-wf")
      .run(async (ctx) => {
        await ctx.stage("my-stage").prompt("x");
        return {};
      })
      .compile();

    const wfResult = await run(def, {}, {
      adapters: { prompt: { prompt: async () => "r" } },
      store: createStore(),
      persistence,
    });

    const stageStart = calls.find((c) => c.type === "workflow.stage.start");
    assert.notEqual(stageStart, undefined);
    assert.equal(stageStart?.payload["runId"], wfResult.runId);
    assert.equal(stageStart?.payload["name"], "my-stage");
    assert.equal(Array.isArray(stageStart?.payload["parentIds"]), true);
  });

  test("stage.end payload contains status completed on success", async () => {
    const { persistence, calls } = makePersistence();

    const def = defineWorkflow("stage-end-wf")
      .run(async (ctx) => {
        await ctx.stage("s").prompt("x");
        return {};
      })
      .compile();

    await run(def, {}, {
      adapters: { prompt: { prompt: async () => "r" } },
      store: createStore(),
      persistence,
    });

    const stageEnd = calls.find((c) => c.type === "workflow.stage.end");
    assert.equal(stageEnd?.payload["status"], "completed");
  });

  test("run.end payload contains status completed on success", async () => {
    const { persistence, calls } = makePersistence();

    const def = defineWorkflow("run-end-wf")
      .run(async (_ctx) => ({ x: 1 }))
      .compile();

    await run(def, {}, { store: createStore(), persistence });

    const runEnd = calls.find((c) => c.type === "workflow.run.end");
    assert.equal(runEnd?.payload["status"], "completed");
    assert.equal(typeof runEnd?.payload["ts"], "number");
  });

  test("failed stage: stage.end status=failed, run.end status=failed", async () => {
    const { persistence, calls } = makePersistence();

    const def = defineWorkflow("fail-persist-wf")
      .run(async (ctx) => {
        await ctx.stage("bad").prompt("x");
        return {};
      })
      .compile();

    const wfResult = await run(def, {}, {
      adapters: { prompt: { prompt: async () => { throw new Error("boom"); } } },
      store: createStore(),
      persistence,
    });

    assert.equal(wfResult.status, "failed");

    const stageEnd = calls.find((c) => c.type === "workflow.stage.end");
    assert.equal(stageEnd?.payload["status"], "failed");

    const runEnd = calls.find((c) => c.type === "workflow.run.end");
    assert.equal(runEnd?.payload["status"], "failed");
  });

  test("no appendEntry calls when persistence not provided", async () => {
    // Ensure no crash and no global side effects
    const def = defineWorkflow("no-persist-wf")
      .run(async (ctx) => {
        await ctx.stage("s").prompt("x");
        return {};
      })
      .compile();

    const wfResult = await run(def, {}, {
      adapters: { prompt: { prompt: async () => "r" } },
      store: createStore(),
      // no persistence
    });

    assert.equal(wfResult.status, "completed");
  });

  test("run.end not appended when recordRunEnd returns false (terminal guard)", async () => {
    const { persistence, calls } = makePersistence();

    // Custom store that returns false for recordRunEnd
    const baseStore = createStore();
    const guardedStore = {
      ...baseStore,
      recordRunEnd(): boolean {
        // Simulate already-terminal: call real store but return false
        return false;
      },
    };

    const def = defineWorkflow("guard-wf")
      .run(async (_ctx) => ({}))
      .compile();

    await run(def, {}, {
      store: guardedStore as import("../../src/shared/store.js").Store,
      persistence,
    });

    const runEndCalls = calls.filter((c) => c.type === "workflow.run.end");
    assert.equal(runEndCalls.length, 0);
  });

  test("multi-stage: correct order run.start, stage.start×2, stage.end×2, run.end", async () => {
    const { persistence, calls } = makePersistence();

    const def = defineWorkflow("multi-persist-wf")
      .run(async (ctx) => {
        await ctx.stage("s1").prompt("a");
        await ctx.stage("s2").prompt("b");
        return {};
      })
      .compile();

    await run(def, {}, {
      adapters: { prompt: { prompt: async (t) => t } },
      store: createStore(),
      persistence,
    });

    const types = calls.map((c) => c.type);
    assert.deepEqual(types, [
      "workflow.run.start",
      "workflow.stage.start",
      "workflow.stage.end",
      "workflow.stage.start",
      "workflow.stage.end",
      "workflow.run.end",
    ]);
  });
});

// ---------------------------------------------------------------------------
// executor.run — abort/kill wiring
// ---------------------------------------------------------------------------

describe("executor.run — abort/kill wiring", () => {
  test("abort signal aborts in-flight stage, run finishes as killed", async () => {
    const { createCancellationRegistry } = await import("../../src/runs/background/cancellation-registry.js");
    const registry = createCancellationRegistry();
    const controller = new AbortController();

    const def = defineWorkflow("abort-wf")
      .run(async (ctx) => {
        await ctx.stage("slow").prompt("go");
        return {};
      })
      .compile();

    let adapterResolve!: (value: string) => void;
    const adapterPromise = new Promise<string>((resolve) => {
      adapterResolve = resolve;
    });

    const runPromise = run(def, {}, {
      adapters: { prompt: { prompt: async (_text) => adapterPromise } },
      store: createStore(),
      cancellation: registry,
      signal: controller.signal,
    });

    // Abort after a short delay while the adapter is pending
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    controller.abort();

    const result = await runPromise;

    assert.equal(result.status, "killed");
    assert.equal(result.error, "workflow killed");

    // Clean up the never-resolving adapter promise
    adapterResolve("ignored");
  });

  test("external killRun + executor abort path: workflow.run.end appended exactly once", async () => {
    const { createCancellationRegistry } = await import("../../src/runs/background/cancellation-registry.js");
    const { killRun } = await import("../../src/runs/background/status.js");

    const registry = createCancellationRegistry();
    const testStore = createStore();

    const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const persistence = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        calls.push({ type, payload });
        return `entry-${calls.length}`;
      },
    };

    const def = defineWorkflow("no-dup-kill-wf")
      .run(async (ctx) => {
        await ctx.stage("slow").prompt("go");
        return {};
      })
      .compile();

    let capturedRunId!: string;
    let adapterResolve!: (value: string) => void;
    const adapterPromise = new Promise<string>((resolve) => {
      adapterResolve = resolve;
    });

    const runPromise = run(def, {}, {
      adapters: { prompt: { prompt: async (_text) => adapterPromise } },
      store: testStore,
      cancellation: registry,
      persistence,
      onRunStart: (snap) => { capturedRunId = snap.id; },
    });

    // Wait for executor to register and stage to be in-flight
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // External kill path: records "killed" in store + appends one workflow.run.end
    const killResult = killRun(capturedRunId, { store: testStore, cancellation: registry, persistence });
    assert.equal(killResult.ok, true);
    assert.equal(killResult.runId, capturedRunId);
    assert.equal(killResult.previousStatus, "running");

    // Resolve the dangling adapter promise (executor is already aborted, ignored)
    adapterResolve("ignored");

    const result = await runPromise;
    assert.equal(result.status, "killed");

    // Executor's abort path called recordRunEnd → store returned false (already terminal)
    // appendRunEndWhenRecorded skipped → total workflow.run.end entries = 1 (from killRun only)
    const runEndCalls = calls.filter((c) => c.type === "workflow.run.end");
    assert.equal(runEndCalls.length, 1);
    assert.equal(runEndCalls[0]?.payload["status"], "killed");
    assert.equal(runEndCalls[0]?.payload["runId"], capturedRunId);
  });

  test("later resolution doesn't overwrite killed status", async () => {
    const { createCancellationRegistry } = await import("../../src/runs/background/cancellation-registry.js");
    const testStore = createStore();
    const registry = createCancellationRegistry();

    const def = defineWorkflow("abort-guard-wf")
      .run(async (ctx) => {
        await ctx.stage("slow").prompt("go");
        return {};
      })
      .compile();

    let adapterResolve!: (value: string) => void;
    const adapterPromise = new Promise<string>((resolve) => {
      adapterResolve = resolve;
    });

    const runPromise = run(def, {}, {
      adapters: { prompt: { prompt: async (_text) => adapterPromise } },
      store: testStore,
      cancellation: registry,
    });

    // Wait for the run to be registered, then abort all
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    registry.abortAll("workflow killed");

    // Resolve the adapter after the abort (should be ignored)
    adapterResolve("done");

    const result = await runPromise;

    assert.equal(result.status, "killed");
    assert.equal(testStore.snapshot().runs[0]?.status, "killed");
  });

  // ---------------------------------------------------------------------------
  // Regression: post-stage abort race
  // Abort fires AFTER final stage settles but BEFORE workflow body returns.
  // The post-body abort check (executor.ts line ~329) must intercept and
  // finalize as "killed" — never "completed".
  // ---------------------------------------------------------------------------
  test("abort after final stage settles but before body returns → killed", async () => {
    const testStore = createStore();
    const controller = new AbortController();

    // Gate that holds the workflow body suspended after the stage resolves.
    // Gives us a deterministic window to fire the abort signal.
    let releaseWorkflow!: () => void;
    const holdWorkflow = new Promise<void>((resolve) => {
      releaseWorkflow = resolve;
    });

    const def = defineWorkflow("post-stage-abort-race-wf")
      .run(async (ctx) => {
        await ctx.stage("final").prompt("go");
        // Stage has settled here. Suspend so the test can abort before we return.
        await holdWorkflow;
        return {};
      })
      .compile();

    const onRunEndCalls: Array<{ status: string }> = [];
    const persistenceCalls: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const persistence = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        persistenceCalls.push({ type, payload });
        return `entry-${persistenceCalls.length}`;
      },
    };

    const runPromise = run(def, {}, {
      // Adapter resolves immediately so the stage settles without delay.
      adapters: { prompt: { prompt: async (_text: string) => "ok" } },
      store: testStore,
      signal: controller.signal,
      persistence,
      onRunEnd: (_runId, status) => { onRunEndCalls.push({ status }); },
    });

    // Wait for stage to complete and workflow body to reach holdWorkflow.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // Abort fires AFTER stage settled, BEFORE workflow body returns.
    controller.abort();

    // Release the workflow body so def.run(ctx) can try to return {}.
    releaseWorkflow();

    const result = await runPromise;

    // Run result must be "killed"
    assert.equal(result.status, "killed");
    assert.equal(result.error, "workflow killed");

    // Store must reflect "killed"
    assert.equal(testStore.snapshot().runs[0]?.status, "killed");

    // onRunEnd must see "killed"
    assert.equal(onRunEndCalls.length, 1);
    assert.equal(onRunEndCalls[0]?.status, "killed");

    // Persistence must have exactly one workflow.run.end entry and it must be "killed".
    // No "completed" entry should exist.
    const runEndEntries = persistenceCalls.filter((c) => c.type === "workflow.run.end");
    assert.equal(runEndEntries.length, 1);
    assert.equal(runEndEntries[0]?.payload["status"], "killed");

    const completedEntries = persistenceCalls.filter(
      (c) => c.type === "workflow.run.end" && c.payload["status"] === "completed",
    );
    assert.equal(completedEntries.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Concurrency limiter integration
// ---------------------------------------------------------------------------

describe("executor.run — concurrency limiter", () => {
  test("defaultConcurrency=1 serializes parallel stages", async () => {
    // Two stages spawned concurrently from Promise.all — with limit=1 only one
    // may execute at a time.
    let active = 0;
    let maxActive = 0;

    const def = defineWorkflow("conc-serial-wf")
      .run(async (ctx) => {
        const task = async (name: string): Promise<string> => {
          return ctx.stage(name).prompt(name);
        };
        const [a, b] = await Promise.all([task("s1"), task("s2")]);
        return { a, b };
      })
      .compile();

    const result = await run(def, {}, {
      config: { defaultConcurrency: 1, maxDepth: 10, persistRuns: false, statusFile: false, resumeInFlight: "never" },
      store: createStore(),
      adapters: {
        prompt: {
          prompt: async (text) => {
            active++;
            maxActive = Math.max(maxActive, active);
            // yield so other stages can start if concurrency allows
            await new Promise<void>((r) => setTimeout(r, 5));
            active--;
            return `done:${text}`;
          },
        },
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(maxActive, 1);
  });

  test("defaultConcurrency=2 allows two concurrent stages", async () => {
    let active = 0;
    let maxActive = 0;

    const def = defineWorkflow("conc-2-wf")
      .run(async (ctx) => {
        const [a, b, c] = await Promise.all([
          ctx.stage("s1").prompt("s1"),
          ctx.stage("s2").prompt("s2"),
          ctx.stage("s3").prompt("s3"),
        ]);
        return { a, b, c };
      })
      .compile();

    const result = await run(def, {}, {
      config: { defaultConcurrency: 2, maxDepth: 10, persistRuns: false, statusFile: false, resumeInFlight: "never" },
      store: createStore(),
      adapters: {
        prompt: {
          prompt: async (text) => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise<void>((r) => setTimeout(r, 5));
            active--;
            return `done:${text}`;
          },
        },
      },
    });

    assert.equal(result.status, "completed");
    assert.ok(maxActive <= 2);
    assert.ok(maxActive >= 1);
  });

  test("default concurrency (4) allows ≤4 concurrent stages", async () => {
    let active = 0;
    let maxActive = 0;

    const def = defineWorkflow("conc-default-wf")
      .run(async (ctx) => {
        await Promise.all(
          ["s1", "s2", "s3", "s4", "s5", "s6"].map((n) =>
            ctx.stage(n).prompt(n),
          ),
        );
        return {};
      })
      .compile();

    const result = await run(def, {}, {
      // no config — should default to 4
      store: createStore(),
      adapters: {
        prompt: {
          prompt: async (text) => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise<void>((r) => setTimeout(r, 5));
            active--;
            return text;
          },
        },
      },
    });

    assert.equal(result.status, "completed");
    assert.ok(maxActive <= 4);
  });

  test("concurrency limiter releases on stage failure", async () => {
    let completedCount = 0;

    const def = defineWorkflow("conc-fail-wf")
      .run(async (ctx) => {
        const [, b] = await Promise.allSettled([
          ctx.stage("fail").prompt("fail-me"),
          ctx.stage("ok").prompt("succeed"),
        ]);
        if (b.status === "fulfilled") completedCount++;
        return {};
      })
      .compile();

    const result = await run(def, {}, {
      config: { defaultConcurrency: 1, maxDepth: 10, persistRuns: false, statusFile: false, resumeInFlight: "never" },
      store: createStore(),
      adapters: {
        prompt: {
          prompt: async (text) => {
            if (text === "fail-me") throw new Error("stage-error");
            return text;
          },
        },
      },
    });

    // Run itself completes (allSettled handles the failure)
    assert.equal(result.status, "completed");
    // The "ok" stage ran after the failed stage released its slot
    assert.equal(completedCount, 1);
  });
});

// ---------------------------------------------------------------------------
// Stage-control registry + controlled pause integration
// ---------------------------------------------------------------------------

import { createStageControlRegistry } from "../../src/runs/foreground/stage-control-registry.js";
import type { StageSessionRuntime } from "../../src/runs/foreground/stage-runner.js";

function mockSession(): StageSessionRuntime {
  const listeners = new Set<(e: { type: string; [k: string]: unknown }) => void>();
  void listeners;
  return {
    async prompt() {
      // Resolve immediately to keep the executor's tracked call short.
    },
    async steer() {},
    async followUp() {},
    subscribe() {
      return () => {};
    },
    sessionFile: "/tmp/atomic-test-session.ndjson",
    sessionId: "sess-test-1",
    async setModel() {},
    setThinkingLevel() {},
    cycleModel: (async () => undefined) as StageSessionRuntime["cycleModel"],
    cycleThinkingLevel: (() => undefined) as StageSessionRuntime["cycleThinkingLevel"],
    agent: undefined as unknown as AgentSession["agent"],
    model: undefined as AgentSession["model"],
    thinkingLevel: "medium" as AgentSession["thinkingLevel"],
    messages: [] as AgentSession["messages"],
    isStreaming: false,
    navigateTree: (async () => ({ cancelled: false })) as StageSessionRuntime["navigateTree"],
    compact: (async () => ({})) as unknown as StageSessionRuntime["compact"],
    abortCompaction() {},
    async abort() {},
    dispose() {},
    getLastAssistantText() {
      return "ok";
    },
  };
}

describe("executor — stage-control registry integration", () => {
  test("stage handle is registered after ctx.stage() before prompt", async () => {
    const registry = createStageControlRegistry();
    let observedHandleCount = 0;
    const def = defineWorkflow("handle-wf")
      .run(async (ctx) => {
        const stage = ctx.stage("first");
        // The handle is registered at ctx.stage() time, before prompt().
        observedHandleCount = registry.forRun(stage.sessionFile === undefined
          // We don't know runId from inside ctx, but the registry can be
          // checked at run-end via opts.onStageStart capture.
          ? "test" : "test").length;
        await stage.prompt("hi");
        return { ok: true };
      })
      .compile();
    const adapters = {
      agentSession: {
        async create() { return mockSession(); },
      },
    };
    let stageStartHandleCount = 0;
    await run(def, {}, {
      adapters,
      store: createStore(),
      stageControlRegistry: registry,
      onStageStart: (runId) => {
        // First stage-start fires *before* the SDK call lands, so the
        // handle should exist in the registry already.
        if (stageStartHandleCount === 0) {
          stageStartHandleCount = registry.forRun(runId).length;
        }
      },
    });
    void observedHandleCount;
    assert.equal(stageStartHandleCount, 1);
  });

  test("session metadata lands in stage snapshot after lazy attach", async () => {
    const def = defineWorkflow("session-meta-wf")
      .run(async (ctx) => {
        await ctx.stage("a").prompt("hello");
        return {};
      })
      .compile();
    const adapters = {
      agentSession: {
        async create() { return mockSession(); },
      },
    };
    const store = createStore();
    await run(def, {}, {
      adapters,
      store,
      stageControlRegistry: createStageControlRegistry(),
    });
    const persistedRun = store.runs()[0];
    assert.ok(persistedRun, "run snapshot should exist");
    const stage = persistedRun!.stages[0];
    assert.ok(stage, "stage snapshot should exist");
    assert.equal(stage!.sessionId, "sess-test-1");
    assert.equal(stage!.sessionFile, "/tmp/atomic-test-session.ndjson");
  });

  test("attachable flag is cleared once the stage settles", async () => {
    const def = defineWorkflow("attachable-wf")
      .run(async (ctx) => {
        await ctx.stage("only").prompt("hi");
        return {};
      })
      .compile();
    const adapters = {
      agentSession: {
        async create() { return mockSession(); },
      },
    };
    const store = createStore();
    // onStageStart fires once with pending status (before the SDK call
    // lands). At that point the live handle is registered and the
    // snapshot carries attachable: true.
    let observedAttachable = false;
    await run(def, {}, {
      adapters,
      store,
      stageControlRegistry: createStageControlRegistry(),
      onStageStart: (_runId, stage) => {
        if (!observedAttachable && stage.attachable === true) {
          observedAttachable = true;
        }
      },
    });
    assert.equal(observedAttachable, true);
    const stage = store.runs()[0]!.stages[0]!;
    assert.equal(stage.attachable, undefined);
  });

  test("ask_user_question tool execution marks the stage awaiting input transiently", async () => {
    const def = defineWorkflow("stage-hil-wf")
      .run(async (ctx) => {
        await ctx.stage("ask").prompt("ask the user");
        return {};
      })
      .compile();
    const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
    const session: StageSessionRuntime = {
      ...mockSession(),
      async prompt() {
        for (const listener of listeners) {
          listener({
            type: "tool_execution_start",
            toolCallId: "tool-1",
            toolName: "ask_user_question",
          });
        }
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        for (const listener of listeners) {
          listener({
            type: "tool_execution_end",
            toolCallId: "tool-1",
            toolName: "ask_user_question",
          });
        }
      },
      subscribe(listener) {
        listeners.add(listener as (event: { type: string; [key: string]: unknown }) => void);
        return () => {
          listeners.delete(listener as (event: { type: string; [key: string]: unknown }) => void);
        };
      },
    };
    const store = createStore();
    const observedStatuses: string[] = [];
    const unsubscribe = store.subscribe((snap) => {
      const status = snap.runs[0]?.stages[0]?.status;
      if (status) observedStatuses.push(status);
    });
    await run(def, {}, {
      adapters: {
        agentSession: {
          async create() {
            return session;
          },
        },
      },
      store,
      stageControlRegistry: createStageControlRegistry(),
    });
    unsubscribe();

    assert.ok(observedStatuses.includes("awaiting_input"));
    assert.equal(store.runs()[0]!.stages[0]!.status, "completed");
  });
});
