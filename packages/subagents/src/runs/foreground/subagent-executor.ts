import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { handleManagementAction } from "../../agents/agent-management.js";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.js";
import { clearPendingForegroundControlNotices } from "../../extension/control-notices.js";
import { buildDoctorReport } from "../../extension/doctor.js";
import { INTERCOM_BRIDGE_MARKER, resolveIntercomSessionTarget } from "../../intercom/intercom-bridge.js";
import { requestSupervisorAuthorization } from "../../intercom/supervisor-authorization.js";
import { getArtifactsDir } from "../../shared/artifacts.js";
import {
	injectSingleProgressInstruction,
	resolveSingleProgress,
	writeInitialProgressFile,
} from "../../shared/settings.js";
import {
	DEFAULT_ARTIFACT_CONFIG,
	type ForegroundResumeRun,
	type ParentAskPauseRequest,
	type SingleResult,
	SUBAGENT_ACTIONS,
	type SubagentToolResult,
} from "../../shared/types.js";
import {
	inspectInProcessChildStatus,
	interruptInProcessChild,
	resumeInProcessChild,
} from "../inprocess/control-status.js";
import { formatParentAskPauseOutput, RELEASED_SIBLING_RESUME_MESSAGE } from "./parent-ask-output.js";
import { prepareExecutionContext, refuseSubagentChildDelegation } from "./subagent-executor-context.js";
import { toExecutionErrorResult, withForkContext } from "./subagent-executor-input.js";
import { runParallelPath } from "./subagent-executor-parallel.js";
import { resolveRequestedCwd } from "./subagent-executor-resume.js";
import { resolveSubagentExecutorRuntimeDeps } from "./subagent-executor-runtime.js";
import { createForwardSingleUpdate, runSinglePath } from "./subagent-executor-single.js";
import {
	createRetainedForegroundControlNotifier,
	foregroundStatusResult,
	getForegroundControl,
	notifyDetachedForegroundChildExit,
	replaceForegroundRunChild,
	retainedForegroundStatusResult,
} from "./subagent-executor-status.js";
import {
	type ExecutorDeps,
	isManagementActionsRestricted,
	type ResolvedExecutorDeps,
	type SubagentParamsLike,
} from "./subagent-executor-types.js";

function completedResumeResult(id: string): SubagentToolResult {
	return {
		content: [{ type: "text", text: `Completed child '${id}' is not resumable.` }],
		isError: true,
		details: { mode: "management", results: [] },
	};
}

function isCompletedRetainedTarget(deps: ResolvedExecutorDeps, id: string, index: number | undefined): boolean {
	const direct = deps.state.foregroundRuns?.get(id);
	if (direct) return direct.children.find((child) => child.index === (index ?? 0))?.status === "completed";
	for (const run of deps.state.foregroundRuns?.values() ?? []) {
		if (run.children.some((child) => child.result?.path === id && child.status === "completed")) return true;
	}
	return false;
}

function normalizeResultIndex(result: SingleResult, index: number): SingleResult {
	if (result.progress) result.progress.index = index;
	return result;
}

function normalizeUpdateIndex(update: SubagentToolResult, index: number): SubagentToolResult {
	for (const result of update.details?.results ?? []) normalizeResultIndex(result, index);
	for (const progress of update.details?.progress ?? []) progress.index = index;
	return update;
}

