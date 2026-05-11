/**
 * cli-flags regression tests.
 * Covers: parseWorkflowFlags, registerWorkflowCliFlags, runWorkflowFromCliFlags.
 */

import { test, expect, describe } from "bun:test";
import {
  parseWorkflowFlags,
  registerWorkflowCliFlags,
  runWorkflowFromCliFlags,
} from "./cli-flags.js";
import type { WorkflowFlagValues } from "./cli-flags.js";
import type { ExtensionAPI } from "./extension/index.js";
import type { ExtensionRuntime } from "./extension/runtime.js";
import type { WorkflowToolArgs } from "./extension/index.js";
import type { WorkflowToolResult } from "./extension/render-result.js";

// ---------------------------------------------------------------------------
// parseWorkflowFlags
// ---------------------------------------------------------------------------

describe("parseWorkflowFlags", () => {
  test("returns null when --workflow absent", () => {
    expect(parseWorkflowFlags([])).toBeNull();
    expect(parseWorkflowFlags(["--other=val"])).toBeNull();
  });

  test("--workflow=<name>", () => {
    const r = parseWorkflowFlags(["--workflow=my-flow"]);
    expect(r).toEqual<WorkflowFlagValues>({ workflow: "my-flow", inputs: {} });
  });

  test("--workflow <name> (space-separated)", () => {
    const r = parseWorkflowFlags(["--workflow", "my-flow"]);
    expect(r).toEqual<WorkflowFlagValues>({ workflow: "my-flow", inputs: {} });
  });

  test("--workflow does NOT consume next flag token when it starts with --", () => {
    const r = parseWorkflowFlags(["--workflow", "--other"]);
    // --other starts with --, so no valid name token; workflow remains null → null result.
    expect(r).toBeNull();
  });

  test("--workflow-input-<key>=<value> string", () => {
    const r = parseWorkflowFlags(["--workflow=flow", "--workflow-input-env=production"]);
    expect(r).toEqual<WorkflowFlagValues>({
      workflow: "flow",
      inputs: { env: "production" },
    });
  });

  test("--workflow-input-<key>=<value> number JSON-parsed", () => {
    const r = parseWorkflowFlags(["--workflow=flow", "--workflow-input-count=42"]);
    expect(r?.inputs.count).toBe(42);
  });

  test("--workflow-input-<key>=<value> boolean JSON-parsed", () => {
    const r = parseWorkflowFlags(["--workflow=flow", "--workflow-input-dry=true"]);
    expect(r?.inputs.dry).toBe(true);
  });

  test("--workflow-input-<key>=<value> object JSON-parsed", () => {
    const r = parseWorkflowFlags([
      "--workflow=flow",
      '--workflow-input-cfg={"k":"v"}',
    ]);
    expect(r?.inputs.cfg).toEqual({ k: "v" });
  });

  test("--workflow-input-<key> <value> space-separated", () => {
    const r = parseWorkflowFlags(["--workflow=flow", "--workflow-input-env", "staging"]);
    expect(r?.inputs.env).toBe("staging");
  });

  test("--workflow-input-<key> with no value → true", () => {
    const r = parseWorkflowFlags(["--workflow=flow", "--workflow-input-verbose"]);
    expect(r?.inputs.verbose).toBe(true);
  });

  test("multiple inputs", () => {
    const r = parseWorkflowFlags([
      "--workflow=flow",
      "--workflow-input-env=prod",
      "--workflow-input-count=3",
      "--workflow-input-dry=false",
    ]);
    expect(r?.inputs).toEqual({ env: "prod", count: 3, dry: false });
  });

  test("mixed positional flags ignored", () => {
    const r = parseWorkflowFlags([
      "--headless",
      "--workflow=deploy",
      "--some-other=thing",
      "--workflow-input-region=us-east-1",
    ]);
    expect(r?.workflow).toBe("deploy");
    expect(r?.inputs).toEqual({ region: "us-east-1" });
  });

  // Task-spec named inputs
  test("--workflow-input-prompt=hello → string", () => {
    const r = parseWorkflowFlags(["--workflow=flow", "--workflow-input-prompt=hello"]);
    expect(r?.inputs.prompt).toBe("hello");
  });

  test("--workflow-input-max=3 → number", () => {
    const r = parseWorkflowFlags(["--workflow=flow", "--workflow-input-max=3"]);
    expect(r?.inputs.max).toBe(3);
  });

  test("--workflow-input-dryRun=true → boolean (camelCase key preserved)", () => {
    const r = parseWorkflowFlags(["--workflow=flow", "--workflow-input-dryRun=true"]);
    expect(r?.inputs.dryRun).toBe(true);
  });

  test('--workflow-input-options={"a":1} → parsed object', () => {
    const r = parseWorkflowFlags(["--workflow=flow", '--workflow-input-options={"a":1}']);
    expect(r?.inputs.options).toEqual({ a: 1 });
  });

  test("--workflow-input-prompt <value> space-separated", () => {
    const r = parseWorkflowFlags(["--workflow=flow", "--workflow-input-prompt", "hello"]);
    expect(r?.inputs.prompt).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// registerWorkflowCliFlags
// ---------------------------------------------------------------------------

describe("registerWorkflowCliFlags", () => {
  test("registers workflow and workflow-input-key flags", () => {
    const registered: Array<{ name: string; type?: string }> = [];
    const pi: ExtensionAPI = {
      registerFlag: (opts) => { registered.push(opts); },
    };
    registerWorkflowCliFlags(pi);
    const names = registered.map((r) => r.name);
    expect(names).toContain("workflow");
    expect(names).toContain("workflow-input-key");
    const wf = registered.find((r) => r.name === "workflow");
    expect(wf?.type).toBe("string");
  });

  test("degrades silently when registerFlag absent", () => {
    const pi: ExtensionAPI = {};
    // Should not throw
    expect(() => registerWorkflowCliFlags(pi)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runWorkflowFromCliFlags
// ---------------------------------------------------------------------------

describe("runWorkflowFromCliFlags", () => {
  function makeRuntime(dispatchImpl: (args: { name: string; inputs: Record<string, unknown> }) => Promise<WorkflowToolResult>): ExtensionRuntime {
    return {
      get registry() {
        return { names: () => [], get: () => undefined } as unknown as ExtensionRuntime["registry"];
      },
      dispatch: (args) => dispatchImpl({ name: args.name, inputs: args.inputs as Record<string, unknown> }),
    };
  }

  test("returns handled:false when --workflow absent", async () => {
    const runtime = makeRuntime(async () => ({ action: "list", workflows: [] }));
    const result = await runWorkflowFromCliFlags({ runtime, argv: ["--headless"] });
    expect(result.handled).toBe(false);
  });

  test("dispatches with correct name and inputs", async () => {
    const capture: { args: { name: string; inputs: Record<string, unknown> } | null } = { args: null };
    const runtime = makeRuntime(async (args) => {
      capture.args = args;
      return {
        action: "run",
        name: args.name,
        runId: "run-1",
        status: "completed",
        stages: [],
      };
    });

    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=deploy", "--workflow-input-env=prod", "--workflow-input-count=2"],
    });

    expect(result.handled).toBe(true);
    expect(capture.args?.name).toBe("deploy");
    expect(capture.args?.inputs).toEqual({ env: "prod", count: 2 });
  });

  test("returns status:completed on successful run", async () => {
    const runtime = makeRuntime(async () => ({
      action: "run",
      name: "flow",
      runId: "r1",
      status: "completed",
      stages: [],
    }));
    const result = await runWorkflowFromCliFlags({ runtime, argv: ["--workflow=flow"] });
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.status).toBe("completed");
    }
  });

  test("returns status:failed when dispatch result is failed", async () => {
    const runtime = makeRuntime(async () => ({
      action: "run",
      name: "flow",
      runId: "",
      status: "failed",
      error: "Workflow not found: \"flow\"",
      stages: [],
    }));
    const result = await runWorkflowFromCliFlags({ runtime, argv: ["--workflow=flow"] });
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.status).toBe("failed");
      expect(result.error).toContain("not found");
    }
  });

  test("returns status:failed on dispatch throw", async () => {
    const runtime = makeRuntime(async () => {
      throw new Error("executor exploded");
    });
    const result = await runWorkflowFromCliFlags({ runtime, argv: ["--workflow=flow"] });
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.status).toBe("failed");
      expect(result.error).toContain("executor exploded");
    }
  });

  test("space-separated --workflow <name>", async () => {
    let name = "";
    const runtime = makeRuntime(async (args) => {
      name = args.name;
      return { action: "run", name: args.name, runId: "r1", status: "completed", stages: [] };
    });
    await runWorkflowFromCliFlags({ runtime, argv: ["--workflow", "my-flow"] });
    expect(name).toBe("my-flow");
  });

  test("uses process.argv when argv not provided (smoke, does not throw)", async () => {
    // process.argv won't have --workflow; handled:false expected
    const runtime = makeRuntime(async () => ({ action: "list", workflows: [] }));
    const result = await runWorkflowFromCliFlags({ runtime });
    // We only verify it doesn't throw and returns a result
    expect(typeof result.handled).toBe("boolean");
  });

  test("dispatch payload contains action:run, name, and inputs", async () => {
    let captured: WorkflowToolArgs | null = null;
    const runtime: ExtensionRuntime = {
      get registry() {
        return { names: () => [], get: () => undefined } as unknown as ExtensionRuntime["registry"];
      },
      dispatch: async (args) => {
        captured = args;
        return { action: "run", name: args.name!, runId: "r1", status: "completed", stages: [] };
      },
    };
    await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=release", "--workflow-input-prompt=hello", "--workflow-input-max=3"],
    });
    expect(captured).not.toBeNull();
    const c = captured!;
    expect(c.action).toBe("run");
    expect(c.name).toBe("release");
    expect((c as WorkflowToolArgs & { inputs: Record<string, unknown> }).inputs).toEqual({
      prompt: "hello",
      max: 3,
    });
  });
});
