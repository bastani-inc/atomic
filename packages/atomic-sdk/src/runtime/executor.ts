/**
 * Workflow runtime executor.
 *
 * Architecture:
 * 1. `executeWorkflow()` is called by the CLI command (e.g. atomic) or by
 *    the SDK's `runWorkflow()` primitive
 * 2. It creates a tmux session with an orchestrator pane that runs the
 *    CLI's hidden `_orchestrator-entry` sub-command with four positional
 *    args: `<workflowName> <agent> <inputsB64> <workflowSource>`
 * 3. The CLI then attaches to the tmux session (user sees it live)
 * 4. The orchestrator pane resolves the workflow definition (via builtin
 *    registry in compiled-binary mode, or by dynamic-importing
 *    `<workflowSource>` in dev), calls `runOrchestrator(definition, inputs)`,
 *    which then calls `definition.run(workflowCtx)` — the user's callback
 *    uses `ctx.stage()` to spawn agent sessions
 *
 * The dev's CLI is never re-imported. The SDK orchestrator entry script
 * is the only re-exec target, so there is no orchestrator-mode env var
 * re-entry signal and no boilerplate in user code.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { writeFile, access as fsAccess, stat as fsStat } from "node:fs/promises";
import { statSync, accessSync, constants as fsConstants } from "node:fs";
import type {
  WorkflowDefinition,
  WorkflowContext,
  WorkflowInput,
  SessionContext,
  SessionRunOptions,
  SessionHandle,
  SessionRef,
  AgentType,
  Transcript,
  SavedMessage,
  SaveTranscript,
  StageClientOptions,
  StageSessionOptions,
  ProviderClient,
  ProviderSession,
} from "../types.ts";
import { type ProviderOverrides } from "../services/config/definitions.ts";
import { getProviderOverrides } from "../services/config/atomic-config.ts";
import { getCopilotScmDisableFlags } from "../services/config/scm-sync.ts";
import { reconcileOpencodeInstructions } from "../services/config/additional-instructions.ts";
import { ensureDir } from "../services/system/copy.ts";
import type { SessionEvent } from "@github/copilot-sdk";
import type { SessionPromptResponse } from "@opencode-ai/sdk/v2";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import * as tmux from "./tmux.ts";
import { spawnMuxAttach } from "./tmux.ts";
import { buildSelfExecCommand, resolveDispatcher } from "../lib/self-exec.ts";
import { buildLauncherEnv, buildTmuxEnv } from "../lib/terminal-env.ts";
import {
  getListeningPortForPid,
  PORT_DISCOVERY_TIMEOUT_MS,
} from "./port-discovery.ts";
import { spawnAttachedFooter } from "./attached-footer.ts";
import {
  clearClaudeSession,
  ClaudeClientWrapper,
  ClaudeSessionWrapper,
  HeadlessClaudeClientWrapper,
  HeadlessClaudeSessionWrapper,
  buildClaudeResumeArgs,
  claudeOffloadCleanup,
  ensureWorkflowHookSettings,
} from "../providers/claude.ts";
import { withHeadlessOpencodeEnv, buildOpencodeResumeArgs } from "../providers/opencode.ts";
import { resolveCopilotCliPath, buildCopilotResumeArgs } from "../providers/copilot.ts";
import { createOffloadManager, type OffloadManager } from "./offload-manager.ts";
import { shellQuote } from "./shell-quote.ts";
import { OrchestratorPanel } from "./panel.tsx";
import { GraphFrontierTracker } from "./graph-inference.ts";
import { buildSnapshot, writeSnapshot } from "./status-writer.ts";
import { errorMessage } from "../errors.ts";
import { createPainter } from "../theme/colors.ts";
import { atomicTempEnv } from "../lib/atomic-temp.ts";
import { getProductionTelemetrySink } from "../lib/telemetry/index.ts";

/** Maximum time (ms) for the SDK probe to succeed after port is discovered. */
export const SERVER_PROBE_TIMEOUT_MS = 60_000;

/** Agent CLI configuration for spawning in tmux panes. */
const AGENT_CLI: Record<
  AgentType,
  { cmd: string; chatFlags: string[]; envVars: Record<string, string> }
> = {
  copilot: {
    cmd: "copilot",
    chatFlags: ["--add-dir", ".", "--yolo", "--experimental"],
    envVars: {
      COPILOT_ALLOW_ALL: "true",
    },
  },
  opencode: { cmd: "opencode", chatFlags: [], envVars: {} },
  claude: {
    cmd: "claude",
    chatFlags: [
      "--allow-dangerously-skip-permissions",
      "--dangerously-skip-permissions",
    ],
    envVars: {
      // Enables session_state_changed events in the session JSONL transcript,
      // which the idle detection in claude.ts watches for to know when the
      // agent has finished processing a prompt.
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
    },
  },
};

/** Thrown when the user aborts a running workflow via `q` or `Ctrl+C`. */
class WorkflowAbortError extends Error {
  constructor() {
    super("Workflow aborted by user");
    this.name = "WorkflowAbortError";
  }
}

/** Compile-time exhaustiveness guard for discriminated unions. */
function assertNever(value: never): never {
  throw new Error(`Unhandled agent type: ${String(value)}`);
}

// Re-export for backward compatibility (tests import from here)
export { errorMessage } from "../errors.ts";

// ---------------------------------------------------------------------------
// Telemetry stub used by loggedKillWindow.
//
// atomic-sdk has no real telemetry sink yet; the shape mirrors
// packages/atomic/src/lib/telemetry/offload-events.ts so the call site is
// identical to the eventual real implementation.
// ---------------------------------------------------------------------------

export interface TelemetrySink {
  emit(event: string, payload: Record<string, unknown>): void;
}

const _defaultTelemetry: TelemetrySink = { emit: () => {} };
const _defaultWarn = (msg: string): void => console.warn(msg);

let _telemetrySink: TelemetrySink = _defaultTelemetry;
let _warnSink: (msg: string) => void = _defaultWarn;

/**
 * Production seam for injecting telemetry + warn sinks (RFC §5.11).
 * Also used in tests to swap sinks without touching real infrastructure.
 * Call with `{}` to restore defaults.
 */
export function setExecutorTelemetrySinks(
  sinks: Partial<{ telemetry: TelemetrySink; warn: (msg: string) => void }>,
): void {
  _telemetrySink = sinks.telemetry ?? _defaultTelemetry;
  _warnSink = sinks.warn ?? _defaultWarn;
}

/**
 * Kill a tmux window and surface any rejection via warn + telemetry.
 *
 * Reserved-name rejections (orchestrator-name leak, fixture leak) are bug
 * conditions that must be observable — they must NOT be silently swallowed.
 */
async function loggedKillWindow(
  sessionName: string,
  windowName: string,
  origin: "stage-error" | "abort-cleanup",
): Promise<void> {
  try {
    await tmux.killWindow(sessionName, windowName);
  } catch (err) {
    const msg = errorMessage(err);
    _warnSink(`killWindow rejected for ${windowName} (${origin}): ${msg}`);
    _telemetrySink.emit("workflow.tmux.kill_window_rejected", {
      windowName,
      origin,
      error: msg,
    });
  }
}

/** Exported for unit testing only. Not part of the public API. */
export const _loggedKillWindowForTest = loggedKillWindow;

// ---------------------------------------------------------------------------
// Agent readiness wait — wired into OffloadManager via deps.waitForReady.
// ---------------------------------------------------------------------------

/** Polling interval for the Claude SessionStart marker file (ms). */
const CLAUDE_READY_POLL_MS = 200;
/** Total time to wait for the agent to signal readiness post-resume (ms). */
const AGENT_READY_TIMEOUT_MS = 10_000;

/**
 * Claude readiness probe — poll the SessionStart hook marker file.
 * Rejects markers whose mtime < startMs (stale from a prior session).
 * Throws `RESUME_TIMEOUT_CLAUDE` after {@link AGENT_READY_TIMEOUT_MS}.
 *
 * @param agentSessionId - The agent session ID used as the marker filename.
 * @param startMs - Resume-attempt start time (default: Date.now()). Markers
 *   written before this time are treated as stale and skipped (RFC §5.5).
 * @param markerBaseDir - Base directory for marker files. Defaults to
 *   `~/.atomic/claude-ready`. Injectable for unit testing only.
 */
async function waitForClaudeReady(
  agentSessionId: string,
  startMs: number = Date.now(),
  markerBaseDir: string = join(homedir(), ".atomic", "claude-ready"),
): Promise<void> {
  const marker = join(markerBaseDir, agentSessionId);
  const deadline = Date.now() + AGENT_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const st = await fsStat(marker);
      if (st.mtimeMs >= startMs) return;
      // Stale marker (pre-resume). Continue polling.
    } catch {
      // Marker not yet written — continue polling.
    }
    await Bun.sleep(CLAUDE_READY_POLL_MS);
  }
  throw new Error("RESUME_TIMEOUT_CLAUDE");
}

/** Exported for unit testing only. Not part of the public API. */
export const _waitForClaudeReadyForTest = waitForClaudeReady;

/**
 * OpenCode readiness probe — wait for HTTP server, then poll `session.get`
 * until the resumed session ID is registered.
 * Throws `RESUME_TIMEOUT_OPENCODE` after {@link AGENT_READY_TIMEOUT_MS}.
 */
async function waitForOpencodeReady(agentSessionId: string, paneId: string): Promise<void> {
  const serverUrl = await waitForServer("opencode", paneId);
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
  const client = createOpencodeClient({ baseUrl: serverUrl });
  const deadline = Date.now() + AGENT_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const result = await client.session.get({ sessionID: agentSessionId });
      if (result.data) return;
    } catch {
      // Network error — keep polling.
    }
    await Bun.sleep(CLAUDE_READY_POLL_MS);
  }
  throw new Error("RESUME_TIMEOUT_OPENCODE");
}

/**
 * Copilot readiness probe — wait for HTTP server, then confirm the resumed
 * session is registered via `getSessionMetadata`. Single-shot (not a poll)
 * since `waitForServer` already verified the SDK can connect.
 * Throws `RESUME_TIMEOUT_COPILOT` if the session is not registered.
 */
async function waitForCopilotReady(agentSessionId: string, paneId: string): Promise<void> {
  const serverUrl = await waitForServer("copilot", paneId);
  const { CopilotClient } = await import("@github/copilot-sdk");
  const probe = new CopilotClient({ cliUrl: serverUrl });
  await probe.start();
  try {
    const metadata = await probe.getSessionMetadata(agentSessionId);
    if (!metadata) throw new Error("RESUME_TIMEOUT_COPILOT");
  } finally {
    await probe.stop();
  }
}

/**
 * Default `waitForReady` impl wired into OffloadManager. Dispatches to a
 * per-agent probe; each probe owns its own timeout and throws
 * `RESUME_TIMEOUT_<AGENT>` on failure (RFC §9 Q11).
 */
export async function defaultWaitForAgentReady(
  agent: AgentType,
  agentSessionId: string,
  paneId: string,
): Promise<void> {
  switch (agent) {
    case "claude":
      return waitForClaudeReady(agentSessionId);
    case "opencode":
      return waitForOpencodeReady(agentSessionId, paneId);
    case "copilot":
      return waitForCopilotReady(agentSessionId, paneId);
    default:
      return assertNever(agent);
  }
}

