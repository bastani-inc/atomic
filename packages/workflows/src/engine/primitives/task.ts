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
import { RESUME_CONTINUATION_PROMPT } from "../../shared/resume-continuation.js";
import type {
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
	const runTask = async (
		name: string,
		options: WorkflowTaskOptions,
		stageFailFastScope?: ParallelFailFastScope,
	): Promise<WorkflowTaskResult> => {
		runtime.exit.throwIfWorkflowExitSelected();
		// The stage spawns at call time, as without a workspace; its session resolves the workspace when it starts.
		const workspace = (stageOptionsWithInputDefaults(options, runtime.inputRuntimeDefaults) ?? options).workspace;
		if (workspace !== undefined) assertWorkspaceCompatible({ ...options, workspace });
		const runTaskOnce = async (
			taskOptions: WorkflowTaskOptions,
			prepareLiveOptions?: () => WorkflowTaskOptions,
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
			const stageHandle = runtime.spawnStage(name, {
				kind: "agent",
				...(stageOptions !== undefined ? { options: stageOptions } : {}),
				...(stageFailFastScope !== undefined ? { failFastScope: stageFailFastScope } : {}),
				prepareLiveOptions: () => {
					const preparedOptions = prepareLiveOptions?.() ?? taskOptions;
					resolvedTaskOptions =
						stageOptionsWithGitWorktree(
							stageOptionsWithInputDefaults(preparedOptions, runtime.inputRuntimeDefaults),
							runtime.workflowInvocationCwd,
							runtime.gitWorktreeSetupCache,
						) ?? preparedOptions;
					return taskStageOptions(resolvedTaskOptions);
				},
			});
			const stage = stageHandle.context;
			const promptText =
				resolvedTaskOptions.resumeFromSessionId !== undefined
					? RESUME_CONTINUATION_PROMPT
					: applyTaskContext(
							`${taskReadInstruction(resolvedTaskOptions)}${taskPrompt(resolvedTaskOptions)}`,
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
				...(stageMeta.routerSelection !== undefined ? { routerSelection: stageMeta.routerSelection } : {}),
				...(stageMeta.warnings !== undefined ? { warnings: stageMeta.warnings } : {}),
			};
		};

		if (options.worktree !== true) {
			const result = await runTaskOnce(options);
			if (workspace === undefined) return result;
			const binding = await resolveWorkspace(workspace, { signal: runtime.signal });
			return { ...result, changeSet: await workspaceChangeSet(binding, { signal: runtime.signal }) };
		}
		let prepared: ReturnType<typeof prepareTaskWorktrees> | undefined;
		let collected: readonly WorkflowArtifact[] | undefined;
		const collect = () => {
			collected ??=
				prepared === undefined ? [] : collectWorktreeDiffs(prepared, options.artifacts !== false).artifacts;
			return collected;
		};
		try {
			const result = await runTaskOnce(options, () => {
				prepared = prepareTaskWorktrees(
					[{ ...options, name }],
					{ ...options, worktree: true },
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
			const artifacts = collect();
			return artifacts.length === 0 ? result : { ...result, artifacts: [...(result.artifacts ?? []), ...artifacts] };
		} finally {
			if (prepared !== undefined) cleanupPreparedWorktrees(prepared);
		}
	};
	/** A git failure while a task sets up its own worktree says that the task needs git, and why. */
	return async (name, options, stageFailFastScope) => {
		try {
			return await runTask(name, options, stageFailFastScope);
		} catch (error) {
			throw wrapGitRequired(error, {
				workflow: runtime.workflowName,
				runId: runtime.runId,
				source: "task-option",
				field: name,
				...(options.gitWorktreeDir === undefined ? {} : { gitWorktreeDir: options.gitWorktreeDir }),
			});
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
