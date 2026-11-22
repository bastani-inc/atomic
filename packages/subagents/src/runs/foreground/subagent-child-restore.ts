import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentTaskHost,
	continueSessionWhereItWorked,
	currentWorktreeRootMappings,
	type DetachedToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type HostDiagnostic,
	isRetryableStorageError,
	isStaleExtensionContextError,
	type LatestBranchSetting,
	mapRestoredPathAsync,
	reportDebugAsync,
	type SessionEntry,
	type SessionManager,
	SettingsManager,
	savedProjectTrustAsync,
	sessionResumeOptions,
	type WorktreeRootMapping,
	withWorktreeRootMappings,
} from "@bastani/atomic";
import type { ModelSingleResponse } from "../../../../coding-agent/src/core/tasks/contracts.js";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.js";
import type { AgentConfig, AgentScope, AgentSource } from "../../agents/agent-types.js";
import { contextAgentDiscoveryOptions, discoverPackageAgents } from "../../agents/agents.js";
import {
	applyIntercomBridgeToAgent,
	resolveIntercomBridge,
	resolveIntercomSessionTarget,
} from "../../intercom/intercom-bridge.js";
import { ownIntercomSessionId } from "../../intercom/own-intercom-session.js";
import { childAllowsIntercom } from "../../intercom/supervisor-authorization.js";
import { childSessionStore } from "../../shared/child-session-store.js";
import { type CwdVerdict, checkLaunchCwd } from "../../shared/launch-cwd.js";
import { collectKnownModelProviders, toModelInfo } from "../../shared/model-info.js";
import { createCandidateModelResolver } from "../../shared/model-resolution.js";
import { getCurrentSubagentDepth, type IntercomEventBus, type RunSyncOptions } from "../../shared/types.js";
import { inheritedIntercomGroup } from "../shared/intercom-group.js";
import { currentModelFullId } from "../shared/model-fallback.js";
import { createExecutionScheduler, type ExecutionScheduler } from "../shared/parallel-utils.js";
import { subagentStartHoldMs } from "../shared/start-progress.js";
import { issuingCallEntries } from "./branch-read-back.js";
import { savedNoticeIds, unreadNotices, withoutLegacyLateMessages } from "./late-tool-result-notice.js";
import { type OwnerlessChildLaunch, runOwnerlessChild, takeStoppedQueuedOwnerlessChild } from "./ownerless-children.js";
import { formatReleasedReplyResults } from "./released-child-replies.js";
import {
	interruptedByRestart,
	interruptedStillRunningResult,
	pendingToolCalls,
	planReleasedChildWake,
	type ReadBackToolResult,
	type ReleasedChildWakePlan,
	readHeldToolResultsBack,
	releasedWakeResultKey,
	SUBAGENT_OWNER_GENERATION,
} from "./released-children.js";
import type { SubagentResumeNote } from "./resume-note.js";
import { boundedWorktreeReply, resumeRunWorktree, WORKTREE_REPLY_WAIT_MS } from "./run-worktrees.js";
import {
	indexSubagentChildOwner,
	loadSubagentChildRecord,
	readableSubagentChildRecordOf,
	SUBAGENT_CHILD_RECORD_TYPE,
} from "./subagent-child-card-state.js";
import { type ChildTargetHold, childHoldKey, holdChildTargets, takeEarlyChildHold } from "./subagent-child-hold.js";
import { describeLostSubagentChild } from "./subagent-child-lost.js";
import { type ChildOwnerAPI, subagentChildOwnerOperations } from "./subagent-child-owner.js";
import {
	bindSubagentChildHeldToolResults,
	clearSubagentChildHeldNotices,
	clearSubagentChildHeldToolResultsWhere,
	createSubagentChildRecordSink,
	findSubagentChildRecord,
	heldTaskExpands,
	heldToolResultCall,
	holdInterruptedStillRunningCalls,
	isRestorableSubagentChild,
	isSubagentChildRecord,
	readSubagentChildRecords,
	recordSubagentChildGone,
	SUBAGENT_CHILD_GONE_STATUS,
	SUBAGENT_CHILD_RELEASED_STATUS,
	type SubagentChildHeldToolResult,
	type SubagentChildLaunch,
	type SubagentChildRecord,
	type SubagentChildRecordSink,
	type SubagentChildStillRunningCall,
	type SubagentWakeHeldToolResult,
	sameHeldResult,
	subagentChildOwner,
	subagentChildRecordsAppended,
} from "./subagent-child-records.js";
import { readPreviousIntercomId, reopenChildSession } from "./subagent-child-session.js";
import { resolveSubagentExecutorRuntimeDeps } from "./subagent-executor-runtime.js";
import { notifyDetachedForegroundChildExit } from "./subagent-executor-status.js";
import type { ExecutorDeps } from "./subagent-executor-types.js";
import {
	type QueuedSubagentChildStart,
	runAgentTask,
	subagentChildClosed,
	subagentRunSchedule,
	takeStoppedQueuedSubagentChild,
} from "./task-execution.js";

/** Prompt a restored child receives after its own interrupted session is reopened (#3760). */
export const SUBAGENT_RESUME_CONTINUATION_PROMPT =
	"Atomic restarted while you were working, and your session has been restored. Continue where you left off. If the restart interrupted a command or step you were running, redo or continue that step as needed. If you believe you are finished with your original task, stop.";

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
	readonly signal?: AbortSignal;
	completion?: Promise<boolean>;
}

export {
	holdRunningSubagentChildren,
	releaseEarlyChildHolds,
	SUBAGENT_RELEASE_RESTORING_CHILD_EVENT,
	SUBAGENT_RESERVE_RESTORING_CHILD_EVENT,
	type SubagentReleaseRestoringChildRequest,
	type SubagentReserveRestoringChildRequest,
} from "./subagent-child-hold.js";

export type SubagentChildRestoreDeps = Pick<ExecutorDeps, "config" | "discoverAgents" | "runtime"> & {
	readonly pi: ChildOwnerAPI;
	/** The owner's own Intercom identity, which a relaunched child's bridge names as its supervisor. */
	readonly state?: Pick<ExecutorDeps["state"], "ownIntercomSession">;
};

/** How an explicit `subagent({ action: "resume" })` reopens a child, instead of session recovery after a restart. */
export interface SubagentChildResumeRequest {
	/** The prompt the reopened child runs next. */
	readonly prompt: string;
	/** Read with `prompt`, as the child's resume note, when it steers a turn the child had not finished. */
	readonly continuation?: string;
	/** The caller's message; a child stopped before it ever started gets it after its original task. */
	readonly message?: string;
	/** `prompt` only tells the child to continue (a resume without a message): it is the child's resume note. */
	readonly continuationOnly?: true;
	/** Additional resume messages batched with the first, in arrival order. */
	readonly followUps?: readonly string[];
	/** Results of the child's detached calls that arrived for it (#4326), in arrival order. */
	readonly toolResults?: readonly DetachedToolResult[];
	/** Only `toolResults` woke the child: nothing is prompted unless a result came too late for its call. */
	readonly promptless?: boolean;
	/**
	 * A wake: `prompt` is never read beside what the wake brings. Unless `promptless`, it starts the child's turn when
	 * nothing else the wake brings does (no turn it continues, no message held for the child, no late result), as that
	 * turn's own prompt: never queued behind a turn, and never handed back as a held message.
	 */
	readonly wakeFallback?: true;
	readonly redispatch?: true;
	/**
	 * Leave the wake's dispatcher slot while `wait` settles: a relaunch whose run has no free slot waits for one outside
	 * it, so other runs' wakes are not held behind it (#4856).
	 */
	readonly outsideWakeSlot?: (wait: Promise<void>) => Promise<void>;
}

export type SubagentChildRestoreOutcome =
	| {
			readonly kind: "restored";
			readonly record: SubagentChildRecord;
			readonly taskId: string;
			/** The child had not started and has no session: it started fresh on its launch, with its task. */
			readonly fresh?: true;
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
	readonly finished: Promise<void>;
	/** The Intercom id the child registered under before the restart; settles once its session is reopened. */
	readonly previousIntercomId: Promise<string | undefined>;
	/** Set once the restoration finished: the child was relaunched, or could not be. */
	settled?: SubagentChildRestoreOutcome;
	/** The Intercom id the child registered under before the restart, once known. */
	knownPreviousIntercomId?: string;
}

// The restore owns its entry until release. A reloaded session uses its existing owner and must join that same restore.
const ACTIVE_RESTORATIONS = Symbol.for("@bastani/subagents/active-restorations@1");
const processRestores = globalThis as { [ACTIVE_RESTORATIONS]?: Map<string, ActiveRestoration> };
const activeRestorations = processRestores[ACTIVE_RESTORATIONS] ?? new Map<string, ActiveRestoration>();
processRestores[ACTIVE_RESTORATIONS] = activeRestorations;

/**
 * A restoration of this child that has not relaunched it yet: it settles once the child runs again or could not be
 * restored, never later, so a caller does not wait for the run it starts (#5485). Undefined when none is under way.
 */
export function subagentChildRestoring(ownerSessionId: string, childId: string): Promise<void> | undefined {
	const active = activeRestorations.get(childHoldKey(ownerSessionId, childId));
	if (active === undefined || active.settled !== undefined) return undefined;
	return active.outcome.then(
		() => undefined,
		() => undefined,
	);
}
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

class RestoreAbortedError extends Error {
	constructor() {
		super("Session closed during subagent restoration");
		this.name = "AbortError";
	}
}

function sessionAbortSignal(ctx: ExtensionContext): AbortSignal | undefined {
	return ctx.getCurrentSessionSignal?.() ?? ctx.sessionSignal;
}

