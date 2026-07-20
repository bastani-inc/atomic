import { randomUUID } from "node:crypto";
import { APP_NAME } from "@bastani/atomic";
import { currentModelFullId, resolveModelCandidate } from "../shared/model-fallback.ts";
import { collectKnownModelProviders, toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import { normalizeSkillInput } from "../../agents/skills.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import {
	resolveChildMaxSubagentDepth,
	resolveSubagentDepthPolicy,
	resolveTopLevelParallelConcurrency,
	resolveTopLevelParallelMaxTasks,
	workflowSessionMetadataFromContext,
	wrapForkTask,
} from "../../shared/types.ts";
import { isDynamicParallelStep, isParallelStep, resolveSingleProgress, type ChainStep, type SequentialStep } from "../../shared/settings.ts";
import { normalizeSingleOutputOverride } from "../shared/single-output.ts";
import type { ExecutionContextData, ResolvedExecutorDeps } from "./subagent-executor-types.ts";
import { collectChainSessionFiles, wrapChainTasksForFork } from "./subagent-executor-input.ts";
import { buildChainWorktreeTaskCwdError, buildParallelModeError, buildParallelWorktreeTaskCwdError } from "./subagent-executor-worktree.ts";
import { requestSupervisorAuthorization, type SupervisorAuthorization } from "../../intercom/supervisor-authorization.ts";

async function authorizeChild(deps: ResolvedExecutorDeps, childName: string | undefined): Promise<SupervisorAuthorization | undefined> {
	return await requestSupervisorAuthorization(deps.pi.events, childName);
}

async function authorizeAsyncChain(
	chain: ChainStep[],
	childTarget: ((agent: string, index: number) => string | undefined) | undefined,
	dynamicMaxItems: number | undefined,
	deps: ResolvedExecutorDeps,
): Promise<{
	authorizations?: Array<SupervisorAuthorization | undefined>;
	dynamic?: Record<number, SupervisorAuthorization[]>;
}> {
	if (!childTarget) return {};
	const authorizations: Array<SupervisorAuthorization | undefined> = [];
	const dynamic: Record<number, SupervisorAuthorization[]> = {};
	for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
		const step = chain[stepIndex]!;
		if (isDynamicParallelStep(step)) {
			authorizations.push(undefined);

			const count = Math.max(0, dynamicMaxItems ?? 0);
			dynamic[stepIndex] = (await Promise.all(
				Array.from({ length: count }, () => authorizeChild(deps, "*")),
			)).filter((value): value is SupervisorAuthorization => value !== undefined);
			continue;
		}
		const agents = isParallelStep(step)
			? step.parallel.map((task) => task.agent)
			: [(step as SequentialStep).agent];
		for (let index = 0; index < agents.length; index++) {
			authorizations.push(await authorizeChild(deps, "*"));
		}
	}
	return {
		authorizations,
		...(Object.keys(dynamic).length > 0 ? { dynamic } : {}),
	};
}


