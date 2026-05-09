/**
 * Merge a workflow registry entry into atomic's `settings.json` without
 * clobbering existing keys.
 *
 * `settings.json` lives at:
 *   - project: <projectDir>/.atomic/settings.json
 *   - global:  ~/.atomic/settings.json
 *
 * The shape we touch:
 *
 *   { "workflows": { "<alias>": { "command": "...", "args": [...], "agents": [...] } } }
 *
 * We preserve every other key (scm, providers, version, $schema, …) and
 * every other workflow alias. Same-alias collisions throw — the caller
 * decides whether to overwrite.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface WorkflowEntry {
  command: string;
  args?: string[];
  agents: string[];
}

interface AtomicSettings {
  $schema?: string;
  version?: number;
  workflows?: Record<string, WorkflowEntry>;
  [k: string]: unknown;
}

export interface MergeOptions {
  /** Absolute path to settings.json. */
  settingsPath: string;
  /** Workflow alias key under `workflows`. */
  alias: string;
  /** Entry to write. */
  entry: WorkflowEntry;
  /** When the alias already exists, throw instead of overwriting. */
  failOnCollision?: boolean;
}

export function mergeSettings(opts: MergeOptions): { existed: boolean } {
  const { settingsPath, alias, entry, failOnCollision = true } = opts;

  let settings: AtomicSettings = {};
  let existed = false;
  if (existsSync(settingsPath)) {
    existed = true;
    const raw = readFileSync(settingsPath, "utf8");
    try {
      settings = JSON.parse(raw) as AtomicSettings;
    } catch (err) {
      throw new Error(
        `Cannot parse existing ${settingsPath} as JSON. ` +
          `Refusing to overwrite. Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    settings = {
      version: 1,
      $schema:
        "https://raw.githubusercontent.com/flora131/atomic/main/assets/settings.schema.json",
    };
  }

  if (!settings.workflows) settings.workflows = {};
  if (alias in settings.workflows && failOnCollision) {
    throw new Error(
      `Settings already has a workflow named "${alias}" at ${settingsPath}. ` +
        `Pick a different name or remove the existing entry first.`,
    );
  }
  settings.workflows[alias] = entry;

  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return { existed };
}
