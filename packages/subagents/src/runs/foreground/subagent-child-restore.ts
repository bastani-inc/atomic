import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	isStaleExtensionContextError,
	type SessionEntry,
	SessionManager,
} from "@bastani/atomic";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.js";
import {
	applyIntercomBridgeToAgent,
	resolveIntercomBridge,
	resolveIntercomSessionTarget,
} from "../../intercom/intercom-bridge.js";
import {
	childAllowsIntercom,
	requestSupervisorAuthorization,
	type SupervisorAuthorization,
} from "../../intercom/supervisor-authorization.js";
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
import {
	createSubagentChildRecordSink,
	findSubagentChildRecord,
	readSubagentChildRecords,
	recordSubagentChildGone,
	SUBAGENT_CHILD_GONE_STATUS,
	type SubagentChildRecord,
	subagentChildOwner,
} from "./subagent-child-records.js";
import { resolveSubagentExecutorRuntimeDeps } from "./subagent-executor-runtime.js";
import type { ExecutorDeps } from "./subagent-executor-types.js";
import { runAgentTask } from "./task-execution.js";

/** Prompt a restored child receives after its own interrupted session is reopened (#3760). */
export const SUBAGENT_RESUME_CONTINUATION_PROMPT =
	"Atomic restarted while you were working, and your session has been restored. Continue where you left off. If you believe you are finished with your original task, stop.";

/** Event the Intercom extension answers once a restored child is registered with the broker. */
export const SUBAGENT_AWAIT_INTERCOM_PEER_EVENT = "subagent:await-intercom-peer";

export const SUBAGENT_INTERCOM_PEER_TIMEOUT_MS = 15_000;

/** Intercom's entry recording the Intercom id a session registered under (`packages/intercom/session-identity.ts`). */
const INTERCOM_SESSION_IDENTITY_ENTRY = "intercom_session_identity";

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

/**
 * Asks Intercom to have the broker hold sends from any sender to a child this session is restoring, by the
 * supervisor capability just issued for that child (#3760). The broker holds them until the child registers
 * with that capability, the owner releases the hold, or the owner disconnects.
 */
export const SUBAGENT_RESERVE_RESTORING_CHILD_EVENT = "subagent:reserve-restoring-child";
/** Ends that hold; with `gone` (the reason) held and later senders are told the child did not survive the restart. */
export const SUBAGENT_RELEASE_RESTORING_CHILD_EVENT = "subagent:release-restoring-child";

export interface SubagentReserveRestoringChildRequest {
	readonly capability: string;
	readonly group?: string;
	/** The child's Atomic session id and the Intercom id it had before the restart. */
	readonly aliases: readonly string[];
	completion?: Promise<void>;
}

export interface SubagentReleaseRestoringChildRequest {
	readonly capability: string;
	readonly gone?: string;
	completion?: Promise<void>;
}

export type SubagentChildRestoreDeps = Pick<ExecutorDeps, "pi" | "config" | "discoverAgents" | "runtime">;

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

