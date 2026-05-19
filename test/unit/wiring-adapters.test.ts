/**
 * Tests for buildRuntimeAdapters — pi AgentSession wiring.
 *
 * The legacy `buildUIAdapter` (pi.ui → WorkflowUIAdapter for HIL) was removed
 * when workflows became background-only — HIL prompts now route through the
 * store-backed background adapter (see `background-ui-adapter.test.ts`).
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildRuntimeAdapters, prepareAtomicStageSessionOptions } from "../../packages/workflows/src/extension/wiring.js";
import type { CreateAgentSessionOptions } from "@bastani/atomic";
import type { PiCodingAgentSdk, PiSdkResourceLoader, PiSdkSettingsManager } from "../../packages/workflows/src/extension/wiring.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";

function fakeSession(): StageSessionRuntime {
  let last = "";
  return {
    async prompt(text: string): Promise<string> { last = `reply:${text}`; return last; },
    async steer(text: string): Promise<void> { last = `steer:${text}`; },
    async followUp(text: string): Promise<void> { last = `follow:${text}`; },
    subscribe: () => () => {},
    sessionFile: undefined,
    sessionId: "session-1",
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


function makeFakeAtomicSdk(defaultAgentDir: string, builtinPackagePaths: string[] = []): {
  readonly sdk: PiCodingAgentSdk;
  readonly loaderOptions: Array<{ cwd: string; agentDir: string; settingsManager?: PiSdkSettingsManager; builtinPackagePaths?: string[] }>;
  readonly settingsCalls: Array<{ cwd?: string; agentDir?: string }>;
  readonly reloads: PiSdkResourceLoader[];
} {
  const loaderOptions: Array<{ cwd: string; agentDir: string; settingsManager?: PiSdkSettingsManager; builtinPackagePaths?: string[] }> = [];
  const settingsCalls: Array<{ cwd?: string; agentDir?: string }> = [];
  const reloads: PiSdkResourceLoader[] = [];

  class FakeResourceLoader implements PiSdkResourceLoader {
    constructor(options: { cwd: string; agentDir: string; settingsManager?: PiSdkSettingsManager; builtinPackagePaths?: string[] }) {
      loaderOptions.push(options);
    }

    async reload(): Promise<void> {
      reloads.push(this);
    }
  }

  const sdk: PiCodingAgentSdk = {
    getAgentDir: () => defaultAgentDir,
    getBuiltinPackagePaths: () => builtinPackagePaths,
    SettingsManager: {
      create(cwd?: string, agentDir?: string): PiSdkSettingsManager {
        settingsCalls.push({ cwd, agentDir });
        return { cwd, agentDir } as PiSdkSettingsManager;
      },
    },
    DefaultResourceLoader: FakeResourceLoader,
    async createAgentSession(): Promise<{ session: StageSessionRuntime }> {
      return { session: fakeSession() };
    },
  };

  return { sdk, loaderOptions, settingsCalls, reloads };
}

describe("prepareAtomicStageSessionOptions", () => {
  test("uses the Atomic default agent dir for resource loading without turning it into a user override", async () => {
    const projectDir = join("/tmp", "project");
    const atomicAgentDir = join("/home", "user", ".atomic", "agent");
    const { sdk, loaderOptions, settingsCalls, reloads } = makeFakeAtomicSdk(atomicAgentDir);

    const options = await prepareAtomicStageSessionOptions({ cwd: projectDir }, sdk);

    assert.equal(options?.cwd, projectDir);
    assert.equal(options?.agentDir, undefined);
    assert.equal(loaderOptions[0]?.cwd, projectDir);
    assert.equal(loaderOptions[0]?.agentDir, atomicAgentDir);
    assert.equal(settingsCalls[0]?.cwd, projectDir);
    assert.equal(settingsCalls[0]?.agentDir, atomicAgentDir);
    assert.equal(reloads.length, 1);
  });

  test("preserves a user-provided agentDir as an explicit single-directory override", async () => {
    const projectDir = join("/tmp", "project");
    const atomicAgentDir = join("/home", "user", ".atomic", "agent");
    const customAgentDir = join("/tmp", "custom-agent");
    const { sdk, loaderOptions } = makeFakeAtomicSdk(atomicAgentDir);

    const options = await prepareAtomicStageSessionOptions({ cwd: projectDir, agentDir: customAgentDir }, sdk);

    assert.equal(options?.agentDir, customAgentDir);
    assert.equal(loaderOptions[0]?.agentDir, customAgentDir);
  });

  test("loads Atomic builtin package extensions for workflow stage sessions", async () => {
    const projectDir = join("/tmp", "project");
    const atomicAgentDir = join("/home", "user", ".atomic", "agent");
    const builtinPackagePaths = [
      "/repo/packages/workflows",
      "/repo/packages/subagents",
      "/repo/packages/mcp",
      "/repo/packages/web-access",
      "/repo/packages/intercom",
    ];
    const { sdk, loaderOptions } = makeFakeAtomicSdk(atomicAgentDir, builtinPackagePaths);

    await prepareAtomicStageSessionOptions({ cwd: projectDir }, sdk);

    assert.deepEqual(loaderOptions[0]?.builtinPackagePaths, builtinPackagePaths);
  });
});

describe("buildRuntimeAdapters — SDK AgentSession adapter", () => {
  test("provides an agentSession adapter without requiring pi.exec", () => {
    const adapters = buildRuntimeAdapters({});
    assert.notEqual(adapters.agentSession, undefined);
    assert.equal(adapters.prompt, undefined);
    assert.equal(adapters.complete, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(adapters, "subagent"), false);
  });

  test(
    "falls back to the pi SDK createAgentSession in production (NODE_ENV unset) — proves pi-coding-agent ≥ 0.74 integration",
    () => {
      // The pi SDK (`@bastani/atomic` ≥ 0.74) exposes
      // `createAgentSession` as a top-level package export, NOT on the
      // ExtensionAPI surface. The workflow extension MUST resolve a default
      // session factory from that package in production (no test context,
      // no caller-provided seam). Otherwise stages that rely on the default
      // SDK-backed prompt() path crash with "prompt adapter not configured"
      // at runtime.
      const savedNodeEnv = process.env["NODE_ENV"];
      const savedNodeTestCtx = process.env["NODE_TEST_CONTEXT"];
      delete process.env["NODE_ENV"];
      delete process.env["NODE_TEST_CONTEXT"];
      try {
        const adapters = buildRuntimeAdapters({});
        assert.notEqual(
          adapters.agentSession,
          undefined,
          "production buildRuntimeAdapters MUST wire an agentSession adapter via the pi SDK; got undefined.",
        );
      } finally {
        if (savedNodeEnv === undefined) delete process.env["NODE_ENV"];
        else process.env["NODE_ENV"] = savedNodeEnv;
        if (savedNodeTestCtx === undefined) delete process.env["NODE_TEST_CONTEXT"];
        else process.env["NODE_TEST_CONTEXT"] = savedNodeTestCtx;
      }
    },
  );

  test("agentSession.create delegates to createAgentSession seam", async () => {
    const calls: Array<CreateAgentSessionOptions | undefined> = [];
    const adapters = buildRuntimeAdapters({}, {
      createAgentSession: async (options) => { calls.push(options); return { session: fakeSession() }; },
    });
    const session = await adapters.agentSession!.create({ cwd: "/tmp/project" });
    assert.equal(session.sessionId, "session-1");
    assert.equal(calls[0]?.cwd, "/tmp/project");
  });

  test("agentSession.create forwards stage options unchanged (pi SDK leaves resource isolation to SettingsManager)", async () => {
    const calls: Array<CreateAgentSessionOptions | undefined> = [];
    const adapters = buildRuntimeAdapters({}, {
      createAgentSession: async (options) => { calls.push(options); return { session: fakeSession() }; },
    });
    await adapters.agentSession!.create({ cwd: "/tmp/project" });
    assert.equal(calls[0]?.cwd, "/tmp/project");
    // Per-call isolation knobs (`disableExtensionDiscovery`, `skills`,
    // `promptTemplates`, `slashCommands`) are not part of the pi SDK
    // surface — resource loading is owned by `SettingsManager` /
    // `ResourceLoader`. The SDK intentionally has no equivalent fields.
    assert.ok(!("disableExtensionDiscovery" in calls[0]!));
    assert.ok(!("skills" in calls[0]!));
    assert.ok(!("promptTemplates" in calls[0]!));
    assert.ok(!("slashCommands" in calls[0]!));
  });

  test("agentSession.create lets callers override fields the SDK still supports", async () => {
    const calls: Array<CreateAgentSessionOptions | undefined> = [];
    const adapters = buildRuntimeAdapters({}, {
      createAgentSession: async (options) => { calls.push(options); return { session: fakeSession() }; },
    });
    await adapters.agentSession!.create({
      cwd: "/tmp/project",
      thinkingLevel: "high",
      noTools: "all",
    });
    assert.equal(calls[0]?.cwd, "/tmp/project");
    assert.equal(calls[0]?.thinkingLevel, "high");
    assert.equal(calls[0]?.noTools, "all");
  });

  test("strips workflow-only fallbackModels before calling createAgentSession", async () => {
    const calls: Array<CreateAgentSessionOptions | undefined> = [];
    const adapters = buildRuntimeAdapters({}, {
      createAgentSession: async (options) => { calls.push(options); return { session: fakeSession() }; },
    });
    await adapters.agentSession!.create({ cwd: "/tmp/project", fallbackModels: ["openai/fallback"] });
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0], "fallbackModels"), false);
    assert.equal(calls[0]?.cwd, "/tmp/project");
  });

  test("strips workflow-only mcp options before calling createAgentSession", async () => {
    const calls: Array<CreateAgentSessionOptions | undefined> = [];
    const adapters = buildRuntimeAdapters({}, {
      createAgentSession: async (options) => { calls.push(options); return { session: fakeSession() }; },
    });
    await adapters.agentSession!.create({ cwd: "/tmp/project", mcp: { allow: ["github"] } });
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0], "mcp"), false);
    assert.equal(calls[0]?.cwd, "/tmp/project");
  });
});