/** Runtime guard for deserialized SavedMessage objects. */
function isValidSavedMessage(msg: unknown): msg is SavedMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return (
    m.provider === "copilot" ||
    m.provider === "opencode" ||
    m.provider === "claude"
  );
}

export interface WorkflowRunOptions {
  /** The compiled workflow definition */
  definition: WorkflowDefinition;
  /** Agent type */
  agent: AgentType;
  /**
   * Structured inputs for this run. Free-form workflows model their
   * single positional prompt as `{ prompt: "..." }` so workflow
   * authors can read `ctx.inputs.prompt` uniformly regardless of
   * whether the workflow declares a schema. Empty record is valid.
   */
  inputs?: Record<string, string>;
  /** Project root (defaults to cwd) */
  projectRoot?: string;
  /**
   * When true, create the tmux session and return immediately instead
   * of attaching. The orchestrator keeps running in the background on
   * the atomic tmux socket; users can attach later with
   * `atomic workflow session connect <name>`.
   */
  detach?: boolean;
  /**
   * Optional override for the dispatcher binary. When set, the SDK
   * spawns this path verbatim for `_orchestrator-entry` / `_cc-debounce`
   * instead of routing through its own bundled cli.ts. The override
   * binary must accept the internal sub-commands directly — atomic's
   * own CLI does, and any `bun build --compile`d host that imports
   * `runWorkflow` from `@bastani/atomic-sdk/workflows` self-dispatches
   * automatically (the SDK barrel intercepts argv at module-load time).
   *
   * Mirrors the Claude Agent SDK's `pathToClaudeCodeExecutable`.
   */
  pathToAtomicExecutable?: string;
}

interface SessionResult {
  name: string;
  sessionId: string;
  sessionDir: string;
  paneId: string;
}

/** A session that has been spawned but may not have completed yet. */
interface ActiveSession {
  name: string;
  paneId: string;
  /** Settles when the session finishes. Resolves on success, rejects on failure. */
  done: Promise<void>;
}

function generateId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function getSessionsBaseDir(): string {
  return join(homedir(), ".atomic", "sessions");
}

/**
 * Resolve a non-JS Copilot CLI binary on PATH.
 *
 * Under Bun, `@github/copilot-sdk` spawns its bundled JS entry via `node`
 * (see `getNodeExecPath` in the SDK). If `node` isn't installed — common in
 * minimal containers — the spawn fails silently with ENOENT and the SDK's
 * write to the child's stdin surfaces as "Cannot call write after a stream
 * was destroyed" from vscode-jsonrpc. Pointing the SDK at a standalone
 * `copilot` binary (the npm-installed ELF executable) sidesteps the
 * node-vs-bun problem because the SDK execs it directly when the path does
 * not end in `.js`.
 *
 * Returns undefined if no suitable binary is found.
 */
export function discoverCopilotBinary(): string | undefined {
  const pathVar = process.env.PATH;
  if (!pathVar) return undefined;
  // Windows: only `copilot.exe` is probed. Bun's global install writes a
  // real `.exe` shim, so this covers the Bun-container scenario this guard
  // exists for. Pre-existing npm-installed shims (`copilot.cmd`/`.ps1`)
  // aren't handled — the entire override is gated on `process.versions.bun`.
  const exe = process.platform === "win32" ? "copilot.exe" : "copilot";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    if (!isExecutableFile(candidate)) continue;
    return candidate;
  }
  return undefined;
}

/**
 * True when we need to override the SDK's default CLI path — i.e. running
 * under Bun, the user hasn't set COPILOT_CLI_PATH, and `node` is not
 * available to execute the SDK's bundled JS entry.
 *
 * Pure predicate on the current env; safe to call repeatedly.
 */
export function shouldOverrideCopilotCliPath(): boolean {
  if (!process.versions.bun) return false;
  if (process.env.COPILOT_CLI_PATH) return false;
  if (isNodeOnPath()) return false;
  return discoverCopilotBinary() !== undefined;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform === "win32") return true;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isNodeOnPath(): boolean {
  const pathVar = process.env.PATH;
  if (!pathVar) return false;
  const exe = process.platform === "win32" ? "node.exe" : "node";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    if (isExecutableFile(join(dir, exe))) return true;
  }
  return false;
}

/**
 * Set safe env defaults for the orchestrator process before any SDK is
 * loaded. Idempotent — subsequent calls no-op once `COPILOT_CLI_PATH`
 * is set. Call as early as possible so headless Copilot subprocesses
 * inherit the resolved env.
 */
export function applyContainerEnvDefaults(): void {
  if (!process.versions.bun) return;
  if (process.env.COPILOT_CLI_PATH) return;
  if (isNodeOnPath()) return;
  const bin = discoverCopilotBinary();
  if (bin) process.env.COPILOT_CLI_PATH = bin;
}

/**
 * Resolve a CLI binary name to its absolute path using the parent atomic
 * process's PATH. tmux's child shell can have a stripped or differently
 * ordered PATH from the user's interactive shell — most visibly when atomic
 * is launched from a globally-installed bin wrapper rather than `bun run dev`.
 * Resolving here, where we still have the full interactive PATH, ensures
 * agent panes spawn regardless of the child shell's PATH.
 *
 * Falls back to the bare name when the binary isn't found on PATH so behavior
 * stays unchanged for callers running entirely inside a normal interactive shell.
 */
function resolveCliBinary(cmd: string): string {
  return Bun.which(cmd, { PATH: process.env.PATH ?? "" }) ?? cmd;
}

/** Wrap a path in bash double quotes only when it contains shell-significant characters. */
function quotePathIfNeeded(path: string): string {
  return /[\s'"$`!\\]/.test(path) ? `"${escBash(path)}"` : path;
}

export function buildPaneCommand(
  agent: AgentType,
  overrides: ProviderOverrides = {},
  extraChatFlags: string[] = [],
): { command: string; envVars: Record<string, string>; chatFlags: string[] } {
  const {
    cmd,
    chatFlags: defaultFlags,
    envVars: defaultEnvVars,
  } = AGENT_CLI[agent];
  const chatFlags = overrides.chatFlags ?? defaultFlags;
  const claudeTempEnv = agent === "claude" ? atomicTempEnv() : {};
  const envVars = overrides.envVars
    ? { ...defaultEnvVars, ...overrides.envVars }
    : defaultEnvVars;
  const mergedEnvVars = { ...envVars, ...claudeTempEnv, ...overrides.envVars };
  // Effective spawn-time chatFlags: defaults/overrides plus extras (e.g. Copilot
  // SCM-disable). Persisted into metadata.json#resume.chatFlags so resume re-spawns
  // with byte-identical argv.
  const mergedChatFlags = [...chatFlags, ...extraChatFlags];

  const resolvedCmd = quotePathIfNeeded(resolveCliBinary(cmd));

  switch (agent) {
    case "copilot": {
      // Prefer the copilot binary resolved via resolveCopilotCliPath so that
      // COPILOT_CLI_PATH (set by applyContainerEnvDefaults in Bun-without-node
      // environments) is honoured in the tmux pane command, keeping the pane
      // binary consistent with the SDK subprocess binary.
      const copilotBin = resolveCopilotCliPath() ?? resolveCliBinary(cmd);
      return {
        command: [
          quotePathIfNeeded(copilotBin),
          "--ui-server",
          "--port",
          "0",
          ...mergedChatFlags,
        ].join(" "),
        envVars: mergedEnvVars,
        chatFlags: mergedChatFlags,
      };
    }
    case "opencode":
      return {
        command: [resolvedCmd, "--port", "0", ...mergedChatFlags].join(" "),
        envVars: mergedEnvVars,
        chatFlags: mergedChatFlags,
      };
    case "claude": {
      // Claude is started via createClaudeSession() in the workflow's run().
      // Resolve $SHELL (or the platform default) to an absolute path for the
      // same reason the agent CLIs are resolved above.
      const fallback = process.platform === "win32" ? "pwsh" : "sh";
      const shellCandidate = process.env.SHELL || fallback;
      const resolvedShell =
        shellCandidate.includes("/") || shellCandidate.includes("\\")
          ? shellCandidate
          : resolveCliBinary(shellCandidate);
      return {
        command: quotePathIfNeeded(resolvedShell),
        envVars: mergedEnvVars,
        chatFlags: mergedChatFlags,
      };
    }
    default:
      return assertNever(agent);
  }
}

export async function waitForServer(
  agent: AgentType,
  paneId: string,
): Promise<string> {
  if (agent === "claude") return "";

  const portDeadline = Date.now() + PORT_DISCOVERY_TIMEOUT_MS;

  // 1. Wait for the agent process to start and the TUI to render.
  while (Date.now() < portDeadline) {
    const content = tmux.capturePane(paneId);
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length >= 3) break;
    await Bun.sleep(1_000);
  }

  // 2. Discover the listening port via the agent's PID.
  const panePid = tmux.getPanePid(paneId);
  if (!panePid) {
    throw new Error(`failed to resolve agent PID for pane ${paneId}`);
  }
  const remainingMs = Math.max(0, portDeadline - Date.now());
  const port = await getListeningPortForPid(panePid, {
    timeoutMs: remainingMs,
  });
  if (port === null) {
    throw new Error(
      `agent (${agent}) did not bind a TCP port within ${PORT_DISCOVERY_TIMEOUT_MS}ms ` +
        `(pane ${paneId}, pid ${panePid})`,
    );
  }
  const serverUrl = `localhost:${port}`;

  // 3. Verify the SDK can actually connect.
  if (agent === "copilot") {
    const probeDeadline = Date.now() + SERVER_PROBE_TIMEOUT_MS;
    const { CopilotClient } = await import("@github/copilot-sdk");
    while (Date.now() < probeDeadline) {
      try {
        const probe = new CopilotClient({ cliUrl: serverUrl });
        await probe.start();
        await probe.listSessions();
        await probe.stop();
        return serverUrl;
      } catch {
        await Bun.sleep(1_000);
      }
    }
    throw new Error(
      `copilot SDK probe did not respond at ${serverUrl} within ${SERVER_PROBE_TIMEOUT_MS}ms`,
    );
  }

  // OpenCode: short settle delay, then return.
  await Bun.sleep(1_000);
  return serverUrl;
}

/**
 * Escape a string for safe interpolation inside a bash double-quoted string.
 *
 * In bash `"..."` strings only `$`, `` ` ``, `\`, `"`, and `!` are special.
 * Single quotes are literal inside double quotes and need no escaping.
 * Null bytes are stripped because bash strings cannot contain them.
 */
