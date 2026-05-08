/**
 * OffloadManager — workflow pane offload & resume state machine.
 * Spec: specs/2026-05-08-workflow-pane-offload-and-resume.md §5.2
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { OffloadResumeMetadata, MetadataJsonWithResume, AgentKind } from "./offload-types.ts";
import type { SessionData } from "../components/orchestrator-panel-types.ts";
import { claudeOffloadCleanup as _realClaudeOffloadCleanup } from "../providers/claude.ts";
import type { ClaudeMarkerCleanupResult } from "../providers/claude.ts";

// Telemetry event-name constants — kept in sync with
// packages/atomic/src/lib/telemetry/offload-events.ts (avoids cross-package dep).
const WORKFLOW_OFFLOAD_SCHEDULED = "workflow.offload.scheduled" as const;
const WORKFLOW_OFFLOAD_COMPLETED = "workflow.offload.completed" as const;
const WORKFLOW_OFFLOAD_RESUME_ATTEMPTED = "workflow.offload.resume.attempted" as const;
const WORKFLOW_OFFLOAD_RESUME_SUCCEEDED = "workflow.offload.resume.succeeded" as const;
const WORKFLOW_OFFLOAD_RESUME_FAILED = "workflow.offload.resume.failed" as const;
const WORKFLOW_OFFLOAD_REGISTER_PERSISTED = "workflow.offload.register.persisted" as const;
const WORKFLOW_OFFLOAD_RESUME_ROLLBACK_FAILED = "workflow.offload.resume.rollback_failed" as const;
const WORKFLOW_OFFLOAD_CLAUDE_MARKER_CLEANUP = "workflow.offload.claude_marker_cleanup" as const;

// ─── filterSpawnEnv ─────────────────────────────────────────────────────────

const SPAWN_ENV_EXACT_ALLOW: ReadonlySet<string> = new Set([
  "CLAUDECODE",
  "PATH",
  "HOME",
  "LANG",
  "SHELL",
]);
const SPAWN_ENV_PREFIX_ALLOW: readonly string[] = ["ATOMIC_", "LC_", "OPENCODE_", "COPILOT_"];
const SPAWN_ENV_EXACT_DENY: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
]);
const SPAWN_ENV_SUFFIX_DENY = /_(API_KEY|AUTH_TOKEN|SECRET|TOKEN|PASSWORD)$/i;

/**
 * Allowlist filter applied to `spawnEnv` before persisting to disk.
 *
 * The in-memory spawnEnv (used for actual tmux exec) retains ALL keys so
 * tokens stripped from disk are re-injected at resume time (RFC §7.1).
 */
export function filterSpawnEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (SPAWN_ENV_EXACT_DENY.has(key) || SPAWN_ENV_SUFFIX_DENY.test(key)) continue;
    if (SPAWN_ENV_EXACT_ALLOW.has(key) || SPAWN_ENV_PREFIX_ALLOW.some((p) => key.startsWith(p))) {
      result[key] = value;
    }
  }
  return result;
}

// ─── persistResume ──────────────────────────────────────────────────────────

/**
 * Per-stageDir mutex map.  Each entry holds the tail of the promise chain
 * for that stage; a new call appends onto the tail so concurrent writers
 * for the same stage serialize.
 */
const _stageMutex = new Map<string, Promise<void>>();

/** Defaults applied when the metadata has no `resume` block yet. */
const _resumeDefaults: Omit<OffloadResumeMetadata, "schemaVersion"> = {
  agentSessionId: "",
  tmuxSessionName: "",
  tmuxWindowName: "",
  spawnEnv: {},
  spawnCwd: "",
  chatFlags: [],
  lastPrompt: "",
  lastSeenAt: 0,
  offloadedAt: null,
};

/**
 * True iff `value` is a v1 `OffloadResumeMetadata` plain object.
 * Used by both `_doPersist` (to gate writes) and `doResume` (to gate spawn).
 */
function isValidResumeBlock(value: unknown): value is OffloadResumeMetadata {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1
  );
}

/**
 * Extract a useful `schemaVersion` value for the schema-mismatch error message.
 * For non-object inputs, returns the value itself so the operator sees `null`,
 * `42`, etc. instead of `undefined`.
 */
