/**
 * Unit tests for `hostWorkflows()`.
 *
 * Mocking strategy:
 * - `process.exit`: replaced with a function that throws `ExitCalled` sentinel
 *   so async test flows can catch and assert on the exit code.
 * - `process.stdout.write` / `process.stderr.write`: replaced with capture spies.
 * - `runWorkflow`: injected via the `options.runWorkflow` DI seam — no
 *   `mock.module` needed (process-global side effects break test isolation).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { defineWorkflow } from "../define-workflow.ts";
import type { RunWorkflowOptions, RunWorkflowResult } from "../primitives/run.ts";
import {
  hostWorkflows,
  lookupHostedWorkflow,
  _clearHostedWorkflowRegistry,
} from "./host-workflows.ts";

// ─── Sentinel ────────────────────────────────────────────────────────────────

class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

const VALID_TOKEN = "a".repeat(32);

const VALID_ENV = {
  ATOMIC_HOST: "1",
  ATOMIC_DISPATCH_TOKEN: VALID_TOKEN,
};

function makeArgv(...extra: string[]): string[] {
  return ["bun", "fixture.ts", ...extra, `--dispatch-token=${VALID_TOKEN}`];
}

/** Build a compiled WorkflowDefinition for use in tests. */
function makeWorkflow(name = "demo", agent: "claude" | "copilot" | "opencode" = "claude") {
  return defineWorkflow({
    name,
    description: `${name} description`,
    source: import.meta.path,
    inputs: [],
  })
    .for(agent)
    .run(async () => {})
    .compile();
}

/** Stand-in result so the injected mock satisfies `runWorkflow`'s return type. */
const RUN_RESULT: RunWorkflowResult = {
  id: "00000000",
  tmuxSessionName: "atomic-wf-test",
};

/** Mock that resolves with a stub result — typed so DI passes typecheck and call sites can introspect args. */
function makeRunMock() {
  return mock(async (_opts: RunWorkflowOptions): Promise<RunWorkflowResult> => RUN_RESULT);
}

// ─── Process spy helpers ──────────────────────────────────────────────────────

type WriteFn = (
  buffer: string | Uint8Array,
  cbOrEncoding?: ((err?: Error | null) => void) | BufferEncoding,
  cb?: (err?: Error | null) => void,
) => boolean;

let capturedStdout: string[] = [];
let capturedStderr: string[] = [];
let originalStdoutWrite: WriteFn;
let originalStderrWrite: WriteFn;
let originalExit: typeof process.exit;