export function escBash(s: string): string {
  return s
    .replace(/\x00/g, "")
    .replace(/[\n\r]+/g, " ")
    .replace(/[\\"$`!]/g, "\\$&");
}

/**
 * Escape a string for safe interpolation inside a PowerShell double-quoted string.
 *
 * In PowerShell `"..."` strings, backtick is the escape character and `$` triggers
 * variable expansion.  Null bytes are stripped for safety.
 */
export function escPwsh(s: string): string {
  return s
    .replace(/\x00/g, "")
    .replace(/[`"$]/g, "`$&")
    .replace(/\n/g, "`n")
    .replace(/\r/g, "`r");
}

/**
 * Coerce raw string inputs to their declared runtime types. Integer inputs
 * become `number`; every other declared type passes through as `string`.
 * Unknown keys (not in the schema) are preserved as strings.
 *
 * Invalid integer strings fall back to the key being dropped — validation
 * already runs upstream (in `validateInputsAgainstSchema`), so reaching
 * this path with garbage means the executor was invoked out-of-band.
 */
export function coerceInputsBySchema(
  inputs: Record<string, string>,
  schema: readonly WorkflowInput[],
): Record<string, string | number> {
  const byName = new Map(schema.map((f) => [f.name, f]));
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(inputs)) {
    const field = byName.get(k);
    if (field?.type === "integer") {
      const parsed = Number.parseInt(v, 10);
      if (Number.isFinite(parsed) && Number.isInteger(parsed)) {
        out[k] = parsed;
      }
      continue;
    }
    out[k] = v;
  }
  return out;
}

// ============================================================================
// Entry point called by the CLI command
// ============================================================================

/**
 * Called by `atomic workflow -n <name> -a <agent> <prompt>`.
 *
 * Always creates a tmux session in the atomic socket with the
 * orchestrator as the initial pane, then attaches so the user sees
 * everything live — even when invoked from inside another tmux session.
 */
export async function executeWorkflow(
  options: WorkflowRunOptions,
): Promise<{ id: string; tmuxSessionName: string }> {
  const {
    definition,
    agent,
    inputs = {},
    projectRoot = process.cwd(),
    detach = false,
    pathToAtomicExecutable,
  } = options;

  // Resolve the dispatcher early — before any tmux or filesystem side-effect
  // so NoDispatcherError rejects the promise without leaking a tmux session
  // (RFC §5.7).
  const dispatcher = resolveDispatcher({ override: pathToAtomicExecutable });

  // OpenCode reads its `instructions` array from `.opencode/opencode.json`
  // at server-start time — both for the interactive tmux-pane path and the
  // headless `createOpencode({ port: 0 })` path. Reconcile here, before
  // either spawn, so the resolved AGENTS.md is the source of truth on
  // every workflow run. Best-effort: a malformed config shouldn't block.
  if (agent === "opencode") {
    try {
      await reconcileOpencodeInstructions(projectRoot);
    } catch {
      /* swallow */
    }
  }

  const workflowRunId = generateId();
  const tmuxSessionName = `atomic-wf-${agent}-${definition.name}-${workflowRunId}`;
  const sessionsBaseDir = join(getSessionsBaseDir(), workflowRunId);
  await ensureDir(sessionsBaseDir);

  // Compose the per-session env exactly like `atomic chat` does in
  // `chat/index.ts`: agent-CLI defaults + claude temp env + provider
  // overrides + ATOMIC_AGENT, then layer terminal defaults
  // (LANG / LC_ALL / LC_CTYPE / TERM / COLORTERM=truecolor) via
  // `buildLauncherEnv`. Without this the orchestrator pane lost
  // COLORTERM (OpenTUI fell back to 256-color rendering) and stage
  // panes never saw provider-overrides envVars (e.g. custom
  // ANTHROPIC_API_URL / OPENAI_BASE_URL set in
  // `~/.atomic/settings.json#providers.<agent>.envVars`).
  const providerOverrides = await getProviderOverrides(agent, projectRoot);
  const claudeTempEnv = agent === "claude" ? atomicTempEnv() : {};
  const agentEnv: Record<string, string> = {
    ...AGENT_CLI[agent].envVars,
    ...claudeTempEnv,
    ...providerOverrides.envVars,
    ATOMIC_AGENT: agent,
  };
  const sessionEnv = buildTmuxEnv(agentEnv);

  // Write a launcher script for the orchestrator pane.
  // Re-executes the atomic CLI's hidden `_orchestrator-entry` sub-command
  // with positional args:
  //   atomic _orchestrator-entry <workflowName> <agent> <inputsB64> <workflowSource>
  // (or `bun <cli.ts> _orchestrator-entry …` in dev). Mirrors OpenCode's
  // single-binary architecture — every fresh-process entry into atomic
  // goes through a CLI sub-command, never a free-standing JS bundle.
  //
  // Why both `name` and `source`: in a `bun build --compile` binary every
  // bundled module's `import.meta.path` collapses to `/$bunfs/root/<binary>`,
  // so the `definition.source` captured at workflow-module-eval time
  // points at the binary itself. The CLI's `_orchestrator-entry` resolves
  // by name+agent against the builtin registry in that case; in dev /
  // installed-package mode it falls back to dynamic-importing the source
  // so third-party SDK consumers (whose workflows aren't in the builtin
  // registry) keep working.
  const isWin = process.platform === "win32";
  const launcherExt = isWin ? "ps1" : "sh";
  const launcherPath = join(sessionsBaseDir, `orchestrator.${launcherExt}`);
  const logPath = join(sessionsBaseDir, "orchestrator.log");
  // Orchestrator launcher env = session env + workflow-specific extras.
  // The workflow extras (ATOMIC_WF_* + diagnostics) are orchestrator-only,
  // so they live in the launcher script rather than the session env.
  const launcherEnvVars: Record<string, string> = {
    ...buildLauncherEnv(agentEnv),
    ...workflowDiagnosticsEnv(),
    ATOMIC_WF_ID: workflowRunId,
    ATOMIC_WF_TMUX: tmuxSessionName,
    ATOMIC_WF_AGENT: agent,
    ATOMIC_WF_CWD: projectRoot,
  };

  // Inputs are passed through as base64-encoded JSON so long multiline
  // text values survive shell quoting without any further escaping.
  // Free-form workflows ride the same pipe — their single positional
  // prompt is stored under the `prompt` key so workflow authors always
  // read the user's prompt via `ctx.inputs.prompt`.
  const inputsB64 = Buffer.from(JSON.stringify(inputs)).toString("base64");
  const workflowSource = definition.source;

  // Build the self-re-exec command line via the resolved dispatcher.
  // Resolution order (already performed above, before any side-effects):
  //   - override-binary → `<override> _orchestrator-entry <args>`
  //   - host-bun        → `<bun> <SDK cli.ts> _orchestrator-entry <args>`
  const orchestratorCmd = buildSelfExecCommand({
    dispatcher,
    subcommand: "_orchestrator-entry",
    args: [definition.name, agent, inputsB64, workflowSource],
  });

  const launcherScript = isWin
    ? [
        `Set-Location "${escPwsh(projectRoot)}"`,
        ...Object.entries(launcherEnvVars).map(
          ([key, value]) => `$env:${key} = "${escPwsh(value)}"`,
        ),
        `& ${orchestratorCmd} 2>"${escPwsh(logPath)}"`,
      ].join("\n")
    : [
        "#!/bin/bash",
        `cd "${escBash(projectRoot)}"`,
        ...Object.entries(launcherEnvVars).map(
          ([key, value]) => `export ${key}="${escBash(value)}"`,
        ),
        `${orchestratorCmd} 2>"${escBash(logPath)}"`,
      ].join("\n");

  await writeFile(launcherPath, launcherScript, { mode: 0o755 });

  const shellCmd = isWin
    ? `pwsh -NoProfile -File "${escPwsh(launcherPath)}"`
    : `bash "${escBash(launcherPath)}"`;
  // Pass `sessionEnv` (not `launcherEnvVars`) to tmux's `new-session -e
  // KEY=VALUE` so all subsequent windows / panes inherit the same agent
  // env that chat sets — terminal defaults, AGENT_CLI defaults, provider
  // overrides, ATOMIC_AGENT. Workflow-only extras (ATOMIC_WF_* and
  // diagnostics) stay in the orchestrator launcher script's env exports
  // since stage panes don't need them.
  const orchPaneId = tmux.createSession(
    tmuxSessionName,
    shellCmd,
    "orchestrator",
    undefined,
    sessionEnv,
    pathToAtomicExecutable,
  );

  // Set up the workflow's status-line up-front so the default tmux
  // window-list (`0:orchestrator …`) doesn't leak through before the
  // first agent stage starts. The format is shared across all windows
  // in this session and switches between the orchestrator and agent
  // branches via `#{window_name}`, so this single call covers every
  // future stage window too — `createSessionRunner` re-applies it per
  // stage to refresh user-option state, but the orchestrator pane no
  // longer flashes the default tmux status while waiting.
  spawnAttachedFooter("orchestrator", orchPaneId, undefined, tmuxSessionName);

  if (detach) {
    // Session is already running detached on the atomic socket (tmux
    // new-session -d). Print connection hints and return so the caller
    // can exit cleanly without blocking on the orchestrator.
    printDetachedBanner(tmuxSessionName);
    return { id: workflowRunId, tmuxSessionName };
  }

  if (tmux.isInsideAtomicSocket()) {
    // Already on the atomic server — just switch to the new session.
    tmux.switchClient(tmuxSessionName);
  } else if (tmux.isInsideTmux()) {
    // Inside a different tmux server — detach and replace the client
    // with an attach to the atomic socket (no nesting).
    tmux.detachAndAttachAtomic(tmuxSessionName);
  } else {
    const attachProc = spawnMuxAttach(tmuxSessionName);
    await attachProc.exited;
  }

  return { id: workflowRunId, tmuxSessionName };
}

function workflowDiagnosticsEnv(): Record<string, string> {
  const keys = [
    "ATOMIC_TUI_DIAGNOSTICS",
    "ATOMIC_TUI_DIAGNOSTICS_DIR",
    "ATOMIC_TUI_DIAGNOSTICS_INTERVAL_MS",
    "ATOMIC_TUI_DIAGNOSTICS_MAX",
    "ATOMIC_TUI_DIAGNOSTICS_OPENTUI_DUMP",
  ];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Print a short banner telling the user the workflow is running in the
 * background and how to attach to it. Written to stdout so scripts can
 * capture the session name with a simple redirect.
 */
function printDetachedBanner(tmuxSessionName: string): void {
  const paint = createPainter();
  process.stdout.write(
    "\n" +
      "  " +
      paint("success", "✓") +
      " " +
      paint("text", "workflow started in background", { bold: true }) +
      "\n" +
      "  " +
      paint("dim", "session: ") +
      paint("accent", tmuxSessionName) +
      "\n" +
      "\n" +
      "  " +
      paint("dim", "attach: ") +
      paint("accent", `atomic workflow session connect ${tmuxSessionName}`) +
      "\n" +
      "  " +
      paint("dim", "list:   ") +
      paint("accent", "atomic workflow session list") +
      "\n" +
      "  " +
      paint("dim", "kill:   ") +
      paint("accent", `atomic workflow session kill ${tmuxSessionName}`) +
      "\n" +
      "\n",
  );
}

// ============================================================================
// Session execution helpers
// ============================================================================

/**
 * Resolve the provider-specific session identifier for use as
 * `SessionContext.sessionId`:
 *   - Claude interactive: `ClaudeSessionWrapper.sessionId` — the Claude UUID
 *     set when `createClaudeSession` ran.
 *   - Claude headless: `HeadlessClaudeSessionWrapper.sessionId` — the SDK
 *     `session_id` from the most recently completed `query()` (empty string
 *     until the first query returns).
 *   - Copilot: `CopilotSession.sessionId`.
 *   - OpenCode: `Session.id`.
 *
 * Returns an empty string for unknown shapes rather than throwing so
 * early-init readers of `s.sessionId` (e.g. logging) don't crash.
 */
function resolveProviderSessionId(
  agent: AgentType,
  providerSession: unknown,
): string {
  if (!providerSession || typeof providerSession !== "object") return "";
  const obj = providerSession as Record<string, unknown>;
  if (agent === "opencode") {
    return typeof obj["id"] === "string" ? (obj["id"] as string) : "";
  }
  // claude and copilot both expose `sessionId` as a string.
  return typeof obj["sessionId"] === "string"
    ? (obj["sessionId"] as string)
    : "";
}

/** Type guard for objects with a string `content` property (Copilot assistant.message data). */
export function hasContent(value: unknown): value is { content: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    typeof (value as { content: unknown }).content === "string"
  );
}

/**
 * Character budget cap for tool-call `input` payloads embedded in the
 * transcript. Tool call arguments can grow (diffs, large SQL strings, whole
 * files passed inline), and the transcript's primary consumer is a
 * downstream LLM that must `Read` this file as context for its own turn —
 * so we cap the per-call JSON at a predictable size. The suffix
 * `[+N chars]` preserves the dropped length for humans reviewing the file.
 *
 * Tool _results_ are intentionally NOT included in the transcript. File
 * contents, shell output, and search results inflate the transcript
 * dramatically and lead to context rot on the next stage. A reader (human
 * or model) can still reconstruct what the tool returned by looking at
 * the assistant's subsequent text — which is the whole point of the
 * assistant summarising its own work.
 */
const TRANSCRIPT_TOOL_INPUT_BUDGET = 800;

function truncateForTranscript(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + ` … [+${text.length - max} chars]`;
}

/** Render a tool_use `input` object as a JSON-ish block, capped to budget. */
function renderToolInput(input: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(input, null, 2);
  } catch {
    json = String(input);
  }
  return truncateForTranscript(json, TRANSCRIPT_TOOL_INPUT_BUDGET);
}

/**
 * Render a Claude transcript as readable Markdown.
 *
 * Captures the user/agent interaction chronologically:
 *   - User messages (string content)                  → `### User`
 *   - Assistant text blocks                           → `### Assistant`
 *   - Assistant `tool_use` blocks                     → `**→ \`Name\`**` + JSON input
 *
 * Intentionally omitted:
 *   - `tool_result` blocks — their payloads (file contents, shell output,
 *     stringified diffs) dominate the transcript and lead to context rot on
 *     the next stage. The assistant's subsequent text response already
 *     summarises what the tool returned; re-including the raw output
 *     duplicates that information at high token cost.
 *   - `thinking` blocks — verbose internal reasoning rarely useful when the
 *     transcript is re-ingested as context elsewhere.
 *   - `system` / `summary` / other non-message types.
 */
function renderClaudeTranscript(
  messages: ReadonlyArray<{ type: string; message: unknown }>,
): string {
  const sections: string[] = [];

  for (const msg of messages) {
    if (msg.type !== "user" && msg.type !== "assistant") continue;

    // `message` shape is one of:
    //   - a plain string (legacy path),
    //   - `{ role, content: string }` (API-style plain text turn),
    //   - `{ role, content: Block[] }` (tool-use / tool-result turns).
    // Normalise the first two into a single string; handle the third below.
    const rawMessage = msg.message;
    let plainText: string | null = null;
    let arrayContent: unknown[] | null = null;

    if (typeof rawMessage === "string") {
      plainText = rawMessage;
    } else if (rawMessage && typeof rawMessage === "object") {
      const content = (rawMessage as { content?: unknown }).content;
      if (typeof content === "string") {
        plainText = content;
      } else if (Array.isArray(content)) {
        arrayContent = content;
      }
    }

    if (plainText !== null) {
      const trimmed = plainText.trim();
      if (trimmed) {
        const header = msg.type === "user" ? "### User" : "### Assistant";
        sections.push(`${header}\n\n${trimmed}`);
      }
      continue;
    }

    if (arrayContent === null) continue;
    const content = arrayContent;

    if (msg.type === "assistant") {
      // Group all blocks from a single assistant message under one header
      // so text and tool calls read as one coherent turn.
      const parts: string[] = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b["type"] === "text" && typeof b["text"] === "string") {
          const txt = (b["text"] as string).trim();
          if (txt) parts.push(txt);
        } else if (b["type"] === "tool_use") {
          const name =
            typeof b["name"] === "string" ? (b["name"] as string) : "tool";
          const input = renderToolInput(b["input"]);
          parts.push(`**→ \`${name}\`**\n\n\`\`\`json\n${input}\n\`\`\``);
        }
        // Skip "thinking" blocks.
      }
      if (parts.length > 0) {
        sections.push(`### Assistant\n\n${parts.join("\n\n")}`);
      }
      continue;
    }

    // msg.type === "user" with array content — usually a batch of tool_results
    // responding to the previous assistant turn's tool_use blocks. We skip
    // the tool_result payloads entirely (see function docstring for why) and
    // only surface any inline `text` blocks, which is where a real follow-up
    // user turn would land.
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b["type"] === "text" && typeof b["text"] === "string") {
        const txt = (b["text"] as string).trim();
        if (txt) sections.push(`### User\n\n${txt}`);
      }
    }
  }

  return sections.join("\n\n");
}

