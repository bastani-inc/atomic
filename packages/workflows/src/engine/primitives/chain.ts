import type { WorkflowChainOptions, WorkflowTaskResult, WorkflowTaskStep } from "../../shared/types.js";
import type { EngineRuntime } from "../runtime.js";
import type { WorkflowTaskPrimitive } from "./task.js";
import {
  chainStepPrompt,
  replaceTaskPlaceholder,
  taskOptionsFromStep,
  taskPrevious,
  taskWithSharedDefaults,
} from "../../runs/foreground/executor-task-prompts.js";

export function createChainPrimitive(input: {
  readonly runtime: EngineRuntime;
  readonly task: WorkflowTaskPrimitive;
}): (steps: readonly WorkflowTaskStep[], options?: WorkflowChainOptions) => Promise<WorkflowTaskResult[]> {
  return async (steps: readonly WorkflowTaskStep[], options: WorkflowChainOptions = {}): Promise<WorkflowTaskResult[]> => {
    input.runtime.exit.throwIfWorkflowExitSelected();
    const results: WorkflowTaskResult[] = [];
    for (let index = 0; index < steps.length; index += 1) {
      input.runtime.exit.throwIfWorkflowExitSelected();
      const step = steps[index]!;
      const explicitPrevious = taskPrevious(step);
      const previous = explicitPrevious ?? (index > 0 ? results[index - 1] : undefined);
      const prompt = replaceTaskPlaceholder(chainStepPrompt(step, index), options.task ?? "");
      results.push(await input.task(step.name, taskWithSharedDefaults(taskOptionsFromStep(step, prompt, previous), options)));
    }
    return results;
  };
}
