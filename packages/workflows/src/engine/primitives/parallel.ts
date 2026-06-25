import type { WorkflowParallelOptions, WorkflowTaskResult, WorkflowTaskStep } from "../../shared/types.js";
import type { EngineRuntime } from "../runtime.js";
import type { WorkflowTaskPrimitive } from "./task.js";
import type { ParallelFailFastScope, ParallelFailFastStage } from "../../runs/foreground/executor-types.js";
import { findWorkflowExitSignal } from "../../runs/foreground/executor-abort.js";
import { mapParallelSteps } from "../../runs/foreground/executor-direct-helpers.js";
import {
  parallelFallbackTask,
  replaceTaskPlaceholder,
  taskOptionsFromStep,
  taskPrevious,
  taskWithSharedDefaults,
} from "../../runs/foreground/executor-task-prompts.js";

export function createParallelPrimitive(input: {
  readonly runtime: EngineRuntime;
  readonly task: WorkflowTaskPrimitive;
}): (steps: readonly WorkflowTaskStep[], options?: WorkflowParallelOptions) => Promise<WorkflowTaskResult[]> {
  return async (steps: readonly WorkflowTaskStep[], options: WorkflowParallelOptions = {}): Promise<WorkflowTaskResult[]> => {
    input.runtime.exit.throwIfWorkflowExitSelected();
    const fallback = parallelFallbackTask(steps, options);
    const failFastEnabled = options.failFast !== false;
    const parallelScope: ParallelFailFastScope = {
      failed: false,
      activeStages: new Map<string, ParallelFailFastStage>(),
      parentIds: Object.freeze(input.runtime.tracker.currentParents()),
    };
    return mapParallelSteps(steps, options.concurrency, options.failFast, async (step) => {
      input.runtime.exit.throwIfWorkflowExitSelected();
      const prompt = replaceTaskPlaceholder(step.prompt ?? step.task ?? fallback, options.task ?? fallback);
      return await input.task(
        step.name,
        taskWithSharedDefaults(taskOptionsFromStep(step, prompt, taskPrevious(step)), options),
        parallelScope,
      );
    }, (error) => {
      if (!failFastEnabled) return;
      parallelScope.failed = true;
      parallelScope.firstFailure = error;
      for (const stage of parallelScope.activeStages.values()) stage.skip();
    }, {
      beforeDequeue: input.runtime.exit.throwIfWorkflowExitSelected,
      beforeMap: input.runtime.exit.throwIfWorkflowExitSelected,
      isControlSignal: (error) => findWorkflowExitSignal(error, input.runtime.exit.exitScope) !== undefined,
    });
  };
}
