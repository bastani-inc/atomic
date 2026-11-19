import {
	chainStepPrompt,
	replaceTaskPlaceholder,
	taskOptionsFromStep,
	taskPrevious,
	taskWithSharedDefaults,
} from "../../runs/foreground/executor-task-prompts.js";
import { validateStepsReleaseWhenWaiting } from "../../shared/stage-wait.js";
import type { WorkflowChainOptions, WorkflowTaskResult, WorkflowTaskStep } from "../../shared/types.js";
import type { EngineRuntime } from "../runtime.js";
import type { WorkflowTaskPrimitive } from "./task.js";
import type { TaskStepKey } from "./task-step-keys.js";

export function createChainPrimitive(input: {
	readonly runtime: EngineRuntime;
	readonly task: WorkflowTaskPrimitive;
}): (
	steps: readonly WorkflowTaskStep[],
	options?: WorkflowChainOptions,
	stepKey?: TaskStepKey,
) => Promise<WorkflowTaskResult[]> {
	return async (
		steps: readonly WorkflowTaskStep[],
		options: WorkflowChainOptions = {},
		stepKey?: TaskStepKey,
	): Promise<WorkflowTaskResult[]> => {
		input.runtime.exit.throwIfWorkflowExitSelected();
		validateStepsReleaseWhenWaiting(steps, options.releaseWhenWaiting);
		const results: WorkflowTaskResult[] = [];
		for (let index = 0; index < steps.length; index += 1) {
			input.runtime.exit.throwIfWorkflowExitSelected();
			const step = steps[index]!;
			const explicitPrevious = taskPrevious(step);
			const previous = explicitPrevious ?? (index > 0 ? results[index - 1] : undefined);
			const prompt = replaceTaskPlaceholder(chainStepPrompt(step, index), options.task ?? "");
			const name = step.name;
			results.push(
				await input.task(
					name,
					taskWithSharedDefaults(taskOptionsFromStep(step, prompt, previous), options),
					undefined,
					stepKey?.(index, name),
				),
			);
		}
		return results;
	};
}
