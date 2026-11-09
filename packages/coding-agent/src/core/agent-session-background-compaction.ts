/**
 * Background compaction for an agent session (#4330).
 *
 * Past the soft threshold a task compacts a frozen prefix (up to the safe point) with the unchanged
 * verbatim compaction ladder while turns continue. Its result is stored as one session entry and
 * committed once, at the next turn boundary, as a boundary that covers only that prefix. Foreground
 * compaction remains for the hard threshold and overflow when no result is ready.
 */

import type { Api, Model } from "@bastani/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AppendedVerbatimBoundary,
	appendVerbatimBoundary,
	finishVerbatimCommit,
	type PlannedVerbatimCompaction,
	planVerbatimCompaction,
} from "./agent-session-compaction.ts";
import { awaitedToolTurnEntryId } from "./agent-session-detached-tools.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { authForStream } from "./agent-session-models.ts";
import { rethrowUnlessReportedPersistenceFailure } from "./agent-session-persistence-failures.ts";
import { type CompactionCacheMiss, createCacheMissModelSource, estimateCompactionCacheMiss } from "./cache-stats.ts";
import {
	announcedResultOutcome,
	BACKGROUND_COMPACTION_RESULT_TYPE,
	type BackgroundCompactionResultRecord,
	type BackgroundCompactionState,
	backgroundCompactionRetryDelayMs,
	type CompactionWakeDispatcher,
	DEFAULT_BACKGROUND_COMPACTION_THRESHOLD_PERCENT,
	findBackgroundCompactionSafePoint,
	IDLE_BACKGROUND_COMPACTION_STATE,
	type ReadyBackgroundCompaction,
	selectReadyBackgroundCompaction,
	serializeBackgroundCompactionState,
	shouldStartBackgroundCompaction,
	staleBackgroundCompactionPrefix,
} from "./compaction/background-compaction.ts";
import {
	BackgroundCompactionCommitError,
	type BackgroundCompactionConfigError,
	BackgroundCompactionDiscardedError,
	type BackgroundCompactionError,
	BackgroundCompactionNotCompactableError,
	BackgroundCompactionPersistError,
	BackgroundCompactionPlanningError,
	isBackgroundCompactionCommitError,
	isBackgroundCompactionConfigError,
	isBackgroundCompactionDiscardedError,
	serializeBackgroundCompactionError,
} from "./compaction/background-compaction-errors.ts";
import { estimateContextTokens, shouldCompact, type VerbatimCompactionResult } from "./compaction/index.ts";
import { scrubPreCompactionAssistantUsage } from "./provider-context-usage.ts";
import { sessionLifetime, trackSessionWork } from "./session-lifecycle-work.ts";
import type { SessionEntry } from "./session-manager-types.ts";
import { settingsWriteOwner } from "./settings-write-ownership.ts";

interface RunningBackgroundCompaction {
	readonly controller: AbortController;
	readonly upToEntryId: string;
	readonly startedAt: string;
	readonly attempt: number;
	readonly settled: Promise<void>;
}

/** A ready result committed at a turn boundary. */
export interface CommittedBackgroundCompaction {
	readonly result: VerbatimCompactionResult;
	readonly cacheMiss?: CompactionCacheMiss;
}

/** A ready result a foreground compaction committed; `sufficient` when no further compaction is needed. */
export interface ForegroundBackgroundCompaction extends CommittedBackgroundCompaction {
	readonly sufficient: boolean;
}

type TaskOutcome =
	| { readonly kind: "ready"; readonly resultEntryId: string }
	| { readonly kind: "failed"; readonly error: BackgroundCompactionError }
	| { readonly kind: "discarded"; readonly error: BackgroundCompactionDiscardedError }
	| { readonly kind: "cancelled" };

/**
 * Per-session scheduler state. No timers: retries wait for a turn boundary after `nextAttemptAt`, a monotonic
 * `performance.now()` reading so a wall-clock step cannot stretch the backoff.
 */