beforeEach(() => {
  capturedStdout = [];
  capturedStderr = [];

  originalStdoutWrite = process.stdout.write.bind(process.stdout) as WriteFn;
  originalStderrWrite = process.stderr.write.bind(process.stderr) as WriteFn;
  originalExit = process.exit;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    capturedStdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as WriteFn;

  process.stderr.write = ((chunk: string | Uint8Array) => {
    capturedStderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as WriteFn;

  process.exit = ((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as typeof process.exit;
});

afterEach(() => {
  process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
  process.stderr.write = originalStderrWrite as typeof process.stderr.write;
  process.exit = originalExit;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("hostWorkflows — _emit-workflow-meta", () => {
  test("emits ATOMIC_WORKFLOW_META JSON and exits 0 with one workflow", async () => {
    const wf = makeWorkflow("demo", "claude");
    const argv = makeArgv("_emit-workflow-meta");

    let firstCaught: ExitCalled | null = null;
    try {
      await hostWorkflows([wf], { argv, env: VALID_ENV });
    } catch (e) {
      firstCaught = e as ExitCalled;
    }
    expect(firstCaught).toBeInstanceOf(ExitCalled);

    expect(capturedStdout).toHaveLength(1);
    const line = capturedStdout[0]!;
    expect(line.startsWith("ATOMIC_WORKFLOW_META: ")).toBe(true);

    const json = line.slice("ATOMIC_WORKFLOW_META: ".length).trimEnd();
    const parsed = JSON.parse(json) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);

    const entry = parsed[0] as Record<string, unknown>;
    expect(entry["name"]).toBe("demo");
    expect(entry["description"]).toBe("demo description");
    expect(entry["agent"]).toBe("claude");
    expect(Array.isArray(entry["inputs"])).toBe(true);
    expect(entry["source"]).toBe(import.meta.path);

    // Assert exit code was 0
    let caught: ExitCalled | null = null;
    try {
      await hostWorkflows([wf], { argv, env: VALID_ENV });
    } catch (e) {
      caught = e as ExitCalled;
    }
    expect(caught).toBeInstanceOf(ExitCalled);
    expect(caught!.code).toBe(0);
  });

  test("emits ATOMIC_WORKFLOW_META: [] and exits 0 with empty workflows", async () => {
    const argv = makeArgv("_emit-workflow-meta");

    let caught: ExitCalled | null = null;
    try {
      await hostWorkflows([], { argv, env: VALID_ENV });
    } catch (e) {
      caught = e as ExitCalled;
    }

    expect(caught).toBeInstanceOf(ExitCalled);
    expect(caught!.code).toBe(0);

    const line = capturedStdout[0]!;
    expect(line.startsWith("ATOMIC_WORKFLOW_META: ")).toBe(true);
    const json = line.slice("ATOMIC_WORKFLOW_META: ".length).trimEnd();
    expect(JSON.parse(json)).toEqual([]);
  });

  test("serializes minSDKVersion field in meta payload", async () => {
    const wf = defineWorkflow({
      name: "versioned",
      description: "with version",
      source: import.meta.path,
      minSDKVersion: "1.2.3",
    })
      .for("claude")
      .run(async () => {})
      .compile();

    const argv = makeArgv("_emit-workflow-meta");
    try {
      await hostWorkflows([wf], { argv, env: VALID_ENV });
    } catch {
      // ExitCalled
    }

    const line = capturedStdout[0]!;
    const parsed = JSON.parse(line.slice("ATOMIC_WORKFLOW_META: ".length).trimEnd()) as Array<Record<string, unknown>>;
    expect(parsed[0]!["minSDKVersion"]).toBe("1.2.3");
  });

  test("serializes minSDKVersion as null when not set", async () => {
    const wf = makeWorkflow("no-version", "claude");
    const argv = makeArgv("_emit-workflow-meta");
    try {
      await hostWorkflows([wf], { argv, env: VALID_ENV });
    } catch {
      // ExitCalled
    }

    const line = capturedStdout[0]!;
    const parsed = JSON.parse(line.slice("ATOMIC_WORKFLOW_META: ".length).trimEnd()) as Array<Record<string, unknown>>;
    expect(Object.prototype.hasOwnProperty.call(parsed[0], "minSDKVersion")).toBe(true);
    expect(parsed[0]!["minSDKVersion"]).toBeNull();
  });
});

describe("hostWorkflows — token guard (silent returns)", () => {
  test("returns silently when no env tokens present", async () => {
    const wf = makeWorkflow();
    const argv = makeArgv("_emit-workflow-meta");
    // No ATOMIC_HOST or ATOMIC_DISPATCH_TOKEN in env
    await hostWorkflows([wf], { argv, env: {} });

    expect(capturedStdout).toHaveLength(0);
    expect(capturedStderr).toHaveLength(0);
  });

  test("returns silently when dispatch token mismatches", async () => {
    const wf = makeWorkflow();
    const argv = makeArgv("_emit-workflow-meta");
    const env = {
      ATOMIC_HOST: "1",
      ATOMIC_DISPATCH_TOKEN: "b".repeat(32), // different from VALID_TOKEN ("a"*32)
    };

    await hostWorkflows([wf], { argv, env });

    expect(capturedStdout).toHaveLength(0);
    expect(capturedStderr).toHaveLength(0);
  });

  test("returns silently when no atomic-internal sub-command in argv", async () => {
    const wf = makeWorkflow();
    const argv = ["bun", "fixture.ts", "--help", `--dispatch-token=${VALID_TOKEN}`];

    await hostWorkflows([wf], { argv, env: VALID_ENV });

    expect(capturedStdout).toHaveLength(0);
    expect(capturedStderr).toHaveLength(0);
  });

  test("returns silently when argv is too short (< 3 tokens)", async () => {
    const wf = makeWorkflow();
    await hostWorkflows([wf], { argv: ["bun", "fixture.ts"], env: VALID_ENV });

    expect(capturedStdout).toHaveLength(0);
    expect(capturedStderr).toHaveLength(0);
  });
});

describe("hostWorkflows — _atomic-run", () => {
  test("calls runWorkflow with matching workflow and exits 0", async () => {
    const wf = makeWorkflow("demo", "claude");

    const runWorkflowMock = makeRunMock();

    const argv = [
      "bun", "fixture.ts",
      "_atomic-run",
      `--dispatch-token=${VALID_TOKEN}`,
      "--name", "demo",
      "--agent", "claude",
    ];

    let caught: ExitCalled | null = null;
    try {
      await hostWorkflows([wf], { argv, env: VALID_ENV, runWorkflow: runWorkflowMock });
    } catch (e) {
      caught = e as ExitCalled;
    }

    expect(caught).toBeInstanceOf(ExitCalled);
    expect(caught!.code).toBe(0);
    expect(runWorkflowMock).toHaveBeenCalledTimes(1);
    const calls = runWorkflowMock.mock.calls as unknown as Array<[{ workflow: unknown; inputs: Record<string, string>; detach: boolean }]>;
    const callArg = calls[0]![0];
    expect(callArg.workflow).toBe(wf);
    expect(callArg.inputs).toEqual({});
    expect(callArg.detach).toBe(false);
  });

  test("passes parsed inputs and detach flag to runWorkflow", async () => {
    const wfWithInputs = defineWorkflow({
      name: "with-inputs",
      description: "test",
      source: import.meta.path,
      inputs: [
        { name: "topic", type: "string" as const, required: false },
      ],
    })
      .for("claude")
      .run(async () => {})
      .compile();

    const runWorkflowMock = makeRunMock();

    const argv = [
      "bun", "fixture.ts",
      "_atomic-run",
      `--dispatch-token=${VALID_TOKEN}`,
      "--name", "with-inputs",
      "--agent", "claude",
      "--detach",
      "--topic", "hello world",
    ];

    try {
      await hostWorkflows([wfWithInputs], { argv, env: VALID_ENV, runWorkflow: runWorkflowMock });
    } catch {
      // ExitCalled
    }

    expect(runWorkflowMock).toHaveBeenCalledTimes(1);
    const calls2 = runWorkflowMock.mock.calls as unknown as Array<[{ workflow: unknown; inputs: Record<string, string>; detach: boolean }]>;
    const callArg2 = calls2[0]![0];
    expect(callArg2.inputs).toEqual({ topic: "hello world" });
    expect(callArg2.detach).toBe(true);
  });

  test("exits 1 with error message when no matching workflow found", async () => {
    const wf = makeWorkflow("demo", "claude");
    const argv = [
      "bun", "fixture.ts",
      "_atomic-run",
      `--dispatch-token=${VALID_TOKEN}`,
      "--name", "unknown",
      "--agent", "claude",
    ];

    let caught: ExitCalled | null = null;
    try {
      await hostWorkflows([wf], { argv, env: VALID_ENV });
    } catch (e) {
      caught = e as ExitCalled;
    }

    expect(caught).toBeInstanceOf(ExitCalled);
    expect(caught!.code).toBe(1);
    expect(capturedStderr.join("")).toContain("unknown");
  });

  test("exits 1 when --name flag is missing", async () => {
    const wf = makeWorkflow("demo", "claude");
    const argv = [
      "bun", "fixture.ts",
      "_atomic-run",
      `--dispatch-token=${VALID_TOKEN}`,
      "--agent", "claude",
      // no --name
    ];

    let caught: ExitCalled | null = null;
    try {
      await hostWorkflows([wf], { argv, env: VALID_ENV });
    } catch (e) {
      caught = e as ExitCalled;
    }

    expect(caught).toBeInstanceOf(ExitCalled);
    expect(caught!.code).toBe(1);
    expect(capturedStderr.join("")).toContain("--name");
  });

  test("exits 1 when --agent flag is missing", async () => {
    const wf = makeWorkflow("demo", "claude");
    const argv = [
      "bun", "fixture.ts",
      "_atomic-run",
      `--dispatch-token=${VALID_TOKEN}`,
      "--name", "demo",
      // no --agent
    ];

    let caught: ExitCalled | null = null;
    try {
      await hostWorkflows([wf], { argv, env: VALID_ENV });
    } catch (e) {
      caught = e as ExitCalled;
    }

    expect(caught).toBeInstanceOf(ExitCalled);
    expect(caught!.code).toBe(1);
    expect(capturedStderr.join("")).toContain("--agent");
  });

  test("exits 1 and writes error to stderr when runWorkflow throws", async () => {
    const wf = makeWorkflow("demo", "claude");

    const runWorkflowMock = mock(async (): Promise<RunWorkflowResult> => {
      throw new Error("workflow execution failed");
    });

    const argv = [
      "bun", "fixture.ts",
      "_atomic-run",
      `--dispatch-token=${VALID_TOKEN}`,
      "--name", "demo",
      "--agent", "claude",
    ];

    let caught: ExitCalled | null = null;
    try {
      await hostWorkflows([wf], { argv, env: VALID_ENV, runWorkflow: runWorkflowMock });
    } catch (e) {
      caught = e as ExitCalled;
    }

    expect(caught).toBeInstanceOf(ExitCalled);
    expect(caught!.code).toBe(1);
    expect(capturedStderr.join("")).toContain("workflow execution failed");
  });
});

// ─── hostedWorkflowRegistry ───────────────────────────────────────────────────

describe("hostWorkflows — registry side-effect", () => {
  beforeEach(() => {
    _clearHostedWorkflowRegistry();
  });

  test("registers each supplied workflow keyed by (agent, name)", async () => {
    const wfA = makeWorkflow("demo-a", "claude");
    const wfB = makeWorkflow("demo-b", "opencode");

    // No HOST_SUBS in argv → hostWorkflows returns silently, but the
    // registry side-effect must still run so orchestrator-entry can resolve
    // the workflow on a later re-import.
    const argv = ["bun", "fixture.ts"];
    await hostWorkflows([wfA, wfB], { argv, env: {} });

    expect(lookupHostedWorkflow("demo-a", "claude")).toBe(wfA);
    expect(lookupHostedWorkflow("demo-b", "opencode")).toBe(wfB);
  });

  test("lookupHostedWorkflow returns undefined for unknown (name, agent)", () => {
    expect(lookupHostedWorkflow("never-registered", "claude")).toBeUndefined();
  });

  test("registry write happens before token validation, so untokenised re-imports still register", async () => {
    const wf = makeWorkflow("demo", "claude");
    // Token absent: validateDispatchToken returns false → hostWorkflows
    // returns immediately. But the registry must still be populated, since
    // this is exactly the path the orchestrator pane takes when it
    // re-imports the user's CLI under `_orchestrator-entry`.
    const argv = ["bun", "fixture.ts", "_emit-workflow-meta"];
    await hostWorkflows([wf], { argv, env: {} });

    expect(lookupHostedWorkflow("demo", "claude")).toBe(wf);
    // No stdout / stderr emitted because token check failed.
    expect(capturedStdout.join("")).toBe("");
  });

  test("agent disambiguates same-named workflows in the registry", async () => {
    const wfClaude = makeWorkflow("shared-name", "claude");
    const wfOpencode = makeWorkflow("shared-name", "opencode");

    await hostWorkflows([wfClaude, wfOpencode], {
      argv: ["bun", "fixture.ts"],
      env: {},
    });

    expect(lookupHostedWorkflow("shared-name", "claude")).toBe(wfClaude);
    expect(lookupHostedWorkflow("shared-name", "opencode")).toBe(wfOpencode);
  });
});

// ─── Direct CLI mode (no dispatch sub-command, --name supplied) ──────────────

describe("hostWorkflows — direct CLI mode", () => {
  test("runs workflow when --name + --agent + inputs supplied without dispatch sub-command", async () => {
    const wf = makeWorkflow("demo", "claude");
    const runWorkflowMock = makeRunMock();

    const argv = [
      "bun", "fixture.ts",
      "--name", "demo",
      "--agent", "claude",
    ];

    let caught: ExitCalled | null = null;
    try {
      await hostWorkflows([wf], { argv, env: {}, runWorkflow: runWorkflowMock });
    } catch (e) {
      caught = e as ExitCalled;
    }

    expect(caught?.code).toBe(0);
    expect(runWorkflowMock).toHaveBeenCalledTimes(1);
    expect(runWorkflowMock.mock.calls[0]![0]!.workflow).toBe(wf);
  });

  test("auto-resolves --agent when exactly one workflow matches --name", async () => {
    const wf = makeWorkflow("demo", "claude");
    const runWorkflowMock = makeRunMock();

    const argv = ["bun", "fixture.ts", "--name", "demo"];

    let caught: ExitCalled | null = null;
    try {
      await hostWorkflows([wf], { argv, env: {}, runWorkflow: runWorkflowMock });
    } catch (e) {
      caught = e as ExitCalled;
    }

    expect(caught?.code).toBe(0);
    expect(runWorkflowMock).toHaveBeenCalledTimes(1);
    expect(runWorkflowMock.mock.calls[0]![0]!.workflow).toBe(wf);
  });

  test("forwards --<input> flags as inputs to runWorkflow", async () => {
    const wf = makeWorkflow("demo", "claude");
    const runWorkflowMock = makeRunMock();

    const argv = [
      "bun", "fixture.ts",
      "--name", "demo",
      "--path", "/abs/path/to/file.ts",
      "--detach",
    ];

    let caught: ExitCalled | null = null;
    try {
      await hostWorkflows([wf], { argv, env: {}, runWorkflow: runWorkflowMock });
    } catch (e) {
      caught = e as ExitCalled;
    }

    expect(caught?.code).toBe(0);
    const callArg = runWorkflowMock.mock.calls[0]![0]!;
    expect(callArg.inputs).toEqual({ path: "/abs/path/to/file.ts" });
    expect(callArg.detach).toBe(true);
  });

  test("errors when --name doesn't match any registered workflow", async () => {
    const wf = makeWorkflow("demo", "claude");
    const runWorkflowMock = makeRunMock();

    const argv = ["bun", "fixture.ts", "--name", "missing"];

    let caught: ExitCalled | null = null;
    try {
      await hostWorkflows([wf], { argv, env: {}, runWorkflow: runWorkflowMock });
    } catch (e) {
      caught = e as ExitCalled;
    }

    expect(caught?.code).toBe(1);
    expect(capturedStderr.join("")).toContain("missing");
    expect(runWorkflowMock).not.toHaveBeenCalled();
  });

  test("errors when --name is ambiguous and --agent is omitted", async () => {
    const wfA = makeWorkflow("shared", "claude");
    const wfB = makeWorkflow("shared", "opencode");
    const runWorkflowMock = makeRunMock();

    const argv = ["bun", "fixture.ts", "--name", "shared"];

    let caught: ExitCalled | null = null;
    try {
      await hostWorkflows([wfA, wfB], { argv, env: {}, runWorkflow: runWorkflowMock });
    } catch (e) {
      caught = e as ExitCalled;
    }

    expect(caught?.code).toBe(1);
    expect(capturedStderr.join("")).toContain("Specify --agent");
    expect(runWorkflowMock).not.toHaveBeenCalled();
  });

  test("returns silently when --name is absent — does not interfere with caller's main()", async () => {
    const wf = makeWorkflow("demo", "claude");
    const runWorkflowMock = makeRunMock();

    const argv = ["bun", "fixture.ts", "--something-else", "value"];

    await hostWorkflows([wf], { argv, env: {}, runWorkflow: runWorkflowMock });

    expect(runWorkflowMock).not.toHaveBeenCalled();
    expect(capturedStdout.join("")).toBe("");
    expect(capturedStderr.join("")).toBe("");
  });
});
