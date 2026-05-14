/**
 * Integration tests: custom registry shared by tool, slash commands, doctor, CLI.
 *
 * Proves that discoverWorkflows with a project-local workflow yields a registry
 * visible to:
 *   1. Tool dispatch (action='list' / 'inputs' / 'run')
 *   2. buildDoctorReport (custom sources section)
 *   3. runWorkflowFromCliFlags (headless CLI dispatch)
 *   4. /workflow slash command (list output, completions)
 *   5. no per-workflow /workflow:<name> aliases; /workflow <name> dispatch path
 *
 * All consumers close over the same ExtensionRuntime (runtimeProxy pattern) —
 * the tests verify this shared-registry invariant end-to-end.
 *
 * cross-ref: pi-workflows RFC §5.2, §5.3, §5.7, §5.13
 */

import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { discoverWorkflows } from "../../src/extension/discovery.js";
import type { DiscoveryResult } from "../../src/extension/discovery.js";
import { createExtensionRuntime } from "../../src/extension/runtime.js";
import type { ExtensionRuntime } from "../../src/extension/runtime.js";
import { buildDoctorPayload, buildDoctorReport } from "../../src/extension/doctor.js";
import type { DoctorSiblingStatus } from "../../src/extension/doctor.js";
import { runWorkflowFromCliFlags } from "../../src/runs/shared/cli-flags.js";
import factory, {
  type ExtensionAPI,
  type PiToolOpts,
  type PiCommandOptions,
  type WorkflowToolArgs,
} from "../../src/extension/index.js";
import type { WorkflowToolResult } from "../../src/extension/render-result.js";
import { waitForRun } from "../support/helpers.ts";
import { store as defaultStore } from "../../src/shared/store.ts";

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
  taskDelegation: false,
  mcpScopeEvents: false,
  sessionNaming: false,
  hil: false,
  uiCustom: false,
  shortcut: false,
  persistenceAppendEntry: false,
  subagentAdapterVia: "unavailable",
};

