import type { StageContext, StageOptions, WorkflowTaskOptions, WorkflowTaskResult, WorkflowTaskStep, WorkflowChainOptions, WorkflowParallelOptions } from "../../shared/types.js";
import type { GraphFrontierTracker } from "../shared/graph-inference.js";
import type { WorkflowExitManager } from "./executor-exit-manager.js";
import type { ParallelFailFastScope, ParallelFailFastStage } from "./executor-types.js";
import { findWorkflowExitSignal } from "./executor-abort.js";
import {
  applyTaskContext,
  chainStepPrompt,
  parallelFallbackTask,
  replaceTaskPlaceholder,
  structuredTaskOutputText,
  taskOptionsFromStep,
  taskPrevious,
  taskPrompt,
  taskPromptOptions,
  taskReadInstruction,
  taskStageOptions,
  taskWithSharedDefaults,
  truncateTaskOutput,
} from "./executor-task-prompts.js";
import { cleanupPreparedWorktrees, collectWorktreeDiffs, mapParallelSteps, prepareDirectWorktrees, stageOptionsWithGitWorktree, stageOptionsWithInputDefaults } from "./executor-direct-helpers.js";
import type { InternalStageContext } from "./stage-runner.js";

export interface WorkflowTaskRunners {
  task(name: string, options: WorkflowTaskOptions, stageFailFastScope?: ParallelFailFastScope): Promise<WorkflowTaskResult>;
  chain(steps: readonly WorkflowTaskStep[], options?: WorkflowChainOptions): Promise<WorkflowTaskResult[]>;
  parallel(steps: readonly WorkflowTaskStep[], options?: WorkflowParallelOptions): Promise<WorkflowTaskResult[]>;
}

export function createWorkflowTaskRunners(input: {
  readonly runId: string;
  readonly exit: WorkflowExitManager;
  readonly tracker: GraphFrontierTracker;
  readonly inputRuntimeDefaults: Partial<StageOptions>;
  readonly workflowInvocationCwd: string;
  readonly stage: (name: string, options?: StageOptions, scope?: ParallelFailFastScope) => StageContext;
}): WorkflowTaskRunners {
  const task = async (name: string, options: WorkflowTaskOptions, stageFailFastScope?: ParallelFailFastScope): Promise<WorkflowTaskResult> => {
    input.exit.throwIfWorkflowExitSelected();
    const runTaskOnce = async (taskOptions: WorkflowTaskOptions): Promise<WorkflowTaskResult> => {
      input.exit.throwIfWorkflowExitSelected();
      const resolvedTaskOptions = stageOptionsWithGitWorktree(stageOptionsWithInputDefaults(taskOptions, input.inputRuntimeDefaults), input.workflowInvocationCwd) ?? taskOptions;
      const stage = input.stage(name, taskStageOptions(resolvedTaskOptions), stageFailFastScope);
      const rawOutput = await stage.prompt(
        applyTaskContext(`${taskReadInstruction(resolvedTaskOptions)}${taskPrompt(resolvedTaskOptions)}`, taskPrevious(resolvedTaskOptions)),
        taskPromptOptions(resolvedTaskOptions),
      );
      const structured = typeof rawOutput === "string" ? undefined : rawOutput;
      const text = truncateTaskOutput(structuredTaskOutputText(rawOutput), resolvedTaskOptions.maxOutput);
      const sessionId = (() => {
        try {
          return stage.sessionId;
        } catch {
          return undefined;
        }
      })();
      const stageMeta = (stage as InternalStageContext).__modelFallbackMeta?.() ?? {};
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
    const prepared = prepareDirectWorktrees(
      [{ ...options, name }],
      { ...options, worktree: true },
      `${input.runId}-${name}-${crypto.randomUUID()}`,
      name,
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

  const chain = async (steps: readonly WorkflowTaskStep[], options: WorkflowChainOptions = {}): Promise<WorkflowTaskResult[]> => {
    input.exit.throwIfWorkflowExitSelected();
    const results: WorkflowTaskResult[] = [];
    for (let index = 0; index < steps.length; index += 1) {
      input.exit.throwIfWorkflowExitSelected();
      const step = steps[index]!;
      const explicitPrevious = taskPrevious(step);
      const previous = explicitPrevious ?? (index > 0 ? results[index - 1] : undefined);
      const prompt = replaceTaskPlaceholder(chainStepPrompt(step, index), options.task ?? "");
      results.push(await task(step.name, taskWithSharedDefaults(taskOptionsFromStep(step, prompt, previous), options)));
    }
    return results;
  };

  const parallel = async (steps: readonly WorkflowTaskStep[], options: WorkflowParallelOptions = {}): Promise<WorkflowTaskResult[]> => {
    input.exit.throwIfWorkflowExitSelected();
    const fallback = parallelFallbackTask(steps, options);
    const failFastEnabled = options.failFast !== false;
    const parallelScope: ParallelFailFastScope = {
      failed: false,
      activeStages: new Map<string, ParallelFailFastStage>(),
      parentIds: Object.freeze(input.tracker.currentParents()),
    };
    return mapParallelSteps(steps, options.concurrency, options.failFast, async (step) => {
      input.exit.throwIfWorkflowExitSelected();
      const prompt = replaceTaskPlaceholder(step.prompt ?? step.task ?? fallback, options.task ?? fallback);
      return await task(step.name, taskWithSharedDefaults(taskOptionsFromStep(step, prompt, taskPrevious(step)), options), parallelScope);
    }, (error) => {
      if (!failFastEnabled) return;
      parallelScope.failed = true;
      parallelScope.firstFailure = error;
      for (const stage of parallelScope.activeStages.values()) stage.skip();
    }, {
      beforeDequeue: input.exit.throwIfWorkflowExitSelected,
      beforeMap: input.exit.throwIfWorkflowExitSelected,
      isControlSignal: (error) => findWorkflowExitSignal(error, input.exit.exitScope) !== undefined,
    });
  };

  return { task, chain, parallel };
}
