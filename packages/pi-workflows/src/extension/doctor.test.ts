/**
 * Tests for buildDoctorReport.
 *
 * Exercises the pure report-builder function in isolation — no ExtensionAPI
 * mock required.
 *
 * cross-ref: packages/pi-workflows/src/extension/doctor.ts
 */

import { test, expect, describe } from "bun:test";
import { buildDoctorReport } from "./doctor.js";
import type { DoctorSiblingStatus } from "./doctor.js";
import { createRegistry } from "../workflows/registry.js";
import type { DiscoveryResult } from "./discovery.js";

// ---------------------------------------------------------------------------
// Minimal fixtures
// ---------------------------------------------------------------------------

function emptyDiscovery(): DiscoveryResult {
  return {
    registry: createRegistry(),
    sources: [],
    errors: [],
  };
}

const allAbsent: DoctorSiblingStatus = {
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

const allPresent: DoctorSiblingStatus = {
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

// ---------------------------------------------------------------------------
// hil field
// ---------------------------------------------------------------------------

describe("buildDoctorReport — hil field", () => {
  test("hil: false renders unavailable", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, hil: false });
    expect(report).toContain("hil            — unavailable");
  });

  test("hil: true renders available", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, hil: true });
    expect(report).toContain("hil            — available");
  });
});

// ---------------------------------------------------------------------------
// pi-subagents available / callable
// ---------------------------------------------------------------------------

describe("buildDoctorReport — pi-subagents callable", () => {
  test("subagents absent renders not detected", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, subagents: false, subagentsCallable: false });
    expect(report).toContain("pi-subagents   — not detected");
  });

  test("subagents present but not callable renders available", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, subagents: true, subagentsCallable: false });
    expect(report).toContain("pi-subagents   — available");
  });

  test("subagents present and callable renders available (callable)", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, subagents: true, subagentsCallable: true });
    expect(report).toContain("pi-subagents   — available (callable)");
  });
});

// ---------------------------------------------------------------------------
// pi-mcp-adapter + mcp scope events
// ---------------------------------------------------------------------------

describe("buildDoctorReport — mcp scope events", () => {
  test("mcpScopeEvents false renders unknown", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, mcpScopeEvents: false });
    expect(report).toContain("mcp scope evts — unknown");
  });

  test("mcpScopeEvents true renders known", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, mcpScopeEvents: true });
    expect(report).toContain("mcp scope evts — known");
  });
});

// ---------------------------------------------------------------------------
// ui.custom capability
// ---------------------------------------------------------------------------

describe("buildDoctorReport — ui.custom", () => {
  test("uiCustom false renders unavailable", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, uiCustom: false });
    expect(report).toContain("ui.custom      — unavailable");
  });

  test("uiCustom true renders available", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, uiCustom: true });
    expect(report).toContain("ui.custom      — available");
  });
});

// ---------------------------------------------------------------------------
// shortcut capability
// ---------------------------------------------------------------------------

describe("buildDoctorReport — shortcut", () => {
  test("shortcut false renders unavailable", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, shortcut: false });
    expect(report).toContain("shortcut       — unavailable");
  });

  test("shortcut true renders available", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, shortcut: true });
    expect(report).toContain("shortcut       — available");
  });
});

// ---------------------------------------------------------------------------
// exec abortable capability
// ---------------------------------------------------------------------------

describe("buildDoctorReport — exec abortable", () => {
  test("execAbortable false renders unavailable", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, execAbortable: false });
    expect(report).toContain("exec abortable — unavailable");
  });

  test("execAbortable true renders yes", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, execAbortable: true });
    expect(report).toContain("exec abortable — yes");
  });
});

// ---------------------------------------------------------------------------
// persistence appendEntry capability
// ---------------------------------------------------------------------------

describe("buildDoctorReport — persistence appendEntry", () => {
  test("persistenceAppendEntry false renders unavailable", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, persistenceAppendEntry: false });
    expect(report).toContain("persistence    — unavailable");
  });

  test("persistenceAppendEntry true renders appendEntry available", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, persistenceAppendEntry: true });
    expect(report).toContain("persistence    — appendEntry available");
  });
});

// ---------------------------------------------------------------------------
// Capabilities section — all fields
// ---------------------------------------------------------------------------