function doctorReport(discovery: DiscoveryResult, siblings: DoctorSiblingStatus): string {
  return buildDoctorReport(buildDoctorPayload({
    discovery,
    siblings,
    companions: [],
  }));
}

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
    assert.ok(discoveryResult.registry.names().includes(CUSTOM_WF_NORM));
  });

  test("result.registry includes user-global custom workflow name", () => {
    assert.ok(discoveryResult.registry.names().includes(USER_WF_NORM));
  });

  test("result.registry includes bundled workflow names alongside custom", () => {
    const names = discoveryResult.registry.names();
    assert.ok(names.includes("deep-research-codebase"));
    assert.ok(names.includes("ralph"));
  });

  test("result.sources contains a 'project-local' entry for custom workflow", () => {
    const src = discoveryResult.sources.find((s) => s.id === CUSTOM_WF_NORM);
    assert.notEqual(src, undefined);
    assert.equal(src!.kind, "project-local");
    assert.equal(src!.name, CUSTOM_WF_NAME);
    assert.ok(src!.filePath!.includes(CUSTOM_WF_NORM));
  });

  test("result.sources contains a 'user-global' entry for user-global workflow", () => {
    const src = discoveryResult.sources.find((s) => s.id === USER_WF_NORM);
    assert.notEqual(src, undefined);
    assert.equal(src!.kind, "user-global");
    assert.equal(src!.name, USER_WF_NAME);
  });

  test("no discovery errors for valid custom workflows", () => {
    const hardErrors = discoveryResult.errors.filter(
      (e) => e.level === "error" && (e.source?.includes(CUSTOM_WF_NORM) || e.source?.includes(USER_WF_NORM)),
    );
    assert.equal(hardErrors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. ExtensionRuntime — tool dispatch sees custom + bundled registry
// ---------------------------------------------------------------------------

describe("ExtensionRuntime with custom registry — tool dispatch", () => {
  test("action='list' returns custom workflow name", async () => {
    const result = await runtime.dispatch({ workflow: "", inputs: {}, action: "list" });
    assert.equal(result.action, "list");
    const r = result as { action: "list"; items: { name: string }[] };
    assert.ok(r.items.some((i) => i.name === CUSTOM_WF_NORM));
  });

  test("action='list' returns user-global workflow name", async () => {
    const result = await runtime.dispatch({ workflow: "", inputs: {}, action: "list" });
    const r = result as { action: "list"; items: { name: string }[] };
    assert.ok(r.items.some((i) => i.name === USER_WF_NORM));
  });

  test("action='list' includes bundled workflows alongside custom", async () => {
    const result = await runtime.dispatch({ workflow: "", inputs: {}, action: "list" });
    const r = result as { action: "list"; items: { name: string }[] };
    const names = r.items.map((i) => i.name);
    assert.ok(names.includes("deep-research-codebase"));
    assert.ok(names.includes("ralph"));
  });

  test("action='inputs' for custom workflow returns declared inputs", async () => {
    const result = await runtime.dispatch({ workflow: CUSTOM_WF_NORM, inputs: {}, action: "inputs" });
    assert.equal(result.action, "inputs");
    const r = result as { action: "inputs"; name: string; inputs: Array<{ name: string }> };
    assert.equal(r.name, CUSTOM_WF_NORM);
    assert.notEqual(r.inputs, undefined);
    const names = r.inputs.map((i) => i.name);
    assert.ok(names.includes("message"));
    assert.ok(names.includes("count"));
  });

  test("action='inputs' for custom workflow has no error field", async () => {
    const result = await runtime.dispatch({ workflow: CUSTOM_WF_NORM, inputs: {}, action: "inputs" });
    const r = result as { action: "inputs"; error?: string };
    assert.equal(r.error, undefined);
  });

  test("action='run' for custom workflow dispatches (returns run result, not unknown-action)", async () => {
    const result = await runtime.dispatch({
      workflow: CUSTOM_WF_NORM,
      inputs: { message: "hello" },
      action: "run",
    });
    assert.equal(result.action, "run");
    const r = result as { action: "run"; runId: string; status: string };
    // runId must be a non-empty string and the synchronous status is "running".
    assert.equal(typeof r.runId, "string");
    assert.ok(r.runId.length > 0);
    assert.equal(r.status, "running");
    // After the background promise settles, the store carries the terminal status.
    await waitForRun(r.runId, { store: defaultStore });
    const settled = defaultStore.runs().find((run) => run.id === r.runId);
    assert.notEqual(settled, undefined);
    assert.ok(["completed", "failed"].includes(settled!.status));
  });

  test("shared registry: list from tool equals registry.names()", async () => {
    const result = await runtime.dispatch({ workflow: "", inputs: {}, action: "list" });
    const r = result as { action: "list"; items: { name: string }[] };
    const toolNames = r.items.map((i) => i.name);
    const registryNames = discoveryResult.registry.names();
    // Every name in the registry is in the tool list and vice versa
    for (const name of registryNames) {
      assert.ok(toolNames.includes(name));
    }
    for (const name of toolNames) {
      assert.ok(registryNames.includes(name));
    }
  });
});

// ---------------------------------------------------------------------------
// 3. buildDoctorReport — custom sources from discovery result
// ---------------------------------------------------------------------------

describe("buildDoctorReport — custom sources from temp cwd/home", () => {
  test("report contains project-local custom workflow id", () => {
    const report = doctorReport(discoveryResult, noSiblings);
    assert.ok(report.includes(CUSTOM_WF_NORM));
  });

  test("report labels custom workflow source as 'project-local'", () => {
    const report = doctorReport(discoveryResult, noSiblings);
    // New format renders the source kind as a dim hint suffix `(project-local)`.
    assert.ok(report.includes("(project-local)"));
  });

  test("report contains user-global workflow id", () => {
    const report = doctorReport(discoveryResult, noSiblings);
    assert.ok(report.includes(USER_WF_NORM));
  });

  test("report labels user-global source as 'user-global'", () => {
    const report = doctorReport(discoveryResult, noSiblings);
    assert.ok(report.includes("(user-global)"));
  });

  test("registry count in report equals total names count (bundled + custom)", () => {
    const report = doctorReport(discoveryResult, noSiblings);
    const totalCount = discoveryResult.registry.names().length;
    assert.ok(report.includes(`${totalCount} workflow${totalCount === 1 ? "" : "s"} loaded`));
  });

  test("report includes the [ DIAGNOSTICS ] section", () => {
    const report = doctorReport(discoveryResult, noSiblings);
    assert.ok(report.includes("[ DIAGNOSTICS ]"));
  });

  test("no error diagnostics for valid custom workflows in report", () => {
    const report = doctorReport(discoveryResult, noSiblings);
    // Diagnostics section should not flag valid custom workflows as
    // INVALID_DEFINITION.
    const diagSection = report.match(/\[ DIAGNOSTICS \].*?(?=\n\[ |\nNext steps|$)/s)?.[0] ?? "";
    assert.ok(!diagSection.includes("INVALID_DEFINITION"));
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
    assert.equal(result.handled, true);
  });

  test("--workflow <customName> result has status completed or failed (not silent)", async () => {
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow", CUSTOM_WF_NORM],
    });
    assert.equal(result.handled, true);
    if (result.handled) {
      assert.ok(["completed", "failed"].includes(result.status));
    }
  });

  test("--workflow unknown-xyz returns handled: true with failed status (not silent)", async () => {
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow", "unknown-xyz-custom"],
    });
    assert.equal(result.handled, true);
    if (result.handled) {
      assert.equal(result.status, "failed");
    }
  });

  test("--workflow absent returns handled: false", async () => {
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--other-flag", "value"],
    });
    assert.equal(result.handled, false);
  });

  test("--workflow-inputs JSON passed to custom workflow dispatch", async () => {
    const result = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow", CUSTOM_WF_NORM, '--workflow-inputs={"message":"hello"}'],
    });
    assert.equal(result.handled, true);
    // Result may be completed or failed (no real adapters), but it must have dispatched
    if (result.handled) {
      assert.ok(["completed", "failed"].includes(result.status));
    }
  });

  test("CLI runtime uses same registry as tool: dispatches custom workflow that tool also sees", async () => {
    // Tool sees the workflow via action='inputs'
    const toolResult = await runtime.dispatch({ workflow: CUSTOM_WF_NORM, inputs: {}, action: "inputs" });
    assert.equal(toolResult.action, "inputs");
    // CLI can also run it (even if it fails in test env)
    const cliResult = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow", CUSTOM_WF_NORM],
    });
    assert.equal(cliResult.handled, true);
  });
});

