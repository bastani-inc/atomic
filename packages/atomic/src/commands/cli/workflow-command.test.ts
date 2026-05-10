/**
 * Tests for `workflowCommand` — the Commander Command returned by
 * `createWorkflowCli(createBuiltinRegistry()).command("workflow")`.
 *
 * Mocking strategy: mock.module("@bastani/atomic-sdk/runtime/daemon") replaces
 * ensureStarted with a spy BEFORE the dynamic import of workflow.ts.
 *
 * Module load order:
 *   1. Static imports execute first (hoisted by ES module semantics).
 *   2. `mock.module` replaces daemon/PanelClient for SUBSEQUENT imports.
 *   3. Dynamic import of workflow.ts uses the mocked modules.
 *
 * Commander error handling: `exitOverride()` is called on the command before
 * tests that expect rejection, converting process.exit(1) into a thrown Error.
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
// Static import — loads registry into module cache BEFORE mocks replace anything.
import "@bastani/atomic-sdk/registry";

// ─── Module-level mock ────────────────────────────────────────────────────────
// Track dispatch calls for assertions
const dispatchCalls: Array<{ source: string; workflowName: string; agent: string; inputs: Record<string, string> }> = [];
const mockRunId = "test-run-id";

/** Shared disposable for fakeConn subscriptions. */
const fakeConnDisposable = { dispose: mock(() => {}) };

const fakeConn = {
  sendRequest: mock(async (_method: string, params: unknown) => {
    if (_method === "workflow/start") {
      dispatchCalls.push(params as typeof dispatchCalls[number]);
      return { runId: mockRunId, attachable: true };
    }
    return {};
  }),
  onNotification: mock((_method: string, handler: (params: unknown) => void) => {
    // Immediately invoke with matching runId so dispatch() doesn't hang
    // (race/buffer path — notification arrives before sendRequest returns).
    if (_method === "run/ended") {
      handler({ runId: mockRunId });
    }
    return fakeConnDisposable;
  }),
  onClose: mock((_handler: () => void) => fakeConnDisposable),
  dispose: mock(() => {}),
};

// Mock daemon ensureStarted
const realDaemon = await import("@bastani/atomic-sdk/runtime/daemon");
await mock.module("@bastani/atomic-sdk/runtime/daemon", () => ({
  ...realDaemon,
  ensureStarted: mock(async () => fakeConn),
}));

// Mock PanelClient.mount
const realPanelClient = await import("@bastani/atomic-sdk/components/panel-client");
const panelMountMock = mock(async () => {});
await mock.module("@bastani/atomic-sdk/components/panel-client", () => ({
  ...realPanelClient,
  PanelClient: {
    ...(realPanelClient.PanelClient ?? {}),
    mount: panelMountMock,
  },
}));

// Load the workflow command after the daemon is mocked.
const {
  workflowCommand,
  buildWorkflowCommand,
  blockIfBroken,
  getActiveBroken,
  getActiveBrokenList,
  rebuildWorkflowCommand,
} = await import("./workflow.ts");
const { createBuiltinRegistry } = await import("../builtin-registry.ts");
const { defineWorkflow } = await import("@bastani/atomic-sdk/define-workflow");
const { createRegistry } = await import("@bastani/atomic-sdk/registry");

// ─── Output capture ──────────────────────────────────────────────────────────

interface CapturedOutput {
  stdout: string;
  stderr: string;
  restore: () => void;
}

function captureOutput(): CapturedOutput {
  const captured: CapturedOutput = { stdout: "", stderr: "", restore: () => {} };
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  const origConsoleLog = console.log;
  const origConsoleError = console.error;
  const origConsoleWarn = console.warn;

  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured.stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured.stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  console.log = (...args: unknown[]) => {
    captured.stdout += args.map(String).join(" ") + "\n";
  };
  console.error = (...args: unknown[]) => {
    captured.stderr += args.map(String).join(" ") + "\n";
  };
  console.warn = (...args: unknown[]) => {
    captured.stderr += args.map(String).join(" ") + "\n";
  };

  captured.restore = () => {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
    console.log = origConsoleLog;
    console.error = origConsoleError;
    console.warn = origConsoleWarn;
  };
  return captured;
}

// ─── Colour suppression ──────────────────────────────────────────────────────

