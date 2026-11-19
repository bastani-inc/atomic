import { randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";
import { type SessionForkCut, type SessionStore, watchSessionFork } from "@bastani/atomic";
import { findWorkflowExitSignal } from "../../runs/foreground/executor-abort.js";
import { mapParallelSteps } from "../../runs/foreground/executor-direct-helpers.js";
import {
	parallelFallbackTask,
	replaceTaskPlaceholder,
	taskOptionsFromStep,
	taskPrevious,
	taskWithSharedDefaults,
} from "../../runs/foreground/executor-task-prompts.js";
import type { ParallelFailFastScope, ParallelFailFastStage } from "../../runs/foreground/executor-types.js";
import { normalizeAutoGroupSentinel } from "../../shared/intercom-group.js";
import { validateStepsReleaseWhenWaiting } from "../../shared/stage-wait.js";
import type { WorkflowParallelOptions, WorkflowTaskResult, WorkflowTaskStep } from "../../shared/types.js";
import { WorkflowBudgetExceededError } from "../run-budget.js";
import type { EngineRuntime } from "../runtime.js";
import type { WorkflowTaskPrimitive } from "./task.js";

const sourceFields = [
	"context",
	"forkFromSessionId",
	"forkFromEntryId",
	"sessionStore",
	"sessionManager",
	"sessionDir",
] as const;

/** Only an explicitly shared, plain source is known without inspecting a queued task or consulting its host. */
export function sharedReplayForkCut(
	steps: readonly WorkflowTaskStep[],
	options: WorkflowParallelOptions | undefined,
): SessionForkCut | undefined {
	if (!options || isProxy(options) || !Array.isArray(steps) || isProxy(steps) || steps.length === 0) return undefined;
	const data = (key: keyof WorkflowParallelOptions) => {
		const field = Object.getOwnPropertyDescriptor(options, key);
		return field?.enumerable && "value" in field ? field.value : undefined;
	};
	if (data("context") !== "fork") return undefined;
	const entry = Object.getOwnPropertyDescriptor(options, "forkFromEntryId");
	if (entry?.enumerable && (!("value" in entry) || entry.value !== undefined)) return undefined;
	const id = data("forkFromSessionId");
	const store = data("sessionStore");
	return typeof id === "string" && store !== null && typeof store === "object"
		? watchSessionFork(store as SessionStore, id)
		: undefined;
}

export function createParallelPrimitive(input: {
	readonly runtime: EngineRuntime;
	readonly task: WorkflowTaskPrimitive;
}) {
	return async (
		steps: readonly WorkflowTaskStep[],
		options: WorkflowParallelOptions = {},
		forkCut?: SessionForkCut,
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
		const failFastEnabled = resolvedOptions.failFast !== false;
		const parallelParentIds = Object.freeze(input.runtime.tracker.currentParents());
		const parallelScope: ParallelFailFastScope = {
			failed: false,
			activeStages: new Map<string, ParallelFailFastStage>(),
			parentIds: parallelParentIds,
		};
		// These tasks still observe the same live fail-fast state as steps that supply their own source.
		const sharedSourceScope: ParallelFailFastScope | undefined =
			forkCut && Object.assign(Object.create(parallelScope), { forkCut });
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
			resolvedSteps,
			resolvedOptions.concurrency,
			resolvedOptions.failFast,
			async (step) => {
				input.runtime.exit.throwIfWorkflowExitSelected();
				const prompt = replaceTaskPlaceholder(
					step.prompt ?? step.task ?? fallback,
					resolvedOptions.task ?? fallback,
				);
				const own = taskOptionsFromStep(step, prompt, taskPrevious(step));
				return await input.task(
					step.name,
					taskWithSharedDefaults(own, resolvedOptions),
					sharedSourceScope && !sourceFields.some((key) => Object.hasOwn(own, key))
						? sharedSourceScope
						: parallelScope,
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
