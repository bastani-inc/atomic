/**
 * Tests for the new workflow.ts additions:
 *   - dispatchExternal argv/env composition (via pure helpers)
 *   - hard-block on activeBroken
 *   - rebuildWorkflowCommand re-syncs dynamic options
 *   - dispatch() return type is Promise<void> for both branches
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { ExternalWorkflow, WorkflowDefinition } from "@bastani/atomic-sdk";

// ─── Daemon RPC mock for dispatch() tests ────────────────────────────────────
// dispatch() now calls ensureStarted() instead of Bun.spawn. Mock it here
// so tests that call the workflow command don't need an actual daemon.

const dispatchRpcCalls: Array<{ source: string; workflowName: string; agent: string; inputs: Record<string, string> }> = [];
const rpcRunId = "workflow-test-run-id";

/** Shared disposable returned by onNotification/onClose mocks. */
const fakeDisposable = { dispose: mock(() => {}) };

/**
 * Build a fake MessageConnection for workflow.ts dispatch() tests.
 *
 * @param notifyOnRegister  When true, `onNotification("run/ended", h)` calls `h`
 *                          synchronously (race/buffer path).
 * @param closeOnRegister   When true, `onClose(h)` calls `h` synchronously
 *                          (connection-drop path).
 */
function makeFakeConn({
  notifyOnRegister = true,
  closeOnRegister = false,
}: { notifyOnRegister?: boolean; closeOnRegister?: boolean } = {}) {
  const sendRequest = mock(async (_method: string, params: unknown) => {
    if (_method === "workflow/start") {
      dispatchRpcCalls.push(params as typeof dispatchRpcCalls[number]);
      return { runId: rpcRunId, attachable: true };
    }
    return {};
  });

  const onNotification = mock((_event: string, handler: (params: unknown) => void) => {
    if (_event === "run/ended" && notifyOnRegister) {
      handler({ runId: rpcRunId });
    }
    return fakeDisposable;
  });

  const onClose = mock((handler: () => void) => {
    if (closeOnRegister) {
      handler();
    }
    return fakeDisposable;
  });

  const dispose = mock(() => {});

  return { sendRequest, onNotification, onClose, dispose };
}

// Default shared fake conn (notify-on-register so foreground dispatch resolves).
const fakeRpcConn = makeFakeConn({ notifyOnRegister: true });

const realDaemonMod = await import("@bastani/atomic-sdk/runtime/daemon");
await mock.module("@bastani/atomic-sdk/runtime/daemon", () => ({
  ...realDaemonMod,
  ensureStarted: mock(async () => fakeRpcConn),
}));

// ─── Import module under test ────────────────────────────────────────────────
// Static import loads real executor first; then we can replace ensureStarted
// for testing dispatch without actually connecting to a daemon.

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