export class BackgroundCompactionRuntime {
	task: RunningBackgroundCompaction | undefined;
	/** The last failure of a task or of applying its result; history is unchanged. */
	failure:
		| { readonly error: BackgroundCompactionError; readonly upToEntryId: string; readonly startedAt: string }
		| undefined;
	/** The invalid-setting error last reported, so the same one is reported only once. */
	reportedConfigError: BackgroundCompactionConfigError | undefined;
	consecutiveFailures = 0;
	nextAttemptAt = 0;
	/** The stored result last announced as ready, so a later discard of it is reported once. */
	announcedResultEntryId: string | undefined;
	commitInFlight: Promise<CommittedBackgroundCompaction | undefined> | undefined;
	readonly readyListeners = new Set<(state: BackgroundCompactionState) => void>();

	readonly wake: CompactionWakeDispatcher | undefined;

	constructor(wake: CompactionWakeDispatcher | undefined) {
		this.wake = wake;
	}
}

function runtimeOf(session: AgentSession): BackgroundCompactionRuntime {
	return session._backgroundCompaction;
}

function foregroundCompactionActive(session: AgentSession): boolean {
	return (
		session._compactionAbortController !== undefined ||
		session._manualCompactionPromise !== undefined ||
		session._autoCompactionAbortController !== undefined
	);
}

function configuredBackgroundSettings(
	session: AgentSession,
): { background: boolean; thresholdPercent: number } | BackgroundCompactionConfigError {
	try {
		return {
			background: session.settingsManager.getCompactionBackground(),
			thresholdPercent: session.settingsManager.getCompactionBackgroundThresholdPercent(),
		};
	} catch (error) {
		if (!isBackgroundCompactionConfigError(error)) throw error;
		return error;
	}
}

/**
 * The background settings Atomic uses. While a setting is invalid, background compaction is off with the default
 * threshold, and the typed config error is reported once.
 */
function effectiveBackgroundSettings(session: AgentSession): { background: boolean; thresholdPercent: number } {
	const configured = configuredBackgroundSettings(session);
	const runtime = runtimeOf(session);
	if (!isBackgroundCompactionConfigError(configured)) {
		runtime.reportedConfigError = undefined;
		return configured;
	}
	if (runtime.reportedConfigError?.message !== configured.message) {
		runtime.reportedConfigError = configured;
		emitBackgroundCompactionState(session);
	}
	return { background: false, thresholdPercent: DEFAULT_BACKGROUND_COMPACTION_THRESHOLD_PERCENT };
}

function backgroundSettings(session: AgentSession): { enabled: boolean; thresholdPercent: number } {
	const { background, thresholdPercent } = effectiveBackgroundSettings(session);
	return { enabled: background && session.settingsManager.getCompactionEnabled(), thresholdPercent };
}

/** Whether background compaction is on, without recording anything: valid settings, both switches on. */
function backgroundCompactionOn(session: AgentSession): boolean {
	const configured = configuredBackgroundSettings(session);
	return (
		!isBackgroundCompactionConfigError(configured) &&
		configured.background &&
		session.settingsManager.getCompactionEnabled()
	);
}

function stateKey(session: AgentSession): string {
	return JSON.stringify(serializeBackgroundCompactionState(backgroundCompactionState(session)));
}

/**
 * Write a setting that decides whether background compaction runs, then bring the runtime in line: while
 * background compaction is off, cancel a running task and forget task failures and their backoff, so turning it
 * on again starts fresh. Reports the state once if it changed, announcing a saved result that was never announced.
 */
