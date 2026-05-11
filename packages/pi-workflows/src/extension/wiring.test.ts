/**
 * Tests for buildUIAdapter — maps pi ctx.ui dialog surface to WorkflowUIAdapter.
 * Tests for buildRuntimeAdapters — prompt/complete/subagent wiring, signal propagation.
 *
 * cross-ref: packages/pi-workflows/src/extension/wiring.ts buildUIAdapter
 *            packages/pi-workflows/src/extension/wiring.ts buildRuntimeAdapters
 *            packages/pi-workflows/src/shared/types.ts WorkflowUIAdapter
 */

import { test, expect, describe } from "bun:test";
import { buildUIAdapter, buildRuntimeAdapters, extractAssistantText } from "./wiring.js";
import type { PiUISurface, UIWiringSurface, PiExecResult, PiExecOpts, RuntimeWiringSurface } from "./wiring.js";
import type { StageExecutionMeta } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Helpers — NDJSON builder
// ---------------------------------------------------------------------------

function makeNdjson(text: string): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function okExecResult(text: string): PiExecResult {
  return { stdout: makeNdjson(text), stderr: "", code: 0, killed: false };
}

function makeSignal(): AbortSignal {
  return new AbortController().signal;
}

// ---------------------------------------------------------------------------
// buildRuntimeAdapters — prompt adapter exec invocation
// ---------------------------------------------------------------------------