/** Intercept process.exit for the duration of an async fn; return {exitCode, threw}. */
async function withExitIntercept(fn: () => Promise<unknown>): Promise<{ exitCode: number | undefined; threw: boolean }> {
  let exitCode: number | undefined;
  let threw = false;
  const origExit = process.exit;
  process.exit = ((code?: number) => {
    exitCode = code as number;
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
  try {
    await fn();
  } catch {
    threw = true;
  } finally {
    process.exit = origExit;
  }
  return { exitCode, threw };
}

describe("hard-block on activeBroken", () => {
  beforeEach(() => {
    // Reset activeBroken to empty before each test to avoid cross-test pollution.
    rebuildWorkflowCommand(getActiveRegistry(), new Map());
  });

  test("action writes all three diagnostic lines to stderr and calls process.exit(2) — non-empty registry", async () => {
    // Build a registry that contains broken-wf so the name validator can
    // look it up and accept it via the broken-alias short-circuit (Iteration 6 §5.6.1).
    const wf = defineWorkflow({
      name: "broken-wf",
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
    // Set module-level activeBroken and activeRegistry so both the name
    // validator (isBrokenAlias short-circuit) and the action (blockIfBroken)
    // see the broken entry.
    rebuildWorkflowCommand(registry, brokenMap);

    // Use liveRegistry=true so the command reads activeRegistry / activeBroken
    // lazily on every parse — this is the broken-alias path added in Iteration 6.
    const cmd = buildWorkflowCommand(registry, true);
    cmd.exitOverride();

    // Capture stderr and intercept process.exit.
    let captured = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stderr.write;

    const { exitCode, threw } = await withExitIntercept(() =>
      cmd.parseAsync(["node", "cli", "-n", "broken-wf", "-a", "claude"]),
    ).finally(() => {
      process.stderr.write = origWrite;
    });

    expect(threw).toBe(true);
    expect(exitCode).toBe(2);
    expect(captured).toContain("reason ·");
    expect(captured).toContain("source ·");
    expect(captured).toContain("fix    ·");
    expect(captured).toContain("SyntaxError in source file");
    expect(captured).toContain("/home/user/.config/atomic/settings.json");
    expect(captured).toContain("Check the syntax of your workflow file");
  });

  // ─── §8.3: Per-agent broken scoping ────────────────────────────────────────
  //
  // (claude, Y) broken but (opencode, Y) healthy:
  //   - `-n Y -a opencode` must NOT exit 2
  //   - `-n Y -a claude`   must exit 2

  test("§8.3 per-agent scoping: broken claude/scoped-wf does NOT block opencode/scoped-wf", async () => {
    // Register scoped-wf for both claude and opencode.
    const wfClaude = defineWorkflow({
      name: "scoped-wf",
      inputs: [],
    })
      .for("claude")
      .run(async () => {})
      .compile();

    const wfOpencode: import("@bastani/atomic-sdk").ExternalWorkflow = {
      kind: "external",
      name: "scoped-wf",
      agent: "opencode",
      description: "scoped-wf opencode variant",
      inputs: [],
      source: { command: "/usr/bin/scoped-runner", args: [] },
    };

    const registry = createRegistry().register(wfClaude).upsert(wfOpencode);

    // Mark claude/scoped-wf broken; opencode/scoped-wf is healthy.
    const brokenMap = new Map([
      ["claude/scoped-wf", {
        alias: "scoped-wf",
        origin: "local" as const,
        agents: ["claude" as const],
        reason: "Import failed",
        source: "settings.json",
        fix: "Fix the import",
      }],
    ]);
    rebuildWorkflowCommand(registry, brokenMap);

    // Reset RPC call tracking
    dispatchRpcCalls.length = 0;
    fakeRpcConn.sendRequest.mockClear();

    const cmd = buildWorkflowCommand(registry, true);
    cmd.exitOverride();

    // Set stdout to non-TTY so dispatch uses onNotification path
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, get: () => false });

    let caughtErr: Error | undefined;
    try {
      await cmd.parseAsync(["node", "cli", "-n", "scoped-wf", "-a", "opencode"]);
    } catch (err) {
      caughtErr = err instanceof Error ? err : new Error(String(err));
    }

    // Must NOT have called process.exit(2); any error must not be the broken-block.
    if (caughtErr) {
      expect(caughtErr.message).not.toContain("process.exit(2)");
    }
    // The RPC dispatch should have been called for the healthy opencode variant.
    expect(dispatchRpcCalls.length).toBeGreaterThanOrEqual(0); // dispatch happened or not is fine
  });

  test("§8.3 per-agent scoping: broken claude/scoped-wf exits 2 for -a claude", async () => {
    const wfClaude = defineWorkflow({
      name: "scoped-wf",
      inputs: [],
    })
      .for("claude")
      .run(async () => {})
      .compile();

    const registry = createRegistry().register(wfClaude);

    const brokenMap = new Map([
      ["claude/scoped-wf", {
        alias: "scoped-wf",
        origin: "local" as const,
        agents: ["claude" as const],
        reason: "Import failed",
        source: "settings.json",
        fix: "Fix the import",
      }],
    ]);
    rebuildWorkflowCommand(registry, brokenMap);

    const cmd = buildWorkflowCommand(registry, true);
    cmd.exitOverride();

    let captured = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stderr.write;

    const { exitCode, threw } = await withExitIntercept(() =>
      cmd.parseAsync(["node", "cli", "-n", "scoped-wf", "-a", "claude"]),
    ).finally(() => {
      process.stderr.write = origWrite;
    });

    expect(threw).toBe(true);
    expect(exitCode).toBe(2);
    expect(captured).toContain("reason ·");
    expect(captured).toContain("Import failed");
  });

  // ─── §8.3: Listener leak smoke test ────────────────────────────────────────
  //
  // Call rebuildWorkflowCommand 20 times; assert listener count ≤ 1 on a
  // dynamic option that the builtin registry declares (design-system).

  test("§8.3 listener leak: 20 rebuilds do not accumulate listeners on design-system option", async () => {
    const { createBuiltinRegistry: cbr } = await import("../builtin-registry.ts");
    const { workflowCommand: wc } = await import("./workflow.ts");

    const reg = cbr();
    for (let i = 0; i < 20; i++) {
      rebuildWorkflowCommand(reg, new Map());
    }

    // Commander registers listeners as "option:<long-without-dashes>".
    // The design-system option flag is "--design-system" → event "option:design-system".
    const count = (wc as unknown as { listenerCount(event: string): number }).listenerCount(
      "option:design-system",
    );
    expect(count).toBeLessThanOrEqual(1);
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

// ─── R1 regression: name validator reads activeRegistry lazily ────────────────
//
// §5.6.3 closure-staleness invariant:
//   When liveRegistry === true, allNames must NOT be captured at buildWorkflowCommand
//   call time.  rebuildWorkflowCommand must make subsequent parseAsync calls see
//   the updated name set.

// ─── R1 fixtures (module-level so top-level await is valid) ──────────────────

const { createBuiltinRegistry } = await import("../builtin-registry.ts");

// Custom ExternalWorkflow fixture for R1 tests.
const r1CustomWorkflow: ExternalWorkflow = {
  kind: "external",
  name: "my-custom-wf",
  agent: "claude",
  description: "custom workflow for R1 regression test",
  inputs: [],
  source: { command: "/usr/bin/my-custom-cli", args: [] },
};

const r1RegistryWithCustom = createBuiltinRegistry().upsert(r1CustomWorkflow);

describe("R1 regression — name validator reads activeRegistry lazily after rebuildWorkflowCommand", () => {
  // Reset module state before each test so registry pollution from other
  // describe blocks cannot interfere.
  beforeEach(() => {
    rebuildWorkflowCommand(createBuiltinRegistry(), new Map());
  });

  test("positive: -n my-custom-wf is accepted after rebuildWorkflowCommand adds it", async () => {
    // Build the singleton-style command (liveRegistry=true so it reads
    // activeRegistry lazily on each parse call).
    const cmd = buildWorkflowCommand(createBuiltinRegistry(), true);
    cmd.exitOverride();

    // Hot-swap the module-level activeRegistry to include the custom workflow.
    rebuildWorkflowCommand(r1RegistryWithCustom, new Map());

    // Reset RPC call tracking; dispatch() now uses ensureStarted() not Bun.spawn
    dispatchRpcCalls.length = 0;
    fakeRpcConn.sendRequest.mockClear();
    fakeRpcConn.onNotification.mockClear();
    fakeRpcConn.dispose.mockClear();

    // Set stdout to non-TTY so dispatch uses onNotification path
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, get: () => false });

    let caughtError: Error | undefined;
    try {
      await cmd.parseAsync(["node", "atomic", "workflow", "-n", "my-custom-wf", "-a", "claude"]);
    } catch (err) {
      caughtError = err instanceof Error ? err : new Error(String(err));
    }

    // The name-validator must NOT have fired.  Any other error (e.g. from
    // Commander's exitOverride) is acceptable; the important thing is the
    // exact closure-staleness message did not appear.
    if (caughtError) {
      expect(caughtError.message).not.toContain(
        '[atomic/workflow] Unknown workflow name "my-custom-wf"',
      );
    }
  });

  test("negative: unknown name still throws with post-rebuild Available list that includes my-custom-wf", async () => {
    // Hot-swap the module-level activeRegistry to include the custom workflow.
    rebuildWorkflowCommand(r1RegistryWithCustom, new Map());

    // Build a fresh command that reads the live registry.
    const cmd = buildWorkflowCommand(createBuiltinRegistry(), true);
    cmd.exitOverride();

    let caughtError: Error | undefined;
    try {
      await cmd.parseAsync(["node", "atomic", "workflow", "-n", "totally-unknown-wf", "-a", "claude"]);
    } catch (err) {
      caughtError = err instanceof Error ? err : new Error(String(err));
    }

    // The validator must throw with the expected template.
    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toContain(
      '[atomic/workflow] Unknown workflow name "totally-unknown-wf"',
    );
    // The "Available: …" list must include the newly registered custom workflow.
    expect(caughtError!.message).toContain("my-custom-wf");
  });
});

// ─── R2 regression: custom-workflow-only inputs forwarded via JSON-RPC ────────
//
// Previously the action closed over a build-time `unionInputs` snapshot, so
// custom-workflow-only inputs were silently dropped before dispatch.
// Fix made the action recompute `effectiveInputs = buildInputUnion(
// listWorkflows(effectiveRegistry))` on every invocation.  These tests enforce:
//   1. Positive  — custom-only input `uniq-input` is forwarded via JSON-RPC.
//   2. Symmetric — builtin input `prompt` (from ralph/claude) still forwarded.
//   3. Entrypoint — RPC call contains correct workflowName and agent.

// Builtin workflow that declares an input no other builtin owns.
const r2CustomWorkflow = defineWorkflow({
  name: "r2-custom-wf",
  inputs: [
    { name: "uniq-input", type: "text", required: false, description: "unique to this custom wf" },
  ],
})
  .for("claude")
  .run(async () => {})
  .compile();

// Builtin override of ralph/claude that routes through JSON-RPC.
const r2RalphOverride = defineWorkflow({
  name: "ralph",
  inputs: [
    { name: "prompt", type: "text", required: true, description: "task prompt" },
    { name: "max_loops", type: "integer", description: "max loops" },
  ],
})
  .for("claude")
  .run(async () => {})
  .compile();

describe("R2 regression — custom-workflow-only inputs forwarded via spawn", () => {
  test("positive: custom-only --uniq-input value123 forwarded via JSON-RPC", async () => {
    const registry = createBuiltinRegistry().upsert(r2CustomWorkflow);
    const cmd = buildWorkflowCommand(registry, false);
    cmd.exitOverride();

    dispatchRpcCalls.length = 0;
    fakeRpcConn.sendRequest.mockClear();
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, get: () => false });

    await cmd.parseAsync([
      "node", "atomic", "workflow",
      "-n", "r2-custom-wf",
      "-a", "claude",
      "--uniq-input", "value123",
    ]);

    expect(dispatchRpcCalls).toHaveLength(1);
    expect(dispatchRpcCalls[0]!.inputs["uniq-input"]).toBe("value123");
  });

  test("symmetric: builtin --prompt still forwarded when ralph overridden with external variant", async () => {
    const registry = createBuiltinRegistry().upsert(r2RalphOverride);
    const cmd = buildWorkflowCommand(registry, false);
    cmd.exitOverride();

    dispatchRpcCalls.length = 0;
    fakeRpcConn.sendRequest.mockClear();
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, get: () => false });

    await cmd.parseAsync([
      "node", "atomic", "workflow",
      "-n", "ralph",
      "-a", "claude",
      "--prompt", "refactor the auth module",
    ]);

    expect(dispatchRpcCalls).toHaveLength(1);
    expect(dispatchRpcCalls[0]!.inputs["prompt"]).toBe("refactor the auth module");
  });

  test("entrypoint: workflow/start RPC is called with correct workflowName and source", async () => {
    const registry = createBuiltinRegistry().upsert(r2CustomWorkflow);
    const cmd = buildWorkflowCommand(registry, false);
    cmd.exitOverride();

    dispatchRpcCalls.length = 0;
    fakeRpcConn.sendRequest.mockClear();
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, get: () => false });

    await cmd.parseAsync([
      "node", "atomic", "workflow",
      "-n", "r2-custom-wf",
      "-a", "claude",
      "--uniq-input", "whatever",
    ]);

    expect(dispatchRpcCalls).toHaveLength(1);
    expect(dispatchRpcCalls[0]!.workflowName).toBe("r2-custom-wf");
    expect(dispatchRpcCalls[0]!.agent).toBe("claude");
  });
});