export function _writeBackgroundCompactionSetting(this: AgentSession, write: () => void): void {
	effectiveBackgroundSettings(this);
	const before = stateKey(this);
	settingsWriteOwner.run(this, write);
	const runtime = runtimeOf(this);
	const configured = configuredBackgroundSettings(this);
	runtime.reportedConfigError = isBackgroundCompactionConfigError(configured) ? configured : undefined;
	if (!backgroundCompactionOn(this)) {
		this._abortBackgroundCompaction();
		runtime.failure = undefined;
		runtime.consecutiveFailures = 0;
		runtime.nextAttemptAt = 0;
	}
	if (stateKey(this) === before) return;
	const ready =
		backgroundCompactionState(this).state === "ready"
			? selectReadyBackgroundCompaction(this.sessionManager.getBranch())
			: undefined;
	if (ready && ready.entry.id !== runtime.announcedResultEntryId)
		announceReady(this, ready.entry.id, ready.record.upToEntryId);
	else emitBackgroundCompactionState(this);
}

/**
 * Current state: invalid settings fail and disabled settings are idle, even while cancellation settles.
 * Otherwise report the running task, a stored result that fits the branch, or the last task or commit failure.
 */
export function backgroundCompactionState(session: AgentSession): BackgroundCompactionState {
	const runtime = runtimeOf(session);
	const configured = configuredBackgroundSettings(session);
	if (isBackgroundCompactionConfigError(configured)) return { state: "failed", error: configured };
	if (!configured.background || !session.settingsManager.getCompactionEnabled())
		return IDLE_BACKGROUND_COMPACTION_STATE;
	if (runtime.task) {
		return { state: "running", upToEntryId: runtime.task.upToEntryId, startedAt: runtime.task.startedAt };
	}
	const ready = selectReadyBackgroundCompaction(session.sessionManager.getBranch());
	const failure = runtime.failure;
	const error = failure?.error;
	const failedResultEntryId = isBackgroundCompactionCommitError(error) ? error.resultEntryId : undefined;
	if (ready && failedResultEntryId !== ready.entry.id) {
		return { state: "ready", upToEntryId: ready.record.upToEntryId, startedAt: ready.record.startedAt };
	}
	if (failure && (ready || failedResultEntryId === undefined)) {
		return { state: "failed", upToEntryId: failure.upToEntryId, startedAt: failure.startedAt, error: failure.error };
	}
	return IDLE_BACKGROUND_COMPACTION_STATE;
}

/** Forget a commit failure whose stored result is no longer the one waiting to be applied. */
function releaseStaleCommitFailure(runtime: BackgroundCompactionRuntime, ready: ReadyBackgroundCompaction | undefined) {
	const error = runtime.failure?.error;
	if (!isBackgroundCompactionCommitError(error) || error.resultEntryId === ready?.entry.id) return;
	runtime.failure = undefined;
	runtime.consecutiveFailures = 0;
	runtime.nextAttemptAt = 0;
}

function recordCommitFailure(session: AgentSession, ready: ReadyBackgroundCompaction, cause: unknown): void {
	const runtime = runtimeOf(session);
	runtime.consecutiveFailures += 1;
	runtime.nextAttemptAt = performance.now() + backgroundCompactionRetryDelayMs(runtime.consecutiveFailures);
	runtime.announcedResultEntryId = ready.entry.id;
	runtime.failure = {
		error: new BackgroundCompactionCommitError(
			{ upToEntryId: ready.record.upToEntryId, resultEntryId: ready.entry.id, attempt: runtime.consecutiveFailures },
			{ cause },
		),
		upToEntryId: ready.record.upToEntryId,
		startedAt: ready.record.startedAt,
	};
	emitBackgroundCompactionState(session);
}

function reportListenerFailure(session: AgentSession, error: unknown): void {
	session._extensionRunner.emitError({
		extensionPath: "<background_compaction>",
		event: "background_compaction",
		error: error instanceof Error ? error.message : String(error),
		stack: error instanceof Error ? error.stack : undefined,
	});
}

function emitBackgroundCompactionState(
	session: AgentSession,
	discarded?: BackgroundCompactionDiscardedError,
): BackgroundCompactionState {
	const state = backgroundCompactionState(session);
	try {
		session._emit({
			type: "background_compaction",
			compaction: serializeBackgroundCompactionState(state),
			...(discarded === undefined ? {} : { discarded: serializeBackgroundCompactionError(discarded) }),
		});
	} catch (error) {
		reportListenerFailure(session, error);
	}
	return state;
}

