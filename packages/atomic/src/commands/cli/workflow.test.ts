/**
 * Tests for the new workflow.ts additions:
 *   - dispatchExternal argv/env composition (via pure helpers)
 *   - hard-block on activeBroken
 *   - rebuildWorkflowCommand re-syncs dynamic options
 *   - dispatch() return type is Promise<void> for both branches
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { ExternalWorkflow } from "@bastani/atomic-sdk";

// ─── Import module under test ────────────────────────────────────────────────
// Static import loads real executor first; then we can replace Bun.spawn for
// testing external dispatch without actually spawning processes.

const {
  buildExternalDispatchArgv,
  buildExternalDispatchEnv,
  dispatch,
  buildWorkflowCommand,
  rebuildWorkflowCommand,
  getActiveRegistry,
  getActiveBroken,
} = await import("./workflow.ts");

const { createRegistry } = await import("@bastani/atomic-sdk/registry");
const { defineWorkflow } = await import("@bastani/atomic-sdk/define-workflow");

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeExternal(overrides: Partial<ExternalWorkflow> = {}): ExternalWorkflow {
  return {
    kind: "external",
    name: "my-ext",
    agent: "claude",
    inputs: [],
    description: "test external",
    source: { command: "/usr/bin/mybin", args: ["--config", "cfg.json"] },
    ...overrides,
  };
}

// ─── buildExternalDispatchArgv ────────────────────────────────────────────────

describe("buildExternalDispatchArgv", () => {
  test("basic structure without detach, no extra inputs", () => {
    const w = makeExternal();
    const argv = buildExternalDispatchArgv(w, {}, false, "deadbeef01234567deadbeef01234567");
    expect(argv).toEqual([
      "/usr/bin/mybin",
      "--config", "cfg.json",
      "_atomic-run",
      "--dispatch-token=deadbeef01234567deadbeef01234567",
      "--name", "my-ext",
      "--agent", "claude",
    ]);
  });

  test("includes --detach when detach=true", () => {
    const w = makeExternal();
    const argv = buildExternalDispatchArgv(w, {}, true, "aabbccdd00112233aabbccdd00112233");
    expect(argv).toContain("--detach");
    const detachIdx = argv.indexOf("--detach");
    // --detach appears after --agent
    const agentIdx = argv.indexOf("--agent");
    expect(detachIdx).toBeGreaterThan(agentIdx);
  });

  test("omits --detach when detach=false", () => {
    const w = makeExternal();
    const argv = buildExternalDispatchArgv(w, {}, false, "token");
    expect(argv).not.toContain("--detach");
  });

  test("appends cliInputs as --key value pairs", () => {
    const w = makeExternal();
    const argv = buildExternalDispatchArgv(
      w,
      { prompt: "hello world", max_loops: "3" },
      false,
      "token",
    );
    expect(argv).toContain("--prompt");
    expect(argv).toContain("hello world");
    expect(argv).toContain("--max_loops");
    expect(argv).toContain("3");
  });

  test("token appears in dispatch-token flag", () => {
    const w = makeExternal();
    const token = "cafebabe12345678cafebabe12345678";
    const argv = buildExternalDispatchArgv(w, {}, false, token);
    expect(argv).toContain(`--dispatch-token=${token}`);
  });

  test("command is first element", () => {
    const w = makeExternal({ source: { command: "/bin/sh", args: [] } });
    const argv = buildExternalDispatchArgv(w, {}, false, "tok");
    expect(argv[0]).toBe("/bin/sh");
  });

  test("source.args are spread before _atomic-run", () => {
    const w = makeExternal({ source: { command: "/bin/sh", args: ["arg1", "arg2"] } });
    const argv = buildExternalDispatchArgv(w, {}, false, "tok");
    const atomicRunIdx = argv.indexOf("_atomic-run");
    const arg1Idx = argv.indexOf("arg1");
    const arg2Idx = argv.indexOf("arg2");
    expect(arg1Idx).toBeLessThan(atomicRunIdx);
    expect(arg2Idx).toBeLessThan(atomicRunIdx);
  });

  test("full argv matches expected shape with all pieces", () => {
    const w = makeExternal({
      name: "wf",
      agent: "opencode",
      source: { command: "/bin/wf-runner", args: [] },
    });
    const argv = buildExternalDispatchArgv(w, { topic: "auth" }, true, "tok123");
    expect(argv).toEqual([
      "/bin/wf-runner",
      "_atomic-run",
      "--dispatch-token=tok123",
      "--name", "wf",
      "--agent", "opencode",
      "--detach",
      "--topic", "auth",
    ]);
  });
});

// ─── buildExternalDispatchEnv ─────────────────────────────────────────────────

describe("buildExternalDispatchEnv", () => {
  test("contains ATOMIC_HOST=1", () => {
    const env = buildExternalDispatchEnv("sometoken");
    expect(env["ATOMIC_HOST"]).toBe("1");
  });

  test("contains ATOMIC_DISPATCH_TOKEN matching the supplied token", () => {
    const token = "0011223344556677001122334455667a";
    const env = buildExternalDispatchEnv(token);
    expect(env["ATOMIC_DISPATCH_TOKEN"]).toBe(token);
  });

  test("argv token and env token match", () => {
    const w = makeExternal();
    const token = "ffffffffffffffffffffffffffffffff";
    const argv = buildExternalDispatchArgv(w, {}, false, token);
    const env = buildExternalDispatchEnv(token);
    // Token in argv is --dispatch-token=<token>
    const dispatchTokenArg = argv.find((a) => a.startsWith("--dispatch-token="));
    expect(dispatchTokenArg).toBe(`--dispatch-token=${env["ATOMIC_DISPATCH_TOKEN"]}`);
  });
});

// ─── Hard-block: activeBroken populated ───────────────────────────────────────

describe("hard-block on activeBroken", () => {
  beforeEach(() => {
    // Reset activeBroken to empty before each test to avoid cross-test pollution.
    rebuildWorkflowCommand(getActiveRegistry(), new Map());
  });

  test("action writes all three diagnostic lines to stderr and calls process.exit(2)", async () => {
    // Build a registry with a workflow we'll mark as broken.
    // Use an empty registry so allNames.length === 0, which lets Commander
    // skip the name-guard and reach the action (where the hard-block lives).
    const wf = defineWorkflow({
      name: "broken-wf",
      source: import.meta.path,
      inputs: [],
    })
      .for("claude")
      .run(async () => {})
      .compile();
    const registry = createRegistry().register(wf);

    const brokenEntry = {
      alias: "broken-wf",
      origin: "local" as const,
      agents: ["claude" as const],
      reason: "SyntaxError in source file",
      source: "/home/user/.config/atomic/settings.json",
      fix: "Check the syntax of your workflow file",
    };

    const brokenMap = new Map([["claude/broken-wf", brokenEntry]]);
    // Set module-level activeBroken so the action reads it lazily.
    rebuildWorkflowCommand(registry, brokenMap);

    // Build a fresh cmd with an EMPTY registry so allNames.length === 0
    // and Commander skips the name-guard entirely, allowing the action to run.
    const cmd = buildWorkflowCommand(createRegistry());
    cmd.exitOverride();

    // Capture stderr.
    let captured = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stderr.write;

    // Intercept process.exit.
    let exitCode: number | undefined;
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code as number;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    let threw = false;
    try {
      await cmd.parseAsync(["node", "cli", "-n", "broken-wf", "-a", "claude"]);
    } catch {
      threw = true;
    } finally {
      process.stderr.write = origWrite;
      process.exit = origExit;
    }

    expect(threw).toBe(true);
    expect(exitCode).toBe(2);
    expect(captured).toContain("reason ·");
    expect(captured).toContain("source ·");
    expect(captured).toContain("fix    ·");
    expect(captured).toContain("SyntaxError in source file");
    expect(captured).toContain("/home/user/.config/atomic/settings.json");
    expect(captured).toContain("Check the syntax of your workflow file");
  });
});

// ─── rebuildWorkflowCommand re-syncs dynamic options ─────────────────────────

describe("rebuildWorkflowCommand", () => {
  test("adds new dynamic options from fresh registry", async () => {
    const { workflowCommand } = await import("./workflow.ts");
    const { createBuiltinRegistry } = await import("../builtin-registry.ts");

    // Build registry with a workflow that has a unique input.
    const wf = defineWorkflow({
      name: "new-workflow",
      source: import.meta.path,
      inputs: [{ name: "custom-option", type: "text", required: false }],
    })
      .for("claude")
      .run(async () => {})
      .compile();

    const registry = createBuiltinRegistry().upsert(wf);
    rebuildWorkflowCommand(registry, new Map());

    const hasCustomOption = workflowCommand.options.some(
      (o) => o.long === "--custom-option",
    );
    expect(hasCustomOption).toBe(true);
  });

  test("getActiveRegistry returns the updated registry", async () => {
    const { createBuiltinRegistry } = await import("../builtin-registry.ts");
    const freshRegistry = createBuiltinRegistry();
    rebuildWorkflowCommand(freshRegistry, new Map());
    expect(getActiveRegistry()).toBe(freshRegistry);
  });

  test("getActiveBroken returns the updated broken map", () => {
    const brokenMap = new Map([
      ["claude/test-wf", {
        alias: "test-wf",
        origin: "local" as const,
        agents: ["claude" as const],
        reason: "test reason",
        source: "test.json",
        fix: "test fix",
      }],
    ]);
    rebuildWorkflowCommand(getActiveRegistry(), brokenMap);
    expect(getActiveBroken()).toBe(brokenMap);
  });
});

// ─── dispatch() return type is Promise<void> ─────────────────────────────────

describe("dispatch() type annotation", () => {
  test("dispatch signature is compatible with () => Promise<void>", () => {
    // This is a compile-time assertion. If dispatch returned Promise<never>
    // (as the old throw branch did), TypeScript would reject the assignment.
    const _: (
      workflow: Parameters<typeof dispatch>[0],
      inputs: Parameters<typeof dispatch>[1],
      detach: Parameters<typeof dispatch>[2],
    ) => Promise<void> = dispatch;
    expect(_).toBeDefined();
  });
});