let savedNoColor: string | undefined;
beforeEach(() => {
  savedNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  dispatchCalls.length = 0;
  fakeConn.sendRequest.mockClear();
  fakeConn.onNotification.mockClear();
  fakeConn.onClose.mockClear();
  fakeConn.dispose.mockClear();
  fakeConnDisposable.dispose.mockClear();
  panelMountMock.mockClear();
  // Set stdout to non-TTY for tests (avoids PanelClient mount)
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, get: () => false });
  // Re-wire sendRequest so dispatchCalls is populated correctly
  fakeConn.sendRequest.mockImplementation(async (_method: string, params: unknown) => {
    if (_method === "workflow/start") {
      dispatchCalls.push(params as typeof dispatchCalls[number]);
      return { runId: mockRunId, attachable: true };
    }
    return {};
  });
  fakeConn.onNotification.mockImplementation((_method: string, handler: (params: unknown) => void) => {
    if (_method === "run/ended") {
      handler({ runId: mockRunId });
    }
    return fakeConnDisposable;
  });
});
afterEach(() => {
  if (savedNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = savedNoColor;
});

// ─── exitOverride helper ──────────────────────────────────────────────────────
// Calling exitOverride() converts Commander's process.exit(1) into a thrown
// Error so tests can assert on rejection without killing the process.

function enableExitOverride(): void {
  workflowCommand.exitOverride();
}

// ─── Listing removed from dispatcher flags ──────────────────────────────────
//
// `--list` / `-l` used to live on the dispatcher command as a flag. It's
// since moved to a dedicated `atomic workflow list` subcommand (registered
// in src/cli.ts, implemented in ./workflow-list.ts) because the flag form
// had confusing interactions with argv parsing. The dispatcher itself no
// longer accepts the flag.

describe("workflowCommand: --list flag removed", () => {
  test("--list is not a recognised dispatcher option", async () => {
    enableExitOverride();
    let threw = false;
    const cap = captureOutput();
    try {
      await workflowCommand.parseAsync(["node", "cli", "--list"]);
    } catch {
      threw = true;
    } finally {
      cap.restore();
    }
    expect(threw).toBe(true);
    expect(dispatchCalls).toHaveLength(0);
  });
});

// ─── Named mode success ───────────────────────────────────────────────────────

describe("workflowCommand named mode — success", () => {
  test("dispatches ralph/claude with prompt to executor", async () => {
    await workflowCommand.parseAsync([
      "node", "cli",
      "-n", "ralph",
      "-a", "claude",
      "--prompt", "fix the auth bug",
    ]);

    expect(dispatchCalls).toHaveLength(1);
    const call = dispatchCalls[0]!;
    expect(call.agent).toBe("claude");
    expect(call.inputs?.["prompt"]).toBe("fix the auth bug");
    expect(`${call.agent}/${call.workflowName}`).toBe("claude/ralph");
  });

  test("dispatches ralph/copilot successfully", async () => {
    await workflowCommand.parseAsync([
      "node", "cli",
      "-n", "ralph",
      "-a", "copilot",
      "--prompt", "review this PR",
    ]);

    expect(dispatchCalls).toHaveLength(1);
    const call = dispatchCalls[0]!;
    expect(call.agent).toBe("copilot");
    expect(call.inputs?.["prompt"]).toBe("review this PR");
  });

  test("dispatches ralph/opencode successfully", async () => {
    await workflowCommand.parseAsync([
      "node", "cli",
      "-n", "ralph",
      "-a", "opencode",
      "--prompt", "refactor the service layer",
    ]);

    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]!.agent).toBe("opencode");
  });

  test("dispatches deep-research-codebase/claude with prompt", async () => {
    await workflowCommand.parseAsync([
      "node", "cli",
      "-n", "deep-research-codebase",
      "-a", "claude",
      "--prompt", "how does auth work",
    ]);

    expect(dispatchCalls).toHaveLength(1);
    expect(`${dispatchCalls[0]!.agent}/${dispatchCalls[0]!.workflowName}`).toBe("claude/deep-research-codebase");
  });

  test("--detach flag threads detach=true to executor", async () => {
    await workflowCommand.parseAsync([
      "node", "cli",
      "-n", "ralph",
      "-a", "claude",
      "--prompt", "test",
      "--detach",
    ]);

    expect(dispatchCalls).toHaveLength(1);
    expect(fakeConn.onNotification).not.toHaveBeenCalled();
    expect(fakeConn.dispose).toHaveBeenCalled();
  });

  test("-d shorthand also sets detach=true", async () => {
    await workflowCommand.parseAsync([
      "node", "cli",
      "-n", "ralph",
      "-a", "claude",
      "--prompt", "test",
      "-d",
    ]);

    expect(dispatchCalls).toHaveLength(1);
    expect(fakeConn.onNotification).not.toHaveBeenCalled();
    expect(fakeConn.dispose).toHaveBeenCalled();
  });

  test("detach defaults to false when flag omitted", async () => {
    await workflowCommand.parseAsync([
      "node", "cli",
      "-n", "ralph",
      "-a", "claude",
      "--prompt", "test",
    ]);

    expect(dispatchCalls).toHaveLength(1);
    expect(fakeConn.onNotification).toHaveBeenCalled();
  });

  test("integer input --max_loops is forwarded to executor", async () => {
    await workflowCommand.parseAsync([
      "node", "cli",
      "-n", "ralph",
      "-a", "claude",
      "--prompt", "test",
      "--max_loops", "3",
    ]);

    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]!.inputs?.["max_loops"]).toBe("3");
  });

  test("workflowKey is always <agent>/<name>", async () => {
    await workflowCommand.parseAsync([
      "node", "cli",
      "-n", "deep-research-codebase",
      "-a", "copilot",
      "--prompt", "research something",
    ]);

    expect(dispatchCalls).toHaveLength(1);
    const c = dispatchCalls[0]!;
    expect(c.agent).toBe("copilot");
    expect(c.workflowName).toBe("deep-research-codebase");
  });
});

