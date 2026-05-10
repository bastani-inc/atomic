/**
 * DaemonWorkflowContext — daemon-resident WorkflowContext implementation.
 *
 * Replaces the stub makeStubContext() in run-manager.ts with a real
 * implementation that:
 *   - Integrates with RunState (addStage / sessionStarted / sessionEnded).
 *   - Spawns agent subprocesses via the typed ISupervisor interface.
 *   - Awaits subprocess exit via the minimal `onExit` promise seam added
 *     to ISupervisor.spawn.
 *   - Reads transcripts and saved messages from the daemon's session
 *     directory layout (~/.atomic/sessions/<runId>/<stageName>/).
 *
 * Shape is compatible with the SDK's WorkflowContext<AgentType> so that
 * existing builtin workflows can call ctx.stage() without hitting a stub.
 * The `run` callback (4th arg to stage) is accepted and invoked with a
 * DaemonSessionContext; caller must not expect SDK client/session to be
 * initialised until run-manager-execution wires that layer.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { AgentType } from "../types.ts";
import type { ISupervisor } from "./ui-protocol/methods.ts";
import type { RunState } from "./run-state.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Resolved stage name + session metadata kept after a stage completes. */
interface CompletedStageRecord {
  sessionId: string;
  sessionDir: string;
}

/** Subset of SessionRunOptions that the daemon context cares about. */
interface StageNameOptions {
  name: string;
  description?: string;
  headless?: boolean;
}

/** Options accepted by DaemonWorkflowContext.stage() simple 2-arg form. */
export interface DaemonStageOptions {
  /** CLI args forwarded verbatim to the agent subprocess. */
  args?: string[];
  /** Extra environment variables merged into the subprocess environment. */
  env?: Record<string, string>;
  /** Human-readable description (tracked in RunState). */
  description?: string;
}

/** Opaque handle returned by ctx.stage(). Compatible with SessionHandle<T>. */
export interface DaemonSessionHandle<T = void> {
  readonly name: string;
  readonly id: string;
  readonly result: T;
}

/**
 * Minimal SessionContext passed to the stage run callback.
 *
 * Provides the fields guaranteed available in daemon mode (identity,
 * inputs, stage runner). SDK client/session fields will be initialised
 * by run-manager-execution; accessing them before that layer is wired
 * throws a descriptive error rather than a generic "stub" message.
 */
export interface DaemonSessionContext {
  /** Which agent is running this stage. */
  agent: AgentType;
  /** Structured workflow inputs. */
  inputs: Record<string, unknown>;
  /** Session UUID generated at stage spawn time. */
  sessionId: string;
  /** Absolute path to this stage's storage directory. */
  sessionDir: string;
  /** PTY pane identifier (pid as string in daemon mode). */
  paneId: string;
  /** Spawn a nested sub-stage from within a stage callback. */
  stage: DaemonWorkflowContext["stage"];
  /** Read the rendered transcript of a completed stage. */
  transcript: DaemonWorkflowContext["transcript"];
  /** Read raw saved messages of a completed stage. */
  getMessages: DaemonWorkflowContext["getMessages"];
}

// ─── Constructor options ──────────────────────────────────────────────────────

export interface DaemonWorkflowContextOptions {
  runId: string;
  agent: AgentType;
  inputs: Record<string, unknown>;
  state: RunState;
  supervisor: ISupervisor;
  /**
   * Base directory for per-run session data.
   * Defaults to ~/.atomic/sessions.
   */
  sessionsBaseDir?: string;
}

// ─── DaemonWorkflowContext ────────────────────────────────────────────────────

/**
 * Daemon-resident implementation of WorkflowContext.
 *
 * Designed to be the direct drop-in for makeStubContext() in RunManager.
 * The stage() method signature is intentionally flexible so it accepts
 * both the simplified (name, opts?) daemon form and the full SDK
 * (SessionRunOptions, clientOpts, sessionOpts, runFn) form used by
 * builtin workflows.
 */
export class DaemonWorkflowContext {
  readonly inputs: Record<string, unknown>;
  readonly agent: AgentType;

  private readonly runId: string;
  private readonly state: RunState;
  private readonly supervisor: ISupervisor;
  private readonly sessionsBaseDir: string;

  /** Completed stage records keyed by stage name. */
  private readonly completedStages = new Map<string, CompletedStageRecord>();

  constructor(opts: DaemonWorkflowContextOptions) {
    this.runId = opts.runId;
    this.agent = opts.agent;
    this.inputs = opts.inputs;
    this.state = opts.state;
    this.supervisor = opts.supervisor;
    this.sessionsBaseDir =
      opts.sessionsBaseDir ??
      join(homedir(), ".atomic", "sessions");
  }

  // ─── stage() ───────────────────────────────────────────────────────────────