function announceReady(session: AgentSession, resultEntryId: string, upToEntryId: string): void {
	const runtime = runtimeOf(session);
	runtime.announcedResultEntryId = resultEntryId;
	const state = emitBackgroundCompactionState(session);
	for (const listener of [...runtime.readyListeners]) {
		try {
			listener(state);
		} catch (error) {
			reportListenerFailure(session, error);
		}
	}
	try {
		runtime.wake?.compactionReady({ sessionId: session.sessionManager.getSessionId(), resultEntryId, upToEntryId });
	} catch (error) {
		reportListenerFailure(session, error);
	}
}

/**
 * The in-memory context after a commit, without the usage of assistants from before the boundary: that
 * usage measured the uncompacted prompt and must not drive the next threshold decision.
 */
export function committedContextMessages(session: AgentSession): AgentMessage[] {
	return scrubPreCompactionAssistantUsage(session.agent.state.messages.slice(), session.sessionManager.getBranch());
}

function plannedFromRecord(record: BackgroundCompactionResultRecord): PlannedVerbatimCompaction {
	return {
		text: record.summary,
		firstKeptEntryId: record.firstKeptEntryId,
		tokensBefore: record.tokensBefore,
		details: record.details,
		...(record.usage ? { usage: record.usage } : {}),
		fromExtension: record.fromExtension,
	};
}

function resultRecord(
	planned: PlannedVerbatimCompaction,
	upToEntryId: string,
	startedAt: string,
): BackgroundCompactionResultRecord {
	return {
		version: 1,
		upToEntryId,
		startedAt,
		completedAt: new Date().toISOString(),
		summary: planned.text,
		firstKeptEntryId: planned.firstKeptEntryId,
		tokensBefore: planned.tokensBefore,
		details: planned.details,
		...(planned.usage ? { usage: planned.usage } : {}),
		fromExtension: planned.fromExtension,
	};
}

async function runTask(
	session: AgentSession,
	task: RunningBackgroundCompaction,
	prefix: SessionEntry[],
): Promise<TaskOutcome> {
	const { controller, upToEntryId } = task;
	let planned: PlannedVerbatimCompaction | undefined;
	try {
		planned = await planVerbatimCompaction.call(
			session,
			{
				reason: "threshold",
				urgency: "recoverable",
				abortController: controller,
				resolvePlannerAuth: async (candidate, signal) => {
					const auth = await session._getRequiredRequestAuth(candidate, signal ?? controller.signal);
					return auth.apiKey || auth.headers ? authForStream(session, auth) : undefined;
				},
			},
			prefix,
		);
	} catch (error) {
		if (controller.signal.aborted) return { kind: "cancelled" };
		return {
			kind: "failed",
			error: new BackgroundCompactionPlanningError({ upToEntryId, attempt: task.attempt }, { cause: error }),
		};
	}
	if (!planned) return { kind: "failed", error: new BackgroundCompactionNotCompactableError({ upToEntryId }) };

	const stale = staleBackgroundCompactionPrefix(session.sessionManager.getBranch(), upToEntryId);
	if (stale) {
		return {
			kind: "discarded",
			error: new BackgroundCompactionDiscardedError({ upToEntryId, reason: stale, phase: "persist" }),
		};
	}
	try {
		const resultEntryId = await session.sessionManager.appendCustomEntry(
			BACKGROUND_COMPACTION_RESULT_TYPE,
			resultRecord(planned, upToEntryId, task.startedAt),
		);
		return { kind: "ready", resultEntryId };
	} catch (error) {
		if (controller.signal.aborted) return { kind: "cancelled" };
		return { kind: "failed", error: new BackgroundCompactionPersistError({ upToEntryId }, { cause: error }) };
	}
}

