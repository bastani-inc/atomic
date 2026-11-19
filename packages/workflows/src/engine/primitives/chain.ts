import { reserveTaskReplayKey } from "../../durable/stage-primitive.js";
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

export function createChainPrimitive(input: {
	readonly runtime: EngineRuntime;
	readonly task: WorkflowTaskPrimitive;
	/**
	 * The run's replay keys. A chain launched in a durable run reserves its steps' keys when it is launched, so a step
	 * that starts when the one before it ends replays its own result, also while another chain with the same step names
	 * runs (#5481).
	 */
	readonly nextReplayKey?: (name: string) => string;
}): (steps: readonly WorkflowTaskStep[], options?: WorkflowChainOptions) => Promise<WorkflowTaskResult[]> {
	return async (
		steps: readonly WorkflowTaskStep[],
		options: WorkflowChainOptions = {},
	): Promise<WorkflowTaskResult[]> => {
		input.runtime.exit.throwIfWorkflowExitSelected();
		validateStepsReleaseWhenWaiting(steps, options.releaseWhenWaiting);
		const nextReplayKey = input.nextReplayKey;
		const replayKeys = steps.map((step) =>
			nextReplayKey === undefined ? undefined : reserveTaskReplayKey(nextReplayKey, step.name),
		);
		const results: WorkflowTaskResult[] = [];
		for (let index = 0; index < steps.length; index += 1) {
			input.runtime.exit.throwIfWorkflowExitSelected();
			const step = steps[index]!;
			const explicitPrevious = taskPrevious(step);
			const previous = explicitPrevious ?? (index > 0 ? results[index - 1] : undefined);
			const prompt = replaceTaskPlaceholder(chainStepPrompt(step, index), options.task ?? "");
			results.push(
				await input.task(
					step.name,
					taskWithSharedDefaults(taskOptionsFromStep(step, prompt, previous), options),
					undefined,
					replayKeys[index],
				),
			);
		}
		return results;
	};
}
