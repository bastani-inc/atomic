/**
 * Source-control-driven MCP server enable/disable sync.
 *
 * When the user sets `scm` in `.atomic/settings.json` to one of
 * `github`, `azure-devops`, or `sapling`, Atomic keeps the corresponding
 * MCP servers in the project's agent configs consistent on every
 * `atomic chat` / `atomic workflow` startup:
 *
 * - `.claude/settings.json`    → updates the `disabledMcpjsonServers` array
 * - `.opencode/opencode.json`  → flips `mcp.<server>.enabled` flags
 *
 * Only servers that already exist in the config are touched — we never
 * add MCP server definitions the user didn't set up. Files that don't
 * exist are skipped (the user may not use that agent).
 */

import { join } from "node:path";
import { pathExists } from "../system/copy.ts";
import type { ScmProvider } from "./atomic-config.ts";
import { readAtomicConfig } from "./atomic-config.ts";

const SCM_MCP_SERVERS = ["github-mcp-server", "azure-devops"] as const;
type ScmMcpServer = (typeof SCM_MCP_SERVERS)[number];

/** Which SCM MCP servers should be enabled for each scm value. */
function enabledServersFor(scm: ScmProvider): Set<ScmMcpServer> {
  if (scm === "github") return new Set(["github-mcp-server"]);
  if (scm === "azure-devops") return new Set(["azure-devops"]);
  return new Set();
}

/**
 * Copilot CLI servers to disable per scm selection. Copilot ships with a
 * built-in `github-mcp-server`; our `.mcp.json` registers a server under
 * the same name, so when scm is `github` we leave it alone — the
 * workspace entry overrides the built-in transparently and we only
 * disable `azure-devops`. For `azure-devops` we disable
 * `github-mcp-server` (which knocks out both the workspace and built-in
 * variants since they share a name). Sapling disables everything.
 */
const COPILOT_DISABLE_BY_SCM: Record<ScmProvider, readonly string[]> = {
  github: ["azure-devops"],
  "azure-devops": ["github-mcp-server"],
  sapling: ["github-mcp-server", "azure-devops"],
};

/**
 * Pure helper: returns the `--disable-mcp-server <name>` flag sequence to
 * append when spawning Copilot CLI, given a selected scm provider.
 *
 * Copilot has no on-disk MCP server enable/disable store, so Atomic
 * injects the flags on the CLI invocation instead. Returns an empty
 * array when scm is unset so callers can spread unconditionally.
 */
export function copilotScmDisableFlags(scm: ScmProvider | undefined): string[] {
  if (!scm) return [];
  const names = COPILOT_DISABLE_BY_SCM[scm] ?? [];
  const flags: string[] = [];
  for (const name of names) flags.push("--disable-mcp-server", name);
  return flags;
}

/**
 * Resolve Copilot's scm-derived `--disable-mcp-server` flags from the
 * project's atomic config. Best-effort — returns `[]` on any failure.
 */
export async function getCopilotScmDisableFlags(
  projectRoot: string,
): Promise<string[]> {
  try {
    const config = await readAtomicConfig(projectRoot);
    return copilotScmDisableFlags(config?.scm);
  } catch {
    return [];
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await Bun.file(path).json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or invalid JSON — treat as absent.
  }
  return null;
}

async function writeJson(path: string, data: Record<string, unknown>): Promise<void> {
  await Bun.write(path, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Update `disabledMcpjsonServers` in Claude's settings so that servers
 * for the non-selected providers are disabled. Preserves any other
 * entries the user has added to the array.
 */
async function syncClaudeSettings(
  projectRoot: string,
  enabled: Set<ScmMcpServer>,
): Promise<void> {
  const path = join(projectRoot, ".claude", "settings.json");
  if (!(await pathExists(path))) return;

  const settings = await readJson(path);
  if (!settings) return;

  const rawDisabled = settings.disabledMcpjsonServers;
  const existing: string[] = Array.isArray(rawDisabled)
    ? rawDisabled.filter((v): v is string => typeof v === "string")
    : [];

  // Drop any SCM MCP server entry, then add back the ones that should be disabled.
  const withoutScm = existing.filter(
    (name): name is string => !(SCM_MCP_SERVERS as readonly string[]).includes(name),
  );
  const toDisable = SCM_MCP_SERVERS.filter((name) => !enabled.has(name));
  const next = [...withoutScm, ...toDisable];

  if (arraysEqual(existing, next)) return;

  settings.disabledMcpjsonServers = next;
  await writeJson(path, settings);
}

/**
 * Flip `enabled` on the GitHub / Azure DevOps MCP server entries in
 * OpenCode's config. Only touches servers the user already has — we
 * don't invent server definitions.
 */
async function syncOpencodeSettings(
  projectRoot: string,
  enabled: Set<ScmMcpServer>,
): Promise<void> {
  const path = join(projectRoot, ".opencode", "opencode.json");
  if (!(await pathExists(path))) return;

  const config = await readJson(path);
  if (!config) return;

  const mcp = config.mcp;
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return;
  const servers = mcp as Record<string, unknown>;

  let changed = false;
  for (const name of SCM_MCP_SERVERS) {
    const server = servers[name];
    if (!server || typeof server !== "object" || Array.isArray(server)) continue;
    const serverObj = server as Record<string, unknown>;
    const shouldEnable = enabled.has(name);
    if (serverObj.enabled !== shouldEnable) {
      serverObj.enabled = shouldEnable;
      changed = true;
    }
  }

  if (!changed) return;
  await writeJson(path, config);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Apply the current `scm` selection to the project's agent config files.
 * No-op when `scm` is unset. Swallows errors so a malformed agent
 * config never blocks `atomic chat` / `atomic workflow` startup.
 */
export async function syncScmMcpServers(projectRoot: string): Promise<void> {
  try {
    const config = await readAtomicConfig(projectRoot);
    const scm = config?.scm;
    if (!scm) return;

    const enabled = enabledServersFor(scm);
    await Promise.all([
      syncClaudeSettings(projectRoot, enabled),
      syncOpencodeSettings(projectRoot, enabled),
    ]);
  } catch {
    // Best-effort: never block startup on a config write failure.
  }
}