describe("buildRuntimeAdapters — prompt adapter", () => {
  test("calls exec('pi', args, { signal }) — first arg is 'pi'", async () => {
    const calls: Array<{ cmd: string; args: string[]; opts?: PiExecOpts }> = [];
    const pi: RuntimeWiringSurface = {
      exec: async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return okExecResult("hello"); },
    };
    const adapters = buildRuntimeAdapters(pi);
    const signal = makeSignal();
    const meta: StageExecutionMeta = { runId: "r1", stageId: "s1", stageName: "S", signal };
    await adapters.prompt!.prompt("the text", meta);
    expect(calls[0]?.cmd).toBe("pi");
  });

  test("calls exec with --mode json and -p flags", async () => {
    const calls: Array<{ args: string[] }> = [];
    const pi: RuntimeWiringSurface = {
      exec: async (_cmd, args) => { calls.push({ args }); return okExecResult("reply"); },
    };
    const adapters = buildRuntimeAdapters(pi);
    await adapters.prompt!.prompt("my prompt", { runId: "r", stageId: "s", stageName: "N" });
    expect(calls[0]?.args).toContain("--mode");
    expect(calls[0]?.args).toContain("json");
    expect(calls[0]?.args).toContain("-p");
    expect(calls[0]?.args).toContain("my prompt");
    expect(calls[0]?.args).toContain("--no-session");
  });

  test("passes { signal } in exec opts when meta.signal present", async () => {
    const calls: Array<{ opts?: PiExecOpts }> = [];
    const signal = makeSignal();
    const pi: RuntimeWiringSurface = {
      exec: async (_cmd, _args, opts) => { calls.push({ opts }); return okExecResult("ok"); },
    };
    const adapters = buildRuntimeAdapters(pi);
    const meta: StageExecutionMeta = { runId: "r", stageId: "s", stageName: "N", signal };
    await adapters.prompt!.prompt("text", meta);
    expect(calls[0]?.opts?.signal).toBe(signal);
  });

  test("passes empty opts (no signal key) when meta.signal absent", async () => {
    const calls: Array<{ opts?: PiExecOpts }> = [];
    const pi: RuntimeWiringSurface = {
      exec: async (_cmd, _args, opts) => { calls.push({ opts }); return okExecResult("ok"); },
    };
    const adapters = buildRuntimeAdapters(pi);
    const meta: StageExecutionMeta = { runId: "r", stageId: "s", stageName: "N" };
    await adapters.prompt!.prompt("text", meta);
    expect(calls[0]?.opts?.signal).toBeUndefined();
  });

  test("prompt adapter absent when pi.exec absent", () => {
    const adapters = buildRuntimeAdapters({});
    expect(adapters.prompt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildRuntimeAdapters — complete adapter exec invocation
// ---------------------------------------------------------------------------

describe("buildRuntimeAdapters — complete adapter", () => {
  test("calls exec('pi', args, { signal }) — first arg is 'pi'", async () => {
    const calls: Array<{ cmd: string }> = [];
    const pi: RuntimeWiringSurface = {
      exec: async (cmd) => { calls.push({ cmd }); return okExecResult("done"); },
    };
    const adapters = buildRuntimeAdapters(pi);
    const signal = makeSignal();
    const meta: StageExecutionMeta = { runId: "r", stageId: "s", stageName: "N", signal };
    await adapters.complete!.complete("text", undefined, meta);
    expect(calls[0]?.cmd).toBe("pi");
  });

  test("passes signal through exec opts for complete", async () => {
    const calls: Array<{ opts?: PiExecOpts }> = [];
    const signal = makeSignal();
    const pi: RuntimeWiringSurface = {
      exec: async (_cmd, _args, opts) => { calls.push({ opts }); return okExecResult("done"); },
    };
    const adapters = buildRuntimeAdapters(pi);
    const meta: StageExecutionMeta = { runId: "r", stageId: "s", stageName: "N", signal };
    await adapters.complete!.complete("text", undefined, meta);
    expect(calls[0]?.opts?.signal).toBe(signal);
  });

  test("appends --model flag when CompleteStageOpts.model provided", async () => {
    const calls: Array<{ args: string[] }> = [];
    const pi: RuntimeWiringSurface = {
      exec: async (_cmd, args) => { calls.push({ args }); return okExecResult("ok"); },
    };
    const adapters = buildRuntimeAdapters(pi);
    await adapters.complete!.complete("text", { model: "gpt-4o" });
    expect(calls[0]?.args).toContain("--model");
    expect(calls[0]?.args).toContain("gpt-4o");
  });

  test("does not append --model when CompleteStageOpts.model absent", async () => {
    const calls: Array<{ args: string[] }> = [];
    const pi: RuntimeWiringSurface = {
      exec: async (_cmd, args) => { calls.push({ args }); return okExecResult("ok"); },
    };
    const adapters = buildRuntimeAdapters(pi);
    await adapters.complete!.complete("text", {});
    expect(calls[0]?.args).not.toContain("--model");
  });

  test("does not append --model when no opts passed", async () => {
    const calls: Array<{ args: string[] }> = [];
    const pi: RuntimeWiringSurface = {
      exec: async (_cmd, args) => { calls.push({ args }); return okExecResult("ok"); },
    };
    const adapters = buildRuntimeAdapters(pi);
    await adapters.complete!.complete("text");
    expect(calls[0]?.args).not.toContain("--model");
  });

  test("complete adapter absent when pi.exec absent", () => {
    const adapters = buildRuntimeAdapters({});
    expect(adapters.complete).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildRuntimeAdapters — subagent adapter: pi.subagents.run path
// ---------------------------------------------------------------------------

describe("buildRuntimeAdapters — subagent adapter via pi.subagents.run", () => {
  test("subagent adapter present when pi.subagents.run exists and pi.exec absent", () => {
    const pi: RuntimeWiringSurface = {
      subagents: { run: async () => "ok" },
    };
    const adapters = buildRuntimeAdapters(pi);
    expect(adapters.subagent).toBeDefined();
  });

  test("subagent adapter present when pi.subagents.run exists alongside pi.exec", () => {
    const pi: RuntimeWiringSurface = {
      exec: async () => okExecResult("hi"),
      subagents: { run: async () => "ok" },
    };
    const adapters = buildRuntimeAdapters(pi);
    expect(adapters.subagent).toBeDefined();
  });

  test("delegates to pi.subagents.run with agent and task", async () => {
    const calls: Array<{ agent: string; task: string }> = [];
    const pi: RuntimeWiringSurface = {
      subagents: {
        run: async (opts: { agent: string; task: string }) => {
          calls.push({ agent: opts.agent, task: opts.task });
          return "result";
        },
      },
    };
    const adapters = buildRuntimeAdapters(pi);
    await adapters.subagent!.subagent({ agent: "coder", task: "fix it" });
    expect(calls[0]?.agent).toBe("coder");
    expect(calls[0]?.task).toBe("fix it");
  });

  test("passes signal from meta to pi.subagents.run", async () => {
    const signal = makeSignal();
    const calls: Array<{ signal?: AbortSignal }> = [];
    const pi: RuntimeWiringSurface = {
      subagents: {
        run: async (opts: { signal?: AbortSignal }) => {
          calls.push({ signal: opts.signal });
          return "ok";
        },
      },
    };
    const adapters = buildRuntimeAdapters(pi);
    const meta: StageExecutionMeta = { runId: "r", stageId: "s", stageName: "N", signal };
    await adapters.subagent!.subagent({ agent: "a", task: "t" }, meta);
    expect(calls[0]?.signal).toBe(signal);
  });

  test("injects runId into env passed to pi.subagents.run", async () => {
    const calls: Array<{ env?: Record<string, string> }> = [];
    const pi: RuntimeWiringSurface = {
      subagents: {
        run: async (opts: { env?: Record<string, string> }) => {
          calls.push({ env: opts.env });
          return "ok";
        },
      },
    };
    const adapters = buildRuntimeAdapters(pi);
    const meta: StageExecutionMeta = { runId: "run-999", stageId: "s", stageName: "N" };
    await adapters.subagent!.subagent({ agent: "a", task: "t" }, meta);
    expect(calls[0]?.env?.["PI_WORKFLOW_RUN_ID"]).toBe("run-999");
  });

  test("injects stageId into env passed to pi.subagents.run", async () => {
    const calls: Array<{ env?: Record<string, string> }> = [];
    const pi: RuntimeWiringSurface = {
      subagents: {
        run: async (opts: { env?: Record<string, string> }) => {
          calls.push({ env: opts.env });
          return "ok";
        },
      },
    };
    const adapters = buildRuntimeAdapters(pi);
    const meta: StageExecutionMeta = { runId: "r", stageId: "stage-42", stageName: "N" };
    await adapters.subagent!.subagent({ agent: "a", task: "t" }, meta);
    expect(calls[0]?.env?.["PI_WORKFLOW_STAGE_ID"]).toBe("stage-42");
  });
});

// ---------------------------------------------------------------------------
// buildRuntimeAdapters — subagent adapter: pi.callTool fallback
// ---------------------------------------------------------------------------

describe("buildRuntimeAdapters — subagent adapter via pi.callTool", () => {
  test("subagent adapter present when pi.callTool exists and pi.exec absent", () => {
    const pi: RuntimeWiringSurface = {
      callTool: async () => "ok",
    };
    const adapters = buildRuntimeAdapters(pi);
    expect(adapters.subagent).toBeDefined();
  });

  test("subagent adapter present when pi.callTool exists alongside pi.exec", () => {
    const pi: RuntimeWiringSurface = {
      exec: async () => okExecResult("hi"),
      callTool: async () => "ok",
    };
    const adapters = buildRuntimeAdapters(pi);
    expect(adapters.subagent).toBeDefined();
  });

  test("delegates to pi.callTool('subagent', args) when pi.subagents absent", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const pi: RuntimeWiringSurface = {
      callTool: async (name, args) => { calls.push({ name, args }); return "done"; },
    };
    const adapters = buildRuntimeAdapters(pi);
    await adapters.subagent!.subagent({ agent: "reviewer", task: "review" });
    expect(calls[0]?.name).toBe("subagent");
    expect(calls[0]?.args["agent"]).toBe("reviewer");
    expect(calls[0]?.args["task"]).toBe("review");
  });

  test("includes context in callTool args when provided", async () => {
    const calls: Array<{ args: Record<string, unknown> }> = [];
    const pi: RuntimeWiringSurface = {
      callTool: async (_name, args) => { calls.push({ args }); return "ok"; },
    };
    const adapters = buildRuntimeAdapters(pi);
    await adapters.subagent!.subagent({ agent: "a", task: "t", context: "ctx text" });
    expect(calls[0]?.args["context"]).toBe("ctx text");
  });

  test("omits context key in callTool args when not provided", async () => {
    const calls: Array<{ args: Record<string, unknown> }> = [];
    const pi: RuntimeWiringSurface = {
      callTool: async (_name, args) => { calls.push({ args }); return "ok"; },
    };
    const adapters = buildRuntimeAdapters(pi);
    await adapters.subagent!.subagent({ agent: "a", task: "t" });
    expect(Object.prototype.hasOwnProperty.call(calls[0]?.args, "context")).toBe(false);
  });

  test("passes runId env to callTool args", async () => {
    const calls: Array<{ args: Record<string, unknown> }> = [];
    const pi: RuntimeWiringSurface = {
      callTool: async (_name, args) => { calls.push({ args }); return "ok"; },
    };
    const adapters = buildRuntimeAdapters(pi);
    const meta: StageExecutionMeta = { runId: "run-ct", stageId: "s", stageName: "N" };
    await adapters.subagent!.subagent({ agent: "a", task: "t" }, meta);
    const env = calls[0]?.args["env"] as Record<string, string>;
    expect(env["PI_WORKFLOW_RUN_ID"]).toBe("run-ct");
  });
});

// ---------------------------------------------------------------------------
// buildRuntimeAdapters — degraded: no surfaces
// ---------------------------------------------------------------------------

describe("buildRuntimeAdapters — degraded (no surfaces)", () => {
  test("returns empty adapter set when pi has no exec, subagents, or callTool", () => {
    const adapters = buildRuntimeAdapters({});
    expect(adapters.prompt).toBeUndefined();
    expect(adapters.complete).toBeUndefined();
    expect(adapters.subagent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractAssistantText — sanity checks
// ---------------------------------------------------------------------------

describe("extractAssistantText", () => {
  test("extracts text from message_end assistant event", () => {
    const ndjson = makeNdjson("hello world");
    expect(extractAssistantText(ndjson)).toBe("hello world");
  });

  test("returns empty string for empty input", () => {
    expect(extractAssistantText("")).toBe("");
  });

  test("returns empty string when no message_end event", () => {
    expect(extractAssistantText('{"type":"message_start"}\n{"type":"content_block_delta"}')).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function piWith(ui: PiUISurface): UIWiringSurface {
  return { ui };
}

// ---------------------------------------------------------------------------
// buildUIAdapter — absent / degraded surface
// ---------------------------------------------------------------------------

describe("buildUIAdapter — absent surface", () => {
  test("returns undefined when pi.ui is absent", () => {
    expect(buildUIAdapter({})).toBeUndefined();
  });

  test("returns undefined when pi.ui is present but has no dialog methods", () => {
    // setWidget-only object (widget surface but no dialog methods)
    expect(buildUIAdapter({ ui: {} as PiUISurface })).toBeUndefined();
  });

  test("returns adapter when at least one dialog method present", () => {
    const adapter = buildUIAdapter(piWith({
      input: async (_title) => "x",
    }));
    expect(adapter).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildUIAdapter — input
// ---------------------------------------------------------------------------

describe("buildUIAdapter — input", () => {
  test("delegates to pi.ui.input using prompt as title", async () => {
    const calls: string[] = [];
    const adapter = buildUIAdapter(piWith({
      input: async (title) => { calls.push(title); return "typed text"; },
    }))!;
    const result = await adapter.input("Your name?");
    expect(calls).toEqual(["Your name?"]);
    expect(result).toBe("typed text");
  });

  test("returns empty string when pi.ui.input returns undefined (dismissed)", async () => {
    const adapter = buildUIAdapter(piWith({
      input: async (_title) => undefined,
    }))!;
    expect(await adapter.input("prompt")).toBe("");
  });

  test("returns empty string when pi.ui.input is absent", async () => {
    // Only confirm present — input fallback returns ""
    const adapter = buildUIAdapter(piWith({
      confirm: async (_t, _m) => true,
    }))!;
    expect(await adapter.input("prompt")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildUIAdapter — confirm
// ---------------------------------------------------------------------------

describe("buildUIAdapter — confirm", () => {
  test("passes message as both title and message args to pi.ui.confirm", async () => {
    const calls: Array<[string, string]> = [];
    const adapter = buildUIAdapter(piWith({
      confirm: async (title, message) => { calls.push([title, message]); return true; },
    }))!;
    const result = await adapter.confirm("Delete everything?");
    expect(calls).toEqual([["Delete everything?", "Delete everything?"]]);
    expect(result).toBe(true);
  });

  test("returns false when pi.ui.confirm is absent", async () => {
    const adapter = buildUIAdapter(piWith({
      input: async (_t) => "x",
    }))!;
    expect(await adapter.confirm("Are you sure?")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildUIAdapter — select
// ---------------------------------------------------------------------------

describe("buildUIAdapter — select", () => {
  test("delegates to pi.ui.select with spread options array", async () => {
    const calls: Array<[string, string[]]> = [];
    const adapter = buildUIAdapter(piWith({
      select: async (title, options) => { calls.push([title, options]); return "b"; },
    }))!;
    const result = await adapter.select("Pick one", ["a", "b", "c"] as const);
    expect(calls).toEqual([["Pick one", ["a", "b", "c"]]]);
    expect(result).toBe("b");
  });

  test("returns first option when pi.ui.select returns undefined (dismissed)", async () => {
    const adapter = buildUIAdapter(piWith({
      select: async (_title, _opts) => undefined,
    }))!;
    const result = await adapter.select("Pick", ["x", "y"] as const);
    expect(result).toBe("x");
  });

  test("returns first option when pi.ui.select is absent", async () => {
    const adapter = buildUIAdapter(piWith({
      input: async (_t) => "ignored",
    }))!;
    const result = await adapter.select("Pick", ["alpha", "beta"] as const);
    expect(result).toBe("alpha");
  });

  test("preserves generic T type — result assignable to original union", async () => {
    type Color = "red" | "green" | "blue";
    const adapter = buildUIAdapter(piWith({
      select: async (_t, _o) => "green",
    }))!;
    const result: Color = await adapter.select("Color?", ["red", "green", "blue"] as const);
    expect(result).toBe("green");
  });
});

// ---------------------------------------------------------------------------
// buildUIAdapter — editor
// ---------------------------------------------------------------------------

describe("buildUIAdapter — editor", () => {
  test("delegates to pi.ui.editor with empty-string title and prefill", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const adapter = buildUIAdapter(piWith({
      editor: async (title, prefill) => { calls.push([title, prefill]); return "edited"; },
    }))!;
    const result = await adapter.editor("initial content");
    expect(calls).toEqual([["", "initial content"]]);
    expect(result).toBe("edited");
  });

  test("passes undefined prefill when no initial provided", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const adapter = buildUIAdapter(piWith({
      editor: async (title, prefill) => { calls.push([title, prefill]); return "x"; },
    }))!;
    await adapter.editor();
    expect(calls[0]).toEqual(["", undefined]);
  });

  test("returns initial when pi.ui.editor returns undefined (dismissed)", async () => {
    const adapter = buildUIAdapter(piWith({
      editor: async (_t, _p) => undefined,
    }))!;
    expect(await adapter.editor("fallback text")).toBe("fallback text");
  });

  test("returns empty string when dismissed and no initial", async () => {
    const adapter = buildUIAdapter(piWith({
      editor: async (_t, _p) => undefined,
    }))!;
    expect(await adapter.editor()).toBe("");
  });

  test("returns empty string when pi.ui.editor is absent", async () => {
    const adapter = buildUIAdapter(piWith({
      input: async (_t) => "x",
    }))!;
    expect(await adapter.editor("init")).toBe("init");
  });
});

// ---------------------------------------------------------------------------
// Integration — full surface present
// ---------------------------------------------------------------------------

describe("buildUIAdapter — full pi surface", () => {
  test("all four methods delegate correctly in sequence", async () => {
    const log: string[] = [];
    const adapter = buildUIAdapter(piWith({
      input: async (t) => { log.push(`input:${t}`); return "alice"; },
      confirm: async (t, m) => { log.push(`confirm:${t}:${m}`); return false; },
      select: async (t, o) => { log.push(`select:${t}`); return o[1]; },
      editor: async (_t, p) => { log.push(`editor:${p ?? ""}`); return "done"; },
    }))!;

    expect(await adapter.input("Name?")).toBe("alice");
    expect(await adapter.confirm("Sure?")).toBe(false);
    expect(await adapter.select("Mode?", ["a", "b", "c"] as const)).toBe("b");
    expect(await adapter.editor("draft")).toBe("done");

    expect(log).toEqual([
      "input:Name?",
      "confirm:Sure?:Sure?",
      "select:Mode?",
      "editor:draft",
    ]);
  });
});
