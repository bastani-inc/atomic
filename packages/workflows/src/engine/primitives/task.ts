import type { WorkflowChainOptions, WorkflowParallelOptions, WorkflowTaskOptions, WorkflowTaskResult, WorkflowTaskStep } from "../../shared/types.js";
import type { ParallelFailFastScope } from "../../runs/foreground/executor-types.js";
import type { EngineRuntime } from "../runtime.js";
import { RESUME_CONTINUATION_PROMPT } from "../../shared/resume-continuation.js";
import {
  applyTaskContext,
  structuredTaskOutputText,
  taskPrevious,
  taskPrompt,
  taskPromptOptions,
  taskReadInstruction,
  taskStageOptions,
  truncateTaskOutput,
} from "../../runs/foreground/executor-task-prompts.js";
import {
  cleanupPreparedWorktrees,
  collectWorktreeDiffs,
  prepareTaskWorktrees,
  stageOptionsWithGitWorktree,
  stageOptionsWithInputDefaults,
} from "../../runs/foreground/executor-direct-helpers.js";
import { createChainPrimitive } from "./chain.js";
import { createParallelPrimitive } from "./parallel.js";

export type WorkflowTaskPrimitive = (
  name: string,
  options: WorkflowTaskOptions,
  stageFailFastScope?: ParallelFailFastScope,
) => Promise<WorkflowTaskResult>;

export interface WorkflowTaskRunners {
  task: WorkflowTaskPrimitive;
  chain(steps: readonly WorkflowTaskStep[], options?: WorkflowChainOptions): Promise<WorkflowTaskResult[]>;
  parallel(steps: readonly WorkflowTaskStep[], options?: WorkflowParallelOptions): Promise<WorkflowTaskResult[]>;
}

function createTaskPrimitive(runtime: EngineRuntime): WorkflowTaskPrimitive {
  return async (name: string, options: WorkflowTaskOptions, stageFailFastScope?: ParallelFailFastScope): Promise<WorkflowTaskResult> => {
    runtime.exit.throwIfWorkflowExitSelected();
    const runTaskOnce = async (taskOptions: WorkflowTaskOptions): Promise<WorkflowTaskResult> => {
      runtime.exit.throwIfWorkflowExitSelected();
      const resolvedTaskOptions = stageOptionsWithGitWorktree(
        stageOptionsWithInputDefaults(taskOptions, runtime.inputRuntimeDefaults),
        runtime.workflowInvocationCwd,
        runtime.gitWorktreeSetupCache,
      ) ?? taskOptions;
      const stageOptions = taskStageOptions(resolvedTaskOptions);
      const stageHandle = runtime.spawnStage(name, {
        kind: "agent",
        ...(stageOptions !== undefined ? { options: stageOptions } : {}),
        ...(stageFailFastScope !== undefined ? { failFastScope: stageFailFastScope } : {}),
      });
      const stage = stageHandle.context;
      const promptText = resolvedTaskOptions.resumeFromSessionFile !== undefined
        ? RESUME_CONTINUATION_PROMPT
        : applyTaskContext(`${taskReadInstruction(resolvedTaskOptions)}${taskPrompt(resolvedTaskOptions)}`, taskPrevious(resolvedTaskOptions));
      const rawOutput = await stage.prompt(promptText, taskPromptOptions(resolvedTaskOptions));
      const structured = typeof rawOutput === "string" ? undefined : rawOutput;
      const text = truncateTaskOutput(structuredTaskOutputText(rawOutput), resolvedTaskOptions.maxOutput);
      const sessionId = (() => {
        try {
          return stage.sessionId;
        } catch {
          return undefined;
        }
      })();
      const stageMeta = stage.__modelFallbackMeta();
      return {
        name,
        stageName: name,
        text,
        ...(structured !== undefined ? { structured } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(stage.sessionFile !== undefined ? { sessionFile: stage.sessionFile } : {}),
        ...(stageMeta.model !== undefined ? { model: stageMeta.model } : {}),
        ...(stageMeta.fastMode === true ? { fastMode: stageMeta.fastMode } : {}),
        ...(stageMeta.attemptedModels !== undefined ? { attemptedModels: stageMeta.attemptedModels } : {}),
        ...(stageMeta.modelAttempts !== undefined ? { modelAttempts: stageMeta.modelAttempts } : {}),
        ...(stageMeta.warnings !== undefined ? { warnings: stageMeta.warnings } : {}),
      };
    };

    if (options.worktree !== true) return runTaskOnce(options);
    const prepared = prepareTaskWorktrees(
      [{ ...options, name }],
      { ...options, worktree: true },
      `${runtime.runId}-${name}-${crypto.randomUUID()}`,
      name,
      runtime.workflowInvocationCwd,
      runtime.worktreeSymlinkDirectories,
    );
    const preparedTask = prepared.tasks[0]!;
    try {
      const result = await runTaskOnce(preparedTask);
      const worktreeDiffs = collectWorktreeDiffs(prepared, options.artifacts !== false);
      return worktreeDiffs.artifacts.length === 0
        ? result
        : { ...result, artifacts: [...(result.artifacts ?? []), ...worktreeDiffs.artifacts] };
    } finally {
      cleanupPreparedWorktrees(prepared);
    }
  };
}

export function createWorkflowTaskRunners(input: { readonly runtime: EngineRuntime }): WorkflowTaskRunners {
  const task = createTaskPrimitive(input.runtime);
  return {
    task,
    chain: createChainPrimitive({ runtime: input.runtime, task }),
    parallel: createParallelPrimitive({ runtime: input.runtime, task }),
  };
}
