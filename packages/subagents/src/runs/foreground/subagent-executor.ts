import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { handleManagementAction } from "../../agents/agent-management.ts";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.ts";
import { clearPendingForegroundControlNotices } from "../../extension/control-notices.ts";
import { buildDoctorReport } from "../../extension/doctor.ts";
import {
	INTERCOM_BRIDGE_MARKER,
	resolveIntercomBridge,
	resolveIntercomSessionTarget,
	resolveSubagentIntercomTarget,
} from "../../intercom/intercom-bridge.ts";
import { requestSupervisorAuthorization } from "../../intercom/supervisor-authorization.ts";
import { getArtifactsDir } from "../../shared/artifacts.ts";
import { collectKnownModelProviders, toModelInfo } from "../../shared/model-info.ts";
import { createCandidateModelResolver } from "../../shared/model-resolution.ts";
import {
	injectSingleProgressInstruction,
	resolveSingleProgress,
	writeInitialProgressFile,
} from "../../shared/settings.ts";
import {
	DEFAULT_ARTIFACT_CONFIG,
	getCurrentSubagentDepth,
	isWorkflowStageOrchestrationContext,
	resolveChildMaxSubagentDepth,
	resolveWorkflowStageMaxSubagentDepth,
	type SingleResult,
	SUBAGENT_ACTIONS,
	type SubagentToolResult,
	workflowSessionMetadataFromContext,
} from "../../shared/types.ts";
import {
	inspectInProcessChildStatus,
	interruptInProcessChild,
	resumeInProcessChild,
} from "../inprocess/control-status.ts";
import { inheritedIntercomGroup } from "../shared/intercom-group.js";
import { currentModelFullId } from "../shared/model-fallback.ts";
import { resolveControlConfig } from "../shared/subagent-control.ts";
import { checkDepthForExecution, prepareExecutionContext } from "./subagent-executor-context.ts";
import { toExecutionErrorResult, withForkContext } from "./subagent-executor-input.ts";
import { runParallelPath } from "./subagent-executor-parallel.ts";
import { resolveRequestedCwd } from "./subagent-executor-resume.ts";
import { resolveSubagentExecutorRuntimeDeps } from "./subagent-executor-runtime.ts";
import { runSinglePath } from "./subagent-executor-single.ts";
import {
	foregroundStatusResult,
	getForegroundControl,
	replaceForegroundRunChild,
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
	const artifactConfig = { ...DEFAULT_ARTIFACT_CONFIG, enabled: params.artifacts !== false };
	const artifactsDir = getArtifactsDir(parentSessionFile);
	const progressDir = resolveSingleProgress(agentConfig, params.progress, message)
		? path.join(artifactsDir, "progress", run.runId)
		: undefined;
	if (progressDir) {
		writeInitialProgressFile(progressDir);
		message = injectSingleProgressInstruction(message, progressDir);
	}
	const cleanupProgress = (): void => {
		if (!progressDir || artifactConfig.enabled) return;
		try {
			fs.rmSync(progressDir, { recursive: true, force: true });
		} catch {
			// Scratch cleanup must never replace the child run's result or original error.
		}
	};
	let result: SingleResult;
	try {
		result = await deps.runtime.runSync(run.cwd, agents, child.agent, message, {
			cwd: run.cwd,
			signal: ctx.signal,
			interruptSignal: ctx.signal,
			allowIntercomDetach: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
			intercomEvents: deps.pi.events,
			runId: run.runId,
			index: child.index,
			sessionDir: child.sessionFile ? path.dirname(child.sessionFile) : undefined,
			sessionFile: child.sessionFile,
			share: params.share === true,
			artifactsDir,
			artifactConfig,
			maxOutput: params.maxOutput,
			maxSubagentDepth:
				child.maxSubagentDepth ??
				resolveChildMaxSubagentDepth(
					resolveWorkflowStageMaxSubagentDepth(ctx, deps.config.maxSubagentDepth),
					agentConfig.maxSubagentDepth,
				),
			parentDepth: getCurrentSubagentDepth(ctx),
			workflowStageSubagentGuard: isWorkflowStageOrchestrationContext(ctx),
			workflowSessionMetadata: workflowSessionMetadataFromContext(ctx),
			controlConfig: resolveControlConfig(deps.config.control, params.control),
			intercomSessionName: intercomBridge.active
				? resolveSubagentIntercomTarget(run.runId, child.agent, child.index)
				: undefined,
			orchestratorIntercomTarget: intercomBridge.active ? intercomBridge.orchestratorTarget : undefined,
			intercomGroup: inheritedIntercomGroup(ctx),
			supervisorAuthorization,
			modelOverride: params.model,
			availableModels: ctx.modelRegistry.getAvailable().map(toModelInfo),
			knownModelProviders: collectKnownModelProviders(ctx.modelRegistry),
			resolveCandidateModel: createCandidateModelResolver(ctx.modelRegistry, ctx.model?.provider),
			preferredModelProvider: ctx.model?.provider,
			currentModel: currentModelFullId(ctx.model),
		});
	} catch (error) {
		cleanupProgress();
		throw error;
	}
	if (!result.detached) cleanupProgress();
	replaceForegroundRunChild(deps.state, run.runId, child.index, result);
	return {
		content: [{ type: "text", text: result.finalOutput ?? result.envelope ?? result.error ?? "" }],
		details: { mode: "single", runId: run.runId, results: [result] },
		...(result.status === "error" ? { isError: true } : {}),
	};
}
const MUTATING_MANAGEMENT_ACTIONS = new Set(["create", "update", "delete"]);
/**
 * Management actions that only observe. Every other action either mutates agent
 * definitions or starts/continues agent execution, so a child without fanout
 * authorization is refused all of them.
 */