/**
 * Render a Copilot transcript as readable Markdown.
 *
 * Preserves the existing `assistant.message → content` extraction and adds
 * `user.message` rendering plus any `toolCalls` attached to an assistant
 * message. All other event types (`session.start`, `session.idle`, plain
 * telemetry, etc.) are skipped.
 */
function renderCopilotTranscript(
  events: ReadonlyArray<{ type?: unknown; data?: unknown }>,
): string {
  const sections: string[] = [];

  for (const evt of events) {
    if (evt.type === "assistant.message") {
      const data = evt.data;
      if (!hasContent(data)) continue;
      const parts: string[] = [];
      const text = data.content.trim();
      if (text) parts.push(text);

      // toolCalls is an array on `assistant.message` data when present.
      const toolCalls = (data as Record<string, unknown>)["toolCalls"];
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          if (!call || typeof call !== "object") continue;
          const c = call as Record<string, unknown>;
          const name =
            typeof c["name"] === "string"
              ? (c["name"] as string)
              : typeof c["toolName"] === "string"
                ? (c["toolName"] as string)
                : "tool";
          const args = c["arguments"] ?? c["input"] ?? c["parameters"];
          parts.push(
            `**→ \`${name}\`**\n\n\`\`\`json\n${renderToolInput(args)}\n\`\`\``,
          );
        }
      }

      if (parts.length > 0) {
        sections.push(`### Assistant\n\n${parts.join("\n\n")}`);
      }
      continue;
    }

    if (evt.type === "user.message") {
      const data = evt.data;
      if (hasContent(data)) {
        const text = data.content.trim();
        if (text) sections.push(`### User\n\n${text}`);
      }
    }
    // All other event types are intentionally skipped.
  }

  return sections.join("\n\n");
}

/**
 * Render an OpenCode prompt response as readable Markdown.
 *
 * OpenCode hands us `{ info, parts }`; `parts` is a discriminated union where
 * `text` parts carry the assistant reply and `tool` parts carry tool
 * invocations. `reasoning` and `subtask` parts are internal and omitted.
 */
function renderOpencodeTranscript(response: {
  parts?: ReadonlyArray<
    { type?: unknown; text?: unknown } & Record<string, unknown>
  >;
}): string {
  if (!response.parts) return "";
  const parts: string[] = [];
  for (const part of response.parts) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      const txt = part.text.trim();
      if (txt) parts.push(txt);
    } else if (part.type === "tool") {
      const name =
        typeof part["tool"] === "string"
          ? (part["tool"] as string)
          : typeof part["name"] === "string"
            ? (part["name"] as string)
            : "tool";
      const state = part["state"];
      const args =
        state && typeof state === "object"
          ? ((state as Record<string, unknown>)["input"] ??
            (state as Record<string, unknown>)["args"])
          : undefined;
      parts.push(
        `**→ \`${name}\`**\n\n\`\`\`json\n${renderToolInput(args)}\n\`\`\``,
      );
      // Tool outputs are intentionally omitted — see the comment on
      // `TRANSCRIPT_TOOL_INPUT_BUDGET` for the context-rot rationale.
    }
  }
  if (parts.length === 0) return "";
  return `### Assistant\n\n${parts.join("\n\n")}`;
}

export function renderMessagesToText(messages: SavedMessage[]): string {
  // Claude messages already come in as a flat chronological list — render
  // the whole slice at once so the helper can cross-reference tool_use_ids
  // against tool_result blocks. Copilot and OpenCode keep their existing
  // per-message rendering.
  const sections: string[] = [];
  const claudeBatch: Array<{ type: string; message: unknown }> = [];

  const flushClaude = (): void => {
    if (claudeBatch.length === 0) return;
    const rendered = renderClaudeTranscript(claudeBatch);
    if (rendered) sections.push(rendered);
    claudeBatch.length = 0;
  };

  for (const m of messages) {
    if (m.provider === "claude") {
      claudeBatch.push(m.data as unknown as { type: string; message: unknown });
      continue;
    }
    flushClaude();
    if (m.provider === "copilot") {
      const rendered = renderCopilotTranscript([
        m.data as unknown as { type?: unknown; data?: unknown },
      ]);
      if (rendered) sections.push(rendered);
    } else if (m.provider === "opencode") {
      const rendered = renderOpencodeTranscript(
        m.data as unknown as {
          parts?: ReadonlyArray<
            { type?: unknown; text?: unknown } & Record<string, unknown>
          >;
        },
      );
      if (rendered) sections.push(rendered);
    }
  }
  flushClaude();

  return sections.join("\n\n");
}

/** Resolve a SessionRef (string or SessionHandle) to the session name. */
function resolveRef(ref: SessionRef): string {
  return typeof ref === "string" ? ref : ref.name;
}

/**
 * Minimal Copilot session surface required by `wrapCopilotSend()`.
 * Uses a generic `on` signature to remain compatible with both the real
 * CopilotSession and lightweight test mocks.
 */
export interface CopilotSendSessionSurface {
  on(
    eventType: string,
    handler: (event: { data?: unknown }) => void,
  ): () => void;
}

/**
 * Wraps a Copilot session's `send()` to block until `session.idle` fires.
 *
 * Copilot's `send()` is fire-and-forget — it returns immediately after
 * queuing the message.  This wrapper blocks the returned promise until the
 * session emits `session.idle` (turn complete) or `session.error`.
 *
 * HIL detection for Copilot is handled separately by
 * `watchCopilotSessionForHIL()`, which subscribes to the session's
 * `tool.execution_start` / `tool.execution_complete` events for the
 * `ask_user` built-in tool.  Those events fire regardless of whether
 * an `onUserInputRequest` handler is registered, so we can detect HIL
 * via native SDK events while the CLI continues to handle user input
 * locally in the tmux pane.
 *
 * Exported for unit testing.
 */
