import * as path from "node:path";
import {
	aggregateParallelOutputs,
	createParallelDirs,
	resolveParallelBehaviors,
	suppressProgressForReadOnlyTask,
	type DynamicParallelStep,
	type ParallelStep,
	type ParallelTaskResult,
} from "../../shared/settings.ts";
import { getSingleResultOutput } from "../../shared/utils.ts";
import { buildChainSummary } from "../../shared/formatters.ts";
import { buildChainExecutionDetails, buildChainExecutionErrorResult } from "./chain-execution-details.ts";
import { ensureParallelProgressFile, runParallelChainTasks } from "./chain-execution-parallel-runner.ts";
import { validateFileOnlyOutputMode } from "../shared/single-output.ts";
import {
	collectDynamicResults,
	DynamicFanoutError,
	materializeDynamicParallelStep,
	validateDynamicCollection,
	type DynamicCollectedResult,
} from "../shared/dynamic-fanout.ts";
import type { ChainExecutionMutableState, ChainExecutionResult, ChainRuntimeContext } from "./chain-execution-types.ts";

export async function runDynamicParallelChainStep(input: {
	context: ChainRuntimeContext;
	state: ChainExecutionMutableState;
	step: DynamicParallelStep;
	stepIndex: number;
}): Promise<ChainExecutionResult | undefined> {
	const { context, state, step, stepIndex } = input;
	let materialized: ReturnType<typeof materializeDynamicParallelStep>;
	try {
		materialized = materializeDynamicParallelStep(step, state.outputs, stepIndex, { maxItems: context.params.dynamicFanoutMaxItems });
	} catch (error) {
		const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
		state.dynamicGroupStatuses[stepIndex] = { status: "failed", error: message };
		return buildChainExecutionErrorResult(message, context.makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: state.globalTaskIndex }));
	}

	state.dynamicChildren[stepIndex] = materialized.items.map((item, itemIndex) => ({
		agent: step.parallel.agent,
		label: materialized.parallel[itemIndex]?.label,
		flatIndex: state.globalTaskIndex + itemIndex,
		itemKey: item.key,
		structured: Boolean(step.parallel.outputSchema),
	}));

	if (materialized.parallel.length === 0) {
		const collection: DynamicCollectedResult[] = [];
		try {
			validateDynamicCollection(step.collect.outputSchema, collection);
		} catch (error) {
			const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
			state.dynamicGroupStatuses[stepIndex] = { status: "failed", error: message };
			return buildChainExecutionErrorResult(message, context.makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: state.globalTaskIndex }));
		}
		state.outputs[step.collect.as] = {
			text: JSON.stringify(collection),
			structured: collection,
			agent: step.parallel.agent,
			stepIndex,
		};
		state.dynamicGroupStatuses[stepIndex] = { status: "completed" };
		state.prev = "Dynamic fanout produced 0 results.";
		return undefined;
	}

	const dynamicParallelStep: ParallelStep = {
		parallel: materialized.parallel,
		concurrency: step.concurrency,
		failFast: step.failFast,
	};
	const parallelTemplates = materialized.parallel.map((task) => task.task ?? "{previous}");
	const parallelBehaviors = resolveParallelBehaviors(dynamicParallelStep.parallel, context.agents, stepIndex, context.chainSkills)
		.map((behavior, taskIndex) => suppressProgressForReadOnlyTask(behavior, parallelTemplates[taskIndex] ?? dynamicParallelStep.parallel[taskIndex]?.task, context.originalTask));

	for (let taskIndex = 0; taskIndex < dynamicParallelStep.parallel.length; taskIndex++) {
		const behavior = parallelBehaviors[taskIndex]!;
		const outputPath = typeof behavior.output === "string"
			? (path.isAbsolute(behavior.output) ? behavior.output : path.join(context.chainDir, behavior.output))
			: undefined;
		const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Dynamic chain step ${stepIndex + 1} item ${taskIndex + 1} (${dynamicParallelStep.parallel[taskIndex]!.agent})`);
		if (validationError) {
			state.dynamicGroupStatuses[stepIndex] = { status: "failed", error: validationError };
			return buildChainExecutionErrorResult(validationError, context.makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: state.globalTaskIndex + taskIndex }));
		}
	}

	state.progressCreated = ensureParallelProgressFile(context.chainDir, state.progressCreated, parallelBehaviors);
	createParallelDirs(context.chainDir, stepIndex, dynamicParallelStep.parallel.length, dynamicParallelStep.parallel.map((task) => task.agent));
	const parallelResults = await runParallelChainTasks({
		step: dynamicParallelStep,
		parallelTemplates,
		parallelBehaviors,
		agents: context.agents,
		stepIndex,
		availableModels: context.availableModels,
		knownModelProviders: context.knownModelProviders,
		chainDir: context.chainDir,
		prev: state.prev,
		originalTask: context.originalTask,
		ctx: context.ctx,
		intercomEvents: context.intercomEvents,
		cwd: context.cwd,
		runId: context.runId,
		globalTaskIndex: state.globalTaskIndex,
		sessionDirForIndex: context.sessionDirForIndex,
		sessionFileForIndex: context.sessionFileForIndex,
		shareEnabled: context.shareEnabled,
		artifactConfig: context.artifactConfig,
		artifactsDir: context.artifactsDir,
		signal: context.signal,
		onUpdate: context.onUpdate,
		results: state.results,
		allProgress: state.allProgress,
		outputs: state.outputs,
		chainAgents: context.chainAgents,
		chainSteps: context.chainSteps,
		totalSteps: context.totalSteps,
		dynamicChildren: state.dynamicChildren,
		dynamicGroupStatuses: state.dynamicGroupStatuses,
		controlConfig: context.controlConfig,
		onControlEvent: context.onControlEvent,
		childIntercomTarget: context.childIntercomTarget,
		orchestratorIntercomTarget: context.orchestratorIntercomTarget,
		foregroundControl: context.foregroundControl,
		nestedRoute: context.params.nestedRoute,
		maxSubagentDepth: context.params.maxSubagentDepth,
		workflowStageSubagentGuard: context.params.workflowStageSubagentGuard,
		runSync: context.executeRunSync,
	});
	state.globalTaskIndex += dynamicParallelStep.parallel.length;
	for (const result of parallelResults) {
		state.results.push(result);
		if (result.progress) state.allProgress.push(result.progress);
		if (result.artifactPaths) state.allArtifactPaths.push(result.artifactPaths);
	}
	const collected = collectDynamicResults(step, materialized.items, parallelResults);
	const baseFlatIndex = state.globalTaskIndex - dynamicParallelStep.parallel.length;

	const interruptedIndexInStep = parallelResults.findIndex((result) => result.interrupted);
	const interrupted = interruptedIndexInStep >= 0 ? parallelResults[interruptedIndexInStep] : undefined;
	if (interrupted) {
		return {
			content: [{ type: "text", text: `Chain paused after interrupt at step ${stepIndex + 1} (${interrupted.agent}). Waiting for explicit next action.` }],
			details: buildChainExecutionDetails(context.makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: baseFlatIndex + interruptedIndexInStep })),
		};
	}
	const detachedIndexInStep = parallelResults.findIndex((result) => result.detached);
	const detached = detachedIndexInStep >= 0 ? parallelResults[detachedIndexInStep] : undefined;
	if (detached) {
		return {
			content: [{ type: "text", text: `Chain detached for intercom coordination at step ${stepIndex + 1} (${detached.agent}). Reply to the supervisor request first. After the child exits, start a fresh follow-up if needed.` }],
			details: buildChainExecutionDetails(context.makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: baseFlatIndex + detachedIndexInStep })),
		};
	}
	const failures = parallelResults.map((result, originalIndex) => ({ ...result, originalIndex })).filter((result) => result.exitCode !== 0 && result.exitCode !== -1);
	if (failures.length > 0) {
		const failureSummary = failures
			.map((failure) => `- Item ${failure.originalIndex + 1} (${failure.agent}, key ${materialized.items[failure.originalIndex]?.key ?? failure.originalIndex}): ${failure.error || "failed"}`)
			.join("\n");
		const errorMsg = `Dynamic step ${stepIndex + 1} failed:\n${failureSummary}`;
		state.dynamicGroupStatuses[stepIndex] = { status: "failed", error: errorMsg };
		const summary = buildChainSummary(context.chainSteps, state.results, context.chainDir, "failed", { index: stepIndex, error: errorMsg });
		return {
			content: [{ type: "text", text: summary }],
			isError: true,
			details: buildChainExecutionDetails(context.makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: baseFlatIndex + failures[0]!.originalIndex })),
		};
	}
	try {
		validateDynamicCollection(step.collect.outputSchema, collected);
	} catch (error) {
		const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
		state.dynamicGroupStatuses[stepIndex] = { status: "failed", error: message };
		return buildChainExecutionErrorResult(message, context.makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: baseFlatIndex }));
	}
	state.outputs[step.collect.as] = {
		text: JSON.stringify(collected),
		structured: collected,
		agent: step.parallel.agent,
		stepIndex,
	};
	state.dynamicGroupStatuses[stepIndex] = { status: "completed" };
	const taskResults: ParallelTaskResult[] = parallelResults.map((result, index) => ({
		agent: result.agent,
		taskIndex: index,
		output: getSingleResultOutput(result),
		exitCode: result.exitCode,
		error: result.error,
	}));
	state.prev = aggregateParallelOutputs(taskResults, (index, agent) => `=== Dynamic Item ${index + 1} (${agent}, key ${materialized.items[index]?.key ?? index}) ===`);
	return undefined;
}
