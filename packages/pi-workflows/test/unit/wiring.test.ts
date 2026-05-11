/**
 * Tests for runtime wiring helpers (src/extension/wiring.ts).
 *
 * Covers:
 * - extractAssistantText: NDJSON parsing
 * - buildRuntimeAdapters: absent exec → empty adapters
 * - buildRuntimeAdapters: exec present → adapters delegate to pi subprocess
 * - prompt/complete/subagent adapters: correct arg construction
 * - complete adapter: --model flag forwarding
 * - subagent adapter: agent+context prompt construction
 * - error handling: non-zero exit, no assistant text
 */

import { test, expect, describe } from "bun:test";
import {
  extractAssistantText,
  buildRuntimeAdapters,
  type RuntimeWiringSurface,
  type PiExecResult,
} from "../../src/extension/wiring.js";
import type { SubagentStageOpts, CompleteStageOpts } from "../../src/shared/types.js";

// ---------------------------------------------------------------------------
// extractAssistantText
// ---------------------------------------------------------------------------

describe("extractAssistantText", () => {
  function makeMessageEnd(text: string, role = "assistant"): string {
    return JSON.stringify({
      type: "message_end",
      message: {
        role,
        content: [{ type: "text", text }],
      },
    });
  }

  test("returns empty string for empty input", () => {
    expect(extractAssistantText("")).toBe("");
  });

  test("returns empty string when no message_end event", () => {
    const ndjson = [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "turn_start" }),
    ].join("\n");
    expect(extractAssistantText(ndjson)).toBe("");
  });

  test("extracts text from message_end with role=assistant", () => {
    const ndjson = [
      JSON.stringify({ type: "agent_start" }),
      makeMessageEnd("Hello from pi"),
    ].join("\n");
    expect(extractAssistantText(ndjson)).toBe("Hello from pi");
  });

  test("ignores message_end with role=user", () => {
    const ndjson = makeMessageEnd("user text", "user");
    expect(extractAssistantText(ndjson)).toBe("");
  });

  test("returns last assistant message_end when multiple present", () => {
    const ndjson = [
      makeMessageEnd("first response"),
      makeMessageEnd("second response"),
    ].join("\n");
    expect(extractAssistantText(ndjson)).toBe("second response");
  });

  test("concatenates multiple text content blocks", () => {
    const event = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      },
    });
    expect(extractAssistantText(event)).toBe("Hello world");
  });

  test("skips non-text content blocks", () => {
    const event = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "bash", input: {} },
          { type: "text", text: "Done!" },
        ],
      },
    });
    expect(extractAssistantText(event)).toBe("Done!");
  });

  test("skips malformed JSON lines gracefully", () => {
    const ndjson = [
      "not valid json{{{",
      makeMessageEnd("valid response"),
    ].join("\n");
    expect(extractAssistantText(ndjson)).toBe("valid response");
  });

  test("handles trailing newline without crashing", () => {
    const ndjson = makeMessageEnd("response") + "\n";
    expect(extractAssistantText(ndjson)).toBe("response");
  });
});

// ---------------------------------------------------------------------------
// buildRuntimeAdapters — absent exec
// ---------------------------------------------------------------------------

