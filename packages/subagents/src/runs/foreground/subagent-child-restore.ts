import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentTaskHost,
	type ExtensionAPI,
	type ExtensionContext,
	isStaleExtensionContextError,
	type SessionEntry,
	type SessionManager,
} from "@bastani/atomic";
import type { ModelSingleResponse } from "../../../../coding-agent/src/core/tasks/contracts.js";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.js";
import {
	applyIntercomBridgeToAgent,
	resolveIntercomBridge,
	resolveIntercomSessionTarget,
} from "../../intercom/intercom-bridge.js";
import { childAllowsIntercom } from "../../intercom/supervisor-authorization.js";
import { collectKnownModelProviders, toModelInfo } from "../../shared/model-info.js";
import { createCandidateModelResolver } from "../../shared/model-resolution.js";
import {
	getCurrentSubagentDepth,
	type IntercomEventBus,
	isWorkflowStageOrchestrationContext,
	type RunSyncOptions,
	workflowSessionMetadataFromContext,
} from "../../shared/types.js";
import { inheritedIntercomGroup } from "../shared/intercom-group.js";
import { currentModelFullId } from "../shared/model-fallback.js";
import { type OwnerlessChildLaunch, runOwnerlessChild, takeStoppedQueuedOwnerlessChild } from "./ownerless-children.js";
import { resumeRunWorktree } from "./run-worktrees.js";
import { type ChildTargetHold, childHoldKey, holdChildTargets, takeEarlyChildHold } from "./subagent-child-hold.js";
import {
	createSubagentChildRecordSink,
	findSubagentChildRecord,
	isRestorableSubagentChild,
	readSubagentChildRecords,
	recordSubagentChildGone,
	SUBAGENT_CHILD_GONE_STATUS,
	type SubagentChildRecord,
	type SubagentChildRecordSink,
	subagentChildOwner,
} from "./subagent-child-records.js";
import { readPreviousIntercomId, reopenChildSession } from "./subagent-child-session.js";
import { resolveSubagentExecutorRuntimeDeps } from "./subagent-executor-runtime.js";
import { notifyDetachedForegroundChildExit } from "./subagent-executor-status.js";
import type { ExecutorDeps } from "./subagent-executor-types.js";
import {
	type QueuedSubagentChildStart,
	runAgentTask,
	subagentChildSchedule,
	takeStoppedQueuedSubagentChild,
} from "./task-execution.js";

/** Prompt a restored child receives after its own interrupted session is reopened (#3760). */
export const SUBAGENT_RESUME_CONTINUATION_PROMPT =
	"Atomic restarted while you were working, and your session has been restored. Continue where you left off. If you believe you are finished with your original task, stop.";

/** Event the Intercom extension answers once a restored child is registered with the broker. */
export const SUBAGENT_AWAIT_INTERCOM_PEER_EVENT = "subagent:await-intercom-peer";

export const SUBAGENT_INTERCOM_PEER_TIMEOUT_MS = 15_000;

/**
 * Intercom asks, before it sends, whether a restored child of this session is still coming back (#3760).
 * The target may be the child's Intercom name, its Atomic session id, or the Intercom id it had before the restart.
 * `completion` resolves to a refusal message when the send must not go out (the child is gone, or did not
 * come back in time), and to `undefined` when the send may proceed.
 */
export const SUBAGENT_AWAIT_CHILD_RESTORATION_EVENT = "subagent:await-child-restoration";

export interface SubagentAwaitChildRestorationRequest {
	readonly ownerSessionId: string;
	readonly target: string;
	readonly timeoutMs: number;
	completion?: Promise<string | undefined>;
}

export interface SubagentAwaitIntercomPeerRequest {
	readonly name: string;
	readonly group?: string;
	readonly timeoutMs: number;
	completion?: Promise<boolean>;
}

