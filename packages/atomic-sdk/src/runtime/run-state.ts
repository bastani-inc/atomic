/**
 * Daemon-resident per-run state with subscriber broadcast.
 *
 * Each active workflow run gets one `RunState` instance. Mutations
 * coalesce via `queueMicrotask` so N synchronous state changes produce
 * one `panel/update` notification per tick. A debounced disk write
 * shadows every broadcast.
 */

import type { MessageConnection } from "vscode-jsonrpc";
import { join } from "node:path";
import type { AgentType } from "../types.ts";
import type { SessionData, SessionStatus } from "../components/orchestrator-panel-types.ts";
import {
  type WorkflowStatusSnapshot,
  type WorkflowOverallStatus,
  buildSnapshot,
  writeSnapshot,
} from "./status-writer.ts";

// Re-export so callers can import from one place.
export type { WorkflowStatusSnapshot, WorkflowOverallStatus };

// ─── Constructor args ─────────────────────────────────────────────────────────

export interface RunStateOptions {
  runId: string;
  workflowName: string;
  agent: AgentType;
  projectRoot: string;
  /** Absolute path for status.json; defaults to ~/.atomic/sessions/<runId>/status.json */
  statusFilePath?: string;
}

// ─── Internal session row ─────────────────────────────────────────────────────

type StageRow = SessionData;

// ─── RunState ─────────────────────────────────────────────────────────────────

export class RunState {
  // ── identity ────────────────────────────────────────────────────────────────
  readonly runId: string;
  readonly workflowName: string;
  readonly agent: AgentType;
  readonly projectRoot: string;

  // ── live state ──────────────────────────────────────────────────────────────
  private stages: StageRow[] = [];
  private fatalError: string | null = null;
  private completionReached = false;
  private foregroundStage: string | null = null;
  private version = 0;

  // ── disk persistence ────────────────────────────────────────────────────────
  private readonly sessionDir: string;
  private persistPending = false;
  private latestSnapshot: WorkflowStatusSnapshot | null = null;

  // ── subscribers ─────────────────────────────────────────────────────────────
  private subscribers = new Map<string, MessageConnection>();

  // ── broadcast coalescing ────────────────────────────────────────────────────
  private broadcastPending = false;
  private disposed = false;

  constructor(opts: RunStateOptions) {
    this.runId = opts.runId;
    this.workflowName = opts.workflowName;
    this.agent = opts.agent;
    this.projectRoot = opts.projectRoot;

    // Determine session directory from statusFilePath or default.
    if (opts.statusFilePath) {
      this.sessionDir = join(opts.statusFilePath, "..");
    } else {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
      this.sessionDir = join(home, ".atomic", "sessions", opts.runId);
    }
  }

  // ─── Subscriber API ─────────────────────────────────────────────────────────

  /**
   * Register a subscriber. Returns a subscriptionId the caller can pass
   * to `unsubscribe`.
   */
  subscribe(connection: MessageConnection): string {
    const id = crypto.randomUUID();
    this.subscribers.set(id, connection);
    return id;
  }

  /** Remove a subscriber by its subscriptionId. No-op if unknown. */
  unsubscribe(subscriptionId: string): void {
    this.subscribers.delete(subscriptionId);
  }

  /** Current snapshot without triggering any mutations. */
  getSnapshot(): WorkflowStatusSnapshot {
    return this.buildCurrentSnapshot();
  }

  // ─── Mutators ────────────────────────────────────────────────────────────────

  /** Append a stage row. Defaults to `pending` status with no parents. */
  addStage(row: {
    name: string;
    parents?: string[];
    status?: SessionStatus;
  }): void {
    this.stages.push({
      name: row.name,
      status: row.status ?? "pending",
      parents: row.parents ?? [],
      startedAt: null,
      endedAt: null,
    });
    this.scheduleBroadcast();
  }

  updateStage(
    name: string,
    patch: Partial<Omit<StageRow, "name">>,
  ): void {
    const row = this.stages.find((s) => s.name === name);
    if (!row) return;
    Object.assign(row, patch);
    this.scheduleBroadcast();
  }

  sessionStarted(name: string): void {
    const row = this.stages.find((s) => s.name === name);
    if (!row) return;
    row.status = "running";
    row.startedAt = Date.now();
    this.scheduleBroadcast();
  }