describe("buildRuntimeAdapters — absent exec", () => {
  test("returns empty object when pi.exec is absent", () => {
    const adapters = buildRuntimeAdapters({});
    expect(adapters).toEqual({});
  });

  test("returns empty object when pi.exec is not a function", () => {
    const pi = { exec: "not-a-function" } as unknown as RuntimeWiringSurface;
    const adapters = buildRuntimeAdapters(pi);
    expect(adapters).toEqual({});
  });

  test("prompt/complete/subagent are all undefined when exec absent", () => {
    const adapters = buildRuntimeAdapters({});
    expect(adapters.prompt).toBeUndefined();
    expect(adapters.complete).toBeUndefined();
    expect(adapters.subagent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildRuntimeAdapters — exec present
// ---------------------------------------------------------------------------

/** Build a mock pi surface whose exec records calls and returns a given NDJSON. */
function makeMockPi(ndjson: string, exitCode = 0): {
  pi: RuntimeWiringSurface;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const result: PiExecResult = { stdout: ndjson, stderr: "", code: exitCode, killed: false };
  const pi: RuntimeWiringSurface = {
    exec: async (command, args) => {
      calls.push({ command, args });
      return result;
    },
  };
  return { pi, calls };
}

function makeNdjsonWithText(text: string): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

describe("buildRuntimeAdapters — exec present", () => {
  test("returns all three adapters when exec is present", () => {
    const { pi } = makeMockPi(makeNdjsonWithText("ok"));
    const adapters = buildRuntimeAdapters(pi);
    expect(adapters.prompt).toBeDefined();
    expect(adapters.complete).toBeDefined();
    expect(adapters.subagent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// prompt adapter
// ---------------------------------------------------------------------------

describe("prompt adapter", () => {
  test("calls pi --mode json -p <text> --no-session", async () => {
    const { pi, calls } = makeMockPi(makeNdjsonWithText("pong"));
    const adapters = buildRuntimeAdapters(pi);
    const result = await adapters.prompt!.prompt("ping");
    expect(result).toBe("pong");
    expect(calls).toHaveLength(1);
    const { command, args } = calls[0]!;
    expect(command).toBe("pi");
    expect(args).toContain("--mode");
    expect(args).toContain("json");
    expect(args).toContain("-p");
    expect(args).toContain("ping");
    expect(args).toContain("--no-session");
  });

  test("returns extracted assistant text", async () => {
    const { pi } = makeMockPi(makeNdjsonWithText("The answer is 42"));
    const adapters = buildRuntimeAdapters(pi);
    const result = await adapters.prompt!.prompt("What is the answer?");
    expect(result).toBe("The answer is 42");
  });

  test("throws when pi returns no assistant text", async () => {
    const { pi } = makeMockPi(JSON.stringify({ type: "agent_start" }));
    const adapters = buildRuntimeAdapters(pi);
    await expect(adapters.prompt!.prompt("hi")).rejects.toThrow(
      "pi-workflows: pi subprocess produced no assistant text",
    );
  });

  test("throws on non-zero exit with empty stdout", async () => {
    const failResult: PiExecResult = { stdout: "", stderr: "pi: command not found", code: 127, killed: false };
    const pi: RuntimeWiringSurface = {
      exec: async () => failResult,
    };
    const adapters = buildRuntimeAdapters(pi);
    await expect(adapters.prompt!.prompt("hi")).rejects.toThrow("code 127");
  });
});

// ---------------------------------------------------------------------------
// complete adapter
// ---------------------------------------------------------------------------

describe("complete adapter", () => {
  test("calls pi --mode json -p <text> --no-session without model", async () => {
    const { pi, calls } = makeMockPi(makeNdjsonWithText("summary"));
    const adapters = buildRuntimeAdapters(pi);
    await adapters.complete!.complete("Summarize this");
    const { args } = calls[0]!;
    expect(args).toContain("--mode");
    expect(args).toContain("json");
    expect(args).toContain("-p");
    expect(args).toContain("Summarize this");
    expect(args).toContain("--no-session");
    expect(args).not.toContain("--model");
  });

  test("forwards model option as --model flag", async () => {
    const { pi, calls } = makeMockPi(makeNdjsonWithText("summary"));
    const adapters = buildRuntimeAdapters(pi);
    const opts: CompleteStageOpts = { model: "claude-sonnet-4" };
    await adapters.complete!.complete("Summarize this", opts);
    const { args } = calls[0]!;
    expect(args).toContain("--model");
    const modelIdx = args.indexOf("--model");
    expect(args[modelIdx + 1]).toBe("claude-sonnet-4");
  });

  test("does not add --model when opts is undefined", async () => {
    const { pi, calls } = makeMockPi(makeNdjsonWithText("ok"));
    const adapters = buildRuntimeAdapters(pi);
    await adapters.complete!.complete("text", undefined);
    expect(calls[0]!.args).not.toContain("--model");
  });

  test("does not add --model when model is undefined in opts", async () => {
    const { pi, calls } = makeMockPi(makeNdjsonWithText("ok"));
    const adapters = buildRuntimeAdapters(pi);
    await adapters.complete!.complete("text", {});
    expect(calls[0]!.args).not.toContain("--model");
  });
});

// ---------------------------------------------------------------------------
// subagent adapter — delegates to pi.subagents.run or pi.callTool (no exec)
// ---------------------------------------------------------------------------

describe("subagent adapter — pi.subagents.run delegation", () => {
  test("calls pi.subagents.run when available", async () => {
    const runCalls: Array<Record<string, unknown>> = [];
    const pi: RuntimeWiringSurface = {
      exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
      subagents: {
        run: async (opts) => {
          runCalls.push(opts as unknown as Record<string, unknown>);
          return "subagent-result";
        },
      },
    };
    const adapters = buildRuntimeAdapters(pi);
    const result = await adapters.subagent!.subagent({ agent: "code-reviewer", task: "Review PR" });
    expect(result).toBe("subagent-result");
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]).toMatchObject({ agent: "code-reviewer", task: "Review PR" });
  });

  test("passes context to pi.subagents.run when provided", async () => {
    const runCalls: Array<Record<string, unknown>> = [];
    const pi: RuntimeWiringSurface = {
      exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
      subagents: {
        run: async (opts) => { runCalls.push(opts as unknown as Record<string, unknown>); return "done"; },
      },
    };
    const adapters = buildRuntimeAdapters(pi);
    await adapters.subagent!.subagent({ agent: "a", task: "t", context: "some context" });
    expect(runCalls[0]).toMatchObject({ context: "some context" });
  });

  test("does NOT call exec for subagent when pi.subagents.run available", async () => {
    const execCalls: Array<unknown> = [];
    const pi: RuntimeWiringSurface = {
      exec: async (...args) => { execCalls.push(args); return { stdout: "", stderr: "", code: 0, killed: false }; },
      subagents: {
        run: async () => "result",
      },
    };
    const adapters = buildRuntimeAdapters(pi);
    await adapters.subagent!.subagent({ agent: "a", task: "t" });
    expect(execCalls).toHaveLength(0);
  });

  test("passes env record to pi.subagents.run", async () => {
    const runCalls: Array<Record<string, unknown>> = [];
    const pi: RuntimeWiringSurface = {
      exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
      subagents: {
        run: async (opts) => { runCalls.push(opts as unknown as Record<string, unknown>); return "done"; },
      },
    };
    const adapters = buildRuntimeAdapters(pi);
    await adapters.subagent!.subagent({ agent: "a", task: "t" });
    expect(runCalls[0]).toHaveProperty("env");
    expect(typeof runCalls[0]!["env"]).toBe("object");
  });
});

describe("subagent adapter — pi.callTool fallback", () => {
  test("calls pi.callTool('subagent', ...) when pi.subagents absent", async () => {
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const pi: RuntimeWiringSurface = {
      exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
      callTool: async (name, args) => { toolCalls.push({ name, args }); return "calltool-result"; },
    };
    const adapters = buildRuntimeAdapters(pi);
    const result = await adapters.subagent!.subagent({ agent: "doc-writer", task: "Write docs" });
    expect(result).toBe("calltool-result");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.name).toBe("subagent");
    expect(toolCalls[0]!.args).toMatchObject({ action: "run", agent: "doc-writer", task: "Write docs" });
  });

  test("passes context in callTool args when provided", async () => {
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const pi: RuntimeWiringSurface = {
      exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
      callTool: async (name, args) => { toolCalls.push({ name, args }); return "done"; },
    };
    const adapters = buildRuntimeAdapters(pi);
    await adapters.subagent!.subagent({ agent: "a", task: "t", context: "repo context" });
    expect(toolCalls[0]!.args).toMatchObject({ context: "repo context" });
  });

  test("omits context key from callTool args when absent", async () => {
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const pi: RuntimeWiringSurface = {
      exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
      callTool: async (name, args) => { toolCalls.push({ name, args }); return "done"; },
    };
    const adapters = buildRuntimeAdapters(pi);
    await adapters.subagent!.subagent({ agent: "a", task: "t" });
    expect(toolCalls[0]!.args).not.toHaveProperty("context");
  });

  test("does NOT call exec for subagent via callTool path", async () => {
    const execCalls: Array<unknown> = [];
    const pi: RuntimeWiringSurface = {
      exec: async (...args) => { execCalls.push(args); return { stdout: "", stderr: "", code: 0, killed: false }; },
      callTool: async () => "result",
    };
    const adapters = buildRuntimeAdapters(pi);
    await adapters.subagent!.subagent({ agent: "a", task: "t" });
    expect(execCalls).toHaveLength(0);
  });
});

describe("subagent adapter — missing pi-subagents error", () => {
  test("throws exact actionable error when neither pi.subagents nor pi.callTool available", async () => {
    const pi: RuntimeWiringSurface = {
      exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    };
    const adapters = buildRuntimeAdapters(pi);
    await expect(adapters.subagent!.subagent({ agent: "a", task: "t" })).rejects.toThrow(
      "pi-workflows: subagent delegation requires pi-subagents — install npm:pi-subagents and restart pi.",
    );
  });

  test("exec is never called when pi-subagents missing", async () => {
    const execCalls: Array<unknown> = [];
    const pi: RuntimeWiringSurface = {
      exec: async (...args) => { execCalls.push(args); return { stdout: "", stderr: "", code: 0, killed: false }; },
    };
    const adapters = buildRuntimeAdapters(pi);
    await expect(adapters.subagent!.subagent({ agent: "a", task: "t" })).rejects.toThrow();
    expect(execCalls).toHaveLength(0);
  });

  test("error message contains install instruction", async () => {
    const pi: RuntimeWiringSurface = {
      exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    };
    const adapters = buildRuntimeAdapters(pi);
    await expect(adapters.subagent!.subagent({ agent: "a", task: "t" })).rejects.toThrow(
      "install npm:pi-subagents",
    );
  });
});
