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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Presence/absence of optional sibling integrations.
 * True = the sibling surface was detected on the ExtensionAPI object.
 */
export interface DoctorSiblingStatus {
  readonly subagents: boolean;
  readonly mcpAdapter: boolean;
  readonly intercom: boolean;
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

/**
 * Build a human-readable doctor report string.
 *
 * Deterministic: same inputs → same output.  No I/O.
 *
 * @param discovery - Result from discoverBundledWorkflows().
 * @param siblings  - Detected sibling availability (structural checks on pi).
 * @returns Multi-line report string suitable for ctx.reply / ctx.print.
 */
export function buildDoctorReport(
  discovery: DiscoveryResult,
  siblings: DoctorSiblingStatus,
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

  // Sibling availability
  lines.push("Siblings:");
  lines.push(`  pi-subagents   — ${siblings.subagents ? "available" : "not detected"}`);
  lines.push(`  pi-mcp-adapter — ${siblings.mcpAdapter ? "available" : "not detected"}`);
  lines.push(`  pi-intercom    — ${siblings.intercom ? "available" : "not detected"}`);

  return lines.join("\n");
}
