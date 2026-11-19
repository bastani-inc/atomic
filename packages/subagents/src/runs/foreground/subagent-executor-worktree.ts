import * as path from "node:path";
import { pathExists } from "../../shared/path-exists.js";
import type { ResolvedStepBehavior } from "../../shared/settings.js";
import type { ExtensionConfig, SubagentToolResult } from "../../shared/types.js";
import { resolveChildCwd } from "../../shared/utils.js";
import { ensureNamedWorktree, type NamedWorktree, type NamedWorktreeOptions } from "../shared/named-worktree.js";
import { resolveSingleOutputPath } from "../shared/single-output.js";
import {
	createWorktrees,
	diffWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeDiffSummary,
	formatWorktreeTaskCwdConflict,
	type WorktreeSetup,
} from "../shared/worktree.js";
import { missingCwdMessage, resolveRequestedCwd } from "./subagent-executor-cwd.js";
import { NAMED_WORKTREE, type SubagentParamsLike, type TaskParam } from "./subagent-executor-types.js";

export function buildParallelModeError(message: string): SubagentToolResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode: "parallel" as const, results: [] },
	};
}

export async function createParallelWorktreeSetup(
	enabled: boolean | undefined,
	cwd: string,
	runId: string,
	tasks: TaskParam[],
	setupHook: ExtensionConfig["worktreeSetupHook"],
	setupHookTimeoutMs: ExtensionConfig["worktreeSetupHookTimeoutMs"],
): Promise<{ setup?: WorktreeSetup; errorResult?: SubagentToolResult }> {
	if (!enabled) return {};
	try {
		return {
			setup: await createWorktrees(cwd, runId, tasks.length, {
				agents: tasks.map((task) => task.agent),
				setupHook: setupHook ? { hookPath: setupHook, timeoutMs: setupHookTimeoutMs } : undefined,
			}),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { errorResult: buildParallelModeError(message) };
	}
}

export async function buildParallelWorktreeTaskCwdError(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): Promise<string | undefined> {
	const conflict = await findWorktreeTaskCwdConflict(tasks, sharedCwd);
	if (!conflict) return undefined;
	return formatWorktreeTaskCwdConflict(conflict, sharedCwd);
}

export function resolveParallelTaskCwd(
	task: TaskParam,
	paramsCwd: string,
	worktreeSetup: WorktreeSetup | undefined,
	index: number,
): string {
	if (worktreeSetup) return worktreeSetup.worktrees[index]!.agentCwd;
	return resolveChildCwd(paramsCwd, task.cwd);
}

/** Where a parallel run saves each `worktree: true` child's edits as a patch: a directory of its own per run. */
export function parallelWorktreeDiffsDir(artifactsDir: string, runId: string): string {
	return path.join(artifactsDir, "worktree-diffs", runId.replaceAll("/", "+"));
}

export async function buildParallelWorktreeSuffix(
	worktreeSetup: WorktreeSetup | undefined,
	artifactsDir: string,
	runId: string,
	tasks: TaskParam[],
): Promise<string> {
	if (!worktreeSetup) return "";
	const diffsDir = parallelWorktreeDiffsDir(artifactsDir, runId);
	const diffs = await diffWorktrees(
		worktreeSetup,
		tasks.map((task) => task.agent),
		diffsDir,
	);
	return formatWorktreeDiffSummary(diffs);
}

export function findDuplicateParallelOutputPath(input: {
	tasks: TaskParam[];
	behaviors: ResolvedStepBehavior[];
	paramsCwd: string;
	ctxCwd: string;
	worktreeSetup?: WorktreeSetup;
	unresolvedCwd?: (task: TaskParam) => boolean;
}): string | undefined {
	const seen = new Map<string, { index: number; agent: string }>();
	for (let index = 0; index < input.tasks.length; index++) {
		const behavior = input.behaviors[index];
		if (!behavior?.output) continue;
		const task = input.tasks[index]!;
		// An absolute output is known even if the run failed before making this task's worktree.
		if (input.unresolvedCwd?.(task) && !path.isAbsolute(behavior.output)) continue;
		const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd, input.worktreeSetup, index);
		const outputPath = resolveSingleOutputPath(behavior.output, input.ctxCwd, taskCwd);
		if (!outputPath) continue;
		const previous = seen.get(outputPath);
		if (previous) {
			return `Parallel tasks ${previous.index + 1} (${previous.agent}) and ${index + 1} (${task.agent}) resolve output to the same path: ${outputPath}. Use distinct output paths.`;
		}
		seen.set(outputPath, { index, agent: task.agent });
	}
	return undefined;
}

