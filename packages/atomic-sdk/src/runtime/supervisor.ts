/**
 * Process supervisor — owns every agent subprocess via bun-pty.
 *
 * Design goals:
 *   - Dependency-injected PTY spawner (`IPtySpawner`) for testability.
 *   - Per-stage `RingBuffer` scrollback (default 4 MiB).
 *   - Fan-out `pane/output` and `pane/exit` JSON-RPC notifications to per-stage
 *     subscriber sets.
 *   - RunState integration via callbacks; no direct import of RunState.
 *   - No tmux dependency.
 */

import type { MessageConnection } from "vscode-jsonrpc";
import type { AgentType } from "../types.ts";
import type { IPty, IPtyForkOptions, IDisposable } from "bun-pty";
import { ptyFailed, stageNotFound } from "./ui-protocol/errors.ts";

// ─── RingBuffer ────────────────────────────────────────────────────────────────

/** Bounded scrollback buffer.
 *
 * Internally stores data as a string. `headOffset` counts total characters ever
 * appended (monotonically increasing). When the accumulated string exceeds
 * `capacity`, the oldest characters are dropped so `buffer.length <= capacity`.
 *
 * `fromOffset` semantics: position in the infinite virtual stream. Characters
 * with virtual index < `baseOffset` have been evicted.
 */
export class RingBuffer {
  private buffer = "";
  /** Oldest virtual offset still in the buffer. */
  private baseOffset = 0;
  /** Virtual offset of the next character to be written (= total chars ever appended). */
  headOffset = 0;
  readonly capacity: number;

  constructor(capacityBytes = 4 * 1024 * 1024) {
    this.capacity = capacityBytes;
  }

  /** Append data, evicting oldest bytes if capacity would be exceeded. */
  append(data: string): void {
    this.buffer += data;
    this.headOffset += data.length;

    if (this.buffer.length > this.capacity) {
      const excess = this.buffer.length - this.capacity;
      this.buffer = this.buffer.slice(excess);
      this.baseOffset += excess;
    }
  }

  /**
   * Return all buffered data starting from `fromOffset`.
   *
   * - `fromOffset` <= `baseOffset` → return entire buffer.
   * - `fromOffset` >= `headOffset` → return `""`.
   * - otherwise → return the slice that covers [fromOffset, headOffset).
   */
  getFrom(fromOffset = 0): string {
    if (fromOffset >= this.headOffset) return "";
    if (fromOffset <= this.baseOffset) return this.buffer;
    const localStart = fromOffset - this.baseOffset;
    return this.buffer.slice(localStart);
  }

  /** Number of characters currently retained. */
  get length(): number {
    return this.buffer.length;
  }
}

// ─── IPtySpawner ──────────────────────────────────────────────────────────────

/**
 * Abstraction over `bun-pty`'s `spawn()` so tests can inject a fake PTY.
 */
export interface IPtySpawner {
  spawn(file: string, args: string[], opts: IPtyForkOptions): IPty;
}

/** Production implementation — delegates to real `bun-pty`. */
export class BunPtySpawner implements IPtySpawner {
  spawn(file: string, args: string[], opts: IPtyForkOptions): IPty {
    // Dynamic import so the module is not evaluated at load time in tests.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bunPty = require("bun-pty") as { spawn: typeof import("bun-pty").spawn };
    return bunPty.spawn(file, args, opts);
  }
}

// ─── Stage callbacks ──────────────────────────────────────────────────────────

/**
 * Callbacks that wire a supervised stage to the surrounding run lifecycle.
 * Callers (e.g. method handlers) supply these; Supervisor never imports RunState
 * directly.
 */
export interface StageCallbacks {
  /**
   * Called when the subprocess exits. Implementors should update RunState and
   * any other bookkeeping.
   */
  onExit(exitCode: number, signal?: string): void;
}

// ─── Internal stage record ────────────────────────────────────────────────────

interface SupervisedStage {
  runId: string;
  stageName: string;
  agent: AgentType;
  pty: IPty;
  scrollback: RingBuffer;
  /** Monotonically increasing; equals `scrollback.headOffset` after each append. */
  scrollbackHead: number;
  outputSubscribers: Set<MessageConnection>;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  dataDisposable: IDisposable;
  exitDisposable: IDisposable;
}

// ─── Output subscription record ───────────────────────────────────────────────

interface OutputSub {
  stageKey: string;
  connection: MessageConnection;
}

// ─── SpawnOptions ─────────────────────────────────────────────────────────────

