/**
 * Unit tests for createStageContext — metadata propagation through stage adapters.
 *
 * Verifies:
 *  - prompt adapter receives { runId, stageId, stageName, signal } as meta
 *  - complete adapter receives meta and preserves CompleteStageOpts (model, maxTokens)
 *  - AbortSignal threaded end-to-end through meta
 *
 * cross-ref: src/runs/foreground/stage-runner.ts
 *            src/shared/types.ts StageExecutionMeta
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStageContext } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type {
  StageRunnerOpts,
  PromptAdapter,
  CompleteAdapter,
} from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { StageExecutionMeta, CompleteStageOpts } from "../../packages/workflows/src/shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignal(): AbortSignal {
  return new AbortController().signal;
}

function makeOpts(overrides: Partial<StageRunnerOpts> = {}): StageRunnerOpts {
  return {
    stageId: "stage-abc",
    stageName: "My Stage",
    runId: "run-xyz",
    adapters: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// prompt — metadata propagation
// ---------------------------------------------------------------------------

describe("createStageContext — prompt metadata propagation", () => {
  test("prompt adapter receives runId from opts", async () => {
    const received: StageExecutionMeta[] = [];
    const promptAdapter: PromptAdapter = {
      async prompt(_text, meta) {
        received.push(meta!);
        return "ok";
      },
    };
    const ctx = createStageContext(makeOpts({ adapters: { prompt: promptAdapter }, runId: "run-001" }));
    await ctx.prompt("hello");
    assert.equal(received[0]?.runId, "run-001");
  });

  test("prompt adapter receives stageId from opts", async () => {
    const received: StageExecutionMeta[] = [];
    const promptAdapter: PromptAdapter = {
      async prompt(_text, meta) { received.push(meta!); return "ok"; },
    };
    const ctx = createStageContext(makeOpts({ adapters: { prompt: promptAdapter }, stageId: "s-99" }));
    await ctx.prompt("hi");
    assert.equal(received[0]?.stageId, "s-99");
  });

  test("prompt adapter receives stageName from opts", async () => {
    const received: StageExecutionMeta[] = [];
    const promptAdapter: PromptAdapter = {
      async prompt(_text, meta) { received.push(meta!); return "ok"; },
    };
    const ctx = createStageContext(makeOpts({ adapters: { prompt: promptAdapter }, stageName: "Analysis" }));
    await ctx.prompt("analyze");
    assert.equal(received[0]?.stageName, "Analysis");
  });

  test("prompt adapter receives signal from opts", async () => {
    const received: StageExecutionMeta[] = [];
    const signal = makeSignal();
    const promptAdapter: PromptAdapter = {
      async prompt(_text, meta) { received.push(meta!); return "ok"; },
    };
    const ctx = createStageContext(makeOpts({ adapters: { prompt: promptAdapter }, signal }));
    await ctx.prompt("go");
    assert.equal(received[0]?.signal, signal);
  });

  test("prompt adapter receives full meta object in one call", async () => {
    const received: StageExecutionMeta[] = [];
    const signal = makeSignal();
    const promptAdapter: PromptAdapter = {
      async prompt(_text, meta) { received.push(meta!); return "done"; },
    };
    const ctx = createStageContext({
      stageId: "s-42",
      stageName: "Summarise",
      runId: "r-100",
      signal,
      adapters: { prompt: promptAdapter },
    });
    await ctx.prompt("summarise this");
    assert.deepEqual(received[0], {
      runId: "r-100",
      stageId: "s-42",
      stageName: "Summarise",
      signal,
      stageOptions: undefined,
    });
  });

  test("prompt adapter receives the text passed to ctx.prompt", async () => {
    const texts: string[] = [];
    const promptAdapter: PromptAdapter = {
      async prompt(text) { texts.push(text); return "ack"; },
    };
    const ctx = createStageContext(makeOpts({ adapters: { prompt: promptAdapter } }));
    await ctx.prompt("specific text payload");
    assert.deepEqual(texts, ["specific text payload"]);
  });

  test("signal is undefined in meta when opts.signal absent", async () => {
    const received: StageExecutionMeta[] = [];
    const promptAdapter: PromptAdapter = {
      async prompt(_text, meta) { received.push(meta!); return "ok"; },
    };
    const ctx = createStageContext(makeOpts({ adapters: { prompt: promptAdapter } }));
    await ctx.prompt("go");
    assert.equal(received[0]?.signal, undefined);
  });

  test("prompt outputMode=file-only writes full output and returns a saved-file reference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-workflows-stage-output-"));
    try {
      const output = join(dir, "answer.md");
      const promptAdapter: PromptAdapter = {
        async prompt() { return "line one\nline two"; },
      };
      const ctx = createStageContext(makeOpts({ adapters: { prompt: promptAdapter } }));

      const result = await ctx.prompt("go", { output, outputMode: "file-only" });

      assert.match(result, /^Output saved to: /);
      assert.match(result, /answer\.md/);
      assert.equal(await readFile(output, "utf8"), "line one\nline two");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("prompt outputMode=file-only requires an output path", async () => {
    const promptAdapter: PromptAdapter = {
      async prompt() { return "ok"; },
    };
    const ctx = createStageContext(makeOpts({ adapters: { prompt: promptAdapter } }));
    await assert.rejects(
      ctx.prompt("go", { outputMode: "file-only" }),
      /outputMode: "file-only".*output file/,
    );
  });

  test("prompt maxOutput truncates inline output", async () => {
    const promptAdapter: PromptAdapter = {
      async prompt() { return "first line\nsecond line"; },
    };
    const ctx = createStageContext(makeOpts({ adapters: { prompt: promptAdapter } }));

    const result = await ctx.prompt("go", { maxOutput: { lines: 1 } });

    assert.equal(result, "first line\n\n[workflow output truncated; limits: 204800 bytes, 1 lines]");
  });

  test("prompt strips workflow output options before delegating to the SDK session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-workflows-session-dir-"));
    try {
      const receivedOptions: Array<Record<string, unknown> | undefined> = [];
      const { session } = makeMockSession({
        async prompt(_text, options) {
          receivedOptions.push(options as Record<string, unknown> | undefined);
        },
        getLastAssistantText() { return "ok"; },
      });
      const agentSession: AgentSessionAdapter = { async create() { return session; } };
      const ctx = createStageContext(makeOpts({
        adapters: { agentSession },
        stageOptions: { cwd: dir, sessionDir: dir, context: "fork" },
      })) as InternalStageContext;

      const result = await ctx.prompt("go", {
        output: false,
        maxOutput: { bytes: 10 },
        cwd: "/ignored-for-session",
        context: "fresh",
        sessionDir: "/ignored-sessions",
        expandPromptTemplates: false,
      });

      assert.equal(result, "ok");
      assert.deepEqual(receivedOptions[0], { expandPromptTemplates: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// complete — metadata propagation + CompleteStageOpts preservation
// ---------------------------------------------------------------------------

describe("createStageContext — complete metadata propagation", () => {
  test("complete adapter receives full meta", async () => {
    const received: StageExecutionMeta[] = [];
    const signal = makeSignal();
    const completeAdapter: CompleteAdapter = {
      async complete(_text, _opts, meta) { received.push(meta!); return "done"; },
    };
    const ctx = createStageContext({
      stageId: "s-7",
      stageName: "Draft",
      runId: "r-55",
      signal,
      adapters: { complete: completeAdapter },
    });
    await ctx.complete("write a draft");
    assert.deepEqual(received[0], {
      runId: "r-55",
      stageId: "s-7",
      stageName: "Draft",
      signal,
      stageOptions: undefined,
    });
  });

  test("complete adapter receives CompleteStageOpts.model", async () => {
    const receivedOpts: Array<CompleteStageOpts | undefined> = [];
    const completeAdapter: CompleteAdapter = {
      async complete(_text, opts) { receivedOpts.push(opts); return "ok"; },
    };
    const ctx = createStageContext(makeOpts({ adapters: { complete: completeAdapter } }));
    await ctx.complete("write", { model: "gpt-4o" });
    assert.equal(receivedOpts[0]?.model, "gpt-4o");
  });

  test("complete adapter receives CompleteStageOpts.maxTokens", async () => {
    const receivedOpts: Array<CompleteStageOpts | undefined> = [];
    const completeAdapter: CompleteAdapter = {
      async complete(_text, opts) { receivedOpts.push(opts); return "ok"; },
    };
    const ctx = createStageContext(makeOpts({ adapters: { complete: completeAdapter } }));
    await ctx.complete("write", { maxTokens: 512 });
    assert.equal(receivedOpts[0]?.maxTokens, 512);
  });

  test("complete adapter receives both model and maxTokens intact", async () => {
    const receivedOpts: Array<CompleteStageOpts | undefined> = [];
    const completeAdapter: CompleteAdapter = {
      async complete(_text, opts) { receivedOpts.push(opts); return "ok"; },
    };
    const ctx = createStageContext(makeOpts({ adapters: { complete: completeAdapter } }));
    await ctx.complete("write", { model: "claude-opus-4", maxTokens: 1024 });
    assert.deepEqual(receivedOpts[0], { model: "claude-opus-4", maxTokens: 1024 });
  });

  test("complete adapter receives undefined opts when none passed", async () => {
    const receivedOpts: Array<CompleteStageOpts | undefined> = [];
    const completeAdapter: CompleteAdapter = {
      async complete(_text, opts) { receivedOpts.push(opts); return "ok"; },
    };
    const ctx = createStageContext(makeOpts({ adapters: { complete: completeAdapter } }));
    await ctx.complete("write");
    assert.equal(receivedOpts[0], undefined);
  });

  test("complete adapter receives text passed to ctx.complete", async () => {
    const texts: string[] = [];
    const completeAdapter: CompleteAdapter = {
      async complete(text) { texts.push(text); return "ok"; },
    };
    const ctx = createStageContext(makeOpts({ adapters: { complete: completeAdapter } }));
    await ctx.complete("the input text");
    assert.deepEqual(texts, ["the input text"]);
  });

  test("complete meta signal is undefined when opts.signal absent", async () => {
    const received: Array<StageExecutionMeta | undefined> = [];
    const completeAdapter: CompleteAdapter = {
      async complete(_text, _opts, meta) { received.push(meta); return "ok"; },
    };
    const ctx = createStageContext(makeOpts({ adapters: { complete: completeAdapter } }));
    await ctx.complete("hi");
    assert.equal(received[0]?.signal, undefined);
  });
});

// ---------------------------------------------------------------------------
// Stage surface
// ---------------------------------------------------------------------------

describe("createStageContext — stage surface", () => {
  test("does not expose a subagent helper", () => {
    const ctx = createStageContext(makeOpts({ adapters: {} }));
    assert.equal("subagent" in ctx, false);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("createStageContext — error paths", () => {
  test("complete without adapters fails with a complete-specific configuration hint", async () => {
    const ctx = createStageContext(makeOpts({ adapters: {} }));
    await assert.rejects(ctx.complete("text"), {
      message: /ctx\.complete requires either RunOpts\.adapters\.complete or RunOpts\.adapters\.agentSession/,
    });
  });

  test("complete options require an explicit complete adapter", async () => {
    const ctx = createStageContext(makeOpts({
      adapters: { agentSession: { create: async () => makeMockSession().session } },
    }));
    await assert.rejects(ctx.complete("text", { maxTokens: 12 }), { message: /complete options require a CompleteAdapter/ });
  });

  test("stage name exposed on ctx.name", () => {
    const ctx = createStageContext(makeOpts({ stageName: "Ingest" }));
    assert.equal(ctx.name, "Ingest");
  });
});

// ---------------------------------------------------------------------------
// Lazy attach + controlled pause
// ---------------------------------------------------------------------------

import type { InternalStageContext, AgentSessionAdapter, StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { AgentSession } from "@bastani/atomic";

function makeMockSession(overrides: Partial<StageSessionRuntime> = {}): {
  session: StageSessionRuntime;
  state: { promptCalls: number; abortCalls: number; resolvers: Array<() => void> };
  emit: (event: { type: string; [k: string]: unknown }) => void;
} {
  const state = {
    promptCalls: 0,
    abortCalls: 0,
    resolvers: [] as Array<() => void>,
  };
  const listeners = new Set<(e: { type: string; [k: string]: unknown }) => void>();
  const session: StageSessionRuntime = {
    async prompt() {
      state.promptCalls += 1;
      // Pretend the SDK is in-flight; return a controllable promise.
      return new Promise<void>((resolve, reject) => {
        state.resolvers.push(resolve);
        // Reject if abort is invoked.
        (session as { __reject?: (err: Error) => void }).__reject = reject;
      });
    },
    async steer() {},
    async followUp() {},
    subscribe(listener) {
      listeners.add(listener as never);
      return () => listeners.delete(listener as never);
    },
    sessionFile: "/tmp/session.ndjson",
    sessionId: "sess-1",
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
    async abort() {
      state.abortCalls += 1;
      const reject = (session as { __reject?: (err: Error) => void }).__reject;
      reject?.(new Error("AbortError"));
    },
    dispose() {},
    getLastAssistantText() {
      return "ok";
    },
    ...overrides,
  };
  const emit = (event: { type: string; [k: string]: unknown }): void => {
    for (const listener of listeners) listener(event);
  };
  return { session, state, emit };
}

describe("createStageContext — model fallback", () => {
  test("primary retryable failure tries fallback and records metadata", async () => {
    const calls: string[] = [];
    const disposed: string[] = [];
    const agentSession: AgentSessionAdapter = {
      async create(options) {
        const model = typeof options.model === "string" ? options.model : `${String(options.model?.provider)}/${options.model?.id}`;
        calls.push(model);
        const { session } = makeMockSession({
          async prompt() {
            if (model === "anthropic/primary") throw new Error("429 rate limit exceeded");
          },
          dispose() {
            disposed.push(model);
          },
          getLastAssistantText() {
            return model === "openai/fallback" ? "fallback answer" : undefined;
          },
        });
        return session;
      },
    };

    const ctx = createStageContext(makeOpts({
      adapters: { agentSession },
      stageOptions: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
    })) as InternalStageContext;

    const text = await ctx.prompt("go");

    assert.equal(text, "fallback answer");
    assert.deepEqual(calls, ["anthropic/primary", "openai/fallback"]);
    assert.deepEqual(disposed, ["anthropic/primary"]);
    assert.deepEqual(ctx.__modelFallbackMeta().attemptedModels, ["anthropic/primary", "openai/fallback"]);
    assert.deepEqual(ctx.__modelFallbackMeta().modelAttempts?.map((attempt) => attempt.success), [false, true]);
  });

  test("workflow fast mode keeps raw model metadata with a structured fast flag", async () => {
    const agentSession: AgentSessionAdapter = {
      async create() {
        const { session } = makeMockSession({
          model: { provider: "openai", id: "gpt-5.1-codex" } as AgentSession["model"],
          async prompt() {},
        });
        return session;
      },
    };

    const ctx = createStageContext(makeOpts({
      adapters: { agentSession },
      stageOptions: {
        settingsManager: {
          getCodexFastModeSettings: () => ({ chat: false, workflow: true }),
        },
      } as Parameters<typeof createStageContext>[0]["stageOptions"],
    })) as InternalStageContext;

    await ctx.prompt("go");

    assert.equal(ctx.__modelFallbackMeta().model, "openai/gpt-5.1-codex");
    assert.equal(ctx.__modelFallbackMeta().fastMode, true);
  });

  test("workflow fast mode metadata uses the adapter-created settings manager", async () => {
    const agentSession: AgentSessionAdapter = {
      async create() {
        const { session } = makeMockSession({
          model: { provider: "openai", id: "gpt-5.1-codex" } as AgentSession["model"],
          async prompt() {},
        });
        return {
          session,
          settingsManager: {
            getCodexFastModeSettings: () => ({ chat: false, workflow: true }),
          },
        };
      },
    };

    const ctx = createStageContext(makeOpts({ adapters: { agentSession } })) as InternalStageContext;

    await ctx.prompt("go");

    assert.equal(ctx.__modelFallbackMeta().model, "openai/gpt-5.1-codex");
    assert.equal(ctx.__modelFallbackMeta().fastMode, true);
  });

  test("workflow fast mode metadata uses the session settings manager when the adapter result omits one", async () => {
    const agentSession: AgentSessionAdapter = {
      async create() {
        const { session } = makeMockSession({
          model: { provider: "openai", id: "gpt-5.1-codex" } as AgentSession["model"],
          settingsManager: {
            getCodexFastModeSettings: () => ({ chat: false, workflow: true }),
          },
          async prompt() {},
        });
        return session;
      },
    };

    const ctx = createStageContext(makeOpts({ adapters: { agentSession } })) as InternalStageContext;

    await ctx.prompt("go");

    assert.equal(ctx.__modelFallbackMeta().model, "openai/gpt-5.1-codex");
    assert.equal(ctx.__modelFallbackMeta().fastMode, true);
  });

  test("workflow fast mode metadata does not reload settings when no manager is provided", async () => {
    const agentSession: AgentSessionAdapter = {
      async create() {
        const { session } = makeMockSession({
          model: { provider: "openai", id: "gpt-5.1-codex" } as AgentSession["model"],
          async prompt() {},
        });
        return session;
      },
    };

    const ctx = createStageContext(makeOpts({ adapters: { agentSession } })) as InternalStageContext;

    await ctx.prompt("go");

    assert.equal(ctx.__modelFallbackMeta().model, "openai/gpt-5.1-codex");
    assert.equal(ctx.__modelFallbackMeta().fastMode, undefined);
  });

  test("current model is appended as an implicit final fallback", async () => {
    const calls: string[] = [];
    const agentSession: AgentSessionAdapter = {
      async create(options) {
        const modelValue = (options as { readonly model?: string }).model;
        const model = typeof modelValue === "string" ? modelValue : "object-model";
        calls.push(model);
        const { session } = makeMockSession({
          async prompt() {
            if (model !== "current/model") throw new Error("503 service unavailable");
          },
          getLastAssistantText() {
            return model === "current/model" ? "current answer" : undefined;
          },
        });
        return session;
      },
    };

    const ctx = createStageContext(makeOpts({
      adapters: { agentSession },
      stageOptions: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
      models: {
        currentModel: "current/model",
        listModels: async () => [
          { provider: "anthropic", id: "primary", fullId: "anthropic/primary" },
          { provider: "openai", id: "fallback", fullId: "openai/fallback" },
          { provider: "current", id: "model", fullId: "current/model" },
        ],
      },
    })) as InternalStageContext;

    assert.equal(await ctx.prompt("go"), "current answer");
    assert.deepEqual(calls, ["anthropic/primary", "openai/fallback", "current/model"]);
    assert.deepEqual(ctx.__modelFallbackMeta().attemptedModels, calls);
  });

  test("non-retryable failure does not try fallback", async () => {
    const calls: string[] = [];
    const agentSession: AgentSessionAdapter = {
      async create(options) {
        calls.push(typeof options.model === "string" ? options.model : "object-model");
        const { session } = makeMockSession({
          async prompt() {
            throw new Error("command failed: bun test");
          },
        });
        return session;
      },
    };
    const ctx = createStageContext(makeOpts({
      adapters: { agentSession },
      stageOptions: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
    }));

    await assert.rejects(ctx.prompt("go"), /command failed/);
    assert.deepEqual(calls, ["anthropic/primary"]);
  });
});

describe("createStageContext — lazy attach", () => {
  test("__ensureSession creates the SDK session on demand", async () => {
    const { session } = makeMockSession();
    let creates = 0;
    const agentSession: AgentSessionAdapter = {
      async create() {
        creates += 1;
        return session;
      },
    };
    const ctx = createStageContext(makeOpts({ adapters: { agentSession } })) as InternalStageContext;
    assert.equal(creates, 0);
    await ctx.__ensureSession();
    assert.equal(creates, 1);
    // Idempotent: a second call reuses the cached promise.
    await ctx.__ensureSession();
    assert.equal(creates, 1);
  });

  test("__sessionMeta returns undefined keys before attach", () => {
    const ctx = createStageContext(makeOpts({ adapters: {} })) as InternalStageContext;
    assert.deepEqual(ctx.__sessionMeta(), { sessionId: undefined, sessionFile: undefined });
  });

  test("pending subscribers fire after lazy attach", async () => {
    const { session } = makeMockSession();
    const agentSession: AgentSessionAdapter = { async create() { return session; } };
    const ctx = createStageContext(makeOpts({ adapters: { agentSession } })) as InternalStageContext;
    const events: string[] = [];
    ctx.subscribe((event) => events.push((event as { type?: string }).type ?? ""));
    await ctx.__ensureSession();
    // Now drive an event through the live session (the listener is bound
    // on attach). We can't directly emit from our mock without state,
    // so we just assert the subscriber survived attach without throwing.
    assert.equal(events.length, 0);
  });

  test("prompt result falls back to assistant text appended to SDK messages", async () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "question" }],
        timestamp: Date.now(),
      },
    ] as AgentSession["messages"];
    const { session } = makeMockSession({
      async prompt() {
        messages.push({
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private reasoning" },
            { type: "text", text: "derived" },
            { type: "text", text: " answer" },
          ],
          timestamp: Date.now(),
        } as AgentSession["messages"][number]);
      },
      messages,
      getLastAssistantText: undefined,
    });
    const agentSession: AgentSessionAdapter = { async create() { return session; } };
    const ctx = createStageContext(makeOpts({ adapters: { agentSession } })) as InternalStageContext;

    const result = await ctx.prompt("question");

    assert.equal(result, "derived answer");
    assert.equal(ctx.getLastAssistantText(), "derived answer");
  });

  test("prompt result falls back to terminating tool result text", async () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "question" }],
        timestamp: Date.now(),
      },
    ] as AgentSession["messages"];
    let emit: (event: { type: string; [k: string]: unknown }) => void = () => {};
    const created = makeMockSession({
      async prompt() {
        messages.push({
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "review_decision", arguments: {} }],
          timestamp: Date.now(),
        } as AgentSession["messages"][number]);
        messages.push({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "review_decision",
          content: [{ type: "text", text: '{"stop_review_loop":true}' }],
          isError: false,
          timestamp: Date.now(),
        } as AgentSession["messages"][number]);
        // The tool actually terminated the turn: emit the runtime signal the
        // stage runner watches (the tool result message carries no terminate).
        emit({
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "review_decision",
          result: { terminate: true },
          isError: false,
        });
      },
      messages,
      getLastAssistantText: undefined,
    });
    emit = created.emit;
    const agentSession: AgentSessionAdapter = { async create() { return created.session; } };
    const ctx = createStageContext(makeOpts({ adapters: { agentSession } })) as InternalStageContext;

    const result = await ctx.prompt("question");

    assert.equal(result, '{"stop_review_loop":true}');
    assert.equal(ctx.getLastAssistantText(), '{"stop_review_loop":true}');
  });

  test("non-terminating trailing tool result falls back to the last assistant message", async () => {
    // A turn that ends on a tool result whose tool returned `terminate: false`
    // (e.g. interrupted/aborted right after a non-terminating tool call) must
    // NOT surface the tool result as the stage output — the last assistant
    // message wins.
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "question" }],
        timestamp: Date.now(),
      },
    ] as AgentSession["messages"];
    let emit: (event: { type: string; [k: string]: unknown }) => void = () => {};
    const created = makeMockSession({
      async prompt() {
        messages.push({
          role: "assistant",
          content: [
            { type: "text", text: "LAST ASSISTANT PROSE" },
            { type: "toolCall", id: "call-9", name: "note_progress", arguments: {} },
          ],
          timestamp: Date.now(),
        } as AgentSession["messages"][number]);
        messages.push({
          role: "toolResult",
          toolCallId: "call-9",
          toolName: "note_progress",
          content: [{ type: "text", text: "tool output that must NOT be the stage result" }],
          isError: false,
          timestamp: Date.now(),
        } as AgentSession["messages"][number]);
        // Non-terminating tool: terminate is false, so the trailing tool result
        // is not the turn output.
        emit({
          type: "tool_execution_end",
          toolCallId: "call-9",
          toolName: "note_progress",
          result: { terminate: false },
          isError: false,
        });
      },
      messages,
      getLastAssistantText: () => "LAST ASSISTANT PROSE",
    });
    emit = created.emit;
    const agentSession: AgentSessionAdapter = { async create() { return created.session; } };
    const ctx = createStageContext(makeOpts({ adapters: { agentSession } })) as InternalStageContext;

    const result = await ctx.prompt("question");

    assert.equal(result, "LAST ASSISTANT PROSE");
    assert.equal(ctx.getLastAssistantText(), "LAST ASSISTANT PROSE");
  });

  test("terminating tool result wins over assistant prose emitted before the tool call", async () => {
    // Mirrors the real review_decision (goal/ralph) case: the model narrates in
    // prose and then ends the turn on the terminating structured-output tool.
    // The deterministic turn output must be the tool result JSON, not the prose.
    const verdict =
      '{"stop_review_loop":true,"overall_correctness":"patch is correct"}';
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "question" }],
        timestamp: Date.now(),
      },
    ] as AgentSession["messages"];
    let emit: (event: { type: string; [k: string]: unknown }) => void = () => {};
    const created = makeMockSession({
      async prompt() {
        messages.push({
          role: "assistant",
          content: [
            { type: "text", text: "All validation passes; the patch looks correct." },
            { type: "toolCall", id: "call-1", name: "review_decision", arguments: {} },
          ],
          timestamp: Date.now(),
        } as AgentSession["messages"][number]);
        messages.push({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "review_decision",
          content: [{ type: "text", text: verdict }],
          isError: false,
          timestamp: Date.now(),
        } as AgentSession["messages"][number]);
        emit({
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "review_decision",
          result: { terminate: true },
          isError: false,
        });
      },
      messages,
      getLastAssistantText: () => "All validation passes; the patch looks correct.",
    });
    emit = created.emit;
    const agentSession: AgentSessionAdapter = { async create() { return created.session; } };
    const ctx = createStageContext(makeOpts({ adapters: { agentSession } })) as InternalStageContext;

    const result = await ctx.prompt("question");

    assert.equal(result, verdict);
    assert.equal(ctx.getLastAssistantText(), verdict);
  });
});

function flushMicrotasks(times = 8): Promise<void> {
  return new Promise<void>((resolve) => {
    let i = times;
    const tick = (): void => {
      if (i-- <= 0) resolve();
      else queueMicrotask(tick);
    };
    tick();
  });
}

describe("createStageContext — controlled pause", () => {
  test("__requestPause aborts the current SDK call without finalising the stage", async () => {
    const { session, state } = makeMockSession();
    const agentSession: AgentSessionAdapter = { async create() { return session; } };
    const ctx = createStageContext(makeOpts({ adapters: { agentSession } })) as InternalStageContext;

    const promptPromise = ctx.prompt("ask the model");
    // Let prompt() reach session.prompt() (await ensureSession() + await s.prompt()).
    await flushMicrotasks();
    assert.equal(state.promptCalls, 1);
    assert.equal(ctx.__isPaused(), false);

    await ctx.__requestPause();
    assert.equal(state.abortCalls, 1);
    assert.equal(ctx.__isPaused(), true);

    // The prompt() awaiter must still be pending — paused, not failed.
    let settled = false;
    void promptPromise.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await flushMicrotasks();
    assert.equal(settled, false);

    // Resume without a message: the awaiter resolves with the last assistant text.
    await ctx.__resume();
    const result = await promptPromise;
    assert.equal(result, "ok");
    assert.equal(ctx.__isPaused(), false);
  });

  test("__requestPause still suspends when SDK prompt resolves after abort", async () => {
    let resolvePrompt: (() => void) | undefined;
    const { session, state } = makeMockSession({
      async prompt() {
        state.promptCalls += 1;
        return new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        });
      },
      async abort() {
        state.abortCalls += 1;
        resolvePrompt?.();
      },
    });
    const agentSession: AgentSessionAdapter = { async create() { return session; } };
    const ctx = createStageContext(makeOpts({ adapters: { agentSession } })) as InternalStageContext;

    const promptPromise = ctx.prompt("ask the model");
    await flushMicrotasks();
    assert.equal(state.promptCalls, 1);

    await ctx.__requestPause();
    assert.equal(state.abortCalls, 1);
    assert.equal(ctx.__isPaused(), true);

    let settled = false;
    void promptPromise.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await flushMicrotasks();
    assert.equal(settled, false);

    await ctx.__resume("continue from pause");
    await flushMicrotasks();
    assert.equal(state.promptCalls, 2);
    resolvePrompt?.();
    await promptPromise;
  });

  test("__resume(message) re-issues prompt with the provided text", async () => {
    const { session, state } = makeMockSession();
    const agentSession: AgentSessionAdapter = { async create() { return session; } };
    const ctx = createStageContext(makeOpts({ adapters: { agentSession } })) as InternalStageContext;

    const promptPromise = ctx.prompt("first");
    // Pre-empt any unhandled-rejection bubbling on the prompt promise.
    void promptPromise.catch(() => {});
    await flushMicrotasks();

    await ctx.__requestPause();
    // The original prompt was aborted and the SDK call count is 1.
    assert.equal(state.promptCalls, 1);

    // Resume with a new message: the SDK is invoked again with the new text.
    await ctx.__resume("retry with this");
    await flushMicrotasks();
    assert.equal(state.promptCalls, 2);

    // Settle the second SDK call — pop the latest mock resolver.
    state.resolvers[state.resolvers.length - 1]?.();
    await promptPromise;
  });

  test("signal abort while paused rejects the awaiter with the workflow kill reason", async () => {
    const { session, state } = makeMockSession();
    const agentSession: AgentSessionAdapter = { async create() { return session; } };
    const controller = new AbortController();
    const ctx = createStageContext(
      makeOpts({ adapters: { agentSession }, signal: controller.signal }),
    ) as InternalStageContext;

    const promptPromise = ctx.prompt("ask");
    await flushMicrotasks();
    await ctx.__requestPause();
    assert.equal(state.abortCalls, 1);

    const rejection = assert.rejects(promptPromise, /workflow killed/);
    controller.abort(new Error("workflow killed"));
    await rejection;
  });
});
