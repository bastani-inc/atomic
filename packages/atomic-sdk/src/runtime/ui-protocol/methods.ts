/**
 * JSON-RPC method dispatcher for the atomic UI server.
 *
 * Provides a focused, testable dispatcher layer that:
 *   - Validates params/results using MethodSchemas (Zod).
 *   - Maps Zod validation failures to JSON-RPC -32602 (Invalid Params).
 *   - Enforces connection-level authentication (connect must precede all other
 *     methods except `protocol/getVersion`).
 *   - Delegates business logic to injected dependencies:
 *       WorkflowRegistry  — workflow discovery and import
 *       IRunManager       — run lifecycle, list, status, transcript, subscribe
 *       ISupervisor       — pane I/O and agent subprocess management
 *
 * Does NOT own any TCP server, daemon lifecycle, or process management.
 * Safe to unit-test in isolation with stub implementations of all deps.
 *
 * §5.1, §5.2, §5.3 of specs/2026-05-09-ui-server-bun-native.md
 */

import { timingSafeEqual } from "node:crypto";
import type { MessageConnection } from "vscode-jsonrpc";
import { ZodError } from "zod";
import { MethodSchemas } from "./schemas.ts";
import {
  AtomicRpcError,
  authenticationRequired,
  runNotFound,
} from "./errors.ts";
import type { WorkflowRegistry, WorkflowDescriptor, BrokenEntry } from "../registry.ts";
import { getProtocolVersion } from "../protocol-version.ts";
import type { AgentType } from "../../types.ts";
import type { RunState } from "../run-state.ts";

// ---------------------------------------------------------------------------
// JSON-RPC standard error codes
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 Invalid Params error code. */
const INVALID_PARAMS = -32602 as const;

// ---------------------------------------------------------------------------
// Dependency injection interfaces
// ---------------------------------------------------------------------------

/**
 * Slim run info record surfaced by `run/list` and `run/get`.
 * Mirrors the wire schema in RunInfoSchema.
 */
export interface RunInfo {
  runId: string;
  workflowName: string;
  agent: AgentType;
  /** e.g. "active", "complete", "error", "cancelled" */
  status: string;
  /** ISO 8601 timestamp string */
  startedAt: string;
  /** ISO 8601 timestamp string; absent if run is still active */
  endedAt?: string;
}

/**
 * Manager interface for workflow run lifecycle.
 *
 * Injected into MethodDispatcher; implementations live in the daemon layer.
 * All methods must be non-blocking where possible and throw AtomicRpcError on
 * known failure conditions.
 */
export interface IRunManager {
  /**
   * Start a new workflow run.
   * Throws AtomicRpcError (WORKFLOW_NOT_FOUND, INVALID_WORKFLOW, etc.) on failure.
   */
  start(params: {
    source: string;
    workflowName: string;
    agent: AgentType;
    inputs: Record<string, unknown>;
  }): Promise<{ runId: string }>;

  /**
   * Stop a running workflow run.
   * Throws AtomicRpcError (RUN_NOT_FOUND) if runId is unknown.
   */
  stop(runId: string): Promise<void>;

  /**
   * List all run info records matching the given scope.
   * Defaults to "all" when scope is omitted.
   */
  list(scope?: "active" | "completed" | "all"): RunInfo[];

  /**
   * Return run info for a specific runId, or null if not found.
   */
  get(runId: string): RunInfo | null;

  /**
   * Return the live RunState for a runId, or null if not found.
   * Used for snapshot reads and subscription operations.
   */
  getState(runId: string): RunState | null;

  /**
   * Return a snapshot of the saved messages for a specific session within a run.
   * `sessionName` matches a stage name inside the run.
   */
  getTranscript(runId: string, sessionName: string): Promise<Record<string, unknown>[]>;

  /**
   * Subscribe a connection to panel/update notifications for a specific run
   * (or all runs if runId is omitted).
   *
   * Returns a subscriptionId the caller can pass to `unsubscribe`.
   */
  subscribe(connection: MessageConnection, runId?: string): string;

  /**
   * Remove a subscription by its subscriptionId.
   * No-op if the id is unknown.
   */
  unsubscribe(subscriptionId: string): void;
}

/**
 * Supervisor interface for pane I/O and agent subprocess management.
 *
 * Injected into MethodDispatcher; implementations live in the daemon layer.
 */
export interface ISupervisor {
  /**
   * Forward input data to the PTY for the given run stage.
   * Throws AtomicRpcError (RUN_NOT_FOUND, STAGE_NOT_FOUND) on unknown targets.
   */
  sendInput(runId: string, stageName: string, data: string): void;

