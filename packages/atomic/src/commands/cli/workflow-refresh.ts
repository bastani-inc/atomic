/**
 * `atomic workflow refresh` — re-spawn the metadata loaders for every
 * `workflows.<alias>` entry in `~/.atomic/settings.json` (global) and
 * `<cwd>/.atomic/settings.json` (local), merge them into the active
 * registry, and report the result.
 *
 * Why this exists: when an LM authors a new custom workflow under
 * `.atomic/workflows/<name>/` and edits `settings.json`, it needs an
 * explicit confirmation that the entry parsed, the metadata subprocess
 * succeeded, and the workflow is now invocable via
 * `atomic workflow -n <name> -a <agent>`. Bootstrap runs on every CLI
 * invocation, so technically the refresh is a no-op in terms of process
 * state — but it produces a single, structured, LM-actionable report
 * that ends the "did this work?" conversation in one command.
 *
 * Output is engineered for an LM consumer:
 *   - `--format text` (TTY default) — colourised, but every diagnostic
 *     line is a `key · value` pair so an LM screen-scraping the output
 *     can extract reason / fix / source / command without parsing prose.
 *   - `--format json` (default inside an atomic chat session, detected
 *     via `ATOMIC_AGENT`) — fully structured payload with the same
 *     fields as the text view.
 *
 * Exit codes:
 *   0 — every entry loaded clean, OR there were broken entries but at
 *       least one entry loaded (broken entries are surfaced as warnings
 *       so the model can fix them without aborting follow-up work).
 *   1 — every entry was broken, OR there were broken entries and zero
 *       loaded (i.e. nothing the model can run yet).
 *
 * Note: an empty settings.json (no `workflows` map) returns 0 with an
 * empty payload — that's a valid state, not an error.
 */

import {
  COLORS,
  createPainter,
} from "@bastani/atomic-sdk/theme/colors";
import type {
  BrokenWorkflow,
  ExternalWorkflow,
  WorkflowInput,
} from "@bastani/atomic-sdk";
import {
  bootstrapCustomWorkflows,
  type BootstrapResult,
  type LoadedWorkflow,
} from "../custom-workflows.ts";
import { rebuildWorkflowCommand } from "./workflow.ts";

export type RefreshFormat = "text" | "json";

export interface WorkflowRefreshOptions {
  /**
   * `text` for human consumption, `json` for LMs / scripts. When omitted,
   * defaults to `json` if `ATOMIC_AGENT` is set in the env (i.e. the caller
   * is running inside an atomic chat session and the consumer is an LM),
   * otherwise `text`.
   */
  format?: RefreshFormat;
}

export interface WorkflowRefreshDeps {
  bootstrap: (projectDir: string) => Promise<BootstrapResult>;
  rebuild: typeof rebuildWorkflowCommand;
  cwd: () => string;
  /** Read an env var. Injected so tests can simulate ATOMIC_AGENT presence. */
  env: (name: string) => string | undefined;
}

export const defaultDeps: WorkflowRefreshDeps = {
  bootstrap: bootstrapCustomWorkflows,
  rebuild: rebuildWorkflowCommand,
  cwd: () => process.cwd(),
  env: (name) => process.env[name],
};

// ─── JSON payload shape (stable contract — LMs parse this) ───────────────────

export interface RefreshLoadedJson {
  alias: string;
  origin: "local" | "global";
  name: string;
  agent: string;
  description: string;
  inputs: WorkflowInput[];
  command: string;
  args: string[];
  /** `workflows.<alias>` — the JSON Pointer-ish key the model edits in settings.json. */
  settingsKey: string;
  /** Absolute path of the settings.json the entry was read from. */
  settingsPath: string;
}

export interface RefreshBrokenJson {
  alias: string;
  origin: "local" | "global";
  agents: readonly string[];
  reason: string;
  fix: string;
  settingsKey: string;
  settingsPath: string;
}

export interface RefreshJsonPayload {
  ok: boolean;
  counts: { loaded: number; broken: number };
  paths: { global: string; local: string };
  loaded: RefreshLoadedJson[];
  broken: RefreshBrokenJson[];
}

// ─── Format resolution ───────────────────────────────────────────────────────

function resolveFormat(
  explicit: RefreshFormat | undefined,
  env: WorkflowRefreshDeps["env"],
): RefreshFormat {
  if (explicit) return explicit;
  // Inside an atomic chat session the agent (LM) is the consumer; emit
  // structured JSON by default so it can ingest results without prose
  // parsing. ATOMIC_AGENT is baked into every chat-launcher env (see
  // `commands/cli/chat/index.ts`) and the workflow runtime env (see
  // `sdk/runtime/executor.ts`).
  return env("ATOMIC_AGENT") ? "json" : "text";
}

// ─── Payload assembly ────────────────────────────────────────────────────────

function pickSettingsPath(
  origin: "local" | "global",
  paths: BootstrapResult["paths"],
): string {
  return origin === "local" ? paths.local : paths.global;
}

function loadedToJson(
  entry: LoadedWorkflow,
  paths: BootstrapResult["paths"],
): RefreshLoadedJson {
  const wf: ExternalWorkflow = entry.workflow;
  return {
    alias: entry.alias,
    origin: entry.origin,
    name: wf.name,
    agent: wf.agent,
    description: wf.description ?? "",
    inputs: [...wf.inputs],
    command: wf.source.command,
    args: [...wf.source.args],
    settingsKey: `workflows.${entry.alias}`,
    settingsPath: pickSettingsPath(entry.origin, paths),
  };
}

