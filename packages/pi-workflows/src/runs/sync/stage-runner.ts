/**
 * Stage runner — creates a StageContext for a given stage.
 * Handles prompt / complete / subagent adapters.
 */

import type { StageContext, SubagentStageOpts, CompleteStageOpts, StageExecutionMeta } from "../../shared/types.js";

export interface PromptAdapter {
  prompt(text: string, meta?: StageExecutionMeta): Promise<string>;
}

export interface CompleteAdapter {
  complete(text: string, opts?: CompleteStageOpts, meta?: StageExecutionMeta): Promise<string>;
}

/**
 * Execution metadata threaded from the executor into stage adapter calls.
 * Not exposed to workflow authors — StageContext public API is unchanged.
 * @deprecated Use StageExecutionMeta from shared/types instead.
 */
export type SubagentStageMeta = StageExecutionMeta;

export interface SubagentAdapter {
  /**
   * Delegate stage to a sub-agent.
   * @param opts   - Public subagent options (agent, task, context).
   * @param meta   - Execution metadata (runId, stageId, stageName, signal)
   *                 injected by the stage-runner; overrides ambient process.env
   *                 fallback in the adapter implementation.
   */
  subagent(opts: SubagentStageOpts, meta?: StageExecutionMeta): Promise<string>;
}

export interface StageAdapters {
  prompt?: PromptAdapter;
  complete?: CompleteAdapter;
  subagent?: SubagentAdapter;
}

export interface StageRunnerOpts {
  stageId: string;
  stageName: string;
  adapters: StageAdapters;
  /** Run ID of the containing workflow execution — forwarded to subagent adapter. */
  runId: string;
  /** AbortSignal from the executor's own AbortController — forwarded to subagent adapter. */
  signal?: AbortSignal;
}

export function createStageContext(opts: StageRunnerOpts): StageContext {
  const { stageId, stageName, adapters, runId, signal } = opts;
  const meta: StageExecutionMeta = { runId, stageId, stageName, signal };

  return {
    name: stageName,

    async prompt(text: string): Promise<string> {
      if (adapters.prompt) {
        return adapters.prompt.prompt(text, meta);
      }
      // Deterministic stub in test environments
      if (process.env["NODE_ENV"] === "test") {
        return `[stub:${stageName}:${text.slice(0, 30)}]`;
      }
      throw new Error(
        "pi-workflows: prompt adapter not configured — provide a PromptAdapter via RunOpts.prompt",
      );
    },

    async complete(text: string, completeOpts?: CompleteStageOpts): Promise<string> {
      if (adapters.complete) {
        return adapters.complete.complete(text, completeOpts, meta);
      }
      throw new Error(
        "pi-workflows: complete adapter not configured — provide a CompleteAdapter via RunOpts.complete",
      );
    },

    async subagent(subagentOpts: SubagentStageOpts): Promise<string> {
      if (adapters.subagent) {
        return adapters.subagent.subagent(subagentOpts, meta);
      }
      throw new Error(
        "pi-workflows: subagent requires pi-subagents — install npm:pi-subagents",
      );
    },
  };
}
