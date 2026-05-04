/**
 * tmux session and pane management utilities.
 *
 * Provides low-level tmux operations for the workflow runtime:
 * creating sessions, splitting panes, spawning commands, capturing output,
 * sending keystrokes, and pane state detection.
 */

import { requiredMuxBinaryCandidatesForPlatform } from "../lib/spawn.ts";
import { tmuxConfPath, ccDebounceScriptPath } from "../lib/runtime-assets.ts";
import { writeFileSync, unlinkSync } from "node:fs";
import type { Subprocess } from "bun";
import { atomicTempPath } from "../lib/atomic-temp.ts";
import { normalizedTerminalEnv } from "../lib/terminal-env.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Dedicated tmux socket name — isolates Atomic sessions from the user's default server. */
export const SOCKET_NAME = "atomic";

/** Path to the bundled tmux config (shared by tmux and psmux). */
const CONFIG_PATH = tmuxConfPath;

/** Path to the bundled Ctrl+C debounce script (TypeScript, run via bun
 *  so the same file handles Linux, macOS, and Windows without shell
 *  dialect gymnastics). Referenced from tmux.conf. */
const CC_DEBOUNCE_PATH = ccDebounceScriptPath;

/** Discriminated result from a tmux command execution. */
export type TmuxResult =
  | { ok: true; stdout: string }
  | { ok: false; stderr: string };

// ---------------------------------------------------------------------------
// Core tmux primitives
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Core tmux primitives
// ---------------------------------------------------------------------------

/** Cached resolved multiplexer binary path. Resolved once on first use. */
let resolvedMuxBinary: string | null | undefined; // undefined = not yet resolved

/**
 * Resolve the terminal multiplexer binary for the current platform.
 *
 * On Windows, tries psmux → pmux. Do not accept arbitrary `tmux.exe` because
 * that can be a non-native shim and would prevent the psmux installer from
 * running.
 * On Unix/macOS, uses tmux directly.
 *
 * Returns the binary name (not the full path) or null if none is found.
 * The result is cached after the first call.
 */
export function getMuxBinary(): string | null {
  if (resolvedMuxBinary !== undefined) return resolvedMuxBinary;

  // Bun.which() reads PATH from the original process environment at startup
  // and ignores runtime mutations to process.env.PATH. Pass PATH explicitly
  // so that callers who modify PATH (e.g. tests) get correct results.
  const pathOpt = { PATH: process.env.PATH ?? "" };

  for (const candidate of requiredMuxBinaryCandidatesForPlatform()) {
    if (Bun.which(candidate, pathOpt)) {
      resolvedMuxBinary = candidate;
      return resolvedMuxBinary;
    }
  }

  resolvedMuxBinary = null;
  return resolvedMuxBinary;
}

/**
 * Reset the cached multiplexer binary resolution.
 * Call after installing tmux/psmux to force re-detection.
 */
export function resetMuxBinaryCache(): void {
  resolvedMuxBinary = undefined;
}

/**
 * Check if tmux is installed and available.
 */
export function isTmuxInstalled(): boolean {
  return getMuxBinary() !== null;
}

/**
 * Check if we're currently inside a tmux session.
 */
export function isInsideTmux(): boolean {
  return process.env.TMUX !== undefined || process.env.PSMUX !== undefined;
}

/**
 * Check if we're inside the atomic tmux socket specifically.
 *
 * The `TMUX` env var has the format `<socket_path>,<pid>,<index>`.
 * On Unix this looks like `/tmp/tmux-1000/atomic,12345,0` when the
 * socket name is "atomic".
 */
export function isInsideAtomicSocket(): boolean {
  const tmuxEnv = process.env.TMUX ?? process.env.PSMUX ?? "";
  // Socket path is everything before the first comma.
  const socketPath = tmuxEnv.split(",")[0] ?? "";
  // The socket name is the last path segment.
  const socketName = socketPath.split("/").pop() ?? "";
  return socketName === SOCKET_NAME;
}

/**
 * Run a tmux command and return a result object.
 * Prefers this over the throwing `tmux()` for cases where callers
 * need to handle failure gracefully.
 */