export {
	holdDormantRunSubagentChildren,
	holdRunningSubagentChildren,
	releaseEarlyChildHolds,
	SUBAGENT_RELEASE_RESTORING_CHILD_EVENT,
	SUBAGENT_RESERVE_RESTORING_CHILD_EVENT,
	type SubagentReleaseRestoringChildRequest,
	type SubagentReserveRestoringChildRequest,
	WORKFLOW_DORMANT_RUN_SUBAGENT_HOLD_EVENT,
	type WorkflowDormantRunSubagentHold,
	type WorkflowDormantRunSubagentHoldRequest,
} from "./subagent-child-hold.js";

export type SubagentChildRestoreDeps = Pick<ExecutorDeps, "pi" | "config" | "discoverAgents" | "runtime">;

/** How an explicit `subagent({ action: "resume" })` reopens a child, instead of session recovery after a restart. */
export interface SubagentChildResumeRequest {
	/** The prompt the reopened child runs next. */
	readonly prompt: string;
	/** Run after `prompt` when it steers a turn the child had not finished. */
	readonly continuation?: string;
	/** The caller's message; a child stopped before it ever started gets it after its original task. */
	readonly message?: string;
}

export type SubagentChildRestoreOutcome =
	| {
			readonly kind: "restored";
			readonly record: SubagentChildRecord;
			readonly taskId: string;
			/** Whether the child re-registered with Intercom; undefined when the child has no Intercom identity. */
			readonly intercomLive: boolean | undefined;
	  }
	| { readonly kind: "terminal"; readonly record: SubagentChildRecord }
	| {
			readonly kind: "unrestorable";
			readonly childId: string;
			readonly record?: SubagentChildRecord;
			readonly reason: string;
	  };

interface ActiveRestoration {
	readonly ownerSessionId: string;
	readonly record: SubagentChildRecord;
	readonly outcome: Promise<SubagentChildRestoreOutcome>;
	/** The Intercom id the child registered under before the restart; settles once its session is reopened. */
	readonly previousIntercomId: Promise<string | undefined>;
	/** Set once the restoration finished: the child was relaunched, or could not be. */
	settled?: SubagentChildRestoreOutcome;
	/** The Intercom id the child registered under before the restart, once known. */
	knownPreviousIntercomId?: string;
}

const activeRestorations = new Map<string, ActiveRestoration>();
/** Children this process found unrestorable, kept until their gone record is durable so senders see them as gone at once. */
const goneChildren = new Map<
	string,
	{
		readonly ownerSessionId: string;
		readonly record: SubagentChildRecord;
		readonly reason: string;
		readonly previousIntercomId: string | undefined;
	}
>();

async function awaitIntercomPeer(
	events: IntercomEventBus,
	name: string,
	group: string | undefined,
): Promise<boolean | undefined> {
	const request: SubagentAwaitIntercomPeerRequest = {
		name,
		...(group ? { group } : {}),
		timeoutMs: SUBAGENT_INTERCOM_PEER_TIMEOUT_MS,
	};
	try {
		events.emit(SUBAGENT_AWAIT_INTERCOM_PEER_EVENT, request);
	} catch (error) {
		if (!isStaleExtensionContextError(error)) throw error;
		return undefined;
	}
	return request.completion ? await request.completion.catch(() => false) : undefined;
}

/**
 * The model and thinking level a reopened child session was last running on, as a `provider/model:thinking`
 * candidate, or `undefined` when no model is known or that model is no longer usable here (#3760).
 * A restored child continues on these rather than the reopened parent's current model and thinking level.
 *
 * A forked child's session starts with the parent's copied model and thinking entries, and its launch model and
 * thinking level (an agent or per-call `model:level`) are applied without writing entries of their own. So the
 * latest change the child's own session recorded after launch wins, then what the launch record says it started
 * on, and only then whatever the session's entries say.
 */
