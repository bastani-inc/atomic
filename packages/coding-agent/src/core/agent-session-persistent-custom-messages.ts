import { waitsOnDetachedResults } from "./agent-session-detached-tools.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { noteMessageSaved } from "./agent-session-persistence-failures.ts";
import type { DrainedAgentQueues } from "./agent-session-types.js";
import { customMessageExcludesContext } from "./agent-session-types.js";
import type { PendingRecoveryDelivery } from "./extensions/index.js";
import type { CustomMessage, StageAdmittedCustomMessage } from "./messages.ts";
import { appendFailureWroteNothing } from "./session-manager-append-errors.ts";
import { SessionDeletedError } from "./session-manager-errors.js";
import { SessionConflictError, SessionNotFoundError } from "./storage/session/errors.js";

type ProtectedDelivery = "steer" | "followUp";
type ProtectedPhase = "queued" | "consumed-unpersisted" | "persistence-failed";

export const PROTECTED_RECONCILIATION_CUSTOM_TYPE = "atomic:protected-streaming-reconciliation";

interface ProtectedReconciliationDetails {
	protectedReconciliationOf: string;
	/** Set when resume recovery declined to replay the card to the model. */
	recovery?: "dropped";
}

export interface ProtectedStreamingCustomMessage {
	message: CustomMessage;
	delivery: ProtectedDelivery;
	phase: ProtectedPhase;
}

function protectedMessages(session: AgentSession): ProtectedStreamingCustomMessage[] {
	session._protectedStreamingCustomMessages ??= [];
	return session._protectedStreamingCustomMessages;
}

interface DurableDisplayCard {
	readonly card: CustomMessage & { excludeFromContext: true };
	readonly intentEntryId: string;
}

const displayedExcludedCards = new WeakMap<AgentSession, Set<string>>();
const failedCardWrites = new WeakMap<AgentSession["sessionManager"], () => Promise<void>>();
const uncertainCardKeys = new WeakMap<AgentSession["sessionManager"], Set<string>>();
const pendingCardWrites = new WeakMap<AgentSession["sessionManager"], Map<string, Promise<DurableDisplayCard>>>();

function displayedCards(session: AgentSession): Set<string> {
	let displayed = displayedExcludedCards.get(session);
	if (displayed === undefined) {
		displayed = new Set(session.sessionManager.getBranch().map((entry) => entry.id));
		displayedExcludedCards.set(session, displayed);
	}
	return displayed;
}

export function markCustomMessageDisplayed(session: AgentSession, entryId: string): void {
	displayedCards(session).add(entryId);
}

export function refreshFailedCustomMessageWrites(session: AgentSession): Promise<void> | undefined {
	displayedCards(session);
	return failedCardWrites.get(session.sessionManager)?.();
}

export function hasUncertainCustomMessageWrite(manager: AgentSession["sessionManager"], key: string): boolean {
	return uncertainCardKeys.get(manager)?.has(key) === true;
}

export function confirmCustomMessageWrite(manager: AgentSession["sessionManager"], key: string | undefined): void {
	if (key !== undefined) uncertainCardKeys.get(manager)?.delete(key);
}

export function recordFailedCustomMessageWrite(
	manager: AgentSession["sessionManager"],
	error: unknown,
	key?: string,
): void {
	if (
		error instanceof SessionDeletedError ||
		error instanceof SessionConflictError ||
		appendFailureWroteNothing(error)
	)
		return;
	if (key !== undefined) {
		const uncertain = uncertainCardKeys.get(manager) ?? new Set<string>();
		uncertain.add(key);
		uncertainCardKeys.set(manager, uncertain);
	}
	failedCardWrites.set(manager, async () => {
		try {
			await manager.refreshFromStore();
		} catch (refreshError) {
			if (!(refreshError instanceof SessionNotFoundError)) throw refreshError;
		}
		failedCardWrites.delete(manager);
	});
}

