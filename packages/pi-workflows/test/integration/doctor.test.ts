/**
 * Focused tests for doctor.ts — buildDoctorReport.
 *
 * Uses mock DiscoveryResult and DoctorSiblingStatus objects so the report
 * builder can be exercised without I/O or bundled workflow loading.
 */

import { test, expect, describe } from "bun:test";
import { buildDoctorReport } from "../../src/extension/doctor.js";
import type { DoctorSiblingStatus } from "../../src/extension/doctor.js";
import { createRegistry } from "../../src/workflows/registry.js";
import type { DiscoveryResult } from "../../src/extension/discovery.js";
import type { ConfigLoadResult } from "../../src/extension/config-loader.js";
import factory, {
  type ExtensionAPI,
  type PiSlashCommandOpts,
} from "../../src/extension/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

const allSiblings: DoctorSiblingStatus = {
  subagents: true,
  subagentsCallable: true,
  mcpAdapter: true,
  mcpScopeEvents: true,
  intercom: true,
  hil: true,
  uiCustom: true,
  shortcut: true,
  execAbortable: true,
  persistenceAppendEntry: true,
  promptAdapter: true,
  completeAdapter: true,
  subagentAdapterVia: "pi.subagents",
};

function makeDiscovery(overrides: Partial<DiscoveryResult> = {}): DiscoveryResult {
  return {
    registry: createRegistry(),
    sources: [],
    errors: [],
    ...overrides,
  };
}

interface RegisteredCommand {
  opts: PiSlashCommandOpts;
}

function makeMockApi(extras: Partial<ExtensionAPI> = {}): ExtensionAPI & { commands: RegisteredCommand[] } {
  const commands: RegisteredCommand[] = [];
  return {
    commands,
    registerCommand(opts: PiSlashCommandOpts) {
      commands.push({ opts });
    },
    registerTool: () => undefined,
    registerMessageRenderer: () => undefined,
    registerFlag: () => undefined,
    ...extras,
  } as ExtensionAPI & { commands: RegisteredCommand[] };
}

// ---------------------------------------------------------------------------
// Header / structure
// ---------------------------------------------------------------------------

describe("buildDoctorReport — header", () => {
  test("starts with 'pi-workflows doctor report'", () => {
    const report = buildDoctorReport(makeDiscovery(), noSiblings);
    expect(report.startsWith("pi-workflows doctor report")).toBe(true);
  });

  test("contains separator line", () => {
    const report = buildDoctorReport(makeDiscovery(), noSiblings);
    expect(report).toContain("──────────────────────────");
  });

  test("does NOT contain 'Phase B stub'", () => {
    const report = buildDoctorReport(makeDiscovery(), noSiblings);
    expect(report).not.toContain("Phase B stub");
  });

  test("does NOT contain 'Executor: not yet implemented'", () => {
    const report = buildDoctorReport(makeDiscovery(), noSiblings);
    expect(report).not.toContain("Executor: not yet implemented");
  });

  test("does NOT contain 'availability check not yet wired'", () => {
    const report = buildDoctorReport(makeDiscovery(), noSiblings);
    expect(report).not.toContain("availability check not yet wired");
  });
});

// ---------------------------------------------------------------------------
// Registry count
// ---------------------------------------------------------------------------

describe("buildDoctorReport — registry count", () => {
  test("shows 0 workflows for empty registry", () => {
    const report = buildDoctorReport(makeDiscovery(), noSiblings);
    expect(report).toContain("Registry: 0 workflow(s) loaded");
  });

  test("shows correct count from registry.names()", () => {
    const discovery = makeDiscovery({
      sources: [
        { id: "alpha", kind: "bundled", name: "Alpha" },
        { id: "beta", kind: "bundled", name: "Beta" },
      ],
    });
    const report = buildDoctorReport(discovery, noSiblings);
    // registry is empty in this fixture; sources are listed separately
    expect(report).toContain("Registry: 0 workflow(s) loaded");
    expect(report).toContain("Bundled sources (2):");
  });
});

// ---------------------------------------------------------------------------
// Bundled sources
// ---------------------------------------------------------------------------