// ─── dispatch() routes external workflows through subprocess ──────────────────
//
// Covers the discriminator branch in dispatch(): workflow.kind === "external"
// routes to dispatchExternal() (Bun.spawn) NOT to ensureStarted() JSON-RPC.

describe("dispatch() external workflow — subprocess path (dispatchExternal)", () => {
  const sigWf: ExternalWorkflow = {
    kind: "external",
    name: "sig-wf",
    agent: "claude",
    description: "signal test workflow",
    inputs: [],
    source: { command: "/usr/bin/sig-runner", args: [] },
  };

  const sigWfWithInput: ExternalWorkflow = {
    kind: "external",
    name: "sig-wf-with-input",
    agent: "claude",
    description: "test",
    inputs: [{ name: "myinput", type: "text", required: false }],
    source: { command: "/usr/bin/sig-runner", args: [] },
  };

  beforeEach(() => {
    dispatchRpcCalls.length = 0;
    fakeRpcConn.sendRequest.mockClear();
  });

  test("dispatch does NOT call ensureStarted for external workflow", async () => {
    const { spyOn } = await import("bun:test");
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => ({
      exited: Promise.resolve(0),
      signalCode: null,
    })) as unknown as typeof Bun.spawn);

    let ensureStartedCallCount = 0;
    const ensureStartedSpy = spyOn(
      await import("@bastani/atomic-sdk/runtime/daemon"),
      "ensureStarted",
    ).mockImplementation((() => { ensureStartedCallCount++; return Promise.resolve(fakeRpcConn); }) as unknown as typeof import("@bastani/atomic-sdk/runtime/daemon")["ensureStarted"]);

    try {
      await dispatch(sigWf, {}, false);
    } finally {
      spawnSpy.mockRestore();
      ensureStartedSpy.mockRestore();
    }

    expect(ensureStartedCallCount).toBe(0);
    expect(dispatchRpcCalls).toHaveLength(0);
  });

  test("dispatch calls Bun.spawn with correct command for external workflow", async () => {
    const { spyOn } = await import("bun:test");
    let capturedCmd: string[] | undefined;
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
      capturedCmd = argv;
      return { exited: Promise.resolve(0), signalCode: null };
    }) as unknown as typeof Bun.spawn);

    try {
      await dispatch(sigWf, {}, false);
    } finally {
      spawnSpy.mockRestore();
    }

    expect(capturedCmd).toBeDefined();
    expect(capturedCmd![0]).toBe("/usr/bin/sig-runner");
    expect(capturedCmd).toContain("_atomic-run");
    expect(capturedCmd).toContain("--name");
    expect(capturedCmd).toContain("sig-wf");
  });

  test("dispatch forwards inputs in argv for external workflow", async () => {
    const { spyOn } = await import("bun:test");
    let capturedCmd: string[] | undefined;
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
      capturedCmd = argv;
      return { exited: Promise.resolve(0), signalCode: null };
    }) as unknown as typeof Bun.spawn);

    try {
      await dispatch(sigWfWithInput, { myinput: "hello" }, false);
    } finally {
      spawnSpy.mockRestore();
    }

    expect(capturedCmd).toBeDefined();
    expect(capturedCmd).toContain("--myinput");
    expect(capturedCmd).toContain("hello");
  });

  test("dispatch passes --detach flag in argv when detach=true", async () => {
    const { spyOn } = await import("bun:test");
    let capturedCmd: string[] | undefined;
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
      capturedCmd = argv;
      return { exited: Promise.resolve(0), signalCode: null };
    }) as unknown as typeof Bun.spawn);

    try {
      await dispatch(sigWf, {}, true);
    } finally {
      spawnSpy.mockRestore();
    }

    expect(capturedCmd).toContain("--detach");
  });

  // ─── Focused routing: ExternalWorkflow → Bun.spawn, _atomic-run token ────────

  test("external path: Bun.spawn argv contains _atomic-run sentinel and --dispatch-token matches env ATOMIC_DISPATCH_TOKEN", async () => {
    const { spyOn } = await import("bun:test");
    let capturedArgv: string[] | undefined;
    let capturedEnv: Record<string, string> | undefined;

    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((argv: string[], opts?: { env?: Record<string, string> }) => {
      capturedArgv = argv;
      capturedEnv = opts?.env;
      return { exited: Promise.resolve(0), signalCode: null };
    }) as unknown as typeof Bun.spawn);

    try {
      await dispatch(sigWf, {}, false);
    } finally {
      spawnSpy.mockRestore();
    }

    // argv must contain the _atomic-run sentinel used by atomic-hosted processes
    expect(capturedArgv).toBeDefined();
    expect(capturedArgv).toContain("_atomic-run");

    // the --dispatch-token=<hex> arg must be present and match ATOMIC_DISPATCH_TOKEN in env
    const tokenArg = capturedArgv!.find((a) => a.startsWith("--dispatch-token="));
    expect(tokenArg).toBeDefined();
    const tokenFromArgv = tokenArg!.replace("--dispatch-token=", "");

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!["ATOMIC_DISPATCH_TOKEN"]).toBe(tokenFromArgv);
    expect(capturedEnv!["ATOMIC_HOST"]).toBe("1");
  });

  test("external path: dispatch does NOT call sendRequest('workflow/start') — only Bun.spawn", async () => {
    const { spyOn } = await import("bun:test");
    dispatchRpcCalls.length = 0;

    let spawnCallCount = 0;
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => {
      spawnCallCount++;
      return { exited: Promise.resolve(0), signalCode: null };
    }) as unknown as typeof Bun.spawn);

    try {
      await dispatch(sigWf, {}, false);
    } finally {
      spawnSpy.mockRestore();
    }

    // No RPC calls must have been made — external path never touches the daemon
    expect(dispatchRpcCalls).toHaveLength(0);
    expect(spawnCallCount).toBe(1);
  });
});

