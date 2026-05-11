/**
 * Doctor report builder for /workflows-doctor.
 *
 * Pure function — takes discovery result + sibling status, returns formatted
 * string.  Kept separate from index.ts so tests can exercise output without
 * spinning up a full ExtensionAPI mock.
 *
 * cross-ref: packages/pi-workflows/src/extension/discovery.ts
 *            packages/pi-workflows/src/extension/index.ts (wires execute)
 */

import type { DiscoveryResult } from "./discovery.js";
import type { ConfigLoadResult } from "./config-loader.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Presence/absence of optional sibling integrations.
 * True = the sibling surface was detected on the ExtensionAPI object.
 */
export interface DoctorSiblingStatus {
  readonly subagents: boolean;
  /** True when pi.subagents has a callable run() method. */
  readonly subagentsCallable: boolean;
  readonly mcpAdapter: boolean;
  /** True when pi-mcp-adapter emits scope-based events. */
  readonly mcpScopeEvents: boolean;
  readonly intercom: boolean;
  /** True when pi.ui is present — HIL dialog adapter is available. */
  readonly hil: boolean;
  /** True when pi.ui.custom is present — custom overlay panel available. */
  readonly uiCustom: boolean;
  /** True when pi.registerShortcut is present — F2 and other shortcuts available. */
  readonly shortcut: boolean;
  /** True when pi.exec is present — abortable stage execution available. */
  readonly execAbortable: boolean;
  /** True when pi.appendEntry is present — persistence transcript available. */
  readonly persistenceAppendEntry: boolean;
  // ---------------------------------------------------------------------------
  // Runtime adapter capabilities (populated by buildRuntimeAdapters surface checks)
  // ---------------------------------------------------------------------------
  /** True when prompt adapter is configured (requires pi.exec). */
  readonly promptAdapter: boolean;
  /** True when complete adapter is configured (requires pi.exec). */
  readonly completeAdapter: boolean;
  /**
   * How the subagent adapter is wired:
   * - "pi.subagents" — pi.subagents.run() present (primary path)
   * - "callTool"     — pi.callTool present, pi.subagents.run absent (fallback path)
   * - "unavailable"  — neither surface detected
   */
  readonly subagentAdapterVia: "pi.subagents" | "callTool" | "unavailable";
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Default tunable values per RFC. */
const DEFAULTS = {
  persistRuns: true,
  resumeInFlight: "ask" as const,
  defaultConcurrency: 4,
  maxDepth: 4,
  statusFile: false,
} as const;

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

/**
 * Build a human-readable doctor report string.
 *
 * Deterministic: same inputs → same output.  No I/O.
 *
 * @param discovery  - Result from discoverBundledWorkflows().
 * @param siblings   - Detected sibling availability (structural checks on pi).
 * @param configLoad - Optional result from loadWorkflowConfig().
 * @returns Multi-line report string suitable for ctx.reply / ctx.print.
 */
export function buildDoctorReport(
  discovery: DiscoveryResult,
  siblings: DoctorSiblingStatus,
  configLoad?: ConfigLoadResult | null,
): string {
  const lines: string[] = [
    "pi-workflows doctor report",
    "──────────────────────────",
  ];

  // Registry count
  const count = discovery.registry.names().length;
  lines.push(`Registry: ${count} workflow(s) loaded`);

  // Bundled sources
  if (discovery.sources.length > 0) {
    lines.push(`Bundled sources (${discovery.sources.length}):`);
    for (const src of discovery.sources) {
      lines.push(`  [${src.kind}] ${src.id} — ${src.name}`);
    }
  } else {
    lines.push("Bundled sources: (none)");
  }

  // Discovery diagnostics
  if (discovery.errors.length > 0) {
    lines.push(`Discovery diagnostics (${discovery.errors.length}):`);
    for (const diag of discovery.errors) {
      const src = diag.source ? ` (${diag.source})` : "";
      lines.push(`  [${diag.level}] ${diag.code}${src}: ${diag.message}`);
    }
  } else {
    lines.push("Discovery diagnostics: (none)");
  }

  // Config diagnostics
  if (configLoad == null) {
    lines.push("Config diagnostics: (not loaded)");
  } else if (configLoad.diagnostics.length > 0) {
    lines.push(`Config diagnostics (${configLoad.diagnostics.length}):`);
    for (const diag of configLoad.diagnostics) {
      const src = diag.source ? ` (${diag.source})` : "";
      lines.push(`  [${diag.level}] ${diag.code}${src}: ${diag.message}`);
    }
  } else {
    lines.push("Config diagnostics: (none)");
  }

  // Effective tunables
  const cfg = configLoad?.config ?? null;
  lines.push("Tunables:");
  lines.push(`  persistRuns        — ${cfg?.persistRuns ?? DEFAULTS.persistRuns}`);
  lines.push(`  resumeInFlight     — ${cfg?.resumeInFlight ?? DEFAULTS.resumeInFlight}`);
  lines.push(`  defaultConcurrency — ${cfg?.defaultConcurrency ?? DEFAULTS.defaultConcurrency}`);
  lines.push(`  maxDepth           — ${cfg?.maxDepth ?? DEFAULTS.maxDepth}`);
  lines.push(`  statusFile         — ${cfg?.statusFile ?? DEFAULTS.statusFile}`);

  // Configured workflow entries
  const workflows = cfg?.workflows;
  const workflowEntries = workflows ? Object.entries(workflows) : [];
  if (workflowEntries.length > 0) {
    lines.push(`Configured workflows (${workflowEntries.length}):`);
    for (const [name, entry] of workflowEntries) {
      lines.push(`  ${name} → ${entry.path}`);
    }
  } else {
    lines.push("Configured workflows: (none configured)");
  }

  // Sibling availability + runtime capabilities
  lines.push("Capabilities:");

  // pi-subagents: available (callable) / available / not detected
  const subagentsValue = !siblings.subagents
    ? "not detected"
    : siblings.subagentsCallable
      ? "available (callable)"
      : "available";
  lines.push(`  pi-subagents   — ${subagentsValue}`);

  // pi-mcp-adapter: available / not detected
  lines.push(`  pi-mcp-adapter — ${siblings.mcpAdapter ? "available" : "not detected"}`);

  // mcp scope events: known / unknown
  lines.push(`  mcp scope evts — ${siblings.mcpScopeEvents ? "known" : "unknown"}`);

  // pi-intercom: present / not detected
  lines.push(`  pi-intercom    — ${siblings.intercom ? "present" : "not detected"}`);

  // hil (pi.ui dialogs): available / unavailable
  lines.push(`  hil            — ${siblings.hil ? "available" : "unavailable"}`);

  // ui.custom (custom overlay UI): available / unavailable
  lines.push(`  ui.custom      — ${siblings.uiCustom ? "available" : "unavailable"}`);

  // shortcut registration: available / unavailable
  lines.push(`  shortcut       — ${siblings.shortcut ? "available" : "unavailable"}`);

  // abortable exec: yes / unavailable
  lines.push(`  exec abortable — ${siblings.execAbortable ? "yes" : "unavailable"}`);

  // persistence appendEntry: appendEntry available / unavailable
  lines.push(`  persistence    — ${siblings.persistenceAppendEntry ? "appendEntry available" : "unavailable"}`);

  // Runtime adapter capabilities
  lines.push("Runtime adapters:");

  // pi.exec: available / unavailable
  lines.push(`  pi.exec          — ${siblings.execAbortable ? "available" : "unavailable"}`);

  // prompt adapter: configured / unconfigured
  lines.push(`  prompt adapter   — ${siblings.promptAdapter ? "configured" : "unconfigured"}`);

  // complete adapter: configured / unconfigured
  lines.push(`  complete adapter — ${siblings.completeAdapter ? "configured" : "unconfigured"}`);

  // subagent adapter: configured via pi.subagents / callTool / unavailable
  const subagentAdapterLabel =
    siblings.subagentAdapterVia === "pi.subagents"
      ? "configured via pi.subagents"
      : siblings.subagentAdapterVia === "callTool"
        ? "configured via callTool"
        : "unavailable";
  lines.push(`  subagent adapter — ${subagentAdapterLabel}`);

  return lines.join("\n");
}