describe("buildDoctorReport — bundled sources", () => {
  test("shows '(none)' when no sources", () => {
    const report = buildDoctorReport(makeDiscovery(), noSiblings);
    expect(report).toContain("Bundled sources: (none)");
  });

  test("lists each source with kind, id, and name", () => {
    const discovery = makeDiscovery({
      sources: [
        { id: "my-workflow", kind: "bundled", name: "My Workflow" },
      ],
    });
    const report = buildDoctorReport(discovery, noSiblings);
    expect(report).toContain("[bundled]");
    expect(report).toContain("my-workflow");
    expect(report).toContain("My Workflow");
  });

  test("shows count in header for multiple sources", () => {
    const discovery = makeDiscovery({
      sources: [
        { id: "wf-a", kind: "bundled", name: "Wf A" },
        { id: "wf-b", kind: "bundled", name: "Wf B" },
        { id: "wf-c", kind: "bundled", name: "Wf C" },
      ],
    });
    const report = buildDoctorReport(discovery, noSiblings);
    expect(report).toContain("Bundled sources (3):");
  });
});

// ---------------------------------------------------------------------------
// Discovery diagnostics
// ---------------------------------------------------------------------------

describe("buildDoctorReport — discovery diagnostics", () => {
  test("shows '(none)' when no errors", () => {
    const report = buildDoctorReport(makeDiscovery(), noSiblings);
    expect(report).toContain("Discovery diagnostics: (none)");
  });

  test("lists each error with level and code", () => {
    const discovery = makeDiscovery({
      errors: [
        {
          level: "error",
          code: "INVALID_DEFINITION",
          message: "export \"badWf\" rejected: missing run function",
          source: "badWf",
        },
      ],
    });
    const report = buildDoctorReport(discovery, noSiblings);
    expect(report).toContain("[error]");
    expect(report).toContain("INVALID_DEFINITION");
    expect(report).toContain("badWf");
  });

  test("lists warn-level duplicate diagnostic", () => {
    const discovery = makeDiscovery({
      errors: [
        {
          level: "warn",
          code: "DUPLICATE_NAME",
          message: 'export "dupWf" skipped: normalizedName "dup" already registered',
          source: "dupWf",
        },
      ],
    });
    const report = buildDoctorReport(discovery, noSiblings);
    expect(report).toContain("[warn]");
    expect(report).toContain("DUPLICATE_NAME");
  });

  test("shows count in header for multiple diagnostics", () => {
    const discovery = makeDiscovery({
      errors: [
        { level: "error", code: "INVALID_DEFINITION", message: "msg1", source: "a" },
        { level: "warn", code: "DUPLICATE_NAME", message: "msg2", source: "b" },
      ],
    });
    const report = buildDoctorReport(discovery, noSiblings);
    expect(report).toContain("Discovery diagnostics (2):");
  });
});

// ---------------------------------------------------------------------------
// Sibling availability
// ---------------------------------------------------------------------------

describe("buildDoctorReport — siblings", () => {
  test("shows 'not detected' for all siblings when none present", () => {
    const report = buildDoctorReport(makeDiscovery(), noSiblings);
    expect(report).toContain("pi-subagents   — not detected");
    expect(report).toContain("pi-mcp-adapter — not detected");
    expect(report).toContain("pi-intercom    — not detected");
  });

  test("shows 'available' for all siblings when all present", () => {
    const report = buildDoctorReport(makeDiscovery(), allSiblings);
    expect(report).toContain("pi-subagents   — available");
    expect(report).toContain("pi-mcp-adapter — available");
    expect(report).toContain("pi-intercom    — present");
  });

  test("shows mixed availability correctly", () => {
    const mixed: DoctorSiblingStatus = {
      subagents: true,
      subagentsCallable: false,
      mcpAdapter: false,
      mcpScopeEvents: false,
      intercom: true,
      hil: false,
      uiCustom: false,
      shortcut: false,
      execAbortable: false,
      persistenceAppendEntry: false,
      promptAdapter: false,
      completeAdapter: false,
      subagentAdapterVia: "unavailable",
    };
    const report = buildDoctorReport(makeDiscovery(), mixed);
    expect(report).toContain("pi-subagents   — available");
    expect(report).toContain("pi-mcp-adapter — not detected");
    expect(report).toContain("pi-intercom    — present");
  });
});

