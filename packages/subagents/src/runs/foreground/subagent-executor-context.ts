import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getEnvValue, type ExtensionContext } from "@bastani/atomic";
import { getArtifactsDir } from "../../shared/artifacts.ts";
import { createForkContextResolver } from "../../shared/fork-context.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.ts";
import {
	applyIntercomBridgeToAgent,
	resolveIntercomBridge,
	resolveIntercomSessionTarget,
	resolveSubagentIntercomTarget,
} from "../../intercom/intercom-bridge.ts";
import {
	createNestedRoute,
	resolveInheritedNestedRouteFromEnv,
	resolveNestedParentAddressFromEnv,
	writeNestedEvent,
} from "../shared/nested-events.ts";
import { SUBAGENT_INTERCOM_SESSION_NAME_ENV } from "../shared/pi-args.ts";
import { resolveControlConfig } from "../shared/subagent-control.ts";
import { applyForceTopLevelAsyncOverride } from "../background/top-level-async.ts";
import {
	DEFAULT_ARTIFACT_CONFIG,
	checkSubagentDepth,
	resolveSubagentDepthPolicy,
	subagentDepthBlockedMessage,
	type ArtifactConfig,
	type SubagentToolResult,
} from "../../shared/types.ts";
import { isParallelStep as isSettingsParallelStep, type SequentialStep } from "../../shared/settings.ts";
import type { ExecutionContextBuildResult, ExecutorDeps, ResolvedExecutorDeps, SubagentParamsLike } from "./subagent-executor-types.ts";
import {
	applyAgentDefaultContext,
	normalizeRepeatedParallelCounts,
	toExecutionErrorResult,
	validateExecutionInput,
	withForkContext,
} from "./subagent-executor-input.ts";

export function checkDepthForExecution(ctx: ExtensionContext, deps: ResolvedExecutorDeps): SubagentToolResult | undefined {
	const depthPolicy = resolveSubagentDepthPolicy(ctx, deps.config.maxSubagentDepth);
	const { blocked, depth, maxDepth, workflowStageGuard } = checkSubagentDepth(depthPolicy.maxSubagentDepth);
	const workflowStageSubagentGuard = workflowStageGuard || depthPolicy.workflowStageSubagentGuard;
	if (!blocked) return undefined;
	return {
		content: [
			{
				type: "text",
				text: subagentDepthBlockedMessage(depth, maxDepth, { workflowStageGuard: workflowStageSubagentGuard }),
			},
		],
		isError: true,
		details: { mode: "single" as const, results: [] },
	};
}

