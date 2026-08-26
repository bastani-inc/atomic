import type { ExtensionContext } from "@bastani/atomic";
import { handleManagementAction } from "../../agents/agent-management.js";
import { clearPendingForegroundControlNotices } from "../../extension/control-notices.js";
import { SUBAGENT_ACTIONS, type SubagentToolResult } from "../../shared/types.js";
import { inspectInProcessChildStatus, interruptInProcessChild } from "../inprocess/control-status.js";
import { createExecutionBurstDispatcher } from "./subagent-executor-burst.js";
import { prepareExecutionContext, refuseSubagentChildDelegation } from "./subagent-executor-context.js";
import { resolveRequestedCwd } from "./subagent-executor-cwd.js";
import { toExecutionErrorResult, withForkContext } from "./subagent-executor-input.js";
import { runParallelPath } from "./subagent-executor-parallel.js";
import { resolveSubagentExecutorRuntimeDeps } from "./subagent-executor-runtime.js";
import { runSinglePath } from "./subagent-executor-single.js";
import { foregroundStatusResult, getForegroundControl } from "./subagent-executor-status.js";
import {
	type ExecutorDeps,
	isManagementActionsRestricted,
	type ResolvedExecutorDeps,
	type SubagentParamsLike,
} from "./subagent-executor-types.js";

const MUTATING_MANAGEMENT_ACTIONS = new Set(["create", "update", "delete"]);
/** Observing management actions do not start or mutate child execution. */
const READ_ONLY_MANAGEMENT_ACTIONS = new Set(["list", "get", "status"]);
const FANOUT_REFUSAL_MESSAGE = "Subagent fanout is not authorized for this child.";

export type { SubagentExecutorRuntimeDeps, SubagentParamsLike } from "./subagent-executor-types.js";

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
	// `interrupt` is privileged control over a running child, so only the
	// observing actions reach handlers for a child without fanout authorization.
	if (deps.childPolicy && !deps.childPolicy.fanoutAuthorized && !READ_ONLY_MANAGEMENT_ACTIONS.has(action)) {
		return {
			content: [{ type: "text", text: FANOUT_REFUSAL_MESSAGE }],
			isError: true,
			details: { mode: "management" as const, results: [] },
		};
	}
	// Delegation is one level deep: a child may never control another child.
	if (!READ_ONLY_MANAGEMENT_ACTIONS.has(action)) {
		const childRefusal = refuseSubagentChildDelegation(ctx, "management");
		if (childRefusal) return childRefusal;
	}
	if (action === "status") {
		const targetRunId = paramsWithResolvedCwd.id ?? paramsWithResolvedCwd.runId;
		const inProcess = inspectInProcessChildStatus(targetRunId);
		if (inProcess) return inProcess;
		const foreground = getForegroundControl(deps.state, targetRunId);
		if (foreground) return foregroundStatusResult(foreground);
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
		deps.state.foregroundControls ??= new Map();
		deps.state.lastForegroundControlId ??= null;
		const requestCwd = resolveRequestedCwd(ctx.cwd, params.cwd);
		const paramsWithResolvedCwd = params.cwd === undefined ? params : { ...params, cwd: requestCwd };
		if (params.action) {
			return handleManagementRequest({ params, paramsWithResolvedCwd, requestCwd, ctx, deps });
		}
		// Fanout authorization gates delegation and privileged control. Only `list`,
		// `get`, and `status` stay available to an unauthorized child; `interrupt`
		// and mutating management are refused by handleManagementRequest.
		if (deps.childPolicy && !deps.childPolicy.fanoutAuthorized) {
			return {
				content: [{ type: "text", text: FANOUT_REFUSAL_MESSAGE }],
				isError: true,
				details: { mode: inferExecutionMode(params), results: [] },
			};
		}

		const childRefusal = refuseSubagentChildDelegation(ctx, inferExecutionMode(params));
		if (childRefusal) return childRefusal;

		const built = prepareExecutionContext({ params: paramsWithResolvedCwd, ctx, signal, onUpdate, deps });
		if (built.error) return built.error;
		const prepared = built.prepared!;
		try {
			if (prepared.hasTasks && prepared.effectiveParams.tasks) {
				const result = await runParallelPath(prepared.execData, deps);
				return withForkContext(result, prepared.effectiveParams.context);
			}
			if (prepared.hasSingle) {
				const result = await runSinglePath(prepared.execData, deps);
				return withForkContext(result, prepared.effectiveParams.context);
			}
		} catch (error) {
			return toExecutionErrorResult(prepared.effectiveParams, error);
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

	const executeWithBurstCollection = createExecutionBurstDispatcher({
		execute,
		isActive: () => deps.state.subagentInProgress === true,
		setActive: (active) => {
			deps.state.subagentInProgress = active;
		},
		duplicateResult: duplicateSubagentCallResult,
	});

	return {
		execute: (id, params, signal, onUpdate, ctx) =>
			params.action
				? execute(id, params, signal, onUpdate, ctx)
				: executeWithBurstCollection(id, params, signal, onUpdate, ctx),
	};
}