function settleTask(session: AgentSession, task: RunningBackgroundCompaction, outcome: TaskOutcome): void {
	const runtime = runtimeOf(session);
	runtime.task = undefined;
	switch (outcome.kind) {
		case "ready": {
			runtime.consecutiveFailures = 0;
			runtime.nextAttemptAt = 0;
			runtime.failure = undefined;
			try {
				session._emit({
					type: "entry_appended",
					entry: session.sessionManager.getEntry(outcome.resultEntryId) as SessionEntry,
				});
			} catch (error) {
				reportListenerFailure(session, error);
			}
			if (backgroundCompactionOn(session)) announceReady(session, outcome.resultEntryId, task.upToEntryId);
			else emitBackgroundCompactionState(session);
			return;
		}
		case "failed":
			runtime.consecutiveFailures += 1;
			runtime.nextAttemptAt = performance.now() + backgroundCompactionRetryDelayMs(runtime.consecutiveFailures);
			runtime.failure = { error: outcome.error, upToEntryId: task.upToEntryId, startedAt: task.startedAt };
			emitBackgroundCompactionState(session);
			return;
		case "discarded":
			runtime.failure = undefined;
			emitBackgroundCompactionState(session, outcome.error);
			return;
		case "cancelled":
			runtime.failure = undefined;
			emitBackgroundCompactionState(session);
			return;
	}
}

function startTask(session: AgentSession, prefix: SessionEntry[]): void {
	const runtime = runtimeOf(session);
	const upToEntryId = prefix[prefix.length - 1].id;
	const controller = new AbortController();
	const lifetime = sessionLifetime(session);
	const relayAbort = () => controller.abort(lifetime.reason);
	lifetime.addEventListener("abort", relayAbort);
	let settle!: () => void;
	const settled = new Promise<void>((resolve) => {
		settle = resolve;
	});
	const task: RunningBackgroundCompaction = {
		controller,
		upToEntryId,
		startedAt: new Date().toISOString(),
		attempt: runtime.consecutiveFailures + 1,
		settled,
	};
	runtime.task = task;
	runtime.failure = undefined;
	emitBackgroundCompactionState(session);
	void trackSessionWork(session, async () => {
		try {
			settleTask(session, task, await runTask(session, task, prefix));
		} finally {
			lifetime.removeEventListener("abort", relayAbort);
			runtime.task = undefined;
			settle();
		}
	}).catch((error: unknown) => reportListenerFailure(session, error));
}

/**
 * Start a background task when context usage passes the soft threshold, nothing is running or
 * waiting for a commit, and the retry backoff has elapsed. Never waits for the task.
 */
export function _maybeStartBackgroundCompaction(this: AgentSession, contextTokens: number): void {
	const runtime = runtimeOf(this);
	if (runtime.task || this._disposed || foregroundCompactionActive(this)) return;
	const settings = backgroundSettings(this);
	if (!settings.enabled) return;
	if (!shouldStartBackgroundCompaction(contextTokens, this.model?.contextWindow ?? 0, settings.thresholdPercent))
		return;
	const branch = this.sessionManager.getBranch();
	if (selectReadyBackgroundCompaction(branch)) return;
	releaseStaleCommitFailure(runtime, undefined);
	if (performance.now() < runtime.nextAttemptAt) return;
	const safe = findBackgroundCompactionSafePoint(branch, awaitedToolTurnEntryId(this));
	if (safe < 0) return;
	startTask(this, branch.slice(0, safe + 1));
}

/**
 * `awaitPersistence` waits for queued message saves first; it is set only outside the session event
 * queue (the agent loop's next-turn hook), never from an event handler running inside that queue.
 */
export interface CommitReadyOptions {
	readonly foreground?: boolean;
	readonly awaitPersistence?: boolean;
}

/**
 * Settle the branch against the runtime before anything waits: forget a commit failure whose result is no
 * longer the ready one, forget an announced result that left the branch, and report one that was discarded.
 */
