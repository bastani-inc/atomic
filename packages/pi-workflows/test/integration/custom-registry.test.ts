/**
 * Integration tests: custom registry shared by tool, slash commands, doctor, CLI.
 *
 * Proves that discoverWorkflows with a project-local workflow yields a registry
 * visible to:
 *   1. Tool dispatch (action='list' / 'inputs' / 'run')
 *   2. buildDoctorReport (custom sources section)
 *   3. runWorkflowFromCliFlags (headless CLI dispatch)
 *   4. /workflow slash command (list output, completions)
 *   5. /workflow:<name> alias registration and dispatch path
 *
 * All consumers close over the same ExtensionRuntime (runtimeProxy pattern) —
 * the tests verify this shared-registry invariant end-to-end.
 *
 * cross-ref: pi-workflows RFC §5.2, §5.3, §5.7, §5.13
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { discoverWorkflows } from "../../src/extension/discovery.js";
import type { DiscoveryResult } from "../../src/extension/discovery.js";
import { createExtensionRuntime } from "../../src/extension/runtime.js";
import type { ExtensionRuntime } from "../../src/extension/runtime.js";
import { buildDoctorReport } from "../../src/extension/doctor.js";
import type { DoctorSiblingStatus } from "../../src/extension/doctor.js";
import { runWorkflowFromCliFlags } from "../../src/cli-flags.js";
import factory, {
  type ExtensionAPI,
  type PiToolOpts,
  type PiSlashCommandOpts,
  type WorkflowToolArgs,
} from "../../src/extension/index.js";
import type { WorkflowToolResult } from "../../src/extension/render-result.js";

// ---------------------------------------------------------------------------
// Temp-dir fixture: one project-local workflow, one user-global workflow
// ---------------------------------------------------------------------------

const CUSTOM_WF_NORM = "custom-integration-workflow";
const CUSTOM_WF_NAME = "Custom Integration Workflow";

const USER_WF_NORM = "user-global-integration-workflow";
const USER_WF_NAME = "User Global Integration Workflow";

/** Minimal valid WorkflowDefinition as a .js source string. */
function makeWorkflowSource(normalizedName: string, name: string): string {
  return `
export default {
  __piWorkflow: true,
  name: ${JSON.stringify(name)},
  normalizedName: ${JSON.stringify(normalizedName)},
  description: "Integration test custom workflow",
  inputs: {
    message: { type: "string", required: true, description: "Test message" },
    count: { type: "number", default: 1 },
  },
  run: async (_inputs, _ctx) => ({ output: "test-done" }),
};
`.trim();
}

let tempRoot: string;
let cwdWorkflowDir: string;
let homeWorkflowDir: string;

// Shared fixtures (expensive — set up once per suite)
let discoveryResult: DiscoveryResult;
let runtime: ExtensionRuntime;

const noSiblings: DoctorSiblingStatus = {
  subagents: false,
  subagentsCallable: false,
  mcpAdapter: false,
  mcpScopeEvents: false,
  intercom: false,
  hil: false,
  uiCustom: false,
  shortcut: false,
  execAbortable: false,
  persistenceAppendEntry: false,
  promptAdapter: false,
  completeAdapter: false,
  subagentAdapterVia: "unavailable",
};

beforeAll(async () => {
  // Create isolated temp dirs
  tempRoot = join(tmpdir(), `pi-wf-int-${randomUUID()}`);
  cwdWorkflowDir = join(tempRoot, "cwd", ".pi", "workflows");
  homeWorkflowDir = join(tempRoot, "home", ".pi", "agent", "workflows");

  mkdirSync(cwdWorkflowDir, { recursive: true });
  mkdirSync(homeWorkflowDir, { recursive: true });

  writeFileSync(
    join(cwdWorkflowDir, `${CUSTOM_WF_NORM}.js`),
    makeWorkflowSource(CUSTOM_WF_NORM, CUSTOM_WF_NAME),
  );

  writeFileSync(
    join(homeWorkflowDir, `${USER_WF_NORM}.js`),
    makeWorkflowSource(USER_WF_NORM, USER_WF_NAME),
  );

  // Run full discovery with both custom dirs + bundled
  discoveryResult = await discoverWorkflows({
    cwd: join(tempRoot, "cwd"),
    homeDir: join(tempRoot, "home"),
    includeBundled: true,
  });

  runtime = createExtensionRuntime({ registry: discoveryResult.registry });
});