function ownSessionModelCandidate(
	sessionManager: SessionManager,
	record: SubagentChildRecord,
	resolveCandidateModel: ReturnType<typeof createCandidateModelResolver>,
): string | undefined {
	const branch = sessionManager.getBranch();
	const launchIndex =
		record.launchLeafId === undefined
			? branch.length
			: record.launchLeafId === null
				? 0
				: branch.findIndex((entry) => entry.id === record.launchLeafId) + 1 || branch.length;
	let changedModel: string | undefined;
	let changedThinking: string | undefined;
	for (const entry of branch.slice(launchIndex)) {
		if (entry.type === "model_change") changedModel = `${entry.provider}/${entry.modelId}`;
		else if (entry.type === "thinking_level_change") changedThinking = entry.thinkingLevel;
	}
	const context = sessionManager.buildSessionContext();
	const model =
		changedModel ??
		record.launchModel ??
		(context.model ? `${context.model.provider}/${context.model.modelId}` : undefined);
	if (!model) return undefined;
	const candidate = `${model}:${changedThinking ?? record.launchThinkingLevel ?? context.thinkingLevel}`;
	return resolveCandidateModel(candidate)?.model ? candidate : undefined;
}

/**
 * What the reopened child is prompted with, in order: the messages it had queued and not read when it was stopped,
 * once, then the resume prompt and its continuation. A continuation it had queued is not repeated.
 */
function resumedPrompts(
	record: SubagentChildRecord,
	resume: SubagentChildResumeRequest | undefined,
): { readonly task: string; readonly followUps: readonly string[] } {
	const prompt = resume?.prompt ?? SUBAGENT_RESUME_CONTINUATION_PROMPT;
	const continuations = new Set([
		SUBAGENT_RESUME_CONTINUATION_PROMPT,
		resume?.continuation,
		resume?.message ? undefined : prompt,
	]);
	const held =
		record.heldMessages && record.heldMessages.taskId === record.taskId
			? record.heldMessages.messages.filter((message) => !continuations.has(message))
			: [];
	const [task = prompt, ...followUps] = [...held, prompt, ...(resume?.continuation ? [resume.continuation] : [])];
	return { task, followUps };
}

