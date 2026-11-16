import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedStepBehavior } from "../../shared/settings.js";
import type { ExtensionConfig, SubagentToolResult } from "../../shared/types.js";
import { resolveChildCwd } from "../../shared/utils.js";
import { ensureNamedWorktree, type NamedWorktree } from "../shared/named-worktree.js";
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

export function createParallelWorktreeSetup(
	enabled: boolean | undefined,
	cwd: string,
	runId: string,
	tasks: TaskParam[],
	setupHook: ExtensionConfig["worktreeSetupHook"],
	setupHookTimeoutMs: ExtensionConfig["worktreeSetupHookTimeoutMs"],
): { setup?: WorktreeSetup; errorResult?: SubagentToolResult } {
	if (!enabled) return {};
	try {
		return {
			setup: createWorktrees(cwd, runId, tasks.length, {
				agents: tasks.map((task) => task.agent),
				setupHook: setupHook ? { hookPath: setupHook, timeoutMs: setupHookTimeoutMs } : undefined,
			}),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { errorResult: buildParallelModeError(message) };
	}
}

export function buildParallelWorktreeTaskCwdError(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): string | undefined {
	const conflict = findWorktreeTaskCwdConflict(tasks, sharedCwd);
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

export function buildParallelWorktreeSuffix(
	worktreeSetup: WorktreeSetup | undefined,
	artifactsDir: string,
	runId: string,
	tasks: TaskParam[],
): string {
	if (!worktreeSetup) return "";
	const diffsDir = parallelWorktreeDiffsDir(artifactsDir, runId);
	const diffs = diffWorktrees(
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
}): string | undefined {
	const seen = new Map<string, { index: number; agent: string }>();
	for (let index = 0; index < input.tasks.length; index++) {
		const behavior = input.behaviors[index];
		if (!behavior?.output) continue;
		const task = input.tasks[index]!;
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
export async function prepareNamedWorktrees(
	params: SubagentParamsLike,
	runtimeCwd: string,
): Promise<{ params: SubagentParamsLike; error?: undefined } | { params?: undefined; error: SubagentToolResult }> {
	const callCwd = params.cwd ?? runtimeCwd;
	const tasks = params.tasks ?? [];
	const cwds = [callCwd, ...tasks.map((task) => resolveRequestedCwd(callCwd, task.cwd))];
	const missing = cwds.find((cwd) => !fs.existsSync(cwd));
	if (missing !== undefined) return { error: launchError(params, missingCwdMessage(missing)) };
	const topLevel = typeof params.worktree === "object" ? params.worktree : undefined;
	if (params.worktree === true && tasks.some((task) => task.worktree !== undefined))
		return {
			error: launchError(
				params,
				"worktree: true gives each task a new worktree of its own, so it cannot be combined with a task's named worktree. Use one or the other.",
			),
		};
	try {
		if (tasks.length === 0)
			return { params: topLevel ? withNamedWorktree(params, await ensureNamedWorktree(callCwd, topLevel)) : params };
		const { worktree: _topLevel, ...rest } = params;
		const preparedTasks: TaskParam[] = [];
		for (const task of tasks) {
			const request = task.worktree ?? topLevel;
			preparedTasks.push(
				request
					? withNamedWorktree(task, await ensureNamedWorktree(resolveRequestedCwd(callCwd, task.cwd), request))
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