export function wrapCopilotSend<O, R>(
  session: CopilotSendSessionSurface,
  nativeSend: (options: O) => Promise<R>,
): (options: O) => Promise<R> {
  return async (options: O): Promise<R> => {
    const idle = new Promise<void>((resolve, reject) => {
      let unsubIdle: (() => void) | undefined;
      let unsubError: (() => void) | undefined;
      const cleanup = () => {
        unsubIdle?.();
        unsubError?.();
      };
      unsubIdle = session.on("session.idle", () => {
        cleanup();
        resolve();
      });
      unsubError = session.on("session.error", (event) => {
        cleanup();
        const data = event.data as { message?: string } | undefined;
        reject(new Error(data?.message ?? "Copilot session error"));
      });
    });
    const result = await nativeSend(options);
    await idle;
    return result;
  };
}

/**
 * Minimal shape of an event as produced by the OpenCode v2 SDK event stream.
 * Using a structural interface rather than the SDK's generated union type keeps
 * this helper independently unit-testable with plain objects.
 *
 * `sessionID` is optional because many OpenCode event types (e.g.
 * `file.edited`, `session.compacted`) carry properties without that field.
 * The `watchOpencodeStreamForHIL` implementation guards with a runtime check.
 */
export interface OpenCodeHILEvent {
  type: string;
  properties: { sessionID?: string; [key: string]: unknown };
}

/**
 * Consume an OpenCode SSE event stream and call `onHIL` whenever the session
 * with `sessionId` enters or exits a human-in-the-loop (HIL) state:
 *
 *   - `question.asked`    → `onHIL(true)`   (agent awaiting user input)
 *   - `question.replied`  → `onHIL(false)`  (user answered, agent resumes)
 *   - `question.rejected` → `onHIL(false)`  (user dismissed, agent resumes)
 *
 * Events for other sessions are silently ignored.  The function returns when
 * the stream is exhausted (i.e. the server closes the connection).
 *
 * NOTE: OpenCode does not emit any bus event for MCP-server-initiated
 * elicitation requests — its MCP client never registers an
 * `ElicitRequestSchema` handler, so such requests are auto-rejected by the
 * MCP SDK at the protocol layer before reaching any OpenCode-level code.
 * As a result, the workflow UI **cannot** mark an OpenCode session as
 * "awaiting input" for MCP elicitation; this is an upstream limitation that
 * Atomic cannot work around.  If a future OpenCode release surfaces MCP
 * elicitation as a bus event, extend the switch below (or add a sibling
 * watcher) to map it onto `onHIL`.
 *
 * Exported for unit testing.
 */
export async function watchOpencodeStreamForHIL(
  stream: AsyncIterable<OpenCodeHILEvent>,
  sessionId: string,
  onHIL: (waiting: boolean) => void,
): Promise<void> {
  for await (const event of stream) {
    if (
      event.type === "question.asked" &&
      event.properties.sessionID === sessionId
    ) {
      onHIL(true);
    } else if (
      (event.type === "question.replied" ||
        event.type === "question.rejected") &&
      event.properties.sessionID === sessionId
    ) {
      onHIL(false);
    }
  }
}

/**
 * Minimal Copilot session surface required by `watchCopilotSessionForHIL()`.
 * A structural `on()` signature keeps this helper independently unit-testable
 * with plain objects and compatible with both the real CopilotSession and
 * test mocks.
 */
export interface CopilotHILSessionSurface {
  on(
    eventType: string,
    handler: (event: { data?: unknown }) => void,
  ): () => void;
}

/**
 * Subscribe to a Copilot session's tool-execution events to track HIL state
 * for the `ask_user` built-in tool:
 *
 *   - `tool.execution_start`    with `toolName === "ask_user"` → `onHIL(true)`
 *   - `tool.execution_complete` with matching `toolCallId`     → `onHIL(false)`
 *
 * These events fire regardless of whether an `onUserInputRequest` handler is
 * registered, so we can detect HIL without providing one — letting the CLI
 * keep its native tmux-pane dialog.
 *
 * Overlapping `ask_user` invocations are tracked by `toolCallId` so
 * `onHIL(false)` only fires after the last active request resolves.
 *
 * Returns an unsubscribe function that removes both listeners.
 *
 * Exported for unit testing.
 */
export function watchCopilotSessionForHIL(
  session: CopilotHILSessionSurface,
  onHIL: (waiting: boolean) => void,
): () => void {
  const active = new Set<string>();
  const unsubStart = session.on("tool.execution_start", (event) => {
    const data = event.data as
      | { toolName?: string; toolCallId?: string }
      | undefined;
    if (data?.toolName === "ask_user" && data.toolCallId) {
      const wasEmpty = active.size === 0;
      active.add(data.toolCallId);
      if (wasEmpty) onHIL(true);
    }
  });
  const unsubComplete = session.on("tool.execution_complete", (event) => {
    const data = event.data as { toolCallId?: string } | undefined;
    if (
      data?.toolCallId &&
      active.delete(data.toolCallId) &&
      active.size === 0
    ) {
      onHIL(false);
    }
  });
  return () => {
    unsubStart();
    unsubComplete();
  };
}

/**
 * Subscribe to a Copilot session's elicitation events to track HIL state for
 * `session.ui.elicitation()`, `session.ui.select()`, `session.ui.input()`, and
 * MCP-server-initiated elicitation requests:
 *
 *   - `elicitation.requested`  → `onHIL(true)`  (set transitions empty→non-empty)
 *   - `elicitation.completed`  → `onHIL(false)` (set transitions non-empty→empty)
 *
 * Overlapping elicitation requests are tracked by `requestId` so
 * `onHIL(false)` only fires after the last in-flight request completes.
 *
 * Returns an unsubscribe function that removes both listeners.
 *
 * Exported for unit testing.
 */
export function watchCopilotSessionForElicitation(
  session: CopilotHILSessionSurface,
  onHIL: (waiting: boolean) => void,
): () => void {
  const active = new Set<string>();
  const unsubRequested = session.on("elicitation.requested", (event) => {
    const data = event.data as { requestId?: string } | undefined;
    if (data?.requestId) {
      const wasEmpty = active.size === 0;
      active.add(data.requestId);
      if (wasEmpty) onHIL(true);
    }
  });
  const unsubCompleted = session.on("elicitation.completed", (event) => {
    const data = event.data as { requestId?: string } | undefined;
    if (data?.requestId && active.delete(data.requestId) && active.size === 0) {
      onHIL(false);
    }
  });
  return () => {
    unsubRequested();
    unsubCompleted();
  };
}

// ============================================================================
// Shared transcript / message readers
// ============================================================================

/**
 * Create a `transcript(ref)` function bound to a completed-session registry.
 * Used by both the top-level WorkflowContext and per-session SessionContext
 * so the implementation is defined once.
 */
function createTranscriptReader(
  completedRegistry: Map<string, SessionResult>,
): (ref: SessionRef) => Promise<Transcript> {
  return async (ref) => {
    const refName = resolveRef(ref);
    const prev = completedRegistry.get(refName);
    if (!prev) {
      const available = [...completedRegistry.keys()].join(", ") || "(none)";
      throw new Error(
        `No transcript for "${refName}". Available: ${available}`,
      );
    }
    const filePath = join(prev.sessionDir, "inbox.md");
    const content = await Bun.file(filePath).text();
    return { path: filePath, content };
  };
}

/**
 * Create a `getMessages(ref)` function bound to a completed-session registry.
 * Used by both the top-level WorkflowContext and per-session SessionContext.
 */
function createMessagesReader(
  completedRegistry: Map<string, SessionResult>,
): (ref: SessionRef) => Promise<SavedMessage[]> {
  return async (ref) => {
    const refName = resolveRef(ref);
    const prev = completedRegistry.get(refName);
    if (!prev) {
      const available = [...completedRegistry.keys()].join(", ") || "(none)";
      throw new Error(`No messages for "${refName}". Available: ${available}`);
    }
    const filePath = join(prev.sessionDir, "messages.json");
    const raw = await Bun.file(filePath).text();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`Invalid messages file for "${refName}": expected array`);
    }
    return parsed.filter(isValidSavedMessage);
  };
}

// ============================================================================
// Session runner — implements ctx.stage() lifecycle
// ============================================================================

/** Shared state passed to session runners by the orchestrator. */
interface SharedRunnerState {
  tmuxSessionName: string;
  sessionsBaseDir: string;
  /**
   * The project root the workflow is operating against. Threaded through to
   * provider initialization so headless paths resolve project-scoped config
   * (e.g. `additional-instructions`) from the workflow's actual root rather
   * than `process.cwd()`, which can drift when workflows are invoked
   * programmatically or from a subdirectory.
   */
  projectRoot: string;
  agent: AgentType;
  /**
   * Structured inputs for this workflow run. Free-form workflows use
   * `{ prompt: "..." }`; structured workflows use their declared field
   * names. Workflow authors read both shapes via `ctx.inputs` — integer
   * inputs are parsed to `number`, everything else stays a `string`.
   */
  inputs: Record<string, string | number>;
  /** User-configured provider overrides (global + local merged). */
  providerOverrides: ProviderOverrides;
  /**
   * Extra CLI flags appended to the agent's chat flags, derived from
   * the project's scm selection. Currently only populated for Copilot
   * (which has no on-disk MCP toggle — see `getCopilotScmDisableFlags`).
   */
  extraChatFlags: string[];
  panel: OrchestratorPanel;
  /** Sessions that have been spawned (for name uniqueness + cleanup). */
  activeRegistry: Map<string, ActiveSession>;
  /** Sessions that completed successfully (for transcript reads). */
  completedRegistry: Map<string, SessionResult>;
  /** Sessions that already failed before completing successfully. */
  failedRegistry: Set<string>;
  /** Offload manager for pane offload/resume tracking (RFC §5.2). */
  offloadManager: OffloadManager;
  /** Workflow run ID (from ATOMIC_WF_ID env var). */
  workflowRunId: string;
}

/**
 * Append tool names to a Copilot `excludedTools` list without duplicating
 * entries the caller already supplied. Exported for unit testing.
 */
export function mergeExcludedTools(
  existing: string[] | undefined,
  extras: string[],
): string[] {
  const merged = [...(existing ?? [])];
  for (const tool of extras) {
    if (!merged.includes(tool)) merged.push(tool);
  }
  return merged;
}

type ExternalCopilotClientOptions = Omit<
  StageClientOptions<"copilot">,
  "gitHubToken" | "useLoggedInUser"
>;

interface ExternalCopilotOptions {
  clientOptions: ExternalCopilotClientOptions;
  sessionGitHubToken?: string;
}

/**
 * Copilot SDK 0.3.0 rejects client-level auth options when connecting to an
 * existing `cliUrl`. Visible stages use an already-running TUI server, so move
 * token auth to the session-level option that 0.3.0 introduced for this case.
 */