async function relaunchChild(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	record: SubagentChildRecord,
	hold: ChildTargetHold | undefined,
	release: () => void,
	onReopened: (previousIntercomId: string | undefined) => void,
	resume: SubagentChildResumeRequest | undefined,
): Promise<SubagentChildRestoreOutcome> {
	const unrestorable = (reason: string): SubagentChildRestoreOutcome => ({
		kind: "unrestorable",
		childId: record.childId,
		record,
		reason,
	});
	const host = ctx.getAgentTaskHost?.();
	const queued = record.taskId && host ? takeStoppedQueuedSubagentChild(record.taskId) : undefined;
	if (queued && host) return startQueuedChild(deps, ctx, host, record, queued, hold, release, resume);
	const queuedOwnerless = record.taskId && !host ? takeStoppedQueuedOwnerlessChild(record.taskId) : undefined;
	// Without a task host nothing else ends the resumed child with its owner: closing the session stops it resumably.
	const ownerSignal = host ? undefined : (ctx.getCurrentSessionSignal?.() ?? ctx.sessionSignal);
	if (queuedOwnerless) {
		const supervisorAuthorization = record.intercomTarget ? hold?.authorization : undefined;
		if (!supervisorAuthorization) await hold?.release();
		const recordChild = createSubagentChildRecordSink(deps.pi, ctx);
		const launched = queuedOwnerless({
			recordChild,
			...(ownerSignal ? { signal: ownerSignal } : {}),
			...(resume?.message ? { message: resume.message } : {}),
			...(supervisorAuthorization ? { supervisorAuthorization } : {}),
		});
		return ownerlessRelaunched(deps, record, launched, recordChild, release, hold, supervisorAuthorization, ctx);
	}
	if (!existsSync(record.cwd)) return unrestorable(`its working directory no longer exists: ${record.cwd}`);
	const discovered = deps
		.discoverAgents(record.cwd, resolveExecutionAgentScope(undefined))
		.agents.find((agent) => agent.name === record.agent);
	if (!discovered) return unrestorable(`agent "${record.agent}" is no longer defined`);
	const bridge = record.orchestratorTarget
		? resolveIntercomBridge({
				config: deps.config.intercomBridge,
				context: "fresh",
				orchestratorTarget: resolveIntercomSessionTarget(
					deps.pi.getSessionName(),
					ctx.sessionManager.getSessionId(),
				),
				cwd: record.cwd,
			})
		: undefined;
	const agent = bridge?.active ? applyIntercomBridgeToAgent(discovered, bridge) : discovered;
	const reopened = await reopenChildSession(ctx, record);
	if ("reason" in reopened) return unrestorable(reopened.reason);
	const { sessionManager } = reopened;
	const previousIntercomId = readPreviousIntercomId(sessionManager);
	onReopened(previousIntercomId);
	if (previousIntercomId) await hold?.add(previousIntercomId);
	const childOptions = ctx.getChildSessionOptions?.({ tools: agent.tools });
	const supervisorAuthorization = childOptions && !childAllowsIntercom(childOptions) ? undefined : hold?.authorization;
	// A child that will not use Intercom never registers, so nothing it could be sent should wait for it.
	if (!supervisorAuthorization) await hold?.release();
	const intercomGroup = record.intercomGroup ?? inheritedIntercomGroup(ctx);
	const currentProvider = ctx.model?.provider;
	const resolveCandidateModel = createCandidateModelResolver(ctx.modelRegistry, currentProvider);
	const ownModel = ownSessionModelCandidate(sessionManager, record, resolveCandidateModel);
	const prompts = resumedPrompts(record, resume);
	const options: RunSyncOptions = {
		runningCapacity: deps.config.parallel?.runningCapacity,
		getChildSessionOptions: ctx.getChildSessionOptions,
		resourceLoaderInheritanceSnapshot: deps.pi.getResourceLoaderInheritanceSnapshot?.(),
		cwd: record.cwd,
		runId: record.runId,
		index: record.index,
		sessionDir: sessionManager.getSessionDir() || mkdtempSync(join(tmpdir(), "atomic-subagent-restore-")),
		sessionManager,
		resumeSession: true,
		...(prompts.followUps.length > 0 ? { resumeFollowUps: prompts.followUps } : {}),
		intercomEvents: deps.pi.events,
		parentDepth: getCurrentSubagentDepth(ctx),
		workflowStageSubagentGuard: isWorkflowStageOrchestrationContext(ctx),
		workflowSessionMetadata: workflowSessionMetadataFromContext(ctx),
		...(record.intercomTarget ? { intercomSessionName: record.intercomTarget } : {}),
		...(supervisorAuthorization ? { supervisorAuthorization } : {}),
		...(bridge?.active && bridge.orchestratorTarget ? { orchestratorIntercomTarget: bridge.orchestratorTarget } : {}),
		...(intercomGroup ? { intercomGroup } : {}),
		availableModels: ctx.modelRegistry.getAvailable().map(toModelInfo),
		knownModelProviders: collectKnownModelProviders(ctx.modelRegistry),
		resolveCandidateModel,
		preferredModelProvider: currentProvider,
		...(ownModel ? { modelOverride: ownModel } : {}),
		currentModel: currentModelFullId(ctx.model),
		currentThinkingLevel: ctx.thinkingLevel,
	};
	ctx.orchestrationContext?.messageAdmission?.boundary.registerOwnedSubagentRun(record.runId);
	const recordChild = createSubagentChildRecordSink(deps.pi, ctx);
	const runtime = resolveSubagentExecutorRuntimeDeps(deps.runtime);
	// It waits for a slot in its run, as its original launch did.
	const schedule = subagentChildSchedule(record.runId, record.index);
	if (!host) {
		// No task host (an SDK session): it runs in the background directly, recorded like a task-host launch.
		const launched = runOwnerlessChild({
			agent: agent.name,
			task: prompts.task,
			cwd: record.cwd,
			options: { ...options, ...(ownerSignal ? { signal: ownerSignal } : {}) },
			recordChild,
			...(schedule ? { schedule } : {}),
			runSync: (task, childOptions) => runtime.runSync(ctx.cwd, [agent], agent.name, task, childOptions),
		});
		return ownerlessRelaunched(deps, record, launched, recordChild, release, hold, supervisorAuthorization, ctx);
	}
	const response = await runAgentTask({
		host,
		cwd: ctx.cwd,
		agents: [agent],
		agent: agent.name,
		task: prompts.task,
		...(resume ? { operation: `${record.runId}:${record.index}:resume:${randomUUID()}` } : {}),
		options,
		wait: { kind: "background" },
		runtime,
		recordChild,
		...(schedule ? { schedule } : {}),
		onTerminal: () => {
			release();
			// Normally the child consumed the hold when it registered; one that never did must not keep it.
			void hold?.release();
		},
	});
	return relaunched(deps, record, response, recordChild, release, supervisorAuthorization, intercomGroup);
}