// ---------------------------------------------------------------------------
// 5. /workflow slash command — list and completions see custom registry
// ---------------------------------------------------------------------------

interface MockCmd {
  name: string;
  options: PiCommandOptions;
}

interface MockTool {
  opts: PiToolOpts<WorkflowToolArgs, WorkflowToolResult>;
}

interface SentMessage {
  customType?: string;
  content?: string;
  display?: boolean;
  details?: unknown;
}

function makeMockApiForRuntime(): ExtensionAPI & {
  commands: MockCmd[];
  tools: MockTool[];
  sent: SentMessage[];
} {
  const commands: MockCmd[] = [];
  const tools: MockTool[] = [];
  const sent: SentMessage[] = [];

  return {
    commands,
    tools,
    sent,
    registerTool<TArgs, TResult>(opts: PiToolOpts<TArgs, TResult>) {
      tools.push({ opts: opts as unknown as MockTool["opts"] });
    },
    registerCommand(name: string, options: PiCommandOptions) {
      commands.push({ name, options });
    },
    registerMessageRenderer: () => undefined,
    registerFlag: () => undefined,
    // Chat surfaces dispatch via emitChatSurface → pi.sendMessage. Mirror
    // the recipient so tests can introspect the new path.
    sendMessage(msg: SentMessage) {
      sent.push(msg);
    },
  } as ExtensionAPI & {
    commands: MockCmd[];
    tools: MockTool[];
    sent: SentMessage[];
  };
}

function getCommand(commands: MockCmd[], name: string): MockCmd | undefined {
  return commands.find((c) => c.name === name);
}

/**
 * Extract workflow names from any `kind: "list"` chat-surface payloads
 * captured by the mock's sendMessage hook.
 */
function collectListEntryNames(sent: readonly SentMessage[]): string[] {
  const names: string[] = [];
  for (const msg of sent) {
    const details = msg.details as
      | { kind?: string; entries?: ReadonlyArray<{ name?: string }> }
      | undefined;
    if (details?.kind !== "list") continue;
    for (const entry of details.entries ?? []) {
      if (typeof entry.name === "string") names.push(entry.name);
    }
  }
  return names;
}

