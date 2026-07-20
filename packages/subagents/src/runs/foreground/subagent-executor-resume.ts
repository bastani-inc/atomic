import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { currentModelFullId } from "../shared/model-fallback.ts";
import { readStatus } from "../../shared/utils.ts";
import { buildRevivedAsyncTask, resolveAsyncResumeTarget } from "../background/async-resume.ts";
import { resolveSubagentRunId, type ResolvedSubagentRunId } from "../background/run-id-resolver.ts";
import { toModelInfo } from "../../shared/model-info.ts";
import { resolveSingleProgress } from "../../shared/settings.ts";
import {
	createNestedRoute,
	readNestedControlResults,
	resolveInheritedNestedRouteFromEnv,
	resolveNestedAsyncDir,
	resolveNestedParentAddressFromEnv,
	writeNestedControlRequest,
	type NestedRunResolutionScope,
} from "../shared/nested-events.ts";
import { resolveControlConfig } from "../shared/subagent-control.ts";
import { deliverSubagentIntercomMessageEvent } from "../../intercom/result-intercom.ts";
import {
	applyIntercomBridgeToAgent,
	resolveIntercomBridge,
	resolveIntercomSessionTarget,
	resolveSubagentIntercomTarget,
} from "../../intercom/intercom-bridge.ts";
import { requestSupervisorAuthorization } from "../../intercom/supervisor-authorization.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.ts";
import {
	DEFAULT_ARTIFACT_CONFIG,
	checkSubagentDepth,
	isWorkflowStageOrchestrationContext,
	resolveSubagentDepthPolicy,
	resolveWorkflowStageMaxSubagentDepth,
	workflowSessionMetadataFromContext,
	subagentDepthBlockedMessage,
	type ArtifactConfig,
	type NestedRunSummary,
	type SubagentState,
	type SubagentToolResult,
} from "../../shared/types.ts";
import type { ResolvedExecutorDeps, SubagentParamsLike } from "./subagent-executor-types.ts";

const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";

export function resolveRequestedCwd(runtimeCwd: string, requestedCwd: string | undefined): string {
	return requestedCwd ? path.resolve(runtimeCwd, requestedCwd) : runtimeCwd;
}

export function nestedResolutionScopeForExecutor(deps: ResolvedExecutorDeps): NestedRunResolutionScope | undefined {
	if (deps.allowMutatingManagementActions !== false) return undefined;
	const route = resolveInheritedNestedRouteFromEnv();
	const address = route ? resolveNestedParentAddressFromEnv() : undefined;
	return {
		routes: route ? [route] : [],
		...(address ? { descendantOf: { parentRunId: address.parentRunId, ...(address.parentStepIndex !== undefined ? { parentStepIndex: address.parentStepIndex } : {}) } } : {}),
	};
}

