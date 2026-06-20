import { randomUUID } from "node:crypto";
import { APP_NAME } from "@bastani/atomic";
import { executeChain } from "./chain-execution.ts";
import { currentModelFullId } from "../shared/model-fallback.ts";
import { toModelInfo } from "../../shared/model-info.ts";
import { normalizeSkillInput } from "../../agents/skills.ts";
import { updateForegroundNestedProjection } from "../shared/nested-events.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { compactForegroundDetails } from "../../shared/utils.ts";
import { resolveSubagentDepthPolicy } from "../../shared/types.ts";
import type { ChainStep } from "../../shared/settings.ts";
import type { ExecutionContextData, ResolvedExecutorDeps } from "./subagent-executor-types.ts";
import { collectChainSessionFiles, wrapChainTasksForFork } from "./subagent-executor-input.ts";
import { createForegroundControlNotifier, maybeBuildForegroundIntercomReceipt, rememberForegroundRun } from "./subagent-executor-status.ts";

export async function runChainPath(data: ExecutionContextData, deps: ResolvedExecutorDeps): Promise<import("../../shared/types.ts").SubagentToolResult> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		artifactsDir,
		artifactConfig,
		onUpdate,
		sessionRoot,
		controlConfig,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget : undefined;
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const normalized = normalizeSkillInput(params.skill);
	const chainSkills = normalized === false ? [] : (normalized ?? []);
	const chain = wrapChainTasksForFork(params.chain as ChainStep[], params.context);
	const depthPolicy = resolveSubagentDepthPolicy(ctx, deps.config.maxSubagentDepth);
	const currentMaxSubagentDepth = depthPolicy.maxSubagentDepth;
	const workflowStageSubagentGuard = depthPolicy.workflowStageSubagentGuard;
	const chainResult = await executeChain({
		chain,
		task: params.task,
		agents,
		ctx,
		intercomEvents: deps.pi.events,
		signal,
		runId,
		cwd: effectiveCwd,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		artifactsDir,
		artifactConfig,
		includeProgress: params.includeProgress,
		clarify: params.clarify,
		onUpdate,
		onControlEvent,
		controlConfig,
		childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(runId, agent, index) : undefined,
		orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
		foregroundControl,
		nestedRoute: foregroundControl?.nestedRoute,
		chainSkills,
		chainDir: params.chainDir,
		dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
		maxSubagentDepth: currentMaxSubagentDepth,
		workflowStageSubagentGuard,
		worktreeSetupHook: deps.config.worktreeSetupHook,
		worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
		runSync: deps.runtime.runSync,
	});

	if (chainResult.requestedAsync) {
		if (!deps.runtime.isAsyncAvailable()) {
			return {
				content: [{ type: "text", text: `Background mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the ${APP_NAME}-subagents package dependencies are installed.` }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		const id = randomUUID();
		const asyncCtx = {
			pi: deps.pi,
			cwd: ctx.cwd,
			currentSessionId: deps.state.currentSessionId!,
			currentModelProvider: ctx.model?.provider,
			currentModel: currentModelFullId(ctx.model),
		};
		const asyncChain = wrapChainTasksForFork(chainResult.requestedAsync.chain, params.context);
		return deps.runtime.executeAsyncChain(id, {
			chain: asyncChain,
			task: params.task,
			agents,
			ctx: asyncCtx,
			availableModels: ctx.modelRegistry.getAvailable().map(toModelInfo),
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			chainSkills: chainResult.requestedAsync.chainSkills,
			sessionFilesByFlatIndex: collectChainSessionFiles(asyncChain, sessionFileForIndex),
			dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
			maxSubagentDepth: currentMaxSubagentDepth,
			workflowStageSubagentGuard,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			controlConfig,
			controlIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
			childIntercomTarget: data.intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(id, agent, index) : undefined,
			nestedRoute: data.nestedRoute,
		});
	}

	const chainDetails = chainResult.details ? compactForegroundDetails({ ...chainResult.details, runId }) : undefined;
	if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
	if (chainDetails) rememberForegroundRun(deps.state, { runId, mode: "chain", cwd: effectiveCwd, results: chainDetails.results });
	const intercomReceipt = chainDetails && !chainDetails.results.some((result) => result.interrupted || result.detached)
		? await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "chain",
			details: chainDetails,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		})
		: null;
	if (intercomReceipt) {
		return {
			...chainResult,
			content: [{ type: "text", text: intercomReceipt.text }],
			details: intercomReceipt.details,
		};
	}

	return chainDetails ? { ...chainResult, details: chainDetails } : chainResult;
}