function describeInvalidResumeBlock(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return (value as { schemaVersion?: unknown }).schemaVersion;
  }
  return value;
}

/**
 * Atomically read-modify-write the `resume` sub-object of
 * `${stageDir}/metadata.json` under a per-stageDir in-process mutex.
 *
 * Guarantees:
 * - Concurrent calls for the same `stageDir` are serialized.
 * - Top-level immutable fields (`name`, `description`, `agent`, `paneId`,
 *   `serverUrl`, `port`, `startedAt`) are written back verbatim.
 * - `patch` fields always win; other existing `resume` fields are retained.
 * - File is written atomically via a `.tmp` rename and mode 0o600.
 *
 * @throws Error("metadata.json not found at <path>") if the file is missing.
 * @throws Error("unsupported resume schemaVersion: <n>") if existing
 *   `resume.schemaVersion` is not 1.
 */
export async function persistResume(
  stageDir: string,
  patch: Partial<OffloadResumeMetadata>,
): Promise<void> {
  const metaPath = join(stageDir, "metadata.json");

  // Mutex-order writes via tail-chaining. `.catch` isolates each link from
  // the previous link's outcome so a queued caller's failure doesn't poison
  // the chain (each call still observes its own outcome via `next`).
  const prev = _stageMutex.get(stageDir) ?? Promise.resolve();
  const next: Promise<void> = prev
    .catch(() => undefined)
    .then(() => _doPersist(metaPath, patch));

  // Register the new tail synchronously so callers arriving after this point
  // append correctly. The trailing `.catch` swallows the cleanup chain's
  // mirrored rejection — the caller still observes failure via `next`.
  _stageMutex.set(stageDir, next);
  next
    .finally(() => {
      if (_stageMutex.get(stageDir) === next) _stageMutex.delete(stageDir);
    })
    .catch(() => {});

  return next;
}

