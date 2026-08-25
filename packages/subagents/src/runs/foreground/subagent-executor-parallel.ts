import type { AgentConfig } from "../../agents/agents.js";
import { normalizeSkillInput } from "../../agents/skills.js";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.js";
import { collectKnownModelProviders, type ModelInfo, toModelInfo } from "../../shared/model-info.js";
import { createCandidateModelResolver } from "../../shared/model-resolution.js";
import {
	resolveStepBehavior,
	type StepOverrides,
	suppressProgressForReadOnlyTask,
	writeInitialProgressFile,
} from "../../shared/settings.js";
import {
	type AgentProgress,
	type ArtifactPaths,
	type ForegroundParentAskHandoff,
	isWorkflowStageOrchestrationContext,
	resolveTopLevelParallelConcurrency,
	resolveTopLevelParallelMaxTasks,
	type SingleResult,
	type SubagentToolResult,
	wrapForkTask,
} from "../../shared/types.js";
import { compactForegroundDetails, getSingleResultOutput } from "../../shared/utils.js";
import { isParentCancellation } from "../shared/cancellation-recovery.js";
import { sharedAutoGroupForSet } from "../shared/intercom-group.js";
import { resolveModelCandidate } from "../shared/model-fallback.js";
import { formatParallelResultContent } from "../shared/parallel-utils.js";
import { recordRun } from "../shared/run-history.js";
import { resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.js";
import { cleanupWorktrees, type WorktreeSetup } from "../shared/worktree.js";
import { createDetachedCleanupBarrier } from "./detached-cleanup-barrier.js";
import { formatParentAskHandoffOutput } from "./parent-ask-output.js";
import { runForegroundParallelTasks } from "./subagent-executor-parallel-task.js";
import { markParentAskHandoff } from "./subagent-executor-parent-ask-projection.js";
import {
	createForegroundControlNotifier,
	maybeBuildForegroundIntercomReceipt,
	notifyDetachedForegroundChildExit,
} from "./subagent-executor-status.js";
import type { ExecutionContextData, ResolvedExecutorDeps, TaskParam } from "./subagent-executor-types.js";
import {
	buildParallelModeError,
	buildParallelWorktreeSuffix,
	buildParallelWorktreeTaskCwdError,
	createParallelWorktreeSetup,
	findDuplicateParallelOutputPath,
	resolveParallelTaskCwd,
} from "./subagent-executor-worktree.js";

export async function runParallelPath(
	data: ExecutionContextData,
	deps: ResolvedExecutorDeps,
): Promise<SubagentToolResult> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForIndex,
		shareEnabled,
		artifactConfig,
		artifactsDir,
		onUpdate,
		controlConfig,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget : undefined;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const tasks = params.tasks!;
	const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
	const parallelConcurrency = resolveTopLevelParallelConcurrency(
		params.concurrency,
		deps.config.parallel?.concurrency,
	);

	if (tasks.length > maxParallelTasks)
		return {
			content: [{ type: "text", text: `Max ${maxParallelTasks} tasks` }],
			isError: true,
			details: { mode: "parallel" as const, results: [] },
		};

	const agentConfigs: AgentConfig[] = data.parallelAgentConfigs ? [...data.parallelAgentConfigs] : [];
	if (!data.parallelAgentConfigs) {
		for (const task of tasks) {
			const config = agents.find((agent) => agent.name === task.agent);
			if (!config) {
				return {
					content: [{ type: "text", text: `Unknown agent: ${task.agent}` }],
					isError: true,
					details: { mode: "parallel" as const, results: [] },
				};
			}
			agentConfigs.push(config);
		}
	}

	const workflowStageSubagentGuard = isWorkflowStageOrchestrationContext(ctx);

	if (params.worktree) {
		const worktreeTaskCwdError = buildParallelWorktreeTaskCwdError(tasks, effectiveCwd);
		if (worktreeTaskCwdError) return buildParallelModeError(worktreeTaskCwdError);
	}

	const currentProvider = ctx.model?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const knownModelProviders = collectKnownModelProviders(ctx.modelRegistry);
	const taskTexts = tasks.map((t) => t.task);
	const skillOverrides: (string[] | false | undefined)[] = tasks.map((t) => normalizeSkillInput(t.skill));
	const behaviorOverrides: StepOverrides[] = tasks.map((task, index) => ({
		...(task.output !== undefined
			? { output: task.output === true ? (agentConfigs[index]?.output ?? false) : task.output }
			: {}),
		...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
		...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
		...(task.progress !== undefined ? { progress: task.progress } : {}),
		...(skillOverrides[index] !== undefined ? { skills: skillOverrides[index] } : {}),
		...(task.model ? { model: task.model } : {}),
	}));
	const modelOverrides: (string | undefined)[] = tasks.map((_, i) =>
		resolveModelCandidate(behaviorOverrides[i]?.model ?? agentConfigs[i]?.model, availableModels, currentProvider),
	);

	const behaviors = agentConfigs.map((config, index) =>
		suppressProgressForReadOnlyTask(resolveStepBehavior(config, behaviorOverrides[index]!), taskTexts[index]),
	);
	const firstProgressIndex = behaviors.findIndex((behavior) => behavior.progress);
	const liveResults: (SingleResult | undefined)[] = new Array(tasks.length).fill(undefined);
	const liveProgress: (AgentProgress | undefined)[] = new Array(tasks.length).fill(undefined);
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const { setup: worktreeSetup, errorResult } = createParallelWorktreeSetup(
		params.worktree,
		effectiveCwd,
		runId,
		tasks,
		deps.config.worktreeSetupHook,
		deps.config.worktreeSetupHookTimeoutMs,
	);
	let worktreeCleanupDeferred = false;
	const detachedCleanup = createDetachedCleanupBarrier(() => {
		if (!worktreeSetup) return;
		buildParallelWorktreeSuffix(worktreeSetup, artifactsDir, tasks as TaskParam[]);
		cleanupWorktrees(worktreeSetup);
	});
	if (errorResult) return errorResult;
	let parentAsk: ForegroundParentAskHandoff | undefined;

	try {
		const duplicateOutputError = findDuplicateParallelOutputPath({
			tasks,
			behaviors,
			paramsCwd: effectiveCwd,
			ctxCwd: ctx.cwd,
			worktreeSetup,
		});
		if (duplicateOutputError) return buildParallelModeError(duplicateOutputError);
		for (let index = 0; index < tasks.length; index++) {
			const taskCwd = resolveParallelTaskCwd(tasks[index]!, effectiveCwd, worktreeSetup, index);
			const outputPath = resolveSingleOutputPath(behaviors[index]?.output, ctx.cwd, taskCwd);
			const validationError = validateFileOnlyOutputMode(
				behaviors[index]?.outputMode,
				outputPath,
				`Parallel task ${index + 1} (${tasks[index]!.agent})`,
			);
			if (validationError) return buildParallelModeError(validationError);
		}

		const parallelProgressPrecreated = firstProgressIndex !== -1;
		if (parallelProgressPrecreated) writeInitialProgressFile(effectiveCwd);

		if (params.context === "fork") {
			for (let i = 0; i < taskTexts.length; i++) {
				taskTexts[i] = wrapForkTask(taskTexts[i]!);
			}
		}

		const results = await runForegroundParallelTasks({
			onDetachedExit: (index, result) => {
				try {
					notifyDetachedForegroundChildExit({
						pi: deps.pi,
						runId,
						mode: "parallel",
						index,
						totalTasks: tasks.length,
						result,
					});
				} finally {
					detachedCleanup.recover(index);
				}
			},
			onParentAskHandoff: (handoff) => {
				if (!parentAsk) parentAsk = handoff;
			},
			tasks,
			taskTexts,
			agents,
			...(data.parallelAgentConfigs ? { agentConfigs } : {}),
			ctx,
			intercomEvents: deps.pi.events,
			signal,
			runId,
			sessionDirForIndex,
			sessionFileForIndex,
			shareEnabled,
			artifactConfig,
			artifactsDir,
			maxOutput: params.maxOutput,
			paramsCwd: effectiveCwd,
			workflowStageSubagentGuard,
			availableModels,
			knownModelProviders,
			resolveCandidateModel: createCandidateModelResolver(ctx.modelRegistry, currentProvider),
			modelOverrides,
			behaviors,
			firstProgressIndex: parallelProgressPrecreated ? -1 : firstProgressIndex,
			controlConfig,
			onControlEvent,
			childIntercomTarget: childIntercomTarget
				? (agent, index) => childIntercomTarget(runId, agent, index)
				: undefined,
			orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
			setIntercomGroup: params.group,
			sharedAutoIntercomGroup: sharedAutoGroupForSet(params.group, tasks),
			foregroundControl,
			concurrencyLimit: parallelConcurrency,
			parentDepth: data.parentDepth,
			liveResults,
			liveProgress,
			onUpdate,
			worktreeSetup: worktreeSetup as WorktreeSetup | undefined,
			runtime: deps.runtime,
		});
		for (let i = 0; i < results.length; i++) {
			const run = results[i]!;
			recordRun(run.agent, taskTexts[i]!, run.status, run.progressSummary?.durationMs ?? 0);
		}

		for (const result of results) {
			if (result.progress) allProgress.push(result.progress);
			if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
		}

		const interrupted = results.find((result) => result.interrupted && !isParentCancellation(result.cause));
		const details = compactForegroundDetails({
			mode: "parallel",
			runId,
			results,
			parentAskYielded: parentAsk !== undefined,
			progress: params.includeProgress ? allProgress : undefined,
			artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
		});
		if (parentAsk) {
			const worktreeSuffix = buildParallelWorktreeSuffix(worktreeSetup, artifactsDir, tasks as TaskParam[]);
			const handoffText = formatParentAskHandoffOutput(parentAsk);
			const yieldedResult: SubagentToolResult = {
				content: [{ type: "text", text: worktreeSuffix ? `${handoffText}\n\n${worktreeSuffix}` : handoffText }],
				details,
			};
			markParentAskHandoff(yieldedResult, parentAsk);
			return yieldedResult;
		}
		if (
			interrupted &&
			!results.some(
				(result) => isParentCancellation(result.cause) && (result.interrupted || result.status === "interrupted"),
			)
		) {
			return {
				content: [
					{
						type: "text",
						text: `Parallel run ended after interrupt (${interrupted.agent}). Launch fresh subagents for any follow-up.`,
					},
				],
				details,
			};
		}
		const detachedIndex = results.findIndex((result) => result.detached);
		const detached = detachedIndex >= 0 ? results[detachedIndex] : undefined;
		worktreeCleanupDeferred = detachedCleanup.defer(
			results.flatMap((result, index) => (result.detached ? [index] : [])),
		);
		if (detached) {
			return {
				content: [
					{
						type: "text",
						text: `Parallel run detached for intercom coordination (${detached.agent}). Reply to the supervisor request first. After the child exits, launch fresh follow-up work if needed.`,
					},
				],
				details,
			};
		}

		const intercomReceipt = await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "parallel",
			details,
		});
		if (intercomReceipt) {
			return {
				content: [{ type: "text", text: intercomReceipt.text }],
				details: intercomReceipt.details,
			};
		}

		const worktreeSuffix = buildParallelWorktreeSuffix(worktreeSetup, artifactsDir, tasks as TaskParam[]);
		const childContent = formatParallelResultContent(
			results.map((result) => ({
				agent: result.agent,
				output: result.truncation?.text || getSingleResultOutput(result),
				status: result.status,
				error: result.error,
				...(result.cause ? { cause: result.cause } : {}),
			})),
			(i, agent) => `=== Task ${i + 1}: ${agent} ===`,
		);
		const fullContent = worktreeSuffix ? `${childContent}\n\n${worktreeSuffix}` : childContent;

		return {
			content: [{ type: "text", text: fullContent }],
			details,
		};
	} finally {
		if (worktreeSetup && !worktreeCleanupDeferred) cleanupWorktrees(worktreeSetup);
	}
}
