/**
 * Doctor report for `/workflows-doctor`.
 *
 * Two public surfaces, same underlying data:
 *  - {@link buildDoctorPayload} returns a structured `DoctorPayload`
 *    consumed by {@link renderDoctorCard} (chat-surface card with stripes,
 *    bands, and `pi install` hint rows).
 *  - {@link buildDoctorReport} returns a plain-text rendering for tests
 *    and any caller that prefers `ctx.ui.notify`-style output.
 *
 * Both are pure functions — no I/O, no globals.
 *
 * cross-ref:
 *  - src/extension/companions.ts — companion-package detection
 *  - src/tui/doctor-card.ts — pi-tui card rendering
 *  - src/extension/index.ts — wires `/workflows-doctor` to emitChatSurface
 */

import type { DiscoveryResult } from "./discovery.js";
import type { ConfigLoadResult } from "./config-loader.js";
import type { CompanionStatus } from "./companions.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Presence/absence of optional pi runtime capabilities.
 * True = the surface was detected on the ExtensionAPI object or command context.
 */
export interface DoctorSiblingStatus {
  /**
   * Whether stage delegation can reach a subagent runtime. Derived from
   * {@link subagentAdapterVia} — `true` when any non-`"unavailable"` path is
   * detected (pi-subagents tool registered via companion install, or a
   * future pi.callTool API).
   */
  readonly taskDelegation: boolean;
  /** True when the host event bus can emit workflow-scoped MCP events. */
  readonly mcpScopeEvents: boolean;
  /** True when pi-intercom-style event emit/on surfaces are present. */
  readonly intercomEvents?: boolean;
  /** True when workflow/subagent intercom control routing is subscribed. */
  readonly intercomControlSubscription?: boolean;
  /** True when session naming is available for child-session correlation. */
  readonly sessionNaming: boolean;
  /** True when ctx.ui is present — HIL dialog adapter is available. */
  readonly hil: boolean;
  /** True when ctx.ui.custom is present — custom overlay panel available. */
  readonly uiCustom: boolean;
  /** True when pi.registerShortcut is present — F2 and other shortcuts available. */
  readonly shortcut: boolean;
  /** True when pi.appendEntry is present — persistence transcript available. */
  readonly persistenceAppendEntry: boolean;
  /** True when the SDK AgentSession adapter is configured. */
  readonly agentSessionAdapter?: boolean;
  /**
   * How subagent delegation is reached:
   *  - `"pi-subagents tool"` — `pi-subagents` companion is installed and its
   *    `subagent` tool is registered; the LLM can invoke it directly.
   *    Workflow stages that call subagent.* go through the tool surface.
   *  - `"pi.callTool"` — the host exposes a direct extension-to-extension
   *    call API. Not part of pi v0.74's public ExtensionAPI; reserved for
   *    forward-compat with hosts that add it later.
   *  - `"unavailable"` — neither signal is present.
   */
  readonly subagentAdapterVia?: "unavailable" | "pi-subagents tool" | "pi.callTool";
}

/** Status family carried by the doctor card and the text formatter. */
export type DoctorStatus = "ok" | "warn" | "fail" | "info" | "dim";

/** One row within a doctor section. Renders as `label  value` with `status` colour. */
export interface DoctorRow {
  readonly label: string;
  readonly value: string;
  readonly status: DoctorStatus;
  /** Optional dim suffix in parentheses (path, package version, evidence). */
  readonly hint?: string;
}

/** One section, rendered as a `[ LABEL ]` band followed by indented rows. */
export interface DoctorSection {
  /** Uppercased band label, e.g. `REGISTRY`, `COMPANIONS`. */
  readonly label: string;
  /** Right-aligned summary (`3 workflows`, `2 / 4 installed`). */
  readonly subtitle?: string;
  readonly rows: readonly DoctorRow[];
}

/** Trailing `▸ pi install npm:...` action rows. */
export interface DoctorHint {
  /** Full slash-style action, e.g. `pi install npm:pi-subagents`. */
  readonly command: string;
  /** Short reason the user is being shown this hint. */
  readonly description: string;
}

