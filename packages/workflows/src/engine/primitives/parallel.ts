import { randomUUID } from "node:crypto";
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
    // Auto-group (group: true) mints ONE shared UUID for the whole parallel set so
    // every item that opted into auto lands in the SAME isolated intercom group.
    const needsAutoGroup = options.group === true || steps.some((step) => step.group === true);
    const autoGroup = needsAutoGroup ? randomUUID() : undefined;
    const resolveAutoGroup = <T extends { group?: string | true }>(value: T): T =>
      value.group === true && autoGroup ? { ...value, group: autoGroup } : value;
    const resolvedOptions = resolveAutoGroup(options);
    const resolvedSteps = steps.map(resolveAutoGroup);
    const fallback = parallelFallbackTask(resolvedSteps, resolvedOptions);
    const failFastEnabled = options.failFast !== false;
    const parallelScope: ParallelFailFastScope = {
      failed: false,
      activeStages: new Map<string, ParallelFailFastStage>(),
      parentIds: Object.freeze(input.runtime.tracker.currentParents()),
    };
    return mapParallelSteps(resolvedSteps, resolvedOptions.concurrency, resolvedOptions.failFast, async (step) => {
      input.runtime.exit.throwIfWorkflowExitSelected();
      const prompt = replaceTaskPlaceholder(step.prompt ?? step.task ?? fallback, resolvedOptions.task ?? fallback);
      return await input.task(
        step.name,
        taskWithSharedDefaults(taskOptionsFromStep(step, prompt, taskPrevious(step)), resolvedOptions),
        parallelScope,
      );
    }, async (error) => {
      if (!failFastEnabled) return;
      parallelScope.failed = true;
      parallelScope.firstFailure = error;
      await Promise.all([...parallelScope.activeStages.values()].map((stage) => stage.skip()));
    }, {
      beforeDequeue: input.runtime.exit.throwIfWorkflowExitSelected,
      beforeMap: input.runtime.exit.throwIfWorkflowExitSelected,
      isControlSignal: (error) => findWorkflowExitSignal(error, input.runtime.exit.exitScope) !== undefined,
    });
  };
}
