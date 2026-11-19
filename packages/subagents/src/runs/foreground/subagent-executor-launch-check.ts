import type { ExtensionContext } from "@bastani/atomic";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.js";
import { type AgentConfig, contextAgentDiscoveryOptions } from "../../agents/agents.js";
import { resolveStepBehavior } from "../../shared/settings.js";
import { resolveTopLevelParallelMaxTasks, type SubagentToolResult } from "../../shared/types.js";
import { resolveRequestedCwd } from "./subagent-executor-cwd.js";
import { normalizeRepeatedParallelCounts, validateExecutionInput } from "./subagent-executor-input.js";
import {
	parallelOutputSetupError,
	parallelTaskBehaviorOverrides,
	parallelTaskLimitError,
	parallelWorktreeTaskError,
} from "./subagent-executor-parallel.js";
import { singleOutputSetupError } from "./subagent-executor-single.js";
import type { ResolvedExecutorDeps, SubagentParamsLike, TaskParam } from "./subagent-executor-types.js";
import { launchDirectoryError } from "./subagent-executor-worktree.js";

/**
 * The error a launch fails with on its own before any child starts, from the same checks its own run makes: its
 * working directories and worktree requests, its task counts, its agents and mode, its parallel task limit, its
 * `worktree: true` tasks and its output settings. A burst merges sibling launches into one run, which fails as a
 * whole; when it does, this tells which launches the error is their own. Making worktrees is not repeated here, so a
 * failure to make one stays the merged run's, and so does an error only the merged run has, such as too many tasks
 * altogether.
 */
export async function launchSetupError(
	params: SubagentParamsLike,
	ctx: ExtensionContext,
	deps: Pick<ResolvedExecutorDeps, "config" | "discoverAgents">,
	preparedTasks?: TaskParam[],
): Promise<SubagentToolResult | undefined> {
	const launchParams =
		params.cwd === undefined ? params : { ...params, cwd: resolveRequestedCwd(ctx.cwd, params.cwd) };
	const directoryError = await launchDirectoryError(launchParams, ctx.cwd);
	if (directoryError) return directoryError;
	const normalized = normalizeRepeatedParallelCounts(launchParams);
	if (normalized.error) return normalized.error;
	const launch = normalized.params!;
	const effectiveCwd = launch.cwd ?? ctx.cwd;
	const scope = resolveExecutionAgentScope(launch.agentScope);
	const { agents } = await deps.discoverAgents(effectiveCwd, scope, contextAgentDiscoveryOptions(ctx));
	const tasks = launch.tasks ?? [];
	const inputError = validateExecutionInput(launch, agents, tasks.length > 0, tasks.length === 0 && !!launch.agent);
	if (inputError) return inputError;
	const agentNamed = (name: string): AgentConfig => agents.find((agent) => agent.name === name)!;
	if (tasks.length === 0) return singleOutputSetupError(launch, agentNamed(launch.agent!), ctx.cwd, effectiveCwd);

	const limitError = parallelTaskLimitError(
		tasks.length,
		resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks),
	);
	if (limitError) return limitError;
	const worktreeTaskError = await parallelWorktreeTaskError(tasks, launch.worktree, effectiveCwd);
	if (worktreeTaskError) return worktreeTaskError;
	const outputTasks = preparedTasks ?? tasks;
	const agentConfigs = outputTasks.map((task) => agentNamed(task.agent));
	const overrides = parallelTaskBehaviorOverrides(outputTasks, agentConfigs);
	return parallelOutputSetupError({
		tasks: outputTasks,
		behaviors: agentConfigs.map((config, index) => resolveStepBehavior(config, overrides[index]!)),
		paramsCwd: effectiveCwd,
		ctxCwd: ctx.cwd,
		worktreeSetup: undefined,
		unresolvedCwd: preparedTasks ? undefined : (task) => Boolean(launch.worktree || task.worktree),
	});
}