  /**
   * Spawn a stage subprocess, register it in RunState, and await its exit.
   *
   * Overloaded to accept:
   *   1. Simple daemon form: `stage(name, opts?)`
   *   2. Full SDK form:      `stage(options, clientOpts, sessionOpts, run)`
   *
   * In both forms the subprocess is spawned via ISupervisor.  When a `run`
   * callback is provided it is invoked with a DaemonSessionContext immediately
   * after spawn succeeds (before subprocess exit) so it can interact with the
   * live subprocess.  The stage only settles after BOTH the callback and the
   * subprocess have completed.
   */
  stage<T = void>(
    nameOrOptions: string | StageNameOptions,
    optsOrClientOpts?: DaemonStageOptions | Record<string, unknown>,
    _sessionOpts?: Record<string, unknown>,
    run?: (ctx: DaemonSessionContext) => Promise<T>,
  ): Promise<DaemonSessionHandle<T>> {
    // Normalise first arg to a plain name string + description.
    const name =
      typeof nameOrOptions === "string" ? nameOrOptions : nameOrOptions.name;
    const description =
      typeof nameOrOptions === "string"
        ? (optsOrClientOpts as DaemonStageOptions | undefined)?.description
        : nameOrOptions.description;

    // Extract subprocess args/env from the daemon-form opts (2-arg call).
    // Full-SDK calls pass clientOpts as 2nd arg — those never have .args.
    const daemonOpts =
      typeof nameOrOptions === "string"
        ? (optsOrClientOpts as DaemonStageOptions | undefined)
        : undefined;

    const args = daemonOpts?.args ?? [];
    const env = daemonOpts?.env;

    const sessionId = randomUUID();
    const sessionDir = join(this.sessionsBaseDir, this.runId, name);

    return this._runStage<T>({ name, description, args, env, sessionId, sessionDir, run });
  }

  // ─── transcript() ──────────────────────────────────────────────────────────

  /**
   * Return the rendered text transcript of a completed stage.
   *
   * Reads `inbox.md` from the stage session directory (same convention as
   * the executor path).  Accepts a stage name string or a DaemonSessionHandle.
   */
  async transcript(
    ref: string | DaemonSessionHandle<unknown>,
  ): Promise<{ path: string; content: string }> {
    const stageName = typeof ref === "string" ? ref : ref.name;
    const record = this.completedStages.get(stageName);
    if (!record) {
      const available =
        [...this.completedStages.keys()].join(", ") || "(none)";
      throw new Error(
        `No transcript for "${stageName}". Available: ${available}`,
      );
    }
    const filePath = join(record.sessionDir, "inbox.md");
    const content = await readFile(filePath, "utf-8");
    return { path: filePath, content };
  }

  // ─── getMessages() ─────────────────────────────────────────────────────────

  /**
   * Return the raw saved messages of a completed stage.
   *
   * Reads `messages.json` from the stage session directory.  Accepts a
   * stage name string or a DaemonSessionHandle.
   */
  async getMessages(
    ref: string | DaemonSessionHandle<unknown>,
  ): Promise<Record<string, unknown>[]> {
    const stageName = typeof ref === "string" ? ref : ref.name;
    const record = this.completedStages.get(stageName);
    if (!record) {
      const available =
        [...this.completedStages.keys()].join(", ") || "(none)";
      throw new Error(
        `No messages for "${stageName}". Available: ${available}`,
      );
    }
    const filePath = join(record.sessionDir, "messages.json");
    const raw = await readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(
        `Invalid messages file for "${stageName}": expected JSON array`,
      );
    }
    return parsed as Record<string, unknown>[];
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async _runStage<T>(opts: {
    name: string;
    description?: string;
    args: string[];
    env?: Record<string, string>;
    sessionId: string;
    sessionDir: string;
    run?: (ctx: DaemonSessionContext) => Promise<T>;
  }): Promise<DaemonSessionHandle<T>> {
    const { name, args, env, sessionId, sessionDir, run } = opts;

    // ── 1. Register in RunState ─────────────────────────────────────────────
    this.state.addStage({ name });
    this.state.sessionStarted(name);

    // ── 2. Spawn subprocess + build exit promise ────────────────────────────
    let pid: number;
    const exitPromise = new Promise<number>((resolveExit, rejectExit) => {
      this.supervisor
        .spawn({
          runId: this.runId,
          stageName: name,
          agent: this.agent,
          args,
          env,
          onExit: (exitCode: number) => resolveExit(exitCode),
        })
        .then((result) => {
          pid = result.pid;
        })
        .catch((spawnErr: unknown) => {
          rejectExit(spawnErr);
        });
    });

    // ── 3. Invoke run callback (if provided) ────────────────────────────────
    let callbackResult: T | undefined;
    if (run) {
      const sessionCtx = this._makeSessionContext(
        name,
        sessionId,
        sessionDir,
        // pid is set by the time onExit fires; use a getter to avoid
        // capturing before spawn resolves.
        () => pid,
      );
      callbackResult = await run(sessionCtx);
    }

    // ── 4. Await subprocess exit ────────────────────────────────────────────
    let exitCode: number;
    try {
      exitCode = await exitPromise;
    } catch (spawnErr: unknown) {
      const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      this.state.sessionEnded(name, "error", msg);
      throw spawnErr;
    }

    // ── 5. Update RunState ──────────────────────────────────────────────────
    if (exitCode === 0) {
      this.state.sessionEnded(name, "complete");
    } else {
      this.state.sessionEnded(
        name,
        "error",
        `Stage "${name}" subprocess exited with code ${exitCode}`,
      );
    }

    // ── 6. Record completion for transcript / getMessages lookup ────────────
    this.completedStages.set(name, { sessionId, sessionDir });

    if (exitCode !== 0) {
      throw new Error(
        `Stage "${name}" subprocess exited with code ${exitCode}`,
      );
    }

    return {
      name,
      id: sessionId,
      result: callbackResult as T,
    };
  }

  /** Build the minimal DaemonSessionContext forwarded to stage run callbacks. */
  private _makeSessionContext(
    name: string,
    sessionId: string,
    sessionDir: string,
    getPid: () => number,
  ): DaemonSessionContext {
    return {
      agent: this.agent,
      inputs: this.inputs,
      sessionId,
      sessionDir,
      get paneId() {
        const pid = getPid();
        return pid != null ? String(pid) : "daemon-pending";
      },
      stage: this.stage.bind(this),
      transcript: this.transcript.bind(this),
      getMessages: this.getMessages.bind(this),
    };
  }
}
