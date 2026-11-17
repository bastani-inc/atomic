import { resolveWorkspace, workspaceChangeSet } from "@bastani/atomic";
import {
	assertWorkspaceCompatible,
	cleanupPreparedWorktrees,
	collectWorktreeDiffs,
	inputsSelectGitWorktree,
	prepareTaskWorktrees,
	stageOptionsWithGitWorktree,
	stageOptionsWithInputDefaults,
} from "../../runs/foreground/executor-direct-helpers.js";
import { restoresStagePaths } from "../../runs/foreground/executor-stage-factory.js";
import {
	applyTaskContext,
	structuredTaskOutputText,
	taskPrevious,
	taskPrompt,
	taskPromptOptions,
	taskReadInstruction,
	taskStageOptions,
	truncateTaskOutput,
} from "../../runs/foreground/executor-task-prompts.js";
import type { ParallelFailFastScope } from "../../runs/foreground/executor-types.js";
import { prepareTaskGit } from "../../runs/shared/worktree-git-runner.js";
import type {
	StageOptions,
	WorkflowArtifact,
	WorkflowChainOptions,
	WorkflowParallelOptions,
	WorkflowTaskOptions,
	WorkflowTaskResult,
	WorkflowTaskStep,
} from "../../shared/types.js";
import { wrapGitRequired } from "../../shared/workflow-git-required-error.js";
import type { EngineRuntime } from "../runtime.js";
import { createChainPrimitive } from "./chain.js";
import { createParallelPrimitive } from "./parallel.js";

export type WorkflowTaskPrimitive = (
	name: string,
	options: WorkflowTaskOptions,
	stageFailFastScope?: ParallelFailFastScope,
) => Promise<WorkflowTaskResult>;

export interface WorkflowTaskRunners {
	task: WorkflowTaskPrimitive;
	chain(steps: readonly WorkflowTaskStep[], options?: WorkflowChainOptions): Promise<WorkflowTaskResult[]>;
	parallel(steps: readonly WorkflowTaskStep[], options?: WorkflowParallelOptions): Promise<WorkflowTaskResult[]>;
}

