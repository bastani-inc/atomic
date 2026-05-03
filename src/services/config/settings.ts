/**
 * User settings persistence
 *
 * Stores user settings (e.g., model selection) across sessions.
 * Settings are resolved in priority order:
 *   1. .atomic/settings.json   (project-local, higher priority)
 *   2. ~/.atomic/settings.json (global, lower priority)
 *
 * The --model CLI flag takes precedence over both (handled at call site).
 */

import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { SETTINGS_SCHEMA_URL } from "./settings-schema.ts";
import { ensureDir } from "../system/copy.ts";
import { errorMessage } from "../../sdk/errors.ts";
import { getAgentKeys, type AgentKey, type ProviderOverrides } from "./definitions.ts";
import type { ScmProvider } from "./atomic-config.ts";

interface AtomicSettings {
  $schema?: string;
  version?: number;
  telemetryEnabled?: boolean;
  scm?: ScmProvider;
  providers?: Partial<Record<AgentKey, ProviderOverrides>>;
}

/** Runtime guard for parsed JSON to ensure it's a plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Global settings path: ~/.atomic/settings.json */
function globalSettingsPath(): string {
  const home = process.env.ATOMIC_SETTINGS_HOME ?? homedir();
  return join(home, ".atomic", "settings.json");
}

async function loadSettingsFile(path: string): Promise<AtomicSettings> {
  try {
    const parsed: unknown = await Bun.file(path).json();
    if (isPlainObject(parsed)) return parsed as AtomicSettings;
  } catch {
    // File missing or invalid JSON — fall through to default
  }
  return {};
}

async function writeGlobalSettings(settings: AtomicSettings): Promise<void> {
  settings.$schema = SETTINGS_SCHEMA_URL;
  const path = globalSettingsPath();
  await ensureDir(dirname(path));
  await Bun.write(path, JSON.stringify(settings, null, 2));
}

/**
 * Ensure `~/.atomic/settings.json` exists. Called once at CLI startup so
 * users have a valid file to edit (with JSON Schema intellisense wired up
 * via `$schema`) without having to run any explicit init command.
 *
 * Idempotent — no-op if the file already exists. Best-effort: filesystem
 * errors (e.g. read-only home) are swallowed so the CLI never blocks on
 * this side-effect.
 */
export async function ensureGlobalAtomicSettings(): Promise<void> {
  try {
    const path = globalSettingsPath();
    if (await Bun.file(path).exists()) return;
    await writeGlobalSettings({ version: 1 });
  } catch (e) {
    console.warn(`[settings] failed to bootstrap global settings: ${errorMessage(e)}`);
  }
}

/**
 * Set telemetry enabled/disabled in global settings.
 */
export async function setTelemetryEnabled(enabled: boolean): Promise<void> {
  try {
    const settings = await loadSettingsFile(globalSettingsPath());
    settings.telemetryEnabled = enabled;
    await writeGlobalSettings(settings);
  } catch (e) {
    console.warn(`[settings] failed to set telemetry: ${errorMessage(e)}`);
  }
}

/**
 * Set the selected source control provider in global settings.
 *
 * The value is read on every `atomic chat` / `atomic workflow` startup
 * to reconcile the enable/disable state of the GitHub and Azure DevOps
 * MCP servers in `.claude/settings.json` and `.opencode/opencode.json`.
 */
export async function setScmProvider(scm: ScmProvider): Promise<void> {
  try {
    const settings = await loadSettingsFile(globalSettingsPath());
    settings.scm = scm;
    await writeGlobalSettings(settings);
  } catch (e) {
    console.warn(`[settings] failed to set scm: ${errorMessage(e)}`);
  }
}

/**
 * Seed `COLORTERM=truecolor` into each agent's `providers.<agent>.envVars`
 * in `~/.atomic/settings.json` on install / version bump. Also seeds
 * `CLAUDE_CODE_TMUX_TRUECOLOR=1` for the `claude` provider so Claude Code
 * emits truecolor escapes when running under tmux.
 *
 * The runtime default in `lib/terminal-env.ts` already injects
 * `COLORTERM=truecolor` for every spawned agent — this seed surfaces that
 * default in the user-editable settings file so users with terminals that
 * misbehave on truecolor have a discoverable place to override it (set
 * to `""`, `256color`, etc.).
 *
 * Only writes a key when it isn't already present, so user edits — including
 * an explicit empty-string override — are preserved across upgrades.
 */
export async function seedGlobalProviderEnvVars(): Promise<void> {
  try {
    const settings = await loadSettingsFile(globalSettingsPath());
    const providers: Partial<Record<AgentKey, ProviderOverrides>> =
      settings.providers ?? {};

    let changed = false;
    for (const agentKey of getAgentKeys()) {
      const provider: ProviderOverrides = providers[agentKey] ?? {};
      const envVars: Record<string, string> = provider.envVars ?? {};
      let providerChanged = false;

      if (!("COLORTERM" in envVars)) {
        envVars.COLORTERM = "truecolor";
        providerChanged = true;
      }

      if (agentKey === "claude" && !("CLAUDE_CODE_TMUX_TRUECOLOR" in envVars)) {
        envVars.CLAUDE_CODE_TMUX_TRUECOLOR = "1";
        providerChanged = true;
      }

      if (!providerChanged) continue;

      provider.envVars = envVars;
      providers[agentKey] = provider;
      changed = true;
    }

    if (!changed) return;

    settings.providers = providers;
    await writeGlobalSettings(settings);
  } catch (e) {
    console.warn(
      `[settings] failed to seed provider envVars: ${errorMessage(e)}`,
    );
  }
}