/** Start a child that pause or quit stopped while it was still queued, on its original launch (#3760). */
async function startQueuedChild(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	host: AgentTaskHost,
	record: SubagentChildRecord,
	queued: QueuedSubagentChildStart,
	hold: ChildTargetHold | undefined,
	release: () => void,
	resume: SubagentChildResumeRequest | undefined,
): Promise<SubagentChildRestoreOutcome> {
	const supervisorAuthorization = queued.usesIntercom ? hold?.authorization : undefined;
	if (!supervisorAuthorization) await hold?.release();
	ctx.orchestrationContext?.messageAdmission?.boundary.registerOwnedSubagentRun(record.runId);
	const recordChild = createSubagentChildRecordSink(deps.pi, ctx);
	const response = await queued.start({
		host,
		recordChild,
		...(resume?.message ? { message: resume.message } : {}),
		...(supervisorAuthorization ? { supervisorAuthorization } : {}),
		onTerminal: () => {
			release();
			void hold?.release();
		},
	});
	return relaunched(
		deps,
		record,
		response,
		recordChild,
		release,
		supervisorAuthorization,
		record.intercomGroup ?? inheritedIntercomGroup(ctx),
	);
}

/**
 * A child relaunched without a task host runs in the background: its result reaches the owner as a completion notice,
 * as a task-host child's does.
 */
async function ownerlessRelaunched(
	deps: SubagentChildRestoreDeps,
	record: SubagentChildRecord,
	launched: OwnerlessChildLaunch,
	recordChild: SubagentChildRecordSink,
	release: () => void,
	hold: ChildTargetHold | undefined,
	supervisorAuthorization: ChildTargetHold["authorization"] | undefined,
	ctx: ExtensionContext,
): Promise<SubagentChildRestoreOutcome> {
	void launched.result
		.then(
			(child) => {
				// Pause and quit report through their own results.
				if (!child.interrupted)
					notifyDetachedForegroundChildExit({
						pi: deps.pi,
						runId: record.runId,
						mode: "single",
						index: record.index,
						result: child,
						notificationId: `subagent-resume-${launched.launchId}`,
						noticeLabel: "Resumed subagent task",
					});
			},
			() => {},
		)
		.finally(() => {
			release();
			// Normally the child consumed the hold when it registered; one that never did must not keep it.
			void hold?.release();
		});
	// Pause or quit right after this returns must find the child under its new launch id.
	await recordChild.flushed?.();
	const intercomGroup = record.intercomGroup ?? inheritedIntercomGroup(ctx);
	const intercomLive =
		record.intercomTarget && supervisorAuthorization
			? await awaitIntercomPeer(deps.pi.events, record.intercomTarget, intercomGroup)
			: undefined;
	return { kind: "restored", record, taskId: launched.launchId, intercomLive };
}