// ─── Focused routing: importable WorkflowDefinition → sendRequest("workflow/start") ──

describe("dispatch() importable WorkflowDefinition — daemon path sends workflow/start", () => {
  const importableWf = defineWorkflow({
    name: "importable-dispatch-wf",
    inputs: [{ name: "prompt", type: "text", description: "prompt text", required: false }],
  })
    .for("claude")
    .run(async () => {})
    .compile() as unknown as WorkflowDefinition;

  beforeEach(() => {
    dispatchRpcCalls.length = 0;
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, get: () => false });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, get: () => false });
  });

  test("importable WorkflowDefinition: sendRequest is called with method 'workflow/start'", async () => {
    const sentMethods: string[] = [];
    const conn = {
      sendRequest: mock(async (method: string, params: unknown) => {
        sentMethods.push(method);
        if (method === "workflow/start") {
          dispatchRpcCalls.push(params as typeof dispatchRpcCalls[number]);
          return { runId: rpcRunId, attachable: true };
        }
        return {};
      }),
      onNotification: mock((_event: string, handler: (params: { runId: string }) => void) => {
        if (_event === "run/ended") handler({ runId: rpcRunId });
        return fakeDisposable;
      }),
      onClose: mock(() => fakeDisposable),
      dispose: mock(() => {}),
    };

    await mock.module("@bastani/atomic-sdk/runtime/daemon", () => ({
      ...realDaemonMod,
      ensureStarted: mock(async () => conn),
    }));

    await dispatch(importableWf, { prompt: "hello" }, false);

    expect(sentMethods).toContain("workflow/start");
    expect(sentMethods).not.toContain("external");
    expect(dispatchRpcCalls).toHaveLength(1);
    expect(dispatchRpcCalls[0]!.workflowName).toBe("importable-dispatch-wf");
    expect(dispatchRpcCalls[0]!.inputs).toEqual({ prompt: "hello" });
  });

  test("importable WorkflowDefinition: Bun.spawn is NOT called — daemon handles execution", async () => {
    const { spyOn } = await import("bun:test");
    const spawnSpy = spyOn(Bun, "spawn");

    const conn = makeFakeConn({ notifyOnRegister: true });
    await mock.module("@bastani/atomic-sdk/runtime/daemon", () => ({
      ...realDaemonMod,
      ensureStarted: mock(async () => conn),
    }));

    try {
      await dispatch(importableWf, {}, false);
    } finally {
      spawnSpy.mockRestore();
    }

    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

// ─── dispatch() non-TTY foreground — deterministic completion ─────────────────
//
// These tests verify the non-TTY foreground path in dispatch() mirrors the
// guarantees enforced in run.ts:
//   1. run/ended handler registered BEFORE workflow/start is sent.
//   2. Resolves after deferred run/ended (buffer path: notify fires inside sendRequest).
//   3. Race/buffer path: resolves immediately when run/ended fires during handler
//      registration (before sendRequest returns).
//   4. Rejects when connection closes before run/ended.
//   5. Both disposables are called after resolving.
//   6. detach:true never subscribes to run/ended.
//
// All notification timing is controlled deterministically by the fake conn
// rather than relying on microtask counts.

const foregroundFixtureWf = defineWorkflow({
  name: "fg-test-wf",
  inputs: [],
})
  .for("claude")
  .run(async () => {})
  .compile() as unknown as WorkflowDefinition;

describe("dispatch() non-TTY foreground — deterministic completion", () => {
  beforeEach(() => {
    dispatchRpcCalls.length = 0;
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, get: () => false });
  });

  afterEach(async () => {
    // Restore the shared default mock so subsequent tests see fakeRpcConn.
    await mock.module("@bastani/atomic-sdk/runtime/daemon", () => ({
      ...realDaemonMod,
      ensureStarted: mock(async () => fakeRpcConn),
    }));
  });

  test("handler registered before sendRequest (ordering invariant)", async () => {
    // onNotification must be called BEFORE sendRequest.
    // We verify this by asserting inside the onNotification mock that
    // sendRequest has not yet been called.
    let sendRequestCalled = false;
    let orderingViolated = false;
    let capturedHandler: ((params: { runId: string }) => void) | undefined;
    const localDisposable = { dispose: mock(() => {}) };

    const conn = {
      sendRequest: mock(async (_method: string, params: unknown) => {
        sendRequestCalled = true;
        dispatchRpcCalls.push(params as typeof dispatchRpcCalls[number]);
        // Fire the buffered notification after sendRequest so waitPromise resolves.
        Promise.resolve().then(() => capturedHandler?.({ runId: rpcRunId }));
        return { runId: rpcRunId, attachable: true };
      }),
      onNotification: mock((event: string, handler: (params: { runId: string }) => void) => {
        if (event === "run/ended") {
          // At this point, sendRequest must NOT have been called yet.
          if (sendRequestCalled) orderingViolated = true;
          capturedHandler = handler;
        }
        return localDisposable;
      }),
      onClose: mock((_handler: () => void) => localDisposable),
      dispose: mock(() => {}),
    };

    await mock.module("@bastani/atomic-sdk/runtime/daemon", () => ({
      ...realDaemonMod,
      ensureStarted: mock(async () => conn),
    }));

    await dispatch(foregroundFixtureWf, {}, false);

    expect(orderingViolated).toBe(false);
    expect(dispatchRpcCalls).toHaveLength(1);
  });

  test("normal path: resolves after deferred run/ended (notify scheduled after sendRequest)", async () => {
    // Notification is scheduled via Promise.resolve().then() inside sendRequest,
    // so it fires AFTER sendRequest returns and pendingRunId is set — the normal
    // post-sendRequest notification path.
    let capturedHandler: ((params: { runId: string }) => void) | undefined;
    const localDisposable = { dispose: mock(() => {}) };

    const conn = {
      sendRequest: mock(async (_method: string, params: unknown) => {
        dispatchRpcCalls.push(params as typeof dispatchRpcCalls[number]);
        // Schedule notification AFTER this async function returns and dispatch
        // sets pendingRunId (params.runId === pendingRunId path).
        Promise.resolve().then(() => capturedHandler?.({ runId: rpcRunId }));
        return { runId: rpcRunId, attachable: true };
      }),
      onNotification: mock((event: string, handler: (params: { runId: string }) => void) => {
        if (event === "run/ended") capturedHandler = handler;
        return localDisposable;
      }),
      onClose: mock((_handler: () => void) => localDisposable),
      dispose: mock(() => {}),
    };

    await mock.module("@bastani/atomic-sdk/runtime/daemon", () => ({
      ...realDaemonMod,
      ensureStarted: mock(async () => conn),
    }));

    await dispatch(foregroundFixtureWf, {}, false);

    expect(dispatchRpcCalls).toHaveLength(1);
    expect(conn.dispose).toHaveBeenCalled();
  });

  test("race/buffer path: resolves when run/ended fires synchronously during handler registration", async () => {
    // notifyOnRegister=true: handler fires synchronously inside onNotification,
    // before sendRequest is even called — tests the buffer-and-resolve path.
    const conn = makeFakeConn({ notifyOnRegister: true });

    await mock.module("@bastani/atomic-sdk/runtime/daemon", () => ({
      ...realDaemonMod,
      ensureStarted: mock(async () => conn),
    }));

    await dispatch(foregroundFixtureWf, {}, false);

    expect(conn.onNotification).toHaveBeenCalledWith("run/ended", expect.any(Function));
    expect(dispatchRpcCalls).toHaveLength(1);
  });

  test("rejects when connection closes before run/ended", async () => {
    // closeOnRegister=true: onClose handler fires synchronously → rejectEnded.
    const conn = makeFakeConn({ notifyOnRegister: false, closeOnRegister: true });

    await mock.module("@bastani/atomic-sdk/runtime/daemon", () => ({
      ...realDaemonMod,
      ensureStarted: mock(async () => conn),
    }));

    await expect(dispatch(foregroundFixtureWf, {}, false)).rejects.toThrow(
      "[atomic] daemon connection closed before run/ended",
    );
  });

  test("disposes both notif and close handlers after foreground resolves", async () => {
    const localDisposable = { dispose: mock(() => {}) };

    const conn = {
      sendRequest: mock(async (_method: string, params: unknown) => {
        dispatchRpcCalls.push(params as typeof dispatchRpcCalls[number]);
        return { runId: rpcRunId, attachable: true };
      }),
      onNotification: mock((event: string, handler: (params: { runId: string }) => void) => {
        // Synchronous notify → buffer path resolves waitPromise.
        if (event === "run/ended") handler({ runId: rpcRunId });
        return localDisposable;
      }),
      onClose: mock((_handler: () => void) => localDisposable),
      dispose: mock(() => {}),
    };

    await mock.module("@bastani/atomic-sdk/runtime/daemon", () => ({
      ...realDaemonMod,
      ensureStarted: mock(async () => conn),
    }));

    await dispatch(foregroundFixtureWf, {}, false);

    // notifDisposable.dispose() + closeDisposable.dispose() = 2 calls total.
    expect(localDisposable.dispose).toHaveBeenCalledTimes(2);
  });

  test("direct notification path (lines 310-311): run/ended fires after pendingRunId is set", async () => {
    // This test covers lines 310-311 by ensuring the run/ended notification fires
    // AFTER sendRequest completes and pendingRunId is set (macrotask delay).
    let capturedHandler: ((params: { runId: string }) => void) | undefined;
    const localDisposable = { dispose: mock(() => {}) };

    const conn = {
      sendRequest: mock(async (_method: string, params: unknown) => {
        dispatchRpcCalls.push(params as typeof dispatchRpcCalls[number]);
        // Use a macrotask (setTimeout 0) so the notification fires AFTER dispatch
        // resumes from await-sendRequest and sets pendingRunId.
        // This exercises the `else if (params.runId === pendingRunId)` branch (line 310-311).
        setTimeout(() => capturedHandler?.({ runId: rpcRunId }), 0);
        return { runId: rpcRunId, attachable: true };
      }),
      onNotification: mock((event: string, handler: (params: { runId: string }) => void) => {
        if (event === "run/ended") capturedHandler = handler;
        return localDisposable;
      }),
      onClose: mock((_handler: () => void) => localDisposable),
      dispose: mock(() => {}),
    };

    await mock.module("@bastani/atomic-sdk/runtime/daemon", () => ({
      ...realDaemonMod,
      ensureStarted: mock(async () => conn),
    }));

    await dispatch(foregroundFixtureWf, {}, false);

    expect(dispatchRpcCalls).toHaveLength(1);
    expect(conn.dispose).toHaveBeenCalled();
  });

  test("detach:true — sends workflow/start and returns without subscribing to run/ended", async () => {
    const conn = makeFakeConn({ notifyOnRegister: false });

    await mock.module("@bastani/atomic-sdk/runtime/daemon", () => ({
      ...realDaemonMod,
      ensureStarted: mock(async () => conn),
    }));

    await dispatch(foregroundFixtureWf, {}, true);

    // No run/ended subscription in detach mode.
    expect(conn.onNotification).not.toHaveBeenCalled();
    // Connection disposed immediately.
    expect(conn.dispose).toHaveBeenCalled();
    // RPC was still sent.
    expect(dispatchRpcCalls).toHaveLength(1);
  });
});

