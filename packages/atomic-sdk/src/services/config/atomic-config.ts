/**
 * Atomic configuration file utilities for persisting project settings.
 *
 * Project/source-control selections are stored in `.atomic/settings.json`.
 * Resolution order:
 * 1) local `.atomic/settings.json` (project override)
 * 2) global `~/.atomic/settings.json` (default fallback)
 */

import { join, dirname } from "node:path";
import { homedir } from "node:os";
import {
  isValidAgent,
  type AgentKey,
  type ProviderOverrides,
} from "./definitions.ts";
import { SETTINGS_SCHEMA_URL } from "./settings-schema.ts";
import { ensureDir } from "../system/copy.ts";

/** Known agent values for workflow validation. */
const KNOWN_AGENTS: ReadonlyArray<AgentKey> = ["claude", "opencode", "copilot"];

/**
 * A single custom workflow entry declared in `settings.json` under the
 * `workflows` map. Each entry describes an external executable that the atomic
 * CLI will spawn to discover and run workflow definitions.
 *
 * RFC §5.2 — schema-level representation of a `workflows.<alias>` value.
 */
export interface CustomWorkflowEntry {
  /** Executable to spawn (e.g., `"bunx"`, `"node"`, `"/abs/path/to/binary"`). */
  command: string;
  /** Static arguments passed before atomic's hidden argv tokens. */
  args?: string[];
  /**
   * Required. Non-empty subset of the known agent keys. Atomic registers one
   * registry entry per listed agent; the spawned command must expose a
   * WorkflowDefinition for each one.
   */
  agents: AgentKey[];
}

const SETTINGS_DIR = ".atomic";
const SETTINGS_FILENAME = "settings.json";

/** Source control providers Atomic can auto-configure MCP servers for. */
export const SCM_PROVIDERS = ["github", "azure-devops", "sapling"] as const;
export type ScmProvider = (typeof SCM_PROVIDERS)[number];

export function isScmProvider(value: unknown): value is ScmProvider {
  return typeof value === "string" && (SCM_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Atomic project configuration schema.
 */
export interface AtomicConfig {
  /** Version of config schema */
  version?: number;
  /** Selected source control provider (drives MCP server enable/disable sync). */
  scm?: ScmProvider;
  /** Per-provider overrides for chatFlags and envVars */
  providers?: Partial<Record<AgentKey, ProviderOverrides>>;
  /**
   * Custom workflow entries loaded from `settings.json`.
   *
   * Precedence (RFC §5.2): project-local `.atomic/settings.json` >
   * global `~/.atomic/settings.json`. For the same alias key, the local
   * entry replaces the global one; non-overlapping keys are unioned.
   */
  workflows?: Record<string, CustomWorkflowEntry>;
}

type JsonRecord = Record<string, unknown>;

function getGlobalSettingsPath(): string {
  const home = process.env.ATOMIC_SETTINGS_HOME ?? homedir();
  return join(home, SETTINGS_DIR, SETTINGS_FILENAME);
}

function getLocalSettingsPath(projectDir: string): string {
  return join(projectDir, SETTINGS_DIR, SETTINGS_FILENAME);
}

async function readJsonFile(path: string): Promise<JsonRecord | null> {
  try {
    return await Bun.file(path).json() as JsonRecord;
  } catch {
    return null;
  }
}

function pickProviderOverrides(raw: unknown): ProviderOverrides | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const result: ProviderOverrides = {};

  if (Array.isArray(obj.chatFlags) && obj.chatFlags.every((f): f is string => typeof f === "string")) {
    result.chatFlags = obj.chatFlags;
  }
  if (obj.envVars && typeof obj.envVars === "object" && !Array.isArray(obj.envVars)) {
    const envVars: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj.envVars)) {
      if (typeof v === "string") envVars[k] = v;
    }
    if (Object.keys(envVars).length > 0) result.envVars = envVars;
  }

  return Object.keys(result).length > 0 ? result : null;
}

