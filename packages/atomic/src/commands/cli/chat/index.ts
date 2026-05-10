#!/usr/bin/env bun
/**
 * Chat CLI command for atomic.
 */

import { dirname } from "node:path";
import { rm } from "node:fs/promises";
import { AGENT_CONFIG, type AgentKey } from "../../../services/config/index.ts";
import { getProviderOverrides } from "@bastani/atomic-sdk/services/config/atomic-config";
import { getCopilotScmDisableFlags } from "@bastani/atomic-sdk/services/config/scm-sync";
import { resolveAdditionalInstructionsPath } from "@bastani/atomic-sdk/services/config/additional-instructions";
import { ensureProjectSetup } from "../init/index.ts";
import { COLORS } from "@bastani/atomic-sdk/theme/colors";
import { getCommandPath } from "@bastani/atomic-sdk/services/system/detect";
import { ensureAtomicGlobalAgentConfigs } from "../../../services/config/atomic-global-config.ts";
import { getEmbeddedAsset } from "../../../lib/embedded-assets.ts";
import { buildLauncherEnv, buildSpawnEnv, buildTmuxEnv } from "@bastani/atomic-sdk/lib/terminal-env";
import { atomicTempEnv } from "@bastani/atomic-sdk/lib/atomic-temp";
import { type CommandPathResolver, resolveCopilotCliPath } from "@bastani/atomic-sdk/providers/copilot";

export {
  buildLauncherEnv,
  buildSpawnEnv,
  buildTmuxEnv,
  TERMINAL_ENV_KEYS,
  type TerminalEnvKey,
} from "@bastani/atomic-sdk/lib/terminal-env";

// ============================================================================
// Types
// ============================================================================

export type AgentType = AgentKey;

/**
 * Options for the chat command.
 */