export function normalizeExternalCopilotOptions(
  clientOptions: StageClientOptions<"copilot">,
  sessionGitHubToken?: string,
): ExternalCopilotOptions {
  const {
    gitHubToken: clientGitHubToken,
    useLoggedInUser,
    ...externalClientOptions
  } = clientOptions;

  if (useLoggedInUser !== undefined) {
    throw new Error(
      "Copilot client option `useLoggedInUser` cannot be used for visible stages because they connect to an existing Copilot CLI server. Configure authentication on the server process instead.",
    );
  }

  const normalized: ExternalCopilotOptions = {
    clientOptions: externalClientOptions,
  };
  if (sessionGitHubToken !== undefined) {
    normalized.sessionGitHubToken = sessionGitHubToken;
  } else if (clientGitHubToken !== undefined) {
    normalized.sessionGitHubToken = clientGitHubToken;
  }
  return normalized;
}

/**
 * Create the provider-specific client and session for a stage.
 * Called by the session runner after server readiness is confirmed.
 *
 * Generic over `A` so callers receive typed `ProviderClient<A>` /
 * `ProviderSession<A>` without unsafe casts. The internal `switch`
 * branches know the concrete types being constructed, so the `as`
 * assertions here are producer-side (correct by construction) rather
 * than consumer-side (trusting the caller to guess right).
 */
async function initProviderClientAndSession<A extends AgentType>(
  agent: A,
  serverUrl: string,
  paneId: string,
  projectRoot: string,
  clientOpts: StageClientOptions<A>,
  sessionOpts: StageSessionOptions<A>,
  headless = false,
  onHIL?: (waiting: boolean) => void,
): Promise<{
  client: ProviderClient<A>;
  session: ProviderSession<A>;
  /** Optional cleanup for SDK-managed resources (e.g. headless OpenCode server). */
  cleanup?: () => void;
}> {
  type Result = {
    client: ProviderClient<A>;
    session: ProviderSession<A>;
    cleanup?: () => void;
  };

  switch (agent) {
    case "copilot": {
      const { CopilotClient, approveAll } = await import("@github/copilot-sdk");
      const { copilotSdkLaunchOptions, mergeCopilotSystemMessage } =
        await import("../providers/copilot.ts");
      const { resolveAdditionalInstructionsContent } =
        await import("../services/config/additional-instructions.ts");
      const copilotClientOpts = clientOpts as StageClientOptions<"copilot">;
      const copilotSessionOpts = sessionOpts as StageSessionOptions<"copilot">;
      // Headless: let the SDK spawn its own CLI process (no cliUrl).
      // Non-headless: connect to the CLI server running in a tmux pane.
      // `env` is only meaningful in the headless path — the SDK ignores
      // it when `cliUrl` is set — but layering in `copilotSdkLaunchOptions`
      // when the caller didn't supply their own env keeps the
      // SQLite `ExperimentalWarning` from leaking through the SDK's
      // `[CLI subprocess]` stderr forwarder.
      let externalCopilotOptions: ExternalCopilotOptions | undefined;
      let client: InstanceType<typeof CopilotClient>;
      if (headless) {
        client = new CopilotClient({
          ...copilotSdkLaunchOptions(),
          ...copilotClientOpts,
        });
      } else {
        externalCopilotOptions = normalizeExternalCopilotOptions(
          copilotClientOpts,
          copilotSessionOpts.gitHubToken,
        );
        client = new CopilotClient({
          ...externalCopilotOptions.clientOptions,
          cliUrl: serverUrl,
        });
      }
      await client.start();
      // In headless stages, add `ask_user` to the session's excludedTools so
      // the agent cannot call the interactive question tool — there is no
      // human attached to answer and the SDK would otherwise sit blocked.
      const additionalInstructions =
        await resolveAdditionalInstructionsContent(projectRoot);
      const sessionConfig = {
        onPermissionRequest: approveAll,
        ...copilotSessionOpts,
        ...(externalCopilotOptions?.sessionGitHubToken !== undefined
          ? { gitHubToken: externalCopilotOptions.sessionGitHubToken }
          : {}),
        ...(headless
          ? {
              excludedTools: mergeExcludedTools(
                copilotSessionOpts.excludedTools,
                ["ask_user"],
              ),
            }
          : {}),
        ...(additionalInstructions
          ? {
              systemMessage: mergeCopilotSystemMessage(
                copilotSessionOpts.systemMessage,
                additionalInstructions,
              ),
            }
          : {}),
      };
      const session = await client.createSession(sessionConfig);
      if (!headless) {
        await client.setForegroundSessionId(session.sessionId);
      }
      return { client, session } as Result;
    }
    case "opencode": {
      const ocSessionOpts = sessionOpts as StageSessionOptions<"opencode">;
      if (headless) {
        const { createOpencode } = await import("@opencode-ai/sdk/v2");
        // Scope OPENCODE_CLIENT=sdk around the SDK spawn so the subprocess
        // inherits it at fork time. OpenCode only registers its interactive
        // `question` tool when OPENCODE_CLIENT is "app"/"cli"/"desktop", so
        // identifying as "sdk" keeps the tool out of the registry entirely
        // — otherwise an unattended stage can hang forever on question.asked
        // (the tool's execute calls Question.ask directly and never consults
        // the session permission ruleset).
        return await withHeadlessOpencodeEnv(async () => {
          const oc = await createOpencode({ port: 0 });
          const sessionResult = await oc.client.session.create({
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
            ...ocSessionOpts,
          });
          return {
            client: oc.client,
            session: sessionResult.data!,
            cleanup: () => oc.server.close(),
          } as Result;
        });
      }
      const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
      const ocClientOpts = clientOpts as StageClientOptions<"opencode">;
      const client = createOpencodeClient({
        ...ocClientOpts,
        baseUrl: serverUrl,
      });
      const sessionResult = await client.session.create(ocSessionOpts);
      await client.tui.selectSession({ sessionID: sessionResult.data!.id });
      return { client, session: sessionResult.data! } as Result;
    }
    case "claude": {
      if (headless) {
        // Headless Claude stages use the Agent SDK directly — no tmux pane.
        // Each query gets its own SDK-assigned session_id; the wrapper
        // tracks the latest one and exposes it as `sessionId`.
        const client = new HeadlessClaudeClientWrapper();
        await client.start();
        const session = new HeadlessClaudeSessionWrapper(projectRoot);
        // Cast through `unknown` — `HeadlessClaudeClientWrapper` intentionally
        // omits the interactive-only fields (`paneId`, `sessionDir`, etc.)
        // that `ClaudeClientWrapper` has; both satisfy the same runtime
        // contract used by workflow code.
        return { client, session } as unknown as Result;
      }
      const claudeClientOpts = clientOpts as StageClientOptions<"claude">;
      const client = new ClaudeClientWrapper(paneId, claudeClientOpts);
      // `start()` now returns the Claude session UUID, which we pass through
      // to the session wrapper so `s.sessionId` is the Claude UUID (not the
      // atomic short ID). This fixes the parallel-workflow bug where save
      // used to look up "the newest Claude session globally" and could
      // attribute one branch's transcript to another.
      const claudeSessionId = await client.start();
      const session = new ClaudeSessionWrapper(paneId, claudeSessionId, onHIL);
      return { client, session } as Result;
    }
    default:
      return assertNever(agent);
  }
}

/**
 * Clean up provider-specific resources after a stage callback completes.
 * Errors are silently caught — cleanup must not mask callback errors.
 *
 * The `switch (agent)` already narrows the type, so we call
 * disconnect/stop directly without redundant `instanceof` checks or
 * dynamic imports.
 */
async function cleanupProvider<A extends AgentType>(
  agent: A,
  providerClient: ProviderClient<A>,
  providerSession: ProviderSession<A>,
  paneId: string,
): Promise<void> {
  switch (agent) {
    case "copilot": {
      const session = providerSession as ProviderSession<"copilot">;
      const client = providerClient as ProviderClient<"copilot">;
      try {
        await session.disconnect();
      } catch (e) {
        console.warn(
          `[cleanup] copilot session disconnect failed: ${errorMessage(e)}`,
        );
      }
      try {
        await client.stop();
      } catch (e) {
        console.warn(
          `[cleanup] copilot client stop failed: ${errorMessage(e)}`,
        );
      }
      break;
    }
    case "opencode":
      // Stateless HTTP client — no cleanup needed
      break;
    case "claude":
      // Headless Claude stages have no tmux pane to clear.
      if (!paneId.startsWith("headless-")) {
        try {
          await clearClaudeSession(paneId);
        } catch (e) {
          console.warn(
            `[cleanup] claude session clear failed: ${errorMessage(e)}`,
          );
        }
      }
      break;
    default:
      assertNever(agent);
  }
}

// ── §5.2.4 offload-wiring helper ─────────────────────────────────────────────

/**
 * Persist `metadata.json` to `sessionDir` then register the session with
 * the `OffloadManager`.
 *
 * Invariants (RFC §5.2.4):
 *  1. `Bun.write` resolves fully before `registerSession` is invoked.
 *  2. `registerSession` is awaited (not fire-and-forget).
 *  3. A rejected `registerSession` is swallowed with a `console.warn`; the
 *     caller continues normally (the pane still runs, resume is just unavailable).
 *
 * Exported for contract-testing only — production callers use
 * `createSessionRunner` which calls this function internally.
 */
export async function persistAndRegisterStage(
  sessionDir: string,
  metadata: {
    name: string;
    description: string;
    agent: AgentType;
    paneId: string;
    serverUrl: string;
    port: number;
    startedAt: string;
  },
  offloadManager: OffloadManager,
  registerInput: {
    name: string;
    runId: string;
    stageDir: string;
    agent: AgentType;
    agentSessionId: string;
    tmuxSession: string;
    tmuxWindow: string;
    spawnEnv: Record<string, string>;
    spawnCwd: string;
    chatFlags: string[];
    headless: boolean;
  },
): Promise<void> {
  await Bun.write(join(sessionDir, "metadata.json"), JSON.stringify(metadata, null, 2));
  try {
    await offloadManager.registerSession(registerInput);
  } catch (err) {
    console.warn(
      `[offload] registerSession failed for stage ${registerInput.name}: ${errorMessage(err)}`,
    );
  }
}

/**
 * Create a `ctx.stage()` function bound to a parent name for graph edges.
 *
 * Graph topology is auto-inferred from JavaScript's execution order:
 * - **Sequential** (`await`): the completed stage is in the frontier when the
 *   next stage spawns → parent-child edge.
 * - **Parallel** (`Promise.all`): both calls fire in the same synchronous
 *   frame → frontier is empty for the second call → sibling edges.
 * - **Fan-in**: after `Promise.all` resolves, all parallel stages are in the
 *   frontier → the next stage depends on all of them.
 *
 * The returned function manages the full session lifecycle:
 * spawn → init client/session → run callback → flush saves → cleanup → complete/error.
 */