function pickProviders(raw: unknown): Partial<Record<AgentKey, ProviderOverrides>> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const result: Partial<Record<AgentKey, ProviderOverrides>> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (!isValidAgent(key)) continue;
    const overrides = pickProviderOverrides(value);
    if (overrides) result[key] = overrides;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/** Known property keys for a `CustomWorkflowEntry`. Used to detect unknown properties. */
const KNOWN_WORKFLOW_PROPS = new Set(["command", "args", "agents"]);

/**
 * Parse and validate the raw `workflows` value from settings.json.
 *
 * Mirrors the conservative `pickProviders` pattern: silently drop malformed
 * entries (after emitting a diagnostic to stderr), keep valid ones.
 *
 * Schema-level error messages match §5.8 exactly.
 *
 * @returns validated map or `undefined` when no valid entries remain.
 */
export function pickWorkflows(raw: unknown): Record<string, CustomWorkflowEntry> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const result: Record<string, CustomWorkflowEntry> = {};

  for (const [alias, value] of Object.entries(obj)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      process.stderr.write(
        `[atomic/workflows] "${alias}": missing required "command"; see ${SETTINGS_SCHEMA_URL}\n`,
      );
      continue;
    }

    const entry = value as Record<string, unknown>;

    // Reject unknown properties (§5.8 — skip the whole entry).
    const unknownProp = Object.keys(entry).find((p) => !KNOWN_WORKFLOW_PROPS.has(p));
    if (unknownProp !== undefined) {
      process.stderr.write(
        `[atomic/workflows] "${alias}": unknown property "${unknownProp}" — see ${SETTINGS_SCHEMA_URL}\n`,
      );
      continue;
    }

    // Validate `command`.
    if (typeof entry.command !== "string" || entry.command.trim() === "") {
      process.stderr.write(
        `[atomic/workflows] "${alias}": missing required "command"; see ${SETTINGS_SCHEMA_URL}\n`,
      );
      continue;
    }

    // Validate `args` if present.
    if (entry.args !== undefined) {
      if (
        !Array.isArray(entry.args) ||
        !(entry.args as unknown[]).every((a) => typeof a === "string")
      ) {
        const gotType = Array.isArray(entry.args) ? "array of non-strings" : typeof entry.args;
        process.stderr.write(
          `[atomic/workflows] "${alias}": "args" must be array of strings (got ${gotType})\n`,
        );
        continue;
      }
    }

    // Validate `agents`.
    const rawAgents = entry.agents;
    if (
      !Array.isArray(rawAgents) ||
      rawAgents.length === 0 ||
      !(rawAgents as unknown[]).every(
        (a): a is AgentKey => typeof a === "string" && (KNOWN_AGENTS as readonly string[]).includes(a),
      )
    ) {
      process.stderr.write(
        `[atomic/workflows] "${alias}": "agents" must be a non-empty subset of [claude, opencode, copilot]\n`,
      );
      continue;
    }

    const validEntry: CustomWorkflowEntry = {
      command: entry.command,
      agents: rawAgents,
    };
    if (entry.args !== undefined) {
      validEntry.args = entry.args as string[];
    }

    result[alias] = validEntry;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function pickAtomicConfig(record: JsonRecord | null): AtomicConfig | null {
  if (!record) return null;

  const config: AtomicConfig = {};
  const version = record.version;

  if (typeof version === "number") config.version = version;
  if (isScmProvider(record.scm)) config.scm = record.scm;

  const providers = pickProviders(record.providers);
  if (providers) config.providers = providers;

  const workflows = pickWorkflows(record.workflows);
  if (workflows) config.workflows = workflows;

  return Object.keys(config).length > 0 ? config : null;
}

/**
 * Merge two ProviderOverrides, with `over` taking precedence.
 * - chatFlags: later config replaces earlier
 * - envVars: merged, later values win on conflict
 */