function resolveForegroundResumeTarget(params: SubagentParamsLike, state: SubagentState): { runId: string; mode: "single" | "parallel" | "chain"; state: "complete"; agent: string; index: number; intercomTarget: string; cwd: string; sessionFile: string } | undefined {
	const requested = (params.id ?? params.runId)?.trim();
	if (!requested || !state.foregroundRuns?.size) return undefined;
	const direct = state.foregroundRuns.get(requested);
	const matches = direct ? [direct] : [...state.foregroundRuns.values()].filter((run) => run.runId.startsWith(requested));
	if (matches.length === 0) return undefined;
	if (matches.length > 1) throw new Error(`Ambiguous foreground run id prefix '${requested}' matched: ${matches.map((run) => run.runId).join(", ")}. Provide a longer id.`);
	const run = matches[0]!;
	if (run.children.length > 1 && params.index === undefined) throw new Error(`Foreground run '${run.runId}' has ${run.children.length} children. Provide index to choose one.`);
	const index = params.index ?? 0;
	if (!Number.isInteger(index)) throw new Error(`Foreground run '${run.runId}' index must be an integer.`);
	if (index < 0 || index >= run.children.length) throw new Error(`Foreground run '${run.runId}' has ${run.children.length} children. Index ${index} is out of range.`);
	const child = run.children[index]!;
	if (child.status === "detached") throw new Error(`Foreground run '${run.runId}' child ${index} is detached for intercom coordination and cannot be revived safely from the remembered foreground state. Reply to the supervisor request first; after the child exits, start a fresh follow-up if needed.`);
	if (!child.sessionFile) throw new Error(`Foreground run '${run.runId}' child ${index} does not have a persisted session file to resume from.`);
	if (path.extname(child.sessionFile) !== ".jsonl") throw new Error(`Foreground run '${run.runId}' child ${index} session file must be a .jsonl file: ${child.sessionFile}`);
	const sessionFile = path.resolve(child.sessionFile);
	if (!fs.existsSync(sessionFile)) throw new Error(`Foreground run '${run.runId}' child ${index} session file does not exist: ${child.sessionFile}`);
	return { runId: run.runId, mode: run.mode, state: "complete", agent: child.agent, index, intercomTarget: resolveSubagentIntercomTarget(run.runId, child.agent, index), cwd: run.cwd, sessionFile };
}

type AsyncResumeSourceTarget = ReturnType<typeof resolveAsyncResumeTarget> & { source: "async" };
type ForegroundResumeSourceTarget = NonNullable<ReturnType<typeof resolveForegroundResumeTarget>> & { kind: "revive"; source: "foreground" };
type NestedResumeSourceTarget = {
	kind: "revive";
	source: "nested";
	runId: string;
	state: "complete" | "failed" | "paused";
	agent: string;
	index: number;
	intercomTarget: string;
	cwd?: string;
	sessionFile: string;
};
type ResumeSourceTarget = AsyncResumeSourceTarget | ForegroundResumeSourceTarget | NestedResumeSourceTarget;

function isAsyncRunNotFound(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("Async run not found.");
}

function isResumeAmbiguity(error: unknown): boolean {
	return error instanceof Error && /Ambiguous .*run id prefix/.test(error.message);
}