// ---------------------------------------------------------------------------
// Integration: /workflows-doctor execute via MockExtensionAPI
// ---------------------------------------------------------------------------

describe("/workflows-doctor execute — integration", () => {
  test("produces multi-line output containing header", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.opts.name === "workflows-doctor")?.opts;
    expect(cmd).toBeDefined();
    const messages: string[] = [];
    await cmd!.execute("", { reply: (m) => messages.push(m) });
    const combined = messages.join("\n");
    expect(combined).toContain("pi-workflows doctor report");
  });

  test("shows 'Registry:' line with number", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.opts.name === "workflows-doctor")?.opts;
    const messages: string[] = [];
    await cmd!.execute("", { reply: (m) => messages.push(m) });
    const combined = messages.join("\n");
    expect(combined).toMatch(/Registry: \d+ workflow\(s\) loaded/);
  });

  test("shows 'Discovery diagnostics:' section", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.opts.name === "workflows-doctor")?.opts;
    const messages: string[] = [];
    await cmd!.execute("", { reply: (m) => messages.push(m) });
    const combined = messages.join("\n");
    expect(combined).toContain("Discovery diagnostics:");
  });

  test("shows 'Capabilities:' section", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.opts.name === "workflows-doctor")?.opts;
    const messages: string[] = [];
    await cmd!.execute("", { reply: (m) => messages.push(m) });
    const combined = messages.join("\n");
    expect(combined).toContain("Capabilities:");
  });

  test("pi-subagents shows 'available' when pi.subagents present", async () => {
    const api = makeMockApi({ subagents: {} });
    factory(api);
    const cmd = api.commands.find((c) => c.opts.name === "workflows-doctor")?.opts;
    const messages: string[] = [];
    await cmd!.execute("", { reply: (m) => messages.push(m) });
    expect(messages.join("\n")).toContain("pi-subagents   — available");
  });

  test("pi-subagents shows 'not detected' when pi.subagents absent", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.opts.name === "workflows-doctor")?.opts;
    const messages: string[] = [];
    await cmd!.execute("", { reply: (m) => messages.push(m) });
    expect(messages.join("\n")).toContain("pi-subagents   — not detected");
  });

  test("pi-intercom shows 'present' when setSessionName present", async () => {
    const api = makeMockApi({ setSessionName: () => undefined });
    factory(api);
    const cmd = api.commands.find((c) => c.opts.name === "workflows-doctor")?.opts;
    const messages: string[] = [];
    await cmd!.execute("", { reply: (m) => messages.push(m) });
    expect(messages.join("\n")).toContain("pi-intercom    — present");
  });

  test("does NOT say 'Phase B stub'", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.opts.name === "workflows-doctor")?.opts;
    const messages: string[] = [];
    await cmd!.execute("", { reply: (m) => messages.push(m) });
    expect(messages.join("\n")).not.toContain("Phase B stub");
  });

  test("does NOT say 'Executor: not yet implemented'", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.opts.name === "workflows-doctor")?.opts;
    const messages: string[] = [];
    await cmd!.execute("", { reply: (m) => messages.push(m) });
    expect(messages.join("\n")).not.toContain("Executor: not yet implemented");
  });

  test("falls back to ctx.print when ctx.reply absent", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.opts.name === "workflows-doctor")?.opts;
    const messages: string[] = [];
    await cmd!.execute("", { print: (m) => messages.push(m) });
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.join("\n")).toContain("pi-workflows");
  });
});

// ---------------------------------------------------------------------------
// Config diagnostics section
// ---------------------------------------------------------------------------