export interface SpawnOptions {
  runId: string;
  stageName: string;
  agent: AgentType;
  /** Absolute path to the executable to run. */
  file: string;
  args: string[];
  /** Working directory for the process. */
  cwd: string;
  env?: Record<string, string>;
  /** Terminal dimensions (optional). */
  cols?: number;
  rows?: number;
  /** Scrollback capacity in bytes (default 4 MiB). */
  scrollbackCapacity?: number;
  callbacks?: StageCallbacks;
}

// ─── Supervisor ───────────────────────────────────────────────────────────────

/**
 * Daemon-resident process supervisor.
 *
 * Single instance per daemon. Owns all PTY file-descriptors and broadcasts
 * JSON-RPC notifications to per-stage output subscriber sets.
 */
export class Supervisor {
  private readonly spawner: IPtySpawner;
  private readonly stages = new Map<string, SupervisedStage>();
  /** pid → stage key, for `kill(pid)` lookups. */
  private readonly pidIndex = new Map<number, string>();
  /** subscriptionId → OutputSub */
  private readonly outputSubs = new Map<string, OutputSub>();
  private disposed = false;

  constructor(spawner?: IPtySpawner) {
    this.spawner = spawner ?? new BunPtySpawner();
  }

  // ─── spawn ──────────────────────────────────────────────────────────────────

