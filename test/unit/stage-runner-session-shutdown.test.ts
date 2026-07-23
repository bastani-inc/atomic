/**
 * Regression: workflow stage sessions must emit `session_shutdown` before
 * `dispose()`.
 *
 * Workflow stage sessions are SDK `AgentSession`s whose extensions are bound via
 * `bindExtensions` (which replays `session_start`). Tearing them down with
 * `dispose()` alone invalidates the extension runtime WITHOUT emitting
 * `session_shutdown`, so extensions such as MCP never get a graceful teardown
 * signal — leaving child MCP servers running and surfacing spurious stale-context
 * "MCP initialization failed" errors when init races with disposal.
 *
 * `disposeStageSession` mirrors the host `AgentSessionRuntime` teardown: emit
 * `session_shutdown` first, then dispose. These tests pin that ordering and the
 * graceful fallbacks (no runner / throwing handler).
 *
 * cross-ref: packages/workflows/src/runs/foreground/stage-runner.ts
 *            packages/coding-agent/src/core/agent-session-runtime.ts (teardownCurrent)
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createStageContext } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type {
  StageRunnerOpts,
  StageSessionRuntime,
} from "../../packages/workflows/src/runs/foreground/stage-runner.js";

type LifecycleEvent = "session_shutdown" | "dispose";

interface FakeSessionOptions {
  /** Attach a stub extension runner exposing hasHandlers/emit. */
  withExtensionRunner: boolean;
  /** Whether the stub runner reports a session_shutdown handler. */
  hasShutdownHandler?: boolean;
  /** Make the session_shutdown emit reject. */
  shutdownThrows?: boolean;
  /** Ordered lifecycle log shared with the test. */
  log: LifecycleEvent[];
}

function makeFakeStageSession(options: FakeSessionOptions): StageSessionRuntime {
  const base: StageSessionRuntime = {
    async prompt(text: string) {
      return `stub:${text}`;
    },
    async steer() {},
    async followUp() {},
    subscribe() {
      return () => {};
    },
    sessionFile: undefined,
    sessionId: `fake-${crypto.randomUUID()}`,
    async setModel() {},
    setThinkingLevel() {},
    async cycleModel() {
      return undefined;
    },
    cycleThinkingLevel() {
      return undefined;
    },
    agent: Object.create(null) as StageSessionRuntime["agent"],
    model: undefined,
    thinkingLevel: "off",
    messages: [] as StageSessionRuntime["messages"],
    isStreaming: false as StageSessionRuntime["isStreaming"],
    async navigateTree() {
      return { cancelled: true };
    },
    async compact() {
      return {
        compactedText: "[User]: retained",
        firstKeptEntryId: "kept",
        tokensBefore: 0,
        promptVersion: 3,
        parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "auto-detected" },
        rung: "planned" as const,
        stats: {
          linesBefore: 0,
          linesDeleted: 0,
          linesKept: 0,
          rangeCount: 0,
          tokensBefore: 0,
          tokensAfter: 0,
          percentReduction: 0,
        },
      };
    },
    abortCompaction() {},
    async abort() {},
    dispose() {
      options.log.push("dispose");
    },
    getLastAssistantText() {
      return undefined;
    },
  };

  if (!options.withExtensionRunner) return base;

  const extensionRunner = {
    hasHandlers(eventType: string): boolean {
      return eventType === "session_shutdown" && options.hasShutdownHandler !== false;
    },
    async emit(event: { readonly type: string }): Promise<unknown> {
      if (event.type === "session_shutdown") {
        options.log.push("session_shutdown");
        if (options.shutdownThrows) throw new Error("boom: shutdown handler failed");
      }
      return undefined;
    },
  };

  return Object.assign(base, { extensionRunner });
}

function makeOpts(session: StageSessionRuntime): StageRunnerOpts {
  return {
    stageId: "stage-1",
    stageName: "Stage One",
    runId: "run-1",
    adapters: {
      agentSession: {
        async create() {
          return session;
        },
      },
    },
  };
}

describe("disposeStageSession — graceful session_shutdown before dispose", () => {
  test("emits session_shutdown before dispose when the session exposes an extension runner", async () => {
    const log: LifecycleEvent[] = [];
    const session = makeFakeStageSession({ withExtensionRunner: true, log });
    const ctx = createStageContext(makeOpts(session));

    await ctx.__ensureSession();
    await ctx.__dispose();

    assert.deepEqual(log, ["session_shutdown", "dispose"]);
  });

  test("skips session_shutdown when the runner reports no handler, but still disposes", async () => {
    const log: LifecycleEvent[] = [];
    const session = makeFakeStageSession({
      withExtensionRunner: true,
      hasShutdownHandler: false,
      log,
    });
    const ctx = createStageContext(makeOpts(session));

    await ctx.__ensureSession();
    await ctx.__dispose();

    assert.deepEqual(log, ["dispose"]);
  });

  test("disposes plainly when the session has no extension runner (test stub shape)", async () => {
    const log: LifecycleEvent[] = [];
    const session = makeFakeStageSession({ withExtensionRunner: false, log });
    const ctx = createStageContext(makeOpts(session));

    await ctx.__ensureSession();
    await ctx.__dispose();

    assert.deepEqual(log, ["dispose"]);
  });

  test("a throwing session_shutdown handler never strands the session", async () => {
    const log: LifecycleEvent[] = [];
    const session = makeFakeStageSession({
      withExtensionRunner: true,
      shutdownThrows: true,
      log,
    });
    const ctx = createStageContext(makeOpts(session));

    const consoleErrors: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: Parameters<typeof console.error>) => {
      consoleErrors.push(args.map(String).join(" "));
    };
    try {
      await ctx.__ensureSession();
      // Must not reject, and must still dispose despite the handler throwing.
      await ctx.__dispose();
    } finally {
      console.error = originalConsoleError;
    }

    assert.deepEqual(log, ["session_shutdown", "dispose"]);
    assert.ok(
      consoleErrors.some((line) => line.includes("stage session_shutdown handler failed")),
      "a failing shutdown handler should be logged, not swallowed silently",
    );
  });
});
