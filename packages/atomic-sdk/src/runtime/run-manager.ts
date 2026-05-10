/**
 * RunManager — implements IRunManager for the atomic daemon.
 *
 * Manages workflow run lifecycle: start, stop, list, get, getState,
 * getTranscript, subscribe, unsubscribe.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { MessageConnection } from "vscode-jsonrpc";
import type { AgentType } from "../types.ts";
import { RunState } from "./run-state.ts";
import type { IRunManager, ISupervisor, RunInfo } from "./ui-protocol/methods.ts";

// ─── WorkflowContext stub ─────────────────────────────────────────────────────

interface WorkflowContext {
  inputs: Record<string, unknown>;
  agent: AgentType;
  stage: (name: string, opts?: unknown) => never;
  transcript: () => never;
  getMessages: () => never;
}

function makeStubContext(inputs: Record<string, unknown>, agent: AgentType): WorkflowContext {
  return {
    inputs,
    agent,
    stage() {
      throw new Error("stage() not yet wired to Supervisor in this daemon version");
    },
    transcript() {
      throw new Error("transcript() not implemented");
    },
    getMessages() {
      throw new Error("getMessages() not implemented");
    },
  };
}

// ─── RunManager ───────────────────────────────────────────────────────────────

/** Options for constructing a RunManager. */
export interface RunManagerOptions {
  /**
   * Injected process supervisor for agent subprocess management.
   * When provided, wired into each RunState for stage execution.
   */
  supervisor?: ISupervisor;
  /**
   * Project root / working directory used for RunState and agent spawning.
   * Defaults to process.cwd() at construction time.
   */
  cwd?: string;
}

export class RunManager implements IRunManager {
  private runs = new Map<string, RunInfo>();
  private states = new Map<string, RunState>();
  private subscriptions = new Map<string, { connection: MessageConnection; runId?: string }>();
  readonly supervisor: ISupervisor | undefined;
  private readonly cwd: string;

  constructor(opts: RunManagerOptions = {}) {
    this.supervisor = opts.supervisor;
    this.cwd = opts.cwd ?? process.cwd();
  }

  async start(params: {
    source: string;
    workflowName: string;
    agent: AgentType;
    inputs: Record<string, unknown>;
  }): Promise<{ runId: string }> {
    const { source, workflowName, agent, inputs } = params;
    const runId = randomUUID();

    const state = new RunState({
      runId,
      workflowName,
      agent,
      projectRoot: this.cwd,
    });

    const info: RunInfo = {
      runId,
      workflowName,
      agent,
      status: "active",
      startedAt: new Date().toISOString(),
    };

    this.runs.set(runId, info);
    this.states.set(runId, state);

    // Fire async execution in the background.
    this.executeRun(state, info, source, inputs).catch((e: unknown) => {
      // Do not overwrite terminal status set by a concurrent stop().
      if (!state.isCancelled) {
        const msg = e instanceof Error ? e.message : String(e);
        state.setError(msg);
        const runInfo = this.runs.get(runId);
        if (runInfo) {
          runInfo.status = "error";
          runInfo.endedAt = new Date().toISOString();
        }
      }
    });

    return { runId };
  }

  private async executeRun(
    state: RunState,
    info: RunInfo,
    source: string,
    inputs: Record<string, unknown>,
  ): Promise<void> {
    try {
      const mod = await import(source);
      if (mod.default && typeof mod.default.run === "function") {
        const ctx = makeStubContext(inputs, info.agent);
        await mod.default.run(ctx);
      }
      // Do not overwrite terminal status set by a concurrent stop().
      if (!state.isCancelled) {
        state.markCompletionReached();
        info.status = "complete";
        info.endedAt = new Date().toISOString();
      }
    } catch (e: unknown) {
      // Do not overwrite terminal status set by a concurrent stop().
      if (!state.isCancelled) {
        const msg = e instanceof Error ? e.message : String(e);
        state.setError(msg);
        info.status = "error";
        info.endedAt = new Date().toISOString();
      }
    }
  }

  async stop(runId: string): Promise<void> {
    const info = this.runs.get(runId);
    const state = this.states.get(runId);
    if (info) {
      info.status = "cancelled";
      info.endedAt = new Date().toISOString();
    }
    if (state) {
      state.cancel();   // emits run/ended exactly once before clearing subscribers
      state.dispose();
    }
  }

  list(scope?: "active" | "completed" | "all"): RunInfo[] {
    const all = [...this.runs.values()];
    switch (scope) {
      case "active":
        return all.filter((r) => r.status === "active");
      case "completed":
        return all.filter((r) => r.status === "complete");
      case "all":
      case undefined:
        return all;
    }
  }

  get(runId: string): RunInfo | null {
    return this.runs.get(runId) ?? null;
  }

  getState(runId: string): RunState | null {
    return this.states.get(runId) ?? null;
  }

  async getTranscript(runId: string, sessionName: string): Promise<Record<string, unknown>[]> {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    const messagesPath = join(home, ".atomic", "sessions", runId, sessionName, "messages.json");
    try {
      const raw = await readFile(messagesPath, "utf-8");
      return JSON.parse(raw) as Record<string, unknown>[];
    } catch {
      return [];
    }
  }

  subscribe(connection: MessageConnection, runId?: string): string {
    const subscriptionId = randomUUID();
    this.subscriptions.set(subscriptionId, { connection, runId });
    // If subscribing to a specific run, add the connection as a subscriber to its state.
    if (runId) {
      const state = this.states.get(runId);
      if (state) {
        state.subscribe(connection);
      }
    } else {
      // Subscribe to all active runs.
      for (const state of this.states.values()) {
        state.subscribe(connection);
      }
    }
    return subscriptionId;
  }

  unsubscribe(subscriptionId: string): void {
    this.subscriptions.delete(subscriptionId);
  }
}