async function _doPersist(
  metaPath: string,
  patch: Partial<OffloadResumeMetadata>,
): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(metaPath, "utf8");
  } catch {
    throw new Error(`metadata.json not found at ${metaPath}`);
  }

  const existing = JSON.parse(raw) as MetadataJsonWithResume;

  // The `resume` slot must be either absent or a v1 plain object. Anything
  // else (null, primitive, array, foreign schemaVersion) is a schema mismatch.
  if (existing.resume !== undefined && !isValidResumeBlock(existing.resume)) {
    throw new Error(
      `unsupported resume schemaVersion: ${describeInvalidResumeBlock(existing.resume)}`,
    );
  }

  // Merge precedence: defaults < existing.resume < patch; schemaVersion
  // always pinned to 1. Spreading `undefined` is a JS no-op.
  const nextResume: OffloadResumeMetadata = {
    ..._resumeDefaults,
    ...existing.resume,
    ...patch,
    schemaVersion: 1,
  };

  // Top-level fields (immutable per write-once contract) echoed verbatim;
  // only `resume` mutates.
  const nextMeta: MetadataJsonWithResume = {
    name: existing.name,
    description: existing.description,
    agent: existing.agent,
    paneId: existing.paneId,
    serverUrl: existing.serverUrl,
    port: existing.port,
    startedAt: existing.startedAt,
    resume: nextResume,
  };

  // Atomic write: 0o600 tmp file + rename over the destination.
  const tmpPath = `${metaPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(nextMeta, null, 2), {
    mode: 0o600,
    encoding: "utf8",
  });
  await fs.rename(tmpPath, metaPath);
}

// ─── Public interfaces ──────────────────────────────────────────────────────

export interface OffloadManager {
  registerSession(input: {
    name: string;
    runId: string;
    stageDir: string;
    agent: AgentKind;
    agentSessionId: string;
    tmuxSession: string;
    tmuxWindow: string;
    spawnEnv: Record<string, string>;
    spawnCwd: string;
    lastPrompt?: string;
    headless: boolean;
    /** Effective merged chatFlags used at original spawn time. Persisted into the resume block. */
    chatFlags: string[];
  }): Promise<void>;
  onWorkflowCompletion(): Promise<void>;
  requestResume(name: string): Promise<void>;
  getStatus(name: string): "alive" | "offloaded" | "resuming";
}

export interface OffloadManagerDeps {
  panelStore: {
    /** Live array reference — caller must not mutate. */
    readonly sessions: readonly SessionData[];
    /** Empty-string sentinel for "no agent attached" — never null. */
    readonly activeAgentId: string;
    setSessionStatus(name: string, status: SessionData["status"]): void;
  };
  tmux: {
    killWindow(session: string, window: string): Promise<void>;
    createWindow(
      session: string,
      window: string,
      command: string,
      cwd: string,
      envVars: Record<string, string>,
    ): Promise<void>;
    selectWindow(session: string, window: string): Promise<void>;
  };
  providers: {
    claude: {
      buildResumeArgs(
        meta: Pick<OffloadResumeMetadata, "agentSessionId" | "chatFlags">,
        hookSettingsPath: string,
      ): string[];
    };
    opencode: {
      buildResumeArgs(
        meta: Pick<OffloadResumeMetadata, "agentSessionId" | "chatFlags">,
      ): string[];
    };
    copilot: {
      buildResumeArgs(
        meta: Pick<OffloadResumeMetadata, "agentSessionId" | "chatFlags">,
      ): string[];
    };
  };
  /** Resolve Claude hook-settings path lazily; only called on Claude resume. */
  hookSettingsPath(): string;
  /**
   * Join agent binary + argv into a single shell command string for
   * `tmux new-window`. Each arg is single-quoted with embedded single-quotes
   * escaped via `'\''` (RFC §9 Q12). Exposed on deps for testability.
   */
  shellQuote(argv: readonly string[]): string;
  /**
   * Wait for the agent process to signal readiness post-resume.
   * The default production impl polls a per-agent marker (Claude:
   * `~/.atomic/claude-ready/<id>`; OpenCode/Copilot: SDK probes).
   * Tests pass an immediate-resolve mock to bypass real I/O.
   * Implementations own their own timeout policy.
   */
  waitForReady(agent: AgentKind, agentSessionId: string, paneId: string): Promise<void>;
  now(): number;
  /** Telemetry sink — `event` is one of WORKFLOW_OFFLOAD_* constants. */
  emit(event: string, payload: Record<string, unknown>): void;
  /**
   * Best-effort cleanup of Claude per-session marker files after offload.
   * Optional — defaults to the real `claudeOffloadCleanup` from providers/claude.ts.
   * Tests inject a mock to avoid real filesystem I/O.
   */
  claudeOffloadCleanup?: (agentSessionId: string) => Promise<ClaudeMarkerCleanupResult>;
}

// ─── Internal state ─────────────────────────────────────────────────────────

type SessionState = "alive" | "offloaded" | "resuming";

interface RegisteredSession {
  name: string;
  runId: string;
  stageDir: string;
  agent: AgentKind;
  agentSessionId: string;
  tmuxSession: string;
  tmuxWindow: string;
  spawnEnv: Record<string, string>;
  spawnCwd: string;
  lastPrompt: string;
  headless: boolean;
  chatFlags: string[];
  state: SessionState;
}

// ─── Idempotency primitive ──────────────────────────────────────────────────

/**
 * Idempotency primitive: if an operation is already running for `name` in
 * `queue`, return the same Promise. Otherwise start a new one, register it,
 * and clear it from the map when it settles (success or failure).
 *
 * Exported as `_testOnlyGetOrStartOp` for unit testing only. Production
 * callers use the instance-level wrapper returned by `createOffloadManager`.
 */
export function _testOnlyGetOrStartOp(
  name: string,
  op: () => Promise<void>,
  queue: Map<string, Promise<void>>,
): Promise<void> {
  const existing = queue.get(name);
  if (existing !== undefined) return existing;

  const promise = op().finally(() => {
    if (queue.get(name) === promise) queue.delete(name);
  });
  queue.set(name, promise);
  return promise;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Build the `[binary, ...argv]` for an agent resume command.
 * Returned argv is fed straight to `deps.shellQuote` and then to
 * `deps.tmux.createWindow` — the binary is execed directly, no shell.
 */
function buildResumeCommand(
  sess: RegisteredSession,
  deps: OffloadManagerDeps,
  meta: Pick<OffloadResumeMetadata, "agentSessionId" | "chatFlags">,
): string[] {
  switch (sess.agent) {
    case "claude":
      return ["claude", ...deps.providers.claude.buildResumeArgs(meta, deps.hookSettingsPath())];
    case "opencode":
      return ["opencode", ...deps.providers.opencode.buildResumeArgs(meta)];
    case "copilot":
      return ["copilot", ...deps.providers.copilot.buildResumeArgs(meta)];
    default:
      throw new Error(`unsupported agent kind: ${sess.agent as string}`);
  }
}

export function createOffloadManager(deps: OffloadManagerDeps): OffloadManager {
  const sessions = new Map<string, RegisteredSession>();
  // Per-pane operation queue scoped to this manager so concurrent test
  // instances do not share state.
  const opQueue = new Map<string, Promise<void>>();

  function getOrStartOp(name: string, op: () => Promise<void>): Promise<void> {
    return _testOnlyGetOrStartOp(name, op, opQueue);
  }

  /** Offload a single registered session. */
  async function killOnePane(sess: RegisteredSession): Promise<void> {
    const ts = deps.now();
    // Patch is ONLY timestamps — snapshot fields already on disk from registerSession.
    await persistResume(sess.stageDir, { offloadedAt: ts, lastSeenAt: ts });

    // RFC §5.4: claude-specific marker cleanup before killing the window.
    if (sess.agent === "claude") {
      const cleanupFn = deps.claudeOffloadCleanup ?? _realClaudeOffloadCleanup;
      try {
        const { readyCleared, stopCleared, pidCleared, inflightCleared, failures } =
          await cleanupFn(sess.agentSessionId);
        deps.emit(WORKFLOW_OFFLOAD_CLAUDE_MARKER_CLEANUP, {
          runId: sess.runId,
          name: sess.name,
          agentSessionId: sess.agentSessionId,
          readyCleared,
          stopCleared,
          pidCleared,
          inflightCleared,
          failures,
        });
      } catch {
        // Cleanup must never abort kill — errors are swallowed.
      }
    }

    await deps.tmux.killWindow(sess.tmuxSession, sess.tmuxWindow);
    deps.panelStore.setSessionStatus(sess.name, "offloaded");
    sess.state = "offloaded";
    deps.emit(WORKFLOW_OFFLOAD_COMPLETED, {
      runId: sess.runId,
      name: sess.name,
      agent: sess.agent,
    });
  }

  /** True iff `sess` is eligible for offload right now. */
  function isEligibleForOffload(sess: RegisteredSession): boolean {
    if (sess.headless) return false;
    const { activeAgentId } = deps.panelStore;
    if (activeAgentId !== "" && activeAgentId === sess.name) return false;
    const panelEntry = deps.panelStore.sessions.find((s) => s.name === sess.name);
    return panelEntry?.status === "complete";
  }

  /** Re-spawn an offloaded session (RFC §5.2.3). */
  async function doResume(sess: RegisteredSession): Promise<void> {
    const startMs = deps.now();
    const baseEvent = { runId: sess.runId, name: sess.name, agent: sess.agent };
    sess.state = "resuming";
    deps.panelStore.setSessionStatus(sess.name, "resuming");
    deps.emit(WORKFLOW_OFFLOAD_RESUME_ATTEMPTED, baseEvent);

    let windowCreated = false;

    try {
      // (a) Read + validate metadata.
      const metaPath = join(sess.stageDir, "metadata.json");
      const parsed = JSON.parse(await fs.readFile(metaPath, "utf8")) as MetadataJsonWithResume;
      if (!isValidResumeBlock(parsed.resume)) throw new Error("SCHEMA_MISMATCH");
      const meta = {
        agentSessionId: parsed.resume.agentSessionId,
        chatFlags: parsed.resume.chatFlags,
      };

      // (b)/(c) Build the command and quote for tmux.
      const cmd = deps.shellQuote(buildResumeCommand(sess, deps, meta));

      // (d) Recreate the tmux window with the resume command and unfiltered
      // in-memory spawnEnv (tokens re-injected from memory, not from disk).
      await deps.tmux.createWindow(
        sess.tmuxSession,
        sess.tmuxWindow,
        cmd,
        sess.spawnCwd,
        sess.spawnEnv,
      );
      windowCreated = true;

      // (e) Wait for agent readiness — impl owns its own timeout.
      // paneId is the tmux target "session:window" used by waitForServer
      // to resolve the agent's PID and discover its listening port.
      const paneId = `${sess.tmuxSession}:${sess.tmuxWindow}`;
      await deps.waitForReady(sess.agent, meta.agentSessionId, paneId);

      // (f) Only after readiness: switch focus.
      await deps.tmux.selectWindow(sess.tmuxSession, sess.tmuxWindow);

      // (g) Success.
      sess.state = "alive";
      deps.panelStore.setSessionStatus(sess.name, "complete");
      deps.emit(WORKFLOW_OFFLOAD_RESUME_SUCCEEDED, {
        ...baseEvent,
        latencyMs: deps.now() - startMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errorCode =
        msg === "SCHEMA_MISMATCH" ? "SCHEMA_MISMATCH" :
        msg.startsWith("RESUME_TIMEOUT_") ? "RESUME_TIMEOUT" :
        "RESUME_FAILED";

      // Best-effort tmux rollback: kill the newly-created window if it exists.
      if (windowCreated) {
        try {
          await deps.tmux.killWindow(sess.tmuxSession, sess.tmuxWindow);
        } catch (rollbackErr) {
          deps.emit(WORKFLOW_OFFLOAD_RESUME_ROLLBACK_FAILED, {
            ...baseEvent,
            error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          });
        }
      }

      // Best-effort error persistence — never mask the original failure.
      try {
        await persistResume(sess.stageDir, { error: msg });
      } catch {}

      sess.state = "offloaded";
      deps.panelStore.setSessionStatus(sess.name, "offloaded");
      deps.emit(WORKFLOW_OFFLOAD_RESUME_FAILED, { ...baseEvent, errorCode, error: msg });
      throw err;
    }
  }

  return {
    async registerSession(input): Promise<void> {
      const lastPrompt = input.lastPrompt ?? "";
      sessions.set(input.name, { ...input, lastPrompt, state: "alive" });

      // Headless sessions: register in-memory only — skip disk write.
      if (input.headless) return;

      // Seed snapshot to disk. Use the op queue under a register-specific key
      // so killOnePane (keyed by `name`) does not collide here, but per-stageDir
      // mutex inside persistResume still serializes the actual disk writes.
      await getOrStartOp(`register:${input.name}`, async () => {
        await persistResume(input.stageDir, {
          agentSessionId: input.agentSessionId,
          tmuxSessionName: input.tmuxSession,
          tmuxWindowName: input.tmuxWindow,
          spawnEnv: filterSpawnEnv(input.spawnEnv),
          spawnCwd: input.spawnCwd,
          chatFlags: input.chatFlags,
          lastPrompt,
          lastSeenAt: deps.now(),
          offloadedAt: null,
        });
        deps.emit(WORKFLOW_OFFLOAD_REGISTER_PERSISTED, {
          runId: input.runId,
          name: input.name,
          agent: input.agent,
        });
      });
    },

    getStatus(name) {
      return sessions.get(name)?.state ?? "alive";
    },

    async onWorkflowCompletion(): Promise<void> {
      const eligible = Array.from(sessions.values()).filter(isEligibleForOffload);

      deps.emit(WORKFLOW_OFFLOAD_SCHEDULED, {
        runId: eligible[0]?.runId ?? "",
        count: eligible.length,
      });

      await Promise.all(
        eligible.map((sess) => getOrStartOp(sess.name, () => killOnePane(sess))),
      );
    },

    async requestResume(name: string): Promise<void> {
      const sess = sessions.get(name);
      if (!sess || sess.state === "alive") return;
      // "offloaded" → start resume; "resuming" → coalesce onto in-flight op.
      const op = sess.state === "offloaded" ? () => doResume(sess) : () => Promise.resolve();
      return getOrStartOp(name, op);
    },
  };
}