/** Top-level payload consumed by the renderer. */
export interface DoctorPayload {
  /** Subtitle next to the `[ DOCTOR ]` band — e.g. `atomic-workflows · 3 workflows`. */
  readonly subtitle: string;
  readonly sections: readonly DoctorSection[];
  readonly hints: readonly DoctorHint[];
  /** Top-line counts used for the band badge column. */
  readonly counts: { readonly ok: number; readonly warn: number; readonly fail: number };
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const DEFAULTS = {
  persistRuns: true,
  resumeInFlight: "ask" as const,
  defaultConcurrency: 4,
  maxDepth: 4,
  statusFile: false,
} as const;

const BOOL_STATUS = (ok: boolean): DoctorStatus => (ok ? "ok" : "warn");

// ---------------------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------------------

export interface BuildDoctorPayloadInput {
  readonly discovery: DiscoveryResult;
  readonly siblings: DoctorSiblingStatus;
  readonly companions: readonly CompanionStatus[];
  readonly configLoad?: ConfigLoadResult | null;
}

/**
 * Compose the structured doctor payload. Deterministic.
 *
 * The layout intentionally mirrors what `/subagents-doctor` produces in
 * pi-subagents: a band per section + concise `label  value` rows + a
 * trailing block of actionable install hints. We use this extension's
 * existing chat-surface vocabulary (bands, stripes, hint rows) for the
 * rendered output so the doctor card visually belongs to the same surface
 * family as `/workflow status` and `/workflow list`.
 */
export function buildDoctorPayload(input: BuildDoctorPayloadInput): DoctorPayload {
  const { discovery, siblings, companions, configLoad } = input;
  const cfg = configLoad?.config ?? null;
  const workflowEntries = cfg?.workflows ? Object.entries(cfg.workflows) : [];

  const sections: DoctorSection[] = [
    registrySection(discovery),
    diagnosticsSection(discovery, configLoad ?? null),
    tunablesSection(cfg),
    workflowsSection(workflowEntries),
    directRuntimeSection(),
    capabilitiesSection(siblings),
    runtimeAdaptersSection(siblings),
    companionsSection(companions),
  ];

  // The hint block lives at the bottom so the user's eye lands on it
  // after scanning the status rows — same pattern as `/workflow status`'s
  // trailing `▸ /workflow status <id>` hint.
  const hints: DoctorHint[] = companions
    .filter((c) => !c.installed)
    .map((c) => ({
      command: `pi install ${c.companion.installSpec}`,
      description: `enable ${c.companion.name} — ${c.companion.purpose}`,
    }));

  const counts = countStatuses(sections);
  const workflowCount = discovery.registry.names().length;
  const installedCompanions = companions.filter((c) => c.installed).length;
  const subtitle =
    `atomic-workflows · ${workflowCount} workflow${workflowCount === 1 ? "" : "s"}` +
    ` · ${installedCompanions}/${companions.length} companions`;

  return { subtitle, sections, hints, counts };
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function registrySection(discovery: DiscoveryResult): DoctorSection {
  const count = discovery.registry.names().length;
  const sourceRows: DoctorRow[] = discovery.sources.map((src) => ({
    label: src.name,
    value: src.id,
    status: "info",
    hint: src.kind,
  }));

  return {
    label: "REGISTRY",
    subtitle: `${count} workflow${count === 1 ? "" : "s"} loaded`,
    rows:
      sourceRows.length > 0
        ? sourceRows
        : [{ label: "(none)", value: "no bundled workflows discovered", status: "warn" }],
  };
}

function diagnosticsSection(
  discovery: DiscoveryResult,
  configLoad: ConfigLoadResult | null,
): DoctorSection {
  const rows: DoctorRow[] = [];
  for (const d of discovery.errors) {
    rows.push({
      label: `[${d.level}] ${d.code}`,
      value: d.message,
      status: d.level === "error" ? "fail" : "warn",
      hint: d.source,
    });
  }
  if (configLoad == null) {
    rows.push({ label: "config", value: "not loaded", status: "dim" });
  } else {
    for (const d of configLoad.diagnostics) {
      rows.push({
        label: `[${d.level}] ${d.code}`,
        value: d.message,
        status: d.level === "error" ? "fail" : "warn",
        hint: d.source,
      });
    }
  }

  return {
    label: "DIAGNOSTICS",
    subtitle: rows.length > 0 ? `${rows.length} item${rows.length === 1 ? "" : "s"}` : "all clear",
    rows: rows.length > 0 ? rows : [{ label: "(none)", value: "no problems found", status: "ok" }],
  };
}

function tunablesSection(cfg: ConfigLoadResult["config"] | null): DoctorSection {
  return {
    label: "TUNABLES",
    rows: [
      tunableRow("persistRuns", cfg?.persistRuns ?? DEFAULTS.persistRuns),
      tunableRow("resumeInFlight", cfg?.resumeInFlight ?? DEFAULTS.resumeInFlight),
      tunableRow("defaultConcurrency", cfg?.defaultConcurrency ?? DEFAULTS.defaultConcurrency),
      tunableRow("maxDepth", cfg?.maxDepth ?? DEFAULTS.maxDepth),
      tunableRow("statusFile", cfg?.statusFile ?? DEFAULTS.statusFile),
    ],
  };
}

function workflowsSection(entries: ReadonlyArray<[string, { path: string }]>): DoctorSection {
  if (entries.length === 0) {
    return {
      label: "CONFIGURED WORKFLOWS",
      rows: [{ label: "(none)", value: "no workflows configured in settings", status: "dim" }],
    };
  }
  return {
    label: "CONFIGURED WORKFLOWS",
    subtitle: `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
    rows: entries.map(([name, entry]) => ({
      label: name,
      value: entry.path,
      status: "info",
    })),
  };
}

function directRuntimeSection(): DoctorSection {
  return {
    label: "DIRECT RUNTIME",
    rows: [
      {
        label: "direct execution",
        value: "single / parallel / chain",
        status: "ok",
      },
      {
        label: "output artifacts",
        value: "inline / file-only",
        status: "ok",
      },
    ],
  };
}

function capabilitiesSection(s: DoctorSiblingStatus): DoctorSection {
  const taskValue = describeSubagentVia(s.subagentAdapterVia, "capability");
  return {
    label: "HOST CAPABILITIES",
    rows: [
      { label: "task delegation", value: taskValue, status: BOOL_STATUS(s.taskDelegation) },
      { label: "mcp scope evts", value: s.mcpScopeEvents ? "known" : "unknown", status: BOOL_STATUS(s.mcpScopeEvents) },
      { label: "intercom events", value: s.intercomEvents ? "emit/on available" : "unavailable", status: BOOL_STATUS(s.intercomEvents === true) },
      { label: "session naming", value: s.sessionNaming ? "present" : "unavailable", status: BOOL_STATUS(s.sessionNaming) },
      { label: "hil dialogs", value: s.hil ? "available" : "unavailable", status: BOOL_STATUS(s.hil) },
      { label: "ui.custom overlay", value: s.uiCustom ? "available" : "unavailable", status: BOOL_STATUS(s.uiCustom) },
      { label: "shortcut (F2)", value: s.shortcut ? "available" : "unavailable", status: BOOL_STATUS(s.shortcut) },
      { label: "persistence appendEntry", value: s.persistenceAppendEntry ? "available" : "unavailable", status: BOOL_STATUS(s.persistenceAppendEntry) },
    ],
  };
}

function runtimeAdaptersSection(s: DoctorSiblingStatus): DoctorSection {
  const subagentValue = describeSubagentVia(s.subagentAdapterVia, "adapter");
  const subagentStatus: DoctorStatus = s.subagentAdapterVia && s.subagentAdapterVia !== "unavailable" ? "ok" : "warn";
  return {
    label: "RUNTIME ADAPTERS",
    rows: [
      { label: "agent session", value: s.agentSessionAdapter ? "configured via pi SDK" : "unconfigured", status: BOOL_STATUS(s.agentSessionAdapter === true) },
      { label: "subagent",      value: subagentValue, status: subagentStatus },
      {
        label: "intercom channels",
        value: s.intercomControlSubscription
          ? "workflow result/control + subagent bridge"
          : "not subscribed",
        status: BOOL_STATUS(s.intercomControlSubscription === true),
      },
    ],
  };
}

/**
 * Map `subagentAdapterVia` to a human-readable value. The wording
 * differs slightly between `capability` ("available via X") and
 * `adapter` ("via X tool") so the same string fits both row labels
 * naturally.
 */
function describeSubagentVia(
  via: DoctorSiblingStatus["subagentAdapterVia"],
  context: "capability" | "adapter",
): string {
  if (via === "pi-subagents tool") {
    return context === "capability" ? "available via pi-subagents" : "via pi-subagents tool";
  }
  if (via === "pi.callTool") {
    return context === "capability" ? "available via pi.callTool" : "via pi.callTool";
  }
  return "unavailable";
}

function companionsSection(companions: readonly CompanionStatus[]): DoctorSection {
  const installed = companions.filter((c) => c.installed).length;
  return {
    label: "COMPANIONS",
    subtitle: `${installed}/${companions.length} installed · pi packages`,
    rows: companions.map<DoctorRow>((c) => ({
      label: c.companion.name,
      value: c.installed ? "installed" : "missing",
      status: c.installed ? "ok" : "warn",
      hint: c.installed ? c.evidence : c.companion.purpose,
    })),
  };
}

function tunableRow(label: string, value: unknown): DoctorRow {
  return { label, value: String(value), status: "info" };
}

// ---------------------------------------------------------------------------
// Plain-text formatter (RPC / print-mode fallback)
// ---------------------------------------------------------------------------

/**
 * Render a `DoctorPayload` as plain ASCII. Used when `pi.sendMessage`
 * isn't wired (RPC, `--print`, some test harnesses) — the rich,
 * themed surface lives in `renderDoctorCard`.
 *
 * Format: one `[ LABEL ]` band per section, status-glyph + `key:
 * value` rows underneath, optional `▸ pi install …` hint block.
 */
export function buildDoctorReport(payload: DoctorPayload): string {
  return renderPayloadAsText(payload);
}

function renderPayloadAsText(payload: DoctorPayload): string {
  const lines: string[] = [
    "atomic-workflows doctor report",
    payload.subtitle,
  ];
  for (const section of payload.sections) {
    lines.push("");
    const subtitle = section.subtitle ? `  —  ${section.subtitle}` : "";
    lines.push(`[ ${section.label} ]${subtitle}`);
    for (const row of section.rows) {
      const glyph = formatStatusGlyph(row.status);
      const hint = row.hint ? `  (${row.hint})` : "";
      lines.push(`  ${glyph} ${row.label}: ${row.value}${hint}`);
    }
  }
  if (payload.hints.length > 0) {
    lines.push("");
    lines.push("[ NEXT STEPS ]");
    for (const hint of payload.hints) {
      lines.push(`  ▸ ${hint.command}   ${hint.description}`);
    }
  }
  return lines.join("\n");
}

function formatStatusGlyph(status: DoctorStatus): string {
  switch (status) {
    case "ok":   return "✓";
    case "warn": return "⚠";
    case "fail": return "✗";
    case "info": return "·";
    case "dim":  return " ";
  }
}

function countStatuses(sections: readonly DoctorSection[]): { ok: number; warn: number; fail: number } {
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const section of sections) {
    for (const row of section.rows) {
      if (row.status === "ok") counts.ok += 1;
      else if (row.status === "warn") counts.warn += 1;
      else if (row.status === "fail") counts.fail += 1;
    }
  }
  return counts;
}