function createSessionRunner(
  shared: SharedRunnerState,
  parentName: string,
): <T = void>(
  options: SessionRunOptions,
  clientOpts: StageClientOptions<AgentType>,
  sessionOpts: StageSessionOptions<AgentType>,
  run: (ctx: SessionContext) => Promise<T>,
) => Promise<SessionHandle<T>> {
  const graphTracker = new GraphFrontierTracker(parentName);

  return async <T = void>(
    options: SessionRunOptions,
    clientOpts: StageClientOptions<AgentType>,
    sessionOpts: StageSessionOptions<AgentType>,
    run: (ctx: SessionContext) => Promise<T>,
  ): Promise<SessionHandle<T>> => {
    const { name } = options;

    // ── 1. Validate name uniqueness (synchronous, before any await) ──
    if (!name || name.trim() === "") {
      throw new Error("Session name is required.");
    }
    if (
      shared.activeRegistry.has(name) ||
      shared.completedRegistry.has(name) ||
      shared.failedRegistry.has(name)
    ) {
      throw new Error(`Duplicate session name: "${name}"`);
    }

    const isHeadless = options.headless === true;

    // ── 2. Auto-infer graph parents from frontier (synchronous) ──
    // Headless stages are invisible in the graph — they must not consume or
    // update the frontier, otherwise the next visible stage gets orphaned
    // parent refs that don't exist in the panel.
    const graphParents = isHeadless ? [] : graphTracker.onSpawn();

    // ── 3. Create done promise so dependent sessions can await this one ──
    let resolveDone!: () => void;
    let rejectDone!: (err: unknown) => void;
    const donePromise = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    // Prevent "unhandled rejection" noise when no dependent awaits us.
    donePromise.catch(() => {});

    // ── 4. Register in active registry (synchronous) ──
    // Placeholder paneId — filled in after tmux window creation.
    shared.activeRegistry.set(name, { name, paneId: "", done: donePromise });

    const sessionId = generateId();
    let paneId = "";
    let panelSessionAdded = false;

    try {
      // ── 6. Build pane command (OS allocates port via --port 0) ──
      const { command: paneCmd, envVars: paneEnvVars, chatFlags: stageChatFlags } = buildPaneCommand(
        shared.agent,
        shared.providerOverrides,
        shared.extraChatFlags,
      );

      // ── 7. Create tmux window or headless execution ──
      let serverUrl: string;
      if (isHeadless) {
        // Headless stages use their SDKs directly — no tmux window.
        // Claude Agent SDK runs in-process; Copilot SDK spawns its own CLI;
        // OpenCode SDK starts both server and client via createOpencode().
        paneId = `headless-${name}-${sessionId}`;
        shared.activeRegistry.set(name, { name, paneId, done: donePromise });
        serverUrl = "";

        shared.panel.backgroundTaskStarted();
        panelSessionAdded = true;
      } else {
        // Standard tmux window for visible stages.
        paneId = tmux.createWindow(
          shared.tmuxSessionName,
          name,
          paneCmd,
          undefined,
          paneEnvVars,
        );
        shared.activeRegistry.set(name, { name, paneId, done: donePromise });

        spawnAttachedFooter(name, paneId, undefined, shared.tmuxSessionName);

        serverUrl = await waitForServer(shared.agent, paneId);

        shared.panel.addSession(name, graphParents);
        panelSessionAdded = true;
      }

      // ── 9. Create session directory ──
      const sessionDirName = `${name}-${sessionId}`;
      const sessionDir = join(shared.sessionsBaseDir, sessionDirName);
      await ensureDir(sessionDir);

      const messagesPath = join(sessionDir, "messages.json");
      const inboxPath = join(sessionDir, "inbox.md");

      // ── Message wrapping (Claude/Copilot/OpenCode) ──
      async function wrapMessages(
        arg: SessionEvent[] | SessionPromptResponse | string,
      ): Promise<SavedMessage[]> {
        if (typeof arg === "string") {
          // `arg` is the Claude session UUID — either `s.sessionId` from an
          // interactive `ClaudeSessionWrapper` (set at `createClaudeSession`
          // time) or the SDK-emitted `session_id` tracked inside
          // `HeadlessClaudeSessionWrapper.query`. Using it directly removes
          // the "pick the globally newest Claude session" heuristic that
          // misattributed transcripts across parallel branches.
          if (!arg) {
            throw new Error(
              "wrapMessages: empty Claude session id. Call s.save(s.sessionId) " +
                "only after a successful s.session.query() (headless wrappers " +
                "only know their session_id once a query completes).",
            );
          }
          const { getSessionMessages } =
            await import("@anthropic-ai/claude-agent-sdk");
          const msgs: SessionMessage[] = await getSessionMessages(arg, {
            dir: process.cwd(),
          });
          return msgs.map((m) => ({ provider: "claude" as const, data: m }));
        }

        if (!Array.isArray(arg) && "info" in arg && "parts" in arg) {
          return [
            {
              provider: "opencode" as const,
              data: arg as SessionPromptResponse,
            },
          ];
        }

        if (Array.isArray(arg)) {
          return (arg as SessionEvent[]).map((m) => ({
            provider: "copilot" as const,
            data: m,
          }));
        }

        return [];
      }

      // ── Save function ──
      const pendingSaves: Promise<void>[] = [];

      const save: SaveTranscript = ((
        arg: SessionEvent[] | SessionPromptResponse | string,
      ) => {
        const p = (async () => {
          const wrapped = await wrapMessages(arg);
          await Bun.write(messagesPath, JSON.stringify(wrapped, null, 2));
          const text = renderMessagesToText(wrapped);
          await Bun.write(inboxPath, text);
        })();
        pendingSaves.push(p);
        return p;
      }) as SaveTranscript;

      // ── Transcript/messages access (reads only from completedRegistry) ──
      const transcriptFn = createTranscriptReader(shared.completedRegistry);
      const getMessagesFn = createMessagesReader(shared.completedRegistry);

      // ── HIL (human-in-the-loop) callback ──
      // Unified callback passed to provider-specific HIL detection so that any
      // provider can signal when the agent is waiting for user input or has
      // resumed processing. Both `name` and `shared.panel` are guaranteed to
      // be in scope here: `name` is validated above and `shared.panel` is
      // always present on the shared runner state.
      const onHIL = (waiting: boolean) => {
        if (waiting) shared.panel.sessionAwaitingInput(name);
        else shared.panel.sessionResumed(name);
      };

      // ── 12. Auto-create provider client and session ──
      const {
        client: providerClient,
        session: providerSession,
        cleanup: providerCleanup,
      } = await initProviderClientAndSession(
        shared.agent,
        serverUrl,
        paneId,
        shared.projectRoot,
        clientOpts,
        sessionOpts,
        isHeadless,
        onHIL,
      );

      // ── 12a. Copilot: wrap send() to await session.idle ──
      // Copilot's send() is fire-and-forget — it returns immediately after
      // queuing the message. Without this wrapper, stage callbacks complete
      // before the agent finishes processing, causing getMessages() to
      // return incomplete data and the stage to be marked done prematurely.
      // We intercept send() to block until the session emits "session.idle",
      // matching the blocking behavior of Claude's query() and OpenCode's
      // session.prompt().
      //
      // Compatible with sendAndWait(): the SDK's _dispatchEvent broadcasts
      // to all handlers (typed + wildcard), so both this wrapper's listener
      // and sendAndWait's internal wildcard handler observe the same event.
      // Unsubscribe fn for the Copilot HIL event listeners; invoked in the
      // `finally` block so the handlers are removed when the stage ends.
      let hilUnsubscribe: (() => void) | undefined;
      let copilotElicitationUnsubscribe: (() => void) | undefined;

      if (shared.agent === "copilot") {
        const copilotSession = providerSession as ProviderSession<"copilot">;
        const nativeSend = copilotSession.send.bind(copilotSession);
        copilotSession.send = wrapCopilotSend(copilotSession, nativeSend);

        // Copilot HIL detection via native SDK events.
        //
        // `tool.execution_start` / `tool.execution_complete` fire for the
        // `ask_user` built-in tool regardless of whether `onUserInputRequest`
        // is registered, so we can detect HIL via the SDK's event stream and
        // still let the CLI render its native tmux-pane dialog.
        hilUnsubscribe = watchCopilotSessionForHIL(copilotSession, onHIL);

        // Copilot elicitation HIL detection via native SDK events.
        //
        // `elicitation.requested` / `elicitation.completed` fire when the
        // agent calls `session.ui.elicitation()`, `session.ui.select()`,
        // `session.ui.input()`, or an MCP server issues an elicitation
        // request.  These events are distinct from the `ask_user` tool and
        // require a separate watcher so the UI can show the "waiting for
        // response" indicator in all HIL scenarios.
        copilotElicitationUnsubscribe = watchCopilotSessionForElicitation(
          copilotSession,
          onHIL,
        );
      }

      // ── 12b. OpenCode: SSE event stream for HIL detection ──
      //
      // `client.event.subscribe()` yields `question.asked`, `question.replied`,
      // and `question.rejected` events in real time.  The subscription is
      // **awaited** before the stage callback runs so the stream is guaranteed
      // to be open when the first prompt fires.
      if (shared.agent === "opencode") {
        const ocClient = providerClient as ProviderClient<"opencode">;
        const ocSession = providerSession as ProviderSession<"opencode">;
        const ocSessionId = ocSession.id;

        try {
          const { stream } = await ocClient.event.subscribe();
          watchOpencodeStreamForHIL(stream, ocSessionId, onHIL).catch((err) => {
            console.warn(
              `[opencode] HIL event stream disconnected for session ${ocSessionId}: ${errorMessage(err)}`,
            );
          });
        } catch (err) {
          console.warn(
            `[opencode] HIL event stream failed to subscribe for session ${ocSessionId}: ${errorMessage(err)}`,
          );
        }
      }

      // ── 13. Construct SessionContext ──
      // Free-form workflows read their prompt via `s.inputs.prompt`;
      // structured workflows read their declared fields the same way.
      // A single uniform access pattern means workflow code never has
      // to branch on "is this workflow structured or free-form".
      //
      // `s.sessionId` is the provider-specific session identifier — the
      // Claude session UUID, the Copilot session id, or the OpenCode
      // session id. This is what workflows pass to `s.save(s.sessionId)`
      // to disambiguate their own transcript when several sessions run
      // in parallel under the same workflow.
      //
      // Exposed as a getter (not a snapshot) because headless Claude stages
      // don't know their SDK-assigned `session_id` until the first `query()`
      // completes — `HeadlessClaudeSessionWrapper._lastSessionId` starts empty
      // and is populated when the SDK emits a `result` event. A snapshot
      // captured at stage creation would leave `s.sessionId === ""` forever,
      // so `s.save(s.sessionId)` would always throw "empty Claude session id"
      // even though the query completed successfully.
      const ctx: SessionContext = {
        client: providerClient,
        session: providerSession,
        inputs: shared.inputs as SessionContext["inputs"],
        agent: shared.agent,
        sessionDir,
        paneId,
        get sessionId() {
          return resolveProviderSessionId(shared.agent, providerSession);
        },
        save,
        transcript: transcriptFn,
        getMessages: getMessagesFn,
        stage: createSessionRunner(shared, name) as SessionContext["stage"],
      };

      // ── Write session metadata + register with OffloadManager (RFC §5.2.4) ──
      // persistAndRegisterStage guarantees Bun.write completes before
      // registerSession is called, registerSession is awaited, and a rejection
      // is swallowed with console.warn so the stage continues regardless.
      await persistAndRegisterStage(
        sessionDir,
        {
          name,
          description: options.description ?? "",
          agent: shared.agent,
          paneId,
          serverUrl,
          port: serverUrl ? Number(serverUrl.split(":").pop()) : 0,
          startedAt: new Date().toISOString(),
        },
        shared.offloadManager,
        {
          name,
          runId: shared.workflowRunId,
          stageDir: sessionDir,
          agent: shared.agent,
          agentSessionId: resolveProviderSessionId(shared.agent, providerSession),
          tmuxSession: shared.tmuxSessionName,
          tmuxWindow: name,
          spawnEnv: paneEnvVars,
          spawnCwd: shared.projectRoot,
          chatFlags: stageChatFlags,
          headless: isHeadless,
        },
      );

      // ── 14. Run user callback ──
      let callbackResult: T;
      try {
        callbackResult = await run(ctx);
        if (pendingSaves.length > 0) await Promise.all(pendingSaves);
      } catch (error) {
        const message = errorMessage(error);
        await Bun.write(join(sessionDir, "error.txt"), message).catch(() => {});
        if (!isHeadless) shared.panel.sessionError(name, message);
        throw error;
      } finally {
        // ── 14a. Stop background HIL watcher (if any) ──
        hilUnsubscribe?.();
        copilotElicitationUnsubscribe?.();

        // ── 14b. Auto-cleanup provider resources ──
        await cleanupProvider(
          shared.agent,
          providerClient,
          providerSession,
          paneId,
        );
        if (providerCleanup) {
          try {
            providerCleanup();
          } catch {}
        }
      }

      // ── 15. Mark session complete ──
      if (isHeadless) {
        shared.panel.backgroundTaskFinished();
      } else {
        shared.panel.sessionSuccess(name);
      }
      const result: SessionResult = { name, sessionId, sessionDir, paneId };
      shared.completedRegistry.set(name, result);
      shared.activeRegistry.delete(name);
      resolveDone();

      // Update frontier so the next stage in this scope chains from us.
      // Headless stages are transparent — they don't touch the frontier.
      if (!isHeadless) graphTracker.onSettle(name);
      return { name, id: sessionId, result: callbackResult! };
    } catch (error) {
      const message = errorMessage(error);
      if (panelSessionAdded) {
        if (isHeadless) {
          shared.panel.backgroundTaskFinished();
        } else {
          shared.panel.sessionError(name, message);
        }
      }
      // Kill the tmux window if one was created (visible stages and headless OpenCode).
      // Headless Claude/Copilot have virtual paneIds ("headless-...") — no window to kill.
      if (paneId && !paneId.startsWith("headless-")) {
        await loggedKillWindow(shared.tmuxSessionName, name, "stage-error");
      }
      // Ensure the done promise settles and the active entry is cleared.
      shared.activeRegistry.delete(name);
      shared.failedRegistry.add(name);
      rejectDone(error);
      // Update frontier even on failure — if the caller catches and
      // continues, the next stage should still chain from this one.
      // Headless stages are transparent — they don't touch the frontier.
      if (!isHeadless) graphTracker.onSettle(name);
      throw error;
    }
  };
}