async function resumeRetainedParentAskRun(
	params: SubagentParamsLike,
	message: string,
	ctx: ExtensionContext,
	deps: ResolvedExecutorDeps,
	onUpdate: ((result: SubagentToolResult) => void) | undefined,
): Promise<SubagentToolResult | undefined> {
	const requested = params.id ?? params.runId;
	if (!requested || params.index !== undefined) return undefined;
	const run: ForegroundResumeRun | undefined = deps.state.foregroundRuns?.get(requested);
	const pause = run?.parentAsk;
	if (!run || !pause || requested !== run.runId) return undefined;
	const releasedChildren = pause.releasedChildIndices
		.map((index) => run.children.find((child) => child.index === index))
		.filter((child): child is NonNullable<typeof child> => child !== undefined);
	const completed = releasedChildren.flatMap((child) =>
		child.status === "completed" && child.result
			? [{ index: child.index, result: normalizeResultIndex(child.result, child.index) }]
			: [],
	);
	const children = releasedChildren.filter((child) => child.status !== "completed");
	if (children.length === 0) return completedResumeResult(requested);
	const childAgents = new Map<number, ReturnType<ResolvedExecutorDeps["discoverAgents"]>["agents"]>();
	for (const child of children) {
		const agents = deps.discoverAgents(
			child.execution.runtimeCwd,
			resolveExecutionAgentScope(child.execution.agentScope),
		).agents;
		if (!agents.some((agent) => agent.name === child.agent)) {
			return {
				content: [{ type: "text", text: `Unknown agent for resume: ${child.agent}` }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		childAgents.set(child.index, agents);
	}
	const groupController = new AbortController();
	const intercomDetachController = run.mode === "parallel" ? new AbortController() : undefined;
	const activeIndices = new Set<number>();
	let nextParentAsk: ParentAskPauseRequest | undefined;
	let nextReleasedIndices: number[] = [];
	const settled = await Promise.allSettled(
		children.map(async (child) => {
			const agents = childAgents.get(child.index)!;
			const childController = new AbortController();
			const abortForGroupPause = () => childController.abort();
			groupController.signal.addEventListener("abort", abortForGroupPause, { once: true });
			if (groupController.signal.aborted) childController.abort();
			activeIndices.add(child.index);
			const supervisedTarget = child.execution.options.intercomSessionName;
			const supervisorAuthorization = await requestSupervisorAuthorization(deps.pi.events, supervisedTarget);
			const onControlEvent = createRetainedForegroundControlNotifier(child.execution.options, deps);
			const childMessage = child.index === pause.askingChildIndex ? message : RELEASED_SIBLING_RESUME_MESSAGE;
			const forwardUpdate = createForwardSingleUpdate(
				onUpdate,
				getForegroundControl(deps.state, run.runId),
				child.agent,
				child.index,
			);
			try {
				const result = normalizeResultIndex(
					await deps.runtime.runSync(child.execution.runtimeCwd, agents, child.agent, childMessage, {
						...child.execution.options,
						signal: ctx.signal,
						interruptSignal: childController.signal,
						intercomEvents: deps.pi.events,
						supervisorAuthorization,
						onControlEvent,
						...(intercomDetachController
							? {
									intercomDetachSignal: intercomDetachController.signal,
									onIntercomDetachCommit: () => intercomDetachController.abort(),
								}
							: {}),
						sessionFile: child.sessionFile ?? child.execution.options.sessionFile,
						sessionDir: child.sessionFile ? path.dirname(child.sessionFile) : child.execution.options.sessionDir,
						onUpdate: forwardUpdate
							? (update) => forwardUpdate(normalizeUpdateIndex(update, child.index))
							: undefined,
						onParentAskClaim: (request) => {
							if (nextParentAsk) return;
							nextParentAsk = request;
							nextReleasedIndices = [...activeIndices].sort((left, right) => left - right);
							groupController.abort();
						},
						onDetachedExit: (detachedResult) => {
							try {
								normalizeResultIndex(detachedResult, child.index);
								replaceForegroundRunChild(deps.state, run.runId, child.index, detachedResult);
								notifyDetachedForegroundChildExit({
									pi: deps.pi,
									runId: run.runId,
									mode: run.mode,
									index: child.index,
									...(run.mode === "parallel" ? { totalTasks: run.children.length } : {}),
									result: detachedResult,
								});
							} finally {
								run.cleanup?.recover(child.index);
							}
						},
					}),
					child.index,
				);
				replaceForegroundRunChild(deps.state, run.runId, child.index, result, { onlyWhenDetached: false });
				return { index: child.index, result };
			} finally {
				activeIndices.delete(child.index);
				groupController.signal.removeEventListener("abort", abortForGroupPause);
			}
		}),
	);
	const failed = settled.find((entry) => entry.status === "rejected");
	if (failed?.status === "rejected") {
		if (run.cleanup) {
			run.cleanup.finalize();
			delete run.cleanup;
		}
		throw failed.reason;
	}
	const resumed = settled.map((entry) => {
		if (entry.status === "rejected") throw entry.reason;
		return entry.value;
	});
	if (nextParentAsk) {
		run.parentAsk = {
			askingChildIndex: nextParentAsk.index,
			releasedChildIndices: nextReleasedIndices,
			unlaunchedChildIndices: pause.unlaunchedChildIndices,
			request: nextParentAsk,
		};
	} else {
		delete run.parentAsk;
	}
	run.updatedAt = Date.now();
	const resultEntries = [...resumed, ...completed].toSorted((left, right) => left.index - right.index);
	const results = resultEntries.map((entry) => entry.result);
	let terminalSuffix = "";
	if (!run.parentAsk && run.cleanup) {
		const detachedIndices = resultEntries.flatMap((entry) => (entry.result.detached ? [entry.index] : []));
		if (!run.cleanup.defer(detachedIndices)) {
			terminalSuffix = run.cleanup.finalize();
			delete run.cleanup;
		}
	}
	const terminalText = results
		.map((result) => result.finalOutput ?? result.envelope ?? result.error ?? "")
		.filter(Boolean)
		.join("\n\n");
	return {
		content: [
			{
				type: "text",
				text: run.parentAsk
					? formatParentAskPauseOutput(run.parentAsk)
					: [terminalText, terminalSuffix].filter(Boolean).join("\n\n"),
			},
		],
		details: {
			mode: run.mode,
			runId: run.runId,
			results,
			totalSteps: releasedChildren.length,
			...(run.parentAsk ? { parentAskPaused: true } : {}),
		},
		...(results.some((result) => result.status === "error") ? { isError: true } : {}),
	};
}

async function resumeRetainedForegroundChild(
	params: SubagentParamsLike,
	message: string,
	ctx: ExtensionContext,
	deps: ResolvedExecutorDeps,
	onUpdate: ((r: SubagentToolResult) => void) | undefined,
): Promise<SubagentToolResult | undefined> {
	const requested = params.id ?? params.runId;
	if (!requested) return undefined;
	const run = deps.state.foregroundRuns?.get(requested);
	if (!run || run.parentAsk) return undefined;
	const requestedIndex = params.index ?? 0;
	const child = run.children.find((candidate) => candidate.index === requestedIndex);
	if (!child) return undefined;
	if (child.status === "completed") return completedResumeResult(requested);
	const agents = deps.discoverAgents(
		child.execution.runtimeCwd,
		resolveExecutionAgentScope(child.execution.agentScope),
	).agents;
	const agentConfig = agents.find((agent) => agent.name === child.agent);
	if (!agentConfig) {
		return {
			content: [{ type: "text", text: `Unknown agent for resume: ${child.agent}` }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}
	const supervisorAuthorization = await requestSupervisorAuthorization(
		deps.pi.events,
		child.execution.options.intercomSessionName,
	);
	const artifactConfig = { ...DEFAULT_ARTIFACT_CONFIG, enabled: params.artifacts !== false };
	const artifactsDir = getArtifactsDir(ctx.sessionManager.getSessionFile() ?? null);
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
	const forwardUpdate = createForwardSingleUpdate(
		onUpdate,
		getForegroundControl(deps.state, run.runId),
		child.agent,
		child.index,
	);
	const onControlEvent = createRetainedForegroundControlNotifier(child.execution.options, deps);
	let result: SingleResult;
	try {
		result = normalizeResultIndex(
			await deps.runtime.runSync(child.execution.runtimeCwd, agents, child.agent, message, {
				...child.execution.options,
				signal: ctx.signal,
				interruptSignal: ctx.signal,
				allowIntercomDetach: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
				intercomEvents: deps.pi.events,
				supervisorAuthorization,
				onControlEvent,
				sessionFile: child.sessionFile ?? child.execution.options.sessionFile,
				sessionDir: child.sessionFile ? path.dirname(child.sessionFile) : child.execution.options.sessionDir,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				onUpdate: forwardUpdate ? (update) => forwardUpdate(normalizeUpdateIndex(update, child.index)) : undefined,
				onDetachedExit: (detachedResult) => {
					cleanupProgress();
					normalizeResultIndex(detachedResult, child.index);
					replaceForegroundRunChild(deps.state, run.runId, child.index, detachedResult);
					notifyDetachedForegroundChildExit({
						pi: deps.pi,
						runId: run.runId,
						mode: "single",
						index: child.index,
						result: detachedResult,
					});
				},
			}),
			child.index,
		);
	} catch (error) {
		cleanupProgress();
		throw error;
	}
	if (!result.detached) cleanupProgress();
	replaceForegroundRunChild(deps.state, run.runId, child.index, result, { onlyWhenDetached: false });
	let terminalSuffix = "";
	if (run.cleanup) {
		terminalSuffix = run.cleanup.finalize();
		delete run.cleanup;
	}
	return {
		content: [
			{
				type: "text",
				text: [result.finalOutput ?? result.envelope ?? result.error ?? "", terminalSuffix]
					.filter(Boolean)
					.join("\n\n"),
			},
		],
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

export type { SubagentExecutorRuntimeDeps, SubagentParamsLike } from "./subagent-executor-types.js";

async function handleManagementRequest(input: {
	params: SubagentParamsLike;
	paramsWithResolvedCwd: SubagentParamsLike;
	requestCwd: string;
	ctx: ExtensionContext;
	deps: ResolvedExecutorDeps;
	onUpdate?: (r: SubagentToolResult) => void;
}): Promise<SubagentToolResult> {
	const { params, paramsWithResolvedCwd, requestCwd, ctx, deps, onUpdate } = input;
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
	// Delegation is one level deep: a session admitted as a subagent child may
	// never start or continue another agent, whatever else it is authorized for.
	if (!READ_ONLY_MANAGEMENT_ACTIONS.has(action)) {
		const childRefusal = refuseSubagentChildDelegation(ctx, "management");
		if (childRefusal) return childRefusal;
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
		const parentAskResume = await resumeRetainedParentAskRun(paramsWithResolvedCwd, message, ctx, deps, onUpdate);
		if (parentAskResume) return parentAskResume;
		if (isCompletedRetainedTarget(deps, targetRunId, paramsWithResolvedCwd.index)) {
			return completedResumeResult(targetRunId);
		}
		const inProcess = await resumeInProcessChild(targetRunId, message, { model: ctx.model });
		if (inProcess) return inProcess;
		const retained = await resumeRetainedForegroundChild(paramsWithResolvedCwd, message, ctx, deps, onUpdate);
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
			return handleManagementRequest({ params, paramsWithResolvedCwd, requestCwd, ctx, deps, onUpdate });
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