  /**
   * Return buffered scrollback for a stage.
   * `fromOffset` optionally requests only bytes after a known head offset.
   * Throws AtomicRpcError (RUN_NOT_FOUND, STAGE_NOT_FOUND) on unknown targets.
   */
  getScrollback(
    runId: string,
    stageName: string,
    fromOffset?: number,
  ): { data: string; headOffset: number };

  /**
   * Spawn an agent subprocess for an existing run stage.
   * Returns the OS PID of the spawned process.
   * Throws AtomicRpcError (PTY_FAILED, RUN_NOT_FOUND, STAGE_NOT_FOUND, MISSING_DEPENDENCY) on failure.
   */
  spawn(params: {
    runId: string;
    stageName: string;
    agent: AgentType;
    args: string[];
    env?: Record<string, string>;
  }): Promise<{ pid: number }>;

  /**
   * Send a signal to a supervised agent process.
   * Defaults to SIGTERM.
   * No-op if pid is unknown (process may have already exited).
   */
  kill(pid: number, signal?: "SIGTERM" | "SIGKILL"): void;
}

// ---------------------------------------------------------------------------
// MethodDispatcher options
// ---------------------------------------------------------------------------

export interface MethodDispatcherOptions {
  /** Workflow registry for discovery and import. */
  workflows: WorkflowRegistry;
  /** Run lifecycle manager. */
  runs: IRunManager;
  /** Process supervisor for pane I/O and agent spawning. */
  supervisor: ISupervisor;
  /**
   * Atomic CLI binary version string (e.g. "2.0.0"), injected by the daemon.
   * Returned as `atomicVersion` in `protocol/getVersion` responses.
   */
  atomicVersion: string;
  /**
   * SDK package version string (e.g. "0.7.13").
   * Returned as `sdkVersion` in `protocol/getVersion` responses.
   */
  sdkVersion: string;
  /**
   * Optional pre-shared token for authenticating connections.
   * When undefined the daemon runs in unauthenticated mode (loopback-only).
   * Corresponds to `ATOMIC_UI_SERVER_TOKEN` in the daemon environment.
   */
  token?: string;
}

// ---------------------------------------------------------------------------
// Per-connection authentication state
// ---------------------------------------------------------------------------

interface ConnectionState {
  authenticated: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Methods that are allowed before a successful `connect` call. */
const UNAUTHENTICATED_METHODS = new Set<string>(["protocol/getVersion", "connect"]);

// ---------------------------------------------------------------------------
// MethodDispatcher
// ---------------------------------------------------------------------------

/**
 * Validates JSON-RPC params, dispatches to handler, validates results.
 *
 * Usage:
 * ```ts
 * const dispatcher = new MethodDispatcher({ workflows, runs, supervisor, ... });
 * const result = await dispatcher.dispatch("workflow/list", {}, connection);
 * ```
 *
 * Throws `AtomicRpcError` on any handled error condition.
 * Unknown methods result in an AtomicRpcError with JSON-RPC code -32601.
 */
export class MethodDispatcher {
  private readonly opts: MethodDispatcherOptions;
  /** Per-connection auth state. WeakMap so GC cleans up dead connections. */
  private readonly connState = new WeakMap<MessageConnection, ConnectionState>();