/** The Intercom id the child's own Intercom extension recorded for its session before the restart. */
function readPreviousIntercomId(sessionManager: SessionManager): string | undefined {
	const sessionId = sessionManager.getSessionId();
	const entries = sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== INTERCOM_SESSION_IDENTITY_ENTRY) continue;
		const data = entry.data as { sessionId?: string; intercomSessionId?: string } | undefined;
		if (data?.sessionId === sessionId && typeof data.intercomSessionId === "string" && data.intercomSessionId)
			return data.intercomSessionId;
	}
	return undefined;
}

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
 * The broker's hold on a child's Intercom targets while its owner restores it (#3760): sends from any sender to
 * its name, Atomic session id or pre-restart Intercom id wait for the child instead of failing with `Session not found`.
 */
interface ChildTargetHold {
	/** The fresh supervisor capability the hold was made under; the relaunched child registers with it. */
	readonly authorization: SupervisorAuthorization;
	/** Also hold sends addressed to `alias`. */
	add(alias: string): Promise<void>;
	/** End the hold; held sends go through ordinary routing. */
	release(): Promise<void>;
	/** End the hold as gone; held and later senders are told the child did not survive the restart. */
	gone(reason: string): Promise<void>;
}

/** Holding is best effort: without it senders get `Session not found`, as they did before the hold existed. */
function emitIntercomRequest(events: IntercomEventBus, eventName: string, request: { completion?: Promise<void> }) {
	try {
		events.emit(eventName, request);
	} catch {
		return Promise.resolve();
	}
	return (request.completion ?? Promise.resolve()).catch(() => undefined);
}

/**
 * Authorize this session as the child's supervisor again and, under that capability, have the broker hold
 * sends to the child's name and Atomic session id. Undefined when the child has no Intercom name or no
 * Intercom extension answers.
 */
async function holdChildTargets(
	events: IntercomEventBus,
	record: SubagentChildRecord,
	group: string | undefined,
): Promise<ChildTargetHold | undefined> {
	if (!record.intercomTarget) return undefined;
	const authorization = await requestSupervisorAuthorization(events, record.intercomTarget);
	if (!authorization) return undefined;
	const { capability } = authorization;
	const reserve = (aliases: readonly string[]) => {
		const request: SubagentReserveRestoringChildRequest = { capability, aliases, ...(group ? { group } : {}) };
		return emitIntercomRequest(events, SUBAGENT_RESERVE_RESTORING_CHILD_EVENT, request);
	};
	let ended = false;
	const end = (gone?: string) => {
		if (ended) return Promise.resolve();
		ended = true;
		const request: SubagentReleaseRestoringChildRequest = { capability, ...(gone === undefined ? {} : { gone }) };
		return emitIntercomRequest(events, SUBAGENT_RELEASE_RESTORING_CHILD_EVENT, request);
	};
	await reserve(record.childSessionId ? [record.childSessionId] : []);
	return {
		authorization,
		add: (alias) => (ended ? Promise.resolve() : reserve([alias])),
		release: () => end(),
		gone: (reason) => end(reason),
	};
}

/**
 * Reopen a child's own session from wherever it was created: its JSONL session file when
 * one was recorded, otherwise by session id from the owner's session store (forked children
 * live in the store of the session that launched them, which is a database by default and
 * has no session file).
 */
async function reopenChildSession(
	ctx: ExtensionContext,
	record: SubagentChildRecord,
): Promise<{ readonly sessionManager: SessionManager } | { readonly reason: string }> {
	try {
		if (record.childSessionFile && existsSync(record.childSessionFile)) {
			const sessionManager = await SessionManager.open(record.childSessionFile, undefined, record.cwd);
			return record.childSessionId !== undefined && sessionManager.getSessionId() !== record.childSessionId
				? { reason: "its session file now belongs to a different session" }
				: { sessionManager };
		}
		if (record.childSessionId === undefined) return { reason: "no session was recorded for it" };
		return {
			sessionManager: await SessionManager.open(
				ctx.sessionManager.getSessionStore(),
				record.childSessionId,
				record.cwd,
			),
		};
	} catch (error) {
		if (error instanceof Error && error.name === "SessionNotFoundError")
			return { reason: "its session no longer exists in the session store" };
		throw error;
	}
}

/**
 * The model and thinking level a reopened child session was last running on, as a `provider/model:thinking`
 * candidate, or `undefined` when no model is known or that model is no longer usable here (#3760).
 * A restored child continues on these rather than the resumed parent's current model and thinking level.
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

async function relaunchChild(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	record: SubagentChildRecord,
	hold: ChildTargetHold | undefined,
	release: () => void,
	onReopened: (previousIntercomId: string | undefined) => void,
): Promise<SubagentChildRestoreOutcome> {
	const unrestorable = (reason: string): SubagentChildRestoreOutcome => ({
		kind: "unrestorable",
		childId: record.childId,
		record,
		reason,
	});
	if (!ctx.getAgentTaskHost) return unrestorable("this session cannot host background subagents");
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
	const response = await runAgentTask({
		host: ctx.getAgentTaskHost(),
		cwd: ctx.cwd,
		agents: [agent],
		agent: agent.name,
		task: SUBAGENT_RESUME_CONTINUATION_PROMPT,
		options,
		wait: { kind: "background" },
		runtime: resolveSubagentExecutorRuntimeDeps(deps.runtime),
		recordChild: createSubagentChildRecordSink(deps.pi, ctx),
		onTerminal: () => {
			release();
			// Normally the child consumed the hold when it registered; one that never did must not keep it.
			void hold?.release();
		},
	});
	if (response.kind === "unstarted") {
		release();
		return unrestorable(`relaunch was refused: ${response.reason.error.message}`);
	}
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
 */
export async function restoreSubagentChild(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	id: string,
): Promise<SubagentChildRestoreOutcome> {
	const ownerSessionId = subagentChildOwner(ctx).sessionId;
	const record = findSubagentChildRecord(
		readSubagentChildRecords(ctx.sessionManager.getEntries(), ownerSessionId),
		id,
	);
	if (!record) return { kind: "unrestorable", childId: id, reason: "this session has no record of that subagent" };
	if (record.state === "terminal") return { kind: "terminal", record };
	const key = `${ownerSessionId}\u0000${record.childId}`;
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
	const restoration: Promise<SubagentChildRestoreOutcome> = (async () => {
		// Hold sends to the child before anything can fail, so no sender is told `Session not found` meanwhile.
		hold = await holdChildTargets(deps.pi.events, record, record.intercomGroup ?? inheritedIntercomGroup(ctx));
		return relaunchChild(deps, ctx, record, hold, release, onReopened);
	})().then(
		async (outcome) => {
			previousIntercomId.resolve(undefined);
			if (outcome.kind === "unrestorable") await markGone(outcome.reason);
			else if (outcome.kind !== "restored") release();
			return outcome;
		},
		async (error: Error) => {
			previousIntercomId.resolve(undefined);
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

/** Restore every background child this session launched that had not settled when it was interrupted. */
export async function restoreSubagentChildren(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
): Promise<SubagentChildRestoreOutcome[]> {
	const owned = readSubagentChildRecords(ctx.sessionManager.getEntries(), subagentChildOwner(ctx).sessionId);
	return Promise.all(
		[...owned.values()]
			.filter((record) => record.state === "running")
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
 * Gate a message to a child of this session that a resume is restoring (#3760). The target may be the child's
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
 * progress. A failed write only means a later resume reports the child again.
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