function createTaskPrimitive(runtime: EngineRuntime): WorkflowTaskPrimitive {
	/** A git failure while a task sets up its own worktree says that the task needs git, and why. */
	const gitRequired = (error: unknown, name: string, options: WorkflowTaskOptions): unknown =>
		wrapGitRequired(error, {
			workflow: runtime.workflowName,
			runId: runtime.runId,
			source: "task-option",
			field: name,
			...(options.gitWorktreeDir === undefined ? {} : { gitWorktreeDir: options.gitWorktreeDir }),
		});
	const runTask = async (
		name: string,
		options: WorkflowTaskOptions,
		stageFailFastScope?: ParallelFailFastScope,
	): Promise<WorkflowTaskResult> => {
		runtime.exit.throwIfWorkflowExitSelected();
		// The stage spawns at call time, as without a workspace; its session resolves the workspace when it starts.
		const workspace = stageOptionsWithInputDefaults(options, runtime.inputRuntimeDefaults)!.workspace;
		assertWorkspaceCompatible({ ...options, workspace });
		const runTaskOnce = async (
			taskOptions: WorkflowTaskOptions,
			prepareLiveOptions?: () => Promise<WorkflowTaskOptions>,
		): Promise<WorkflowTaskResult> => {
			runtime.exit.throwIfWorkflowExitSelected();
			let resolvedTaskOptions =
				stageOptionsWithInputDefaults(taskOptions, runtime.inputRuntimeDefaults) ?? taskOptions;
			const stageOptions = taskStageOptions(resolvedTaskOptions);
			if (
				(taskOptions.worktree === true || inputsSelectGitWorktree(taskOptions)) &&
				!runtime.agentStageReplaysSavedResult(name, stageOptions)
			)
				await prepareTaskGit(runtime.signal);
			const mapRestored = runtime.mapRestoredOptions;
			const mapsPaths = restoresStagePaths(mapRestored, taskOptions);
			let livePreparation: Promise<StageOptions | undefined> | undefined;
			const prepareLive = async (): Promise<StageOptions | undefined> => {
				try {
					const unmapped = (await prepareLiveOptions?.()) ?? taskOptions;
					const preparedOptions = mapRestored === undefined ? unmapped : await mapRestored(unmapped);
					resolvedTaskOptions =
						(await stageOptionsWithGitWorktree(
							stageOptionsWithInputDefaults(preparedOptions, runtime.inputRuntimeDefaults),
							runtime.workflowInvocationCwd,
							runtime.gitWorktreeSetupCache,
						)) ?? preparedOptions;
					return taskStageOptions(resolvedTaskOptions);
				} catch (error) {
					const named = mapRestored === undefined ? options : await mapRestored(options).catch(() => options);
					throw gitRequired(error, name, named);
				}
			};
			const stageHandle = runtime.spawnStage(name, {
				kind: "agent",
				...(stageOptions !== undefined ? { options: stageOptions } : {}),
				...(stageFailFastScope !== undefined ? { failFastScope: stageFailFastScope } : {}),
				...(prepareLiveOptions !== undefined || typeof resolvedTaskOptions.gitWorktreeDir === "string" || mapsPaths
					? {
							prepareLiveOptions: () => {
								livePreparation = prepareLive();
								return livePreparation;
							},
						}
					: {}),
			});
			const stage = stageHandle.context;
			if (mapsPaths && livePreparation === undefined) resolvedTaskOptions = await mapRestored(resolvedTaskOptions);
			const setupFailed =
				livePreparation !== undefined &&
				(await livePreparation.then(
					() => false,
					() => true,
				));
			// A resumed task sends the prompt it was started with, which its stage compares with the transcript it reopens;
			// the files the prompt names are checked only when the task starts.
			const resumed = resolvedTaskOptions.resumeFromSessionId !== undefined;
			const promptText = setupFailed
				? ""
				: applyTaskContext(
						`${await taskReadInstruction(resolvedTaskOptions, !resumed)}${taskPrompt(resolvedTaskOptions)}`,
						taskPrevious(resolvedTaskOptions),
					);
			const rawOutput = await stage.prompt(promptText, taskPromptOptions(resolvedTaskOptions));
			const structured = typeof rawOutput === "string" ? undefined : rawOutput;
			const text = truncateTaskOutput(structuredTaskOutputText(rawOutput), resolvedTaskOptions.maxOutput);
			const sessionId = (() => {
				try {
					return stage.sessionId;
				} catch {
					return undefined;
				}
			})();
			const stageMeta = stage.__modelFallbackMeta();
			// Nothing outside this task can reach its stage context, so its live session need not wait for the run
			// to end: a long run would otherwise keep every completed task's session in memory.
			void stage.__releaseIfIdle?.();
			return {
				name,
				stageName: name,
				text,
				...(structured !== undefined ? { structured } : {}),
				...(sessionId !== undefined ? { sessionId } : {}),
				...(stage.sessionFile !== undefined ? { sessionFile: stage.sessionFile } : {}),
				...(stageMeta.model !== undefined ? { model: stageMeta.model } : {}),
				...(stageMeta.thinkingLevel !== undefined ? { thinkingLevel: stageMeta.thinkingLevel } : {}),
				...(stageMeta.attemptedModels !== undefined ? { attemptedModels: stageMeta.attemptedModels } : {}),
				...(stageMeta.modelAttempts !== undefined ? { modelAttempts: stageMeta.modelAttempts } : {}),
				...(stageMeta.rateLimits !== undefined ? { rateLimits: stageMeta.rateLimits } : {}),
				...(stageMeta.warnings !== undefined ? { warnings: stageMeta.warnings } : {}),
			};
		};

		if (options.worktree !== true) {
			const result = await runTaskOnce(options);
			if (workspace === undefined) return result;
			const binding = await resolveWorkspace(workspace, { signal: runtime.signal });
			return { ...result, changeSet: await workspaceChangeSet(binding, { signal: runtime.signal }) };
		}
		let prepared: Awaited<ReturnType<typeof prepareTaskWorktrees>> | undefined;
		let collected: Promise<readonly WorkflowArtifact[]> | undefined;
		const collect = (): Promise<readonly WorkflowArtifact[]> => {
			collected ??=
				prepared === undefined
					? Promise.resolve([])
					: collectWorktreeDiffs(prepared, options.artifacts !== false).then(({ artifacts }) => artifacts);
			return collected;
		};
		try {
			const result = await runTaskOnce(options, async () => {
				const mapped =
					runtime.mapRestoredOptions === undefined ? options : await runtime.mapRestoredOptions(options);
				prepared = await prepareTaskWorktrees(
					[{ ...mapped, name }],
					{ ...mapped, worktree: true },
					`${runtime.runId}-${name}-${crypto.randomUUID()}`,
					name,
					runtime.workflowInvocationCwd,
					runtime.worktreeSymlinkDirectories,
				);
				const preparedTask = prepared.tasks[0]!;
				if (preparedTask.durableReplayKey !== undefined)
					runtime.registerTerminalArtifactCollector(preparedTask.durableReplayKey, collect);
				return preparedTask;
			});
			const artifacts = await collect();
			// A worktree whose diff could not be captured is kept, and setup it could not finish is skipped: the task's
			// result says so, with the worktree (#4876).
			const worktreeWarnings = [
				...(prepared?.setup?.worktrees ?? []).flatMap((worktree) => worktree.setupWarnings ?? []),
				...artifacts.flatMap((artifact) =>
					artifact.captureError === undefined
						? []
						: [
								`Diff capture failed for task ${name}; its worktree was kept at ${artifact.worktreePath}: ${artifact.captureError}`,
							],
				),
			];
			if (artifacts.length === 0 && worktreeWarnings.length === 0) return result;
			return {
				...result,
				...(artifacts.length === 0 ? {} : { artifacts: [...(result.artifacts ?? []), ...artifacts] }),
				...(worktreeWarnings.length === 0 ? {} : { warnings: [...(result.warnings ?? []), ...worktreeWarnings] }),
			};
		} finally {
			if (prepared !== undefined) await cleanupPreparedWorktrees(prepared);
		}
	};
	return async (name, options, stageFailFastScope) => {
		try {
			return await runTask(name, options, stageFailFastScope);
		} catch (error) {
			throw gitRequired(error, name, options);
		}
	};
}

export function createWorkflowTaskRunners(input: { readonly runtime: EngineRuntime }): WorkflowTaskRunners {
	const task = createTaskPrimitive(input.runtime);
	return {
		task,
		chain: createChainPrimitive({ runtime: input.runtime, task }),
		parallel: createParallelPrimitive({ runtime: input.runtime, task }),
	};
}