const READ_ONLY_MANAGEMENT_ACTIONS = new Set(["list", "get", "status", "doctor"]);
const FANOUT_REFUSAL_MESSAGE = "Subagent fanout is not authorized for this child.";

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
	// `resume` revives a child and `interrupt` is privileged control over a
	// running one; both continue agent execution, so only the observing actions
	// reach their handlers for a child without fanout authorization.
	if (deps.childPolicy && !deps.childPolicy.fanoutAuthorized && !READ_ONLY_MANAGEMENT_ACTIONS.has(action)) {
		return {
			content: [{ type: "text", text: FANOUT_REFUSAL_MESSAGE }],
			isError: true,
			details: { mode: "management" as const, results: [] },
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
	return handleManagementAction(action, paramsWithResolvedCwd, { ...ctx, cwd: requestCwd });
}

function inferExecutionMode(params: SubagentParamsLike): "single" | "parallel" {
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
		deps.state.baseCwd = ctx.cwd;
		deps.state.foregroundRuns ??= new Map();
		deps.state.foregroundControls ??= new Map();
		deps.state.lastForegroundControlId ??= null;
		const requestCwd = resolveRequestedCwd(ctx.cwd, params.cwd);
		const paramsWithResolvedCwd = params.cwd === undefined ? params : { ...params, cwd: requestCwd };
		if (params.action) {
			return handleManagementRequest({ params, paramsWithResolvedCwd, requestCwd, ctx, deps });
		}
		// Fanout authorization gates delegation and every management action that can
		// start or continue agent execution. Only `list`, `get`, `status`, and
		// `doctor` stay available to an unauthorized child; `resume`, `interrupt`,
		// and mutating management are refused inside handleManagementRequest.
		if (deps.childPolicy && !deps.childPolicy.fanoutAuthorized) {
			return {
				content: [{ type: "text", text: FANOUT_REFUSAL_MESSAGE }],
				isError: true,
				details: { mode: inferExecutionMode(params), results: [] },
			};
		}

		const depthError = checkDepthForExecution(ctx, deps);
		if (depthError) return depthError;

		const built = prepareExecutionContext({ params: paramsWithResolvedCwd, ctx, signal, onUpdate, deps });
		if (built.error) return built.error;
		const prepared = built.prepared!;
		let nestedForegroundStarted = false;
		try {
			if (prepared.foregroundControl) {
				prepared.writeNestedForegroundEvent("subagent.nested.started");
				nestedForegroundStarted = true;
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
