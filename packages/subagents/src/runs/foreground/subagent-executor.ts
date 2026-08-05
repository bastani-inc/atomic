import type { ExtensionContext } from "@bastani/atomic";
import { handleManagementAction } from "../../agents/agent-management.ts";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.ts";
import { clearPendingForegroundControlNotices } from "../../extension/control-notices.ts";
import { buildDoctorReport } from "../../extension/doctor.ts";
import {
	resolveIntercomBridge,
	resolveIntercomSessionTarget,
	resolveSubagentIntercomTarget,
} from "../../intercom/intercom-bridge.ts";
import { requestSupervisorAuthorization } from "../../intercom/supervisor-authorization.ts";
import { getArtifactsDir } from "../../shared/artifacts.ts";
import { toModelInfo } from "../../shared/model-info.ts";
import { resolveSingleProgress } from "../../shared/settings.ts";
import {
	DEFAULT_ARTIFACT_CONFIG,
	isWorkflowStageOrchestrationContext,
	resolveWorkflowStageMaxSubagentDepth,
	SUBAGENT_ACTIONS,
	type SubagentToolResult,
	workflowSessionMetadataFromContext,
} from "../../shared/types.ts";
import {
	inspectInProcessChildStatus,
	interruptInProcessChild,
	resumeInProcessChild,
} from "../inprocess/control-status.ts";
import { inheritedIntercomGroup } from "../shared/intercom-group.ts";
import { currentModelFullId } from "../shared/model-fallback.ts";
import { resolveControlConfig } from "../shared/subagent-control.ts";
import { runAsyncPath } from "./subagent-executor-async.ts";
import { runChainPath } from "./subagent-executor-chain.ts";
import { checkDepthForExecution, prepareExecutionContext } from "./subagent-executor-context.ts";
import { toExecutionErrorResult, withForkContext } from "./subagent-executor-input.ts";
import { runParallelPath } from "./subagent-executor-parallel.ts";
import { resolveRequestedCwd } from "./subagent-executor-resume.ts";
import { resolveSubagentExecutorRuntimeDeps } from "./subagent-executor-runtime.ts";
import { runSinglePath } from "./subagent-executor-single.ts";
import {
	foregroundStatusResult,
	getForegroundControl,
	retainedForegroundStatusResult,
} from "./subagent-executor-status.ts";
import {
	type ExecutorDeps,
	isManagementActionsRestricted,
	type ResolvedExecutorDeps,
	type SubagentParamsLike,
} from "./subagent-executor-types.ts";

