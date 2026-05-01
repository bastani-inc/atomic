#!/usr/bin/env bun
/**
 * Chat CLI command for atomic
 *
 * Spawns the native agent CLI in tmux/psmux with an OpenTUI footer pane.
 *
 * All extra arguments after `-a <agent>` are forwarded to the native CLI.
 *
 * Usage:
 *   atomic chat -a <agent> [native-args...]
 */

import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { AGENT_CONFIG, type AgentKey } from "../../../services/config/index.ts";
import { getProviderOverrides } from "../../../services/config/atomic-config.ts";
import { getCopilotScmDisableFlags } from "../../../services/config/scm-sync.ts";
import {
  resolveAdditionalInstructionsPath,
} from "../../../services/config/additional-instructions.ts";
import { ensureProjectSetup } from "../init/index.ts";
import { COLORS } from "../../../theme/colors.ts";
import {
  getCommandPath,
} from "../../../services/system/detect.ts";
import { checkAgentAuth, printAuthError } from "../../../services/system/auth.ts";
import {
  ensureAtomicGlobalAgentConfigs,
} from "../../../services/config/atomic-global-config.ts";
import { getConfigRoot } from "../../../services/config/config-path.ts";
import {
  isInsideAtomicSocket,
  isInsideTmux,
  isTmuxInstalled,
  resetMuxBinaryCache,
  createSession,
  detachAndAttachAtomic,
  killSessionOnPaneExit,
  killSession,
  spawnMuxAttach,
  switchClient,
} from "../../../sdk/runtime/tmux.ts";
import { spawnAttachedFooter } from "../../../sdk/runtime/attached-footer.ts";
import { ensureTmuxInstalled } from "../../../lib/spawn.ts";
import {
  buildLauncherEnv,
  buildSpawnEnv,
  buildTmuxEnv,
} from "../../../lib/terminal-env.ts";
import { atomicTempEnv } from "../../../lib/atomic-temp.ts";
import {
  type CommandPathResolver,
  resolveCopilotCliPath,
} from "../../../sdk/providers/copilot.ts";