function settleBranch(session: AgentSession): { branch: SessionEntry[]; ready: ReadyBackgroundCompaction | undefined } {
	const runtime = runtimeOf(session);
	const branch = session.sessionManager.getBranch();
	const ready = selectReadyBackgroundCompaction(branch);
	releaseStaleCommitFailure(runtime, ready);
	const outcome = announcedResultOutcome(branch, runtime.announcedResultEntryId);
	if (outcome.kind !== "committable") {
		runtime.announcedResultEntryId = undefined;
		if (outcome.kind === "discarded") emitBackgroundCompactionState(session, outcome.error);
	}
	return { branch, ready };
}

/** Whether nothing may be applied now: the session closed or failed to save, a foreground compaction owns the boundary, or background compaction is off. */
function commitBlocked(session: AgentSession, foreground: boolean): boolean {
	return (
		session._disposed ||
		session._persistenceFailure !== undefined ||
		(!foreground && foregroundCompactionActive(session)) ||
		!backgroundSettings(session).enabled
	);
}

const COMMIT_BLOCKED = Symbol();

function assertCommitAllowed(session: AgentSession, ready: ReadyBackgroundCompaction, foreground: boolean): void {
	if (commitBlocked(session, foreground)) throw COMMIT_BLOCKED;
	const outcome = announcedResultOutcome(session.sessionManager.getBranch(), ready.entry.id);
	if (outcome.kind === "committable") return;
	throw outcome.kind === "discarded"
		? outcome.error
		: new BackgroundCompactionDiscardedError({ upToEntryId: ready.record.upToEntryId, reason: "off-branch" });
}

async function commitReady(
	session: AgentSession,
	{ foreground = false, awaitPersistence = false }: CommitReadyOptions,
): Promise<CommittedBackgroundCompaction | undefined> {
	if (commitBlocked(session, foreground)) return undefined;
	const runtime = runtimeOf(session);
	let { branch, ready } = settleBranch(session);
	if (!ready) return undefined;
	if (
		!foreground &&
		isBackgroundCompactionCommitError(runtime.failure?.error) &&
		performance.now() < runtime.nextAttemptAt
	)
		return undefined;
	if (awaitPersistence) {
		await session._agentEventQueue.catch(rethrowUnlessReportedPersistenceFailure);
		if (commitBlocked(session, foreground)) return undefined;
		({ branch, ready } = settleBranch(session));
		if (!ready) return undefined;
	}
	const planned = plannedFromRecord(ready.record);
	let appended: AppendedVerbatimBoundary;
	try {
		appended = await appendVerbatimBoundary.call(session, planned, {
			backupLabel: "background-compact",
			coveredThroughEntryId: ready.record.upToEntryId,
			precondition: () => assertCommitAllowed(session, ready, foreground),
		});
	} catch (error) {
		if (error === COMMIT_BLOCKED) return undefined;
		if (isBackgroundCompactionDiscardedError(error)) {
			settleBranch(session);
			return undefined;
		}
		if (!session._disposed && backgroundCompactionOn(session)) recordCommitFailure(session, ready, error);
		return undefined;
	}
	const result = await finishVerbatimCommit.call(session, planned, appended, "threshold");
	const cacheMiss = estimateCompactionCacheMiss(
		branch,
		estimateContextTokens(committedContextMessages(session)).tokens,
		createCacheMissModelSource(session._modelRuntime),
	);
	runtime.consecutiveFailures = 0;
	runtime.nextAttemptAt = 0;
	runtime.failure = undefined;
	runtime.announcedResultEntryId = undefined;
	emitBackgroundCompactionState(session);
	return { result, ...(cacheMiss ? { cacheMiss } : {}) };
}

/**
 * Commit the stored result that fits the current branch, once, if there is one. `foreground` is set
 * by a foreground compaction that already owns the boundary and tries a ready result first.
 */