function resumeTargetExact(target: { runId: string } | undefined, requested: string): boolean {
	return target?.runId === requested;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isExactResumeError(error: unknown, source: "async" | "foreground", requested: string): boolean {
	if (!(error instanceof Error) || !requested) return false;
	return new RegExp(`\\b${source} run '${escapeRegExp(requested)}'`, "i").test(error.message);
}

function resolveResumeTarget(params: SubagentParamsLike, state: SubagentState): ResumeSourceTarget {
	const requested = (params.id ?? params.runId)?.trim() ?? "";
	let foregroundTarget: ForegroundResumeSourceTarget | undefined;
	let foregroundError: unknown;
	let asyncTarget: AsyncResumeSourceTarget | undefined;
	let asyncError: unknown;

	try {
		const target = resolveForegroundResumeTarget(params, state);
		if (target) foregroundTarget = { kind: "revive", source: "foreground", ...target };
	} catch (error) {
		foregroundError = error;
	}
	try {
		asyncTarget = { source: "async", ...resolveAsyncResumeTarget(params) };
	} catch (error) {
		asyncError = error;
	}

	if (foregroundTarget && asyncTarget) {
		const foregroundExact = resumeTargetExact(foregroundTarget, requested);
		const asyncExact = resumeTargetExact(asyncTarget, requested);
		if (foregroundExact && !asyncExact) return foregroundTarget;
		if (asyncExact && !foregroundExact) return asyncTarget;
		throw new Error(`Resume id '${requested}' is ambiguous between foreground run '${foregroundTarget.runId}' and async run '${asyncTarget.runId}'. Provide a full run id.`);
	}
	if (foregroundTarget) {
		if (isExactResumeError(asyncError, "async", requested)) throw asyncError;
		if (isResumeAmbiguity(asyncError) && !resumeTargetExact(foregroundTarget, requested)) throw asyncError;
		return foregroundTarget;
	}
	if (asyncTarget) {
		if (isExactResumeError(foregroundError, "foreground", requested)) throw foregroundError;
		if (isResumeAmbiguity(foregroundError) && !resumeTargetExact(asyncTarget, requested)) throw foregroundError;
		return asyncTarget;
	}
	if (foregroundError && !isAsyncRunNotFound(asyncError)) throw foregroundError;
	if (foregroundError) throw foregroundError;
	if (asyncError) throw asyncError;
	throw new Error("Run not found. Provide id or runId.");
}

function getAsyncInterruptTarget(state: SubagentState, runId: string | undefined): { asyncId: string; asyncDir: string } | undefined {
	if (runId) {
		const direct = state.asyncJobs.get(runId);
		if (direct) return { asyncId: direct.asyncId, asyncDir: direct.asyncDir };
	}
	let newest: { asyncId: string; asyncDir: string; updatedAt: number } | undefined;
	for (const job of state.asyncJobs.values()) {
		if (job.status !== "running") continue;
		if (!newest || (job.updatedAt ?? 0) > newest.updatedAt) {
			newest = { asyncId: job.asyncId, asyncDir: job.asyncDir, updatedAt: job.updatedAt ?? 0 };
		}
	}
	return newest ? { asyncId: newest.asyncId, asyncDir: newest.asyncDir } : undefined;
}

export function interruptAsyncRun(state: SubagentState, runId: string | undefined): SubagentToolResult | null {
	const target = getAsyncInterruptTarget(state, runId);
	if (!target) return null;
	const status = readStatus(target.asyncDir);
	if (!status || status.state !== "running" || typeof status.pid !== "number") {
		return {
			content: [{ type: "text", text: `No running async run with an interrupt-capable pid was found for '${runId ?? "current"}'.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	try {
		process.kill(status.pid, ASYNC_INTERRUPT_SIGNAL);
		const tracked = state.asyncJobs.get(target.asyncId);
		if (tracked) {
			tracked.activityState = undefined;
			tracked.updatedAt = Date.now();
		}
		return {
			content: [{ type: "text", text: `Interrupt requested for async run ${target.asyncId}.` }],
			details: { mode: "management", results: [] },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to interrupt async run ${target.asyncId}: ${message}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
}

function nestedRunSessionFile(run: NestedRunSummary): string | undefined {
	return run.sessionFile ?? (run.steps?.length === 1 ? run.steps[0]?.sessionFile : undefined);
}

function nestedRunAgent(run: NestedRunSummary): string | undefined {
	return run.agent ?? run.agents?.[0] ?? (run.steps?.length === 1 ? run.steps[0]?.agent : undefined);
}

function pathWithin(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

function validateNestedSessionFile(run: NestedRunSummary, trustedSessionRoots: string[]): string {
	const sessionFile = nestedRunSessionFile(run);
	if (!sessionFile) throw new Error(`Nested run '${run.id}' does not have a persisted session file to resume from.`);
	if (path.extname(sessionFile) !== ".jsonl") throw new Error(`Nested run '${run.id}' session file must be a .jsonl file: ${sessionFile}`);
	const resolved = path.resolve(sessionFile);
	if (!path.isAbsolute(sessionFile)) throw new Error(`Nested run '${run.id}' session file must be absolute: ${sessionFile}`);
	if (!fs.existsSync(resolved)) throw new Error(`Nested run '${run.id}' session file does not exist: ${sessionFile}`);
	const stat = fs.lstatSync(resolved);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Nested run '${run.id}' session file is not a regular file: ${sessionFile}`);
	const realSessionFile = fs.realpathSync(resolved);
	const trustedRoots = trustedSessionRoots
		.filter((root) => fs.existsSync(root))
		.map((root) => fs.realpathSync(root));
	if (!trustedRoots.some((root) => pathWithin(root, realSessionFile))) {
		throw new Error(`Nested run '${run.id}' session file is outside trusted nested session roots: ${sessionFile}`);
	}
	if (!realSessionFile.split(path.sep).includes(run.id)) {
		throw new Error(`Nested run '${run.id}' session file is not under that nested run's session directory: ${sessionFile}`);
	}
	return realSessionFile;
}

function resolveNestedResumeTarget(match: ResolvedSubagentRunId & { kind: "nested" }, trustedSessionRoots: string[]): NestedResumeSourceTarget {
	const run = match.match.run;
	if (run.state === "running" || run.state === "queued") throw new Error(`Nested run '${run.id}' is live; route the follow-up to the owner process instead.`);
	const agent = nestedRunAgent(run);
	if (!agent) throw new Error(`Could not determine child agent for nested run '${run.id}'.`);
	const state = run.state === "complete" || run.state === "failed" || run.state === "paused" ? run.state : "failed";
	const asyncDir = resolveNestedAsyncDir(match.match.rootRunId, run);
	return {
		kind: "revive",
		source: "nested",
		runId: run.id,
		state,
		agent,
		index: 0,
		intercomTarget: resolveSubagentIntercomTarget(run.id, agent, 0),
		cwd: asyncDir ? path.dirname(asyncDir) : undefined,
		sessionFile: validateNestedSessionFile(run, trustedSessionRoots),
	};
}

async function waitForNestedControlResult(target: ResolvedSubagentRunId & { kind: "nested" }, requestId: string, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = readNestedControlResults(target.match.route).find((candidate) => candidate.requestId === requestId && candidate.targetRunId === target.match.run.id);
		if (result) return result;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return undefined;
}

async function sendNestedControlRequest(target: ResolvedSubagentRunId & { kind: "nested" }, action: "interrupt" | "resume", message?: string) {
	const requestId = randomUUID();
	writeNestedControlRequest(target.match.route, {
		ts: Date.now(),
		requestId,
		targetRunId: target.match.run.id,
		action,
		...(message ? { message } : {}),
	});
	return waitForNestedControlResult(target, requestId);
}

function directNestedAsyncInterrupt(target: ResolvedSubagentRunId & { kind: "nested" }): SubagentToolResult | undefined {
	const run = target.match.run;
	const asyncDir = resolveNestedAsyncDir(target.match.rootRunId, run);
	if (!asyncDir) return undefined;
	const status = readStatus(asyncDir);
	const pid = typeof status?.pid === "number" && status.pid > 0 ? status.pid : run.pid;
	if (!status || status.state !== "running" || typeof pid !== "number" || pid <= 0) return undefined;
	try {
		process.kill(pid, ASYNC_INTERRUPT_SIGNAL);
		return { content: [{ type: "text", text: `Interrupt requested for nested async run ${run.id}.` }], details: { mode: "management", results: [] } };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text", text: `Failed to interrupt nested async run ${run.id}: ${message}` }], isError: true, details: { mode: "management", results: [] } };
	}
}

export async function interruptNestedRun(target: ResolvedSubagentRunId & { kind: "nested" }): Promise<SubagentToolResult> {
	const run = target.match.run;
	if (run.state === "complete") return { content: [{ type: "text", text: `Nested run ${run.id} is already complete and cannot be interrupted.` }], isError: true, details: { mode: "management", results: [] } };
	if (run.state === "failed") return { content: [{ type: "text", text: `Nested run ${run.id} has failed and cannot be interrupted.` }], isError: true, details: { mode: "management", results: [] } };
	if (run.state === "paused") return { content: [{ type: "text", text: `Nested run ${run.id} is already paused.` }], isError: true, details: { mode: "management", results: [] } };
	const result = await sendNestedControlRequest(target, "interrupt");
	if (result) return { content: [{ type: "text", text: result.message }], isError: result.ok ? undefined : true, details: { mode: "management", results: [] } };
	const direct = directNestedAsyncInterrupt(target);
	if (direct) return direct;
	return { content: [{ type: "text", text: `Nested run ${run.id} owner is not reachable and no safe direct async interrupt fallback is available.` }], isError: true, details: { mode: "management", results: [] } };
}

async function resumeLiveNestedRun(input: { target: ResolvedSubagentRunId & { kind: "nested" }; message: string }): Promise<SubagentToolResult> {
	const run = input.target.match.run;
	const result = await sendNestedControlRequest(input.target, "resume", input.message);
	if (result) return { content: [{ type: "text", text: result.message }], isError: result.ok ? undefined : true, details: { mode: "management", results: [] } };
	return { content: [{ type: "text", text: `Nested run ${run.id} appears live but its owner route is not reachable. Wait for completion, then retry action='resume'.` }], isError: true, details: { mode: "management", results: [] } };
}

export async function resumeAsyncRun(input: {
	params: SubagentParamsLike;
	requestCwd: string;
	ctx: ExtensionContext;
	deps: ResolvedExecutorDeps;
}): Promise<SubagentToolResult> {
	const followUp = (input.params.message ?? input.params.task ?? "").trim();
	if (!followUp) {
		return {
			content: [{ type: "text", text: "action='resume' requires message." }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	let target: ResumeSourceTarget;
	const parentSessionFile = input.ctx.sessionManager.getSessionFile() ?? null;
	try {
		const requestedId = input.params.id ?? input.params.runId;
		const resolved = requestedId ? resolveSubagentRunId(requestedId, { state: input.deps.state, nested: nestedResolutionScopeForExecutor(input.deps) }) : undefined;
		if (resolved?.kind === "nested") {
			if (resolved.match.run.state === "running" || resolved.match.run.state === "queued") {
				return resumeLiveNestedRun({ target: resolved, message: followUp });
			}
			const trustedSessionRoots = [
				...(input.deps.config.defaultSessionDir ? [path.resolve(input.deps.expandTilde(input.deps.config.defaultSessionDir))] : []),
				...(parentSessionFile ? [input.deps.getSubagentSessionRoot(parentSessionFile)] : []),
			];
			target = resolveNestedResumeTarget(resolved, trustedSessionRoots);
		} else {
			target = resolveResumeTarget(input.params, input.deps.state);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
	}

	if (target.kind === "live") {
		const delivered = await deliverSubagentIntercomMessageEvent(
			input.deps.pi.events,
			target.intercomTarget,
			`Follow-up for async run ${target.runId} (${target.agent}):\n\n${followUp}`,
			500,
			{ source: "async-resume", runId: target.runId, agent: target.agent, index: target.index },
		);
		if (delivered) {
			return {
				content: [{ type: "text", text: [`Delivered follow-up to live async child.`, `Run: ${target.runId}`, `Intercom target: ${target.intercomTarget}`].join("\n") }],
				details: { mode: "management", results: [] },
			};
		}
		return {
			content: [{ type: "text", text: [`Async child appears live but its intercom target is not registered.`, `Run: ${target.runId}`, `Intercom target: ${target.intercomTarget}`, `Wait for completion, then retry action='resume'.`].join("\n") }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	const resumeDepthPolicy = resolveSubagentDepthPolicy(input.ctx, input.deps.config.maxSubagentDepth);
	const { blocked, depth, maxDepth, workflowStageGuard } = checkSubagentDepth(resumeDepthPolicy.maxSubagentDepth);
	if (blocked) {
		return {
			content: [{
				type: "text",
				text: subagentDepthBlockedMessage(depth, maxDepth, {
					action: "resume",
					workflowStageGuard: workflowStageGuard || resumeDepthPolicy.workflowStageSubagentGuard,
				}),
			}],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	input.deps.state.currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
	const effectiveCwd = target.cwd ?? input.requestCwd;
	const scope = resolveExecutionAgentScope(input.params.agentScope);
	const discoveredAgents = input.deps.discoverAgents(effectiveCwd, scope).agents;
	const sessionName = resolveIntercomSessionTarget(input.deps.pi.getSessionName(), input.ctx.sessionManager.getSessionId());
	const intercomBridge = resolveIntercomBridge({
		config: input.deps.config.intercomBridge,
		context: input.params.context,
		orchestratorTarget: sessionName,
		cwd: effectiveCwd,
	});
	const agents = intercomBridge.active
		? discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))
		: discoveredAgents;
	const agentConfig = agents.find((agent) => agent.name === target.agent);
	if (!agentConfig) {
		return {
			content: [{ type: "text", text: `Unknown agent for resume: ${target.agent}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	const runId = randomUUID().slice(0, 8);
	const revivedTarget = intercomBridge.active
		? resolveSubagentIntercomTarget(runId, target.agent, 0)
		: undefined;
	const supervisorAuthorization = await requestSupervisorAuthorization(input.deps.pi.events, revivedTarget);
	const artifactConfig: ArtifactConfig = { ...DEFAULT_ARTIFACT_CONFIG, enabled: input.params.artifacts !== false };
	const availableModels = input.ctx.modelRegistry.getAvailable().map(toModelInfo);
	const result = input.deps.runtime.executeAsyncSingle(runId, {
		agent: target.agent,
		task: buildRevivedAsyncTask(target, followUp),
		agentConfig,
		progress: resolveSingleProgress(agentConfig, input.params.progress, followUp),
		ctx: {
			pi: input.deps.pi,
			cwd: input.requestCwd,
			currentSessionId: input.deps.state.currentSessionId,
			currentModelProvider: input.ctx.model?.provider,
			currentModel: currentModelFullId(input.ctx.model),
			workflowSessionMetadata: workflowSessionMetadataFromContext(input.ctx),
		},
		cwd: effectiveCwd,
		maxOutput: input.params.maxOutput,
		artifactsDir: input.deps.tempArtifactsDir,
		artifactConfig,
		shareEnabled: input.params.share === true,
		sessionRoot: input.deps.getSubagentSessionRoot(parentSessionFile),
		sessionFile: target.sessionFile,
		maxSubagentDepth: resolveWorkflowStageMaxSubagentDepth(input.ctx, input.deps.config.maxSubagentDepth),
		workflowStageSubagentGuard: isWorkflowStageOrchestrationContext(input.ctx),
		worktreeSetupHook: input.deps.config.worktreeSetupHook,
		worktreeSetupHookTimeoutMs: input.deps.config.worktreeSetupHookTimeoutMs,
		controlConfig: resolveControlConfig(input.deps.config.control, input.params.control),
		controlIntercomTarget: intercomBridge.active ? intercomBridge.orchestratorTarget : undefined,
		childIntercomTarget: intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(runId, agent, index) : undefined,
		supervisorAuthorization,
		availableModels,
	});
	if (result.isError) return result;

	const revivedId = result.details.asyncId ?? runId;
	const sourceLabel = target.source;
	const lines = [
		`Revived ${sourceLabel} subagent from ${target.runId}.`,
		`Revived run: ${revivedId}`,
		`Agent: ${target.agent}`,
		`Session: ${target.sessionFile}`,
		result.details.asyncDir ? `Async dir: ${result.details.asyncDir}` : undefined,
		revivedTarget ? `Intercom target: ${revivedTarget} (if registered)` : undefined,
		`Status if needed: subagent({ action: "status", id: "${revivedId}" })`,
	].filter((line): line is string => Boolean(line));
	return { content: [{ type: "text", text: input.deps.runtime.formatAsyncStartedMessage(lines.join("\n")) }], details: result.details };
}

export { createNestedRoute };
export type { ResolvedSubagentRunId };