// ─── Named mode — error paths ─────────────────────────────────────────────────

describe("workflowCommand named mode — error paths", () => {
  test("unknown workflow name throws (Commander exits via exitOverride)", async () => {
    enableExitOverride();
    let threw = false;
    const cap = captureOutput();
    try {
      await workflowCommand.parseAsync([
        "node", "cli",
        "-n", "bogus-workflow",
        "-a", "claude",
      ]);
    } catch (_e) {
      threw = true;
    } finally {
      cap.restore();
    }
    expect(threw).toBe(true);
    expect(dispatchCalls).toHaveLength(0);
  });

  test("unknown agent throws (Commander exits via exitOverride)", async () => {
    enableExitOverride();
    let threw = false;
    const cap = captureOutput();
    try {
      await workflowCommand.parseAsync([
        "node", "cli",
        "-n", "ralph",
        "-a", "bogus-agent",
      ]);
    } catch (_e) {
      threw = true;
    } finally {
      cap.restore();
    }
    expect(threw).toBe(true);
    expect(dispatchCalls).toHaveLength(0);
  });

  test("missing required prompt for ralph routes through daemon (validation is server-side)", async () => {
    // In the new JSON-RPC architecture, client-side validateAndResolve is gone.
    // Missing required inputs are forwarded to the daemon which validates server-side.
    const cap = captureOutput();
    try {
      await workflowCommand.parseAsync([
        "node", "cli",
        "-n", "ralph",
        "-a", "claude",
        // --prompt intentionally omitted
      ]);
    } finally {
      cap.restore();
    }
    // dispatch still fires — daemon is responsible for required-input validation
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]!.inputs?.["prompt"]).toBeUndefined();
  });

  test("non-integer value for --max_loops is forwarded to daemon without client-side coercion", async () => {
    // In the new JSON-RPC architecture, type validation moved to the daemon.
    // The CLI forwards string values as-is without throwing.
    const cap = captureOutput();
    try {
      await workflowCommand.parseAsync([
        "node", "cli",
        "-n", "ralph",
        "-a", "claude",
        "--prompt", "test",
        "--max_loops", "not-an-int",
      ]);
    } finally {
      cap.restore();
    }
    // dispatch fires; daemon validates type server-side
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]!.inputs?.["max_loops"]).toBe("not-an-int");
  });
});

// ─── Enum input coercion ──────────────────────────────────────────────────────

describe("workflowCommand enum input coercion", () => {
  test("valid enum value accepted for open-claude-design --output-type", async () => {
    await workflowCommand.parseAsync([
      "node", "cli",
      "-n", "open-claude-design",
      "-a", "claude",
      "--prompt", "design a button",
      "--output-type", "prototype",
    ]);

    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]!.inputs?.["output-type"]).toBe("prototype");
  });

  test("default enum value applied when --output-type omitted", async () => {
    // In the new JSON-RPC architecture, validateAndResolve no longer fills
    // in defaults client-side. The daemon handles defaults server-side.
    // When --output-type is omitted, inputs["output-type"] is not set.
    await workflowCommand.parseAsync([
      "node", "cli",
      "-n", "open-claude-design",
      "-a", "claude",
      "--prompt", "design a button",
      // --output-type intentionally omitted
    ]);

    expect(dispatchCalls).toHaveLength(1);
    // Default is not filled client-side; daemon applies defaults server-side.
    expect(dispatchCalls[0]!.inputs?.["output-type"]).toBeUndefined();
  });
});