describe("/workflow slash command — bundled-and-custom shared registry", () => {
  // The factory seeds the runtime from discoverStartupWorkflowsSync() synchronously,
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
    const toolOut = await toolExecute(
      "test-tool-call",
      { inputs: {}, action: "list" },
      undefined,
      undefined,
      {} as never,
    );
    const toolItems = (toolOut.details as { action: "list"; items: { name: string }[] }).items;
    const toolWorkflows = toolItems.map((i) => i.name);

    // Slash command list now emits via pi.sendMessage with a chat-surface
    // payload `{ kind: "list", entries: [{ name }, …] }`. Extract entry
    // names from the sent payload (and fall back to combined reply text
    // for hosts without registerMessageRenderer).
    const messages: string[] = [];
    const cmd = getCommand(mock.commands, "workflow")!;
    await cmd.options.handler("list", { ui: { notify: (m: string) => messages.push(m) } });
    const listEntries = collectListEntryNames(mock.sent);
    const combined = messages.join("\n");

    // Every bundled name visible to tool is also in slash output.
    for (const name of ["deep-research-codebase", "ralph", "open-claude-design"]) {
      assert.ok(toolWorkflows.includes(name));
      assert.ok(
        listEntries.includes(name) || combined.includes(name),
        `bundled workflow ${name} missing from slash list output`,
      );
    }
  });

  test("tool and /workflow list agree on the count of bundled workflows", async () => {
    const toolExecute = mock.tools[0]!.opts.execute;
    const toolOut = await toolExecute(
      "test-tool-call",
      { inputs: {}, action: "list" },
      undefined,
      undefined,
      {} as never,
    );
    const toolWorkflows = (toolOut.details as { action: "list"; items: { name: string }[] }).items.map((i) => i.name);

    const messages: string[] = [];
    const cmd = getCommand(mock.commands, "workflow")!;
    await cmd.options.handler("list", { ui: { notify: (m: string) => messages.push(m) } });
    const listEntries = collectListEntryNames(mock.sent);
    const combined = messages.join("\n");

    // All tool names appear in the slash command output (chat-surface
    // payload via sendMessage, with combined-reply fallback).
    for (const name of toolWorkflows) {
      assert.ok(
        listEntries.includes(name) || combined.includes(name),
        `slash list output missing workflow ${name}`,
      );
    }
  });

  test("completions include all bundled workflow names (from shared runtimeProxy.registry)", async () => {
    const cmd = getCommand(mock.commands, "workflow")!;
    const completions = await cmd.options.getArgumentCompletions?.("") ?? [];
    const labels = completions.map((c) => c.label);

    for (const name of ["deep-research-codebase", "ralph", "open-claude-design"]) {
      assert.ok(labels.includes(name));
    }
  });
});

// ---------------------------------------------------------------------------
// 6. No /workflow:<name> aliases — /workflow <name> dispatches same runtime path as tool
// ---------------------------------------------------------------------------

