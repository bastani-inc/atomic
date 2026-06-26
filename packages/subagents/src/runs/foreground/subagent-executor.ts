import { type ExtensionContext } from "@bastani/atomic";
import { handleManagementAction } from "../../agents/agent-management.ts";
import { buildDoctorReport } from "../../extension/doctor.ts";
import { clearPendingForegroundControlNotices } from "../../extension/control-notices.ts";
import { resolveIntercomSessionTarget } from "../../intercom/intercom-bridge.ts";
import { SUBAGENT_ACTIONS, type SubagentToolResult } from "../../shared/types.ts";
import { inspectSubagentStatus } from "../background/run-status.ts";
import { resolveSubagentRunId, type ResolvedSubagentRunId } from "../background/run-id-resolver.ts";
import { runAsyncPath } from "./subagent-executor-async.ts";
import { runChainPath } from "./subagent-executor-chain.ts";
import { checkDepthForExecution, prepareExecutionContext } from "./subagent-executor-context.ts";
import {
	toExecutionErrorResult,
	withForkContext,
} from "./subagent-executor-input.ts";
import { runParallelPath } from "./subagent-executor-parallel.ts";
import {
	interruptAsyncRun,
	interruptNestedRun,
	nestedResolutionScopeForExecutor,
	resolveRequestedCwd,
	resumeAsyncRun,
} from "./subagent-executor-resume.ts";
import { resolveSubagentExecutorRuntimeDeps } from "./subagent-executor-runtime.ts";
import { runSinglePath } from "./subagent-executor-single.ts";
import {
	foregroundStatusResult,
	getForegroundControl,
} from "./subagent-executor-status.ts";
import type {
	ExecutorDeps,
	ResolvedExecutorDeps,
	SubagentParamsLike,
} from "./subagent-executor-types.ts";

const MUTATING_MANAGEMENT_ACTIONS = new Set(["create", "update", "delete"]);

export type { SubagentParamsLike, SubagentExecutorRuntimeDeps } from "./subagent-executor-types.ts";

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
		return { content: [{ type: "text", text: "Missing action." }], isError: true, details: { mode: "management", results: [] } };
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
			content: [{
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
			}],
			details: { mode: "management", results: [] },
		};
	}
	if (action === "status") {
		const targetRunId = paramsWithResolvedCwd.id ?? paramsWithResolvedCwd.runId;
		if (targetRunId) {
			try {
				const nestedScope = nestedResolutionScopeForExecutor(deps);
				const resolved = resolveSubagentRunId(targetRunId, { state: deps.state, nested: nestedScope });
				if (resolved?.kind === "foreground") {
					const foreground = getForegroundControl(deps.state, resolved.id);
					if (foreground) return foregroundStatusResult(foreground);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
			}
		} else {
			const foreground = getForegroundControl(deps.state, undefined);
			if (foreground) return foregroundStatusResult(foreground);
		}
		return inspectSubagentStatus({
			action: "status",
			id: paramsWithResolvedCwd.id,
			runId: paramsWithResolvedCwd.runId,
			dir: paramsWithResolvedCwd.dir,
		}, { state: deps.state, nested: nestedResolutionScopeForExecutor(deps) });
	}
	if (action === "resume") {
		return resumeAsyncRun({ params: paramsWithResolvedCwd, requestCwd, ctx, deps });
	}
	if (action === "interrupt") {
		return handleInterruptRequest({ paramsWithResolvedCwd, deps });
	}
	if (!(SUBAGENT_ACTIONS as readonly string[]).includes(action)) {
		return {
			content: [{ type: "text", text: `Unknown action: ${action}. Valid: ${SUBAGENT_ACTIONS.join(", ")}` }],
			isError: true,
			details: { mode: "management" as const, results: [] },
		};
	}
	if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
		return {
			content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }],
			isError: true,
			details: { mode: "management" as const, results: [] },
		};
	}
	return handleManagementAction(action, paramsWithResolvedCwd, { ...ctx, cwd: requestCwd });
}

async function handleInterruptRequest(input: {
	paramsWithResolvedCwd: SubagentParamsLike;
	deps: ResolvedExecutorDeps;
}): Promise<SubagentToolResult> {
	const { paramsWithResolvedCwd, deps } = input;
	const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
	let resolved: ResolvedSubagentRunId | undefined;
	if (targetRunId) {
		try {
			resolved = resolveSubagentRunId(targetRunId, { state: deps.state, nested: nestedResolutionScopeForExecutor(deps) });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
		}
	}
	if (resolved?.kind === "nested") return interruptNestedRun(resolved);
	const foreground = getForegroundControl(deps.state, resolved?.kind === "foreground" ? resolved.id : targetRunId);
	if (foreground?.interrupt) {
		const interrupted = foreground.interrupt();
		if (interrupted) {
			foreground.updatedAt = Date.now();
			foreground.currentActivityState = undefined;
			return {
				content: [{ type: "text", text: `Interrupt requested for foreground run ${foreground.runId}.` }],
				details: { mode: "management", results: [] },
			};
		}
		return {
			content: [{ type: "text", text: `Foreground run ${foreground.runId} has no active child step to interrupt.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const asyncInterruptResult = interruptAsyncRun(deps.state, resolved?.kind === "async" ? resolved.id : targetRunId);
	if (asyncInterruptResult) return asyncInterruptResult;
	return {
		content: [{ type: "text", text: "No interrupt-capable run found in this session." }],
		isError: true,
		details: { mode: "management", results: [] },
	};
}

function inferExecutionMode(params: SubagentParamsLike): "single" | "parallel" | "chain" {
	if ((params.chain?.length ?? 0) > 0) return "chain";
	if ((params.tasks?.length ?? 0) > 0) return "parallel";
	return "single";
}

function duplicateSubagentCallResult(params: SubagentParamsLike): SubagentToolResult {
	return {
		content: [{
			type: "text",
			text: "Rejected: a subagent call is already in progress. Issue exactly ONE subagent call per turn.",
		}],
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

		const depthError = checkDepthForExecution(ctx, deps);
		if (depthError) return depthError;

		const built = prepareExecutionContext({ params: paramsWithResolvedCwd, ctx, signal, onUpdate, deps });
		if (built.error) return built.error;
		const prepared = built.prepared!;
		let nestedForegroundStarted = false;
		try {
			const asyncResult = runAsyncPath(prepared.execData, deps);
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

		return withForkContext({
			content: [{ type: "text", text: "Invalid params" }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		}, prepared.effectiveParams.context);
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