function isRestoreAborted(error: unknown, signal: AbortSignal | undefined): boolean {
	if (signal?.aborted) return true;
	if (error instanceof RestoreAbortedError) return true;
	if (isStaleExtensionContextError(error)) return true;
	return error instanceof Error && error.name === "AbortError";
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort: () => T): Promise<T> {
	if (signal === undefined) return promise;
	if (signal.aborted) {
		void promise.catch(() => undefined);
		return Promise.resolve(onAbort());
	}
	return new Promise<T>((resolve, reject) => {
		const handleAbort = () => resolve(onAbort());
		signal.addEventListener("abort", handleAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", handleAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", handleAbort);
				if (signal.aborted) resolve(onAbort());
				else reject(error);
			},
		);
	});
}

async function awaitIntercomPeer(
	events: IntercomEventBus,
	name: string,
	group: string | undefined,
	signal?: AbortSignal,
): Promise<boolean | undefined> {
	if (signal?.aborted) return false;
	const request: SubagentAwaitIntercomPeerRequest = {
		name,
		...(group ? { group } : {}),
		timeoutMs: SUBAGENT_INTERCOM_PEER_TIMEOUT_MS,
		...(signal === undefined ? {} : { signal }),
	};
	try {
		events.emit(SUBAGENT_AWAIT_INTERCOM_PEER_EVENT, request);
	} catch (error) {
		if (!isStaleExtensionContextError(error)) throw error;
		return undefined;
	}
	if (!request.completion) return undefined;
	return raceWithSignal(
		request.completion.catch(() => false),
		signal,
		() => false,
	);
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
function hasPartialHistory(sessionManager: SessionManager): boolean {
	if (typeof sessionManager.hasFullHistory === "function" && !sessionManager.hasFullHistory()) return true;
	if (typeof sessionManager.getHeldTail === "function" && sessionManager.getHeldTail().fromSeq > 1) return true;
	return false;
}

/** The position of the child's launch leaf in its session, for a session that knows its entries' positions. */
async function launchSeqOf(sessionManager: SessionManager, record: SubagentChildRecord): Promise<number | undefined> {
	return (
		record.launchLeafSeq ??
		(record.launchLeafId === null
			? 0
			: typeof record.launchLeafId === "string"
				? typeof sessionManager.findEntrySeq === "function"
					? await sessionManager.findEntrySeq(record.launchLeafId)
					: sessionManager.getEntrySeq(record.launchLeafId)
				: undefined)
	);
}

/** Where on `branch` the entries after the launch leaf begin; past its end when the branch does not hold that leaf. */
function launchIndexOf(branch: ReturnType<SessionManager["getBranch"]>, record: SubagentChildRecord): number {
	if (record.launchLeafId === undefined) return branch.length;
	if (record.launchLeafId === null) return 0;
	const index = branch.findIndex((entry) => entry.id === record.launchLeafId);
	return index === -1 ? branch.length : index + 1;
}

async function entriesAfterLaunch(
	sessionManager: SessionManager,
	branch: ReturnType<SessionManager["getBranch"]>,
	record: SubagentChildRecord,
): Promise<ReturnType<SessionManager["getBranch"]>> {
	const branchLaunchIndex =
		typeof record.launchLeafId === "string" ? branch.findIndex((entry) => entry.id === record.launchLeafId) : -1;
	const launchIndex = launchIndexOf(branch, record);
	if (typeof sessionManager.getEntrySeq === "function") {
		const launchSeq = await launchSeqOf(sessionManager, record);
		return launchSeq === undefined
			? branch.slice(launchIndex)
			: branch.filter((entry) => (sessionManager.getEntrySeq(entry.id) ?? 0) > launchSeq);
	}
	if (
		(record.launchLeafId === null && (record.launchLeafSeq === undefined || record.launchLeafSeq <= 0)) ||
		branchLaunchIndex !== -1
	) {
		return branch.slice(launchIndex);
	}
	const store = typeof sessionManager.findEntrySeq !== "function" ? sessionManager.getSessionStore?.() : undefined;
	const locate =
		typeof sessionManager.findEntrySeq === "function"
			? (id: string) => sessionManager.findEntrySeq(id)
			: store?.findEntrySeq
				? (id: string) => store.findEntrySeq!(sessionManager.getSessionId(), id)
				: undefined;
	if (locate) {
		const launchSeq =
			record.launchLeafSeq ??
			(record.launchLeafId === null
				? 0
				: typeof record.launchLeafId === "string"
					? await locate(record.launchLeafId)
					: undefined);
		if (launchSeq === undefined) return branch.slice(launchIndex);
		const branchSeqs = await Promise.all(branch.map((entry) => locate(entry.id)));
		if (branchSeqs.every((seq) => seq !== undefined)) {
			return branch.filter((_entry, index) => (branchSeqs[index] ?? 0) > launchSeq);
		}
	}
	if (hasPartialHistory(sessionManager)) return branch.slice(launchIndex);
	const entries = typeof sessionManager.getEntries === "function" ? sessionManager.getEntries() : [];
	const seqById = new Map<string, number>();
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry !== undefined) seqById.set(entry.id, index + 1);
	}
	const launchSeq =
		record.launchLeafSeq ?? (typeof record.launchLeafId === "string" ? seqById.get(record.launchLeafId) : undefined);
	if (launchSeq !== undefined && branch.every((entry) => seqById.has(entry.id))) {
		return branch.filter((entry) => (seqById.get(entry.id) ?? 0) > launchSeq);
	}
	if (entries.length === 0 && record.launchLeafId === undefined && record.launchLeafSeq !== undefined) {
		return branch.filter((_entry, index) => index + 1 > record.launchLeafSeq!);
	}
	return branch.slice(launchIndex);
}

/**
 * Whether the pause a record names still holds in the child's saved session: the session still holds the entry the
 * pause was taken at, and no user message reached the child after it. What its interrupted turn left (its answer, the
 * results of its stopped calls) and what a restore notes are not messages to it. A version that does not record pauses
 * leaves the record's pause behind when it continues the child; the message it continues it with ends the pause.
 *
 * A pause recorded without its entry, as builds before `pausedAtLeafId` recorded it, holds as those builds held it,
 * unless a user message reached the child after the record of that pause was saved (`recordedAt`, when it is known).
 */
function pauseStillHolds(
	branch: ReturnType<SessionManager["getBranch"]> | undefined,
	pausedAtLeafId: string | null | undefined,
	recordedAt?: number,
): boolean {
	if (branch === undefined) return false;
	if (pausedAtLeafId === undefined)
		return (
			recordedAt === undefined ||
			branch.every((entry) => !(isUserMessage(entry) && Date.parse(entry.timestamp) > recordedAt))
		);
	const pausedAt = pausedAtLeafId === null ? -1 : branch.findIndex((entry) => entry.id === pausedAtLeafId);
	if (pausedAtLeafId !== null && pausedAt === -1) return false;
	return branch.slice(pausedAt + 1).every((entry) => !isUserMessage(entry));
}

function isUserMessage(entry: ReturnType<SessionManager["getBranch"]>[number]): boolean {
	return entry.type === "message" && entry.message.role === "user";
}

/**
 * When the owner's session saved the record where child `childId`'s current pause began: the first of the records that
 * say it is paused since the last one that says otherwise. A version that writes whole merged records keeps saying
 * paused after it continued the child, so a later record does not date the pause; a record that says nothing of pauses
 * after them (an older writer's) does not end them either. `undefined` when the owner's session does not hold where
 * that run of records begins.
 */
function pauseRecordedAt(ctx: ExtensionContext, childId: string): number | undefined {
	const entries = ctx.sessionManager.getEntries();
	let began: (typeof entries)[number] | undefined;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== SUBAGENT_CHILD_RECORD_TYPE) continue;
		const data = entry.data as Partial<SubagentChildRecord> | undefined;
		if (data?.childId !== childId) continue;
		if (data.pausedByUser === true) began = entry;
		else if (began !== undefined) return recordTime(began);
		else if (data.pausedByUser === false) return undefined;
	}
	// The run reaches the oldest record the session holds: it began there only if the session holds its whole history.
	const wholeHistory = typeof ctx.sessionManager.hasFullHistory !== "function" || ctx.sessionManager.hasFullHistory();
	return began !== undefined && wholeHistory ? recordTime(began) : undefined;
}

function recordTime(entry: { readonly timestamp: string }): number | undefined {
	const at = Date.parse(entry.timestamp);
	return Number.isNaN(at) ? undefined : at;
}

const BUILTIN_DIAGNOSTIC_CONTEXT_KEY = Symbol.for("atomic.builtin-diagnostic-context.v1");
type BuiltinDiagnosticReporter = (diagnostic: Omit<HostDiagnostic, "sessionId">) => void;

type LegacyBranchSetting<T extends SessionEntry> = { readonly entry: T; readonly seq: number } | undefined;

function normalizeBranchSetting<T extends SessionEntry>(
	value: LatestBranchSetting<T> | LegacyBranchSetting<T>,
): LatestBranchSetting<T> {
	if (value === undefined) return { status: "none" };
	if ("status" in value) return value;
	return { status: "found", entry: value.entry, seq: value.seq };
}

function reportSettingsNotHeldDiagnostic(
	record: SubagentChildRecord,
	sessionManager: SessionManager,
	launchSeq: number,
	notHeldAxes: readonly ("model" | "thinking level")[],
): void {
	const message = `Restored subagent ${record.childId} could not confirm post-launch ${notHeldAxes.join(" and ")} changes from partial session history; keeping launch settings.`;
	const host = globalThis as typeof globalThis & {
		[BUILTIN_DIAGNOSTIC_CONTEXT_KEY]?: { getStore(): BuiltinDiagnosticReporter | undefined };
	};
	const report = host[BUILTIN_DIAGNOSTIC_CONTEXT_KEY]?.getStore();
	let delivered = false;
	if (report) {
		try {
			report({ level: "warning", source: "subagents", message });
			delivered = true;
		} catch {
			// A failing diagnostic listener must never abort subagent restoration.
		}
	}
	if (!delivered) console.warn(`atomic-subagents: ${message}`);
	void reportDebugAsync("storage", "subagent-restore-settings-not-held", {
		childId: record.childId,
		childSessionId: sessionManager.getSessionId(),
		launchSeq,
		axes: [...notHeldAxes],
	});
}

