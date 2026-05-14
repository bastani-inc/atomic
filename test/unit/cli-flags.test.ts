/**
 * cli-flags regression tests.
 * Covers: parseWorkflowFlags, registerWorkflowCliFlags, runWorkflowFromCliFlags.
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWorkflowFlags,
  registerWorkflowCliFlags,
  runWorkflowFromCliFlags,
} from "../../src/runs/shared/cli-flags.js";
import type { ExtensionAPI, PiFlagNamedOpts } from "../../src/extension/index.js";
import type { ExtensionRuntime } from "../../src/extension/runtime.js";
import type { WorkflowToolArgs } from "../../src/extension/index.js";
import type { WorkflowToolResult } from "../../src/extension/render-result.js";
import type { WorkflowDefinition, WorkflowInputSchema } from "../../src/shared/types.js";

function writeInputsFile(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "atomic-cli-flags-"));
  const path = join(dir, "inputs.json");
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

function makeDef(name: string, inputs: Record<string, WorkflowInputSchema>): WorkflowDefinition {
  return {
    __piWorkflow: true,
    name,
    normalizedName: name,
    description: "",
    inputs,
    run: async () => ({}),
  };
}

// ---------------------------------------------------------------------------
// parseWorkflowFlags
// ---------------------------------------------------------------------------

describe("parseWorkflowFlags", () => {
  test("returns null when --workflow absent", () => {
    assert.equal(parseWorkflowFlags([]), null);
    assert.equal(parseWorkflowFlags(["--other=val"]), null);
  });

  test("--workflow=<name>", () => {
    const r = parseWorkflowFlags(["--workflow=my-flow"]);
    assert.deepEqual(r, { workflow: "my-flow", inputs: {} });
  });

  test("--workflow <name> (space-separated)", () => {
    const r = parseWorkflowFlags(["--workflow", "my-flow"]);
    assert.deepEqual(r, { workflow: "my-flow", inputs: {} });
  });

  test("--workflow does NOT consume next flag token when it starts with --", () => {
    const r = parseWorkflowFlags(["--workflow", "--other"]);
    // --other starts with --, so no valid name token; workflow remains null → null result.
    assert.equal(r, null);
  });

  test("--workflow-inputs=<json> populates inputs", () => {
    const r = parseWorkflowFlags([
      "--workflow=flow",
      '--workflow-inputs={"prompt":"hello","count":3,"dry":true}',
    ]);
    assert.deepEqual(r?.inputs, { prompt: "hello", count: 3, dry: true });
    assert.equal(r?.error, undefined);
  });

  test("--workflow-inputs <json> space-separated", () => {
    const r = parseWorkflowFlags([
      "--workflow=flow",
      "--workflow-inputs",
      '{"prompt":"hello"}',
    ]);
    assert.deepEqual(r?.inputs, { prompt: "hello" });
  });

  test("--workflow-inputs empty object → empty inputs", () => {
    const r = parseWorkflowFlags(["--workflow=flow", "--workflow-inputs={}"]);
    assert.deepEqual(r?.inputs, {});
  });

  test("--workflow-inputs without value → empty inputs (no error)", () => {
    const r = parseWorkflowFlags(["--workflow=flow", "--workflow-inputs"]);
    assert.deepEqual(r?.inputs, {});
    assert.equal(r?.error, undefined);
  });

  test("repeated --workflow-inputs: last wins", () => {
    const r = parseWorkflowFlags([
      "--workflow=flow",
      '--workflow-inputs={"a":1}',
      '--workflow-inputs={"b":2}',
    ]);
    assert.deepEqual(r?.inputs, { b: 2 });
  });

  test("malformed JSON: error set, inputs empty (does not throw)", () => {
    const r = parseWorkflowFlags(["--workflow=flow", "--workflow-inputs={prompt:hello}"]);
    assert.notEqual(r, null);
    assert.deepEqual(r?.inputs, {});
    assert.ok(r?.error?.includes("--workflow-inputs"));
  });

  test("non-object JSON (array) rejected as error", () => {
    const r = parseWorkflowFlags(["--workflow=flow", "--workflow-inputs=[1,2]"]);
    assert.notEqual(r?.error, undefined);
    assert.deepEqual(r?.inputs, {});
  });

  test("non-object JSON (scalar) rejected as error", () => {
    const r = parseWorkflowFlags(["--workflow=flow", "--workflow-inputs=42"]);
    assert.notEqual(r?.error, undefined);
  });

  test("string and number values preserved as-typed inside JSON", () => {
    const r = parseWorkflowFlags([
      "--workflow=release",
      '--workflow-inputs={"prompt":"hello","max":3,"dryRun":true,"options":{"a":1}}',
    ]);
    assert.deepEqual(r?.inputs, {
      prompt: "hello",
      max: 3,
      dryRun: true,
      options: { a: 1 },
    });
  });

  test("ignores unrelated flags between --workflow and --workflow-inputs", () => {
    const r = parseWorkflowFlags([
      "--headless",
      "--workflow=deploy",
      "--some-other=thing",
      '--workflow-inputs={"region":"us-east-1"}',
    ]);
    assert.equal(r?.workflow, "deploy");
    assert.deepEqual(r?.inputs, { region: "us-east-1" });
  });

  test("--inputs=<path> captures the path", () => {
    const r = parseWorkflowFlags([
      "--workflow=flow",
      "--inputs=/tmp/inputs.json",
    ]);
    assert.equal(r?.inputsFile, "/tmp/inputs.json");
    assert.deepEqual(r?.inputs, {});
    assert.equal(r?.error, undefined);
  });

  test("--inputs <path> space-separated", () => {
    const r = parseWorkflowFlags([
      "--workflow=flow",
      "--inputs",
      "/tmp/inputs.json",
    ]);
    assert.equal(r?.inputsFile, "/tmp/inputs.json");
  });

  test("both --workflow-inputs and --inputs → error (mutually exclusive)", () => {
    const r = parseWorkflowFlags([
      "--workflow=flow",
      '--workflow-inputs={"a":1}',
      "--inputs=/tmp/x.json",
    ]);
    assert.match(r?.error ?? "", /mutually exclusive/i);
  });
});

// ---------------------------------------------------------------------------
// registerWorkflowCliFlags
// ---------------------------------------------------------------------------

describe("registerWorkflowCliFlags", () => {
  function registeredFlags(): Array<{ name: string; opts: PiFlagNamedOpts }> {
    const calls: Array<{ name: string; opts: PiFlagNamedOpts }> = [];
    registerWorkflowCliFlags({
      registerFlag: (name, opts) => {
        calls.push({ name, opts });
      },
    });
    return calls;
  }

  test("registers literal workflow and workflow-inputs flags", () => {
    const flags = registeredFlags();
    const names = flags.map((flag) => flag.name);
    assert.ok(names.includes("workflow"));
    assert.ok(names.includes("workflow-inputs"));
    assert.equal(flags.find((flag) => flag.name === "workflow")?.opts.type, "string");
    assert.equal(flags.find((flag) => flag.name === "workflow-inputs")?.opts.type, "string");
  });

  test("does NOT register placeholder/dynamic flag names (pi only supports literal names)", () => {
    const flags = registeredFlags();
    const names = flags.map((flag) => flag.name);
    for (const name of names) {
      assert.ok(!name.includes("<"), `flag name must be literal, got "${name}"`);
    }
  });

  test("degrades silently when registerFlag absent", () => {
    const pi: ExtensionAPI = {};
    // Should not throw
    assert.doesNotThrow(() => registerWorkflowCliFlags(pi));
  });

  test("opts exclude name; descriptions and types preserved (canonical Pi-shaped mock)", () => {
    const flags = registeredFlags();
    const workflow = flags.find((flag) => flag.name === "workflow");
    const inputs = flags.find((flag) => flag.name === "workflow-inputs");

    assert.notEqual(workflow, undefined);
    assert.notEqual(inputs, undefined);
    assert.equal("name" in workflow!.opts, false);
    assert.equal("name" in inputs!.opts, false);
    assert.equal(workflow!.opts.type, "string");
    assert.equal(inputs!.opts.type, "string");
    assert.equal(typeof workflow!.opts.description, "string");
    assert.ok(workflow!.opts.description.length > 0);
    assert.equal(typeof inputs!.opts.description, "string");
    assert.ok(inputs!.opts.description.length > 0);
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
      dispatch: (args) => dispatchImpl({ name: args.workflow ?? "", inputs: args.inputs ?? {} }),
      runDirect: async () => ({
        mode: "single",
        action: "run",
        status: "failed",
        error: "direct execution unavailable in cli flag test runtime",
      }),
    };
  }

  test("returns handled:false when --workflow absent", async () => {
    const runtime = makeRuntime(async () => ({ action: "list", items: [] }));
    const result = await runWorkflowFromCliFlags({ runtime, argv: ["--headless"] });
    assert.equal(result.handled, false);
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
      argv: ["--workflow=deploy", '--workflow-inputs={"env":"prod","count":2}'],
    });

    assert.equal(result.handled, true);
    assert.equal(capture.args?.name, "deploy");
    assert.deepEqual(capture.args?.inputs, { env: "prod", count: 2 });
  });

  test("malformed --workflow-inputs JSON returns status:failed without dispatching", async () => {
    let dispatched = false;
    const runtime = makeRuntime(async () => {
      dispatched = true;
      return { action: "run", name: "flow", runId: "r1", status: "completed", stages: [] };
    });
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=flow", "--workflow-inputs={oops}"],
    });
    assert.equal(dispatched, false);
    assert.equal(result.handled, true);
    if (result.handled) {
      assert.equal(result.status, "failed");
      assert.ok(result.error?.includes("--workflow-inputs"));
    }
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
    assert.equal(result.handled, true);
    if (result.handled) {
      assert.equal(result.status, "completed");
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
    assert.equal(result.handled, true);
    if (result.handled) {
      assert.equal(result.status, "failed");
      assert.ok(result.error!.includes("not found"));
    }
  });

  test("returns status:failed on dispatch throw", async () => {
    const runtime = makeRuntime(async () => {
      throw new Error("executor exploded");
    });
    const result = await runWorkflowFromCliFlags({ runtime, argv: ["--workflow=flow"] });
    assert.equal(result.handled, true);
    if (result.handled) {
      assert.equal(result.status, "failed");
      assert.ok(result.error!.includes("executor exploded"));
    }
  });

  test("space-separated --workflow <name>", async () => {
    let name = "";
    const runtime = makeRuntime(async (args) => {
      name = args.name;
      return { action: "run", name: args.name, runId: "r1", status: "completed", stages: [] };
    });
    await runWorkflowFromCliFlags({ runtime, argv: ["--workflow", "my-flow"] });
    assert.equal(name, "my-flow");
  });

  test("uses process.argv when argv not provided (smoke, does not throw)", async () => {
    // process.argv won't have --workflow; handled:false expected
    const runtime = makeRuntime(async () => ({ action: "list", items: [] }));
    const result = await runWorkflowFromCliFlags({ runtime });
    // We only verify it doesn't throw and returns a result
    assert.equal(typeof result.handled, "boolean");
  });

  test("dispatch payload contains action:run, workflow, and inputs", async () => {
    let captured: WorkflowToolArgs | null = null;
    const runtime: ExtensionRuntime = {
      get registry() {
        return { names: () => [], get: () => undefined } as unknown as ExtensionRuntime["registry"];
      },
      dispatch: async (args) => {
        captured = args;
        return { action: "run", name: args.workflow ?? "", runId: "r1", status: "completed", stages: [] };
      },
      runDirect: async () => ({
        mode: "single",
        action: "run",
        status: "failed",
        error: "direct execution unavailable in cli flag test runtime",
      }),
    };
    await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=release", '--workflow-inputs={"prompt":"hello","max":3}'],
    });
    assert.notEqual(captured, null);
    const c = captured!;
    assert.equal(c.action, "run");
    assert.equal(c.workflow, "release");
    assert.deepEqual((c as WorkflowToolArgs & { inputs: Record<string, unknown> }).inputs, {
      prompt: "hello",
      max: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// runWorkflowFromCliFlags — --inputs
// ---------------------------------------------------------------------------

function makeRuntimeWithRegistry(
  defs: WorkflowDefinition[],
  dispatchImpl: (args: { name: string; inputs: Record<string, unknown> }) => Promise<WorkflowToolResult>,
): ExtensionRuntime {
  const byName = new Map(defs.map((d) => [d.normalizedName, d]));
  return {
    get registry() {
      return {
        names: () => [...byName.keys()],
        get: (n: string) => byName.get(n),
      } as unknown as ExtensionRuntime["registry"];
    },
    dispatch: (args) => dispatchImpl({ name: args.workflow ?? "", inputs: args.inputs ?? {} }),
    runDirect: async () => ({
      mode: "single",
      action: "run",
      status: "failed",
      error: "direct execution unavailable in cli flag test runtime",
    }),
  };
}

describe("runWorkflowFromCliFlags — --inputs", () => {
  test("reads + parses inputs from a JSON file", async () => {
    const path = writeInputsFile({ prompt: "from-file", count: 5 });
    let captured: Record<string, unknown> | null = null;
    const runtime = makeRuntimeWithRegistry([], async (args) => {
      captured = args.inputs;
      return { action: "run", name: args.name, runId: "r1", status: "completed", stages: [] };
    });
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=flow", `--inputs=${path}`],
    });
    assert.equal(result.handled, true);
    assert.deepEqual(captured, { prompt: "from-file", count: 5 });
  });

  test("missing file: status:failed without dispatching", async () => {
    let dispatched = false;
    const runtime = makeRuntimeWithRegistry([], async () => {
      dispatched = true;
      return { action: "run", name: "flow", runId: "r1", status: "completed", stages: [] };
    });
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=flow", "--inputs=/no/such/path/inputs.json"],
    });
    assert.equal(dispatched, false);
    assert.equal(result.handled, true);
    if (result.handled) {
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /--inputs/);
    }
  });

  test("file with malformed JSON: status:failed without dispatching", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-bad-"));
    const badPath = join(dir, "bad.json");
    writeFileSync(badPath, "{not valid json");
    let dispatched = false;
    const runtime = makeRuntimeWithRegistry([], async () => {
      dispatched = true;
      return { action: "run", name: "flow", runId: "r1", status: "completed", stages: [] };
    });
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=flow", `--inputs=${badPath}`],
    });
    assert.equal(dispatched, false);
    if (result.handled) {
      assert.equal(result.status, "failed");
    }
  });

  test("file containing non-object JSON: status:failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-arr-"));
    const arrPath = join(dir, "arr.json");
    writeFileSync(arrPath, "[1,2,3]");
    const runtime = makeRuntimeWithRegistry([], async () => ({
      action: "run", name: "flow", runId: "r1", status: "completed", stages: [],
    }));
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=flow", `--inputs=${arrPath}`],
    });
    if (result.handled) {
      assert.equal(result.status, "failed");
    }
  });

  test("file inputs with schema errors report --inputs", async () => {
    const path = writeInputsFile({ prompt: "hi", count: "three" });
    const def = makeDef("flow", {
      prompt: { type: "text", required: true },
      count: { type: "number" },
    });
    let dispatched = false;
    const runtime = makeRuntimeWithRegistry([def], async () => {
      dispatched = true;
      return { action: "run", name: "flow", runId: "r1", status: "completed", stages: [] };
    });

    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=flow", `--inputs=${path}`],
    });

    assert.equal(dispatched, false);
    assert.equal(result.handled, true);
    if (result.handled) {
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /Invalid --inputs/);
      assert.match(result.error ?? "", /count/);
      assert.match(result.error ?? "", /number/);
    }
  });
});

// ---------------------------------------------------------------------------
// runWorkflowFromCliFlags — schema validation
// ---------------------------------------------------------------------------

describe("runWorkflowFromCliFlags — --workflow-help", () => {
  test("prints input schema without dispatching when --workflow-help is set", async () => {
    const def = makeDef("flow", {
      prompt: { type: "text", required: true, description: "Topic" },
      max: { type: "number", default: 3 },
    });
    let dispatched = false;
    const runtime = makeRuntimeWithRegistry([def], async () => {
      dispatched = true;
      return { action: "run", name: "flow", runId: "r1", status: "completed", stages: [] };
    });
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=flow", "--workflow-help"],
    });
    assert.equal(dispatched, false);
    assert.equal(result.handled, true);
    if (result.handled) {
      assert.equal(result.status, "completed");
      assert.match(result.message ?? "", /Inputs for "flow"/);
      assert.match(result.message ?? "", /prompt/);
      assert.match(result.message ?? "", /max/);
    }
  });

  test("--workflow-help on unknown workflow reports not-found with available list", async () => {
    const runtime = makeRuntimeWithRegistry([makeDef("alpha", {})], async () => ({
      action: "run", name: "ghost", runId: "", status: "completed", stages: [],
    }));
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=ghost", "--workflow-help"],
    });
    if (result.handled) {
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /ghost/);
    }
  });
});

describe("runWorkflowFromCliFlags — schema validation", () => {
  test("wrong-typed input: status:failed without dispatching; error names the offending key", async () => {
    const def = makeDef("flow", {
      prompt: { type: "text", required: true },
      count: { type: "number" },
    });
    let dispatched = false;
    const runtime = makeRuntimeWithRegistry([def], async () => {
      dispatched = true;
      return { action: "run", name: "flow", runId: "r1", status: "completed", stages: [] };
    });
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=flow", '--workflow-inputs={"prompt":"hi","count":"three"}'],
    });
    assert.equal(dispatched, false);
    if (result.handled) {
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /count/);
      assert.match(result.error ?? "", /number/);
    }
  });

  test("unknown input key: status:failed without dispatching", async () => {
    const def = makeDef("flow", { prompt: { type: "text", required: true } });
    let dispatched = false;
    const runtime = makeRuntimeWithRegistry([def], async () => {
      dispatched = true;
      return { action: "run", name: "flow", runId: "r1", status: "completed", stages: [] };
    });
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=flow", '--workflow-inputs={"prompt":"hi","propmt":"typo"}'],
    });
    assert.equal(dispatched, false);
    if (result.handled) {
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /propmt/);
    }
  });

  test("missing required input: status:failed without dispatching", async () => {
    const def = makeDef("flow", { prompt: { type: "text", required: true } });
    let dispatched = false;
    const runtime = makeRuntimeWithRegistry([def], async () => {
      dispatched = true;
      return { action: "run", name: "flow", runId: "r1", status: "completed", stages: [] };
    });
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=flow"],
    });
    assert.equal(dispatched, false);
    if (result.handled) {
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /prompt/);
    }
  });

  test("valid inputs: dispatches normally", async () => {
    const def = makeDef("flow", {
      prompt: { type: "text", required: true },
      count: { type: "number" },
    });
    let captured: Record<string, unknown> | null = null;
    const runtime = makeRuntimeWithRegistry([def], async (args) => {
      captured = args.inputs;
      return { action: "run", name: args.name, runId: "r1", status: "completed", stages: [] };
    });
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=flow", '--workflow-inputs={"prompt":"hi","count":3}'],
    });
    assert.equal(result.handled, true);
    assert.deepEqual(captured, { prompt: "hi", count: 3 });
    if (result.handled) assert.equal(result.status, "completed");
  });

  test("validation skipped when workflow not in registry (lets dispatch report not-found)", async () => {
    let dispatched = false;
    const runtime = makeRuntimeWithRegistry([], async () => {
      dispatched = true;
      return {
        action: "run",
        name: "ghost",
        runId: "",
        status: "failed",
        error: 'Workflow not found: "ghost"',
        stages: [],
      };
    });
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow=ghost", '--workflow-inputs={"anything":1}'],
    });
    assert.equal(dispatched, true);
    if (result.handled) assert.equal(result.status, "failed");
  });
});