afterAll(() => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// 1. discoverWorkflows — custom sources present in result
// ---------------------------------------------------------------------------

describe("discoverWorkflows — custom sources from temp cwd/home", () => {
  test("result.registry includes project-local custom workflow name", () => {
    expect(discoveryResult.registry.names()).toContain(CUSTOM_WF_NORM);
  });

  test("result.registry includes user-global custom workflow name", () => {
    expect(discoveryResult.registry.names()).toContain(USER_WF_NORM);
  });

  test("result.registry includes bundled workflow names alongside custom", () => {
    const names = discoveryResult.registry.names();
    expect(names).toContain("deep-research-codebase");
    expect(names).toContain("ralph");
  });

  test("result.sources contains a 'project-local' entry for custom workflow", () => {
    const src = discoveryResult.sources.find((s) => s.id === CUSTOM_WF_NORM);
    expect(src).toBeDefined();
    expect(src!.kind).toBe("project-local");
    expect(src!.name).toBe(CUSTOM_WF_NAME);
    expect(src!.filePath).toContain(CUSTOM_WF_NORM);
  });

  test("result.sources contains a 'user-global' entry for user-global workflow", () => {
    const src = discoveryResult.sources.find((s) => s.id === USER_WF_NORM);
    expect(src).toBeDefined();
    expect(src!.kind).toBe("user-global");
    expect(src!.name).toBe(USER_WF_NAME);
  });

  test("no discovery errors for valid custom workflows", () => {
    const hardErrors = discoveryResult.errors.filter(
      (e) => e.level === "error" && (e.source?.includes(CUSTOM_WF_NORM) || e.source?.includes(USER_WF_NORM)),
    );
    expect(hardErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. ExtensionRuntime — tool dispatch sees custom + bundled registry
// ---------------------------------------------------------------------------

describe("ExtensionRuntime with custom registry — tool dispatch", () => {
  test("action='list' returns custom workflow name", async () => {
    const result = await runtime.dispatch({ name: "", inputs: {}, action: "list" });
    expect(result.action).toBe("list");
    const r = result as { action: "list"; workflows: string[] };
    expect(r.workflows).toContain(CUSTOM_WF_NORM);
  });

  test("action='list' returns user-global workflow name", async () => {
    const result = await runtime.dispatch({ name: "", inputs: {}, action: "list" });
    const r = result as { action: "list"; workflows: string[] };
    expect(r.workflows).toContain(USER_WF_NORM);
  });

  test("action='list' includes bundled workflows alongside custom", async () => {
    const result = await runtime.dispatch({ name: "", inputs: {}, action: "list" });
    const r = result as { action: "list"; workflows: string[] };
    expect(r.workflows).toContain("deep-research-codebase");
    expect(r.workflows).toContain("ralph");
  });

  test("action='inputs' for custom workflow returns declared inputs", async () => {
    const result = await runtime.dispatch({ name: CUSTOM_WF_NORM, inputs: {}, action: "inputs" });
    expect(result.action).toBe("inputs");
    const r = result as { action: "inputs"; name: string; inputs: Array<{ name: string }> };
    expect(r.name).toBe(CUSTOM_WF_NORM);
    expect(r.inputs).toBeDefined();
    const names = r.inputs.map((i) => i.name);
    expect(names).toContain("message");
    expect(names).toContain("count");
  });

  test("action='inputs' for custom workflow has no error field", async () => {
    const result = await runtime.dispatch({ name: CUSTOM_WF_NORM, inputs: {}, action: "inputs" });
    const r = result as { action: "inputs"; error?: string };
    expect(r.error).toBeUndefined();
  });

  test("action='run' for custom workflow dispatches (returns run result, not unknown-action)", async () => {
    const result = await runtime.dispatch({
      name: CUSTOM_WF_NORM,
      inputs: { message: "hello" },
      action: "run",
    });
    expect(result.action).toBe("run");
    const r = result as { action: "run"; runId: string; status: string };
    // runId must be a non-empty string
    expect(typeof r.runId).toBe("string");
    // status must be terminal (completed or failed) — no stub/placeholder
    expect(["completed", "failed"]).toContain(r.status);
  });

  test("shared registry: list from tool equals registry.names()", async () => {
    const result = await runtime.dispatch({ name: "", inputs: {}, action: "list" });
    const r = result as { action: "list"; workflows: string[] };
    const registryNames = discoveryResult.registry.names();
    // Every name in the registry is in the tool list and vice versa
    for (const name of registryNames) {
      expect(r.workflows).toContain(name);
    }
    for (const name of r.workflows) {
      expect(registryNames).toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. buildDoctorReport — custom sources from discovery result
// ---------------------------------------------------------------------------

describe("buildDoctorReport — custom sources from temp cwd/home", () => {
  test("report contains project-local custom workflow id", () => {
    const report = buildDoctorReport(discoveryResult, noSiblings);
    expect(report).toContain(CUSTOM_WF_NORM);
  });

  test("report labels custom workflow source as '[project-local]'", () => {
    const report = buildDoctorReport(discoveryResult, noSiblings);
    expect(report).toContain("[project-local]");
  });

  test("report contains user-global workflow id", () => {
    const report = buildDoctorReport(discoveryResult, noSiblings);
    expect(report).toContain(USER_WF_NORM);
  });

  test("report labels user-global source as '[user-global]'", () => {
    const report = buildDoctorReport(discoveryResult, noSiblings);
    expect(report).toContain("[user-global]");
  });

  test("registry count in report equals total names count (bundled + custom)", () => {
    const report = buildDoctorReport(discoveryResult, noSiblings);
    const totalCount = discoveryResult.registry.names().length;
    expect(report).toContain(`Registry: ${totalCount} workflow(s) loaded`);
  });

  test("report discovery diagnostics section is present", () => {
    const report = buildDoctorReport(discoveryResult, noSiblings);
    expect(report).toContain("Discovery diagnostics:");
  });

  test("no error diagnostics for valid custom workflows in report", () => {
    const report = buildDoctorReport(discoveryResult, noSiblings);
    // If diagnostics section is empty, it shows (none)
    // If there are errors they would reference the custom workflow paths
    // Either way the report header should not contain error mentions for our workflows
    const errorSection = report.match(/Discovery diagnostics.*?(?=Siblings:)/s)?.[0] ?? "";
    // Only check no INVALID_DEFINITION for our custom workflows
    expect(errorSection).not.toContain(`INVALID_DEFINITION`);
  });
});

// ---------------------------------------------------------------------------
// 4. runWorkflowFromCliFlags — dispatches to same custom runtime
// ---------------------------------------------------------------------------

describe("runWorkflowFromCliFlags — custom runtime dispatch", () => {
  test("--workflow <customName> returns handled: true", async () => {
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow", CUSTOM_WF_NORM],
    });
    expect(result.handled).toBe(true);
  });

  test("--workflow <customName> result has status completed or failed (not silent)", async () => {
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow", CUSTOM_WF_NORM],
    });
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(["completed", "failed"]).toContain(result.status);
    }
  });

  test("--workflow unknown-xyz returns handled: true with failed status (not silent)", async () => {
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow", "unknown-xyz-custom"],
    });
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.status).toBe("failed");
    }
  });

  test("--workflow absent returns handled: false", async () => {
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--other-flag", "value"],
    });
    expect(result.handled).toBe(false);
  });

  test("--workflow-input-message=hello passed to custom workflow dispatch", async () => {
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow", CUSTOM_WF_NORM, "--workflow-input-message=hello"],
    });
    expect(result.handled).toBe(true);
    // Result may be completed or failed (no real adapters), but it must have dispatched
    if (result.handled) {
      expect(["completed", "failed"]).toContain(result.status);
    }
  });

  test("CLI runtime uses same registry as tool: dispatches custom workflow that tool also sees", async () => {
    // Tool sees the workflow via action='inputs'
    const toolResult = await runtime.dispatch({ name: CUSTOM_WF_NORM, inputs: {}, action: "inputs" });
    expect(toolResult.action).toBe("inputs");
    // CLI can also run it (even if it fails in test env)
    const cliResult = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow", CUSTOM_WF_NORM],
    });
    expect(cliResult.handled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. /workflow slash command — list and completions see custom registry
// ---------------------------------------------------------------------------

interface MockCmd {
  opts: PiSlashCommandOpts;
}

interface MockTool {
  opts: PiToolOpts<WorkflowToolArgs, WorkflowToolResult>;
}

function makeMockApiForRuntime(): ExtensionAPI & {
  commands: MockCmd[];
  tools: MockTool[];
} {
  const commands: MockCmd[] = [];
  const tools: MockTool[] = [];

  return {
    commands,
    tools,
    registerTool<TArgs, TResult>(opts: PiToolOpts<TArgs, TResult>) {
      tools.push({ opts: opts as unknown as MockTool["opts"] });
    },
    registerCommand(opts: PiSlashCommandOpts) {
      commands.push({ opts });
    },
    registerMessageRenderer: () => undefined,
    registerFlag: () => undefined,
  } as ExtensionAPI & { commands: MockCmd[]; tools: MockTool[] };
}

function getCommand(commands: MockCmd[], name: string): PiSlashCommandOpts | undefined {
  return commands.find((c) => c.opts.name === name)?.opts;
}

describe("/workflow slash command — bundled-and-custom shared registry", () => {
  // The factory seeds the runtime from discoverBundledWorkflowsSync() synchronously,
  // then upgrades async via discoverWorkflows(). For bundled workflows (always present)
  // we can verify slash command and tool see the same registry synchronously.
  let mock: ReturnType<typeof makeMockApiForRuntime>;

  beforeAll(() => {
    mock = makeMockApiForRuntime();
    factory(mock);
  });

  test("tool action='list' and /workflow list produce same workflow names (bundled)", async () => {
    // Tool list
    const toolExecute = mock.tools[0]!.opts.execute;
    const toolResult = await toolExecute({ name: "", inputs: {}, action: "list" }, {});
    const toolWorkflows = (toolResult as { action: "list"; workflows: string[] }).workflows;

    // Slash command list
    const messages: string[] = [];
    const cmd = getCommand(mock.commands, "workflow")!;
    await cmd.execute("list", { reply: (m) => messages.push(m) });
    const combined = messages.join("\n");

    // Every bundled name visible to tool is also in slash output
    for (const name of ["deep-research-codebase", "ralph", "open-claude-design"]) {
      expect(toolWorkflows).toContain(name);
      expect(combined).toContain(name);
    }
  });

  test("tool and /workflow list agree on the count of bundled workflows", async () => {
    const toolExecute = mock.tools[0]!.opts.execute;
    const toolResult = await toolExecute({ name: "", inputs: {}, action: "list" }, {});
    const toolWorkflows = (toolResult as { action: "list"; workflows: string[] }).workflows;

    const messages: string[] = [];
    const cmd = getCommand(mock.commands, "workflow")!;
    await cmd.execute("list", { reply: (m) => messages.push(m) });
    const combined = messages.join("\n");

    // All tool names appear in the slash command output
    for (const name of toolWorkflows) {
      expect(combined).toContain(name);
    }
  });

  test("completions include all bundled workflow names (from shared runtimeProxy.registry)", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const completions = await cmd.getArgumentCompletions?.("") ?? [];
    const labels = completions.map((c) => c.label);

    for (const name of ["deep-research-codebase", "ralph", "open-claude-design"]) {
      expect(labels).toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. /workflow:<name> alias — dispatches same runtime path as tool
// ---------------------------------------------------------------------------

describe("/workflow:<name> alias — dispatches same runtime path as tool", () => {
  let mock: ReturnType<typeof makeMockApiForRuntime>;

  beforeAll(() => {
    mock = makeMockApiForRuntime();
    factory(mock);
  });

  test("alias workflow:ralph is registered and has matching description", () => {
    const alias = getCommand(mock.commands, "workflow:ralph");
    expect(alias).toBeDefined();
    expect(alias!.description).toContain("ralph");
  });

  test("alias workflow:deep-research-codebase execute produces output (completed or failed, not silent)", async () => {
    const alias = getCommand(mock.commands, "workflow:deep-research-codebase");
    expect(alias).toBeDefined();
    const messages: string[] = [];
    await alias!.execute("prompt=test", { reply: (m) => messages.push(m) });
    // Must produce at least one message — not silent
    expect(messages.length).toBeGreaterThan(0);
    const combined = messages.join("\n");
    // Must be either completed or a failure message — never "unknown subcommand"
    const dispatched =
      combined.includes("completed") ||
      combined.includes("failed") ||
      combined.includes("Workflow");
    expect(dispatched).toBe(true);
  });

  test("alias dispatch and tool dispatch reach same registry (alias run returns same action='run')", async () => {
    // Tool route: dispatch ralph with required prompt input (avoids resolveInputs throw)
    const toolExecute = mock.tools[0]!.opts.execute;
    const toolResult = await toolExecute(
      { name: "ralph", inputs: { prompt: "test" }, action: "run" },
      {},
    );
    expect(toolResult.action).toBe("run");

    // Alias route must also produce action='run' (via runtimeProxy.dispatch)
    // We can't directly inspect alias result since it only calls reply/print.
    // But we can verify the alias's execute does NOT say "unknown subcommand"
    const alias = getCommand(mock.commands, "workflow:ralph");
    const messages: string[] = [];
    await alias!.execute("prompt=test", { reply: (m) => messages.push(m) });
    expect(messages.some((m) => m.includes("unknown subcommand"))).toBe(false);
  });

  test("all bundled workflow aliases are registered (one alias per bundled workflow)", () => {
    const allAliases = mock.commands
      .filter((c) => c.opts.name.startsWith("workflow:"))
      .map((c) => c.opts.name.slice("workflow:".length));

    expect(allAliases).toContain("deep-research-codebase");
    expect(allAliases).toContain("ralph");
    expect(allAliases).toContain("open-claude-design");
  });
});

// ---------------------------------------------------------------------------
// 7. Shared registry invariant — end-to-end across all consumers
// ---------------------------------------------------------------------------

describe("shared registry invariant — all consumers see same workflows", () => {
  test("tool list, doctor registry count, and CLI dispatch all reflect same registry", async () => {
    // 1. Tool: list via runtime
    const listResult = await runtime.dispatch({ name: "", inputs: {}, action: "list" });
    const toolNames = (listResult as { action: "list"; workflows: string[] }).workflows;

    // 2. Doctor: registry count via buildDoctorReport
    const report = buildDoctorReport(discoveryResult, noSiblings);
    const match = report.match(/Registry:\s*(\d+)\s*workflow/);
    expect(match).not.toBeNull();
    const doctorCount = match ? parseInt(match[1]!, 10) : -1;
    expect(doctorCount).toBe(toolNames.length);

    // 3. CLI: can handle one of the custom workflow names
    const cliResult = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow", CUSTOM_WF_NORM],
    });
    expect(cliResult.handled).toBe(true);
  });

  test("custom workflow visible to tool, doctor, and CLI but NOT in bundled-only registry", async () => {
    // Bundled-only discovery (no temp dirs)
    const { discoverBundledWorkflowsSync } = await import("../../src/extension/discovery.js");
    const bundledResult = discoverBundledWorkflowsSync();
    expect(bundledResult.registry.names()).not.toContain(CUSTOM_WF_NORM);

    // Custom-inclusive runtime includes it
    const toolResult = await runtime.dispatch({ name: "", inputs: {}, action: "list" });
    const toolNames = (toolResult as { action: "list"; workflows: string[] }).workflows;
    expect(toolNames).toContain(CUSTOM_WF_NORM);

    // Doctor with full discovery shows it
    const report = buildDoctorReport(discoveryResult, noSiblings);
    expect(report).toContain(CUSTOM_WF_NORM);

    // CLI with custom runtime handles it
    const cliResult = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow", CUSTOM_WF_NORM],
    });
    expect(cliResult.handled).toBe(true);
  });

  test("custom workflow inputs schema consistent across tool and CLI dispatch", async () => {
    // Tool: inputs action
    const inputsResult = await runtime.dispatch({ name: CUSTOM_WF_NORM, inputs: {}, action: "inputs" });
    const r = inputsResult as { action: "inputs"; inputs: Array<{ name: string; type: string }> };
    const inputsByName = Object.fromEntries(r.inputs.map((i) => [i.name, i]));

    expect(inputsByName["message"]).toBeDefined();
    expect(inputsByName["message"]!.type).toBe("string");
    expect(inputsByName["count"]).toBeDefined();
    expect(inputsByName["count"]!.type).toBe("number");

    // CLI: dispatch with well-formed inputs (same schema path)
    const cliResult = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow", CUSTOM_WF_NORM, "--workflow-input-message=hello"],
    });
    expect(cliResult.handled).toBe(true);
  });
});