async function relaunched(
	deps: SubagentChildRestoreDeps,
	record: SubagentChildRecord,
	response: ModelSingleResponse,
	recordChild: SubagentChildRecordSink,
	release: () => void,
	supervisorAuthorization: ChildTargetHold["authorization"] | undefined,
	intercomGroup: string | undefined,
): Promise<SubagentChildRestoreOutcome> {
	if (response.kind === "unstarted") {
		release();
		return {
			kind: "unrestorable",
			childId: record.childId,
			record,
			reason: `relaunch was refused: ${response.reason.error.message}`,
		};
	}
	// Pause or quit right after this returns must find the child under its new task id.
	await recordChild.flushed?.();
	const intercomLive =
		record.intercomTarget && supervisorAuthorization
			? await awaitIntercomPeer(deps.pi.events, record.intercomTarget, intercomGroup)
			: undefined;
	return { kind: "restored", record, taskId: response.observation.taskId, intercomLive };
}

/**
 * Restore one background child this session launched: reopen the child's own session,
 * relaunch it in the background with a continuation prompt, and re-register it with
 * Intercom under its original name and group with a fresh supervisor capability (#3760).
 * Accepts the child id (`<runId>:<index>`), its launch task id, or its Intercom name.
 * Records that a fork copied from another session name that session as their owner, so they are never restored here.
 * With `resume`, an explicit `subagent({ action: "resume" })` reopens a settled child the same way; the caller
 * decides which settled children are resumable.
 */
export async function restoreSubagentChild(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	id: string,
	resume?: SubagentChildResumeRequest,
): Promise<SubagentChildRestoreOutcome> {
	const ownerSessionId = subagentChildOwner(ctx).sessionId;
	const record = findSubagentChildRecord(
		readSubagentChildRecords(ctx.sessionManager.getEntries(), ownerSessionId),
		id,
	);
	if (!record) return { kind: "unrestorable", childId: id, reason: "this session has no record of that subagent" };
	if (!isRestorableSubagentChild(record) && !resume) return { kind: "terminal", record };
	const key = childHoldKey(ownerSessionId, record.childId);
	const active = activeRestorations.get(key);
	if (active) return active.outcome;
	goneChildren.delete(key);
	const previousIntercomId = Promise.withResolvers<string | undefined>();
	let knownPreviousIntercomId: string | undefined;
	const onReopened = (intercomId: string | undefined) => {
		knownPreviousIntercomId = intercomId;
		previousIntercomId.resolve(intercomId);
	};
	const release = () => {
		if (activeRestorations.get(key)?.outcome === restoration) activeRestorations.delete(key);
	};
	let hold: ChildTargetHold | undefined;
	const markGone = async (reason: string) => {
		goneChildren.set(key, {
			ownerSessionId,
			record,
			reason,
			previousIntercomId: knownPreviousIntercomId,
		});
		release();
		// Every sender, not only this session, is told the child is gone, for as long as this session is connected.
		await hold?.gone(reason);
	};
	// Hold the child's worktree until its new execution holds it, recreating it from the run's base if it was removed.
	const releaseWorktree = resumeRunWorktree(
		record,
		deps.config.worktreeSetupHook
			? { hookPath: deps.config.worktreeSetupHook, timeoutMs: deps.config.worktreeSetupHookTimeoutMs }
			: undefined,
	);
	const restoration: Promise<SubagentChildRestoreOutcome> = (async () => {
		// Hold sends to the child before anything can fail, so no sender is told `Session not found` meanwhile.
		// When the session already holds them since it started, that hold carries on under the same capability:
		// what it holds stays held, and no moment passes without a hold.
		const earlier = await takeEarlyChildHold(key);
		if (earlier) {
			hold = earlier;
			await hold.refresh();
		} else {
			hold = await holdChildTargets(deps.pi.events, record, record.intercomGroup ?? inheritedIntercomGroup(ctx));
		}
		return relaunchChild(deps, ctx, record, hold, release, onReopened, resume);
	})().then(
		async (outcome) => {
			previousIntercomId.resolve(undefined);
			const registered = activeRestorations.get(key);
			if (registered?.outcome === restoration) {
				registered.settled = outcome;
				registered.knownPreviousIntercomId = knownPreviousIntercomId;
			}
			releaseWorktree();
			if (outcome.kind === "unrestorable") await markGone(outcome.reason);
			else if (outcome.kind !== "restored") release();
			return outcome;
		},
		async (error: Error) => {
			previousIntercomId.resolve(undefined);
			releaseWorktree();
			await markGone(error.message);
			return { kind: "unrestorable", childId: record.childId, record, reason: error.message };
		},
	);
	activeRestorations.set(key, {
		ownerSessionId,
		record,
		outcome: restoration,
		previousIntercomId: previousIntercomId.promise,
	});
	return restoration;
}