  /**
   * Spawn a new PTY process for a stage.
   *
   * @throws AtomicRpcError (PTY_FAILED) if the PTY cannot be created.
   */
  spawn(opts: SpawnOptions): { pid: number } {
    const key = stageKey(opts.runId, opts.stageName);
    if (this.stages.has(key)) {
      throw ptyFailed(`stage '${opts.stageName}' in run '${opts.runId}' already exists`);
    }

    let pty: IPty;
    try {
      pty = this.spawner.spawn(opts.file, opts.args, {
        name: "xterm-256color",
        cols: opts.cols ?? 120,
        rows: opts.rows ?? 40,
        cwd: opts.cwd,
        env: { ...(process.env as Record<string, string>), ...opts.env },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw ptyFailed(reason);
    }

    const scrollback = new RingBuffer(opts.scrollbackCapacity);

    const stage: SupervisedStage = {
      runId: opts.runId,
      stageName: opts.stageName,
      agent: opts.agent,
      pty,
      scrollback,
      scrollbackHead: 0,
      outputSubscribers: new Set(),
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      // Placeholders — replaced immediately below.
      dataDisposable: { dispose() {} },
      exitDisposable: { dispose() {} },
    };

    stage.dataDisposable = pty.onData((data) => {
      scrollback.append(data);
      stage.scrollbackHead = scrollback.headOffset;
      this.broadcastOutput(stage, data);
    });

    stage.exitDisposable = pty.onExit(({ exitCode, signal }) => {
      stage.endedAt = Date.now();
      stage.exitCode = exitCode;
      const sigStr = typeof signal === "number" ? String(signal) : signal;
      this.broadcastExit(stage, exitCode, sigStr);
      opts.callbacks?.onExit(exitCode, sigStr);
    });

    this.stages.set(key, stage);
    this.pidIndex.set(pty.pid, key);

    return { pid: pty.pid };
  }

  // ─── kill ───────────────────────────────────────────────────────────────────

  /**
   * Kill a process by PID.
   *
   * @throws AtomicRpcError (STAGE_NOT_FOUND) if no stage matches the pid.
   */
  killByPid(pid: number, signal: string = "SIGTERM"): void {
    const key = this.pidIndex.get(pid);
    if (!key) {
      throw stageNotFound("(unknown)", `pid ${pid}`);
    }
    const stage = this.stages.get(key)!;
    stage.pty.kill(signal);
  }

  /**
   * Kill a stage by runId + stageName.
   *
   * @throws AtomicRpcError (STAGE_NOT_FOUND) if not found.
   */
  killStage(runId: string, stageName: string, signal: string = "SIGTERM"): void {
    const stage = this.requireStage(runId, stageName);
    stage.pty.kill(signal);
  }

  // ─── sendInput ──────────────────────────────────────────────────────────────

  /**
   * Forward data to the PTY's stdin.
   *
   * @throws AtomicRpcError (STAGE_NOT_FOUND) if not found.
   */
  sendInput(runId: string, stageName: string, data: string): void {
    const stage = this.requireStage(runId, stageName);
    stage.pty.write(data);
  }

  // ─── getScrollback ──────────────────────────────────────────────────────────

  /**
   * Return buffered scrollback data starting from `fromOffset`.
   *
   * @throws AtomicRpcError (STAGE_NOT_FOUND) if not found.
   */
  getScrollback(
    runId: string,
    stageName: string,
    fromOffset = 0,
  ): { data: string; headOffset: number } {
    const stage = this.requireStage(runId, stageName);
    return {
      data: stage.scrollback.getFrom(fromOffset),
      headOffset: stage.scrollbackHead,
    };
  }

  // ─── output subscriptions ───────────────────────────────────────────────────

  /**
   * Subscribe a `MessageConnection` to `pane/output` notifications for a stage.
   *
   * @returns subscriptionId for use with `unsubscribeOutput`.
   * @throws AtomicRpcError (STAGE_NOT_FOUND) if not found.
   */
  subscribeOutput(runId: string, stageName: string, conn: MessageConnection): string {
    const stage = this.requireStage(runId, stageName);
    stage.outputSubscribers.add(conn);
    const subId = crypto.randomUUID();
    this.outputSubs.set(subId, {
      stageKey: stageKey(runId, stageName),
      connection: conn,
    });
    return subId;
  }

  /**
   * Remove an output subscription. No-op if unknown.
   */
  unsubscribeOutput(subscriptionId: string): void {
    const sub = this.outputSubs.get(subscriptionId);
    if (!sub) return;
    this.outputSubs.delete(subscriptionId);
    const stage = this.stages.get(sub.stageKey);
    stage?.outputSubscribers.delete(sub.connection);
  }

  // ─── introspection ──────────────────────────────────────────────────────────

  /** Returns true if the given (runId, stageName) pair is tracked. */
  hasStage(runId: string, stageName: string): boolean {
    return this.stages.has(stageKey(runId, stageName));
  }

  /** PID of a tracked stage, or `undefined`. */
  getPid(runId: string, stageName: string): number | undefined {
    return this.stages.get(stageKey(runId, stageName))?.pty.pid;
  }

  /**
   * Exit code of a stage, or `null` if still running / not found.
   */
  getExitCode(runId: string, stageName: string): number | null {
    return this.stages.get(stageKey(runId, stageName))?.exitCode ?? null;
  }

  /** Number of tracked stages (running + exited). */
  get stageCount(): number {
    return this.stages.size;
  }

  /** Number of output subscriptions. */
  get outputSubCount(): number {
    return this.outputSubs.size;
  }

  // ─── dispose ────────────────────────────────────────────────────────────────

  /**
   * Kill all supervised processes, dispose event listeners, clear maps.
   * Safe to call multiple times.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const stage of this.stages.values()) {
      try { stage.pty.kill("SIGKILL"); } catch { /* best-effort */ }
      stage.dataDisposable.dispose();
      stage.exitDisposable.dispose();
      stage.outputSubscribers.clear();
    }
    this.stages.clear();
    this.pidIndex.clear();
    this.outputSubs.clear();
  }

  // ─── private helpers ────────────────────────────────────────────────────────

  private requireStage(runId: string, stageName: string): SupervisedStage {
    const stage = this.stages.get(stageKey(runId, stageName));
    if (!stage) throw stageNotFound(runId, stageName);
    return stage;
  }

  /**
   * Fan out a JSON-RPC notification to every output subscriber for a stage.
   * Connections that throw synchronously or reject asynchronously are pruned.
   */
  private fanOutNotification(
    subscribers: Set<MessageConnection>,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const dead: MessageConnection[] = [];
    for (const conn of subscribers) {
      try {
        const p = conn.sendNotification(method, params);
        Promise.resolve(p).catch(() => {
          subscribers.delete(conn);
        });
      } catch {
        dead.push(conn);
      }
    }
    for (const c of dead) subscribers.delete(c);
  }

  private broadcastOutput(stage: SupervisedStage, data: string): void {
    this.fanOutNotification(stage.outputSubscribers, "pane/output", {
      runId: stage.runId,
      stageName: stage.stageName,
      data,
      offset: stage.scrollbackHead,
    });
  }

  private broadcastExit(
    stage: SupervisedStage,
    exitCode: number,
    signal?: string,
  ): void {
    this.fanOutNotification(stage.outputSubscribers, "pane/exit", {
      runId: stage.runId,
      stageName: stage.stageName,
      exitCode,
      ...(signal !== undefined && { signal }),
    });
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function stageKey(runId: string, stageName: string): string {
  return `${runId}:${stageName}`;
}