export function customMessageOccurrences<T>(messages: CustomMessage<T>[]): CustomMessage<T>[] {
	const counts = new Map<string, number>();
	for (const message of messages) {
		const key = (message as StageAdmittedCustomMessage).stageAdmissionKey;
		if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const used = new Set(counts.keys());
	const next = new Map<string, number>();
	return messages.map((message) => {
		const key = (message as StageAdmittedCustomMessage).stageAdmissionKey;
		if (key === undefined || counts.get(key) === 1) return message;
		counts.set(key, counts.get(key)! - 1);
		let index = next.get(key) ?? 0;
		while (used.has(`${key}#${index}`)) index++;
		const occurrenceKey = `${key}#${index}`;
		used.add(occurrenceKey);
		next.set(key, index + 1);
		return { ...message, stageAdmissionKey: occurrenceKey } satisfies StageAdmittedCustomMessage;
	});
}

function appendDurableDisplayCard(
	session: AgentSession,
	message: CustomMessage,
	delivery: ProtectedDelivery | undefined,
): Promise<DurableDisplayCard> {
	const key = (message as StageAdmittedCustomMessage).stageAdmissionKey;
	if (key === undefined) return appendDisplayCardOccurrence(session, message, delivery);
	const manager = session.sessionManager;
	const pending = pendingCardWrites.get(manager) ?? new Map<string, Promise<DurableDisplayCard>>();
	const existing = pending.get(key);
	if (existing !== undefined) return existing;
	const write = appendDisplayCardOccurrence(session, message, delivery);
	pending.set(key, write);
	pendingCardWrites.set(manager, pending);
	const clear = () => {
		if (pending.get(key) === write) pending.delete(key);
		if (pending.size === 0) pendingCardWrites.delete(manager);
	};
	void write.then(clear, clear);
	return write;
}

async function appendDisplayCardOccurrence(
	session: AgentSession,
	message: CustomMessage,
	delivery: ProtectedDelivery | undefined,
): Promise<DurableDisplayCard> {
	const refresh = refreshFailedCustomMessageWrites(session);
	if (refresh !== undefined) await refresh;
	const card = { ...message, excludeFromContext: true } satisfies CustomMessage & { excludeFromContext: true };
	const admitted = message as StageAdmittedCustomMessage;
	// A retry after a failed flush must complete the already-appended occurrence
	// rather than append a second visible card for the same stable key.
	const partial =
		admitted.stageAdmissionKey === undefined
			? undefined
			: session.sessionManager
					.getBranch()
					.find(
						(entry) =>
							entry.type === "custom_message" &&
							entry.stageAdmissionKey === admitted.stageAdmissionKey &&
							(delivery === undefined
								? entry.protectedReconciliation === undefined
								: protectedDelivery(entry.protectedReconciliation) !== undefined),
					);
	// The card and recovery marker share one append, so either both survive a
	// process exit or neither does.
	let intentEntryId = partial?.id;
	if (intentEntryId === undefined) {
		const manager = session.sessionManager;
		try {
			intentEntryId = await manager.appendCustomMessageEntry(
				card.customType,
				card.content,
				card.display,
				card.details,
				true,
				delivery === undefined ? undefined : { delivery },
				admitted.stageAdmissionKey,
			);
		} catch (error) {
			recordFailedCustomMessageWrite(manager, error, admitted.stageAdmissionKey);
			throw error;
		}
	}
	confirmCustomMessageWrite(session.sessionManager, admitted.stageAdmissionKey);
	session._entryIdsByMessage.set(card, intentEntryId);
	noteMessageSaved(session, card);
	session._refreshFinalizedContext();
	return { card, intentEntryId };
}

function emitDurableDisplayCard(session: AgentSession, card: CustomMessage): void {
	try {
		session._emit({ type: "message_start", message: card });
	} catch {}
	try {
		session._emit({ type: "message_end", message: card });
	} catch {}
}

function createProtectedReconciliation(message: CustomMessage, intentEntryId: string): CustomMessage {
	return {
		role: "custom",
		customType: PROTECTED_RECONCILIATION_CUSTOM_TYPE,
		content: message.content,
		display: false,
		details: { protectedReconciliationOf: intentEntryId } satisfies ProtectedReconciliationDetails,
		timestamp: message.timestamp,
	};
}

function completedReconciliationIntent(details: unknown): string | undefined {
	if (details === null || typeof details !== "object") return undefined;
	const intent = (details as { protectedReconciliationOf?: unknown }).protectedReconciliationOf;
	return typeof intent === "string" ? intent : undefined;
}

function protectedDelivery(marker: unknown): ProtectedDelivery | undefined {
	if (marker === null || typeof marker !== "object") return undefined;
	const delivery = (marker as { delivery?: unknown }).delivery;
	return delivery === "steer" || delivery === "followUp" ? delivery : undefined;
}

/** Durable card intents with neither a persisted hidden completion nor a scheduled one. */
export function pendingProtectedStreamingCustomMessages(session: AgentSession): PendingRecoveryDelivery[] {
	const branch = session.sessionManager.getBranch();
	// A resumed window can keep a reconciled card for another reason without its reconciliation (#6168).
	const completed = new Set([
		...(session.sessionManager.getSessionRecoveryState?.().reconciledCardIds ?? []),
		...branch.flatMap((entry) =>
			entry.type === "custom_message" && entry.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE
				? [completedReconciliationIntent(entry.details)].filter((intent): intent is string => intent !== undefined)
				: [],
		),
	]);
	const scheduled = new Set(
		protectedMessages(session).flatMap((entry) => {
			const intent = completedReconciliationIntent(entry.message.details);
			return intent === undefined ? [] : [intent];
		}),
	);
	const pending: PendingRecoveryDelivery[] = [];
	for (const entry of branch) {
		if (entry.type !== "custom_message") continue;
		const delivery = protectedDelivery(entry.protectedReconciliation);
		if (delivery === undefined || completed.has(entry.id) || scheduled.has(entry.id)) continue;
		pending.push({
			entryId: entry.id,
			customType: entry.customType,
			content: entry.content,
			details: entry.details,
			timestamp: entry.timestamp,
			...(entry.stageAdmissionKey === undefined ? {} : { stageAdmissionKey: entry.stageAdmissionKey }),
			delivery,
		});
	}
	return pending;
}

/** Requeue the hidden model-facing turn of each recovered durable card. */
export function recoverProtectedStreamingCustomMessages(
	session: AgentSession,
	pending: readonly PendingRecoveryDelivery[],
): number {
	for (const entry of pending) {
		const parsedTimestamp = Date.parse(entry.timestamp);
		const reconciliation: CustomMessage = {
			role: "custom",
			customType: PROTECTED_RECONCILIATION_CUSTOM_TYPE,
			content: entry.content,
			display: false,
			details: { protectedReconciliationOf: entry.entryId } satisfies ProtectedReconciliationDetails,
			timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now(),
		};
		protectedMessages(session).push({ message: reconciliation, delivery: entry.delivery, phase: "queued" });
		session._queueAgentMessage(reconciliation, entry.delivery);
	}
	return pending.length;
}

/** Close a recovered card without a model turn, so later resumes never offer it again. */
export async function dismissProtectedStreamingCustomMessage(
	session: AgentSession,
	pending: PendingRecoveryDelivery,
): Promise<void> {
	await session.sessionManager.appendCustomMessageEntry(
		PROTECTED_RECONCILIATION_CUSTOM_TYPE,
		pending.content,
		false,
		{ protectedReconciliationOf: pending.entryId, recovery: "dropped" } satisfies ProtectedReconciliationDetails,
		true,
	);
}

interface ProtectedAdmission {
	owner: AgentSession;
	cards: CustomMessage[];
	reconciliations: CustomMessage[];
}

interface PreparedCard {
	readonly card: CustomMessage;
	readonly intentEntryId: string;
	readonly reconciliation: CustomMessage;
}

/** How a queued batch reports its queueing, and what happens to the cards it saved before a later write failed. */
interface ProtectedBatchQueueing {
	/** Runs once reconciliations are queued, including those of a saved prefix queued after a failed write. */
	readonly onQueued?: () => void;
	/** Whether the saved prefix of a failed write is queued now; otherwise it waits for the retry or for recovery. */
	readonly queuesSavedPrefix?: () => boolean;
}

async function prepareProtectedAdmission(
	session: AgentSession,
	messages: CustomMessage[],
	delivery: ProtectedDelivery,
	commitBatch?: (admission: ProtectedAdmission) => void,
	queuesSavedPrefix: () => boolean = () => true,
): Promise<ProtectedAdmission> {
	// While the initiating tool is still executing, its assistant call
	// may be ahead of SessionManager's async event writer. Wait only in that
	// protocol-sensitive phase; at ordinary turn boundaries the hidden steer must
	// be queued synchronously so agent-core's next native poll observes it.
	if (session.agent.state.pendingToolCalls.size > 0) await session._agentEventQueue;
	const prepared: PreparedCard[] = [];
	const commit = (): ProtectedAdmission => {
		const admission = registerProtectedAdmission(session, prepared, delivery);
		if (admission.reconciliations.length > 0) commitBatch?.(admission);
		return admission;
	};
	try {
		for (const message of customMessageOccurrences(messages)) {
			const { card, intentEntryId } = await appendDurableDisplayCard(session, message, delivery);
			prepared.push({ card, intentEntryId, reconciliation: createProtectedReconciliation(message, intentEntryId) });
		}
	} catch (error) {
		// The cards saved before the failed write reach the model now, and a retry finds them registered and skips them.
		if (commitBatch !== undefined && prepared.length > 0 && queuesSavedPrefix()) commit();
		throw error;
	}
	return commit();
}

function registerProtectedAdmission(
	owner: AgentSession,
	prepared: readonly PreparedCard[],
	delivery: ProtectedDelivery,
): ProtectedAdmission {
	const registered = new Set(
		protectedMessages(owner).map((entry) => completedReconciliationIntent(entry.message.details)),
	);
	for (const entry of owner.sessionManager.getBranch()) {
		if (entry.type === "custom_message" && entry.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE)
			registered.add(completedReconciliationIntent(entry.details));
	}
	const unread = prepared.filter((entry) => {
		if (registered.has(entry.intentEntryId)) return false;
		registered.add(entry.intentEntryId);
		return true;
	});
	const cards = unread.map((entry) => entry.card);
	if (owner._disposed) return { owner, cards, reconciliations: [] };
	const reconciliations = unread.map((entry) => entry.reconciliation);
	protectedMessages(owner).push(
		...reconciliations.map((message) => ({ message, delivery, phase: "queued" as const })),
	);
	return { owner, cards, reconciliations };
}

function emitProtectedAdmission(admission: ProtectedAdmission): AgentSession {
	const owner = admission.owner;
	for (const card of admission.cards) {
		emitDurableDisplayCard(owner, card);
	}
	return owner;
}

/** Persist one visible card and register its hidden model-facing turn. */
export async function admitProtectedStreamingCustomMessage(
	session: AgentSession,
	message: CustomMessage,
	delivery: ProtectedDelivery,
): Promise<CustomMessage | undefined> {
	const admission = await prepareProtectedAdmission(session, [message], delivery);
	emitProtectedAdmission(admission);
	return admission.reconciliations[0];
}

const turnEndAdmissions = new WeakMap<AgentSession, Set<Promise<unknown>>>();

export function openTurnEndAdmissions(session: AgentSession): void {
	turnEndAdmissions.set(session, new Set());
}

export async function joinTurnEndAdmissions(session: AgentSession, signal?: AbortSignal): Promise<void> {
	const admissions = turnEndAdmissions.get(session);
	turnEndAdmissions.delete(session);
	if (admissions === undefined || admissions.size === 0 || signal?.aborted) return;
	const aborted = Promise.withResolvers<void>();
	const onAbort = () => aborted.resolve();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await Promise.race([Promise.allSettled(admissions), aborted.promise]);
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

function trackTurnEndAdmission<T>(session: AgentSession, admission: Promise<T>): Promise<T> {
	const admissions = turnEndAdmissions.get(session);
	if (admissions !== undefined) {
		admissions.add(admission);
		const release = () => admissions.delete(admission);
		void admission.then(release, release);
	}
	return admission;
}

/** Queue one hidden turn before public listeners can transfer its ownership. */
export function queueProtectedStreamingCustomMessage(
	session: AgentSession,
	message: CustomMessage,
	delivery: ProtectedDelivery,
	priority = false,
): Promise<void> {
	return trackTurnEndAdmission(
		session,
		prepareProtectedAdmission(session, [message], delivery).then((admission) => {
			for (const reconciliation of admission.reconciliations)
				admission.owner._queueAgentMessage(reconciliation, priority ? "interrupt" : delivery);
			emitProtectedAdmission(admission);
		}),
	);
}

/** Queue a whole hidden batch before public listeners can transfer ownership. */
export async function queueProtectedStreamingCustomMessages(
	session: AgentSession,
	messages: CustomMessage[],
	delivery: ProtectedDelivery,
	queueing: ProtectedBatchQueueing = {},
): Promise<number> {
	const admission = await trackTurnEndAdmission(
		session,
		prepareProtectedAdmission(
			session,
			messages,
			delivery,
			(admission) => {
				for (const reconciliation of admission.reconciliations) {
					admission.owner._queueAgentMessage(reconciliation, delivery);
				}
				emitProtectedAdmission(admission);
				queueing.onQueued?.();
			},
			queueing.queuesSavedPrefix,
		),
	);
	return admission.reconciliations.length;
}

export async function queueHeldCustomMessages(
	session: AgentSession,
	messages: CustomMessage[],
	delivery: ProtectedDelivery,
	queueing: ProtectedBatchQueueing = {},
): Promise<number> {
	let queued = 0;
	let contextual: CustomMessage[] = [];
	for (const message of customMessageOccurrences(messages)) {
		if (!customMessageExcludesContext(message)) {
			contextual.push(message);
			continue;
		}
		if (contextual.length > 0)
			queued += await queueProtectedStreamingCustomMessages(session, contextual, delivery, queueing);
		contextual = [];
		const { card, intentEntryId } = await appendDurableDisplayCard(session, message, undefined);
		const displayed = displayedCards(session);
		if (!displayed.has(intentEntryId)) {
			displayed.add(intentEntryId);
			emitDurableDisplayCard(session, card);
		}
	}
	if (contextual.length > 0)
		queued += await queueProtectedStreamingCustomMessages(session, contextual, delivery, queueing);
	return queued;
}

/** Start or queue an idle protected batch before exposing its display cards. */
export async function triggerProtectedStreamingCustomMessages(
	session: AgentSession,
	messages: CustomMessage[],
	delivery: ProtectedDelivery,
): Promise<void> {
	await prepareProtectedAdmission(session, messages, delivery, (admission) => {
		for (const reconciliation of admission.reconciliations) {
			admission.owner._queueAgentMessage(reconciliation, delivery);
		}
		const owner = emitProtectedAdmission(admission);
		if (owner.isStreaming || owner._isPreparingRun || owner._queuedMessagesPaused) return;
		for (const reconciliation of admission.reconciliations) {
			removeQueuedProtectedReference(owner, reconciliation);
		}
		const turn = owner._runAgentPrompt(admission.reconciliations);
		void turn.catch(() => {});
	});
}

/** Record that agent-core drained and consumed the hidden reconciliation. */
export function markProtectedStreamingCustomMessageConsumed(session: AgentSession, message: CustomMessage): boolean {
	const entry = protectedMessages(session).find((candidate) => candidate.message === message);
	if (!entry) return false;
	entry.phase = "consumed-unpersisted";
	return true;
}

export function markProtectedStreamingCustomMessagePersistenceFailed(
	session: AgentSession,
	message: CustomMessage,
): void {
	const entry = protectedMessages(session).find((candidate) => candidate.message === message);
	if (entry?.phase === "consumed-unpersisted") entry.phase = "persistence-failed";
}

/**
 * Whether a durable card of this custom type is admitted but its hidden turn is still queued, so the model has not
 * read it yet. Clearing the queue restores protected turns, so a queued entry ends only when it is consumed.
 */
export function hasUnreadProtectedCustomMessage(session: AgentSession, customType: string): boolean {
	return protectedMessages(session).some((entry) => {
		if (entry.phase !== "queued") return false;
		const intent = completedReconciliationIntent(entry.message.details);
		if (intent === undefined) return false;
		const card = session.sessionManager.getEntry(intent);
		return card?.type === "custom_message" && card.customType === customType;
	});
}

export function isProtectedStreamingCustomMessage(session: AgentSession, message: CustomMessage): boolean {
	return protectedMessages(session).some((entry) => entry.message === message);
}

/**
 * Persist a consumed hidden reconciliation exactly once. Its visible card was
 * already committed at admission, so a transient failure never re-adds a card
 * or re-injects another provider message.
 */
export async function persistProtectedStreamingCustomMessage(
	session: AgentSession,
	message: CustomMessage,
): Promise<boolean> {
	const pending = protectedMessages(session);
	const index = pending.findIndex((entry) => entry.message === message);
	if (index === -1) return false;
	const entry = pending[index];
	const admitted = message as StageAdmittedCustomMessage;
	if (entry.phase !== "consumed-unpersisted" && entry.phase !== "persistence-failed") return true;
	await session.sessionManager.appendCustomMessageEntry(
		message.customType,
		message.content,
		message.display,
		message.details,
		customMessageExcludesContext(message),
		undefined,
		admitted.stageAdmissionKey,
	);
	pending.splice(index, 1);
	return true;
}

/** Retry only hidden reconciliation persistence; never queue another alias. */
export async function retryConsumedProtectedStreamingCustomMessages(session: AgentSession): Promise<void> {
	// #4254: a run stopped on an unsaved message writes nothing more; the next prompt or disposal retries.
	if (session._persistenceFailure !== undefined) return;
	for (const entry of [...protectedMessages(session)]) {
		if (entry.phase !== "persistence-failed") continue;
		try {
			await persistProtectedStreamingCustomMessage(session, entry.message);
		} catch {
			// The visible lifecycle card is already durable. Keep this consumed phase
			// for a later event rather than duplicating either the card or model turn.
		}
	}
}

/**
 * #5135: appends stopped by another writer's entries are refused, not failed: the card stays pending in the store,
 * so the session that reopens delivers it.
 */
function refusedByConflictHalt(session: AgentSession, error: unknown): boolean {
	return error !== undefined && error === session.sessionManager.getAppendHalt();
}

/** Flush consumed reconciliations before session state can be discarded. */
export async function flushConsumedProtectedStreamingCustomMessages(session: AgentSession): Promise<void> {
	for (const entry of [...protectedMessages(session)]) {
		if (entry.phase === "queued") continue;
		// Do not swallow the final write failure: callers must keep this session
		// alive rather than discard the only remaining recovery state.
		try {
			await persistProtectedStreamingCustomMessage(session, entry.message);
		} catch (error) {
			if (!refusedByConflictHalt(session, error)) throw error;
		}
	}
}

function removeReference<T>(items: T[], message: T): void {
	let index = items.indexOf(message);
	while (index >= 0) {
		items.splice(index, 1);
		index = items.indexOf(message);
	}
}

function removeQueuedProtectedReference(session: AgentSession, message: CustomMessage): void {
	const hold = session._activeInterruptQueueHold;
	if (hold !== undefined) {
		removeReference(hold.steering, message);
		removeReference(hold.followUp, message);
	}
	const queues = session._drainQueuedAgentMessages();
	session._restoreQueuedAgentMessages({
		steering: queues.steering.filter((candidate) => candidate !== message),
		followUp: queues.followUp.filter((candidate) => candidate !== message),
	});
}

function isPausedHeldProtectedReference(session: AgentSession, message: CustomMessage): boolean {
	const hold = session._activeInterruptQueueHold;
	return (
		session._queuedMessagesPaused &&
		hold !== undefined &&
		(hold.steering.includes(message) || hold.followUp.includes(message))
	);
}

/**
 * Persist only reconciliation input already sealed inside an accepted pause
 * hold. Other queued input can still race an active protocol turn and must keep
 * the historical fail-closed disposal behavior.
 */
export async function prepareProtectedStreamingCustomMessagesForDisposal(session: AgentSession): Promise<void> {
	const pending = protectedMessages(session);
	const unsealed = pending.filter(
		(entry) => entry.phase === "queued" && !isPausedHeldProtectedReference(session, entry.message),
	);
	if (unsealed.length > 0) {
		if (!waitsOnDetachedResults(session))
			throw new Error("Cannot dispose a session with a queued protected reconciliation");
		// A reconciliation appended now would sit between the waiting call and its result. Its card keeps the pending
		// marker, so the session that reopens delivers it after the result (#4580).
		for (const entry of unsealed) {
			removeQueuedProtectedReference(session, entry.message);
			pending.splice(pending.indexOf(entry), 1);
		}
	}
	for (const entry of pending.filter((candidate) => candidate.phase === "queued")) {
		const admitted = entry.message as StageAdmittedCustomMessage;
		try {
			await session.sessionManager.appendCustomMessageEntry(
				entry.message.customType,
				entry.message.content,
				entry.message.display,
				entry.message.details,
				customMessageExcludesContext(entry.message),
				undefined,
				admitted.stageAdmissionKey,
			);
		} catch (error) {
			if (!refusedByConflictHalt(session, error)) throw error;
		}
		removeQueuedProtectedReference(session, entry.message);
		const index = pending.indexOf(entry);
		if (index >= 0) pending.splice(index, 1);
	}
	await flushConsumedProtectedStreamingCustomMessages(session);
}

/** Restore only protected references actually removed from native queues/hold. */
export function restoreProtectedStreamingCustomMessages(session: AgentSession, removed: DrainedAgentQueues): void {
	const removedReferences = new Set([...removed.steering, ...removed.followUp]);
	for (const entry of protectedMessages(session)) {
		if (entry.phase === "queued" && removedReferences.has(entry.message)) {
			session._queueAgentMessage(entry.message, entry.delivery);
		}
	}
}
