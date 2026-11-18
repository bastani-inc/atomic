import { randomUUID } from "node:crypto";
import { type FanOutForkPoints, launchForkSourceOf, withLaunchForkEntry } from "../../durable/stage-fork-point.js";
import { findWorkflowExitSignal } from "../../runs/foreground/executor-abort.js";
import { mapParallelSteps } from "../../runs/foreground/executor-direct-helpers.js";
import {
	parallelFallbackTask,
	replaceTaskPlaceholder,
	taskOptionsFromStep,
	taskPrevious,
	taskWithSharedDefaults,
	type WorkflowTaskExecutionOptions,
} from "../../runs/foreground/executor-task-prompts.js";
import type { ParallelFailFastScope, ParallelFailFastStage } from "../../runs/foreground/executor-types.js";
import { normalizeAutoGroupSentinel } from "../../shared/intercom-group.js";
import { liveStageSessionLeaf } from "../../shared/live-stage-sessions.js";
import { validateStepsReleaseWhenWaiting } from "../../shared/stage-wait.js";
import type { WorkflowParallelOptions, WorkflowTaskResult, WorkflowTaskStep } from "../../shared/types.js";
import { WorkflowBudgetExceededError } from "../run-budget.js";
import type { EngineRuntime } from "../runtime.js";
import type { WorkflowTaskPrimitive } from "./task.js";

export function createParallelPrimitive(input: {
	readonly runtime: EngineRuntime;
	readonly task: WorkflowTaskPrimitive;
	/** Records where the sources of a parallel's forked steps were at launch, before any step is scheduled. */
	readonly forkPoints?: FanOutForkPoints;
}): (steps: readonly WorkflowTaskStep[], options?: WorkflowParallelOptions) => Promise<WorkflowTaskResult[]> {
	return async (
		steps: readonly WorkflowTaskStep[],
		options: WorkflowParallelOptions = {},
	): Promise<WorkflowTaskResult[]> => {
		input.runtime.exit.throwIfWorkflowExitSelected();
		validateStepsReleaseWhenWaiting(steps, options.releaseWhenWaiting);
		// Normalize both authored and agent-serialized sentinels before deciding
		// whether this invocation needs one shared auto-group UUID.
		const normalizeGroup = <T extends { group?: string | true }>(value: T): T =>
			value.group === undefined ? value : { ...value, group: normalizeAutoGroupSentinel(value.group) };
		const normalizedOptions = normalizeGroup(options);
		const normalizedSteps = steps.map(normalizeGroup);
		const needsAutoGroup = normalizedOptions.group === true || normalizedSteps.some((step) => step.group === true);
		const autoGroup = needsAutoGroup ? randomUUID() : undefined;
		const resolveAutoGroup = <T extends { group?: string | true }>(value: T): T =>
			value.group === true && autoGroup ? { ...value, group: autoGroup } : value;
		const resolvedOptions = resolveAutoGroup(normalizedOptions);
		const resolvedSteps = normalizedSteps.map(resolveAutoGroup);
		const fallback = parallelFallbackTask(resolvedSteps, resolvedOptions);
		const stepOptions = (step: WorkflowTaskStep): WorkflowTaskExecutionOptions =>
			taskWithSharedDefaults(
				taskOptionsFromStep(
					step,
					replaceTaskPlaceholder(step.prompt ?? step.task ?? fallback, resolvedOptions.task ?? fallback),
					taskPrevious(step),
				),
				resolvedOptions,
			);
		// One fork point for the whole parallel: a step that waits for a slot, or starts after the run resumed, forks
		// where its source was now (#5481).
		const launchedSteps = resolvedSteps.map((step) => ({ ...step }));
		const forkSources = new Map(launchedSteps.map((step) => [step, launchForkSourceOf(stepOptions(step))]));
		const sourceIds = [...new Set([...forkSources.values()].filter((id): id is string => id !== undefined))];
		const launchEntries =
			sourceIds.length === 0
				? new Map<string, string>()
				: await (input.forkPoints ?? liveForkPoints)(
						`parallel:${resolvedSteps.map((step) => step.name).join(",")}`,
						sourceIds,
					);
		const failFastEnabled = resolvedOptions.failFast !== false;
		const parallelParentIds = Object.freeze(input.runtime.tracker.currentParents());
		const parallelScope: ParallelFailFastScope = {
			failed: false,
			activeStages: new Map<string, ParallelFailFastStage>(),
			parentIds: parallelParentIds,
		};
		const stageIdsBeforeParallel = new Set(
			input.runtime.activeStore.run(input.runtime.runId)?.stages.map((stage) => stage.id) ?? [],
		);
		const everyStepCompleted = (): boolean => {
			const run = input.runtime.activeStore.run(input.runtime.runId);
			if (run === undefined) return false;
			const completed = run.stages.filter(
				(stage) =>
					stage.status === "completed" &&
					!stageIdsBeforeParallel.has(stage.id) &&
					stage.parentIds.length === parallelParentIds.length &&
					stage.parentIds.every((parentId, index) => parentId === parallelParentIds[index]),
			);
			return resolvedSteps.every((step) => {
				const index = completed.findIndex((stage) => stage.name === step.name);
				if (index < 0) return false;
				completed.splice(index, 1);
				return true;
			});
		};

		return mapParallelSteps(
			launchedSteps,
			resolvedOptions.concurrency,
			resolvedOptions.failFast,
			async (step) => {
				input.runtime.exit.throwIfWorkflowExitSelected();
				return await input.task(
					step.name,
					withLaunchForkEntry(stepOptions(step), launchEntries.get(forkSources.get(step) ?? "")),
					parallelScope,
				);
			},
			async (error) => {
				if (!failFastEnabled) return;
				parallelScope.failed = true;
				parallelScope.firstFailure = error;
				await Promise.all([...parallelScope.activeStages.values()].map((stage) => stage.skip()));
			},
			{
				beforeDequeue: input.runtime.exit.throwIfWorkflowExitSelected,
				beforeMap: input.runtime.exit.throwIfWorkflowExitSelected,
				isControlSignal: (error) => findWorkflowExitSignal(error, input.runtime.exit.exitScope) !== undefined,
				selectSettledFailure: (failures) => {
					if (
						!everyStepCompleted() ||
						!failures.every((failure) => failure.error instanceof WorkflowBudgetExceededError)
					)
						return undefined;
					return failures.reduce((selected, failure) => (failure.index < selected.index ? failure : selected))
						.error;
				},
			},
		);
	};
}

/** Fork points read from the sources open in this process, for a parallel outside a durable run. */
async function liveForkPoints(
	_launchName: string,
	sessionIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
	return new Map(
		sessionIds.flatMap((sessionId) => {
			const entryId = liveStageSessionLeaf(sessionId);
			return entryId === undefined ? [] : [[sessionId, entryId] as const];
		}),
	);
}