// ─── Help fallback when name/agent is missing ────────────────────────────────
//
// `cmd.help()` is the action's terminal branch when neither `-n` nor `-a`
// can resolve to a target (and the TTY picker isn't viable). With
// `exitOverride()` Commander throws a CommanderError instead of calling
// `process.exit`, so we can assert the dispatcher reaches the help path
// without dispatching to the executor.

describe("workflowCommand help fallback", () => {
  test("no name and no agent triggers cmd.help() without dispatch", async () => {
    enableExitOverride();
    let threw = false;
    const cap = captureOutput();
    try {
      await workflowCommand.parseAsync(["node", "cli"]);
    } catch {
      threw = true;
    } finally {
      cap.restore();
    }
    expect(threw).toBe(true);
    expect(dispatchCalls).toHaveLength(0);
  });

  test("agent without name does NOT trigger picker when stdout is not a TTY", async () => {
    enableExitOverride();
    const origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      get: () => false,
    });
    let threw = false;
    const cap = captureOutput();
    try {
      // -a claude with no -n: in TTY mode this would launch the picker;
      // with isTTY=false it falls through to cmd.help().
      await workflowCommand.parseAsync(["node", "cli", "-a", "claude"]);
    } catch {
      threw = true;
    } finally {
      cap.restore();
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        get: () => origIsTTY,
      });
    }
    expect(threw).toBe(true);
    expect(dispatchCalls).toHaveLength(0);
  });

  test("name without agent triggers cmd.help() — agent is required", async () => {
    enableExitOverride();
    let threw = false;
    const cap = captureOutput();
    try {
      await workflowCommand.parseAsync(["node", "cli", "-n", "ralph"]);
    } catch {
      threw = true;
    } finally {
      cap.restore();
    }
    expect(threw).toBe(true);
    expect(dispatchCalls).toHaveLength(0);
  });
});

// ─── Custom-registry behaviours ──────────────────────────────────────────────
//
// `buildWorkflowCommand(registry)` lets us test branches that the
// builtin registry doesn't exercise: workflows with empty input
// schemas (free-form prompt collapse), enum inputs without a
// description (fallback `desc` line), and (name, agent) pairs that
// resolve only for one agent (resolveWorkflow's hint builder).

