/**
 * Runtime wiring tests for SDK-backed workflow stages.
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { buildRuntimeAdapters } from "../../packages/workflows/src/extension/wiring.js";
import { createStageContext } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { RuntimeWiringSurface } from "../../packages/workflows/src/extension/wiring.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";

function fakeSession(): StageSessionRuntime {
  let last = "";
  return {
    async prompt(text: string): Promise<string> { last = `sdk:${text}`; return last; },
    async steer(text: string): Promise<void> { last = `steer:${text}`; },
    async followUp(text: string): Promise<void> { last = `follow:${text}`; },
    subscribe: () => () => {},
    sessionFile: undefined,
    sessionId: "session-id",
    async setModel(): Promise<void> {},
    setThinkingLevel(): void {},
    async cycleModel(): Promise<undefined> { return undefined; },
    cycleThinkingLevel(): undefined { return undefined; },
    agent: {} as StageSessionRuntime["agent"],
    model: undefined,
    thinkingLevel: "medium" as StageSessionRuntime["thinkingLevel"],
    messages: [],
    isStreaming: false,
    async navigateTree(): Promise<{ cancelled: boolean }> { return { cancelled: true }; },
    async compact(): ReturnType<StageSessionRuntime["compact"]> {
      return undefined as unknown as Awaited<ReturnType<StageSessionRuntime["compact"]>>;
    },
    abortCompaction(): void {},
    async abort(): Promise<void> {},
    dispose(): void {},
    getLastAssistantText(): string | undefined { return last; },
  };
}

describe("buildRuntimeAdapters — SDK sessions", () => {
  test("always configures agentSession without pi.exec", () => {
    const adapters = buildRuntimeAdapters({});
    assert.notEqual(adapters.agentSession, undefined);
    assert.equal(adapters.prompt, undefined);
    assert.equal(adapters.complete, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(adapters, "subagent"), false);
  });

  test("forwards createAgentSession options from stage options", async () => {
    const calls: Array<CreateAgentSessionOptions | undefined> = [];
    const adapters = buildRuntimeAdapters({}, {
      createAgentSession: async (options) => { calls.push(options); return { session: fakeSession() }; },
    });
    await adapters.agentSession!.create({ cwd: "/repo", tools: ["read"], mcp: { deny: ["network"] } } as unknown as Parameters<NonNullable<typeof adapters.agentSession>["create"]>[0]);
    assert.equal(calls[0]?.cwd, "/repo");
    assert.deepEqual((calls[0] as unknown as { tools?: string[] })?.tools, ["read"]);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0], "mcp"), false);
  });

  test("stage prompt delegates to the SDK session adapter", async () => {
    const adapters = buildRuntimeAdapters({}, {
      createAgentSession: async () => ({ session: fakeSession() }),
    });
    const stage = createStageContext({ stageId: "s", stageName: "Stage", runId: "r", adapters });
    const result = await stage.prompt("hello");
    assert.equal(result, "sdk:hello");
    assert.equal(stage.getLastAssistantText(), "sdk:hello");
  });

  test("stage prompt output options do not override createAgentSession options", async () => {
    const calls: Array<CreateAgentSessionOptions | undefined> = [];
    const adapters = buildRuntimeAdapters({}, {
      createAgentSession: async (options) => { calls.push(options); return { session: fakeSession() }; },
    });
    const stage = createStageContext({
      stageId: "s",
      stageName: "Stage",
      runId: "r",
      adapters,
      stageOptions: { cwd: "/stage-cwd" },
    });

    await stage.prompt("hello", { cwd: "/prompt-cwd", context: "fork", sessionDir: "/prompt-sessions" });

    assert.equal(calls[0]?.cwd, "/stage-cwd");
    assert.equal((calls[0] as { context?: string } | undefined)?.context, undefined);
    assert.equal((calls[0] as { sessionDir?: string } | undefined)?.sessionDir, undefined);
  });

  test("does not inject custom tools per stage", async () => {
    const calls: CreateAgentSessionOptions[] = [];
    const adapters = buildRuntimeAdapters(
      { ui: { custom: () => undefined } },
      {
        createAgentSession: async (options) => {
          calls.push(options ?? {});
          return { session: fakeSession() };
        },
      },
    );

    await adapters.agentSession!.create({}, {
      runId: "run-1",
      stageId: "stage-1",
      stageName: "worker-a",
      signal: new AbortController().signal,
    });

    assert.equal(calls[0]?.tools, undefined);
    assert.equal(calls[0]?.customTools, undefined);
  });

  test("binds pi UI context onto stage sessions when ui.custom is available", async () => {
    const bindCalls: Array<{
      uiContext?: Record<string, unknown> & {
        custom?: <T = undefined>(factory: unknown, options?: unknown) => Promise<T> | T | undefined;
      };
    }> = [];
    const session = {
      ...fakeSession(),
      async bindExtensions(bindings: {
        uiContext?: Record<string, unknown> & {
          custom?: <T = undefined>(factory: unknown, options?: unknown) => Promise<T> | T | undefined;
        };
      }): Promise<void> {
        bindCalls.push(bindings);
      },
    };
    const pi: RuntimeWiringSurface = {
      ui: {
        custom: async () => undefined,
      },
    };
    const adapters = buildRuntimeAdapters(pi, {
      createAgentSession: async () => ({ session }),
    });

    await adapters.agentSession!.create({ tools: ["read"] }, {
      runId: "run-1",
      stageId: "stage-1",
      stageName: "worker-a",
      signal: new AbortController().signal,
    });

    assert.equal(typeof bindCalls[0]?.uiContext?.custom, "function");
  });

  test("binds inherited theme and UI extension helpers onto stage sessions", async () => {
    const bindCalls: Array<{ uiContext?: Record<string, unknown> }> = [];
    const session = {
      ...fakeSession(),
      async bindExtensions(bindings: { uiContext?: Record<string, unknown> }): Promise<void> {
        bindCalls.push(bindings);
      },
    };
    const theme = { name: "host-theme" };
    const adapters = buildRuntimeAdapters(
      {
        ui: {
          custom: async () => undefined,
          theme,
          getAllThemes: () => [{ name: "host-theme", path: "/themes/host.json" }],
          getTheme: (name: string) => (name === "host-theme" ? theme : undefined),
          setTheme: () => ({ success: true }),
          getToolsExpanded: () => true,
          setToolsExpanded: () => undefined,
        },
      },
      { createAgentSession: async () => ({ session }) },
    );

    await adapters.agentSession!.create({}, {
      runId: "run-1",
      stageId: "stage-1",
      stageName: "worker-a",
      signal: new AbortController().signal,
    });

    const uiContext = bindCalls[0]?.uiContext;
    assert.equal(uiContext?.theme, theme);
    assert.deepEqual((uiContext?.getAllThemes as () => unknown)(), [{ name: "host-theme", path: "/themes/host.json" }]);
    assert.equal((uiContext?.getTheme as (name: string) => unknown)("host-theme"), theme);
    assert.equal((uiContext?.setTheme as (name: string) => { success: boolean })("host-theme").success, true);
    assert.equal((uiContext?.getToolsExpanded as () => boolean)(), true);
  });
});

