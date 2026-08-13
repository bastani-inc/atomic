import { APP_NAME } from "@bastani/atomic";
import { normalizeSkillInput } from "../../agents/skills.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { collectKnownModelProviders, toModelInfo } from "../../shared/model-info.ts";
import { createCandidateModelResolver } from "../../shared/model-resolution.ts";
import type { SingleResult, SubagentToolResult } from "../../shared/types.ts";
import {
	resolveChildMaxSubagentDepth,
	resolveSubagentDepthPolicy,
	resolveTopLevelParallelMaxTasks,
	workflowSessionMetadataFromContext,
	wrapForkTask,
} from "../../shared/types.ts";
import { formatAsyncStartedMessage } from "../inprocess/background.ts";
import { inheritedIntercomGroup } from "../shared/intercom-group.js";
import { runParallelPath } from "./subagent-executor-parallel.ts";
import type { ExecutionContextData, ResolvedExecutorDeps } from "./subagent-executor-types.ts";
import { buildParallelModeError, buildParallelWorktreeTaskCwdError } from "./subagent-executor-worktree.ts";

function continuedResult(data: ExecutionContextData, mode: "single" | "parallel"): SingleResult {
	const path = `${data.runId}/orchestration_1`;
	return {
		agent: mode,
		task: data.params.task ?? `${mode} subagent run`,
		status: "continued",
		path,
		envelope: "Child continued in background.",
		detached: true,
		detachedReason: "async-requested",
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		progress: {
			index: 0,
			agent: mode,
			status: "running",
			task: data.params.task ?? `${mode} subagent run`,
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			turnCount: 0,
			tokens: 0,
			durationMs: 0,
			lastActivityAt: Date.now(),
		},
	};
}

function modeFor(data: ExecutionContextData): "single" | "parallel" {
	if ((data.params.tasks?.length ?? 0) > 0) return "parallel";
	return "single";
}

function runForegroundInBackground(data: ExecutionContextData, deps: ResolvedExecutorDeps): void {
	const backgroundData: ExecutionContextData = { ...data, effectiveAsync: false };
	void runParallelPath(backgroundData, deps).catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[${APP_NAME}-subagents] in-process async parallel failed: ${message}`);
	});
}

/** Async is a don't-wait request over the same in-process foreground executor. */
export async function runAsyncPath(
	data: ExecutionContextData,
	deps: ResolvedExecutorDeps,
): Promise<SubagentToolResult | null> {
	if (!data.effectiveAsync) return null;

	const mode = modeFor(data);
	const { params, effectiveCwd } = data;
	if (mode === "parallel" && params.tasks) {
		const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
		if (params.tasks.length > maxParallelTasks) return buildParallelModeError(`Max ${maxParallelTasks} tasks`);
		if (params.worktree) {
			const worktreeTaskCwdError = buildParallelWorktreeTaskCwdError(params.tasks, effectiveCwd);
			if (worktreeTaskCwdError) return buildParallelModeError(worktreeTaskCwdError);
		}
	}
	if (!deps.runtime.isAsyncAvailable()) {
		return {
			content: [
				{
					type: "text",
					text: `Async mode requires the in-process runner but it could not be initialized. Ensure the ${APP_NAME}-subagents package is installed.`,
				},
			],
			isError: true,
			details: { mode, results: [] },
		};
	}

	if (mode === "single") {
		const agent = data.agents.find((candidate) => candidate.name === params.agent);
		if (!agent) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
				isError: true,
				details: { mode: "single", results: [] },
			};
		}
		const availableModels = data.ctx.modelRegistry.getAvailable().map(toModelInfo);
		const knownModelProviders = collectKnownModelProviders(data.ctx.modelRegistry);
		const depthPolicy = resolveSubagentDepthPolicy(data.ctx, deps.config.maxSubagentDepth);
		const normalizedSkills = normalizeSkillInput(params.skill);
		const skills = normalizedSkills === false ? [] : normalizedSkills;
		const task = params.context === "fork" ? wrapForkTask(params.task ?? "") : (params.task ?? "");
		const childIntercomTarget = data.intercomBridge.active
			? (childAgent: string, index: number) => resolveSubagentIntercomTarget(data.runId, childAgent, index)
			: undefined;
		const currentModel = data.ctx.model ? `${data.ctx.model.provider}/${data.ctx.model.id}` : undefined;
		const modelOverride = params.model ?? agent.model;
		return deps.runtime.executeAsyncSingle(data.runId, {
			agent: params.agent!,
			task,
			group: params.group,
			agentConfig: agent,
			ctx: {
				pi: deps.pi,
				cwd: data.ctx.cwd,
				currentSessionId: deps.state.currentSessionId ?? data.ctx.sessionManager.getSessionId(),
				currentModelProvider: data.ctx.model?.provider,
				currentModel,
				intercomGroup: inheritedIntercomGroup(data.ctx),
				workflowSessionMetadata: workflowSessionMetadataFromContext(data.ctx),
			},
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: data.artifactConfig.enabled ? data.artifactsDir : undefined,
			artifactConfig: data.artifactConfig,
			shareEnabled: data.shareEnabled,
			sessionRoot: data.sessionRoot,
			sessionFile: data.sessionFileForIndex(0),
			skills,
			output: params.output,
			outputMode: params.outputMode,
			progress: params.progress,
			modelOverride,
			availableModels,
			knownModelProviders,
			resolveCandidateModel: createCandidateModelResolver(data.ctx.modelRegistry, data.ctx.model?.provider),
			maxSubagentDepth: resolveChildMaxSubagentDepth(depthPolicy.maxSubagentDepth, agent.maxSubagentDepth),
			parentDepth: data.parentDepth,
			workflowStageSubagentGuard: depthPolicy.workflowStageSubagentGuard,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			controlConfig: data.controlConfig,
			controlIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
			childIntercomTarget,
			nestedRoute: data.nestedRoute,
		});
	}

	const continued = continuedResult(data, mode);
	if (mode === "parallel") runForegroundInBackground(data, deps);
	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(`Async ${mode}: ${data.runId}`) }],
		details: {
			mode,
			runId: data.runId,
			asyncId: data.runId,
			results: [continued],
		},
	};
}