export {
  buildLauncherEnv,
  buildSpawnEnv,
  buildTmuxEnv,
  TERMINAL_ENV_KEYS,
  type TerminalEnvKey,
} from "../../../lib/terminal-env.ts";

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
  const { agentType, passthroughArgs } = options;

  if (!agentType) {
    throw new Error("agentType is required. Start chat with `atomic chat -a <agent>`.");
  }

  const config = AGENT_CONFIG[agentType];

  const executable = resolveChatCommand(agentType);

  // Check the agent CLI is installed
  if (!executable) {
    console.error(
      `${COLORS.red}Error: '${config.cmd}' is not installed or not in PATH.${COLORS.reset}`
    );
    console.error(`Install it from: ${config.install_url}`);
    return 1;
  }

  // ── Preflight: authentication ──
  // Copilot and Claude expose SDK-level login checks; run them now so
  // users get a short actionable error instead of being dropped into a
  // native CLI that immediately redirects them to /login.
  const auth = await checkAgentAuth(agentType);
  if (!auth.loggedIn) {
    printAuthError(agentType, auth);
    return 1;
  }

  // ── Preflight: global config sync ──
  const projectRoot = process.cwd();
  const configRoot = getConfigRoot();

  await ensureAtomicGlobalAgentConfigs(configRoot);

  // ── Preflight: project setup (onboarding files, skills) ──
  await ensureProjectSetup(agentType, projectRoot);

  // ── Build argv ──
  const args = await buildAgentArgs(agentType, passthroughArgs, projectRoot);
  const cmd = [executable, ...args];
  const overrides = await getProviderOverrides(agentType, projectRoot);
  const claudeTempEnv = agentType === "claude" ? atomicTempEnv() : {};
  // ATOMIC_AGENT must be baked into the launcher env so the agent CLI
  // and anything it spawns can read it from process start.
  const envVars: Record<string, string> = {
    ...config.env_vars,
    ...claudeTempEnv,
    ...overrides.envVars,
    ATOMIC_AGENT: agentType,
  };

  // Copilot CLI loads `AGENTS.md` from any directory listed in
  // `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` (comma-separated). Point it at the
  // resolved AGENTS.md's parent dir so our additional instructions get
  // appended to the persona without touching the project's `AGENTS.md`.
  // Skip dirs containing a comma — Copilot CLI has no documented escape
  // syntax for the list separator, so a comma in the path (rare on POSIX,
  // possible in Windows usernames) would be misparsed as a list boundary.
  if (agentType === "copilot") {
    const dir = getAdditionalInstructionsDir(projectRoot);
    if (dir && dir.includes(",")) {
      console.error(
        `${COLORS.yellow}Warning: skipping COPILOT_CUSTOM_INSTRUCTIONS_DIRS entry because the path contains a comma, which Copilot CLI cannot escape: ${dir}${COLORS.reset}`,
      );
    } else if (dir) {
      const existing = envVars.COPILOT_CUSTOM_INSTRUCTIONS_DIRS;
      envVars.COPILOT_CUSTOM_INSTRUCTIONS_DIRS = existing
        ? `${existing},${dir}`
        : dir;
    }
  }

  const spawnEnv = buildSpawnEnv(envVars);
  const launcherEnv = buildLauncherEnv(envVars);
  const tmuxEnv = buildTmuxEnv(envVars);

  // ── No TTY: tmux attach requires a real terminal ──
  if (!process.stdin.isTTY) {
    return spawnDirect(cmd, projectRoot, spawnEnv);
  }

  // ── Ensure tmux is available ──
  if (!isTmuxInstalled()) {
    console.log("Terminal multiplexer not found. Installing...");
    try {
      await ensureTmuxInstalled();
      resetMuxBinaryCache();
    } catch {
      // Fall through to check below
    }
    if (!isTmuxInstalled()) {
      // No tmux available — fall back to direct spawn
      return spawnDirect(cmd, projectRoot, spawnEnv);
    }
  }

  // ── Build launcher script for safe arg/cwd handling ──
  const chatId = generateChatId();
  const windowName = `atomic-chat-${agentType}-${chatId}`;

  const sessionsDir = join(homedir(), ".atomic", "sessions", "chat");
  await mkdir(sessionsDir, { recursive: true });
  const { script, ext } = buildLauncherScript(
    executable,
    args,
    projectRoot,
    launcherEnv,
  );
  const launcherPath = join(sessionsDir, `${windowName}.${ext}`);
  await writeFile(launcherPath, script, { mode: 0o755 });

  const shellCmd = process.platform === "win32"
    ? `pwsh -NoProfile -File "${launcherPath}"`
    : `bash "${launcherPath}"`;

  // ── Create session on the atomic socket and attach ──
  try {
    const paneId = createSession(windowName, shellCmd, undefined, projectRoot, tmuxEnv);
    spawnAttachedFooter(windowName, paneId, agentType);
    killSessionOnPaneExit(windowName, paneId);

    if (isInsideAtomicSocket()) {
      // Already on the atomic server — just switch to the new session.
      switchClient(windowName);
      await removeLauncher(launcherPath);
      return 0;
    }

    if (isInsideTmux()) {
      // Inside a different tmux server — detach and replace the client
      // with an attach to the atomic socket (no nesting).
      detachAndAttachAtomic(windowName);
      await removeLauncher(launcherPath);
      return 0;
    }

    const attachProc = spawnMuxAttach(windowName);
    const exitCode = await attachProc.exited;

    await removeLauncher(launcherPath);

    // If tmux attach itself failed (e.g. lost TTY), clean up and fall back
    if (exitCode !== 0) {
      try { killSession(windowName); } catch {}
      return spawnDirect(cmd, projectRoot, spawnEnv);
    }

    return exitCode;
  } catch (error) {
    await removeLauncher(launcherPath);
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `${COLORS.yellow}Warning: Failed to create tmux session (${message}). Falling back to direct spawn.${COLORS.reset}`
    );
    return spawnDirect(cmd, projectRoot, spawnEnv);
  }
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