/**
 * Intercom asks, when it decides what to do with the interrupted deliveries of a reopened session, which of its children
 * were relaunched but have not registered with Intercom yet (#3760). They may still reconnect, so deliveries they sent
 * are neither replayed as if they were live nor discarded as if they were gone.
 */
export const SUBAGENT_RESTORED_INTERCOM_PEERS_EVENT = "subagent:restored-intercom-peers";

/** A child this session relaunched that has not registered with Intercom yet. */
export interface SubagentRestoredIntercomPeer {
	/** Its Intercom name. */
	readonly name: string;
	/** Its Atomic session id and the Intercom id it had before the restart, when known. */
	readonly ids: readonly string[];
}

export interface SubagentRestoredIntercomPeersRequest {
	readonly ownerSessionId: string;
	completion?: Promise<readonly SubagentRestoredIntercomPeer[]>;
}

/** The children of this session that were relaunched in this process but did not register with Intercom in time. */
export function restoredChildrenAwaitingIntercom(ownerSessionId: string): SubagentRestoredIntercomPeer[] {
	const peers: SubagentRestoredIntercomPeer[] = [];
	for (const restoration of activeRestorations.values()) {
		const { settled, record } = restoration;
		if (restoration.ownerSessionId !== ownerSessionId || !record.intercomTarget) continue;
		if (settled?.kind !== "restored" || settled.intercomLive !== false) continue;
		peers.push({
			name: record.intercomTarget,
			ids: [record.childSessionId, restoration.knownPreviousIntercomId].filter((id): id is string => !!id),
		});
	}
	return peers;
}

/** Restore every background child this session launched that had not settled when it was interrupted. */
export async function restoreSubagentChildren(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
): Promise<SubagentChildRestoreOutcome[]> {
	const owned = readSubagentChildRecords(ctx.sessionManager.getEntries(), subagentChildOwner(ctx).sessionId);
	return Promise.all(
		[...owned.values()]
			.filter(isRestorableSubagentChild)
			.map((record) => restoreSubagentChild(deps, ctx, record.childId)),
	);
}

/**
 * Whether a send target addresses this child: by its Intercom name, its Atomic session id, or the Intercom id
 * it registered under before the restart (the id its restored session reclaims). `target` is trimmed and lowercased.
 */
function addressesChild(record: SubagentChildRecord, target: string, previousIntercomId?: string): boolean {
	return [record.intercomTarget, record.childSessionId, previousIntercomId].some(
		(address) => address?.trim().toLowerCase() === target,
	);
}

function goneChildRefusal(label: string, reason?: string): string {
	return `Subagent \`${label}\` did not survive the restart and is gone${reason ? `: ${reason}` : ""}. The message was not sent; launch a fresh subagent if its work is still needed.`;
}