describe("/workflow <name> dispatch — no per-workflow aliases", () => {
  let mock: ReturnType<typeof makeMockApiForRuntime>;

  beforeAll(() => {
    mock = makeMockApiForRuntime();
    factory(mock);
  });

  test("alias workflow:ralph is not registered", () => {
    const alias = getCommand(mock.commands, "workflow:ralph");
    assert.equal(alias, undefined);
  });

  test("/workflow deep-research-codebase execute produces output (completed or failed, not silent)", async () => {
    const cmd = getCommand(mock.commands, "workflow");
    assert.notEqual(cmd, undefined);
    const messages: string[] = [];
    const beforeSent = mock.sent.length;
    await cmd!.options.handler("deep-research-codebase prompt=test", { ui: { notify: (m: string) => messages.push(m) } });
    // Success path: dispatch confirmation goes through pi.sendMessage with
    // `{ kind: "dispatch", … }`. Failure paths still hit ctx.ui.notify. Either
    // signal counts as "not silent".
    const dispatchedSent = mock.sent
      .slice(beforeSent)
      .some((m) => (m.details as { kind?: string } | undefined)?.kind === "dispatch");
    const errored = messages.some(
      (m) =>
        m.includes("completed") ||
        m.includes("failed") ||
        m.includes("Workflow"),
    );
    assert.equal(dispatchedSent || errored, true);
  });

  test("/workflow dispatch and tool dispatch reach same registry", async () => {
    // Tool route: dispatch ralph with required prompt input (avoids resolveInputs throw)
    const toolExecute = mock.tools[0]!.opts.execute;
    const toolOut = await toolExecute(
      "test-tool-call",
      { workflow: "ralph", inputs: { prompt: "test" }, action: "run" },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(toolOut.details.action, "run");

    // Slash route must also produce action='run' (via runtimeProxy.dispatch).
    // We can't directly inspect slash result since it only calls reply/print,
    // but we can verify execute does NOT say "unknown subcommand".
    const cmd = getCommand(mock.commands, "workflow");
    const messages: string[] = [];
    await cmd!.options.handler("ralph prompt=test", { ui: { notify: (m: string) => messages.push(m) } });
    assert.equal(messages.some((m) => m.includes("unknown subcommand")), false);
  });

  test("no bundled workflow aliases are registered", () => {
    const allAliases = mock.commands
      .filter((c) => c.name.startsWith("workflow:"))
      .map((c) => c.name.slice("workflow:".length));

    assert.deepEqual(allAliases, []);
  });
});

// ---------------------------------------------------------------------------
// 7. Shared registry invariant — end-to-end across all consumers
// ---------------------------------------------------------------------------

describe("shared registry invariant — all consumers see same workflows", () => {
  test("tool list, doctor registry count, and CLI dispatch all reflect same registry", async () => {
    // 1. Tool: list via runtime
    const listResult = await runtime.dispatch({ workflow: "", inputs: {}, action: "list" });
    const toolNames = (listResult as { action: "list"; items: { name: string }[] }).items.map((i) => i.name);

    // 2. Doctor: registry count via buildDoctorReport. The new subtitle
    //    format is `atomic-workflows · N workflow(s) · N/N companions`,
    //    so we match the first "N workflow(s)" token after the program
    //    name to extract the loaded count.
    const report = doctorReport(discoveryResult, noSiblings);
    const match = report.match(/atomic-workflows[^\n]*?(\d+)\s+workflows?\b/);
    assert.notEqual(match, null);
    const doctorCount = match ? parseInt(match[1]!, 10) : -1;
    assert.equal(doctorCount, toolNames.length);

    // 3. CLI: can handle one of the custom workflow names
    const cliResult = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow", CUSTOM_WF_NORM],
    });
    assert.equal(cliResult.handled, true);
  });

  test("custom workflow visible to tool, doctor, and CLI but NOT in startup bundled registry", async () => {
    // startup bundled discovery (no temp dirs)
    const { discoverStartupWorkflowsSync } = await import("../../src/extension/discovery.js");
    const bundledResult = discoverStartupWorkflowsSync();
    assert.ok(!bundledResult.registry.names().includes(CUSTOM_WF_NORM));

    // Custom-inclusive runtime includes it
    const toolResult = await runtime.dispatch({ workflow: "", inputs: {}, action: "list" });
    const toolNames = (toolResult as { action: "list"; items: { name: string }[] }).items.map((i) => i.name);
    assert.ok(toolNames.includes(CUSTOM_WF_NORM));

    // Doctor with full discovery shows it
    const report = doctorReport(discoveryResult, noSiblings);
    assert.ok(report.includes(CUSTOM_WF_NORM));

    // CLI with custom runtime handles it
    const cliResult = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow", CUSTOM_WF_NORM],
    });
    assert.equal(cliResult.handled, true);
  });

  test("custom workflow inputs schema consistent across tool and CLI dispatch", async () => {
    // Tool: inputs action
    const inputsResult = await runtime.dispatch({ workflow: CUSTOM_WF_NORM, inputs: {}, action: "inputs" });
    const r = inputsResult as { action: "inputs"; inputs: Array<{ name: string; type: string }> };
    const inputsByName = Object.fromEntries(r.inputs.map((i) => [i.name, i]));

    assert.notEqual(inputsByName["message"], undefined);
    assert.equal(inputsByName["message"]!.type, "string");
    assert.notEqual(inputsByName["count"], undefined);
    assert.equal(inputsByName["count"]!.type, "number");

    // CLI: dispatch with well-formed inputs (same schema path)
    const cliResult = await runWorkflowFromCliFlags({
      runtime,
      argv: ["--workflow", CUSTOM_WF_NORM, '--workflow-inputs={"message":"hello"}'],
    });
    assert.equal(cliResult.handled, true);
  });
});