export async function runAsyncPath(data: ExecutionContextData, deps: ResolvedExecutorDeps): Promise<import("../../shared/types.ts").SubagentToolResult | null> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		shareEnabled,
		sessionRoot,
		sessionFileForIndex,
		artifactConfig,
		artifactsDir,
		effectiveAsync,
		controlConfig,
		intercomBridge,
		nestedRoute,
	} = data;
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = !hasChain && !hasTasks && Boolean(params.agent);
	if (!effectiveAsync) return null;

	if (hasChain && params.chain) {
		const chainWorktreeTaskCwdError = buildChainWorktreeTaskCwdError(params.chain as ChainStep[], effectiveCwd);
		if (chainWorktreeTaskCwdError) {
			return {
				content: [{ type: "text", text: chainWorktreeTaskCwdError }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
	}

	if (hasTasks && params.tasks) {
		const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
		if (params.tasks.length > maxParallelTasks) {
			return buildParallelModeError(`Max ${maxParallelTasks} tasks`);
		}
		if (params.worktree) {
			const worktreeTaskCwdError = buildParallelWorktreeTaskCwdError(params.tasks, effectiveCwd);
			if (worktreeTaskCwdError) return buildParallelModeError(worktreeTaskCwdError);
		}
	}

	if (!deps.runtime.isAsyncAvailable()) {
		return {
			content: [{ type: "text", text: `Async mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the ${APP_NAME}-subagents package dependencies are installed.` }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}
	const id = randomUUID();
	const asyncCtx = {
		pi: deps.pi,
		cwd: ctx.cwd,
		currentSessionId: deps.state.currentSessionId!,
		currentModelProvider: ctx.model?.provider,
		currentModel: currentModelFullId(ctx.model),
		workflowSessionMetadata: workflowSessionMetadataFromContext(ctx),
	};
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const knownModelProviders = collectKnownModelProviders(ctx.modelRegistry);
	const depthPolicy = resolveSubagentDepthPolicy(ctx, deps.config.maxSubagentDepth);
	const currentMaxSubagentDepth = depthPolicy.maxSubagentDepth;
	const workflowStageSubagentGuard = depthPolicy.workflowStageSubagentGuard;
	const currentProvider = ctx.model?.provider;
	const controlIntercomTarget = intercomBridge.active ? intercomBridge.orchestratorTarget : undefined;
	const childIntercomTarget = intercomBridge.active ? (agent: string, index: number) => resolveSubagentIntercomTarget(id, agent, index) : undefined;

	if (hasTasks && params.tasks) {
		const agentConfigs = params.tasks.map((task) => agents.find((agent) => agent.name === task.agent));
		const modelOverrides = params.tasks.map((task, index) =>
			resolveModelCandidate(task.model ?? agentConfigs[index]?.model, availableModels, currentProvider),
		);
		const skillOverrides = params.tasks.map((task) => normalizeSkillInput(task.skill));
		const parallelTasks = params.tasks.map((task, index) => ({
			agent: task.agent,
			task: params.context === "fork" ? wrapForkTask(task.task) : task.task,
			cwd: task.cwd,
			...(modelOverrides[index] ? { model: modelOverrides[index] } : {}),
			...(skillOverrides[index] !== undefined ? { skill: skillOverrides[index] } : {}),
			...(task.output === true ? (agentConfigs[index]?.output ? { output: agentConfigs[index]!.output } : {}) : task.output !== undefined ? { output: task.output } : {}),
			...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
			...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
			...(task.progress !== undefined ? { progress: task.progress } : {}),
		}));
		const supervisorAuthorizations = childIntercomTarget
			? await Promise.all(params.tasks.map((task, index) => authorizeChild(deps, childIntercomTarget(task.agent, index))))
			: undefined;
		return deps.runtime.executeAsyncChain(id, {
			chain: [{
				parallel: parallelTasks,
				concurrency: resolveTopLevelParallelConcurrency(params.concurrency, deps.config.parallel?.concurrency),
				worktree: params.worktree,
			}],
			resultMode: "parallel",
			agents,
			ctx: asyncCtx,
			availableModels,
			knownModelProviders,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			chainSkills: [],
			sessionFilesByFlatIndex: params.tasks.map((_, index) => sessionFileForIndex(index)),
			maxSubagentDepth: currentMaxSubagentDepth,
			workflowStageSubagentGuard,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			worktreeSymlinkDirectories: deps.config.worktree?.symlinkDirectories,
			controlConfig,
			controlIntercomTarget,
			childIntercomTarget,
			supervisorAuthorizations,
			nestedRoute,
		});
	}

	if (hasChain && params.chain) {
		const normalized = normalizeSkillInput(params.skill);
		const chainSkills = normalized === false ? [] : (normalized ?? []);
		const chain = wrapChainTasksForFork(params.chain as ChainStep[], params.context);
		const supervisor = await authorizeAsyncChain(
			chain,
			childIntercomTarget,
			deps.config.chain?.dynamicFanout?.maxItems,
			deps,
		);
		return deps.runtime.executeAsyncChain(id, {
			chain,
			task: params.task,
			agents,
			ctx: asyncCtx,
			availableModels,
			knownModelProviders,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			chainSkills,
			sessionFilesByFlatIndex: collectChainSessionFiles(chain, sessionFileForIndex),
			dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
			maxSubagentDepth: currentMaxSubagentDepth,
			workflowStageSubagentGuard,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			worktreeSymlinkDirectories: deps.config.worktree?.symlinkDirectories,
			controlConfig,
			controlIntercomTarget,
			childIntercomTarget,
			supervisorAuthorizations: supervisor.authorizations,
			dynamicSupervisorAuthorizations: supervisor.dynamic,
			nestedRoute,
		});
	}

	if (hasSingle) {
		const a = agents.find((x) => x.name === params.agent);
		if (!a) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		}
		const rawOutput = params.output !== undefined ? params.output : a.output;
		const effectiveOutput = normalizeSingleOutputOverride(rawOutput, a.output);
		const effectiveOutputMode = params.outputMode ?? "inline";
		const normalizedSkills = normalizeSkillInput(params.skill);
		const skills = normalizedSkills === false ? [] : normalizedSkills;
		const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, a.maxSubagentDepth);
		const modelOverride = resolveModelCandidate((params.model as string | undefined) ?? a.model, availableModels, currentProvider);
		const progress = resolveSingleProgress(a, params.progress, params.task);
		const supervisorAuthorization = childIntercomTarget
			? await authorizeChild(deps, childIntercomTarget(params.agent!, 0))
			: undefined;
		return deps.runtime.executeAsyncSingle(id, {
			agent: params.agent!,
			task: params.context === "fork" ? wrapForkTask(params.task ?? "") : (params.task ?? ""),
			agentConfig: a,
			ctx: asyncCtx,
			availableModels,
			knownModelProviders,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			sessionFile: sessionFileForIndex(0),
			skills,
			output: effectiveOutput,
			outputMode: effectiveOutputMode,
			progress,
			modelOverride,
			maxSubagentDepth,
			workflowStageSubagentGuard,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			worktreeSymlinkDirectories: deps.config.worktree?.symlinkDirectories,
			controlConfig,
			controlIntercomTarget,
			childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(agent, index) : undefined,
			supervisorAuthorization,
			nestedRoute,
		});
	}

	return null;
}