  constructor(opts: MethodDispatcherOptions) {
    this.opts = opts;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Dispatch an incoming JSON-RPC method call.
   *
   * @param method  JSON-RPC method name (e.g. "workflow/list")
   * @param rawParams  Raw (un-validated) params object from the wire
   * @param connection  The vscode-jsonrpc MessageConnection for the caller
   * @returns  Validated result value, ready to send as the JSON-RPC response
   * @throws  AtomicRpcError on any known error condition
   */
  async dispatch(
    method: string,
    rawParams: unknown,
    connection: MessageConnection,
  ): Promise<unknown> {
    const entry = MethodSchemas[method];
    if (!entry) {
      throw new AtomicRpcError(-32601, `method not found: ${method}`);
    }

    // Auth gate: only UNAUTHENTICATED_METHODS pass before connect.
    if (!UNAUTHENTICATED_METHODS.has(method)) {
      const state = this.connState.get(connection);
      if (!state?.authenticated) {
        throw authenticationRequired();
      }
    }

    // Validate params.
    let params: unknown;
    try {
      params = entry.params.parse(rawParams ?? {});
    } catch (err) {
      if (err instanceof ZodError) {
        throw new AtomicRpcError(INVALID_PARAMS, `invalid params: ${err.message}`, err.issues);
      }
      throw err;
    }

    // Dispatch to handler.
    const raw = await this.handle(method, params, connection);

    // Validate result.
    try {
      return entry.result.parse(raw);
    } catch (err) {
      if (err instanceof ZodError) {
        // Internal error: handler produced a non-conforming result.
        throw new AtomicRpcError(-32603, `internal error: result validation failed`, err.issues);
      }
      throw err;
    }
  }

  // ── Router ────────────────────────────────────────────────────────────────

  private async handle(
    method: string,
    params: unknown,
    connection: MessageConnection,
  ): Promise<unknown> {
    switch (method) {
      case "protocol/getVersion":
        return this.handleProtocolGetVersion();
      case "connect":
        return this.handleConnect(params as { token?: string; clientName: string }, connection);
      case "protocol/sendTelemetry":
        return this.handleProtocolSendTelemetry(
          params as { event: string; payload?: Record<string, unknown> },
        );
      case "workflow/list":
        return this.handleWorkflowList();
      case "workflow/refresh":
        return this.handleWorkflowRefresh();
      case "workflow/start":
        return this.handleWorkflowStart(
          params as {
            source: string;
            workflowName: string;
            agent: AgentType;
            inputs: Record<string, unknown>;
          },
        );
      case "run/list":
        return this.handleRunList(params as { scope?: "active" | "completed" | "all" });
      case "run/get":
        return this.handleRunGet(params as { runId: string });
      case "run/status":
        return this.handleRunStatus(params as { runId: string });
      case "run/transcript":
        return this.handleRunTranscript(params as { runId: string; sessionName: string });
      case "run/stop":
        return this.handleRunStop(params as { runId: string });
      case "run/getAttachInfo":
        return this.handleRunGetAttachInfo(params as { runId: string }, connection);
      case "run/setForeground":
        return this.handleRunSetForeground(
          params as { runId: string; stageName?: string },
        );
      case "pane/sendInput":
        return this.handlePaneSendInput(
          params as { runId: string; stageName: string; data: string },
        );
      case "pane/getScrollback":
        return this.handlePaneGetScrollback(
          params as { runId: string; stageName: string; fromOffset?: number },
        );
      case "panel/get":
        return this.handlePanelGet(params as { runId: string });
      case "panel/subscribe":
        return this.handlePanelSubscribe(params as { runId?: string }, connection);
      case "panel/unsubscribe":
        return this.handlePanelUnsubscribe(params as { subscriptionId: string });
      case "agent/spawn":
        return this.handleAgentSpawn(
          params as {
            runId: string;
            stageName: string;
            agent: AgentType;
            args: string[];
            env?: Record<string, string>;
          },
        );
      case "agent/kill":
        return this.handleAgentKill(params as { pid: number; signal?: "SIGTERM" | "SIGKILL" });
      default:
        throw new AtomicRpcError(-32601, `method not found: ${method}`);
    }
  }

  // ── Handlers: protocol/* ──────────────────────────────────────────────────

  private handleProtocolGetVersion(): {
    protocolVersion: string;
    sdkVersion: string;
    atomicVersion: string;
  } {
    return {
      protocolVersion: getProtocolVersion(),
      sdkVersion: this.opts.sdkVersion,
      atomicVersion: this.opts.atomicVersion,
    };
  }

  private handleConnect(
    params: { token?: string; clientName: string },
    connection: MessageConnection,
  ): { ok: true } {
    const { token } = params;
    const envToken = this.opts.token;

    if (envToken !== undefined) {
      // Auth required — compare tokens with constant-time equality to prevent
      // timing-based token inference attacks.
      if (!token) {
        throw authenticationRequired();
      }
      const a = Buffer.from(token);
      const b = Buffer.from(envToken);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw authenticationRequired();
      }
    }
    // If envToken is undefined: unauthenticated mode — accept any token value.

    this.connState.set(connection, { authenticated: true });
    return { ok: true };
  }

  private handleProtocolSendTelemetry(params: {
    event: string;
    payload?: Record<string, unknown>;
  }): { ok: true } {
    // Telemetry forwarding is fire-and-forget at this layer; the daemon can
    // wire up actual telemetry backends by overriding this via a subclass or
    // by intercepting at the server layer before dispatch.
    void params; // no-op in the dispatcher layer
    return { ok: true };
  }

