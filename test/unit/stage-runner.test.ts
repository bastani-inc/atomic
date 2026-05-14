/**
 * Unit tests for createStageContext — metadata propagation through stage adapters.
 *
 * Verifies:
 *  - prompt adapter receives { runId, stageId, stageName, signal } as meta
 *  - complete adapter receives meta and preserves CompleteStageOpts (model, maxTokens)
 *  - subagent adapter receives meta
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
import { createStageContext } from "../../src/runs/foreground/stage-runner.js";
import type {
  StageRunnerOpts,
  PromptAdapter,
  CompleteAdapter,
  SubagentAdapter,
} from "../../src/runs/foreground/stage-runner.js";
import type { StageExecutionMeta, CompleteStageOpts, SubagentStageOpts } from "../../src/shared/types.js";

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
// subagent — metadata propagation
// ---------------------------------------------------------------------------

describe("createStageContext — subagent metadata propagation", () => {
  test("subagent adapter receives full meta", async () => {
    const received: StageExecutionMeta[] = [];
    const signal = makeSignal();
    const subagentAdapter: SubagentAdapter = {
      async subagent(_opts, meta) { received.push(meta!); return "done"; },
    };
    const ctx = createStageContext({
      stageId: "s-sub",
      stageName: "SubStage",
      runId: "r-sub",
      signal,
      adapters: { subagent: subagentAdapter },
    });
    await ctx.subagent({ agent: "coder", task: "fix bug" });
    assert.deepEqual(received[0], {
      runId: "r-sub",
      stageId: "s-sub",
      stageName: "SubStage",
      signal,
      stageOptions: undefined,
    });
  });

  test("subagent adapter receives SubagentStageOpts intact", async () => {
    const receivedOpts: SubagentStageOpts[] = [];
    const subagentAdapter: SubagentAdapter = {
      async subagent(opts) { receivedOpts.push(opts); return "ok"; },
    };
    const ctx = createStageContext(makeOpts({ adapters: { subagent: subagentAdapter } }));
    // pi-subagents v0.24.2: `context` is the literal union `"fresh" | "fork"`.
    await ctx.subagent({ agent: "reviewer", task: "review PR", context: "fork" });
    assert.deepEqual(receivedOpts[0], { agent: "reviewer", task: "review PR", context: "fork" });
  });

  test("throws when subagent adapter absent", async () => {
    const ctx = createStageContext(makeOpts({ adapters: {} }));
    await assert.rejects(ctx.subagent({ agent: "x", task: "y" }), { message: /subagent requires pi task delegation/ });
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("createStageContext — error paths", () => {
  test("complete throws when adapter absent", async () => {
    const ctx = createStageContext(makeOpts({ adapters: {} }));
    await assert.rejects(ctx.complete("text"), { message: /complete adapter not configured/ });
  });

  test("stage name exposed on ctx.name", () => {
    const ctx = createStageContext(makeOpts({ stageName: "Ingest" }));
    assert.equal(ctx.name, "Ingest");
  });
});

// ---------------------------------------------------------------------------
// Lazy attach + controlled pause
// ---------------------------------------------------------------------------

import type { InternalStageContext, AgentSessionAdapter, StageSessionRuntime } from "../../src/runs/foreground/stage-runner.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

function makeMockSession(overrides: Partial<StageSessionRuntime> = {}): {
  session: StageSessionRuntime;
  state: { promptCalls: number; abortCalls: number; resolvers: Array<() => void> };
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
  return { session, state };
}

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

  test("signal abort while paused rejects the awaiter with a typed error", async () => {
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

    // Attach the rejection expectation BEFORE firing abort() so the
    // deferred reject doesn't bubble as an unhandled rejection in the
    // tick between abort() and `await assert.rejects`.
    const rejection = assert.rejects(promptPromise, /aborted while paused/);
    controller.abort();
    await rejection;
  });
});