export interface ChatCommandOptions {
  /** Agent type to use (claude, opencode, copilot) */
  agentType?: AgentType;
  /** Extra args/options forwarded verbatim to the native agent CLI */
  passthroughArgs?: string[];
  /**
   * When true, run only the preflight steps (global config sync + project
   * onboarding) and exit 0 without spawning the agent CLI. Intended for
   * integration tests and CI smoke-checks; skips the executable-existence
   * check so it works even when the agent CLI is not installed.
   */
  preflightOnly?: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

export function getAgentDisplayName(agentType: AgentType): string {
  return AGENT_CONFIG[agentType].name;
}

/**
 * Build the argv array for spawning the agent CLI.
 *
 * Starts with the agent's default chat_flags (or replaces them entirely
 * when the user sets `chatFlags` in `.atomic/settings.json`), then
 * appends any extra args the user passed after `-a <agent>`.
 */
export async function buildAgentArgs(
  agentType: AgentType,
  passthroughArgs: string[] = [],
  projectRoot: string = process.cwd(),
): Promise<string[]> {
  const config = AGENT_CONFIG[agentType];
  const overrides = await getProviderOverrides(agentType, projectRoot);

  const flags = overrides.chatFlags ?? [...config.chat_flags];

  // Copilot has no on-disk MCP toggle — `--disable-mcp-server <name>` is
  // the equivalent of flipping `enabled: false` in .opencode/opencode.json
  // or adding to `disabledMcpjsonServers` in .claude/settings.json.
  const scmFlags =
    agentType === "copilot" ? await getCopilotScmDisableFlags(projectRoot) : [];

  // Claude Code is the only one with a flag that takes an instructions file.
  // OpenCode and Copilot CLI consume the file via config (.opencode/opencode.json
  // `instructions` array) and env var (`COPILOT_CUSTOM_INSTRUCTIONS_DIRS`)
  // respectively — see `applyManagedOnboardingFiles` and `chatCommand`'s env
  // build. Skipped silently when no file resolves so the CLI still spawns
  // even on a fresh checkout that hasn't run `autoSyncIfStale` yet.
  const instructionsFlags: string[] = [];
  if (agentType === "claude") {
    const path = resolveAdditionalInstructionsPath(projectRoot);
    if (path) instructionsFlags.push("--append-system-prompt-file", path);
  }

  return [...flags, ...scmFlags, ...instructionsFlags, ...passthroughArgs];
}

/**
 * Directory containing the resolved additional-instructions `AGENTS.md`,
 * or `undefined` if no file resolves. Used to set
 * `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` on Copilot spawns — Copilot loads
 * `AGENTS.md` from each dir on that list.
 */
export function getAdditionalInstructionsDir(
  projectRoot: string,
): string | undefined {
  const path = resolveAdditionalInstructionsPath(projectRoot);
  return path ? dirname(path) : undefined;
}

export function resolveChatCommand(
  agentType: AgentType,
  resolveCommandPath: CommandPathResolver = getCommandPath,
): string | undefined {
  if (agentType === "copilot") {
    return resolveCopilotCliPath(resolveCommandPath);
  }

  const config = AGENT_CONFIG[agentType];
  return resolveCommandPath(config.cmd) ?? undefined;
}

function generateChatId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** Escape a string for safe interpolation inside a bash double-quoted string. */
function escBash(s: string): string {
  return s.replace(/[\\"$`!]/g, "\\$&");
}

/** Escape a string for safe interpolation inside a PowerShell double-quoted string. */
function escPwsh(s: string): string {
  return s.replace(/[`"$]/g, "`$&");
}

const POSIX_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertBashEnvKey(key: string): void {
  if (!POSIX_ENV_KEY_RE.test(key)) {
    throw new Error(
      `Invalid Bash env key "${key}": must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
    );
  }
}

function escPwshEnvKey(key: string): string {
  return key.replace(/}/g, "`}");
}

async function removeLauncher(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // Cleanup best effort; attach/fallback result should remain authoritative.
  }
}

/**
 * Build a launcher script that preserves cwd and properly quotes args.
 * This avoids shell-injection risks from passthrough args.
 */
export function buildLauncherScript(
  cmd: string,
  args: string[],
  projectRoot: string,
  envVars: Record<string, string> = {},
): { script: string; ext: string } {
  const isWin = process.platform === "win32";
  const envEntries = Object.entries(envVars);

  if (isWin) {
    // PowerShell: use array splatting for safe arg passing
    const argList = args.map((a) => `"${escPwsh(a)}"`).join(", ");
    const envLines = envEntries.map(
      ([key, value]) => `\${env:${escPwshEnvKey(key)}} = "${escPwsh(value)}"`,
    );
    const script = [
      `Set-Location "${escPwsh(projectRoot)}"`,
      ...envLines,
      argList.length > 0
        ? `& "${escPwsh(cmd)}" @(${argList})`
        : `& "${escPwsh(cmd)}"`,
      "$atomicExitCode = 0",
      "if ($LASTEXITCODE -is [int]) { $atomicExitCode = $LASTEXITCODE }",
      "exit $atomicExitCode",
    ].join("\n");
    return { script, ext: "ps1" };
  }

  const quotedCommand = [
    `"${escBash(cmd)}"`,
    ...args.map((arg) => `"${escBash(arg)}"`),
  ].join(" ");
  const envLines = envEntries.map(([key, value]) => {
    assertBashEnvKey(key);
    return `export ${key}="${escBash(value)}"`;
  });
  const script = [
    "#!/bin/bash",
    `cd "${escBash(projectRoot)}"`,
    ...envLines,
    quotedCommand,
    "atomic_exit_code=$?",
    'exit "$atomic_exit_code"',
  ].join("\n");
  return { script, ext: "sh" };
}

// ============================================================================
// Chat Command Implementation
// ============================================================================

/**
 * Spawn the native agent CLI as an interactive subprocess.
 *
 * Always creates a new session in the atomic tmux socket and attaches
 * to it, regardless of whether the user is already inside tmux.
 * Falls back to direct spawn only when no TTY is available or tmux
 * cannot be installed.
 *
 * @param options - Chat command configuration options
 * @returns Exit code from the agent process
 */
export async function chatCommand(options: ChatCommandOptions = {}): Promise<number> {
  const { agentType, passthroughArgs, preflightOnly } = options;

  if (!agentType) {
    throw new Error("agentType is required. Start chat with atomic chat -a <agent>.");
  }

  const projectRoot = process.cwd();
  await ensureAtomicGlobalAgentConfigs(getEmbeddedAsset);
  await ensureProjectSetup(agentType, projectRoot);

  if (preflightOnly) return 0;

  const config = AGENT_CONFIG[agentType];
  const executable = resolveChatCommand(agentType);
  if (!executable) {
    console.error(`${COLORS.red}Error: '${config.cmd}' is not installed or not in PATH.${COLORS.reset}`);
    console.error(`Install it from: ${config.install_url}`);
    return 1;
  }

  const args = await buildAgentArgs(agentType, passthroughArgs, projectRoot);
  const overrides = await getProviderOverrides(agentType, projectRoot);
  const claudeTempEnv = agentType === "claude" ? atomicTempEnv() : {};
  const envVars: Record<string, string> = {
    ...config.env_vars,
    ...claudeTempEnv,
    ...overrides.envVars,
    ATOMIC_AGENT: agentType,
  };

  if (agentType === "copilot") {
    const dir = getAdditionalInstructionsDir(projectRoot);
    if (dir && dir.includes(",")) {
      console.error(`${COLORS.yellow}Warning: skipping COPILOT_CUSTOM_INSTRUCTIONS_DIRS entry because the path contains a comma, which Copilot CLI cannot escape: ${dir}${COLORS.reset}`);
    } else if (dir) {
      const existing = envVars.COPILOT_CUSTOM_INSTRUCTIONS_DIRS;
      envVars.COPILOT_CUSTOM_INSTRUCTIONS_DIRS = existing ? `${existing},${dir}` : dir;
    }
  }

  buildSpawnEnv(envVars);
  buildLauncherEnv(envVars);
  buildTmuxEnv(envVars);
  void args;

  throw new Error("not implemented: use daemon path");
}
/**
 * Spawn the agent CLI directly with inherited stdio.
 * Used when not inside tmux.
 */
async function spawnDirect(
  cmd: string[],
  projectRoot: string,
  env: Record<string, string> = {},
): Promise<number> {
  const proc = Bun.spawn(cmd, {
    stdio: ["inherit", "inherit", "inherit"],
    cwd: projectRoot,
    env,
  });

  return await proc.exited;
}