function mergeProviderOverrides(
  base: ProviderOverrides | undefined,
  over: ProviderOverrides | undefined,
): ProviderOverrides | undefined {
  if (!base && !over) return undefined;
  if (!base) return over;
  if (!over) return base;

  const result: ProviderOverrides = {};

  // chatFlags: later replaces earlier entirely
  if (over.chatFlags !== undefined) {
    result.chatFlags = over.chatFlags;
  } else if (base.chatFlags !== undefined) {
    result.chatFlags = base.chatFlags;
  }

  // envVars: merged, later wins on conflict
  if (base.envVars || over.envVars) {
    result.envVars = { ...base.envVars, ...over.envVars };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Merge two or more `AtomicConfig` objects left-to-right, last write wins for
 * scalar fields. For `workflows`, same-key entries in a later config replace
 * those in an earlier config (local > global); non-overlapping keys are
 * unioned. Returns `undefined` workflows when neither side contributes any.
 *
 * RFC §5.2 precedence: `mergeConfigs(globalConfig, localConfig)` — local is
 * passed last so it naturally wins on key collision.
 */
function mergeConfigs(...configs: Array<AtomicConfig | null>): AtomicConfig | null {
  const merged: AtomicConfig = {};
  for (const config of configs) {
    if (!config) continue;
    if (config.version !== undefined) merged.version = config.version;
    if (config.scm !== undefined) merged.scm = config.scm;

    if (config.providers) {
      if (!merged.providers) merged.providers = {};
      for (const [key, overrides] of Object.entries(config.providers)) {
        const agentKey = key as AgentKey;
        merged.providers[agentKey] = mergeProviderOverrides(merged.providers[agentKey], overrides);
      }
    }

    if (config.workflows) {
      if (!merged.workflows) merged.workflows = {};
      // Same-key local entry replaces global; non-overlapping keys union.
      for (const [alias, entry] of Object.entries(config.workflows)) {
        merged.workflows[alias] = entry;
      }
    }
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

/**
 * Read atomic config with local override semantics.
 */
export async function readAtomicConfig(projectDir: string): Promise<AtomicConfig | null> {
  const localConfig = pickAtomicConfig(await readJsonFile(getLocalSettingsPath(projectDir)));
  const globalConfig = pickAtomicConfig(await readJsonFile(getGlobalSettingsPath()));

  // global < local settings
  return mergeConfigs(globalConfig, localConfig);
}

/**
 * Save project config to `.atomic/settings.json`.
 */
export async function saveAtomicConfig(
  projectDir: string,
  updates: Partial<AtomicConfig>
): Promise<void> {
  const localPath = getLocalSettingsPath(projectDir);

  const localSettings = (await readJsonFile(localPath)) ?? {};
  const localExistingConfig = pickAtomicConfig(localSettings);
  const currentConfig = localExistingConfig ?? {};

  const newConfig: AtomicConfig = {
    ...currentConfig,
    ...updates,
    version: 1,
  };

  const nextSettings: JsonRecord = {
    ...localSettings,
    ...newConfig,
    $schema: SETTINGS_SCHEMA_URL,
  };

  await ensureDir(dirname(localPath));
  await Bun.write(localPath, JSON.stringify(nextSettings, null, 2) + "\n");
}

/**
 * Resolve provider overrides from global + local settings (local wins).
 *
 * Returns `{ chatFlags, envVars }` that are meant to be layered on top
 * of the provider's hardcoded defaults:
 * - `chatFlags`: when set, replaces the provider's default chat_flags entirely
 * - `envVars`: merged on top of the provider's default env_vars (user values win)
 */
export async function getProviderOverrides(
  agentKey: AgentKey,
  projectDir: string,
): Promise<ProviderOverrides> {
  const config = await readAtomicConfig(projectDir);
  return config?.providers?.[agentKey] ?? {};
}