function brokenToJson(entry: BrokenWorkflow): RefreshBrokenJson {
  return {
    alias: entry.alias,
    origin: entry.origin,
    agents: entry.agents,
    reason: entry.reason,
    fix: entry.fix,
    settingsKey: `workflows.${entry.alias}`,
    settingsPath: entry.source,
  };
}

function buildPayload(result: BootstrapResult): RefreshJsonPayload {
  const loaded = result.loaded.map((l) => loadedToJson(l, result.paths));
  const broken = result.brokenList.map(brokenToJson);
  // ok = "the model can act on at least one workflow and isn't blocked
  // entirely by load failures". An all-empty result is also ok (valid
  // empty state — nothing to fix, nothing to run).
  const ok = broken.length === 0 || loaded.length > 0;
  return {
    ok,
    counts: { loaded: loaded.length, broken: broken.length },
    paths: result.paths,
    loaded,
    broken,
  };
}

// ─── Text renderer ───────────────────────────────────────────────────────────

function formatInputForDisplay(input: WorkflowInput): string {
  const requiredTag = input.required ? "required" : "optional";
  const typeTag = input.type === "enum"
    ? `enum[${(input.values ?? []).join("|")}]`
    : input.type;
  const defaultTag =
    "default" in input && input.default !== undefined
      ? `, default=${JSON.stringify(input.default)}`
      : "";
  return `${input.name} (${typeTag}, ${requiredTag}${defaultTag})`;
}

function renderText(payload: RefreshJsonPayload): string {
  const paint = createPainter();
  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push("");
  lines.push(
    "  " +
      paint("text", `Reloaded ${payload.counts.loaded} workflow(s)`, { bold: true }) +
      paint("dim", " · ") +
      paint(
        payload.counts.broken > 0 ? "warning" : "dim",
        `${payload.counts.broken} broken`,
      ),
  );

  // ── Loaded section ────────────────────────────────────────────────────────
  if (payload.loaded.length > 0) {
    lines.push("");
    lines.push("  " + paint("dim", "LOADED"));
    for (const w of payload.loaded) {
      lines.push("");
      lines.push(
        "  " +
          paint("success", "✓") +
          " " +
          paint("text", w.alias, { bold: true }) +
          "  " +
          paint("dim", `(${w.origin})`),
      );
      lines.push("    " + paint("dim", "name    · ") + paint("text", w.name));
      lines.push("    " + paint("dim", "agent   · ") + paint("accent", w.agent));
      if (w.description) {
        lines.push("    " + paint("dim", "desc    · ") + paint("text", w.description));
      }
      const inputsLine =
        w.inputs.length === 0
          ? paint("dim", "(none)")
          : w.inputs.map(formatInputForDisplay).join(", ");
      lines.push("    " + paint("dim", "inputs  · ") + inputsLine);
      const cmdLine = [w.command, ...w.args].join(" ");
      lines.push("    " + paint("dim", "command · ") + paint("text", cmdLine));
      lines.push(
        "    " +
          paint("dim", "settings · ") +
          paint("text", `${w.settingsPath} (${w.settingsKey})`),
      );
    }
  }

  // ── Broken section ────────────────────────────────────────────────────────
  if (payload.broken.length > 0) {
    lines.push("");
    lines.push("  " + paint("error", "BROKEN"));
    for (const b of payload.broken) {
      lines.push("");
      lines.push(
        "  " +
          paint("error", "✗") +
          " " +
          paint("error", b.alias) +
          "  " +
          paint("dim", `(${b.origin})`) +
          "  " +
          paint("dim", `agents: ${b.agents.join(", ")}`),
      );
      // Reason / fix / settings on their own lines so an LM screen-scraping
      // the output can match `^    reason · ` etc. without prose parsing.
      lines.push("    " + paint("dim", "reason   · ") + paint("text", b.reason));
      lines.push("    " + paint("dim", "fix      · ") + paint("text", b.fix));
      lines.push(
        "    " +
          paint("dim", "settings · ") +
          paint("text", `${b.settingsPath} (${b.settingsKey})`),
      );
    }
  }

  // ── Empty state ───────────────────────────────────────────────────────────
  if (payload.loaded.length === 0 && payload.broken.length === 0) {
    lines.push("");
    lines.push(
      "  " +
        paint("dim", "No custom workflows registered. ") +
        paint("text", "Edit ") +
        paint("text", payload.paths.local, { bold: true }) +
        paint("text", " (project) or ") +
        paint("text", payload.paths.global, { bold: true }) +
        paint("text", " (global) to add one."),
    );
  }

  lines.push("");
  return lines.join("\n") + "\n";
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Re-load custom workflows and render the report. Returns the process
 * exit code.
 */
export async function workflowRefreshCommand(
  options: WorkflowRefreshOptions = {},
  deps: WorkflowRefreshDeps = defaultDeps,
): Promise<number> {
  const format = resolveFormat(options.format, deps.env);

  let result: BootstrapResult;
  try {
    result = await deps.bootstrap(deps.cwd());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (format === "json") {
      process.stdout.write(
        JSON.stringify(
          {
            ok: false,
            error: `failed to read settings: ${message}`,
            counts: { loaded: 0, broken: 0 },
            loaded: [],
            broken: [],
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stderr.write(
        `${COLORS.red}Error: failed to read settings: ${message}${COLORS.reset}\n`,
      );
    }
    return 1;
  }

  // Hot-swap the singleton command tree so any subsequent in-process
  // calls (currently none — the CLI exits after this — but reserved for
  // future REPL-style hosts) see the freshly-merged registry.
  deps.rebuild(result.registry, result.brokenIndex, result.brokenList);

  const payload = buildPayload(result);

  if (format === "json") {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    process.stdout.write(renderText(payload));
  }

  return payload.ok ? 0 : 1;
}
