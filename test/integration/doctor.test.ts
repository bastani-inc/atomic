/**
 * Focused tests for doctor.ts — buildDoctorReport.
 *
 * Uses mock DiscoveryResult and DoctorSiblingStatus objects so the report
 * builder can be exercised without I/O or bundled workflow loading.
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { buildDoctorPayload, buildDoctorReport } from "../../src/extension/doctor.js";
import type { DoctorSiblingStatus } from "../../src/extension/doctor.js";
import { createRegistry } from "../../src/workflows/registry.js";
import type { DiscoveryResult } from "../../src/extension/discovery.js";
import type { ConfigLoadResult } from "../../src/extension/config-loader.js";
import factory, {
  type ExtensionAPI,
  type PiCommandOptions,
} from "../../src/extension/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const noSiblings: DoctorSiblingStatus = {
  taskDelegation: false,
  mcpScopeEvents: false,
  intercomEvents: false,
  intercomControlSubscription: false,
  sessionNaming: false,
  hil: false,
  uiCustom: false,
  shortcut: false,
  persistenceAppendEntry: false,
  subagentAdapterVia: "unavailable",
};

const allSiblings: DoctorSiblingStatus = {
  taskDelegation: true,
  mcpScopeEvents: true,
  intercomEvents: true,
  intercomControlSubscription: true,
  sessionNaming: true,
  hil: true,
  uiCustom: true,
  shortcut: true,
  persistenceAppendEntry: true,
  subagentAdapterVia: "pi-subagents tool",
};

function makeDiscovery(overrides: Partial<DiscoveryResult> = {}): DiscoveryResult {
  return {
    registry: createRegistry(),
    sources: [],
    errors: [],
    ...overrides,
  };
}

function doctorReport(
  discovery: DiscoveryResult,
  siblings: DoctorSiblingStatus,
  configLoad?: ConfigLoadResult | null,
): string {
  return buildDoctorReport(buildDoctorPayload({
    discovery,
    siblings,
    companions: [],
    configLoad,
  }));
}

interface RegisteredCommand {
  name: string;
  options: PiCommandOptions;
}

function makeMockApi(extras: Partial<ExtensionAPI> = {}): ExtensionAPI & { commands: RegisteredCommand[] } {
  const commands: RegisteredCommand[] = [];
  return {
    commands,
    registerCommand(name: string, options: PiCommandOptions) {
      commands.push({ name, options });
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
  test("starts with 'atomic-workflows doctor report'", () => {
    const report = doctorReport(makeDiscovery(), noSiblings);
    assert.equal(report.startsWith("atomic-workflows doctor report"), true);
  });

  test("includes the payload subtitle on the second line", () => {
    const report = doctorReport(makeDiscovery(), noSiblings);
    // Subtitle format: `atomic-workflows · N workflow(s) · N/N companions`.
    assert.match(report, /atomic-workflows · \d+ workflows? · \d+\/\d+ companions/);
  });

  test("does NOT contain 'Phase B stub'", () => {
    const report = doctorReport(makeDiscovery(), noSiblings);
    assert.ok(!report.includes("Phase B stub"));
  });

  test("does NOT contain 'Executor: not yet implemented'", () => {
    const report = doctorReport(makeDiscovery(), noSiblings);
    assert.ok(!report.includes("Executor: not yet implemented"));
  });

  test("does NOT contain 'availability check not yet wired'", () => {
    const report = doctorReport(makeDiscovery(), noSiblings);
    assert.ok(!report.includes("availability check not yet wired"));
  });
});

// ---------------------------------------------------------------------------
// Registry count
// ---------------------------------------------------------------------------

describe("buildDoctorReport — registry section", () => {
  test("shows 0 workflows for empty registry", () => {
    const report = doctorReport(makeDiscovery(), noSiblings);
    assert.ok(report.includes("[ REGISTRY ]"));
    assert.ok(report.includes("0 workflows loaded"));
  });

  test("shows correct count from registry.names()", () => {
    const discovery = makeDiscovery({
      sources: [
        { id: "alpha", kind: "bundled", name: "Alpha" },
        { id: "beta", kind: "bundled", name: "Beta" },
      ],
    });
    const report = doctorReport(discovery, noSiblings);
    // registry is empty in this fixture; sources appear as rows under [ REGISTRY ].
    assert.ok(report.includes("[ REGISTRY ]"));
    assert.ok(report.includes("0 workflows loaded"));
    assert.ok(report.includes("Alpha"));
    assert.ok(report.includes("Beta"));
  });
});

// ---------------------------------------------------------------------------
// Bundled sources
// ---------------------------------------------------------------------------

describe("buildDoctorReport — source rows", () => {
  test("shows placeholder row when no sources", () => {
    const report = doctorReport(makeDiscovery(), noSiblings);
    assert.ok(report.includes("no bundled workflows discovered"));
  });

  test("lists each source with kind hint and name", () => {
    const discovery = makeDiscovery({
      sources: [
        { id: "my-workflow", kind: "bundled", name: "My Workflow" },
      ],
    });
    const report = doctorReport(discovery, noSiblings);
    assert.ok(report.includes("My Workflow"));
    assert.ok(report.includes("my-workflow"));
    assert.ok(report.includes("(bundled)"));
  });

  test("shows all sources for multiple bundled workflows", () => {
    const discovery = makeDiscovery({
      sources: [
        { id: "wf-a", kind: "bundled", name: "Wf A" },
        { id: "wf-b", kind: "bundled", name: "Wf B" },
        { id: "wf-c", kind: "bundled", name: "Wf C" },
      ],
    });
    const report = doctorReport(discovery, noSiblings);
    assert.ok(report.includes("Wf A"));
    assert.ok(report.includes("Wf B"));
    assert.ok(report.includes("Wf C"));
  });
});

// ---------------------------------------------------------------------------
// Discovery diagnostics
// ---------------------------------------------------------------------------

describe("buildDoctorReport — diagnostics section", () => {
  test("emits the diagnostics band even when there are no discovery errors", () => {
    const report = doctorReport(makeDiscovery(), noSiblings);
    assert.ok(report.includes("[ DIAGNOSTICS ]"));
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
    const report = doctorReport(discovery, noSiblings);
    assert.ok(report.includes("[error]"));
    assert.ok(report.includes("INVALID_DEFINITION"));
    assert.ok(report.includes("badWf"));
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
    const report = doctorReport(discovery, noSiblings);
    assert.ok(report.includes("[warn]"));
    assert.ok(report.includes("DUPLICATE_NAME"));
  });

  test("shows item count for multiple diagnostics", () => {
    const discovery = makeDiscovery({
      errors: [
        { level: "error", code: "INVALID_DEFINITION", message: "msg1", source: "a" },
        { level: "warn", code: "DUPLICATE_NAME", message: "msg2", source: "b" },
      ],
    });
    const report = doctorReport(discovery, noSiblings);
    assert.ok(report.includes("[ DIAGNOSTICS ]"));
    // Two error rows + one 'config: not loaded' row from undefined configLoad.
    assert.ok(report.includes("INVALID_DEFINITION"));
    assert.ok(report.includes("DUPLICATE_NAME"));
  });
});

// ---------------------------------------------------------------------------
// Runtime capability availability
// ---------------------------------------------------------------------------

describe("buildDoctorReport — siblings", () => {
  test("shows unavailable runtime capabilities when none present", () => {
    const report = doctorReport(makeDiscovery(), noSiblings);
    assert.ok(report.includes("task delegation: unavailable"));
    assert.ok(report.includes("session naming: unavailable"));
  });

  test("shows available/present runtime capabilities when configured", () => {
    const report = doctorReport(makeDiscovery(), allSiblings);
    // `allSiblings` uses subagentAdapterVia: "pi-subagents tool", which
    // renders as `available via pi-subagents` in the capability row.
    assert.ok(report.includes("task delegation: available via pi-subagents"));
    assert.ok(report.includes("session naming: present"));
  });

  test("shows mixed availability correctly", () => {
    const mixed: DoctorSiblingStatus = {
      taskDelegation: true,
      mcpScopeEvents: false,
      intercomEvents: true,
      intercomControlSubscription: false,
      sessionNaming: true,
      hil: false,
      uiCustom: false,
      shortcut: false,
      persistenceAppendEntry: false,
      subagentAdapterVia: "pi.callTool",
    };
    const report = doctorReport(makeDiscovery(), mixed);
    assert.ok(report.includes("task delegation: available via pi.callTool"));
    assert.ok(report.includes("mcp scope evts: unknown"));
    assert.ok(report.includes("intercom events: emit/on available"));
    assert.ok(report.includes("intercom channels: not subscribed"));
    assert.ok(report.includes("session naming: present"));
  });
});

describe("buildDoctorReport — direct workflow runtime", () => {
  test("reports direct execution and output artifact support", () => {
    const report = doctorReport(makeDiscovery(), allSiblings);
    assert.ok(report.includes("direct execution"));
    assert.ok(report.includes("single / parallel / chain"));
    assert.ok(report.includes("output artifacts"));
  });
});

// ---------------------------------------------------------------------------
// Integration: /workflows-doctor execute via MockExtensionAPI
// ---------------------------------------------------------------------------

describe("/workflows-doctor execute — integration", () => {
  test("produces multi-line output containing header", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.name === "workflows-doctor");
    assert.notEqual(cmd, undefined);
    const messages: string[] = [];
    await cmd!.options.handler("", { ui: { notify: (m: string) => messages.push(m) } });
    const combined = messages.join("\n");
    assert.ok(combined.includes("atomic-workflows doctor report"));
  });

  test("shows the [ REGISTRY ] band with a workflow count", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.name === "workflows-doctor");
    const messages: string[] = [];
    await cmd!.options.handler("", { ui: { notify: (m: string) => messages.push(m) } });
    const combined = messages.join("\n");
    assert.match(combined, /\[ REGISTRY \][^\n]*\d+ workflows? loaded/);
  });

  test("shows the [ DIAGNOSTICS ] band", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.name === "workflows-doctor");
    const messages: string[] = [];
    await cmd!.options.handler("", { ui: { notify: (m: string) => messages.push(m) } });
    const combined = messages.join("\n");
    assert.ok(combined.includes("[ DIAGNOSTICS ]"));
  });

  test("shows the [ HOST CAPABILITIES ] band", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.name === "workflows-doctor");
    const messages: string[] = [];
    await cmd!.options.handler("", { ui: { notify: (m: string) => messages.push(m) } });
    const combined = messages.join("\n");
    assert.ok(combined.includes("[ HOST CAPABILITIES ]"));
  });

  test("task delegation shows 'available' when callTool is present (no pi-subagents)", async () => {
    const api = makeMockApi({ callTool: async () => "ok" });
    factory(api);
    const cmd = api.commands.find((c) => c.name === "workflows-doctor");
    const messages: string[] = [];
    await cmd!.options.handler("", { ui: { notify: (m: string) => messages.push(m) } });
    assert.ok(messages.join("\n").includes("task delegation: available via pi.callTool"));
  });

  test("task delegation shows 'unavailable' when callTool and pi-subagents are both absent", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.name === "workflows-doctor");
    const messages: string[] = [];
    await cmd!.options.handler("", { ui: { notify: (m: string) => messages.push(m) } });
    assert.ok(messages.join("\n").includes("task delegation: unavailable"));
  });

  test("session naming shows 'present' when setSessionName present", async () => {
    const api = makeMockApi({ setSessionName: () => undefined });
    factory(api);
    const cmd = api.commands.find((c) => c.name === "workflows-doctor");
    const messages: string[] = [];
    await cmd!.options.handler("", { ui: { notify: (m: string) => messages.push(m) } });
    assert.ok(messages.join("\n").includes("session naming: present"));
  });

  test("does NOT say 'Phase B stub'", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.name === "workflows-doctor");
    const messages: string[] = [];
    await cmd!.options.handler("", { ui: { notify: (m: string) => messages.push(m) } });
    assert.ok(!messages.join("\n").includes("Phase B stub"));
  });

  test("does NOT say 'Executor: not yet implemented'", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.name === "workflows-doctor");
    const messages: string[] = [];
    await cmd!.options.handler("", { ui: { notify: (m: string) => messages.push(m) } });
    assert.ok(!messages.join("\n").includes("Executor: not yet implemented"));
  });
});

// ---------------------------------------------------------------------------
// Config diagnostics section
// ---------------------------------------------------------------------------

describe("buildDoctorReport — config diagnostics", () => {
  test("emits a 'config: not loaded' row when configLoad is undefined", () => {
    const report = doctorReport(makeDiscovery(), noSiblings);
    assert.ok(report.includes("config: not loaded"));
  });

  test("emits a 'config: not loaded' row when configLoad is null", () => {
    const report = doctorReport(makeDiscovery(), noSiblings, null);
    assert.ok(report.includes("config: not loaded"));
  });

  test("emits the diagnostics band when configLoad has no diagnostics", () => {
    const configLoad: ConfigLoadResult = { config: null, globalConfig: null, projectConfig: null, diagnostics: [] };
    const report = doctorReport(makeDiscovery(), noSiblings, configLoad);
    assert.ok(report.includes("[ DIAGNOSTICS ]"));
    assert.ok(report.includes("no problems found"));
  });

  test("lists config diagnostic with level, code, source, and message", () => {
    const configLoad: ConfigLoadResult = {
      config: null,
      globalConfig: null,
      projectConfig: null,
      diagnostics: [
        {
          level: "error",
          code: "CONFIG_INVALID",
          message: "Invalid JSON in config file: Unexpected token",
          source: "/project/.pi/extensions/workflow/config.json",
        },
      ],
    };
    const report = doctorReport(makeDiscovery(), noSiblings, configLoad);
    assert.ok(report.includes("[error]"));
    assert.ok(report.includes("CONFIG_INVALID"));
    assert.ok(report.includes("/project/.pi/extensions/workflow/config.json"));
    assert.ok(report.includes("Invalid JSON in config file"));
  });

  test("includes both diagnostics when there are multiple", () => {
    const configLoad: ConfigLoadResult = {
      config: null,
      globalConfig: null,
      projectConfig: null,
      diagnostics: [
        { level: "error", code: "CONFIG_INVALID", message: "err1", source: "/a.json" },
        { level: "error", code: "CONFIG_INVALID", message: "err2", source: "/b.json" },
      ],
    };
    const report = doctorReport(makeDiscovery(), noSiblings, configLoad);
    assert.ok(report.includes("err1"));
    assert.ok(report.includes("err2"));
  });

  test("shows diagnostic without source when source absent", () => {
    const configLoad: ConfigLoadResult = {
      config: null,
      globalConfig: null,
      projectConfig: null,
      diagnostics: [
        { level: "error", code: "CONFIG_INVALID", message: "some error" },
      ],
    };
    const report = doctorReport(makeDiscovery(), noSiblings, configLoad);
    assert.ok(report.includes("CONFIG_INVALID"));
    assert.ok(report.includes("some error"));
  });
});

// ---------------------------------------------------------------------------
// Tunables section
// ---------------------------------------------------------------------------

describe("buildDoctorReport — tunables", () => {
  test("shows default tunables when config is null", () => {
    const configLoad: ConfigLoadResult = { config: null, globalConfig: null, projectConfig: null, diagnostics: [] };
    const report = doctorReport(makeDiscovery(), noSiblings, configLoad);
    assert.ok(report.includes("[ TUNABLES ]"));
    assert.ok(report.includes("persistRuns: true"));
    assert.ok(report.includes("resumeInFlight: ask"));
    assert.ok(report.includes("defaultConcurrency: 4"));
    assert.ok(report.includes("maxDepth: 4"));
    assert.ok(report.includes("statusFile: false"));
  });

  test("shows default tunables when configLoad is undefined", () => {
    const report = doctorReport(makeDiscovery(), noSiblings);
    assert.ok(report.includes("[ TUNABLES ]"));
    assert.ok(report.includes("persistRuns: true"));
    assert.ok(report.includes("resumeInFlight: ask"));
    assert.ok(report.includes("defaultConcurrency: 4"));
    assert.ok(report.includes("maxDepth: 4"));
    assert.ok(report.includes("statusFile: false"));
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
      globalConfig: null,
      projectConfig: null,
      diagnostics: [],
    };
    const report = doctorReport(makeDiscovery(), noSiblings, configLoad);
    assert.ok(report.includes("persistRuns: false"));
    assert.ok(report.includes("resumeInFlight: auto"));
    assert.ok(report.includes("defaultConcurrency: 8"));
    assert.ok(report.includes("maxDepth: 2"));
    assert.ok(report.includes("statusFile: true"));
  });

  test("shows partial overrides; unset fields fall back to defaults", () => {
    const configLoad: ConfigLoadResult = {
      config: { maxDepth: 10 },
      globalConfig: null,
      projectConfig: null,
      diagnostics: [],
    };
    const report = doctorReport(makeDiscovery(), noSiblings, configLoad);
    assert.ok(report.includes("maxDepth: 10"));
    assert.ok(report.includes("persistRuns: true"));
    assert.ok(report.includes("defaultConcurrency: 4"));
  });
});

// ---------------------------------------------------------------------------
// Configured workflow entries section
// ---------------------------------------------------------------------------

describe("buildDoctorReport — configured workflows", () => {
  test("shows '(none configured)' placeholder when config has no workflows", () => {
    const configLoad: ConfigLoadResult = { config: {}, globalConfig: null, projectConfig: null, diagnostics: [] };
    const report = doctorReport(makeDiscovery(), noSiblings, configLoad);
    assert.ok(report.includes("[ CONFIGURED WORKFLOWS ]"));
    assert.ok(report.includes("no workflows configured in settings"));
  });

  test("shows '(none configured)' placeholder when configLoad is undefined", () => {
    const report = doctorReport(makeDiscovery(), noSiblings);
    assert.ok(report.includes("[ CONFIGURED WORKFLOWS ]"));
    assert.ok(report.includes("no workflows configured in settings"));
  });

  test("lists each configured workflow with name and path", () => {
    const configLoad: ConfigLoadResult = {
      config: {
        workflows: {
          "my-workflow": { path: "./workflows/my-workflow.ts" },
        },
      },
      globalConfig: null,
      projectConfig: null,
      diagnostics: [],
    };
    const report = doctorReport(makeDiscovery(), noSiblings, configLoad);
    assert.ok(report.includes("[ CONFIGURED WORKFLOWS ]"));
    assert.ok(report.includes("my-workflow: ./workflows/my-workflow.ts"));
  });

  test("lists multiple configured workflows", () => {
    const configLoad: ConfigLoadResult = {
      config: {
        workflows: {
          alpha: { path: "/abs/alpha.ts" },
          beta: { path: "./beta.ts" },
        },
      },
      globalConfig: null,
      projectConfig: null,
      diagnostics: [],
    };
    const report = doctorReport(makeDiscovery(), noSiblings, configLoad);
    assert.ok(report.includes("alpha: /abs/alpha.ts"));
    assert.ok(report.includes("beta: ./beta.ts"));
  });

  test("does NOT print file contents — only name and path", () => {
    const configLoad: ConfigLoadResult = {
      config: {
        workflows: {
          secret: { path: "./secret-workflow.ts" },
        },
      },
      globalConfig: null,
      projectConfig: null,
      diagnostics: [],
    };
    const report = doctorReport(makeDiscovery(), noSiblings, configLoad);
    // Only path, not any file content
    assert.ok(report.includes("secret: ./secret-workflow.ts"));
    assert.ok(!report.includes("FILE_CONTENTS"));
  });
});

// ---------------------------------------------------------------------------
// Section ordering
// ---------------------------------------------------------------------------

describe("buildDoctorReport — section ordering", () => {
  test("diagnostics appears before tunables", () => {
    const configLoad: ConfigLoadResult = { config: null, globalConfig: null, projectConfig: null, diagnostics: [] };
    const report = doctorReport(makeDiscovery(), noSiblings, configLoad);
    assert.ok(report.indexOf("[ DIAGNOSTICS ]") < report.indexOf("[ TUNABLES ]"));
  });

  test("tunables appears before configured workflows", () => {
    const configLoad: ConfigLoadResult = { config: null, globalConfig: null, projectConfig: null, diagnostics: [] };
    const report = doctorReport(makeDiscovery(), noSiblings, configLoad);
    assert.ok(report.indexOf("[ TUNABLES ]") < report.indexOf("[ CONFIGURED WORKFLOWS ]"));
  });

  test("configured workflows appears before host capabilities", () => {
    const configLoad: ConfigLoadResult = { config: null, globalConfig: null, projectConfig: null, diagnostics: [] };
    const report = doctorReport(makeDiscovery(), noSiblings, configLoad);
    assert.ok(report.indexOf("[ CONFIGURED WORKFLOWS ]") < report.indexOf("[ HOST CAPABILITIES ]"));
  });

  test("host capabilities appears before runtime adapters and companions", () => {
    const configLoad: ConfigLoadResult = { config: null, globalConfig: null, projectConfig: null, diagnostics: [] };
    const report = doctorReport(makeDiscovery(), noSiblings, configLoad);
    const caps = report.indexOf("[ HOST CAPABILITIES ]");
    const adapters = report.indexOf("[ RUNTIME ADAPTERS ]");
    const companions = report.indexOf("[ COMPANIONS ]");
    assert.ok(caps < adapters);
    assert.ok(adapters < companions);
  });
});

// ---------------------------------------------------------------------------
// Integration: /workflows-doctor includes new sections
// ---------------------------------------------------------------------------

describe("/workflows-doctor execute — config sections integration", () => {
  test("shows the [ DIAGNOSTICS ] band", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.name === "workflows-doctor");
    const messages: string[] = [];
    await cmd!.options.handler("", { ui: { notify: (m: string) => messages.push(m) } });
    assert.ok(messages.join("\n").includes("[ DIAGNOSTICS ]"));
  });

  test("shows the [ TUNABLES ] band", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.name === "workflows-doctor");
    const messages: string[] = [];
    await cmd!.options.handler("", { ui: { notify: (m: string) => messages.push(m) } });
    assert.ok(messages.join("\n").includes("[ TUNABLES ]"));
  });

  test("shows the [ CONFIGURED WORKFLOWS ] band", async () => {
    const api = makeMockApi();
    factory(api);
    const cmd = api.commands.find((c) => c.name === "workflows-doctor");
    const messages: string[] = [];
    await cmd!.options.handler("", { ui: { notify: (m: string) => messages.push(m) } });
    assert.ok(messages.join("\n").includes("[ CONFIGURED WORKFLOWS ]"));
  });
});
