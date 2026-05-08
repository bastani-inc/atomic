/**
 * OffloadManager — workflow pane offload & resume state machine.
 *
 * Spec: specs/2026-05-08-workflow-pane-offload-and-resume.md §5.2
 *
 * persistResume (task #10) is intentionally co-located in this file.
 * Tasks #2 and #13 will fill the bodies of onWorkflowCompletion and
 * requestResume respectively.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { OffloadResumeMetadata, MetadataJsonWithResume, AgentKind } from "./offload-types.ts";

// ---------------------------------------------------------------------------
// persistResume — per-stage mutex map
// ---------------------------------------------------------------------------

/**
 * Module-level mutex map.  Key = stageDir absolute path.
 * Value = tail of the promise chain for that stage — each new call appends
 * to the tail so concurrent calls for the same stageDir serialize.
 */
const _stageMutex = new Map<string, Promise<void>>();

/** Default values for required OffloadResumeMetadata fields when no existing resume present. */
const _resumeDefaults: Omit<OffloadResumeMetadata, "schemaVersion"> = {
  agentSessionId: "",
  tmuxSessionName: "",
  tmuxWindowName: "",
  spawnEnv: {},
  spawnCwd: "",
  lastPrompt: "",
  lastSeenAt: 0,
  offloadedAt: null,
};

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

  // Serialize by chaining onto the current tail for this stageDir.
  const prev = _stageMutex.get(stageDir) ?? Promise.resolve();
  const next: Promise<void> = prev.then(() => _doPersist(metaPath, patch));

  // Register the new tail immediately (before awaiting) so concurrent callers
  // that arrive after this point append to the correct tail.
  _stageMutex.set(stageDir, next);

  // Clean up map entry once this chain link settles so map doesn't grow unbounded.
  // `.catch(() => {})` silences the unhandled-rejection warning on the floating
  // finally promise — the caller handles the actual rejection via `return next`.
  next.finally(() => {
    if (_stageMutex.get(stageDir) === next) {
      _stageMutex.delete(stageDir);
    }
  }).catch(() => {});

  return next;
}

async function _doPersist(
  metaPath: string,
  patch: Partial<OffloadResumeMetadata>,
): Promise<void> {
  // Read
  let raw: string;
  try {
    raw = await fs.readFile(metaPath, "utf8");
  } catch {
    throw new Error(`metadata.json not found at ${metaPath}`);
  }

  const existing = JSON.parse(raw) as MetadataJsonWithResume;

  // Validate existing schemaVersion if resume sub-object is present.
  if (existing.resume !== undefined && existing.resume.schemaVersion !== 1) {
    throw new Error(
      `unsupported resume schemaVersion: ${existing.resume.schemaVersion}`,
    );
  }

  // Merge: defaults < existing.resume < patch; schemaVersion always 1.
  // Spreading undefined/null is a no-op in JS, so the fallback `?? {}` is
  // unnecessary and rejected by the unicorn/no-useless-fallback-in-spread rule.
  const nextResume: OffloadResumeMetadata = {
    ..._resumeDefaults,
    ...existing.resume,
    ...patch,
    schemaVersion: 1,
  };

  // Rebuild with immutables verbatim from the read.
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

  const tmpPath = `${metaPath}.tmp`;

  // Write tmp file with restricted permissions (mode 0o600).
  await fs.writeFile(tmpPath, JSON.stringify(nextMeta, null, 2), {
    mode: 0o600,
    encoding: "utf8",
  });

  // Atomic rename over destination.
  await fs.rename(tmpPath, metaPath);
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

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
  }): void;
  onWorkflowCompletion(): Promise<void>;
  requestResume(name: string): Promise<void>;
  getStatus(name: string): "alive" | "offloaded" | "resuming";
}

export interface OffloadManagerDeps {
  panelStore: {
    setSessionStatus(
      name: string,
      status: "offloaded" | "resuming" | "complete",
    ): void;
    activeAgentId(): string | null;
    sessions(): ReadonlyMap<string, { headless: boolean; status: string }>;
  };
  tmux: {
    killWindow(session: string, window: string): Promise<void>;
    createWindow(session: string, name: string, cwd: string): Promise<void>;
    sendKeys(session: string, window: string, keys: string[]): Promise<void>;
    selectWindow(session: string, window: string): Promise<void>;
  };
  providers: {
    claude: { buildResumeArgs(meta: OffloadResumeMetadata): string[] };
    opencode: { buildResumeArgs(meta: OffloadResumeMetadata): string[] };
    copilot: { buildResumeArgs(meta: OffloadResumeMetadata): string[] };
  };
  now(): number;
}

// ---------------------------------------------------------------------------
// Internal state shape
// ---------------------------------------------------------------------------

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
  state: SessionState;
}

// ---------------------------------------------------------------------------
// Module-level idempotency primitive (shared across all manager instances
// in tests and exposed for white-box testing via _testOnlyGetOrStartOp).
// ---------------------------------------------------------------------------

const _moduleOpQueue = new Map<string, Promise<void>>();

/**
 * Idempotency primitive: if an operation is already running for `name`,
 * return the same Promise.  Otherwise start a new one, register it, and
 * clear it from the map when it settles (success or failure).
 *
 * Exported as `_testOnlyGetOrStartOp` for unit testing only.
 * Production callers use the instance-level wrapper returned by createOffloadManager.
 */
export function _testOnlyGetOrStartOp(
  name: string,
  op: () => Promise<void>,
  queue: Map<string, Promise<void>> = _moduleOpQueue,
): Promise<void> {
  const existing = queue.get(name);
  if (existing !== undefined) return existing;

  const promise = op().finally(() => {
    if (queue.get(name) === promise) {
      queue.delete(name);
    }
  });
  queue.set(name, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOffloadManager(deps: OffloadManagerDeps): OffloadManager {
  const sessions = new Map<string, RegisteredSession>();

  /**
   * Per-pane operation serializer — instance-scoped queue so multiple
   * managers in tests don't share state.
   */
  const opQueue = new Map<string, Promise<void>>();

  /**
   * Instance-level wrapper around the idempotency primitive using the
   * per-instance queue.  Tasks #2 and #13 will call this.
   */
  function getOrStartOp(name: string, op: () => Promise<void>): Promise<void> {
    return _testOnlyGetOrStartOp(name, op, opQueue);
  }

  // Make getOrStartOp available to future task bodies via closure.
  void getOrStartOp;

  // Suppress unused-variable lint for `deps` until task #2/#13 use it.
  void deps;

  return {
    registerSession(input) {
      sessions.set(input.name, {
        ...input,
        state: "alive",
      });
    },

    getStatus(name) {
      return sessions.get(name)?.state ?? "alive";
    },

    onWorkflowCompletion(): Promise<void> {
      return Promise.reject(new Error("not yet implemented (task-2)"));
    },

    requestResume(name: string): Promise<void> {
      void name;
      return Promise.reject(new Error("not yet implemented (task-13)"));
    },
  };
}