// ============================================================================
// Orchestrator logic — runs inside a tmux pane
// ============================================================================

export { validateOrchestratorEnv } from "./executor-env.ts";
import { validateOrchestratorEnv } from "./executor-env.ts";

/**
 * Run the orchestrator for a compiled workflow definition.
 *
 * Called by the SDK's `orchestrator-entry.ts` after it has resolved the
 * workflow definition (either via builtin-registry lookup in compiled-
 * binary mode, or by dynamic-importing `source` in dev) and decoded the
 * inputs payload from argv. The runtime environment (`ATOMIC_WF_ID`,
 * `ATOMIC_WF_TMUX`, `ATOMIC_WF_AGENT`, `ATOMIC_WF_CWD`) is set by the
 * launcher script that `executeWorkflow()` writes — those vars describe
 * *where* this orchestrator is running, not what to do.
 */
export async function runOrchestrator(
  definition: WorkflowDefinition,
  inputs: Record<string, string> = {},
): Promise<void> {
  const { workflowRunId, tmuxSessionName, agent, cwd } =
    validateOrchestratorEnv();

  // RFC §5.11 — register the real telemetry sink so all WORKFLOW_OFFLOAD_*
  // events reach disk at ~/.atomic/sessions/<runId>/telemetry.jsonl. Tests
  // override via setExecutorTelemetrySinks before runOrchestrator is invoked.
  // `warn` keeps its default (console.warn) — no override needed here.
  setExecutorTelemetrySinks({
    telemetry: getProductionTelemetrySink(workflowRunId),
  });

  // A bare prompt string is still useful for the panel header and the
  // session-dir metadata.json — both just want something displayable.
  // Free-form workflows store their single positional prompt under the
  // `prompt` key so workflow authors always read it via
  // `ctx.inputs.prompt`.
  const prompt = inputs.prompt ?? "";

  process.chdir(cwd);

  const providerOverrides = await getProviderOverrides(agent, cwd);
  const extraChatFlags =
    agent === "copilot" ? await getCopilotScmDisableFlags(cwd) : [];
  const sessionsBaseDir = join(getSessionsBaseDir(), workflowRunId);
  await ensureDir(sessionsBaseDir);

  const panel = await OrchestratorPanel.create({
    tmuxSession: tmuxSessionName,
  });

  // Mirror panel-store mutations to <sessionDir>/status.json so
  // out-of-process consumers (e.g. `atomic workflow status`) can read
  // the live workflow state without IPC into the orchestrator.
  // Writes are debounced via a "pending" flag so a burst of mutations
  // collapses into a single file write.
  let snapshotPending = false;
  const persistSnapshot = (): void => {
    if (snapshotPending) return;
    snapshotPending = true;
    queueMicrotask(() => {
      snapshotPending = false;
      const snap = panel.getSnapshot();
      void writeSnapshot(
        sessionsBaseDir,
        buildSnapshot({
          workflowRunId,
          tmuxSession: tmuxSessionName,
          ...snap,
        }),
      );
    });
  };
  const unsubscribePanel = panel.subscribe(persistSnapshot);
  // Seed an initial snapshot so the file exists before any session starts.
  persistSnapshot();

  // Idempotent shutdown guard
  let shutdownCalled = false;
  const shutdown = (exitCode = 0) => {
    if (shutdownCalled) return;
    shutdownCalled = true;
    unsubscribePanel();
    // Final snapshot reflecting terminal state (completed/error/aborted).
    void writeSnapshot(
      sessionsBaseDir,
      buildSnapshot({
        workflowRunId,
        tmuxSession: tmuxSessionName,
        ...panel.getSnapshot(),
      }),
    );
    panel.destroy();
    try {
      tmux.killSession(tmuxSessionName);
    } catch {}
    process.exitCode = exitCode;
  };

  // Wire SIGINT so the terminal is always restored.
  // SIGTERM and other signals are handled by OpenTUI's exitSignals.
  const signalHandler = () => shutdown(1);
  process.on("SIGINT", signalHandler);

  // Build OffloadManager with live panel store and tmux/provider deps.
  const offloadManager = createOffloadManager({
    panelStore: panel.getPanelStore(),
    tmux: {
      killWindow: tmux.killWindow,
      createWindow: async (session, window, command, cwd, envVars) => {
        tmux.createWindow(session, window, command, cwd, envVars);
      },
      selectWindow: async (session, window) => {
        tmux.selectWindow(`${session}:${window}`);
      },
    },
    providers: {
      claude: { buildResumeArgs: buildClaudeResumeArgs },
      opencode: { buildResumeArgs: buildOpencodeResumeArgs },
      copilot: { buildResumeArgs: buildCopilotResumeArgs },
    },
    hookSettingsPath: ensureWorkflowHookSettings,
    shellQuote,
    waitForReady: defaultWaitForAgentReady,
    now: Date.now,
    emit: (event, payload) => _telemetrySink.emit(event, payload),
    claudeOffloadCleanup,
  });

  // RFC §5.6 — wire the offload manager into the panel so the React tree's
  // OffloadManagerContext.Provider is non-null before any stage renders.
  panel.attachOffloadManager(offloadManager);

  // Shared state for all session runners
  const shared: SharedRunnerState = {
    tmuxSessionName,
    sessionsBaseDir,
    projectRoot: cwd,
    agent,
    inputs,
    providerOverrides,
    extraChatFlags,
    panel,
    activeRegistry: new Map(),
    completedRegistry: new Map(),
    failedRegistry: new Set(),
    offloadManager,
    workflowRunId,
  };

  try {
    // Parse integer inputs to numbers so `ctx.inputs.<name>` matches the
    // declared type. Mutate shared.inputs so per-stage SessionContexts see
    // the same shape.
    shared.inputs = coerceInputsBySchema(inputs, definition.inputs);

    await Bun.write(
      join(sessionsBaseDir, "metadata.json"),
      JSON.stringify(
        {
          workflowName: definition.name,
          agent,
          prompt,
          projectRoot: cwd,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    // Initialize panel with just the orchestrator node (sessions added dynamically)
    panel.showWorkflowInfo(definition.name, agent, [], prompt);

    // Build the WorkflowContext — top-level context for the .run() callback
    const sessionRunner = createSessionRunner(shared, "orchestrator");

    const workflowCtx: WorkflowContext = {
      inputs: shared.inputs as WorkflowContext["inputs"],
      agent,
      stage: sessionRunner as WorkflowContext["stage"],
      transcript: createTranscriptReader(shared.completedRegistry),
      getMessages: createMessagesReader(shared.completedRegistry),
    };

    // Run the workflow, racing against user abort (q / Ctrl+C)
    const abortPromise = panel.waitForAbort().then(() => {
      throw new WorkflowAbortError();
    });
    await Promise.race([definition.run(workflowCtx), abortPromise]);

    // Notify OffloadManager that all stages have completed (RFC §5.11). Wrap
    // to keep an offload failure from halting orchestrator teardown.
    try {
      await shared.offloadManager.onWorkflowCompletion();
    } catch (err) {
      console.warn(`offload onWorkflowCompletion failed: ${errorMessage(err)}`);
    }

    panel.showCompletion(definition.name, sessionsBaseDir);
    await panel.waitForExit();
    shutdown(0);
  } catch (error) {
    // Kill any active tmux windows that didn't complete.
    // Headless Claude/Copilot have virtual paneIds ("headless-...") — their
    // SDK-managed processes are cleaned up by cleanupProvider().
    for (const [, active] of shared.activeRegistry) {
      if (active.paneId && !active.paneId.startsWith("headless-")) {
        await loggedKillWindow(tmuxSessionName, active.name, "abort-cleanup");
      }
    }

    if (error instanceof WorkflowAbortError) {
      shutdown(0);
    } else {
      const message = errorMessage(error);
      try {
        panel.showFatalError(message);
        await panel.waitForExit();
      } catch {}
      shutdown(1);
    }
  } finally {
    process.off("SIGINT", signalHandler);
  }
}