describe("buildDoctorReport — capabilities section", () => {
  test("all absent renders not-detected / unavailable / unknown", () => {
    const report = buildDoctorReport(emptyDiscovery(), allAbsent);
    expect(report).toContain("pi-subagents   — not detected");
    expect(report).toContain("pi-mcp-adapter — not detected");
    expect(report).toContain("mcp scope evts — unknown");
    expect(report).toContain("pi-intercom    — not detected");
    expect(report).toContain("hil            — unavailable");
    expect(report).toContain("ui.custom      — unavailable");
    expect(report).toContain("shortcut       — unavailable");
    expect(report).toContain("exec abortable — unavailable");
    expect(report).toContain("persistence    — unavailable");
  });

  test("all present renders available / known / yes", () => {
    const report = buildDoctorReport(emptyDiscovery(), allPresent);
    expect(report).toContain("pi-subagents   — available (callable)");
    expect(report).toContain("pi-mcp-adapter — available");
    expect(report).toContain("mcp scope evts — known");
    expect(report).toContain("pi-intercom    — present");
    expect(report).toContain("hil            — available");
    expect(report).toContain("ui.custom      — available");
    expect(report).toContain("shortcut       — available");
    expect(report).toContain("exec abortable — yes");
    expect(report).toContain("persistence    — appendEntry available");
  });
});

// ---------------------------------------------------------------------------
// Smoke — report structure
// ---------------------------------------------------------------------------

describe("buildDoctorReport — structure", () => {
  test("includes header", () => {
    const report = buildDoctorReport(emptyDiscovery(), allAbsent);
    expect(report).toContain("pi-workflows doctor report");
  });

  test("includes registry count", () => {
    const report = buildDoctorReport(emptyDiscovery(), allAbsent);
    expect(report).toContain("Registry: 0 workflow(s) loaded");
  });

  test("includes Capabilities section header", () => {
    const report = buildDoctorReport(emptyDiscovery(), allAbsent);
    expect(report).toContain("Capabilities:");
  });
});

// ---------------------------------------------------------------------------
// Runtime adapters — pi.exec
// ---------------------------------------------------------------------------

describe("buildDoctorReport — pi.exec capability", () => {
  test("execAbortable false renders unavailable under Runtime adapters", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, execAbortable: false });
    expect(report).toContain("pi.exec          — unavailable");
  });

  test("execAbortable true renders available under Runtime adapters", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, execAbortable: true });
    expect(report).toContain("pi.exec          — available");
  });
});

// ---------------------------------------------------------------------------
// Runtime adapters — prompt adapter
// ---------------------------------------------------------------------------

describe("buildDoctorReport — prompt adapter", () => {
  test("promptAdapter false renders unconfigured", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, promptAdapter: false });
    expect(report).toContain("prompt adapter   — unconfigured");
  });

  test("promptAdapter true renders configured", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, promptAdapter: true });
    expect(report).toContain("prompt adapter   — configured");
  });
});

// ---------------------------------------------------------------------------
// Runtime adapters — complete adapter
// ---------------------------------------------------------------------------

describe("buildDoctorReport — complete adapter", () => {
  test("completeAdapter false renders unconfigured", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, completeAdapter: false });
    expect(report).toContain("complete adapter — unconfigured");
  });

  test("completeAdapter true renders configured", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, completeAdapter: true });
    expect(report).toContain("complete adapter — configured");
  });
});

// ---------------------------------------------------------------------------
// Runtime adapters — subagent adapter via
// ---------------------------------------------------------------------------

describe("buildDoctorReport — subagent adapter via", () => {
  test("unavailable renders unavailable", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, subagentAdapterVia: "unavailable" });
    expect(report).toContain("subagent adapter — unavailable");
  });

  test("pi.subagents renders configured via pi.subagents", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, subagentAdapterVia: "pi.subagents" });
    expect(report).toContain("subagent adapter — configured via pi.subagents");
  });

  test("callTool renders configured via callTool", () => {
    const report = buildDoctorReport(emptyDiscovery(), { ...allAbsent, subagentAdapterVia: "callTool" });
    expect(report).toContain("subagent adapter — configured via callTool");
  });
});

// ---------------------------------------------------------------------------
// Runtime adapters — section header + combined
// ---------------------------------------------------------------------------

describe("buildDoctorReport — Runtime adapters section", () => {
  test("includes Runtime adapters header", () => {
    const report = buildDoctorReport(emptyDiscovery(), allAbsent);
    expect(report).toContain("Runtime adapters:");
  });

  test("all absent renders all unconfigured/unavailable", () => {
    const report = buildDoctorReport(emptyDiscovery(), allAbsent);
    expect(report).toContain("pi.exec          — unavailable");
    expect(report).toContain("prompt adapter   — unconfigured");
    expect(report).toContain("complete adapter — unconfigured");
    expect(report).toContain("subagent adapter — unavailable");
  });

  test("all present renders all configured/available", () => {
    const report = buildDoctorReport(emptyDiscovery(), allPresent);
    expect(report).toContain("pi.exec          — available");
    expect(report).toContain("prompt adapter   — configured");
    expect(report).toContain("complete adapter — configured");
    expect(report).toContain("subagent adapter — configured via pi.subagents");
  });
});