function launchError(params: SubagentParamsLike, message: string): SubagentToolResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode: (params.tasks?.length ?? 0) > 0 ? "parallel" : "single", results: [] },
	};
}

function withNamedWorktree<T extends { cwd?: string; worktree?: SubagentParamsLike["worktree"] }>(
	value: T,
	worktree: NamedWorktree,
): Omit<T, "worktree"> & { cwd: string; [NAMED_WORKTREE]: NamedWorktree } {
	const { worktree: _request, ...rest } = value;
	return { ...rest, cwd: worktree.agentCwd, [NAMED_WORKTREE]: worktree };
}

/**
 * Before any child starts: refuse a launch whose cwd is missing, and check out the named worktree each child asks for
 * (#5202), setting the child's cwd to it. A top-level named worktree applies to the single child, or to each task
 * that names none of its own. `worktree: true` is left as it is.
 */
/** The error a launch fails with before any worktree is made: a working directory that does not exist, or worktree requests that do not go together. */
export async function launchDirectoryError(
	params: SubagentParamsLike,
	runtimeCwd: string,
): Promise<SubagentToolResult | undefined> {
	const callCwd = params.cwd ?? runtimeCwd;
	const tasks = params.tasks ?? [];
	const cwds = [callCwd, ...tasks.map((task) => resolveRequestedCwd(callCwd, task.cwd))];
	for (const cwd of cwds) {
		if (!(await pathExists(cwd))) return launchError(params, missingCwdMessage(cwd));
	}
	if (params.worktree === true && tasks.some((task) => task.worktree !== undefined))
		return launchError(
			params,
			"worktree: true gives each task a new worktree of its own, so it cannot be combined with a task's named worktree. Use one or the other.",
		);
	return undefined;
}

export async function prepareNamedWorktrees(
	params: SubagentParamsLike,
	runtimeCwd: string,
	options: NamedWorktreeOptions = {},
): Promise<{ params: SubagentParamsLike; error?: undefined } | { params?: undefined; error: SubagentToolResult }> {
	const directoryError = await launchDirectoryError(params, runtimeCwd);
	if (directoryError) return { error: directoryError };
	const callCwd = params.cwd ?? runtimeCwd;
	const tasks = params.tasks ?? [];
	const topLevel = typeof params.worktree === "object" ? params.worktree : undefined;
	try {
		if (tasks.length === 0)
			return {
				params: topLevel
					? withNamedWorktree(params, await ensureNamedWorktree(callCwd, topLevel, options))
					: params,
			};
		const { worktree: _topLevel, ...rest } = params;
		const preparedTasks: TaskParam[] = [];
		for (const task of tasks) {
			const request = task.worktree ?? topLevel;
			preparedTasks.push(
				request
					? withNamedWorktree(
							task,
							await ensureNamedWorktree(resolveRequestedCwd(callCwd, task.cwd), request, options),
						)
					: task,
			);
		}
		return {
			params: {
				...rest,
				...(topLevel ? {} : { worktree: params.worktree }),
				tasks: preparedTasks,
			},
		};
	} catch (error) {
		return { error: launchError(params, error instanceof Error ? error.message : String(error)) };
	}
}

/** The named worktree each child of a prepared launch runs in, by child index. */
export function namedWorktreesByIndex(params: SubagentParamsLike): Map<number, NamedWorktree> {
	const byIndex = new Map<number, NamedWorktree>();
	if (params.tasks?.length) {
		for (const [index, task] of params.tasks.entries()) {
			const worktree = task[NAMED_WORKTREE];
			if (worktree) byIndex.set(index, worktree);
		}
	} else if (params[NAMED_WORKTREE]) byIndex.set(0, params[NAMED_WORKTREE]);
	return byIndex;
}