describe("buildWorkflowCommand with custom registries", () => {
  test("empty-inputs workflow + positional prompt collapses into inputs.prompt", async () => {
    const freeForm = defineWorkflow({
      name: "free-form",
    })
      .for("claude")
      .run(async () => {})
      .compile();
    const registry = createRegistry().register(freeForm);
    const cmd = buildWorkflowCommand(registry);

    await cmd.parseAsync([
      "node", "cli",
      "-n", "free-form",
      "-a", "claude",
      "fix",
      "the",
      "auth",
      "bug",
    ]);

    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]!.inputs?.["prompt"]).toBe("fix the auth bug");
  });

  test("workflow with declared inputs ignores positional prompt collapsing", async () => {
    const declared = defineWorkflow({
      name: "declared",
      inputs: [{ name: "topic", type: "text", required: false }],
    })
      .for("claude")
      .run(async () => {})
      .compile();
    const registry = createRegistry().register(declared);
    const cmd = buildWorkflowCommand(registry);

    await cmd.parseAsync([
      "node", "cli",
      "-n", "declared",
      "-a", "claude",
      "trailing", "positional",
    ]);

    expect(dispatchCalls).toHaveLength(1);
    // No `prompt` should be synthesised — schema is non-empty.
    expect(dispatchCalls[0]!.inputs?.["prompt"]).toBeUndefined();
  });

  test("resolveWorkflow lists alternate agents when name exists for a different agent", async () => {
    const claudeOnly = defineWorkflow({
      name: "only-claude",
      inputs: [{ name: "topic", type: "text", required: false }],
    })
      .for("claude")
      .run(async () => {})
      .compile();
    const registry = createRegistry().register(claudeOnly);
    const cmd = buildWorkflowCommand(registry);
    cmd.exitOverride();

    let caught: unknown;
    const cap = captureOutput();
    try {
      await cmd.parseAsync([
        "node", "cli",
        "-n", "only-claude",
        "-a", "copilot",
      ]);
    } catch (e) {
      caught = e;
    } finally {
      cap.restore();
    }
    expect(caught).toBeDefined();
    const message = caught instanceof Error ? caught.message : String(caught);
    // Hint should call out the agent that DOES have this workflow.
    expect(message).toContain("only-claude");
    expect(message).toContain("claude");
  });

  test("enum input without description gets a 'one of: ...' fallback in --help", async () => {
    const enumWf = defineWorkflow({
      name: "enum-wf",
      inputs: [
        {
          name: "format",
          type: "enum",
          required: false,
          values: ["json", "text"],
          // description omitted on purpose — exercises the enum-fallback branch.
        },
      ],
    })
      .for("claude")
      .run(async () => {})
      .compile();
    const registry = createRegistry().register(enumWf);
    const cmd = buildWorkflowCommand(registry);

    // Walk the registered options and find the synthesised --format.
    const formatOption = cmd.options.find((o) => o.long === "--format");
    expect(formatOption).toBeDefined();
    expect(formatOption!.description).toBe("one of: json, text");
  });

  test("text input without description falls back to the type label", async () => {
    const textWf = defineWorkflow({
      name: "text-wf",
      inputs: [
        { name: "topic", type: "text", required: false },
      ],
    })
      .for("claude")
      .run(async () => {})
      .compile();
    const registry = createRegistry().register(textWf);
    const cmd = buildWorkflowCommand(registry);

    const topicOption = cmd.options.find((o) => o.long === "--topic");
    expect(topicOption).toBeDefined();
    expect(topicOption!.description).toBe("text");
  });

  test("empty registry rejects unknown name + agent at dispatch time with empty-registry hint", async () => {
    const registry = createRegistry();
    const cmd = buildWorkflowCommand(registry);
    cmd.exitOverride();

    let caught: unknown;
    const cap = captureOutput();
    try {
      // With an empty registry the option parser allows any name (since
      // allNames.length === 0 short-circuits the guard), so we reach
      // resolveWorkflow which throws with the "no workflow named ..."
      // hint.
      await cmd.parseAsync([
        "node", "cli",
        "-n", "anything",
        "-a", "claude",
      ]);
    } catch (e) {
      caught = e;
    } finally {
      cap.restore();
    }
    expect(caught).toBeDefined();
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("anything");
    expect(message).toContain("registry");
  });
});

// ─── Broken-workflow gating and active-state accessors ──────────────────────

describe("rebuildWorkflowCommand + broken-workflow gating", () => {
  const sampleBroken = {
    alias: "demo",
    origin: "local" as const,
    agents: ["claude" as const] as ("claude" | "copilot" | "opencode")[],
    reason: "demo workflow failed to load",
    source: "/repo/.atomic/settings.json",
    fix: "fix the import error",
  };

  test("getActiveBroken / getActiveBrokenList expose the latest rebuild's broken state", () => {
    const reg = createBuiltinRegistry();
    const idx = new Map([[`claude/${sampleBroken.alias}`, sampleBroken]]);
    rebuildWorkflowCommand(reg, idx, [sampleBroken]);
    try {
      expect(getActiveBroken().has("claude/demo")).toBe(true);
      expect(getActiveBrokenList()).toContain(sampleBroken);
    } finally {
      rebuildWorkflowCommand(createBuiltinRegistry(), new Map(), []);
    }
  });

  test("blockIfBroken writes the 4-line diagnostic and exits with code 2", () => {
    const reg = createBuiltinRegistry();
    const idx = new Map([[`claude/${sampleBroken.alias}`, sampleBroken]]);
    rebuildWorkflowCommand(reg, idx, [sampleBroken]);

    const origExit = process.exit;
    const exits: number[] = [];
    process.exit = ((code?: number): never => {
      exits.push(code ?? 0);
      throw new Error(`__test_exit_${code}`);
    }) as typeof process.exit;
    const cap = captureOutput();
    let caught: unknown;
    try {
      try {
        blockIfBroken("demo", "claude");
      } catch (e) {
        caught = e;
      }
    } finally {
      cap.restore();
      process.exit = origExit;
      rebuildWorkflowCommand(createBuiltinRegistry(), new Map(), []);
    }
    expect(exits).toEqual([2]);
    expect(caught).toBeDefined();
    expect(cap.stderr).toContain('cannot run "demo"');
    expect(cap.stderr).toContain("reason · demo workflow failed to load");
    expect(cap.stderr).toContain("source · /repo/.atomic/settings.json");
    expect(cap.stderr).toContain("fix    · fix the import error");
  });

  test("blockIfBroken is a no-op when (agent, name) is not in the broken index", () => {
    rebuildWorkflowCommand(createBuiltinRegistry(), new Map(), []);
    expect(() => blockIfBroken("not-broken", "claude")).not.toThrow();
  });
});