/**
 * The latest model and thinking level the child's own session changed to after its launch, each on its own. They are
 * read from memory, never from the session's saved history: a session that holds only part of its history still holds
 * the latest change of each on its branch when its resume retains it, which `getLatestBranchSettingsWithProvenance`
 * reports as `found | none | not-held` per axis. On `not-held`, the restore keeps the launch record's settings for
 * that axis and emits a diagnostic. Older sessions with only `getLatestBranchSettings` fall back to that method, and
 * external sessions without either (an SDK caller's) are searched from their launch on.
 */
async function settingsChangedSinceLaunch(
	sessionManager: SessionManager,
	record: SubagentChildRecord,
): Promise<{ readonly model?: string; readonly thinking?: string }> {
	let afterLaunch: ReturnType<SessionManager["getBranch"]>;
	const hasWithProvenance = typeof sessionManager.getLatestBranchSettingsWithProvenance === "function";
	const hasLegacy = typeof sessionManager.getLatestBranchSettings === "function";
	if ((hasWithProvenance || hasLegacy) && typeof sessionManager.getEntrySeq === "function") {
		const launchSeq = await launchSeqOf(sessionManager, record);
		if (launchSeq !== undefined) {
			const raw = hasWithProvenance
				? sessionManager.getLatestBranchSettingsWithProvenance(launchSeq)
				: sessionManager.getLatestBranchSettings(launchSeq);
			const model = normalizeBranchSetting(raw.model);
			const thinkingLevel = normalizeBranchSetting(raw.thinkingLevel);
			const notHeldAxes: ("model" | "thinking level")[] = [];
			if (model.status === "not-held") notHeldAxes.push("model");
			if (thinkingLevel.status === "not-held") notHeldAxes.push("thinking level");
			if (notHeldAxes.length > 0) {
				reportSettingsNotHeldDiagnostic(record, sessionManager, launchSeq, notHeldAxes);
			}
			return {
				...(model.status === "found" ? { model: `${model.entry.provider}/${model.entry.modelId}` } : {}),
				...(thinkingLevel.status === "found" ? { thinking: thinkingLevel.entry.thinkingLevel } : {}),
			};
		}
		const branch = sessionManager.getBranch();
		afterLaunch = branch.slice(launchIndexOf(branch, record));
	} else afterLaunch = await entriesAfterLaunch(sessionManager, sessionManager.getBranch(), record);
	let model: string | undefined;
	let thinking: string | undefined;
	for (const entry of afterLaunch) {
		if (entry.type === "model_change") model = `${entry.provider}/${entry.modelId}`;
		else if (entry.type === "thinking_level_change") thinking = entry.thinkingLevel;
	}
	return { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
}

async function ownSessionModelCandidate(
	sessionManager: SessionManager,
	record: SubagentChildRecord,
	resolveCandidateModel: ReturnType<typeof createCandidateModelResolver>,
): Promise<string | undefined> {
	const { model: changedModel, thinking: changedThinking } = await settingsChangedSinceLaunch(sessionManager, record);
	const context = sessionManager.buildSessionContext();
	const model =
		changedModel ??
		record.launchModel ??
		(context.model ? `${context.model.provider}/${context.model.modelId}` : undefined);
	if (!model) return undefined;
	const candidate = `${model}:${changedThinking ?? record.launchThinkingLevel ?? context.thinkingLevel}`;
	return resolveCandidateModel(candidate)?.model ? candidate : undefined;
}

/** What a restored child is prompted with: its task, then follow-ups delivered as written, and its resume note. */
interface ResumePrompts {
	readonly task: string;
	readonly followUps: readonly string[];
	/** The task is delivered as written rather than as a fresh launch's task. */
	readonly taskLiteral: boolean;
	/** Why it runs again, when Atomic says so rather than a message: read with its turn, never as a message. */
	readonly note?: SubagentResumeNote;
}

/**
 * What the reopened child is prompted with, in order: the messages it had queued and not read when it was stopped,
 * once, then the resume's own message. Atomic's own continuation (after a restart, a resume without a message, or the
 * continuation of an interrupted turn) is its resume note. A continuation an earlier version held as a message is not
 * repeated.
 */
function resumedPrompts(record: SubagentChildRecord, resume: SubagentChildResumeRequest | undefined): ResumePrompts {
	const prompt = resume?.prompt ?? SUBAGENT_RESUME_CONTINUATION_PROMPT;
	const recorded =
		record.heldMessages && record.heldMessages.taskId === record.taskId ? record.heldMessages : undefined;
	// A wake's prompt is never held now, so a held message with its text was sent to the child. One an earlier version
	// held, in a record that does not say so, is that version's own wake prompt: not read again.
	const heldAllSent = resume?.wakeFallback === true && recorded?.withoutWakePrompt === true;
	const continuations = new Set([
		SUBAGENT_RESUME_CONTINUATION_PROMPT,
		resume?.continuation,
		resume?.message || heldAllSent ? undefined : prompt,
	]);
	// Held messages written since continuations became notes are each a message the child was sent.
	const held = recorded
		? recorded.messages.filter((message) => recorded.withoutContinuations === true || !continuations.has(message))
		: [];
	// Only an original task the child never read keeps a fresh launch's handling; a held message it already received,
	// or the resume's own message, is delivered as written whether or not anything was held (#4027).
	const taskExpands =
		recorded !== undefined && heldTaskExpands(recorded) && held.length > 0 && held[0] === recorded.messages[0];
	const note: SubagentResumeNote | undefined =
		resume === undefined
			? { kind: "restart", text: SUBAGENT_RESUME_CONTINUATION_PROMPT }
			: resume.continuationOnly === true
				? { kind: "resume", text: prompt }
				: resume.continuation
					? { kind: "resume", text: resume.continuation }
					: undefined;
	// A wake's fallback prompt is not among them: the wake decides whether its note starts the turn.
	const promptIsNote = resume === undefined || resume.continuationOnly === true || resume.wakeFallback === true;
	const [task = "", ...followUps] = [...held, ...(promptIsNote ? [] : [prompt]), ...(resume?.followUps ?? [])];
	return { task, followUps, taskLiteral: !taskExpands, ...(note === undefined ? {} : { note }) };
}

/** Whether `prompts` give the child anything to read. */
function promptsAnything(prompts: ResumePrompts): boolean {
	return prompts.task !== "" || prompts.followUps.length > 0;
}

/**
 * What a child that never started is prompted with when it starts fresh: its original task, with the resume
 * message after it as its original launch would have had it, then any messages it was sent while it waited.
 */
function freshPrompts(
	record: SubagentChildRecord,
	launch: SubagentChildLaunch,
	resume: SubagentChildResumeRequest | undefined,
): ResumePrompts {
	const recorded =
		record.heldMessages && record.heldMessages.taskId === record.taskId ? record.heldMessages : undefined;
	const held = recorded?.messages ?? [];
	// A child stopped before it read its task holds that task first; its launch prompts it, so it is not sent twice.
	const heldTask = recorded !== undefined && held[0] === launch.task && heldTaskExpands(recorded);
	// The child never started: its task is prompted as its original launch would have prompted it.
	return {
		task: resume?.message ? `${launch.task}\n\n${resume.message}` : launch.task,
		followUps: heldTask ? held.slice(1) : held,
		taskLiteral: false,
	};
}

/**
 * The agent definition the child was launched with, looked up again by name. With the source its launch resolved,
 * the definition from that source, wherever the default scope would shadow it with another of the same name.
 */
async function rediscoverAgent(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	cwd: string,
	name: string,
	source: AgentSource | undefined,
): Promise<AgentConfig | undefined> {
	// A user or project agent of the same full name hides a package agent in every scope; look it up directly.
	if (source === "package")
		return (await discoverPackageAgents(contextAgentDiscoveryOptions(ctx))).find((agent) => agent.name === name);
	const scopes: readonly AgentScope[] = source ? ["both", "user", "project"] : [resolveExecutionAgentScope(undefined)];
	for (const scope of scopes) {
		const { agents } = await deps.discoverAgents(cwd, scope, contextAgentDiscoveryOptions(ctx));
		const agent = agents.find((candidate) => candidate.name === name && (!source || candidate.source === source));
		if (agent) return agent;
	}
	return undefined;
}

/**
 * The Intercom group the child's launch had. A record that says what the launch inherited names it exactly, none
 * included; an older one falls back to the group the owner is in now.
 */
function launchIntercomGroup(record: SubagentChildRecord, ctx: ExtensionContext): string | undefined {
	return record.inherited ? record.intercomGroup : (record.intercomGroup ?? inheritedIntercomGroup(ctx));
}

/** The restores recorded with the child's launch, leaving out anything a damaged record holds. */
function recordedWorktreeRootMappings(
	record: Pick<SubagentChildRecord, "worktreeRootMappings">,
): WorktreeRootMapping[] {
	const entries: readonly Partial<WorktreeRootMapping>[] = Array.isArray(record.worktreeRootMappings)
		? record.worktreeRootMappings
		: [];
	return entries.filter(
		(entry): entry is WorktreeRootMapping =>
			typeof entry?.from === "string" &&
			typeof entry.to === "string" &&
			typeof entry.snapshotId === "string" &&
			typeof entry.tree === "string" &&
			typeof entry.restoredAt === "string",
	);
}

/**
 * Where a child's reopened session continues, decided as a woken session's is (`rehydrate()`): each checkout it worked
 * in on this machine stays, and the others, as when it was woken on another machine, are restored from its snapshots
 * into worktrees of this machine first, setting them up as a resume does.
 */
async function continueChildWhereItWorked(
	ctx: ExtensionContext,
	launchCwd: string,
	opened: SessionManager,
): Promise<SessionManager> {
	const inherited = ctx.getChildSessionOptions?.({});
	const agentDir = inherited?.agentDir ?? getAgentDir();
	const settingsManager = inherited?.settingsManager ?? (await SettingsManager.createAsync(launchCwd, agentDir));
	return continueSessionWhereItWorked(opened, {
		...sessionResumeOptions(
			"rehydrate",
			launchCwd,
			agentDir,
			settingsManager,
			savedProjectTrustAsync(agentDir, settingsManager),
		),
		onNotices: (notices) => {
			for (const notice of notices) console.warn(`atomic-subagents: ${notice.message}`);
		},
	});
}

/**
 * The calls a woken child is told are still running once its wake is delivered (#5014): those it was told so before
 * whose results it has not received, and each pending call this wake answers "still running".
 */
/**
 * The results held for the child that a wake gives its run, each by the number it is held under and whether it is read
 * late. A result the wake reads for a call that another result of it already answers is let go with that one.
 */
function heldGiven(
	toolResults: readonly DetachedToolResult[],
	items: readonly { readonly held?: { readonly heldSeq?: number } }[],
	plan: ReleasedChildWakePlan,
	older: ReadonlyMap<DetachedToolResult, string>,
): SubagentWakeHeldToolResult[] {
	const late = new Map<string, boolean>();
	for (const result of plan.resumeToolResults) late.set(releasedWakeResultKey(result, older), false);
	for (const result of plan.lateResults) late.set(releasedWakeResultKey(result, older), true);
	return toolResults.flatMap((result, index) => {
		const held = items[index]?.held;
		const readLate = late.get(releasedWakeResultKey(result, older));
		if (held === undefined || readLate === undefined) return [];
		return [
			{
				toolCallId: result.toolCallId,
				...(held.heldSeq === undefined ? {} : { heldSeq: held.heldSeq }),
				late: readLate,
			},
		];
	});
}

function stillRunningAfterWake(
	record: SubagentChildRecord,
	delivered: readonly DetachedToolResult[],
	answers: readonly DetachedToolResult[],
	late: readonly DetachedToolResult[],
	/** The entry of the call a result is for, where the wake knows it. */
	callOf: (result: DetachedToolResult) => string | undefined,
): SubagentChildStillRunningCall[] {
	// Each answer and each late result is one call's: it stops tracking that call, by its entry where both name it, else
	// one call with its id, the earliest; never every call a provider gave that id (#3274).
	const ending = [...answers, ...late].map((result) => ({ toolCallId: result.toolCallId, call: callOf(result) }));
	const kept = (record.stillRunning ?? []).filter((tracked) => {
		const index = ending.findIndex((end) =>
			tracked.callEntryId !== undefined && end.call !== undefined
				? end.call === tracked.callEntryId
				: end.toolCallId === tracked.toolCallId,
		);
		if (index < 0) return true;
		ending.splice(index, 1);
		return false;
	});
	// A result read in the same wake for an older call with the same id does not answer the pending one (#3274).
	const told = answers
		.filter((answer) => !delivered.includes(answer) && !answer.isError)
		.map((answer) => {
			const callEntryId = callOf(answer);
			return {
				toolCallId: answer.toolCallId,
				toolName: answer.toolName,
				ownerGeneration: SUBAGENT_OWNER_GENERATION,
				...(callEntryId === undefined ? {} : { callEntryId }),
			};
		});
	return [...kept, ...told];
}

/**
 * The run's scheduler, for a wake that holds a dispatcher slot: a dispatch the run starts at once keeps that slot; one
 * queued behind the run's limit leaves it while it waits and takes it back, in turn, before it starts (#4856).
 */
function waitingOutsideWakeSlot(
	schedule: ExecutionScheduler,
	outsideWakeSlot: (wait: Promise<void>) => Promise<void>,
): ExecutionScheduler {
	const gated = (dispatch: () => Promise<void>): void => {
		const granted = Promise.withResolvers<void>();
		let started = false;
		let slotBack: Promise<void> | undefined;
		schedule(async () => {
			started = true;
			granted.resolve();
			if (slotBack !== undefined) await slotBack;
			await dispatch();
		});
		// A run with a free slot started it synchronously, and the wake's slot stays with it.
		if (!started) slotBack = outsideWakeSlot(granted.promise);
	};
	return schedule.limit === undefined ? gated : Object.assign(gated, { limit: schedule.limit });
}

async function relaunchChild(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	record: SubagentChildRecord,
	hold: ChildTargetHold | undefined,
	release: () => void,
	onReopened: (previousIntercomId: string | undefined) => void,
	resume: SubagentChildResumeRequest | undefined,
	refuseRelaunch: (() => SubagentChildRecord | undefined) | undefined,
): Promise<SubagentChildRestoreOutcome> {
	const unrestorable = (reason: string): SubagentChildRestoreOutcome => ({
		kind: "unrestorable",
		childId: record.childId,
		record,
		reason,
	});
	await subagentChildClosed(record.runId, record.index);
	const host = ctx.getAgentTaskHost?.();
	const queued = record.taskId && host ? takeStoppedQueuedSubagentChild(record.taskId) : undefined;
	if (queued && host)
		return startedFresh(await startQueuedChild(deps, ctx, host, record, queued, hold, release, resume));
	const queuedOwnerless = record.taskId && !host ? takeStoppedQueuedOwnerlessChild(record.taskId) : undefined;
	// Without a task host nothing else stops the resumed child with its owner: closing the session stops it, restorably.
	const ownerSignal = host ? undefined : (ctx.getCurrentSessionSignal?.() ?? ctx.sessionSignal);
	if (queuedOwnerless) {
		const supervisorAuthorization = record.intercomTarget ? hold?.authorization : undefined;
		if (!supervisorAuthorization) await hold?.release();
		const recordChild = createSubagentChildRecordSink(deps.pi, ctx);
		const intercomGroup = launchIntercomGroup(record, ctx);
		const launched = queuedOwnerless({
			recordChild,
			...(ownerSignal ? { ownerSignal } : {}),
			...(resume?.message ? { message: resume.message } : {}),
			...(supervisorAuthorization ? { supervisorAuthorization } : {}),
		});
		return startedFresh(
			await ownerlessRelaunched(
				deps,
				record,
				launched,
				recordChild,
				release,
				hold,
				supervisorAuthorization,
				intercomGroup,
			),
		);
	}
	// A child that never started has no session to reopen; its records say how its launch starts it fresh.
	const fresh =
		record.childSessionId === undefined && record.childSessionFile === undefined ? record.launch : undefined;
	// Where the child worked, after the restores of the session it belongs to: on another machine its own directory may
	// be gone, and the worktree that was restored for that directory is where it continues.
	const scope = currentWorktreeRootMappings();
	let cwd = await mapRestoredPathAsync(record.cwd, scope);
	let cwdVerdict: CwdVerdict;
	let sessionManager: SessionManager | undefined;
	/** The child's session as it was saved, before restoring it changes anything: where a recorded pause is checked. */
	let savedBranch: ReturnType<SessionManager["getBranch"]> | undefined;
	if (fresh) {
		cwdVerdict = await checkLaunchCwd(cwd);
		if (cwdVerdict.state === "missing") return unrestorable(`its working directory no longer exists: ${cwd}`);
		// A forked launch starts on the branch it prepared from its owner's conversation, never on a fresh context.
		if (fresh.forkSession) {
			const branch = await reopenChildSession(ctx, {
				cwd,
				childSessionId: fresh.forkSession.id,
				...(fresh.forkSession.file ? { childSessionFile: fresh.forkSession.file } : {}),
			});
			if ("reason" in branch)
				return unrestorable(
					`the session forked from its parent's conversation for it could not be reopened: ${branch.reason}`,
				);
			sessionManager = branch.sessionManager;
		}
		onReopened(undefined);
	} else {
		const reopened = await reopenChildSession(ctx, { ...record, cwd });
		if ("reason" in reopened) return unrestorable(reopened.reason);
		savedBranch = reopened.sessionManager.getBranch();
		sessionManager = await continueChildWhereItWorked(ctx, cwd, reopened.sessionManager);
		cwd = await mapRestoredPathAsync(sessionManager.getCwd(), scope);
		cwdVerdict = await checkLaunchCwd(cwd);
		if (cwdVerdict.state === "missing") return unrestorable(`its working directory no longer exists: ${cwd}`);
		const previousIntercomId = readPreviousIntercomId(sessionManager);
		onReopened(previousIntercomId);
		if (previousIntercomId) await hold?.add(previousIntercomId);
	}
	const discovered = await rediscoverAgent(deps, ctx, cwd, record.agent, record.agentSource);
	if (!discovered)
		return unrestorable(
			`agent "${record.agent}"${record.agentSource ? ` (${record.agentSource})` : ""} is no longer defined`,
		);
	const bridge = record.orchestratorTarget
		? await resolveIntercomBridge({
				config: deps.config.intercomBridge,
				context: record.forked ? "fork" : "fresh",
				orchestratorTarget: resolveIntercomSessionTarget(
					deps.pi.getSessionName(),
					ctx.sessionManager.getSessionId(),
					ownIntercomSessionId(deps.state ?? {}, ctx.sessionManager),
				),
				cwd,
			})
		: undefined;
	const agent = bridge?.active ? applyIntercomBridgeToAgent(discovered, bridge) : discovered;
	// The owner as it was when it admitted the child, not as it is now (#3784); an older record has only the latter.
	const inherited = record.inherited ?? {
		...(ctx.model ? { model: currentModelFullId(ctx.model), modelProvider: ctx.model.provider } : {}),
		...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
	};
	const resolveCandidateModel = createCandidateModelResolver(ctx.modelRegistry, inherited.modelProvider);

	const ownModel = fresh
		? fresh.modelOverride && resolveCandidateModel(fresh.modelOverride)?.model
			? fresh.modelOverride
			: undefined
		: sessionManager
			? await ownSessionModelCandidate(sessionManager, record, resolveCandidateModel)
			: undefined;
	// A model it inherited that is no longer usable is dropped, as an unusable model of its own is. It never takes the
	// owner's new model instead: a child that would have run on the inherited model cannot continue.
	const inheritedModel =
		inherited.model && (!record.inherited || resolveCandidateModel(inherited.model)?.model)
			? inherited.model
			: undefined;
	if (
		inherited.model &&
		!inheritedModel &&
		!ownModel &&
		!record.namedModel &&
		!agent.model &&
		!agent.fallbackModels?.length
	)
		return unrestorable(
			`the model it inherited from its parent when it was launched, ${inherited.model}, is no longer available`,
		);
	// Calls an earlier owner process told it are still running died with that process: held as interrupted (#5014).
	if (record.stillRunning?.some((call) => call.ownerGeneration !== SUBAGENT_OWNER_GENERATION))
		await holdInterruptedStillRunningCalls(
			deps.pi,
			record.owner.sessionId,
			record.childId,
			SUBAGENT_OWNER_GENERATION,
			interruptedStillRunningResult,
		);
	// Read again: the owner's wakes may have held them first, after `record` was read. `record` when it cannot be read.
	const latest = readableSubagentChildRecordOf(record.owner.sessionId, record.childId) ?? record;
	// What its transcript already holds was delivered: a run that saved it stopped before it reported it (#5012). Also
	// when a compaction since took it out of the transcript's context.
	// The wake carries what the record held and what arrived with it, which the wake held first.
	const heldItems = latest.heldToolResults ?? [];
	const arrivedItems = (resume?.toolResults ?? []).filter(
		(result) => !heldItems.some((held) => sameHeldResult(latest, held, result)),
	);
	const readBackItems: ReadBackToolResult[] = [
		...heldItems.map((held) => {
			const call = heldToolResultCall(latest, held);
			return call === undefined ? held : { ...held, callEntryId: call };
		}),
		...arrivedItems,
	];
	const readBack = sessionManager && !fresh ? await readHeldToolResultsBack(sessionManager, readBackItems) : undefined;
	// The calls its transcript ends on, and the entry that issued each: a call told it is still running is tracked by that
	// entry, apart from another call a provider gave its id (#3274).
	const transcriptPending =
		sessionManager &&
		!fresh &&
		resume?.redispatch !== true &&
		(record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS ||
			(record.waitingOn?.length ?? 0) > 0 ||
			readBackItems.length > 0)
			? pendingToolCalls(sessionManager)
			: undefined;
	const pendingCallEntries =
		sessionManager && transcriptPending !== undefined && transcriptPending.size > 0
			? await issuingCallEntries(sessionManager, [...transcriptPending.keys()])
			: new Map<string, string>();
	const readOf = (index: number) => readBack?.results[index];
	const savedHeld = heldItems.filter((_, index) => readOf(index)?.saved === true);
	await clearSubagentChildHeldToolResultsWhere(
		deps.pi,
		record.owner.sessionId,
		record.childId,
		(held, current) => savedHeld.some((saved) => sameHeldResult(current, saved, held)),
		readBack?.saved ?? [],
	);
	// The others are bound to the calls the read-back found for them before a run is given them (below): a run that saves
	// one and stops before the owner lets it go leaves it found saved by the next read-back, also past a newer call a
	// provider gave the same id; and a result for that newer call is held beside it (#3274).
	const bindings = new Map<number, string>();
	heldItems.forEach((held, index) => {
		const found = readOf(index);
		if (held.heldSeq !== undefined && found?.saved === false && found.call !== undefined)
			bindings.set(held.heldSeq, found.call);
	});
	// So were the notices of finished background tasks held for it that its transcript already holds.
	const heldNotices = latest.heldNotices ?? [];
	const savedNotices = sessionManager && !fresh ? savedNoticeIds(sessionManager, heldNotices) : [];
	if (savedNotices.length > 0)
		await clearSubagentChildHeldNotices(deps.pi, record.owner.sessionId, record.childId, savedNotices);
	const childOptions = ctx.getChildSessionOptions?.({ tools: agent.tools });
	const redispatch = resume?.redispatch === true && !fresh && sessionManager !== undefined;
	const supervisorAuthorization =
		redispatch || (childOptions && !childAllowsIntercom(childOptions)) ? undefined : hold?.authorization;
	// A child that will not use Intercom never registers, so nothing it could be sent should wait for it.
	if (!supervisorAuthorization) await hold?.release();
	// The last check before it runs again, with nothing awaited after it: a wake whose child was paused or quit meanwhile
	// relaunches nothing, and the results it carries stay held for the child's resume (#4845).
	const declined = refuseRelaunch?.();
	if (declined !== undefined) {
		await hold?.release();
		return { kind: "terminal", record: declined };
	}
	const intercomGroup = launchIntercomGroup(record, ctx);
	// A released child, or one results are held for, continues the turn it was waiting in before anything else (#4326).
	const unsavedItems = readBackItems.flatMap((item, index) => {
		const {
			callEntryId: _bound,
			heldSeq: _seq,
			...result
		} = item as ReadBackToolResult & SubagentChildHeldToolResult;
		const seq = index < heldItems.length ? { heldSeq: (item as SubagentChildHeldToolResult).heldSeq } : undefined;
		return readOf(index)?.saved === true ? [] : [{ result, read: readOf(index), held: seq }];
	});
	const heldResults: DetachedToolResult[] = unsavedItems.map(({ result }) => result);
	const toolResults = sessionManager
		? formatReleasedReplyResults(sessionManager, heldResults, deps.pi.events)
		: heldResults;
	// Each as the read-back found it: a result bound to an older call than the newest with its id is never that call's.
	const readOfResult = new Map(toolResults.map((result, index) => [result, unsavedItems[index]?.read]));
	const older = new Map(
		toolResults.flatMap((result) => {
			const read = readOfResult.get(result);
			return read?.older === true && read.call !== undefined ? [[result, read.call] as const] : [];
		}),
	);
	// Session recovery of a child the user had paused: it comes back paused, prompted with nothing, as it was.
	const restoredPaused =
		resume === undefined &&
		!fresh &&
		sessionManager !== undefined &&
		latest.pausedByUser === true &&
		pauseStillHolds(
			savedBranch,
			latest.pausedAtLeafId,
			latest.pausedAtLeafId === undefined ? pauseRecordedAt(ctx, record.childId) : undefined,
		);
	// The calls a woken child's transcript waits on: a released child, one waiting on a call, or one results are held for.
	const pending =
		!redispatch &&
		!restoredPaused &&
		!fresh &&
		sessionManager &&
		(record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS ||
			(record.waitingOn?.length ?? 0) > 0 ||
			toolResults.length > 0)
			? transcriptPending
			: undefined;
	// A late result an earlier build held for the child as a message is read in its notice now, so that copy is not.
	const heldRecord =
		pending === undefined
			? record
			: withoutLegacyLateMessages(
					record,
					toolResults.filter((result) => !pending.has(result.toolCallId)),
				);
	const heldMessages =
		heldRecord.heldMessages && heldRecord.heldMessages.taskId === heldRecord.taskId
			? heldRecord.heldMessages.messages
			: [];
	const basePrompts = fresh ? freshPrompts(record, fresh, resume) : resumedPrompts(heldRecord, resume);
	// A wake's fallback prompt is not input of its own: such a wake is promptless unless it brings messages to read.
	const wakeFallback = resume?.wakeFallback === true && !fresh;
	const promptless = wakeFallback
		? !promptsAnything(basePrompts)
		: resume?.promptless === true && heldMessages.length === 0;
	const wakePlan =
		pending === undefined
			? undefined
			: planReleasedChildWake(pending, toolResults, !promptless, interruptedByRestart(record), older);
	// Each reaches it as the notice a running child gets, with its next turn, once. A paused child keeps them held.
	const notices =
		!redispatch && !restoredPaused && !fresh && sessionManager
			? heldNotices.filter((notice) => !savedNotices.includes(notice.details.completionId))
			: [];
	const wokenPrompts = redispatch
		? { task: resume?.prompt ?? SUBAGENT_RESUME_CONTINUATION_PROMPT, followUps: heldMessages, taskLiteral: true }
		: basePrompts;
	// The wake's own prompt starts the child only when nothing else does: no turn continues, no late result starts one
	// and nothing is to be read. It is never queued behind the continued turn as a follow-up the child would take a turn
	// for (an extra request).
	const fallback =
		wakeFallback &&
		resume?.promptless !== true &&
		!redispatch &&
		(wakePlan?.resumeToolResults.length ?? 0) === 0 &&
		(wakePlan?.lateResults.length ?? 0) === 0 &&
		notices.length === 0 &&
		!promptsAnything(wokenPrompts) &&
		resume !== undefined;
	const prompts: ResumePrompts = fallback
		? { task: "", followUps: [], taskLiteral: true, note: { kind: "wake", text: resume.prompt } }
		: wokenPrompts;
	// A wake by results alone of a child that finished on its own, all of them already in its transcript, leaves it
	// nothing to continue, read or answer: it is not run again. One with a notice it has not read yet is, to read it.
	if (
		resume?.wakeFallback === true &&
		resume.promptless === true &&
		latest.terminalStatus !== SUBAGENT_CHILD_RELEASED_STATUS &&
		!redispatch &&
		!fresh &&
		sessionManager !== undefined &&
		(wakePlan?.resumeToolResults.length ?? 0) === 0 &&
		(wakePlan?.lateResults.length ?? 0) === 0 &&
		notices.length === 0 &&
		!fallback &&
		!promptsAnything(prompts) &&
		unreadNotices(sessionManager).length === 0
	) {
		await hold?.release();
		return { kind: "terminal", record: latest };
	}
	// Bound only for a run given them, just before it is: a wake that relaunches nothing, or a paused child restored with
	// nothing to read, writes no binding.
	if (wakePlan !== undefined && bindings.size > 0) {
		await bindSubagentChildHeldToolResults(deps.pi, record.owner.sessionId, record.childId, bindings);
		// The last check again, with nothing awaited after it (#4845).
		const stopped = refuseRelaunch?.();
		if (stopped !== undefined) {
			await hold?.release();
			return { kind: "terminal", record: stopped };
		}
	}
	// Redispatched calls start the child; their task is never prompted, so it is only a fallback.
	const taskFallback = redispatch && wakeFallback;
	// A fresh child its launch created in its owner's store starts there, while the owner's store is not files.
	const sessionStore = fresh?.ownerStore && !sessionManager ? childSessionStore(ctx.sessionManager) : undefined;
	const options: RunSyncOptions = {
		runningCapacity: deps.config.parallel?.runningCapacity,
		sessionStartTimeoutMs: deps.config.sessionStartTimeoutMs,
		// A retried start of the relaunched child holds sends to it again, until the retry registers.
		onStartRetry: () => hold?.holdWhileStarting(subagentStartHoldMs(deps.config.sessionStartTimeoutMs)),
		getChildSessionOptions: ctx.getChildSessionOptionsResolver?.() ?? ctx.getChildSessionOptions,
		resourceLoaderInheritanceSnapshot: deps.pi.getResourceLoaderInheritanceSnapshot?.(),
		cwd: cwd,
		cwdVerdict,
		runId: record.runId,
		index: record.index,
		// Only a child that creates a session file of its own needs a directory: one reopened, or created in its owner's
		// store, needs none.
		...(sessionManager
			? { ...(sessionManager.getSessionDir() ? { sessionDir: sessionManager.getSessionDir() } : {}) }
			: sessionStore
				? {}
				: { sessionDir: fresh?.sessionDir || (await mkdtemp(join(tmpdir(), "atomic-subagent-restore-"))) }),
		...(sessionStore ? { sessionStore } : {}),
		...(sessionManager ? { sessionManager, ...(fresh ? {} : { resumeSession: true }) } : {}),
		...(fresh?.skills ? { skills: [...fresh.skills] } : {}),
		...(fresh?.outputPath ? { outputPath: fresh.outputPath } : {}),
		...(fresh?.outputMode ? { outputMode: fresh.outputMode } : {}),
		...(fresh?.maxOutput ? { maxOutput: fresh.maxOutput } : {}),
		...(fresh?.share === undefined ? {} : { share: fresh.share }),
		...(prompts.followUps.length > 0 && !restoredPaused ? { resumeFollowUps: prompts.followUps } : {}),
		...(prompts.taskLiteral ? { resumeTaskLiteral: true } : {}),
		// A pause its record still names but that no longer holds is cleared, so the record says what the child is.
		...(restoredPaused ? { resumePaused: true } : latest.pausedByUser === true ? { resumePaused: false } : {}),
		// Present, even empty, whenever the wake took the results its record held: they are cleared once delivered.
		...(wakePlan
			? {
					resumeToolResults: wakePlan.resumeToolResults,
					...(wakePlan.lateResults.length > 0
						? {
								resumeLateToolResults: wakePlan.lateResults,
								// Where their calls are, as the read-back above found them: the run does not read back again.
								...(readBack
									? {
											resumeLateToolResultCalls: wakePlan.lateResults.map(
												(result) => readOfResult.get(result)?.call,
											),
										}
									: {}),
							}
						: {}),
					wakeToolResultIds: toolResults.map((result) => result.toolCallId),
					// The held results it gives the run, by number: only those are let go once saved (#3274).
					wakeHeldToolResults: heldGiven(toolResults, unsavedItems, wakePlan, older),
					stillRunning: stillRunningAfterWake(
						latest,
						toolResults,
						wakePlan.resumeToolResults,
						wakePlan.lateResults,
						(result) =>
							readOfResult.get(result)?.call ??
							(wakePlan.lateResults.includes(result) ? undefined : pendingCallEntries.get(result.toolCallId)),
					),
				}
			: {}),
		...(notices.length > 0 ? { resumeNotices: notices } : {}),
		// An empty prompt is never sent: what it has to read, a notice its reopened session replays included, starts its turn.
		...(wakePlan?.skipPrompt || !promptsAnything(prompts) ? { skipTaskPrompt: true } : {}),
		// Its note says why it runs again; a paused child is told nothing until the user continues it.
		...(prompts.note !== undefined && !restoredPaused && !redispatch ? { resumeNote: prompts.note } : {}),
		...(taskFallback ? { resumeTaskFallback: true } : {}),
		...(redispatch ? { redispatchDetachedCalls: true } : {}),
		intercomEvents: deps.pi.events,
		parentDepth: getCurrentSubagentDepth(ctx),
		...(record.intercomTarget ? { intercomSessionName: record.intercomTarget } : {}),
		...(supervisorAuthorization ? { supervisorAuthorization } : {}),
		...(bridge?.active && bridge.orchestratorTarget && !redispatch
			? { orchestratorIntercomTarget: bridge.orchestratorTarget }
			: {}),
		...(intercomGroup ? { intercomGroup } : {}),
		availableModels: ctx.modelRegistry.getAvailable().map(toModelInfo),
		knownModelProviders: collectKnownModelProviders(ctx.modelRegistry),
		resolveCandidateModel,
		...(inherited.modelProvider ? { preferredModelProvider: inherited.modelProvider } : {}),
		// A launch that named its model keeps to that model and its own chain: when the model it continues on is gone, it
		// asks for the named one again, which fails clearly when that is gone too. One that ran its parent's keeps the
		// parent's (#4188). Either keeps the model its original launch asked for.
		...((ownModel ?? record.namedModel) ? { modelOverride: ownModel ?? record.namedModel } : {}),
		...(record.namedModel === undefined ? { runsNamedModel: false as const } : {}),
		...(record.requestedModel ? { requestedModel: record.requestedModel } : {}),
		...(inheritedModel ? { currentModel: inheritedModel } : {}),
		...(inherited.thinkingLevel ? { currentThinkingLevel: inherited.thinkingLevel } : {}),
	};
	const recordChild = createSubagentChildRecordSink(deps.pi, ctx);
	const runtime = resolveSubagentExecutorRuntimeDeps(deps.runtime);
	// It waits for a slot in its run, as its original launch did: its own scheduler, a sibling's (#4856), or, with no
	// child of the run holding one here, a new one under the run's recorded limit. The relaunch registers what it uses
	// before anything else runs, so a sibling woken after it shares that one.
	const runSchedule =
		subagentRunSchedule(record.runId) ??
		(record.runConcurrency === undefined ? undefined : createExecutionScheduler(record.runConcurrency));
	const schedule =
		runSchedule && resume?.outsideWakeSlot
			? waitingOutsideWakeSlot(runSchedule, resume.outsideWakeSlot)
			: runSchedule;
	const sessionSignal = sessionAbortSignal(ctx);
	if (sessionSignal?.aborted) throw new RestoreAbortedError();
	if (!host) {
		// #3981: a queued child starts after its launch; by then model fallback can have retired the launching session, whose
		// context throws on every read. The working directory is fixed at launch.
		const launchCwd = ctx.cwd;
		// No task host (an SDK session): it runs in the background directly, recorded like a task-host launch.
		const launched = runOwnerlessChild({
			agent: agent.name,
			agentSource: agent.source,
			forked: record.forked === true,
			task: prompts.task,
			cwd: cwd,
			options,
			...(ownerSignal ? { ownerSignal } : {}),
			recordChild,
			...(schedule ? { schedule } : {}),
			runSync: (task, childOptions) => runtime.runSync(launchCwd, [agent], agent.name, task, childOptions),
		});
		const outcome = await ownerlessRelaunched(
			deps,
			record,
			launched,
			recordChild,
			release,
			hold,
			supervisorAuthorization,
			intercomGroup,
			sessionSignal,
		);
		return fresh ? startedFresh(outcome) : outcome;
	}
	const childFailed = new AbortController();
	const peerWaitSignal = sessionSignal ? AbortSignal.any([sessionSignal, childFailed.signal]) : childFailed.signal;
	const response = await runAgentTask({
		host,
		cwd: ctx.cwd,
		agents: [agent],
		agent: agent.name,
		task: prompts.task,
		// A wake keeps the child's label: its prompt is no task the user gave it. A resume shows the message it brings.
		...(fresh
			? fresh.intentTask === undefined
				? {}
				: { intentTask: fresh.intentTask }
			: resume?.wakeFallback === true || prompts.task === ""
				? { intentTask: resumedTaskLabel(record) }
				: {}),
		...(resume || fresh ? { operation: `${record.runId}:${record.index}:resume:${randomUUID()}` } : {}),
		options,
		runtime,
		recordChild,
		forked: record.forked === true,
		...(record.heartbeatMs === undefined ? {} : { heartbeatMs: record.heartbeatMs }),
		...(schedule ? { schedule } : {}),
		onTerminal: (child) => {
			if (child.status === "error" || child.interrupted) childFailed.abort();
			release();
			// Normally the child consumed the hold when it registered; one that never did must not keep it, and tells the
			// senders still held why when its start failed.
			void hold?.release(startFailureRefusal(record.intercomTarget, child));
		},
		// However it ends, also failed or stopped before it started: the restoration is over. A stopped one keeps its hold,
		// so what is sent to it meanwhile waits for it to start.
		onEnded: () => {
			childFailed.abort();
			release();
		},
	});
	const outcome = await relaunched(
		deps,
		record,
		response,
		recordChild,
		release,
		supervisorAuthorization,
		intercomGroup,
		sessionSignal,
		peerWaitSignal,
	);
	return fresh ? startedFresh(outcome) : outcome;
}

/**
 * What a woken child's task is labelled with: its launch's task, never the wake prompt or result it continues with.
 * Its launch's label as the record keeps it; a record written before Atomic kept that has the task's one-line
 * summary; failing both, its agent's name.
 */
function resumedTaskLabel(record: SubagentChildRecord): string {
	return record.title || record.launch?.intentTask || record.launch?.task || record.task || record.agent;
}

/** A restored child that had no session started fresh on its launch rather than resuming one. */
function startedFresh(outcome: SubagentChildRestoreOutcome): SubagentChildRestoreOutcome {
	return outcome.kind === "restored" ? { ...outcome, fresh: true } : outcome;
}

/** What senders still held for a relaunched child are told when its start failed; undefined routes them normally. */
function startFailureRefusal(
	intercomTarget: string | undefined,
	child: { readonly status: string; readonly error?: string },
): string | undefined {
	const reason = child.status === "error" ? child.error?.trim() : undefined;
	return reason && intercomTarget
		? `Subagent \`${intercomTarget}\` did not start: ${reason} The message was not sent.`
		: undefined;
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
	const sessionSignal = sessionAbortSignal(ctx);
	if (sessionSignal?.aborted) throw new RestoreAbortedError();
	const supervisorAuthorization = queued.usesIntercom ? hold?.authorization : undefined;
	if (!supervisorAuthorization) await hold?.release();
	const recordChild = createSubagentChildRecordSink(deps.pi, ctx);
	const intercomGroup = launchIntercomGroup(record, ctx);
	const childFailed = new AbortController();
	const peerWaitSignal = sessionSignal ? AbortSignal.any([sessionSignal, childFailed.signal]) : childFailed.signal;
	const response = await queued.start({
		host,
		recordChild,
		...(resume?.message ? { message: resume.message } : {}),
		...(supervisorAuthorization ? { supervisorAuthorization } : {}),
		onTerminal: () => {
			childFailed.abort();
			release();
			void hold?.release();
		},
		onEnded: () => {
			childFailed.abort();
			release();
		},
	});
	return relaunched(
		deps,
		record,
		response,
		recordChild,
		release,
		supervisorAuthorization,
		intercomGroup,
		sessionSignal,
		peerWaitSignal,
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
	intercomGroup: string | undefined,
	sessionSignal?: AbortSignal,
): Promise<SubagentChildRestoreOutcome> {
	const childEnded = new AbortController();
	const peerWaitSignal = sessionSignal ? AbortSignal.any([sessionSignal, childEnded.signal]) : childEnded.signal;
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
		// A report that fails ends nothing else.
		.catch(() => {})
		// Normally the child consumed the hold when it registered; one that never did must not keep it.
		.finally(() => void hold?.release());
	// The restoration is over once the launch ended, however it ends, also stopped before it started, which its result
	// reports only once its run's slot frees. A result handed off while the launch still runs is no end of it.
	void Promise.race([
		launched.ended,
		launched.result.then(
			(child) => (child.detached ? launched.ended : undefined),
			() => undefined,
		),
	]).then(() => {
		childEnded.abort();
		release();
	});
	// Pause or quit right after this returns must find the child under its new launch id.
	await raceWithSignal(recordChild.flushed?.() ?? Promise.resolve(), sessionSignal, () => undefined);
	if (sessionSignal?.aborted) {
		release();
		throw new RestoreAbortedError();
	}
	const intercomLive =
		record.intercomTarget && supervisorAuthorization
			? await awaitIntercomPeer(deps.pi.events, record.intercomTarget, intercomGroup, peerWaitSignal)
			: undefined;
	if (sessionSignal?.aborted) {
		release();
		throw new RestoreAbortedError();
	}
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
	sessionSignal?: AbortSignal,
	peerWaitSignal?: AbortSignal,
): Promise<SubagentChildRestoreOutcome> {
	if (sessionSignal?.aborted) {
		release();
		throw new RestoreAbortedError();
	}
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
	await raceWithSignal(recordChild.flushed?.() ?? Promise.resolve(), sessionSignal, () => undefined);
	if (sessionSignal?.aborted) {
		release();
		throw new RestoreAbortedError();
	}
	const intercomLive =
		record.intercomTarget && supervisorAuthorization
			? await awaitIntercomPeer(
					deps.pi.events,
					record.intercomTarget,
					intercomGroup,
					peerWaitSignal ?? sessionSignal,
				)
			: undefined;
	if (sessionSignal?.aborted) {
		release();
		throw new RestoreAbortedError();
	}
	return { kind: "restored", record, taskId: response.observation.taskId, intercomLive };
}

/**
 * Restore one background child this session launched: reopen the child's own session,
 * relaunch it in the background with a continuation prompt, and re-register it with
 * Intercom under its original name and group with a fresh supervisor capability (#3760).
 * Accepts the child id (`<runId>:<index>`), its launch task id, or its Intercom name.
 * Records that a fork copied from another session name that session as their owner, so they are never restored here.
 * With `resume`, an explicit `subagent({ action: "resume" })` reopens a settled child the same way; the caller
 * decides which settled children are resumable. A failure that passes (`isRetryableStorageError`) rejects with that
 * failure and leaves the child as it was, never gone. `refuseRelaunch`, checked last before the child runs again,
 * returns the child's latest record when it must not run after all; the outcome is then `terminal` with that record.
 */
export async function restoreSubagentChild(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	id: string,
	resume?: SubagentChildResumeRequest,
	refuseRelaunch?: () => SubagentChildRecord | undefined,
): Promise<SubagentChildRestoreOutcome> {
	const owner = subagentChildOwnerOperations(deps.pi, ctx);
	deps = { ...deps, pi: owner.pi };
	ctx = owner.ctx;
	const signal = sessionAbortSignal(ctx);
	if (signal?.aborted) throw new RestoreAbortedError();
	const ownerSessionId = subagentChildOwner(ctx).sessionId;
	indexSubagentChildOwner(ctx);
	// The owner's own session when the index's latest record is in a copy of it that is no longer open. A child whose
	// records left the owner's window is read from it, and kept until its relaunch records it again over that record.
	const record =
		readableSubagentChildRecordOf(ownerSessionId, id) ??
		findSubagentChildRecord(readSubagentChildRecords(ctx.sessionManager.getEntries(), ownerSessionId), id) ??
		(await archivedChildRecord(ctx, ownerSessionId, id));
	if (!record) return { kind: "unrestorable", childId: id, reason: "this session has no record of that subagent" };
	if (!isRestorableSubagentChild(record) && !resume) return { kind: "terminal", record };
	const key = childHoldKey(ownerSessionId, record.childId);
	const active = activeRestorations.get(key);
	if (active) {
		if (resume === undefined) return active.outcome;
		await active.finished;
		await subagentChildRecordsAppended(ownerSessionId);
		return restoreSubagentChild(deps, ctx, id, resume, refuseRelaunch);
	}
	goneChildren.delete(key);
	const previousIntercomId = Promise.withResolvers<string | undefined>();
	const finished = Promise.withResolvers<void>();
	let knownPreviousIntercomId: string | undefined;
	const onReopened = (intercomId: string | undefined) => {
		knownPreviousIntercomId = intercomId;
		previousIntercomId.resolve(intercomId);
	};
	const release = () => {
		if (activeRestorations.get(key)?.outcome === restoration) activeRestorations.delete(key);
		finished.resolve();
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
	const worktreeResume = resumeRunWorktree(
		record,
		deps.config.worktreeSetupHook
			? { hookPath: deps.config.worktreeSetupHook, timeoutMs: deps.config.worktreeSetupHookTimeoutMs }
			: undefined,
		{
			onWaiting: (message) => {
				if (ctx.hasUI) ctx.ui.setStatus(`subagent-worktree-${record.childId}`, message);
			},
		},
	);
	let releaseWorktree: ((failed?: boolean) => Promise<void>) | undefined;
	// The resume reports only once its run's worktrees are swept, so nothing of Atomic still runs in the child's worktree
	// when it does (#5589). A sweep that fails leaves the worktree to the next one; it never changes how the resume ends.
	const worktreeReleased = (failed: boolean) =>
		boundedWorktreeReply(record.runId, releaseWorktree?.(failed), undefined, signal);
	const failedRestore = async (reason: string, deadline: number) => {
		await markGone(reason);
		// The broker acknowledgement yields: the last sibling may have begun sweeping this worktree meanwhile.
		const note = await boundedWorktreeReply(record.runId, undefined, deadline, signal);
		return {
			kind: "unrestorable" as const,
			childId: record.childId,
			record,
			reason: note ? `${reason.replace(/\.$/, "")}. ${note.replace(/\.$/, "")}` : reason,
		};
	};
	const restoration: Promise<SubagentChildRestoreOutcome> = (async () => {
		releaseWorktree = await worktreeResume;
		if (signal?.aborted) throw new RestoreAbortedError();
		// Hold sends to the child before anything can fail, so no sender is told `Session not found` meanwhile.
		// When the session already holds them since it started, that hold carries on under the same capability:
		// what it holds stays held, and no moment passes without a hold.
		const earlier = await raceWithSignal(
			takeEarlyChildHold(key) ?? Promise.resolve(undefined),
			signal,
			() => undefined,
		);
		if (signal?.aborted) throw new RestoreAbortedError();
		// Sends to the relaunched child wait through its start, until it registers, instead of a brief hold.
		const holdMs = subagentStartHoldMs(deps.config.sessionStartTimeoutMs);
		if (earlier) {
			hold = earlier;
			await raceWithSignal(hold.holdWhileStarting(holdMs), signal, () => undefined);
		} else {
			hold = await raceWithSignal(
				holdChildTargets(deps.pi.events, record, launchIntercomGroup(record, ctx), { holdMs }),
				signal,
				() => undefined,
			);
		}
		if (signal?.aborted) throw new RestoreAbortedError();
		// The child follows the restores of the session that owns it, after those it was launched in: a wake comes from
		// outside any work, so neither is in scope here.
		return withWorktreeRootMappings(
			ctx.sessionManager.getWorktreeRootMappings(),
			() => relaunchChild(deps, ctx, record, hold, release, onReopened, resume, refuseRelaunch),
			recordedWorktreeRootMappings(record),
		);
	})().then(
		async (outcome) => {
			previousIntercomId.resolve(undefined);
			if (signal?.aborted) {
				release();
				void hold?.release();
				await worktreeReleased(false);
				throw new RestoreAbortedError();
			}
			const registered = activeRestorations.get(key);
			if (registered?.outcome === restoration) {
				registered.settled = outcome;
				registered.knownPreviousIntercomId = knownPreviousIntercomId;
			}
			const deadline = Date.now() + WORKTREE_REPLY_WAIT_MS;
			await worktreeReleased(outcome.kind === "unrestorable");
			if (outcome.kind === "unrestorable") return failedRestore(outcome.reason, deadline);
			if (outcome.kind !== "restored") release();
			return outcome;
		},
		async (error: Error) => {
			previousIntercomId.resolve(undefined);
			const aborted = isRestoreAborted(error, signal);
			const deadline = Date.now() + WORKTREE_REPLY_WAIT_MS;
			await worktreeReleased(!aborted);
			// A shutdown abort or transient storage failure leaves the child as it was for a later wake or resume;
			// never mark a healthy child permanently gone because the session closed mid-restore.
			if (aborted) {
				release();
				void hold?.release();
				throw error;
			}
			if (isRetryableStorageError(error)) {
				release();
				await hold?.release();
				throw error;
			}
			return failedRestore(error.message, deadline);
		},
	);
	activeRestorations.set(key, {
		ownerSessionId,
		record,
		outcome: restoration,
		finished: finished.promise,
		previousIntercomId: previousIntercomId.promise,
	});
	return restoration;
}

/**
 * A child of `ownerSessionId` whose records left its window, by any id {@link restoreSubagentChild} accepts, read in full
 * from the owner's session. Read through the child index when it can be, which keeps the record until the child is
 * recorded again: a relaunched child's records name only what changed.
 */
async function archivedChildRecord(
	ctx: ExtensionContext,
	ownerSessionId: string,
	id: string,
): Promise<SubagentChildRecord | undefined> {
	const target = id.trim();
	const catalog =
		typeof ctx.sessionManager.getArchivedChildCatalog === "function"
			? ctx.sessionManager.getArchivedChildCatalog().filter((child) => child.ownerSessionId === ownerSessionId)
			: [];
	const child =
		catalog.find((candidate) => candidate.childId === target) ??
		catalog.find((candidate) => candidate.taskId === target || candidate.intercomTarget === target);
	if (child === undefined) return undefined;
	const kept = await loadSubagentChildRecord(ownerSessionId, child.childId, { keep: true }).catch(() => undefined);
	if (kept !== undefined) return kept;
	const saved = await ctx.sessionManager.readArchivedChildRecord?.(child.entryId);
	const data = saved !== undefined && isSubagentChildRecord(saved) ? saved.data : undefined;
	return data?.childId === child.childId ? data : undefined;
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

/**
 * Restore every background child this session launched that had not settled when it was interrupted. A child whose
 * restoration met a failure that passes is left out, as it was, to be resumed.
 */
export async function restoreSubagentChildren(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
): Promise<SubagentChildRestoreOutcome[]> {
	const signal = sessionAbortSignal(ctx);
	if (signal?.aborted) return [];
	const owned = readSubagentChildRecords(ctx.sessionManager.getEntries(), subagentChildOwner(ctx).sessionId);
	const restorable = [...owned.values()].filter(isRestorableSubagentChild);
	const settled = await Promise.allSettled(
		restorable.map((record) => restoreSubagentChild(deps, ctx, record.childId)),
	);
	if (signal?.aborted) return [];
	// One child's failure never takes the others' outcomes with it (#4660). A failure that passes (or a session
	// shutdown abort) leaves its child as it was, to be resumed; any other is reported for that child alone, and
	// the child is not recorded as gone.
	const outcomes = settled.map((result, index): SubagentChildRestoreOutcome | undefined => {
		if (result.status === "fulfilled") return result.value;
		const error: unknown = result.reason;
		if (isRetryableStorageError(error) || isRestoreAborted(error, signal)) return undefined;
		return {
			kind: "unrestorable",
			childId: restorable[index]!.childId,
			reason: error instanceof Error ? error.message : String(error),
		};
	});
	return outcomes.filter((outcome) => outcome !== undefined);
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

function goneChildRefusal(label: string, record: SubagentChildRecord, reason?: string): string {
	return `Subagent \`${label}\` did not survive the restart and is gone${reason ? `: ${reason}` : ""}. The message was not sent. ${describeLostSubagentChild(record)}`;
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

/** Where an owner's session keeps the children whose records left its window, and reads their records. */
export type ArchivedSubagentChildren = Partial<
	Pick<SessionManager, "getArchivedChildCatalog" | "readArchivedChildRecord">
>;

/**
 * The child of `ownerSessionId` reported gone that `target` addresses, among those whose records left its window: read
 * in full, as its refusal describes it.
 */
async function archivedGoneChild(
	archived: ArchivedSubagentChildren | undefined,
	ownerSessionId: string,
	target: string,
): Promise<SubagentChildRecord | undefined> {
	if (typeof archived?.getArchivedChildCatalog !== "function") return undefined;
	const child = archived
		.getArchivedChildCatalog()
		.find(
			(candidate) =>
				candidate.ownerSessionId === ownerSessionId &&
				candidate.state === "terminal" &&
				candidate.terminalStatus === SUBAGENT_CHILD_GONE_STATUS &&
				[candidate.intercomTarget, candidate.childSessionId].some(
					(address) => address?.trim().toLowerCase() === target,
				),
		);
	if (child === undefined) return undefined;
	const saved = await archived.readArchivedChildRecord?.(child.entryId).catch(() => undefined);
	const data = saved !== undefined && isSubagentChildRecord(saved) ? saved.data : undefined;
	if (data?.childId === child.childId) return data;
	// Its record cannot be read now: it is refused as it stands, without its task or worktree.
	return {
		version: 1,
		childId: child.childId,
		runId: child.runId,
		index: child.index,
		agent: child.agent,
		state: child.state,
		cwd: child.cwd,
		owner: { kind: "session", sessionId: ownerSessionId },
		...(child.terminalStatus === undefined ? {} : { terminalStatus: child.terminalStatus }),
		...(child.intercomTarget === undefined ? {} : { intercomTarget: child.intercomTarget }),
		...(child.childSessionId === undefined ? {} : { childSessionId: child.childSessionId }),
		...(child.childSessionFile === undefined ? {} : { childSessionFile: child.childSessionFile }),
	};
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
	archived?: ArchivedSubagentChildren,
): Promise<string | undefined> {
	const target = targetName.trim().toLowerCase();
	if (!target) return undefined;
	const deadline = Date.now() + timeoutMs;
	const owned = [...activeRestorations.values()].filter(
		(restoration) => restoration.ownerSessionId === ownerSessionId,
	);
	let active = owned.find((restoration) => addressesChild(restoration.record, target));
	if (!active && owned.length > 0) {
		// A child's pre-restart Intercom id is known only once its own session has been reopened. Each is matched as soon
		// as it is known, so a sibling still reopening does not hide the child addressed (#5097).
		active = await settleWithin(
			new Promise<ActiveRestoration | undefined>((resolve) => {
				let unresolved = owned.length;
				for (const restoration of owned)
					void restoration.previousIntercomId.then((previousIntercomId) => {
						unresolved--;
						if (addressesChild(restoration.record, target, previousIntercomId)) resolve(restoration);
						else if (unresolved === 0) resolve(undefined);
					});
			}),
			deadline - Date.now(),
		);
	}
	if (active) {
		const label = active.record.intercomTarget ?? targetName.trim();
		let outcome: SubagentChildRestoreOutcome | undefined;
		try {
			outcome = await settleWithin(active.outcome, deadline - Date.now());
		} catch (error) {
			// Only a failure that passes rejects a restoration: the child is as it was, and may be restored next time.
			return `Subagent \`${label}\` could not be restored just now: ${(error as Error).message}. The message was not sent; try again shortly.`;
		}
		if (!outcome)
			return `Subagent \`${label}\` is still being restored after the restart. The message was not sent; try again shortly.`;
		if (outcome.kind === "unrestorable") return goneChildRefusal(label, active.record, outcome.reason);
		// A relaunched child that has not registered yet is still starting: its hold keeps the send for it until it
		// registers, before its first turn, so the send goes out.
		return undefined;
	}
	for (const reported of goneChildren.values()) {
		if (
			reported.ownerSessionId === ownerSessionId &&
			addressesChild(reported.record, target, reported.previousIntercomId)
		)
			return goneChildRefusal(reported.record.intercomTarget ?? targetName.trim(), reported.record, reported.reason);
	}
	const gone =
		[...readSubagentChildRecords(entries, ownerSessionId).values()].find(
			(record) =>
				addressesChild(record, target) &&
				record.state === "terminal" &&
				record.terminalStatus === SUBAGENT_CHILD_GONE_STATUS,
		) ?? (await archivedGoneChild(archived, ownerSessionId, target));
	return gone ? goneChildRefusal(gone.intercomTarget ?? targetName.trim(), gone) : undefined;
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
				`${childLabel(outcome.record, outcome.childId)} did not survive the restart and could not be restored: ${outcome.reason}. It is gone: do not send it Intercom messages or wait for its result.${outcome.record ? ` ${describeLostSubagentChild(outcome.record)}` : " Launch a fresh subagent if its work is still needed."}`,
			];
		const label = childLabel(outcome.record, outcome.record.childId);
		const how = outcome.fresh
			? "started fresh with its task, since it had not started before the restart,"
			: "relaunched from its own session";
		if (outcome.intercomLive === false)
			return [
				`${label} was ${how} as task ${outcome.taskId} and is still starting: it has not registered on Intercom yet. Messages sent to it now wait for it and reach it before its first turn; \`subagent({ action: "status", id: "${outcome.taskId}" })\` shows where its start is. Its result arrives as a task completion.`,
			];
		return [
			`${label} was interrupted by the restart and has been ${how} as task ${outcome.taskId}${outcome.intercomLive ? "; it is live on Intercom under the same name" : ""}.`,
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
	atomic: Pick<ExtensionAPI, "appendEntry">,
	outcomes: readonly SubagentChildRestoreOutcome[],
): Promise<void> {
	for (const outcome of outcomes) {
		if (outcome.kind !== "unrestorable" || !outcome.record) continue;
		await recordSubagentChildGone(atomic, outcome.record).catch(() => undefined);
	}
}

/** Restorations in flight and children reported gone, held in this process; counted by tests and the benchmark. */
export function subagentRestoreRegistrySizes(): { readonly active: number; readonly gone: number } {
	return { active: activeRestorations.size, gone: goneChildren.size };
}
