/**
 * Tests for `workflowCommand` — the Commander Command returned by
 * `createWorkflowCli(createBuiltinRegistry()).command("workflow")`.
 *
 * Mocking strategy: mock.module("../../sdk/runtime/executor.ts") replaces
 * executeWorkflow with a spy BEFORE the dynamic import of workflow.ts.
 *
 * Module load order:
 *   1. Static imports execute first (hoisted by ES module semantics) —
 *      this loads registry.ts → providers/claude.ts → executor.ts (REAL),
 *      so `escBash` and all other executor exports are cached before the mock.
 *   2. `mock.module` replaces executor.ts for SUBSEQUENT imports — only
 *      `worker.ts` picks up the mocked executeWorkflow/runOrchestrator.
 *   3. Dynamic import of workflow.ts uses the mocked executor via worker.ts.
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
import type { WorkflowRunOptions } from "../../sdk/runtime/executor.ts";
// Static import — loads providers/claude.ts → real executor.ts into module cache
// BEFORE mock.module replaces it for subsequent imports.
import "../../sdk/registry.ts";

// ─── Module-level mock ────────────────────────────────────────────────────────
// Must be declared AFTER the static imports above (which load the real executor)
// but BEFORE the dynamic import of workflow.ts below (which uses worker.ts → mock).

const executeWorkflowCalls: WorkflowRunOptions[] = [];
const executeWorkflowMock = mock(
  async (opts: WorkflowRunOptions): Promise<{ id: string; tmuxSessionName: string }> => {
    executeWorkflowCalls.push(opts);
    return { id: "fake-id", tmuxSessionName: "fake-session" };
  },
);

// Spread real module to preserve all exports (escBash, discoverCopilotBinary, etc.)
// so this mock doesn't break other test files that import those exports.
const realExecutor = await import("../../sdk/runtime/executor.ts");
await mock.module("../../sdk/runtime/executor.ts", () => ({
  ...realExecutor,
  executeWorkflow: executeWorkflowMock,
  runOrchestrator: async () => {},
}));

// Load the workflow command after the executor is mocked. Importing
// `./workflow.ts` triggers the registry build + Commander tree
// construction inside the mocked executor sandbox.
const { workflowCommand } = await import("./workflow.ts");

// ─── Output capture ──────────────────────────────────────────────────────────

interface CapturedOutput {
  stdout: string;
  stderr: string;
  restore: () => void;
}

function captureOutput(): CapturedOutput {
  const captured: CapturedOutput = { stdout: "", stderr: "", restore: () => {} };
  const origStdout = process.stdout.write.bind(process.stdout);
  const origConsoleLog = console.log;
  const origConsoleError = console.error;
  const origConsoleWarn = console.warn;

  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured.stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
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
  executeWorkflowCalls.length = 0;
  executeWorkflowMock.mockClear();
  executeWorkflowMock.mockImplementation(async (opts) => {
    executeWorkflowCalls.push(opts);
    return { id: "fake-id", tmuxSessionName: "fake-session" };
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
    expect(executeWorkflowMock).not.toHaveBeenCalled();
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

    expect(executeWorkflowMock).toHaveBeenCalledTimes(1);
    const call = executeWorkflowCalls[0]!;
    expect(call.agent).toBe("claude");
    expect(call.inputs?.["prompt"]).toBe("fix the auth bug");
    expect(`${call.definition.agent}/${call.definition.name}`).toBe("claude/ralph");
  });

  test("dispatches ralph/copilot successfully", async () => {
    await workflowCommand.parseAsync([
      "node", "cli",
      "-n", "ralph",
      "-a", "copilot",
      "--prompt", "review this PR",
    ]);

    expect(executeWorkflowMock).toHaveBeenCalledTimes(1);
    const call = executeWorkflowCalls[0]!;
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

    expect(executeWorkflowMock).toHaveBeenCalledTimes(1);
    expect(executeWorkflowCalls[0]!.agent).toBe("opencode");
  });

  test("dispatches deep-research-codebase/claude with prompt", async () => {
    await workflowCommand.parseAsync([
      "node", "cli",
      "-n", "deep-research-codebase",
      "-a", "claude",
      "--prompt", "how does auth work",
    ]);

    expect(executeWorkflowMock).toHaveBeenCalledTimes(1);
    expect(`${executeWorkflowCalls[0]!.definition.agent}/${executeWorkflowCalls[0]!.definition.name}`).toBe("claude/deep-research-codebase");
  });

  test("--detach flag threads detach=true to executor", async () => {
    await workflowCommand.parseAsync([
      "node", "cli",
      "-n", "ralph",
      "-a", "claude",
      "--prompt", "test",
      "--detach",
    ]);

    expect(executeWorkflowMock).toHaveBeenCalledTimes(1);
    expect(executeWorkflowCalls[0]!.detach).toBe(true);
  });

  test("-d shorthand also sets detach=true", async () => {
    await workflowCommand.parseAsync([
      "node", "cli",
      "-n", "ralph",
      "-a", "claude",
      "--prompt", "test",
      "-d",
    ]);

    expect(executeWorkflowMock).toHaveBeenCalledTimes(1);
    expect(executeWorkflowCalls[0]!.detach).toBe(true);
  });

  test("detach defaults to false when flag omitted", async () => {
    await workflowCommand.parseAsync([
      "node", "cli",
      "-n", "ralph",
      "-a", "claude",
      "--prompt", "test",
    ]);

    expect(executeWorkflowMock).toHaveBeenCalledTimes(1);
    expect(executeWorkflowCalls[0]!.detach).toBe(false);
  });

  test("integer input --max_loops is forwarded to executor", async () => {
    await workflowCommand.parseAsync([
      "node", "cli",
      "-n", "ralph",
      "-a", "claude",
      "--prompt", "test",
      "--max_loops", "3",
    ]);

    expect(executeWorkflowMock).toHaveBeenCalledTimes(1);
    expect(executeWorkflowCalls[0]!.inputs?.["max_loops"]).toBe("3");
  });

  test("workflowKey is always <agent>/<name>", async () => {
    await workflowCommand.parseAsync([
      "node", "cli",
      "-n", "deep-research-codebase",
      "-a", "copilot",
      "--prompt", "research something",
    ]);

    expect(executeWorkflowMock).toHaveBeenCalledTimes(1);
    const c = executeWorkflowCalls[0]!;
    expect(`${c.definition.agent}/${c.definition.name}`).toBe(
      "copilot/deep-research-codebase",
    );
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
    expect(executeWorkflowMock).not.toHaveBeenCalled();
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
    expect(executeWorkflowMock).not.toHaveBeenCalled();
  });

  test("missing required prompt for ralph throws from validateAndResolve", async () => {
    enableExitOverride();
    let threw = false;
    const cap = captureOutput();
    try {
      await workflowCommand.parseAsync([
        "node", "cli",
        "-n", "ralph",
        "-a", "claude",
        // --prompt intentionally omitted
      ]);
    } catch (_e) {
      threw = true;
    } finally {
      cap.restore();
    }
    expect(threw).toBe(true);
    expect(executeWorkflowMock).not.toHaveBeenCalled();
  });

  test("non-integer value for --max_loops throws from validateAndResolve", async () => {
    enableExitOverride();
    let threw = false;
    const cap = captureOutput();
    try {
      await workflowCommand.parseAsync([
        "node", "cli",
        "-n", "ralph",
        "-a", "claude",
        "--prompt", "test",
        "--max_loops", "not-an-int",
      ]);
    } catch (_e) {
      threw = true;
    } finally {
      cap.restore();
    }
    expect(threw).toBe(true);
    expect(executeWorkflowMock).not.toHaveBeenCalled();
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

    expect(executeWorkflowMock).toHaveBeenCalledTimes(1);
    expect(executeWorkflowCalls[0]!.inputs?.["output-type"]).toBe("prototype");
  });

  test("default enum value applied when --output-type omitted", async () => {
    // output-type has default "prototype" — validateAndResolve fills it in.
    // Note: Commander camelCases hyphenated flags (output-type → outputType),
    // so the CLI flag lookup for "output-type" falls through to the default.
    await workflowCommand.parseAsync([
      "node", "cli",
      "-n", "open-claude-design",
      "-a", "claude",
      "--prompt", "design a button",
      // --output-type intentionally omitted
    ]);

    expect(executeWorkflowMock).toHaveBeenCalledTimes(1);
    expect(executeWorkflowCalls[0]!.inputs?.["output-type"]).toBe("prototype");
  });
});
