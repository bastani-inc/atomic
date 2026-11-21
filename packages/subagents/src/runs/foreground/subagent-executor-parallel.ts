import { join } from "node:path";
import type { AgentConfig } from "../../agents/agents.js";
import { normalizeSkillInput } from "../../agents/skills.js";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.js";
import { collectKnownModelProviders, type ModelInfo, toModelInfo } from "../../shared/model-info.js";
import { createCandidateModelResolver } from "../../shared/model-resolution.js";
import {
	type ResolvedStepBehavior,
	resolveStepBehavior,
	type StepOverrides,
	suppressProgressForReadOnlyTask,
	writeInitialProgressFile,
} from "../../shared/settings.js";
import {
	type AgentProgress,
	type ArtifactPaths,
	resolveTopLevelParallelConcurrency,
	resolveTopLevelParallelMaxTasks,
	type SingleResult,
	type SubagentToolResult,
} from "../../shared/types.js";
import { compactForegroundDetails, getSingleResultOutput } from "../../shared/utils.js";
import { resolveSubagentAutoModel } from "../shared/auto-model.js";
import { isParentCancellation } from "../shared/cancellation-recovery.js";
import { sharedAutoGroupForSet } from "../shared/intercom-group.js";
import { resolveModelCandidate, resultRanOnLine } from "../shared/model-fallback.js";
import { formatParallelResultContent } from "../shared/parallel-utils.js";
import { recordRun } from "../shared/run-history.js";
import { resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.js";
import { formatWorktreeDiffSummary, type WorktreeSetup } from "../shared/worktree.js";
import { currentChildWorktreeNote, registerRunWorktrees } from "./run-worktrees.js";
import { createSubagentChildRecordSink } from "./subagent-child-records.js";
import { runForegroundParallelTasks } from "./subagent-executor-parallel-task.js";
import {
	createForegroundControlNotifier,
	maybeBuildForegroundIntercomReceipt,
	notifyDetachedForegroundChildExit,
} from "./subagent-executor-status.js";
import {
	BURST_ANSWERS,
	BURST_PREPARED_TASKS,
	type ExecutionContextData,
	type ResolvedExecutorDeps,
	type SubagentParamsLike,
	type TaskParam,
} from "./subagent-executor-types.js";
import {
	buildParallelModeError,
	buildParallelWorktreeTaskCwdError,
	createParallelWorktreeSetup,
	findDuplicateParallelOutputPath,
	parallelWorktreeDiffsDir,
	resolveParallelTaskCwd,
} from "./subagent-executor-worktree.js";
import { parallelTaskToolResultWithOutput, withRejectedWorktrees } from "./task-execution.js";

/** The error a parallel run with more tasks than its limit fails with. */
export function parallelTaskLimitError(taskCount: number, maxParallelTasks: number): SubagentToolResult | undefined {
	if (taskCount > maxParallelTasks)
		return {
			content: [
				{
					type: "text",
					text: `Too many parallel tasks (${taskCount} after count expansion). Maximum is ${maxParallelTasks} (configure parallel.maxTasks in ~/.atomic/agent/extensions/subagent/config.json).`,
				},
			],
			isError: true,
			details: { mode: "parallel" as const, results: [] },
		};
	return undefined;
}

/** The error a `worktree: true` parallel run fails with for tasks it cannot give a worktree of their own. */
export async function parallelWorktreeTaskError(
	tasks: TaskParam[],
	worktree: SubagentParamsLike["worktree"],
	effectiveCwd: string,
): Promise<SubagentToolResult | undefined> {
	if (worktree !== true) return undefined;
	const worktreeTaskCwdError = await buildParallelWorktreeTaskCwdError(tasks, effectiveCwd);
	return worktreeTaskCwdError ? buildParallelModeError(worktreeTaskCwdError) : undefined;
}

/** What each task of a parallel run overrides of its agent's behavior. */
export function parallelTaskBehaviorOverrides(tasks: TaskParam[], agentConfigs: AgentConfig[]): StepOverrides[] {
	return tasks.map((task, index) => ({
		...(task.output !== undefined
			? { output: task.output === true ? (agentConfigs[index]?.output ?? false) : task.output }
			: {}),
		...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
		...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
		...(task.progress !== undefined ? { progress: task.progress } : {}),
		...(normalizeSkillInput(task.skill) !== undefined ? { skills: normalizeSkillInput(task.skill) } : {}),
		...(task.model ? { model: task.model } : {}),
	}));
}

/** The error a parallel run fails with for its tasks' output settings: two tasks writing one file, or a file-only task without a file. */
export function parallelOutputSetupError(input: {
	tasks: TaskParam[];
	behaviors: ResolvedStepBehavior[];
	paramsCwd: string;
	ctxCwd: string;
	worktreeSetup: WorktreeSetup | undefined;
	unresolvedCwd?: (task: TaskParam) => boolean;
}): SubagentToolResult | undefined {
	const duplicateOutputError = findDuplicateParallelOutputPath(input);
	if (duplicateOutputError) return buildParallelModeError(duplicateOutputError);
	for (let index = 0; index < input.tasks.length; index++) {
		const taskCwd = resolveParallelTaskCwd(input.tasks[index]!, input.paramsCwd, input.worktreeSetup, index);
		const outputPath = resolveSingleOutputPath(input.behaviors[index]?.output, input.ctxCwd, taskCwd);
		const validationError = validateFileOnlyOutputMode(
			input.behaviors[index]?.outputMode,
			outputPath,
			`Parallel task ${index + 1} (${input.tasks[index]!.agent})`,
		);
		if (validationError) return buildParallelModeError(validationError);
	}
	return undefined;
}

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
		sessionManagerForIndex,
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

	const limitError = parallelTaskLimitError(tasks.length, maxParallelTasks);
	if (limitError) return limitError;

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

	const worktreeTaskError = await parallelWorktreeTaskError(tasks, params.worktree, effectiveCwd);
	if (worktreeTaskError) return worktreeTaskError;

	const currentProvider = ctx.model?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const knownModelProviders = collectKnownModelProviders(ctx.modelRegistry);
	const taskTexts = tasks.map((t) => t.task);
	const behaviorOverrides = parallelTaskBehaviorOverrides(tasks, agentConfigs);
	const autoModels = tasks.map((task, index) => (task.model ?? agentConfigs[index]?.model) === "auto");
	const settings = autoModels.includes(true) ? deps.pi.getSettings?.() : undefined;
	const modelOverrides = tasks.map((_, index) =>
		autoModels[index]
			? resolveSubagentAutoModel(ctx, settings, agentConfigs[index]!)
			: resolveModelCandidate(
					behaviorOverrides[index]?.model ?? agentConfigs[index]?.model,
					availableModels,
					currentProvider,
				),
	);

	const behaviors = agentConfigs.map((config, index) =>
		suppressProgressForReadOnlyTask(resolveStepBehavior(config, behaviorOverrides[index]!), taskTexts[index]),
	);
	const firstProgressIndex = behaviors.findIndex((behavior) => behavior.progress);
	const liveResults: (SingleResult | undefined)[] = new Array(tasks.length).fill(undefined);
	const liveProgress: (AgentProgress | undefined)[] = new Array(tasks.length).fill(undefined);
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const { setup: worktreeSetup, errorResult } = await createParallelWorktreeSetup(
		params.worktree === true,
		effectiveCwd,
		runId,
		tasks,
		deps.config.worktreeSetupHook,
		deps.config.worktreeSetupHookTimeoutMs,
	);
	if (errorResult) return errorResult;
	// Each child execution holds the worktrees; they go once the run returned and no execution holds them, except a
	// stopped child's worktree with unsaved work.
	let worktreeSuffix = "";
	const runWorktrees = worktreeSetup
		? registerRunWorktrees(runId, worktreeSetup, {
				diffsDir: parallelWorktreeDiffsDir(artifactsDir, runId),
				agents: tasks.map((task) => task.agent),
				...(ctx.getAgentTaskHost
					? {}
					: {
							onCaptured: (diffs) => {
								worktreeSuffix = formatWorktreeDiffSummary(diffs);
							},
						}),
			})
		: undefined;

	try {
		if (worktreeSetup)
			params[BURST_PREPARED_TASKS]?.(
				tasks.map((task, i) => ({ ...task, cwd: worktreeSetup.worktrees[i]!.agentCwd })),
			);
		const outputError = parallelOutputSetupError({
			tasks,
			behaviors,
			paramsCwd: effectiveCwd,
			ctxCwd: ctx.cwd,
			worktreeSetup,
		});
		if (outputError) return outputError;

		// #4976: the run's shared progress.md lives in run-scoped artifact storage, never in the project directory,
		// where it would overwrite a project's own progress.md.
		const progressDir = firstProgressIndex === -1 ? undefined : join(artifactsDir, "progress", runId);
		if (progressDir) await writeInitialProgressFile(progressDir);

		const results = await runForegroundParallelTasks({
			runWorktrees,
			...(params.heartbeatMs === undefined ? {} : { heartbeatMs: params.heartbeatMs }),
			onDetachedExit: (index, result) => {
				notifyDetachedForegroundChildExit({
					pi: deps.pi,
					runId,
					mode: "parallel",
					index,
					totalTasks: tasks.length,
					result,
				});
			},
			tasks,
			taskTexts,
			agents,
			...(data.parallelAgentConfigs ? { agentConfigs } : {}),
			ctx,
			resourceLoaderInheritanceSnapshot: deps.pi.getResourceLoaderInheritanceSnapshot?.(),
			intercomEvents: deps.pi.events,
			recordChild: createSubagentChildRecordSink(deps.pi, ctx),
			signal,
			runId,
			sessionDirForIndex,
			...(data.sessionStore ? { sessionStore: data.sessionStore } : {}),
			sessionManagerForIndex,
			shareEnabled,
			artifactConfig,
			artifactsDir,
			maxOutput: params.maxOutput,
			paramsCwd: effectiveCwd,
			availableModels,
			knownModelProviders,
			resolveCandidateModel: createCandidateModelResolver(ctx.modelRegistry, currentProvider),
			modelOverrides,
			autoModels,
			behaviors,
			...(progressDir ? { progressDir } : {}),
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
			runningCapacity: deps.config.parallel?.runningCapacity,
			sessionStartTimeoutMs: deps.config.sessionStartTimeoutMs,
			parentDepth: data.parentDepth,
			liveResults,
			liveProgress,
			onUpdate,
			worktreeSetup: worktreeSetup as WorktreeSetup | undefined,
			runtime: deps.runtime,
		});
		const rejectedWorktrees =
			runWorktrees &&
			results.map(({ taskResponse }, index) =>
				taskResponse?.kind === "unstarted" && taskResponse.reason.kind === "rejected" ? { runId, index } : null,
			);
		if (ctx.getAgentTaskHost) {
			const response: import("../../../../coding-agent/src/core/tasks/contracts.js").ModelParallelResponse = {
				kind: "parallel",
				slots: results.map((result, ordinal) => ({
					ordinal,
					outcome: result.taskResponse ?? {
						kind: "unstarted",
						reason: { kind: "skipped", cause: "parallel-group-detach" },
					},
				})),
			};
			const reply = await parallelTaskToolResultWithOutput(response, ctx.getAgentTaskHost());
			return withRejectedWorktrees(reply, rejectedWorktrees);
		}
		// A sibling may have released the batch since this child finished. Report only its own current worktree.
		if (runWorktrees) {
			for (const [index, result] of results.entries()) {
				if (result.worktreeNote)
					result.worktreeNote = rejectedWorktrees?.[index] ? undefined : currentChildWorktreeNote(runId, index);
			}
		}
		for (let i = 0; i < results.length; i++) {
			const run = results[i]!;
			recordRun(run.agent, taskTexts[i]!, run.status, run.progressSummary?.durationMs ?? 0);
		}

		for (const result of results) {
			if (result.progress) allProgress.push(result.progress);
			if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
		}

		const interrupted = results.find(
			(result) => result.status === "killed" || (result.interrupted && !isParentCancellation(result.cause)),
		);
		const details = compactForegroundDetails({
			mode: "parallel",
			runId,
			results,
			parentAskYielded: false,
			...(rejectedWorktrees?.some(Boolean) ? { rejectedWorktrees } : {}),
			progress: params.includeProgress ? allProgress : undefined,
			artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
		});
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
						text:
							interrupted.status === "killed"
								? `Parallel child killed (${interrupted.agent}). This child cannot be resumed. Launch fresh subagents for any follow-up.`
								: `Parallel run ended before completion (${interrupted.agent}). Launch fresh subagents for any follow-up.`,
					},
				],
				details,
			};
		}
		const detachedIndex = results.findIndex(
			(result) => result.detached && result.detachedReason !== "worktree-cleanup",
		);
		const detached = detachedIndex >= 0 ? results[detachedIndex] : undefined;
		if (detached) {
			return {
				content: [
					{
						type: "text",
						text: `Parallel observation yielded for intercom coordination (${detached.agent}). The original children continue; reply to any pending ask without relaunching them.`,
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

		const renderAnswers = (children: SingleResult[]) => {
			const childContent = formatParallelResultContent(
				children.map((result) => ({
					agent: result.agent,
					output: [result.worktreeNote, result.truncation?.text || getSingleResultOutput(result)]
						.filter(Boolean)
						.join("\n\n"),
					status: result.status,
					error: result.error,
					...(result.cause ? { cause: result.cause } : {}),
				})),
				(i, agent) => {
					const ranOn = resultRanOnLine(children[i]!);
					return `=== Task ${i + 1}: ${agent} ===${ranOn ? `\n${ranOn}` : ""}`;
				},
			);
			return worktreeSuffix ? `${childContent}\n\n${worktreeSuffix}` : childContent;
		};
		params[BURST_ANSWERS]?.((start, length) => renderAnswers(results.slice(start, start + length)));

		return {
			content: [{ type: "text", text: renderAnswers(results) }],
			details,
			// #4697: the call fails only when no child started; even then each child's error is listed.
			...(results.every((result) => result.taskResponse?.kind === "unstarted") ? { isError: true } : {}),
		};
	} finally {
		await runWorktrees?.release();
	}
}
