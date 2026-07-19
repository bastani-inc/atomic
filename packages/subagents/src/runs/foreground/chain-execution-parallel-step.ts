import * as fs from "node:fs";
import * as path from "node:path";
import {
	aggregateParallelOutputs,
	createParallelDirs,
	resolveParallelBehaviors,
	suppressProgressForReadOnlyTask,
	type ParallelStep,
	type ParallelTaskResult,
} from "../../shared/settings.ts";
import { getSingleResultOutput, resolveChildCwd } from "../../shared/utils.ts";
import { buildChainSummary } from "../../shared/formatters.ts";
import {
	cleanupWorktrees,
	createWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeTaskCwdConflict,
	type WorktreeSetup,
} from "../shared/worktree.ts";
import { outputEntryFromResult } from "../shared/chain-outputs.ts";
import { validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { buildChainExecutionDetails, buildChainExecutionErrorResult } from "./chain-execution-details.ts";
import { appendParallelWorktreeSummary, ensureParallelProgressFile, runParallelChainTasks } from "./chain-execution-parallel-runner.ts";
import type { ChainExecutionMutableState, ChainExecutionResult, ChainRuntimeContext } from "./chain-execution-types.ts";
import { createDetachedCleanupBarrier } from "./detached-cleanup-barrier.ts";

export async function runStaticParallelChainStep(input: {
	context: ChainRuntimeContext;
	state: ChainExecutionMutableState;
	step: ParallelStep;
	stepIndex: number;
	parallelTemplates: string[];
}): Promise<ChainExecutionResult | undefined> {
	const { context, state, step, stepIndex, parallelTemplates } = input;
	const parallelCwd = resolveChildCwd(context.cwd ?? context.ctx.cwd, step.cwd);
	let worktreeSetup: WorktreeSetup | undefined;
	let worktreeCleanupDeferred = false;
	if (step.worktree) {
		const worktreeTaskCwdConflict = findWorktreeTaskCwdConflict(step.parallel, parallelCwd);
		if (worktreeTaskCwdConflict) {
			return buildChainExecutionErrorResult(
				`parallel chain step ${stepIndex + 1}: ${formatWorktreeTaskCwdConflict(worktreeTaskCwdConflict, parallelCwd)}`,
				context.makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: state.globalTaskIndex }),
			);
		}
		try {
			worktreeSetup = createWorktrees(parallelCwd, `${context.runId}-s${stepIndex}`, step.parallel.length, {
				agents: step.parallel.map((task) => task.agent),
				setupHook: context.params.worktreeSetupHook
					? { hookPath: context.params.worktreeSetupHook, timeoutMs: context.params.worktreeSetupHookTimeoutMs }
					: undefined,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return buildChainExecutionErrorResult(message, context.makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: state.globalTaskIndex }));
		}
	}

	try {
		const agentNames = step.parallel.map((task) => task.agent);
		const parallelBaseIndex = state.globalTaskIndex;
		const detachedCleanup = createDetachedCleanupBarrier(() => {
			if (!worktreeSetup) return;
			appendParallelWorktreeSummary("", worktreeSetup, path.join(context.chainDir, "worktree-diffs", `step-${stepIndex}`), agentNames);
			cleanupWorktrees(worktreeSetup);
		});
		const parallelBehaviors = resolveParallelBehaviors(step.parallel, context.agents, stepIndex, context.chainSkills)
			.map((behavior, taskIndex) => suppressProgressForReadOnlyTask(behavior, parallelTemplates[taskIndex] ?? step.parallel[taskIndex]?.task, context.originalTask));
		for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
			const behavior = parallelBehaviors[taskIndex]!;
			const outputPath = typeof behavior.output === "string"
				? (path.isAbsolute(behavior.output) ? behavior.output : path.join(context.chainDir, behavior.output))
				: undefined;
			const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Parallel chain step ${stepIndex + 1} task ${taskIndex + 1} (${step.parallel[taskIndex]!.agent})`);
			if (validationError) {
				return buildChainExecutionErrorResult(validationError, context.makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: state.globalTaskIndex + taskIndex }));
			}
		}
		state.progressCreated = ensureParallelProgressFile(context.chainDir, state.progressCreated, parallelBehaviors);
		createParallelDirs(context.chainDir, stepIndex, step.parallel.length, agentNames);

		const parallelResults = await runParallelChainTasks({
			step,
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
			worktreeSetup,
			maxSubagentDepth: context.params.maxSubagentDepth,
			workflowStageSubagentGuard: context.params.workflowStageSubagentGuard,
			runSync: context.executeRunSync,
			onDetachedExit: (index, result) => {
				try {
					context.onDetachedExit?.(index, result);
				} finally {
					detachedCleanup.recover(index);
				}
			},
		});
		worktreeCleanupDeferred = detachedCleanup.defer(
			parallelResults.flatMap((result, index) => result.detached ? [parallelBaseIndex + index] : []),
		);
		state.globalTaskIndex += step.parallel.length;
		for (const result of parallelResults) {
			state.results.push(result);
			if (result.progress) state.allProgress.push(result.progress);
			if (result.artifactPaths) state.allArtifactPaths.push(result.artifactPaths);
		}

		const interruptedIndexInStep = parallelResults.findIndex((result) => result.interrupted);
		const interrupted = interruptedIndexInStep >= 0 ? parallelResults[interruptedIndexInStep] : undefined;
		if (interrupted) {
			return {
				content: [{ type: "text", text: `Chain paused after interrupt at step ${stepIndex + 1} (${interrupted.agent}). Waiting for explicit next action.` }],
				details: buildChainExecutionDetails(context.makeDetailsInput({
					currentStepIndex: stepIndex,
					currentFlatIndex: state.globalTaskIndex - step.parallel.length + interruptedIndexInStep,
				})),
			};
		}
		const detachedIndexInStep = parallelResults.findIndex((result) => result.detached);
		const detached = detachedIndexInStep >= 0 ? parallelResults[detachedIndexInStep] : undefined;
		if (detached) {
			return {
				content: [{ type: "text", text: `Chain detached for intercom coordination at step ${stepIndex + 1} (${detached.agent}). Reply to the supervisor request first. After the child exits, start a fresh follow-up if needed.` }],
				details: buildChainExecutionDetails(context.makeDetailsInput({
					currentStepIndex: stepIndex,
					currentFlatIndex: state.globalTaskIndex - step.parallel.length + detachedIndexInStep,
				})),
			};
		}

		const failures = parallelResults.map((result, originalIndex) => ({ ...result, originalIndex })).filter((result) => result.exitCode !== 0 && result.exitCode !== -1);
		if (failures.length > 0) {
			const failureSummary = failures.map((failure) => `- Task ${failure.originalIndex + 1} (${failure.agent}): ${failure.error || "failed"}`).join("\n");
			const errorMsg = `Parallel step ${stepIndex + 1} failed:\n${failureSummary}`;
			const summary = buildChainSummary(context.chainSteps, state.results, context.chainDir, "failed", { index: stepIndex, error: errorMsg });
			return {
				content: [{ type: "text", text: summary }],
				isError: true,
				details: buildChainExecutionDetails(context.makeDetailsInput({
					currentStepIndex: stepIndex,
					currentFlatIndex: state.globalTaskIndex - step.parallel.length + failures[0]!.originalIndex,
				})),
			};
		}

		for (let taskIndex = 0; taskIndex < parallelResults.length; taskIndex++) {
			const outputName = step.parallel[taskIndex]?.as;
			if (outputName) state.outputs[outputName] = outputEntryFromResult(parallelResults[taskIndex]!, stepIndex);
		}
		const taskResults: ParallelTaskResult[] = parallelResults.map((result, index) => {
			const outputTarget = parallelBehaviors[index]?.output;
			const outputTargetPath = typeof outputTarget === "string"
				? (path.isAbsolute(outputTarget) ? outputTarget : path.join(context.chainDir, outputTarget))
				: undefined;
			return {
				agent: result.agent,
				taskIndex: index,
				output: getSingleResultOutput(result),
				exitCode: result.exitCode,
				error: result.error,
				outputTargetPath,
				outputTargetExists: outputTargetPath ? fs.existsSync(outputTargetPath) : undefined,
			};
		});
		state.prev = aggregateParallelOutputs(taskResults);
		state.prev = appendParallelWorktreeSummary(state.prev, worktreeSetup, path.join(context.chainDir, "worktree-diffs", `step-${stepIndex}`), agentNames);
		return undefined;
	} finally {
		if (worktreeSetup && !worktreeCleanupDeferred) cleanupWorktrees(worktreeSetup);
	}
}