export function prepareExecutionContext(input: {
	params: SubagentParamsLike;
	ctx: ExtensionContext;
	signal: AbortSignal;
	onUpdate?: (r: SubagentToolResult) => void;
	deps: ResolvedExecutorDeps;
}): ExecutionContextBuildResult {
	const { params, ctx, signal, onUpdate, deps } = input;
	const depthPolicy = resolveSubagentDepthPolicy(ctx, deps.config.maxSubagentDepth);
	const { depth } = checkSubagentDepth(depthPolicy.maxSubagentDepth);
	const normalized = normalizeRepeatedParallelCounts(params);
	if (normalized.error) return { error: normalized.error };
	const normalizedParams = normalized.params!;

	let effectiveParams = applyForceTopLevelAsyncOverride(
		normalizedParams,
		depth,
		deps.config.forceTopLevelAsync === true,
	);

	const scope = resolveExecutionAgentScope(effectiveParams.agentScope);
	const effectiveCwd = effectiveParams.cwd ?? ctx.cwd;
	const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
	deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
	const discoveredAgents = deps.discoverAgents(effectiveCwd, scope).agents;
	effectiveParams = applyAgentDefaultContext(effectiveParams, discoveredAgents);
	const sessionName = resolveIntercomSessionTarget(deps.pi.getSessionName(), ctx.sessionManager.getSessionId());
	const intercomBridge = resolveIntercomBridge({
		config: deps.config.intercomBridge,
		context: effectiveParams.context,
		orchestratorTarget: sessionName,
		cwd: effectiveCwd,
	});
	const agents = intercomBridge.active
		? discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))
		: discoveredAgents;
	const runId = randomUUID().slice(0, 8);
	const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	const nestedParentAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
	const nestedRoute = inheritedNestedRoute ?? createNestedRoute(runId);
	const shareEnabled = effectiveParams.share === true;
	const hasChain = (effectiveParams.chain?.length ?? 0) > 0;
	const hasTasks = (effectiveParams.tasks?.length ?? 0) > 0;
	const hasSingle = !hasChain && !hasTasks && Boolean(effectiveParams.agent);
	const validationError = validateExecutionInput(
		effectiveParams,
		agents,
		hasChain,
		hasTasks,
		hasSingle,
	);
	if (validationError) return { error: validationError };

	let sessionFileForIndex: (idx?: number) => string | undefined = () => undefined;
	try {
		sessionFileForIndex = createForkContextResolver(ctx.sessionManager, effectiveParams.context).sessionFileForIndex;
	} catch (error) {
		return { error: toExecutionErrorResult(effectiveParams, error) };
	}
	const effectiveAsync = effectiveParams.async ?? deps.asyncByDefault;
	const controlConfig = resolveControlConfig(deps.config.control, effectiveParams.control);

	const artifactConfig: ArtifactConfig = {
		...DEFAULT_ARTIFACT_CONFIG,
		enabled: effectiveParams.artifacts !== false,
	};
	const artifactsDir = effectiveAsync ? deps.tempArtifactsDir : getArtifactsDir(parentSessionFile);

	let sessionRoot: string;
	if (effectiveParams.sessionDir) {
		sessionRoot = path.resolve(deps.expandTilde(effectiveParams.sessionDir));
	} else {
		const baseSessionRoot = deps.config.defaultSessionDir
			? path.resolve(deps.expandTilde(deps.config.defaultSessionDir))
			: deps.getSubagentSessionRoot(parentSessionFile);
		sessionRoot = path.join(baseSessionRoot, runId);
	}
	try {
		fs.mkdirSync(sessionRoot, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			error: toExecutionErrorResult(
				effectiveParams,
				new Error(`Failed to create session directory '${sessionRoot}': ${message}`),
			),
		};
	}
	const sessionDirForIndex = (idx?: number) =>
		path.join(sessionRoot, `run-${idx ?? 0}`);
	const childSessionFileForIndex = (idx?: number) =>
		sessionFileForIndex(idx) ?? path.join(sessionDirForIndex(idx), "session.jsonl");

	const onUpdateWithContext = onUpdate
		? (r: SubagentToolResult) => onUpdate(withForkContext(r, effectiveParams.context))
		: undefined;

	const execData = {
		params: effectiveParams,
		effectiveCwd,
		ctx,
		signal,
		onUpdate: onUpdateWithContext,
		agents,
		runId,
		shareEnabled,
		sessionRoot,
		sessionDirForIndex,
		sessionFileForIndex: childSessionFileForIndex,
		artifactConfig,
		artifactsDir,
		effectiveAsync,
		controlConfig,
		intercomBridge,
		nestedRoute,
	};

	const foregroundMode: "single" | "parallel" | "chain" = hasChain ? "chain" : hasTasks ? "parallel" : "single";
	const foregroundControl = effectiveAsync
		? undefined
		: {
			runId,
			mode: foregroundMode,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			currentAgent: undefined,
			currentIndex: undefined,
			currentActivityState: undefined,
			nestedRoute,
			interrupt: undefined,
		};
	if (foregroundControl) {
		deps.state.foregroundControls.set(runId, foregroundControl);
		deps.state.lastForegroundControlId = runId;
	}

	const writeNestedForegroundEvent = (type: "subagent.nested.started" | "subagent.nested.completed", result?: SubagentToolResult): void => {
		if (!inheritedNestedRoute || !nestedParentAddress) return;
		const now = Date.now();
		const details = result?.details;
		const state = type === "subagent.nested.started"
			? "running"
			: result?.isError || details?.results.some((child) => child.exitCode !== 0)
				? "failed"
				: details?.results.some((child) => child.interrupted)
					? "paused"
					: "complete";
		const errorText = result?.isError
			? result.content.find((item) => item.type === "text")?.text
			: undefined;
		const agentsForSummary = hasTasks && effectiveParams.tasks
			? effectiveParams.tasks.map((task) => task.agent)
			: hasChain && effectiveParams.chain
				? effectiveParams.chain.flatMap((step) => isSettingsParallelStep(step) ? step.parallel.map((task) => task.agent) : [(step as SequentialStep).agent])
				: effectiveParams.agent ? [effectiveParams.agent] : [];
		const leafIntercomTarget = intercomBridge.active && agentsForSummary[0]
			? resolveSubagentIntercomTarget(runId, agentsForSummary[0], 0)
			: undefined;
		try {
			writeNestedEvent(inheritedNestedRoute, {
				type,
				ts: now,
				parentRunId: nestedParentAddress.parentRunId,
				parentStepIndex: nestedParentAddress.parentStepIndex,
				child: {
					id: runId,
					parentRunId: nestedParentAddress.parentRunId,
					parentStepIndex: nestedParentAddress.parentStepIndex,
					depth: nestedParentAddress.depth,
					path: nestedParentAddress.path,
					ownerIntercomTarget: getEnvValue(SUBAGENT_INTERCOM_SESSION_NAME_ENV),
					leafIntercomTarget,
					intercomTarget: leafIntercomTarget,
					ownerState: state === "running" ? "live" : "gone",
					mode: foregroundMode,
					state,
					agent: agentsForSummary[0],
					agents: agentsForSummary,
					startedAt: foregroundControl?.startedAt ?? now,
					...(state !== "running" ? { endedAt: now } : {}),
					lastUpdate: now,
					...(errorText ? { error: errorText } : {}),
					...(details?.results.length ? { steps: details.results.map((child) => ({
						agent: child.agent,
						status: child.interrupted ? "paused" : child.exitCode === 0 ? "complete" : "failed",
						...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
						...(child.error ? { error: child.error } : {}),
					})) } : {}),
				},
			});
		} catch (error) {
			console.error("Failed to emit nested foreground status event:", error);
		}
	};

	return { prepared: { effectiveParams, effectiveCwd, runId, hasChain, hasTasks, hasSingle, foregroundMode, execData, foregroundControl, writeNestedForegroundEvent } };
}

export type { ExecutorDeps };