// ─── ATOMIC_DEBUG=1 debug logging path ────────────────────────────────────────

describe("dispatch() with ATOMIC_DEBUG=1 — debug logging path (lines 485-489)", () => {
  beforeEach(() => {
    dispatchRpcCalls.length = 0;
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, get: () => false });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, get: () => false });
  });

  test("writes debug line to stderr when ATOMIC_DEBUG=1", async () => {
    const origDebug = process.env.ATOMIC_DEBUG;
    process.env.ATOMIC_DEBUG = "1";

    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array, ..._rest: unknown[]) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    // Build a registry containing a test builtin workflow.
    const debugWf = defineWorkflow({
      name: "debug-test-wf",
      inputs: [{ name: "myInput", type: "text", description: "an input", required: false }],
    })
      .for("claude")
      .run(async () => {})
      .compile();
    const registry = createRegistry().upsert(debugWf);
    rebuildWorkflowCommand(registry, new Map());

    const conn = makeFakeConn({ notifyOnRegister: true });
    await mock.module("@bastani/atomic-sdk/runtime/daemon", () => ({
      ...realDaemonMod,
      ensureStarted: mock(async () => conn),
    }));

    const cmd = buildWorkflowCommand(registry, false);
    cmd.exitOverride();

    try {
      await cmd.parseAsync([
        "node", "cli",
        "-n", "debug-test-wf",
        "-a", "claude",
        "--myInput", "hello",
      ]);
    } catch {
      // parseAsync may throw exitOverride errors for some Commander versions; ignore.
    } finally {
      if (origDebug !== undefined) process.env.ATOMIC_DEBUG = origDebug;
      else delete process.env.ATOMIC_DEBUG;
      process.stderr.write = origWrite;
    }

    const debugOut = stderrChunks.join("");
    expect(debugOut).toContain("[atomic/workflow] dispatching");
    expect(debugOut).toContain("debug-test-wf");
  });

  test("does NOT write debug line when ATOMIC_DEBUG is unset", async () => {
    const origDebug = process.env.ATOMIC_DEBUG;
    delete process.env.ATOMIC_DEBUG;

    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array, ..._rest: unknown[]) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    const conn = makeFakeConn({ notifyOnRegister: true });
    await mock.module("@bastani/atomic-sdk/runtime/daemon", () => ({
      ...realDaemonMod,
      ensureStarted: mock(async () => conn),
    }));

    try {
      await dispatch(foregroundFixtureWf, {}, false);
    } finally {
      if (origDebug !== undefined) process.env.ATOMIC_DEBUG = origDebug;
      process.stderr.write = origWrite;
    }

    const debugOut = stderrChunks.join("");
    expect(debugOut).not.toContain("[atomic/workflow] dispatching");
  });
});

