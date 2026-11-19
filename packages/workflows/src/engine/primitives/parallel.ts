import { randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";
import { durableHash } from "../../durable/durable-hash.js";
import {
	type DurableLaunchRun,
	type LaunchForkSource,
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
import { validateStepsReleaseWhenWaiting } from "../../shared/stage-wait.js";
import type {
	StageOptions,
	WorkflowParallelOptions,
	WorkflowTaskResult,
	WorkflowTaskStep,
} from "../../shared/types.js";
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
		let autoGroup: string | undefined;
		const sources = parallelForkSources(steps, options);
		const fallback = parallelFallbackTask(steps, options);
		const stepOptions = (step: WorkflowTaskStep): WorkflowTaskExecutionOptions => {
			const task = taskWithSharedDefaults(
				taskOptionsFromStep(
					step,
					replaceTaskPlaceholder(step.prompt ?? step.task ?? fallback, options.task ?? fallback),
					taskPrevious(step),
				),
				options,
			);
			const authoredGroup = step.group ?? task.group;
			if (authoredGroup === undefined) return task;
			const group = normalizeAutoGroupSentinel(authoredGroup);
			if (group !== true) return { ...task, group };
			autoGroup ??= randomUUID();
			return { ...task, group: autoGroup };
		};
		// What names this launch is fixed now, before its fork points are recorded: its graph parents and the stages
		// before it, each step's replay key and the key of its fork point record. A stage that settles while the record
		// is written, a step that waits for a slot, and another parallel launched meanwhile cannot change them, so each
		// step replays its own result and forks at this launch's point after the run resumes (#5481).
		const parallelParentIds = Object.freeze(input.runtime.tracker.currentParents());
		const stageIdsBeforeParallel = new Set(
			input.runtime.activeStore.run(input.runtime.runId)?.stages.map((stage) => stage.id) ?? [],
		);
		const durable = input.durable;
		const hasForks = sources.all.length > 0;
		const reservesKeys = input.reservesStepKeys !== false;
		// In an older fork launch only the slots filled now may claim before the write; queued steps still
		// take their keys at dequeue. A marked launch reserves one key per occurrence, even for repeated step objects.
		const reserveCount = reservesKeys
			? steps.length
			: hasForks
				? (positiveConcurrency(options.concurrency) ?? steps.length)
				: 0;
		const replayKeys =
			durable === undefined || reserveCount === 0
				? undefined
				: steps.slice(0, reserveCount).map((step) => reserveTaskReplayKey(durable.nextReplayKey, step.name));
		const forkRecord = hasForks
			? recordFanOutForkPoints(
					durable,
					nextFanOutKey(`parallel:${durableHash(steps.map((step) => step.name))}`),
					sources.all,
				)
			: undefined;
		// In an older run a cached worker must settle and admit its successor just as it did before fork records.
		// Start its normal task path synchronously; only a worker that needs to run live waits for the record.
		const forkPoints = forkRecord !== undefined && reservesKeys ? await forkRecord : undefined;
		const failFastEnabled = options.failFast !== false;
		const legacyForkRecord = reservesKeys ? undefined : forkRecord;
		let recordFailure: unknown;
		legacyForkRecord?.catch((error: unknown) => {
			recordFailure = error;
		});
		const parallelScope: ParallelFailFastScope = {
			failed: false,
			activeStages: new Map<string, ParallelFailFastStage>(),
			parentIds: parallelParentIds,
			forkPointsBeforeLiveTask: legacyForkRecord,
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
			return steps.every((step) => {
				const index = completed.findIndex((stage) => stage.name === step.name);
				if (index < 0) return false;
				completed.splice(index, 1);
				return true;
			});
		};

		const tasks = mapParallelSteps(
			steps,
			options.concurrency,
			options.failFast,
			async (step, index) => {
				input.runtime.exit.throwIfWorkflowExitSelected();
				const task = stepOptions(step);
				const source = sources.find(task);
				const launched =
					source === undefined
						? task
						: legacyForkRecord === undefined
							? withForkPoint(task, forkPoints?.get(source.slot))
							: { ...task, durableForkPoint: async () => (await legacyForkRecord).get(source.slot) };
				return await input.task(step.name, launched, parallelScope, replayKeys?.[index]);
			},
			async (error) => {
				if (!failFastEnabled) return;
				parallelScope.failed = true;
				parallelScope.firstFailure = error;
				await Promise.all([...parallelScope.activeStages.values()].map((stage) => stage.skip()));
			},
			{
				beforeDequeue: () => {
					// A failed fork record stops the whole launch, even with failFast: false.
					if (recordFailure !== undefined) throw recordFailure;
					input.runtime.exit.throwIfWorkflowExitSelected();
				},
				beforeMap: input.runtime.exit.throwIfWorkflowExitSelected,
				isControlSignal: (error) =>
					(recordFailure !== undefined && error === recordFailure) ||
					findWorkflowExitSignal(error, input.runtime.exit.exitScope) !== undefined,
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
		// Even an all-cached replay keeps its launch point for a future live restart.
		return legacyForkRecord === undefined ? tasks : (await Promise.all([tasks, legacyForkRecord]))[0];
	};
}

const sourceFields = [
	"context",
	"forkFromSessionId",
	"forkFromEntryId",
	"forkFromEmptySource",
	"sessionStore",
	"sessionManager",
	"sessionDir",
	"cwd",
	"agentDir",
	"settingsManager",
] as const;

/** Inspect only declarative source coordinates. A computed option is evaluated by the worker, never by the queue. */
function parallelForkSources(steps: readonly WorkflowTaskStep[], defaults: WorkflowParallelOptions) {
	const all: LaunchForkSource[] = [];
	const bySession = new Map<string, LaunchForkSource[]>();
	const find = (options: StageOptions) => {
		const id = launchForkSourceOf(options);
		return id === undefined ? undefined : bySession.get(id)?.find((s) => sameSourceStore(s.options, options));
	};
	for (const [slot, step] of steps.entries()) {
		if (isProxy(step) || isProxy(defaults)) continue;
		const data: Partial<Record<(typeof sourceFields)[number], unknown>> = {};
		let computed = false;
		for (const key of sourceFields) {
			let field = Object.getOwnPropertyDescriptor(step, key);
			if (!field?.enumerable || ("value" in field && field.value === undefined))
				field = Object.getOwnPropertyDescriptor(defaults, key);
			if (key === "context" && (!field?.enumerable || !("value" in field) || field.value !== "fork")) break;
			if (!field?.enumerable) continue;
			if (!("value" in field)) {
				computed = true;
				break;
			}
			data[key] = field.value;
		}
		if (computed) continue;
		const options: StageOptions = data as StageOptions;
		const sessionId = launchForkSourceOf(options);
		if (sessionId === undefined || find(options) !== undefined) continue;
		const source = { slot, sessionId, options };
		all.push(source);
		const group = bySession.get(sessionId);
		if (group) group.push(source);
		else bySession.set(sessionId, [source]);
	}
	return { all, find };
}

function sameSourceStore(a: StageOptions, b: StageOptions): boolean {
	if (a.sessionStore || b.sessionStore) return a.sessionStore === b.sessionStore;
	if (a.sessionManager || b.sessionManager) return a.sessionManager === b.sessionManager;
	if (a.sessionDir !== undefined || b.sessionDir !== undefined) return a.sessionDir === b.sessionDir;
	return a.cwd === b.cwd && a.agentDir === b.agentDir && a.settingsManager === b.settingsManager;
}
