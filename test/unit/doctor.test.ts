/**
 * Doctor payload + text-formatter tests.
 *
 * The payload builder is the source of truth — both `/workflows-doctor`
 * (chat-surface card) and `buildDoctorReport` (plain-text fallback)
 * derive from it. We exercise:
 *   - structured payload shape (sections, status rows, hints)
 *   - companion presence/missing
 *   - payload text rendering for RPC mode and environments without
 *     `pi.sendMessage`
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildDoctorPayload,
  buildDoctorReport,
  type DoctorPayload,
  type DoctorSiblingStatus,
} from "../../src/extension/doctor.js";
import { COMPANIONS, type CompanionStatus } from "../../src/extension/companions.js";
import { createRegistry } from "../../src/workflows/registry.js";
import type { DiscoveryResult } from "../../src/extension/discovery.js";

function emptyDiscovery(): DiscoveryResult {
  return {
    registry: createRegistry(),
    sources: [],
    errors: [],
  };
}

function findSection(payload: DoctorPayload, label: string) {
  const section = payload.sections.find((s) => s.label === label);
  if (!section) throw new Error(`expected section ${label} in payload`);
  return section;
}

function findRow(payload: DoctorPayload, section: string, label: string) {
  const sec = findSection(payload, section);
  const row = sec.rows.find((r) => r.label === label);
  if (!row) throw new Error(`expected row ${label} in section ${section}`);
  return row;
}

const allAbsent: DoctorSiblingStatus = {
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
  agentSessionAdapter: false,
};

const allPresent: DoctorSiblingStatus = {
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
  agentSessionAdapter: true,
};

const noCompanions: readonly CompanionStatus[] = COMPANIONS.map((companion) => ({
  companion,
  installed: false,
}));

const allCompanions: readonly CompanionStatus[] = COMPANIONS.map((companion) => ({
  companion,
  installed: true,
  evidence: `tool ${companion.toolHints[0] ?? companion.commandHints[0] ?? "synthetic"}`,
}));

describe("buildDoctorPayload — structure", () => {
  test("emits the standard section list in order", () => {
    const payload = buildDoctorPayload({
      discovery: emptyDiscovery(),
      siblings: allAbsent,
      companions: noCompanions,
    });
    const labels = payload.sections.map((s) => s.label);
    assert.deepEqual(labels, [
      "REGISTRY",
      "DIAGNOSTICS",
      "TUNABLES",
      "CONFIGURED WORKFLOWS",
      "DIRECT RUNTIME",
      "HOST CAPABILITIES",
      "RUNTIME ADAPTERS",
      "COMPANIONS",
    ]);
  });

  test("subtitle reflects workflow count and companion install ratio", () => {
    const payload = buildDoctorPayload({
      discovery: emptyDiscovery(),
      siblings: allAbsent,
      companions: noCompanions,
    });
    assert.match(payload.subtitle, /atomic-workflows · 0 workflows · 0\/\d+ companions/);
  });

  test("host capability rows flip ok/warn based on detection", () => {
    const ok = buildDoctorPayload({
      discovery: emptyDiscovery(),
      siblings: allPresent,
      companions: noCompanions,
    });
    assert.equal(findRow(ok, "HOST CAPABILITIES", "task delegation").status, "ok");
    assert.equal(findRow(ok, "HOST CAPABILITIES", "hil dialogs").value, "available");
    assert.equal(findRow(ok, "HOST CAPABILITIES", "intercom events").value, "emit/on available");
    assert.equal(findRow(ok, "RUNTIME ADAPTERS", "intercom channels").value, "workflow result/control + subagent bridge");

    const missing = buildDoctorPayload({
      discovery: emptyDiscovery(),
      siblings: allAbsent,
      companions: noCompanions,
    });
    assert.equal(findRow(missing, "HOST CAPABILITIES", "task delegation").status, "warn");
    assert.equal(findRow(missing, "HOST CAPABILITIES", "hil dialogs").value, "unavailable");
    assert.equal(findRow(missing, "HOST CAPABILITIES", "intercom events").status, "warn");
    assert.equal(findRow(missing, "RUNTIME ADAPTERS", "intercom channels").value, "not subscribed");
  });

  test("runtime adapter rows describe the subagent-via path", () => {
    const payload = buildDoctorPayload({
      discovery: emptyDiscovery(),
      siblings: allPresent,
      companions: noCompanions,
    });
    // `allPresent` sets subagentAdapterVia: "pi-subagents tool".
    assert.equal(
      findRow(payload, "RUNTIME ADAPTERS", "subagent").value,
      "via pi-subagents tool",
    );
    assert.equal(findRow(payload, "RUNTIME ADAPTERS", "agent session").value, "configured via pi SDK");
  });
});

describe("buildDoctorPayload — companions", () => {
  test("missing companions produce one install hint each", () => {
    const payload = buildDoctorPayload({
      discovery: emptyDiscovery(),
      siblings: allPresent,
      companions: noCompanions,
    });
    assert.equal(payload.hints.length, COMPANIONS.length);
    for (const hint of payload.hints) {
      assert.match(hint.command, /^pi install npm:/);
    }
  });

  test("all-installed companions produce zero install hints", () => {
    const payload = buildDoctorPayload({
      discovery: emptyDiscovery(),
      siblings: allPresent,
      companions: allCompanions,
    });
    assert.equal(payload.hints.length, 0);
  });

  test("companion rows carry the right status colour", () => {
    const payload = buildDoctorPayload({
      discovery: emptyDiscovery(),
      siblings: allPresent,
      companions: COMPANIONS.map((c, i) => ({
        companion: c,
        installed: i % 2 === 0,
        evidence: i % 2 === 0 ? "tool subagent" : undefined,
      })),
    });
    const companions = findSection(payload, "COMPANIONS");
    for (let i = 0; i < companions.rows.length; i++) {
      const row = companions.rows[i]!;
      const expected = i % 2 === 0 ? "ok" : "warn";
      assert.equal(row.status, expected, `row ${row.label} should be ${expected}`);
    }
  });

  test("counts aggregate ok/warn/fail across all sections", () => {
    const payload = buildDoctorPayload({
      discovery: emptyDiscovery(),
      siblings: allAbsent,
      companions: noCompanions,
    });
    assert.ok(payload.counts.warn > 0, "all-absent payload should have warnings");
    assert.ok(payload.counts.ok < payload.counts.warn, "more warns than oks when nothing is wired");
  });
});

describe("buildDoctorReport — text formatter", () => {
  test("payload signature renders sections, glyphs, and install hints", () => {
    const payload = buildDoctorPayload({
      discovery: emptyDiscovery(),
      siblings: allPresent,
      companions: noCompanions,
    });
    const text = buildDoctorReport(payload);
    assert.ok(text.includes("REGISTRY"));
    assert.ok(text.includes("HOST CAPABILITIES"));
    assert.ok(text.includes("COMPANIONS"));
    assert.ok(text.includes("NEXT STEPS"));
    for (const companion of COMPANIONS) {
      assert.ok(
        text.includes(`pi install ${companion.installSpec}`),
        `text should advertise install command for ${companion.name}`,
      );
    }
  });

  test("text formatter chooses glyphs by status", () => {
    const text = buildDoctorReport(
      buildDoctorPayload({
        discovery: emptyDiscovery(),
        siblings: allPresent,
        companions: allCompanions,
      }),
    );
    assert.ok(text.includes("✓"), "expected at least one ok glyph");
  });
});