export function tmuxRun(args: string[]): TmuxResult {
  const binary = getMuxBinary();
  if (!binary) {
    return { ok: false, stderr: "No terminal multiplexer (tmux/psmux) found on PATH" };
  }
  const fullArgs = ["-f", CONFIG_PATH, "-L", SOCKET_NAME, ...args];
  const result = Bun.spawnSync({
    cmd: [binary, ...fullArgs],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) {
    return { ok: false, stderr: result.stderr.toString().trim() };
  }
  return { ok: true, stdout: result.stdout.toString().trim() };
}

/**
 * Run a tmux command and return stdout. Throws on failure.
 */
function tmux(args: string[]): string {
  const result = tmuxRun(args);
  if (!result.ok) {
    throw new Error(`tmux ${args[0]} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Run a tmux command, ignoring output. Throws on failure.
 */
function tmuxExec(args: string[]): void {
  const result = tmuxRun(args);
  if (!result.ok) {
    throw new Error(`tmux ${args[0]} failed: ${result.stderr}`);
  }
}

// ---------------------------------------------------------------------------
// Session and pane management
// ---------------------------------------------------------------------------

/**
 * Build `-e KEY=VALUE` argument pairs for tmux environment flags.
 * Supported by tmux new-session/new-window since tmux 3.2.
 */
function buildEnvArgs(envVars?: Record<string, string>): string[] {
  if (!envVars) return [];
  const args: string[] = [];
  for (const [key, value] of Object.entries(envVars)) {
    args.push("-e", `${key}=${value}`);
  }
  return args;
}

/**
 * Create a new tmux session with the given name.
 * The session starts detached with an initial command in the first pane.
 *
 * @param sessionName - Unique session name
 * @param initialCommand - Shell command to run in the initial pane
 * @param windowName - Optional name for the initial window
 * @param cwd - Optional working directory for the initial pane
 * @param envVars - Optional environment variables for the initial pane
 * @returns The pane ID of the initial pane (e.g., "%0")
 */
export function createSession(
  sessionName: string,
  initialCommand: string,
  windowName?: string,
  cwd?: string,
  envVars?: Record<string, string>,
): string {
  const args = [
    "new-session",
    "-d",
    "-s", sessionName,
    "-P", "-F", "#{pane_id}",
    ...buildEnvArgs(envVars),
  ];
  if (windowName) {
    args.push("-n", windowName);
  }
  if (cwd) {
    args.push("-c", cwd);
  }
  args.push(initialCommand);
  const paneId = tmux(args);
  // Reload config into the running server so keybindings are always current
  // (tmux only loads -f on first server start; source-file updates a running server).
  tmuxRun(["source-file", CONFIG_PATH]);
  // Expose the bun binary and debounce-script paths as server-wide user
  // options so tmux.conf's Ctrl+C binding can invoke them without
  // hardcoding an install path or relying on the user's PATH — which
  // tmux's run-shell does not always inherit in full, especially on
  // Windows psmux. `process.execPath` is the exact bun interpreter
  // currently running atomic, guaranteeing it's executable.
  tmuxRun(["set-option", "-g", "@atomic-bun", process.execPath]);
  tmuxRun(["set-option", "-g", "@atomic-cc-debounce", CC_DEBOUNCE_PATH]);
  return paneId || tmux(["list-panes", "-t", sessionName, "-F", "#{pane_id}"]).split("\n")[0]!;
}

export function buildKillSessionOnPaneExitHooks(
  sessionName: string,
  paneId: string,
  options: { guardPaneExited?: boolean } = {},
): Array<{ event: string; command: string }> {
  const killCommand = `kill-session -t ${sessionName}`;
  const paneExitedCommand = options.guardPaneExited === false
    ? killCommand
    : `if -F '#{==:#{hook_pane},${paneId}}' '${killCommand}'`;
  return [
    { event: "pane-exited", command: paneExitedCommand },
    { event: "after-kill-pane", command: killCommand },
  ];
}

function supportsHookPaneFormat(binary = getMuxBinary()): boolean {
  return binary !== "psmux" && binary !== "pmux";
}

/**
 * Install hooks that kill the entire session when the agent pane goes away.
 * Used by chat sessions so the session is torn down when the agent CLI exits
 * — whether via `/exit`, a deliberate double Ctrl+C, a crash, or a direct
 * pane close — without leaving the footer pane keeping the session alive.
 *
 * tmux fires `pane-exited` when a pane process exits; psmux also supports
 * that event, but does not currently populate tmux's `#{hook_pane}` format,
 * so the psmux hook is session-scoped. A direct pane close/kill fires
 * `after-kill-pane` instead. These session-scoped hooks are safe for chat
 * sessions: they only have the agent pane plus its footer, and closing either
 * should close the entire chat window.
 */
export function killSessionOnPaneExit(sessionName: string, paneId: string): void {
  const hooks = buildKillSessionOnPaneExitHooks(sessionName, paneId, {
    guardPaneExited: supportsHookPaneFormat(),
  });
  for (const hook of hooks) {
    tmuxRun([
      "set-hook",
      "-t", sessionName,
      hook.event,
      hook.command,
    ]);
  }
}

/**
 * Create a new window in an existing session without switching focus.
 *
 * @param sessionName - Target session name
 * @param windowName - Name for the new window
 * @param command - Shell command to run in the new window
 * @param cwd - Optional working directory for the new window
 * @param envVars - Optional environment variables for the new window
 * @returns The pane ID of the new window's pane
 */
export function createWindow(
  sessionName: string,
  windowName: string,
  command: string,
  cwd?: string,
  envVars?: Record<string, string>,
): string {
  const args = [
    "new-window",
    "-d",
    "-t", sessionName,
    "-n", windowName,
    "-P", "-F", "#{pane_id}",
    ...buildEnvArgs(envVars),
  ];
  if (cwd) {
    args.push("-c", cwd);
  }
  args.push(command);
  return tmux(args);
}

/**
 * Create a new pane in an existing session by splitting.
 *
 * @returns The pane ID of the new pane
 */
export function createPane(sessionName: string, command: string): string {
  return tmux([
    "split-window",
    "-t", sessionName,
    "-P", "-F", "#{pane_id}",
    command,
  ]);
}

/**
 * Replace the running command in an existing pane with a new one.
 *
 * `-k` kills whatever is currently running in the pane (e.g. a still-initializing
 * shell) before tmux spawns the new command. Because tmux execs the command
 * itself rather than forwarding keystrokes through a shell line editor, there
 * is no shell-ready race and no ZLE TCSAFLUSH drop — callers can invoke this
 * immediately after pane creation without waiting for a prompt to appear.
 */
export function respawnPane(paneId: string, command: string): void {
  tmuxExec(["respawn-pane", "-k", "-t", paneId, command]);
}

// ---------------------------------------------------------------------------
// Keystroke sending
// ---------------------------------------------------------------------------

/**
 * Send literal text to a tmux pane using `-l` flag (no special key interpretation).
 * Uses `--` to prevent text starting with `-` from being parsed as flags.
 *
 * For large text payloads, prefer {@link sendViaPasteBuffer} which bypasses
 * tmux's ~16 KB internal message buffer limit.
 */
export function sendLiteralText(paneId: string, text: string): void {
  // Replace newlines with spaces to avoid premature submission
  const normalized = text.replace(/[\r\n]+/g, " ");
  tmuxExec(["send-keys", "-t", paneId, "-l", "--", normalized]);
}

/**
 * Send text to a tmux pane via the paste buffer.
 *
 * More reliable than `send-keys -l` for large text:
 * - No OS ARG_MAX / MAX_ARG_STRLEN limits (text goes through a temp file)
 * - Atomic delivery — the entire text is pasted at once
 * - No chunking needed
 *
 * Newlines are normalized to spaces to prevent premature submission,
 * matching `sendLiteralText`'s behavior.
 */
export function sendViaPasteBuffer(paneId: string, text: string): void {
  const normalized = text.replace(/[\r\n]+/g, " ");
  const tmp = atomicTempPath(
    "atomic-paste",
    ".txt",
    `${process.pid}-${Date.now()}`,
  );

  writeFileSync(tmp, normalized, "utf-8");
  try {
    tmuxExec(["load-buffer", tmp]);
    tmuxExec(["paste-buffer", "-t", paneId, "-d"]);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // Temp file cleanup is best-effort
    }
  }
}

/**
 * Send a special key (C-m, C-c, C-u, Tab, etc.) to a tmux pane.
 */
export function sendSpecialKey(paneId: string, key: string): void {
  tmuxExec(["send-keys", "-t", paneId, key]);
}

// ---------------------------------------------------------------------------
// Pane capture
// ---------------------------------------------------------------------------

/**
 * Capture the visible content of a tmux pane.
 *
 * @param paneId - The pane ID (e.g., "%0")
 * @param start - Start line (negative = from bottom, default: capture visible only)
 */
export function capturePane(paneId: string, start?: number): string {
  const args = ["capture-pane", "-t", paneId, "-p"];
  if (start !== undefined) {
    args.push("-S", String(start));
  }
  return tmux(args);
}

/** Internal capture helper — returns empty string on failure. */
function capturePaneRaw(paneId: string, scrollbackLines?: number): string {
  const args = ["capture-pane", "-t", paneId, "-p"];
  if (scrollbackLines !== undefined) {
    args.push("-S", `-${scrollbackLines}`);
  }
  const result = tmuxRun(args);
  return result.ok ? result.stdout : "";
}

/**
 * Capture only the visible portion of a pane (no scrollback).
 * Preferred for state detection (ready/busy) to avoid stale prompt lines
 * or old activity indicators in scrollback triggering false positives.
 * Returns empty string on failure instead of throwing.
 */
export function capturePaneVisible(paneId: string): string {
  return capturePaneRaw(paneId);
}

/**
 * Capture last N lines of scrollback from a pane.
 * Preferred for output collection where you need recent history.
 * Returns empty string on failure instead of throwing.
 */
export function capturePaneScrollback(paneId: string, lines = 200): string {
  return capturePaneRaw(paneId, lines);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Kill a tmux session.
 */
export function killSession(sessionName: string): void {
  try {
    tmuxExec(["kill-session", "-t", sessionName]);
  } catch {
    // Session may already be dead
  }
}

/** Kill a specific tmux window within a session. Silences errors if already dead. */
export function killWindow(sessionName: string, windowName: string): void {
  try {
    tmuxExec(["kill-window", "-t", `${sessionName}:${windowName}`]);
  } catch {
    // Window may already be dead
  }
}

/**
 * Check if a tmux session exists.
 */
export function sessionExists(sessionName: string): boolean {
  const result = tmuxRun(["has-session", "-t", sessionName]);
  return result.ok;
}

/**
 * Set a session-level environment variable.
 * Uses `tmux set-environment -t <session>` so the value is scoped to
 * the individual session, not the global server environment.
 */
export function setSessionEnv(sessionName: string, key: string, value: string): void {
  tmuxRun(["set-environment", "-t", sessionName, key, value]);
}

export function parseSessionEnvValue(stdout: string, key: string): string | null {
  const prefix = `${key}=`;
  const line = stdout
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(prefix));
  return line ? line.slice(prefix.length) : null;
}

/**
 * Get the PID of the foreground process in a tmux pane.
 * Returns null if the pane no longer exists or the query fails.
 *
 * Note: this is the pane's "current" process — typically the agent
 * itself when the pane was created with the agent as the initial command.
 * If tmux exec'd a wrapper shell that then exec'd the agent, the PID
 * will refer to the same process (exec replaces in-place).
 */
export function getPanePid(paneId: string): number | null {
  const result = tmuxRun(["display-message", "-t", paneId, "-p", "#{pane_pid}"]);
  if (!result.ok) return null;
  const pid = Number(result.stdout.trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/**
 * Read a session-level environment variable.
 * Returns `null` when the session doesn't exist or the variable isn't set.
 */
export function getSessionEnv(sessionName: string, key: string): string | null {
  const result = tmuxRun(["show-environment", "-t", sessionName, key]);
  if (!result.ok) return null;
  // tmux returns "KEY=VALUE" for a requested key. psmux can append its own
  // PSMUX_* metadata or return all environment lines, so only accept an exact
  // key match and ignore every unrelated line.
  return parseSessionEnvValue(result.stdout, key);
}

/** Session type derived from the session name prefix. */
export type SessionType = "chat" | "workflow";

/**
 * Parse a session name into its type and agent.
 *
 * Naming conventions:
 *   Chat:     atomic-chat-<agent>-<id>
 *   Workflow:  atomic-wf-<agent>-<name>-<id>
 *
 * Agent names are a known, hyphen-free set (claude, copilot, opencode)
 * so parsing is unambiguous even when the workflow name contains hyphens.
 */
export function parseSessionName(name: string): { type?: SessionType; agent?: string } {
  const KNOWN_AGENTS = new Set(["claude", "copilot", "opencode"]);

  if (name.startsWith("atomic-chat-")) {
    // atomic-chat-<agent>-<id>
    const rest = name.slice("atomic-chat-".length);
    const dash = rest.indexOf("-");
    const candidate = dash >= 0 ? rest.slice(0, dash) : rest;
    if (KNOWN_AGENTS.has(candidate)) {
      return { type: "chat", agent: candidate };
    }
    return { type: "chat" };
  }

  if (name.startsWith("atomic-wf-")) {
    // atomic-wf-<agent>-<name>-<id>
    const rest = name.slice("atomic-wf-".length);
    const dash = rest.indexOf("-");
    const candidate = dash >= 0 ? rest.slice(0, dash) : rest;
    if (KNOWN_AGENTS.has(candidate)) {
      return { type: "workflow", agent: candidate };
    }
    return { type: "workflow" };
  }

  return {};
}

/** A single tmux session on the atomic socket. */
export interface TmuxSession {
  /** Session name (e.g. "atomic-chat-claude-a1b2c3d4") */
  name: string;
  /** Number of windows in the session */
  windows: number;
  /** ISO 8601 creation timestamp */
  created: string;
  /** Whether a client is currently attached */
  attached: boolean;
  /** Session type derived from the name prefix */
  type?: SessionType;
  /** Agent backend that owns this session (e.g. "claude", "copilot", "opencode") */
  agent?: string;
}

const SESSION_LIST_DELIMITER = "__ATOMIC_SESSION_FIELD__";

function isAtomicManagedSessionName(name: string): boolean {
  return name.startsWith("atomic-");
}

export function parseListSessionsOutput(
  stdout: string,
  getEnv: (sessionName: string, key: string) => string | null = getSessionEnv,
): TmuxSession[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => line.includes(SESSION_LIST_DELIMITER))
    .flatMap((line) => {
      const [name, windowsStr, createdStr, attachedStr] = line.split(SESSION_LIST_DELIMITER);
      if (!name || !windowsStr || !createdStr || attachedStr === undefined) return [];
      if (!isAtomicManagedSessionName(name)) return [];

      const epochSec = Number(createdStr);
      const parsed = parseSessionName(name);
      return [{
        name,
        windows: Number(windowsStr) || 1,
        created: Number.isFinite(epochSec) && epochSec > 0
          ? new Date(epochSec * 1000).toISOString()
          : createdStr,
        attached: attachedStr === "1",
        type: parsed.type,
        agent: parsed.agent ?? getEnv(name, "ATOMIC_AGENT") ?? undefined,
      }];
    });
}

/**
 * List all sessions on the atomic tmux socket.
 *
 * Uses a custom format string so output is machine-parseable regardless of
 * locale. Returns an empty array when the server isn't running or has no
 * sessions (tmux exits non-zero in both cases).
 */
export function listSessions(): TmuxSession[] {
  const fmt = [
    "#{session_name}",
    "#{session_windows}",
    "#{session_created}",
    "#{session_attached}",
  ].join(SESSION_LIST_DELIMITER);
  const result = tmuxRun(["list-sessions", "-F", fmt]);
  if (!result.ok) return [];

  return parseListSessionsOutput(result.stdout);
}

/** Build the full argument list for an attach-session command. */
function buildAttachArgs(sessionName: string): string[] {
  const binary = getMuxBinary();
  if (!binary) {
    throw new Error("No terminal multiplexer (tmux/psmux) found on PATH");
  }
  return [binary, "-f", CONFIG_PATH, "-L", SOCKET_NAME, "attach-session", "-t", sessionName];
}

/**
 * Build the env for an attach-session client process.
 *
 * tmux probes the client's $TERM at attach time and aborts with
 * "open terminal failed: terminal does not support clear" when the
 * value is unset, "dumb", or has no terminfo entry on the host. That
 * branches the chat command into a silent `spawnDirect` fallback even
 * though the session was created successfully — exactly the failure
 * mode that CI / Docker / `script(1)`-wrapped invocations hit.
 *
 * Reusing `normalizedTerminalEnv` keeps the override aligned with what
 * we already inject into tmux *new-session* via `-e TERM=…`, so the
 * client and the in-pane processes always agree on the terminal type.
 */
function attachClientEnv(): Record<string, string> {
  return normalizedTerminalEnv(process.env);
}

/**
 * Attach to an existing tmux session (takes over the current terminal).
 */
export function attachSession(sessionName: string): void {
  const cmd = buildAttachArgs(sessionName);
  const proc = Bun.spawnSync({
    cmd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "pipe",
    env: attachClientEnv(),
  });
  if (!proc.success) {
    const stderr = proc.stderr.toString().trim();
    throw new Error(`Failed to attach to session: ${sessionName}${stderr ? ` (${stderr})` : ""}`);
  }
}

/**
 * Spawn an interactive attach-session process.
 * Encapsulates binary resolution, config injection, and socket isolation.
 * Used by all async attach call sites (executor, chat).
 */
export function spawnMuxAttach(sessionName: string): Subprocess {
  return Bun.spawn(buildAttachArgs(sessionName), {
    stdio: ["inherit", "inherit", "inherit"],
    env: attachClientEnv(),
  });
}

/**
 * Switch the current tmux client to a different session.
 * Use this instead of `attachSession` when already inside tmux to avoid
 * creating a nested tmux client.
 */
export function switchClient(sessionName: string): void {
  tmuxExec(["switch-client", "-t", sessionName]);
}

/**
 * Get the name of the current tmux session (when running inside tmux).
 * Returns null if not inside tmux or if the query fails.
 */
export function getCurrentSession(): string | null {
  if (!isInsideTmux()) return null;
  // Only query the atomic server if we're actually inside the atomic socket.
  // Otherwise, display-message picks an arbitrary session on the atomic
  // server that has nothing to do with our terminal.
  if (!isInsideAtomicSocket()) return null;
  const result = tmuxRun(["display-message", "-p", "#{session_name}"]);
  if (!result.ok) return null;
  return result.stdout || null;
}

/**
 * Attach or switch to a tmux session depending on whether we're already
 * inside tmux. Avoids nested tmux clients.
 *
 * - Outside tmux: spawns `attach-session` (blocks until session ends).
 * - Inside tmux: runs `switch-client` (returns immediately).
 */
export function attachOrSwitch(sessionName: string): void {
  if (isInsideTmux()) {
    switchClient(sessionName);
  } else {
    attachSession(sessionName);
  }
}

/**
 * Detach every client currently attached to the given atomic-managed
 * tmux session. The session itself stays alive — only the clients are
 * disconnected. Mirrors {@link attachSession}: attach connects a client,
 * detachClients disconnects them.
 *
 * Best-effort: returns silently when the session has no attached clients
 * or has already been torn down.
 */
export function detachClients(sessionName: string): void {
  try {
    tmuxExec(["detach-client", "-s", sessionName]);
  } catch {
    // No clients attached or session already gone — nothing to do.
  }
}

/**
 * Detach from the user's current tmux session and replace the client
 * with an attach to a session on the atomic socket.
 *
 * Uses `detach-client -E` so the user's terminal seamlessly transitions
 * from their tmux session to the atomic session — no nesting.
 * Their original tmux session stays alive; they can re-attach with
 * `tmux attach` after leaving the atomic session.
 *
 * Only call when {@link isInsideTmux} returns `true`.
 */
export function detachAndAttachAtomic(sessionName: string): void {
  const binary = getMuxBinary();
  if (!binary) {
    throw new Error("No terminal multiplexer (tmux/psmux) found on PATH");
  }
  // Build the shell command that will run on the freed terminal.
  const attachArgs = buildAttachArgs(sessionName);
  const attachCmd = attachArgs
    .map((a) => `"${a.replace(/[\\"$`!]/g, "\\$&")}"`)
    .join(" ");

  // Target the user's current tmux server (no -L flag) and replace
  // the client process with an attach to the atomic socket.
  Bun.spawnSync({
    cmd: [binary, "detach-client", "-E", attachCmd],
    stdio: ["inherit", "inherit", "inherit"],
  });
}

/**
 * Select (switch to) a window within the current tmux session.
 */
export function selectWindow(target: string): void {
  tmuxExec(["select-window", "-t", target]);
}

/**
 * Move the target session's current-window pointer forward by one.
 * Equivalent to the `Ctrl+\` binding inside an attached client, but
 * usable without a client and addressable by session name.
 */
export function nextWindow(sessionName: string): void {
  tmuxExec(["next-window", "-t", sessionName]);
}

/**
 * Move the target session's current-window pointer backward by one.
 */
export function previousWindow(sessionName: string): void {
  tmuxExec(["previous-window", "-t", sessionName]);
}

// ---------------------------------------------------------------------------
// Normalization (ported from oh-my-codex's normalizeTmuxCapture)
// ---------------------------------------------------------------------------

/**
 * Collapse all whitespace to single spaces for robust capture comparison.
 * Prevents false negatives from tmux inserting/stripping whitespace.
 */
export function normalizeTmuxCapture(text: string): string {
  return text.replace(/\r/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Normalize captured text preserving line structure (for display output).
 */
export function normalizeTmuxLines(text: string): string {
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}