export function _commitReadyBackgroundCompaction(
	this: AgentSession,
	options: CommitReadyOptions = {},
): Promise<CommittedBackgroundCompaction | undefined> {
	const runtime = runtimeOf(this);
	const inFlight = runtime.commitInFlight;
	if (inFlight) return inFlight.then(() => undefined);
	const flight = commitReady(this, options).finally(() => {
		runtime.commitInFlight = undefined;
	});
	runtime.commitInFlight = flight;
	return flight;
}

/** Turn-boundary step: commit a ready result and announce it. Returns true when a boundary was committed. */
export async function _runBackgroundCompactionBoundary(
	this: AgentSession,
	midTurn: boolean,
	awaitPersistence = false,
): Promise<boolean> {
	const committed = await this._commitReadyBackgroundCompaction({ awaitPersistence });
	if (committed) {
		this._emit({
			type: "compaction_end",
			reason: "threshold",
			result: committed.result,
			aborted: false,
			willRetry: false,
			midTurn,
			background: true,
			...(committed.cacheMiss ? { cacheMiss: committed.cacheMiss } : {}),
		});
		return true;
	}
	return false;
}

/**
 * Foreground entry point: commit a ready result instead of planning when one exists and the
 * compacted context is back under the hard threshold; otherwise cancel any running task so the
 * foreground boundary supersedes it.
 */
export async function _useReadyBackgroundCompaction(
	this: AgentSession,
	model: Model<Api>,
): Promise<ForegroundBackgroundCompaction | undefined> {
	const committed = await this._commitReadyBackgroundCompaction({ foreground: true });
	this._abortBackgroundCompaction();
	if (committed === undefined) return undefined;
	const sufficient = !shouldCompact(
		estimateContextTokens(committedContextMessages(this)).tokens,
		model.contextWindow,
		this.settingsManager.getCompactionSettings(model),
	);
	return { ...committed, sufficient };
}

export function _abortBackgroundCompaction(this: AgentSession): void {
	runtimeOf(this).task?.controller.abort();
}

/** Resolves once no background task is running, with the state at that point. Never rejects. */
export async function awaitBackgroundCompaction(this: AgentSession): Promise<BackgroundCompactionState> {
	const task = runtimeOf(this).task;
	if (task) await task.settled;
	return this.compaction;
}

/** Call `listener` each time a background result is stored and ready to commit. Returns an unsubscribe. */
export function onCompactionReady(
	this: AgentSession,
	listener: (state: BackgroundCompactionState) => void,
): () => void {
	const listeners = runtimeOf(this).readyListeners;
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function setBackgroundCompactionEnabled(this: AgentSession, enabled: boolean): void {
	this._writeBackgroundCompactionSetting(() => this.settingsManager.setCompactionBackground(enabled));
}

export function setBackgroundCompactionThresholdPercent(this: AgentSession, percent: number): void {
	this._writeBackgroundCompactionSetting(() => this.settingsManager.setCompactionBackgroundThresholdPercent(percent));
}

export function installBackgroundCompactionAccessors(prototype: AgentSession): void {
	Object.defineProperties(prototype, {
		compaction: {
			get(this: AgentSession) {
				effectiveBackgroundSettings(this);
				return backgroundCompactionState(this);
			},
		},
		backgroundCompactionEnabled: {
			get(this: AgentSession) {
				return effectiveBackgroundSettings(this).background;
			},
		},
		backgroundCompactionThresholdPercent: {
			get(this: AgentSession) {
				return effectiveBackgroundSettings(this).thresholdPercent;
			},
		},
	});
}

export const agentSessionBackgroundCompactionMethods = {
	_writeBackgroundCompactionSetting,
	_maybeStartBackgroundCompaction,
	_commitReadyBackgroundCompaction,
	_runBackgroundCompactionBoundary,
	_useReadyBackgroundCompaction,
	_abortBackgroundCompaction,
	awaitBackgroundCompaction,
	onCompactionReady,
	setBackgroundCompactionEnabled,
	setBackgroundCompactionThresholdPercent,
};
