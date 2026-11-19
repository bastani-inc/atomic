import { randomUUID } from "node:crypto";
import { durableHash } from "../../durable/durable-hash.js";
import {
	type DurableLaunchRun,
	type ForkPoint,
	launchForkSourceOf,
	recordFanOutForkPoints,
	withForkPoint,
} from "../../durable/stage-fork-point.js";
import { createStageReplayKeyGenerator, reserveTaskReplayKey } from "../../durable/stage-primitive.js";
import { findWorkflowExitSignal } from "../../runs/foreground/executor-abort.js";
import { mapParallelSteps, positiveConcurrency } from "../../runs/foreground/executor-direct-helpers.js";
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
	/**
	 * The run's journal. A parallel launched in it reserves its steps' replay keys, and records where the sources of its
	 * forked steps are, before it starts any step (#5481).
	 */
	readonly durable?: DurableLaunchRun;
	/**
	 * False in a run resumed from a record that has results but no launch-time keys, such as one an earlier release
	 * started: its steps take their replay keys when they start, as they were recorded, so the run finds its results.
	 */
	readonly reservesStepKeys?: boolean;
}): (steps: readonly WorkflowTaskStep[], options?: WorkflowParallelOptions) => Promise<WorkflowTaskResult[]> {
	// Keep the journal format, but count fan-outs separately: any string is a valid authored stage name.
	const nextFanOutKey = createStageReplayKeyGenerator(input.runtime.runId);
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
		// What names this launch is fixed now, before its fork points are recorded: its graph parents and the stages
		// before it, each step's replay key and the key of its fork point record. A stage that settles while the record
		// is written, a step that waits for a slot, and another parallel launched meanwhile cannot change them, so each
		// step replays its own result and forks at this launch's point after the run resumes (#5481).
		const parallelParentIds = Object.freeze(input.runtime.tracker.currentParents());
		const stageIdsBeforeParallel = new Set(
			input.runtime.activeStore.run(input.runtime.runId)?.stages.map((stage) => stage.id) ?? [],
		);
		const launchedSteps = resolvedSteps.map((step) => ({ ...step }));
		const durable = input.durable;
		// One fork point for the whole parallel: a step that waits for a slot, or starts after the run resumed, forks
		// where its source was now. No step starts before the point is recorded.
		const forkSources = new Map(launchedSteps.map((step) => [step, launchForkSourceOf(stepOptions(step))]));
		const sourceIds = [...new Set([...forkSources.values()].filter((id): id is string => id !== undefined))];
		// An older run took keys as workers acquired slots. Before the fork-record await, claim only the
		// slots the parallel would have filled synchronously; queued steps still take their keys at dequeue.
		const reserveCount =
			input.reservesStepKeys !== false
				? launchedSteps.length
				: sourceIds.length === 0
					? 0
					: (positiveConcurrency(resolvedOptions.concurrency) ?? launchedSteps.length);
		const replayKeys = new Map(
			durable === undefined
				? []
				: launchedSteps
						.slice(0, reserveCount)
						.map((step) => [step, reserveTaskReplayKey(durable.nextReplayKey, step.name)] as const),
		);
		const forkPoints =
			sourceIds.length === 0
				? new Map<string, ForkPoint>()
				: durable === undefined
					? liveForkPoints(sourceIds)
					: await recordFanOutForkPoints(
							durable,
							// Named by its steps, hashed so a parallel of many or long step names gets a short record key.
							nextFanOutKey(`parallel:${durableHash(resolvedSteps.map((step) => step.name))}`),
							sourceIds,
						);
		const failFastEnabled = resolvedOptions.failFast !== false;
		const parallelScope: ParallelFailFastScope = {
			failed: false,
			activeStages: new Map<string, ParallelFailFastStage>(),
			parentIds: parallelParentIds,
		};
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
				const source = forkSources.get(step);
				return await input.task(
					step.name,
					withForkPoint(stepOptions(step), source === undefined ? undefined : forkPoints.get(source)),
					parallelScope,
					replayKeys.get(step),
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
function liveForkPoints(sessionIds: readonly string[]): ReadonlyMap<string, ForkPoint> {
	return new Map(
		sessionIds.flatMap((sessionId) => {
			const entryId = liveStageSessionLeaf(sessionId);
			return entryId === undefined ? [] : [[sessionId, entryId] as const];
		}),
	);
}
