import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.js";
import type { AgentConfig } from "../../agents/agents.js";
import {
	applyIntercomBridgeToAgent,
	resolveIntercomBridge,
	resolveIntercomSessionTarget,
} from "../../intercom/intercom-bridge.js";
import { getArtifactsDir } from "../../shared/artifacts.js";
import { createForkContextResolver } from "../../shared/fork-context.js";
import { resolveCurrentSessionId } from "../../shared/session-identity.js";
import { buildReadInstruction } from "../../shared/settings.js";
import {
	type ArtifactConfig,
	DEFAULT_ARTIFACT_CONFIG,
	getCurrentSubagentDepth,
	isSubagentChildSession,
	SUBAGENT_CHILD_DELEGATION_BLOCKED_MESSAGE,
	type SubagentRunMode,
	type SubagentToolResult,
} from "../../shared/types.js";
import { resolveControlConfig } from "../shared/subagent-control.js";
import {
	applyAgentDefaultContext,
	normalizeRepeatedParallelCounts,
	toExecutionErrorResult,
	validateExecutionInput,
	withForkContext,
} from "./subagent-executor-input.js";
import {
	BURST_TASK_DISCOVERY_CWD,
	type BurstTaskParam,
	type ExecutionContextBuildResult,
	type ExecutionContextData,
	type ExecutorDeps,
	type ResolvedExecutorDeps,
	type SubagentParamsLike,
} from "./subagent-executor-types.js";

/**
 * Delegation is one level deep and not configurable: a session that was itself
 * admitted as a subagent child may never call the subagent tool.
 */
export function refuseSubagentChildDelegation(
	ctx: Pick<ExtensionContext, "subagentPolicy">,
	mode: SubagentRunMode | "management",
): SubagentToolResult | undefined {
	if (!isSubagentChildSession(ctx)) return undefined;
	return {
		content: [{ type: "text", text: SUBAGENT_CHILD_DELEGATION_BLOCKED_MESSAGE }],
		isError: true,
		details: { mode, results: [] },
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
	const depth = getCurrentSubagentDepth(ctx);
	const normalized = normalizeRepeatedParallelCounts(params);
	if (normalized.error) return { error: normalized.error };
	const normalizedParams = normalized.params!;

	let effectiveParams = normalizedParams;

	const scope = resolveExecutionAgentScope(effectiveParams.agentScope);
	const effectiveCwd = effectiveParams.cwd ?? ctx.cwd;
	const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
	deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
	const initialDiscoveryCwd =
		(effectiveParams.tasks?.[0] as BurstTaskParam | undefined)?.[BURST_TASK_DISCOVERY_CWD] ?? effectiveCwd;
	const discoveredAgents = deps.discoverAgents(initialDiscoveryCwd, scope).agents;
	let resolvedTaskAgents: AgentConfig[] | undefined;
	if (effectiveParams.tasks?.some((task) => (task as BurstTaskParam)[BURST_TASK_DISCOVERY_CWD] !== undefined)) {
		const agentsByCwd = new Map<string, AgentConfig[]>([[initialDiscoveryCwd, discoveredAgents]]);
		resolvedTaskAgents = [];
		for (let index = 0; index < effectiveParams.tasks.length; index++) {
			const task = effectiveParams.tasks[index]!;
			const discoveryCwd = (task as BurstTaskParam)[BURST_TASK_DISCOVERY_CWD] ?? effectiveCwd;
			let taskAgents = agentsByCwd.get(discoveryCwd);
			if (!taskAgents) {
				taskAgents = deps.discoverAgents(discoveryCwd, scope).agents;
				agentsByCwd.set(discoveryCwd, taskAgents);
			}
			const agent = taskAgents.find((candidate) => candidate.name === task.agent);
			if (!agent) {
				return {
					error: {
						content: [{ type: "text", text: `Unknown agent: ${task.agent} (task ${index + 1})` }],
						isError: true,
						details: { mode: "parallel", results: [] },
					},
				};
			}
			resolvedTaskAgents.push(agent);
		}
	}
	if (effectiveParams.context === undefined && resolvedTaskAgents?.some((agent) => agent.defaultContext === "fork")) {
		effectiveParams = { ...effectiveParams, context: "fork" };
	} else {
		effectiveParams = applyAgentDefaultContext(effectiveParams, discoveredAgents);
	}
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
	const parallelAgentConfigs = intercomBridge.active
		? resolvedTaskAgents?.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))
		: resolvedTaskAgents;
	const runId = randomUUID().slice(0, 8);
	const shareEnabled = effectiveParams.share === true;
	const hasTasks = (effectiveParams.tasks?.length ?? 0) > 0;
	const hasSingle = !hasTasks && Boolean(effectiveParams.agent);
	const validationError = validateExecutionInput(effectiveParams, agents, hasTasks, hasSingle, parallelAgentConfigs);
	if (validationError) return { error: validationError };
	if (hasSingle) {
		const readInstruction = buildReadInstruction(effectiveParams.reads, effectiveCwd);
		if (readInstruction)
			effectiveParams = { ...effectiveParams, task: `${readInstruction}\n\n${effectiveParams.task ?? ""}` };
	}

	let sessionFileForIndex: (idx?: number) => string | undefined = () => undefined;
	try {
		sessionFileForIndex = createForkContextResolver(ctx.sessionManager, effectiveParams.context).sessionFileForIndex;
	} catch (error) {
		return { error: toExecutionErrorResult(effectiveParams, error) };
	}
	const controlConfig = resolveControlConfig(deps.config.control, effectiveParams.control);

	const artifactConfig: ArtifactConfig = {
		...DEFAULT_ARTIFACT_CONFIG,
		enabled: effectiveParams.artifacts !== false,
	};
	const artifactsDir = getArtifactsDir(parentSessionFile);

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
	const sessionDirForIndex = (idx?: number) => path.join(sessionRoot, `run-${idx ?? 0}`);
	const childSessionFileForIndex = (idx?: number) =>
		sessionFileForIndex(idx) ?? path.join(sessionDirForIndex(idx), "session.jsonl");

	const onUpdateWithContext = onUpdate
		? (r: SubagentToolResult) => onUpdate(withForkContext(r, effectiveParams.context))
		: undefined;

	const execData: ExecutionContextData = {
		params: effectiveParams,
		effectiveCwd,
		ctx,
		signal,
		onUpdate: onUpdateWithContext,
		agents,
		...(parallelAgentConfigs ? { parallelAgentConfigs } : {}),
		runId,
		shareEnabled,
		sessionRoot,
		sessionDirForIndex,
		sessionFileForIndex: childSessionFileForIndex,
		artifactConfig,
		artifactsDir,
		parentDepth: depth,
		controlConfig,
		intercomBridge,
	};

	const foregroundMode: "single" | "parallel" = hasTasks ? "parallel" : "single";
	const foregroundControl = {
		runId,
		mode: foregroundMode,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		interrupt: undefined,
	};
	deps.state.foregroundControls.set(runId, foregroundControl);
	deps.state.lastForegroundControlId = runId;

	return {
		prepared: {
			effectiveParams,
			effectiveCwd,
			runId,
			hasTasks,
			hasSingle,
			foregroundMode,
			execData,
			foregroundControl,
		},
	};
}

export type { ExecutorDeps };