describe("buildDoctorReport — config diagnostics", () => {
  test("shows '(not loaded)' when configLoad is undefined", () => {
    const report = buildDoctorReport(makeDiscovery(), noSiblings);
    expect(report).toContain("Config diagnostics: (not loaded)");
  });

  test("shows '(not loaded)' when configLoad is null", () => {
    const report = buildDoctorReport(makeDiscovery(), noSiblings, null);
    expect(report).toContain("Config diagnostics: (not loaded)");
  });

  test("shows '(none)' when configLoad has no diagnostics", () => {
    const configLoad: ConfigLoadResult = { config: null, diagnostics: [] };
    const report = buildDoctorReport(makeDiscovery(), noSiblings, configLoad);
    expect(report).toContain("Config diagnostics: (none)");
  });

  test("lists config diagnostic with level, code, source, and message", () => {
    const configLoad: ConfigLoadResult = {
      config: null,
      diagnostics: [
        {
          level: "error",
          code: "CONFIG_INVALID",
          message: "Invalid JSON in config file: Unexpected token",
          source: "/project/.pi/extensions/workflow/config.json",
        },
      ],
    };
    const report = buildDoctorReport(makeDiscovery(), noSiblings, configLoad);
    expect(report).toContain("Config diagnostics (1):");
    expect(report).toContain("[error]");
    expect(report).toContain("CONFIG_INVALID");
    expect(report).toContain("/project/.pi/extensions/workflow/config.json");
    expect(report).toContain("Invalid JSON in config file");
  });

  test("shows count for multiple config diagnostics", () => {
    const configLoad: ConfigLoadResult = {
      config: null,
      diagnostics: [
        { level: "error", code: "CONFIG_INVALID", message: "err1", source: "/a.json" },
        { level: "error", code: "CONFIG_INVALID", message: "err2", source: "/b.json" },
      ],
    };
    const report = buildDoctorReport(makeDiscovery(), noSiblings, configLoad);
    expect(report).toContain("Config diagnostics (2):");
  });

  test("shows diagnostic without source when source absent", () => {
    const configLoad: ConfigLoadResult = {
      config: null,
      diagnostics: [
        { level: "error", code: "CONFIG_INVALID", message: "some error" },
      ],
    };
    const report = buildDoctorReport(makeDiscovery(), noSiblings, configLoad);
    expect(report).toContain("CONFIG_INVALID: some error");
  });
});

// ---------------------------------------------------------------------------
// Tunables section
// ---------------------------------------------------------------------------

describe("buildDoctorReport — tunables", () => {
  test("shows default tunables when config is null", () => {
    const configLoad: ConfigLoadResult = { config: null, diagnostics: [] };
    const report = buildDoctorReport(makeDiscovery(), noSiblings, configLoad);
    expect(report).toContain("Tunables:");
    expect(report).toContain("persistRuns        — true");
    expect(report).toContain("resumeInFlight     — ask");
    expect(report).toContain("defaultConcurrency — 4");
    expect(report).toContain("maxDepth           — 4");
    expect(report).toContain("statusFile         — false");
  });

  test("shows default tunables when configLoad is undefined", () => {
    const report = buildDoctorReport(makeDiscovery(), noSiblings);
    expect(report).toContain("Tunables:");
    expect(report).toContain("persistRuns        — true");
    expect(report).toContain("resumeInFlight     — ask");
    expect(report).toContain("defaultConcurrency — 4");
    expect(report).toContain("maxDepth           — 4");
    expect(report).toContain("statusFile         — false");
  });

  test("shows overridden tunables from config", () => {
    const configLoad: ConfigLoadResult = {
      config: {
        persistRuns: false,
        resumeInFlight: "auto",
        defaultConcurrency: 8,
        maxDepth: 2,
        statusFile: true,
      },
      diagnostics: [],
    };
    const report = buildDoctorReport(makeDiscovery(), noSiblings, configLoad);
    expect(report).toContain("persistRuns        — false");
    expect(report).toContain("resumeInFlight     — auto");
    expect(report).toContain("defaultConcurrency — 8");
    expect(report).toContain("maxDepth           — 2");
    expect(report).toContain("statusFile         — true");
  });

  test("shows partial overrides; unset fields fall back to defaults", () => {
    const configLoad: ConfigLoadResult = {
      config: { maxDepth: 10 },
      diagnostics: [],
    };
    const report = buildDoctorReport(makeDiscovery(), noSiblings, configLoad);
    expect(report).toContain("maxDepth           — 10");
    expect(report).toContain("persistRuns        — true");
    expect(report).toContain("defaultConcurrency — 4");
  });
});

// ---------------------------------------------------------------------------
// Configured workflow entries section
// ---------------------------------------------------------------------------