  // ── Handlers: workflow/* ──────────────────────────────────────────────────

  private handleWorkflowList(): WorkflowDescriptor[] {
    return this.opts.workflows.list();
  }

  private async handleWorkflowRefresh(): Promise<{ count: number; broken: BrokenEntry[] }> {
    return this.opts.workflows.refresh();
  }

  private async handleWorkflowStart(params: {
    source: string;
    workflowName: string;
    agent: AgentType;
    inputs: Record<string, unknown>;
  }): Promise<{ runId: string; attachable: true }> {
    const { runId } = await this.opts.runs.start(params);
    return { runId, attachable: true };
  }

  // ── Handlers: run/* ───────────────────────────────────────────────────────

  private handleRunList(params: { scope?: "active" | "completed" | "all" }): RunInfo[] {
    return this.opts.runs.list(params.scope);
  }

  private handleRunGet(params: { runId: string }): RunInfo | null {
    return this.opts.runs.get(params.runId);
  }

  private handleRunStatus(params: { runId: string }): Record<string, unknown> | null {
    const state = this.opts.runs.getState(params.runId);
    if (!state) return null;
    return state.getSnapshot() as unknown as Record<string, unknown>;
  }

  private async handleRunTranscript(params: {
    runId: string;
    sessionName: string;
  }): Promise<Record<string, unknown>[]> {
    const { runId, sessionName } = params;
    // Throws RUN_NOT_FOUND or STAGE_NOT_FOUND from the run manager on error.
    return this.opts.runs.getTranscript(runId, sessionName);
  }

  private async handleRunStop(params: { runId: string }): Promise<{ ok: true }> {
    const info = this.opts.runs.get(params.runId);
    if (!info) throw runNotFound(params.runId);
    await this.opts.runs.stop(params.runId);
    return { ok: true };
  }

  private handleRunGetAttachInfo(
    params: { runId: string },
    connection: MessageConnection,
  ): { subscriptionId: string; foregroundStage: string | null } {
    const state = this.opts.runs.getState(params.runId);
    if (!state) throw runNotFound(params.runId);

    const subscriptionId = state.subscribe(connection);
    const foregroundStage = state.getForeground();
    return { subscriptionId, foregroundStage };
  }

  private handleRunSetForeground(params: {
    runId: string;
    stageName?: string;
  }): { ok: true } {
    const state = this.opts.runs.getState(params.runId);
    if (!state) throw runNotFound(params.runId);
    state.setForeground(params.stageName ?? null);
    return { ok: true };
  }

  // ── Handlers: pane/* ──────────────────────────────────────────────────────

  private handlePaneSendInput(params: {
    runId: string;
    stageName: string;
    data: string;
  }): { ok: true } {
    this.opts.supervisor.sendInput(params.runId, params.stageName, params.data);
    return { ok: true };
  }

  private handlePaneGetScrollback(params: {
    runId: string;
    stageName: string;
    fromOffset?: number;
  }): { data: string; headOffset: number } {
    return this.opts.supervisor.getScrollback(
      params.runId,
      params.stageName,
      params.fromOffset,
    );
  }

  // ── Handlers: panel/* ─────────────────────────────────────────────────────

  private handlePanelGet(params: { runId: string }): Record<string, unknown> {
    const state = this.opts.runs.getState(params.runId);
    if (!state) throw runNotFound(params.runId);
    return state.getSnapshot() as unknown as Record<string, unknown>;
  }

  private handlePanelSubscribe(
    params: { runId?: string },
    connection: MessageConnection,
  ): { subscriptionId: string } {
    const subscriptionId = this.opts.runs.subscribe(connection, params.runId);
    return { subscriptionId };
  }

  private handlePanelUnsubscribe(params: { subscriptionId: string }): { ok: true } {
    this.opts.runs.unsubscribe(params.subscriptionId);
    return { ok: true };
  }

  // ── Handlers: agent/* ─────────────────────────────────────────────────────

  private async handleAgentSpawn(params: {
    runId: string;
    stageName: string;
    agent: AgentType;
    args: string[];
    env?: Record<string, string>;
  }): Promise<{ pid: number; scrollbackBytes: 0 }> {
    const { pid } = await this.opts.supervisor.spawn(params);
    return { pid, scrollbackBytes: 0 };
  }

  private handleAgentKill(params: {
    pid: number;
    signal?: "SIGTERM" | "SIGKILL";
  }): { ok: true } {
    this.opts.supervisor.kill(params.pid, params.signal);
    return { ok: true };
  }
}