async function resumeRetainedForegroundChild(
	params: SubagentParamsLike,
	message: string,
	ctx: ExtensionContext,
	deps: ResolvedExecutorDeps,
): Promise<SubagentToolResult | undefined> {
	const requested = params.id ?? params.runId;
	if (!requested) return undefined;
	const run = deps.state.foregroundRuns?.get(requested);
	if (!run) return undefined;
	const child = run.children[params.index ?? 0];
	if (!child) return undefined;
	const agents = deps.discoverAgents(run.cwd, resolveExecutionAgentScope(params.agentScope)).agents;
	const agentConfig = agents.find((agent) => agent.name === child.agent);
	if (!agentConfig) {
		return {
			content: [{ type: "text", text: `Unknown agent for resume: ${child.agent}` }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}
	const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
	const sessionName = resolveIntercomSessionTarget(deps.pi.getSessionName(), ctx.sessionManager.getSessionId());
	const intercomBridge = resolveIntercomBridge({
		config: deps.config.intercomBridge,
		context: params.context,
		orchestratorTarget: sessionName,
		cwd: run.cwd,
	});
	const supervisedTarget = intercomBridge.active
		? resolveSubagentIntercomTarget(run.runId, child.agent, child.index)
		: undefined;
	const supervisorAuthorization = await requestSupervisorAuthorization(deps.pi.events, supervisedTarget);
	return deps.runtime.executeAsyncSingle(run.runId, {
		agent: child.agent,
		agentConfig,
		task: message,
		ctx: {
			pi: deps.pi,
			cwd: run.cwd,
			currentSessionId: ctx.sessionManager.getSessionId(),
			currentModelProvider: ctx.model?.provider,
			currentModel: currentModelFullId(ctx.model),
			intercomGroup: inheritedIntercomGroup(ctx),
			workflowSessionMetadata: workflowSessionMetadataFromContext(ctx),
		},
		cwd: run.cwd,
		maxOutput: params.maxOutput,
		artifactsDir: getArtifactsDir(parentSessionFile),
		artifactConfig: { ...DEFAULT_ARTIFACT_CONFIG, enabled: params.artifacts !== false },
		shareEnabled: params.share === true,
		sessionRoot: deps.getSubagentSessionRoot(parentSessionFile),
		sessionFile: child.sessionFile,
		progress: resolveSingleProgress(agentConfig, params.progress, message),
		modelOverride: params.model,
		availableModels: ctx.modelRegistry.getAvailable().map(toModelInfo),
		maxSubagentDepth: resolveWorkflowStageMaxSubagentDepth(ctx, deps.config.maxSubagentDepth),
		workflowStageSubagentGuard: isWorkflowStageOrchestrationContext(ctx),
		controlConfig: resolveControlConfig(deps.config.control, params.control),
		controlIntercomTarget: intercomBridge.active ? intercomBridge.orchestratorTarget : undefined,
		childIntercomTarget: intercomBridge.active
			? (agent, index) => resolveSubagentIntercomTarget(run.runId, agent, index)
			: undefined,
		supervisorAuthorization,
	});
}
const MUTATING_MANAGEMENT_ACTIONS = new Set(["create", "update", "delete"]);

export type { SubagentExecutorRuntimeDeps, SubagentParamsLike } from "./subagent-executor-types.ts";

async function handleManagementRequest(input: {
	params: SubagentParamsLike;
	paramsWithResolvedCwd: SubagentParamsLike;
	requestCwd: string;
	ctx: ExtensionContext;
	deps: ResolvedExecutorDeps;
}): Promise<SubagentToolResult> {
	const { params, paramsWithResolvedCwd, requestCwd, ctx, deps } = input;
	const action = params.action;
	if (!action) {
		return {
			content: [{ type: "text", text: "Missing action." }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (action === "doctor") {
		let currentSessionFile: string | null = null;
		let currentSessionId = deps.state.currentSessionId;
		let sessionError: string | undefined;
		try {
			currentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
			currentSessionId = ctx.sessionManager.getSessionId();
		} catch (error) {
			sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		}
		let orchestratorTarget: string | undefined;
		try {
			orchestratorTarget = resolveIntercomSessionTarget(deps.pi.getSessionName(), ctx.sessionManager.getSessionId());
		} catch {}
		return {
			content: [
				{
					type: "text",
					text: buildDoctorReport({
						cwd: requestCwd,
						config: deps.config,
						state: deps.state,
						context: paramsWithResolvedCwd.context,
						requestedSessionDir: paramsWithResolvedCwd.sessionDir,
						currentSessionFile,
						currentSessionId,
						orchestratorTarget,
						sessionError,
						expandTilde: deps.expandTilde,
					}),
				},
			],
			details: { mode: "management", results: [] },
		};
	}
	if (action === "status") {
		const targetRunId = paramsWithResolvedCwd.id ?? paramsWithResolvedCwd.runId;
		const inProcess = inspectInProcessChildStatus(targetRunId);
		if (inProcess) return inProcess;
		const foreground = getForegroundControl(deps.state, targetRunId);
		if (foreground) return foregroundStatusResult(foreground);
		if (targetRunId) {
			const retained = retainedForegroundStatusResult(deps.state, targetRunId);
			if (retained) return retained;
		}
		return {
			content: [
				{
					type: "text",
					text: targetRunId ? `No in-process child found for '${targetRunId}'.` : "No in-process subagent found.",
				},
			],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (action === "resume") {
		const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
		const message = paramsWithResolvedCwd.message ?? paramsWithResolvedCwd.task;
		if (!targetRunId || !message) {
			return {
				content: [{ type: "text", text: "action='resume' requires id/runId and message." }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		const inProcess = await resumeInProcessChild(targetRunId, message, { model: ctx.model });
		if (inProcess) return inProcess;
		const retained = await resumeRetainedForegroundChild(paramsWithResolvedCwd, message, ctx, deps);
		if (retained) return retained;
		return {
			content: [{ type: "text", text: `No in-process child found for '${targetRunId}'.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (action === "interrupt") {
		const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
		if (targetRunId) {
			const inProcess = await interruptInProcessChild(targetRunId);
			if (inProcess) return inProcess;
		}
		return {
			content: [
				{
					type: "text",
					text: targetRunId
						? `No running in-process child found for '${targetRunId}'.`
						: "No interrupt-capable child found.",
				},
			],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (!(SUBAGENT_ACTIONS as readonly string[]).includes(action)) {
		return {
			content: [{ type: "text", text: `Unknown action: ${action}. Valid: ${SUBAGENT_ACTIONS.join(", ")}` }],
			isError: true,
			details: { mode: "management" as const, results: [] },
		};
	}
	if (isManagementActionsRestricted(deps) && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
		return {
			content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }],
			isError: true,
			details: { mode: "management" as const, results: [] },
		};
	}
	return handleManagementAction(action, paramsWithResolvedCwd, { ...ctx, cwd: requestCwd });
}

function inferExecutionMode(params: SubagentParamsLike): "single" | "parallel" | "chain" {
	if ((params.chain?.length ?? 0) > 0) return "chain";
	if ((params.tasks?.length ?? 0) > 0) return "parallel";
	return "single";
}

function duplicateSubagentCallResult(params: SubagentParamsLike): SubagentToolResult {
	return {
		content: [
			{
				type: "text",
				text: "Rejected: a subagent call is already in progress. Issue exactly ONE subagent call per turn.",
			},
		],
		isError: true,
		details: { mode: inferExecutionMode(params), results: [] },
	};
}

export function createSubagentExecutor(rawDeps: ExecutorDeps): {
	execute: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: SubagentToolResult) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<SubagentToolResult>;
} {
	const deps: ResolvedExecutorDeps = { ...rawDeps, runtime: resolveSubagentExecutorRuntimeDeps(rawDeps.runtime) };
	const execute = async (
		_id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: SubagentToolResult) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<SubagentToolResult> => {
		if (deps.childPolicy && !deps.childPolicy.fanoutAuthorized) {
			return {
				content: [{ type: "text", text: "Subagent fanout is not authorized for this child." }],
				isError: true,
				details: { mode: "single", results: [] },
			};
		}
		deps.state.baseCwd = ctx.cwd;
		deps.state.foregroundRuns ??= new Map();
		deps.state.foregroundControls ??= new Map();
		deps.state.lastForegroundControlId ??= null;
		const requestCwd = resolveRequestedCwd(ctx.cwd, params.cwd);
		const paramsWithResolvedCwd = params.cwd === undefined ? params : { ...params, cwd: requestCwd };
		if (params.action) {
			return handleManagementRequest({ params, paramsWithResolvedCwd, requestCwd, ctx, deps });
		}

		const depthError = checkDepthForExecution(ctx, deps);
		if (depthError) return depthError;

		const built = prepareExecutionContext({ params: paramsWithResolvedCwd, ctx, signal, onUpdate, deps });
		if (built.error) return built.error;
		const prepared = built.prepared!;
		let nestedForegroundStarted = false;
		try {
			const asyncResult = await runAsyncPath(prepared.execData, deps);
			if (asyncResult) return withForkContext(asyncResult, prepared.effectiveParams.context);
			if (prepared.foregroundControl) {
				prepared.writeNestedForegroundEvent("subagent.nested.started");
				nestedForegroundStarted = true;
			}
			if (prepared.hasChain && prepared.effectiveParams.chain) {
				const result = await runChainPath(prepared.execData, deps);
				prepared.writeNestedForegroundEvent("subagent.nested.completed", result);
				return withForkContext(result, prepared.effectiveParams.context);
			}
			if (prepared.hasTasks && prepared.effectiveParams.tasks) {
				const result = await runParallelPath(prepared.execData, deps);
				prepared.writeNestedForegroundEvent("subagent.nested.completed", result);
				return withForkContext(result, prepared.effectiveParams.context);
			}
			if (prepared.hasSingle) {
				const result = await runSinglePath(prepared.execData, deps);
				prepared.writeNestedForegroundEvent("subagent.nested.completed", result);
				return withForkContext(result, prepared.effectiveParams.context);
			}
		} catch (error) {
			const errorResult = toExecutionErrorResult(prepared.effectiveParams, error);
			if (nestedForegroundStarted) prepared.writeNestedForegroundEvent("subagent.nested.completed", errorResult);
			return errorResult;
		} finally {
			if (prepared.foregroundControl) {
				clearPendingForegroundControlNotices(deps.state, prepared.runId);
				deps.state.foregroundControls.delete(prepared.runId);
				if (deps.state.lastForegroundControlId === prepared.runId) {
					deps.state.lastForegroundControlId = null;
				}
			}
		}

		return withForkContext(
			{
				content: [{ type: "text", text: "Invalid params" }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			},
			prepared.effectiveParams.context,
		);
	};

	const executeWithSingleDispatchGuard = async (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: SubagentToolResult) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<SubagentToolResult> => {
		if (params.action) return execute(id, params, signal, onUpdate, ctx);
		if (deps.state.subagentInProgress === true) return duplicateSubagentCallResult(params);
		deps.state.subagentInProgress = true;
		try {
			return await execute(id, params, signal, onUpdate, ctx);
		} finally {
			deps.state.subagentInProgress = false;
		}
	};

	return { execute: executeWithSingleDispatchGuard };
}