// ─── ATOMIC_DEBUG=1 dispatch tracing ─────────────────────────────────────────

describe("workflowCommand ATOMIC_DEBUG tracing", () => {
  test("writes a `[atomic/workflow] dispatching ...` line to stderr when ATOMIC_DEBUG=1", async () => {
    const saved = process.env.ATOMIC_DEBUG;
    process.env.ATOMIC_DEBUG = "1";
    const cap = captureOutput();
    try {
      await workflowCommand.parseAsync([
        "node", "cli",
        "-n", "ralph",
        "-a", "claude",
        "--prompt", "trace me",
      ]);
    } finally {
      cap.restore();
      if (saved === undefined) delete process.env.ATOMIC_DEBUG;
      else process.env.ATOMIC_DEBUG = saved;
    }
    expect(cap.stderr).toContain("[atomic/workflow] dispatching ralph/claude inputs=[prompt]");
    expect(dispatchCalls).toHaveLength(1);
  });
});

// ─── Non-TTY dispatch settle paths ───────────────────────────────────────────

describe("workflowCommand non-TTY dispatch settle paths", () => {
  test("run/ended with overall=error rejects with the fatalError message", async () => {
    // Reroute the run/ended handler to fire AFTER startWorkflow returns,
    // so it reaches the `params.runId === pendingRunId` branch with an error.
    fakeConn.onNotification.mockImplementation(
      (_method: string, handler: (params: unknown) => void) => {
        if (_method === "run/ended") {
          queueMicrotask(() => handler({ runId: mockRunId, overall: "error", fatalError: "boom" }));
        }
        return fakeConnDisposable;
      },
    );
    const cap = captureOutput();
    let caught: unknown;
    try {
      await workflowCommand.parseAsync([
        "node", "cli",
        "-n", "ralph",
        "-a", "claude",
        "--prompt", "trigger error",
      ]);
    } catch (e) {
      caught = e;
    } finally {
      cap.restore();
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("boom");
  });

  test("run/get reporting a non-active status settles dispatch immediately", async () => {
    // Suppress the immediate run/ended firing so settlement must come from
    // the run/get short-circuit path.
    fakeConn.onNotification.mockImplementation(() => fakeConnDisposable);
    fakeConn.sendRequest.mockImplementation(async (method: string, params: unknown) => {
      if (method === "workflow/start") {
        dispatchCalls.push(params as typeof dispatchCalls[number]);
        return { runId: mockRunId, attachable: true };
      }
      if (method === "run/get") return { status: "complete" };
      return {};
    });
    const cap = captureOutput();
    try {
      await workflowCommand.parseAsync([
        "node", "cli",
        "-n", "ralph",
        "-a", "claude",
        "--prompt", "already done",
      ]);
    } finally {
      cap.restore();
    }
    expect(dispatchCalls).toHaveLength(1);
  });

  test("daemon onClose firing before run/ended rejects with a connection-closed error", async () => {
    fakeConn.onNotification.mockImplementation(() => fakeConnDisposable);
    fakeConn.onClose.mockImplementation((handler: () => void) => {
      queueMicrotask(handler);
      return fakeConnDisposable;
    });
    fakeConn.sendRequest.mockImplementation(async (method: string, params: unknown) => {
      if (method === "workflow/start") {
        dispatchCalls.push(params as typeof dispatchCalls[number]);
        return { runId: mockRunId, attachable: true };
      }
      if (method === "run/get") return { status: "active" };
      return {};
    });
    const cap = captureOutput();
    let caught: unknown;
    try {
      await workflowCommand.parseAsync([
        "node", "cli",
        "-n", "ralph",
        "-a", "claude",
        "--prompt", "daemon dies",
      ]);
    } catch (e) {
      caught = e;
    } finally {
      cap.restore();
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("daemon connection closed");
  });
});