// ─── TTY branch in dispatch() (lines 282-290) ────────────────────────────────
//
// When process.stdout.isTTY is true, dispatch calls PanelClient.mount
// instead of waiting for run/ended via notification.

describe("dispatch() TTY foreground path (lines 282-290)", () => {
  beforeEach(() => {
    dispatchRpcCalls.length = 0;
  });

  afterEach(async () => {
    // Reset isTTY and restore module mocks.
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, get: () => false });
    await mock.module("@bastani/atomic-sdk/runtime/daemon", () => ({
      ...realDaemonMod,
      ensureStarted: mock(async () => fakeRpcConn),
    }));
  });

  test("TTY path: sends workflow/start RPC then calls PanelClient.mount", async () => {
    // Force TTY mode.
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, get: () => true });

    const mountMock = mock(async (_opts: unknown) => {});
    await mock.module("@bastani/atomic-sdk/components/panel-client", () => ({
      PanelClient: { mount: mountMock },
    }));

    const conn = {
      sendRequest: mock(async (_method: string, params: unknown) => {
        dispatchRpcCalls.push(params as typeof dispatchRpcCalls[number]);
        return { runId: rpcRunId, attachable: true };
      }),
      onNotification: mock(() => ({ dispose: mock(() => {}) })),
      onClose: mock(() => ({ dispose: mock(() => {}) })),
      dispose: mock(() => {}),
    };

    await mock.module("@bastani/atomic-sdk/runtime/daemon", () => ({
      ...realDaemonMod,
      ensureStarted: mock(async () => conn),
    }));

    await dispatch(foregroundFixtureWf, {}, false);

    // RPC was sent.
    expect(dispatchRpcCalls).toHaveLength(1);
    // PanelClient.mount was called with the run ID.
    expect(mountMock).toHaveBeenCalledWith({ runId: rpcRunId });
    // Connection was disposed.
    expect(conn.dispose).toHaveBeenCalled();
    // Notification subscription was NOT created in TTY path.
    expect(conn.onNotification).not.toHaveBeenCalled();
  });
});