describe("buildDoctorReport — configured workflows", () => {
  test("shows '(none configured)' when config has no workflows", () => {
    const configLoad: ConfigLoadResult = { config: {}, diagnostics: [] };
    const report = buildDoctorReport(makeDiscovery(), noSiblings, configLoad);
    expect(report).toContain("Configured workflows: (none configured)");
  });

  test("shows '(none configured)' when configLoad is undefined", () => {
    const report = buildDoctorReport(makeDiscovery(), noSiblings);
    expect(report).toContain("Configured workflows: (none configured)");
  });

  test("lists each configured workflow with name and path", () => {
    const configLoad: ConfigLoadResult = {
      config: {
        workflows: {
          "my-workflow": { path: "./workflows/my-workflow.ts" },
        },
      },
      diagnostics: [],
    };
    const report = buildDoctorReport(makeDiscovery(), noSiblings, configLoad);
    expect(report).toContain("Configured workflows (1):");
    expect(report).toContain("my-workflow → ./workflows/my-workflow.ts");
  });

  test("lists multiple configured workflows", () => {
    const configLoad: ConfigLoadResult = {
      config: {
        workflows: {
          alpha: { path: "/abs/alpha.ts" },
          beta: { path: "./beta.ts" },
        },
      },
      diagnostics: [],
    };
    const report = buildDoctorReport(makeDiscovery(), noSiblings, configLoad);
    expect(report).toContain("Configured workflows (2):");
    expect(report).toContain("alpha → /abs/alpha.ts");
    expect(report).toContain("beta → ./beta.ts");
  });

  test("does NOT print file contents — only name and path", () => {
    const configLoad: ConfigLoadResult = {
      config: {
        workflows: {
          secret: { path: "./secret-workflow.ts" },
        },
      },
      diagnostics: [],
    };
    const report = buildDoctorReport(makeDiscovery(), noSiblings, configLoad);
    // Only path, not any file content
    expect(report).toContain("secret → ./secret-workflow.ts");
    expect(report).not.toContain("FILE_CONTENTS");
  });
});

// ---------------------------------------------------------------------------
// Section ordering
// ---------------------------------------------------------------------------

describe("buildDoctorReport — section ordering", () => {
  test("config diagnostics appears before tunables", () => {
    const configLoad: ConfigLoadResult = { config: null, diagnostics: [] };
    const report = buildDoctorReport(makeDiscovery(), noSiblings, configLoad);
    const configIdx = report.indexOf("Config diagnostics:");
    const tunablesIdx = report.indexOf("Tunables:");
    expect(configIdx).toBeLessThan(tunablesIdx);
  });

  test("tunables appears before configured workflows", () => {
    const configLoad: ConfigLoadResult = { config: null, diagnostics: [] };
    const report = buildDoctorReport(makeDiscovery(), noSiblings, configLoad);
    const tunablesIdx = report.indexOf("Tunables:");
    const workflowsIdx = report.indexOf("Configured workflows:");
    expect(tunablesIdx).toBeLessThan(workflowsIdx);
  });

  test("configured workflows appears before capabilities", () => {
    const configLoad: ConfigLoadResult = { config: null, diagnostics: [] };
    const report = buildDoctorReport(makeDiscovery(), noSiblings, configLoad);
    const workflowsIdx = report.indexOf("Configured workflows:");
    const capabilitiesIdx = report.indexOf("Capabilities:");
    expect(workflowsIdx).toBeLessThan(capabilitiesIdx);
  });
});

// ---------------------------------------------------------------------------
// Integration: /workflows-doctor includes new sections
// ---------------------------------------------------------------------------

describe("/workflows-doctor execute — config sections integration", () => {
  test("shows 'Config diagnostics:' section", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.opts.name === "workflows-doctor")?.opts;
    const messages: string[] = [];
    await cmd!.execute("", { reply: (m) => messages.push(m) });
    expect(messages.join("\n")).toContain("Config diagnostics:");
  });

  test("shows 'Tunables:' section", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.opts.name === "workflows-doctor")?.opts;
    const messages: string[] = [];
    await cmd!.execute("", { reply: (m) => messages.push(m) });
    expect(messages.join("\n")).toContain("Tunables:");
  });

  test("shows 'Configured workflows:' section", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.opts.name === "workflows-doctor")?.opts;
    const messages: string[] = [];
    await cmd!.execute("", { reply: (m) => messages.push(m) });
    expect(messages.join("\n")).toContain("Configured workflows:");
  });
});