  sessionEnded(name: string, status: "complete" | "error", error?: string): void {
    const row = this.stages.find((s) => s.name === name);
    if (!row) return;
    row.status = status;
    if (status === "error" && error !== undefined) row.error = error;
    row.endedAt = Date.now();
    this.scheduleBroadcast();
  }

  setError(message: string): void {
    this.fatalError = message;
    this.completionReached = true;
    this.scheduleBroadcast();
  }

  markCompletionReached(): void {
    this.completionReached = true;
    this.scheduleBroadcast();
  }

  /**
   * Set the foreground stage name (the pane the UI should attach to).
   * Broadcasts `panel/foregroundChange` immediately and a coalesced
   * `panel/update` on the next microtask.
   */
  setForeground(stageName: string | null): void {
    this.foregroundStage = stageName;
    this.scheduleBroadcast();
    this.broadcast("panel/foregroundChange", {
      runId: this.runId,
      stageName,
    });
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  /** Tear down — clears subscribers and cancels pending broadcasts. */
  dispose(): void {
    this.disposed = true;
    this.subscribers.clear();
    this.broadcastPending = false;
    this.persistPending = false;
    this.latestSnapshot = null;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Schedule a coalesced broadcast for the current microtask checkpoint.
   * Multiple synchronous mutations within one tick produce a single
   * `panel/update` notification.
   */
  private scheduleBroadcast(): void {
    if (this.broadcastPending || this.disposed) return;
    this.broadcastPending = true;
    queueMicrotask(() => {
      this.broadcastPending = false;
      if (this.disposed) return;
      this.version++;
      const snapshot = this.buildCurrentSnapshot();
      this.broadcast("panel/update", { runId: this.runId, snapshot, version: this.version });
      this.schedulePersist(snapshot);
    });
  }

  /**
   * Debounced disk write — fires after the microtask broadcast (via setTimeout
   * macrotask) so persistence is always consistent with what was sent to
   * clients and never blocks the microtask queue.
   *
   * `latestSnapshot` is overwritten unconditionally so a coalesced burst still
   * persists the most recent state; the timer reads it at fire time rather
   * than capturing a closure-stale value.
   */
  private schedulePersist(snapshot: WorkflowStatusSnapshot): void {
    this.latestSnapshot = snapshot;
    if (this.persistPending || this.disposed) return;
    this.persistPending = true;
    const timer = setTimeout(() => {
      this.persistPending = false;
      if (this.disposed) return;
      const toWrite = this.latestSnapshot;
      if (!toWrite) return;
      // Best-effort — never crash the daemon over a disk write.
      void writeSnapshot(this.sessionDir, toWrite).catch(() => {});
    }, 0);
    // Don't hold the event loop alive just for persistence.
    (timer as { unref?: () => void }).unref?.();
  }

  /** Number of active subscribers. Exposed for testing. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Current foreground stage name. Exposed for run/getAttachInfo. */
  getForeground(): string | null {
    return this.foregroundStage;
  }

  /**
   * Fan out a JSON-RPC notification to every subscriber.
   * Subscribers that throw synchronously or whose async send rejects are
   * pruned immediately (RFC §5.3.1 / §7.3 policy: close that client).
   */
  private broadcast(method: string, params: unknown): void {
    const warn = (id: string, err: unknown): void => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[RunState] subscriber ${id} dropped (${method}): ${message}`);
    };
    const dead: string[] = [];
    for (const [id, conn] of this.subscribers) {
      try {
        const promise = conn.sendNotification(method, params);
        Promise.resolve(promise).catch((err: unknown) => {
          warn(id, err);
          this.subscribers.delete(id);
        });
      } catch (err) {
        warn(id, err);
        dead.push(id);
      }
    }
    for (const id of dead) this.subscribers.delete(id);
  }

  private buildCurrentSnapshot(): WorkflowStatusSnapshot {
    return buildSnapshot(
      {
        workflowRunId: this.runId,
        tmuxSession: "", // daemon-resident; no tmux session
        workflowName: this.workflowName,
        agent: this.agent,
        prompt: "", // prompt not tracked at this layer
        fatalError: this.fatalError,
        completionReached: this.completionReached,
        sessions: this.stages,
      },
      () => new Date(),
    );
  }
}