function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve(undefined), Math.max(0, timeoutMs));
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * Gate a message to a child of this session that a restart is restoring (#3760). The target may be the child's
 * Intercom name, its Atomic session id, or its pre-restart Intercom id. Waits (bounded) while its restoration is
 * in progress, then resolves `undefined` when the child is live again and the send may go out, or a refusal
 * explaining that the child is gone so the sender is not told `Session not found`.
 * Children with no restoration in flight, or that completed normally, are left to the ordinary send path.
 */
export async function awaitSubagentChildRestoration(
	ownerSessionId: string,
	entries: readonly SessionEntry[],
	targetName: string,
	timeoutMs: number,
): Promise<string | undefined> {
	const target = targetName.trim().toLowerCase();
	if (!target) return undefined;
	const deadline = Date.now() + timeoutMs;
	const owned = [...activeRestorations.values()].filter(
		(restoration) => restoration.ownerSessionId === ownerSessionId,
	);
	let active = owned.find((restoration) => addressesChild(restoration.record, target));
	if (!active && owned.length > 0) {
		// A child's pre-restart Intercom id is known only once its own session has been reopened.
		const previousIds = await settleWithin(
			Promise.all(owned.map((restoration) => restoration.previousIntercomId)),
			deadline - Date.now(),
		);
		active = owned.find((restoration, index) => addressesChild(restoration.record, target, previousIds?.[index]));
	}
	if (active) {
		const label = active.record.intercomTarget ?? targetName.trim();
		const outcome = await settleWithin(active.outcome, deadline - Date.now());
		if (!outcome)
			return `Subagent \`${label}\` is still being restored after the restart. The message was not sent; try again shortly.`;
		if (outcome.kind === "unrestorable") return goneChildRefusal(label, outcome.reason);
		if (outcome.kind === "restored" && outcome.intercomLive === false)
			return `Subagent \`${label}\` was relaunched after the restart but has not reconnected to Intercom. The message was not sent; its result will still arrive as a task completion.`;
		return undefined;
	}
	for (const reported of goneChildren.values()) {
		if (
			reported.ownerSessionId === ownerSessionId &&
			addressesChild(reported.record, target, reported.previousIntercomId)
		)
			return goneChildRefusal(reported.record.intercomTarget ?? targetName.trim(), reported.reason);
	}
	const gone = [...readSubagentChildRecords(entries, ownerSessionId).values()].find(
		(record) =>
			addressesChild(record, target) &&
			record.state === "terminal" &&
			record.terminalStatus === SUBAGENT_CHILD_GONE_STATUS,
	);
	return gone ? goneChildRefusal(gone.intercomTarget ?? targetName.trim()) : undefined;
}

function childLabel(record: SubagentChildRecord | undefined, childId: string): string {
	if (!record) return `Subagent ${childId}`;
	return record.intercomTarget
		? `Background subagent \`${record.intercomTarget}\` (${record.agent})`
		: `Background subagent ${record.agent} (${record.childId})`;
}

/** Agent-facing notices describing what restoration did, so the session never addresses a gone child. */
export function subagentChildRestoreNotices(outcomes: readonly SubagentChildRestoreOutcome[]): string[] {
	return outcomes.flatMap((outcome) => {
		if (outcome.kind === "terminal") return [];
		if (outcome.kind === "unrestorable")
			return [
				`${childLabel(outcome.record, outcome.childId)} did not survive the restart and could not be restored: ${outcome.reason}. It is gone: do not send it Intercom messages or wait for its result. Launch a fresh subagent if its work is still needed.`,
			];
		const label = childLabel(outcome.record, outcome.record.childId);
		if (outcome.intercomLive === false)
			return [
				`${label} was relaunched from its own session as task ${outcome.taskId}, but it did not reconnect to Intercom. Treat it as unreachable until it reconnects; its result will still arrive as a task completion.`,
			];
		return [
			`${label} was interrupted by the restart and has been relaunched from its own session as task ${outcome.taskId}${outcome.intercomLive ? "; it is live on Intercom under the same name" : ""}.`,
		];
	});
}

/**
 * Record unrestorable children as gone once the agent has been told so (#3760). Without this a child
 * that can never be restored keeps its `running` record, so every later resume would retry it and post
 * the same notice again. Children that were restored are never marked: they keep recording their own
 * progress. A failed write only means a later restart reports the child again.
 */
export async function recordReportedGoneSubagentChildren(
	pi: Pick<ExtensionAPI, "appendEntry">,
	outcomes: readonly SubagentChildRestoreOutcome[],
): Promise<void> {
	for (const outcome of outcomes) {
		if (outcome.kind !== "unrestorable" || !outcome.record) continue;
		await recordSubagentChildGone(pi, outcome.record).catch(() => undefined);
	}
}
