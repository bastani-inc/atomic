/**
 * Workflow runtime executor.
 *
 * This module contains the pre-daemon executor utilities that still back a
 * few provider tests and telemetry helpers. Public workflow dispatch now goes
 * through the daemon JSON-RPC surface (`workflow/start`) instead of hidden argv
 * subcommands or SDK self-dispatch.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { writeFile, stat as fsStat } from "node:fs/promises";
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
import { buildLauncherEnv, buildTmuxEnv } from "../lib/terminal-env.ts";
import {
  getListeningPortForPid,
  PORT_DISCOVERY_TIMEOUT_MS,
} from "./port-discovery.ts";
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
import {
  wrapCopilotSend,
  watchCopilotSessionForElicitation,
  watchCopilotSessionForHIL,
  watchOpencodeStreamForHIL,
} from "./hil-watchers.ts";
export type {
  CopilotHILSessionSurface,
  CopilotSendSessionSurface,
  OpenCodeHILEvent,
} from "./hil-watchers.ts";

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
/** Exported for unit testing only. Not part of the public API. */
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
  /** Optional override for the Atomic executable used by legacy executor callers. */
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

export async function waitForServer(agent: AgentType, paneId: string): Promise<string> {
  if (agent === "claude") return "";
  void paneId;
  throw new Error("not implemented: use daemon path");
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

// Re-export provider HIL helpers from the legacy executor module for tests and
// external callers that imported them here before the daemon split.
export {
  wrapCopilotSend,
  watchCopilotSessionForElicitation,
  watchCopilotSessionForHIL,
  watchOpencodeStreamForHIL,
} from "./hil-watchers.ts";

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
        // Standard tmux window for visible stages — not implemented in daemon path.
        // Non-headless stages are handled by the daemon UI server.
        serverUrl = "";
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
        // Per-stage offload: kill the tmux pane + agent CLI as soon as the
        // stage callback resolves. Without this, idle agent CLIs from earlier
        // stages accumulate memory until the entire workflow finishes.
        // Wrapped so an offload failure can't block stage cleanup.
        try {
          await shared.offloadManager.offloadSession(name);
        } catch (err) {
          console.warn(`[offload] offloadSession failed for ${name}: ${errorMessage(err)}`);
        }
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

export { validateOrchestratorEnv } from "./executor-env.ts";
