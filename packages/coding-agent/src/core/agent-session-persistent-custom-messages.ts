import { resolveWorkflowStageDeliveryTarget } from "./agent-session-delivery-forwarding.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { DrainedAgentQueues } from "./agent-session-types.ts";
import { customMessageExcludesContext } from "./agent-session-types.ts";
import type { CustomMessage, StageAdmittedCustomMessage } from "./messages.ts";

type ProtectedDelivery = "steer" | "followUp";
type ProtectedPhase = "queued" | "consumed-unpersisted" | "persistence-failed";

export const PROTECTED_RECONCILIATION_CUSTOM_TYPE = "atomic:protected-streaming-reconciliation";

interface ProtectedReconciliationDetails {
	protectedReconciliationOf: string;
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

function appendDurableDisplayCard(
	session: AgentSession,
	message: CustomMessage,
	delivery: ProtectedDelivery,
): { readonly card: CustomMessage & { excludeFromContext: true }; readonly intentEntryId: string } {
	const card = { ...message, excludeFromContext: true } satisfies CustomMessage & { excludeFromContext: true };
	const admitted = message as StageAdmittedCustomMessage;
	// The card and recovery marker share one append, so either both survive a
	// process exit or neither does.
	const intentEntryId = session.sessionManager.appendCustomMessageEntry(
		card.customType,
		card.content,
		card.display,
		card.details,
		true,
		{ delivery },
		admitted.stageAdmissionKey,
	);
	session.agent.state.messages.push(card);
	return { card, intentEntryId };
}

function emitDurableDisplayCard(session: AgentSession, card: CustomMessage): void {
	// The card is already live and file-backed, and its protected reconciliation
	// is registered. Public listeners remain fallible, but their errors cannot
	// revoke admission or make the producer retry this committed occurrence.
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

/** Requeue each durable card intent that has no persisted hidden completion. */
export function recoverProtectedStreamingCustomMessages(session: AgentSession): number {
	const branch = session.sessionManager.getBranch();
	const completed = new Set(
		branch.flatMap((entry) =>
			entry.type === "custom_message" && entry.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE
				? [completedReconciliationIntent(entry.details)].filter((intent): intent is string => intent !== undefined)
				: [],
		),
	);
	const scheduled = new Set(
		protectedMessages(session).flatMap((entry) => {
			const intent = completedReconciliationIntent(entry.message.details);
			return intent === undefined ? [] : [intent];
		}),
	);
	let recovered = 0;
	for (const entry of branch) {
		if (entry.type !== "custom_message") continue;
		const delivery = protectedDelivery(entry.protectedReconciliation);
		if (delivery === undefined || completed.has(entry.id) || scheduled.has(entry.id)) continue;
		const parsedTimestamp = Date.parse(entry.timestamp);
		const card: CustomMessage = {
			role: "custom",
			customType: entry.customType,
			content: entry.content,
			display: entry.display,
			details: entry.details,
			timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now(),
		};
		const reconciliation = createProtectedReconciliation(card, entry.id);
		protectedMessages(session).push({ message: reconciliation, delivery, phase: "queued" });
		session._queueAgentMessage(reconciliation, delivery);
		recovered += 1;
	}
	return recovered;
}

interface ProtectedAdmission {
	owner: AgentSession;
	cards: CustomMessage[];
	reconciliations: CustomMessage[];
}

async function prepareProtectedAdmission(
	session: AgentSession,
	messages: CustomMessage[],
	delivery: ProtectedDelivery,
): Promise<ProtectedAdmission> {
	// While the initiating workflow tool is still executing, its assistant call
	// may be ahead of SessionManager's async event writer. Wait only in that
	// protocol-sensitive phase; at ordinary turn boundaries the hidden steer must
	// be queued synchronously so agent-core's next native poll observes it.
	if (session.agent.state.pendingToolCalls.size > 0) await session._agentEventQueue;
	const owner = resolveWorkflowStageDeliveryTarget(session);
	const prepared = messages.map((message) => {
		const { card, intentEntryId } = appendDurableDisplayCard(owner, message, delivery);
		return { card, reconciliation: createProtectedReconciliation(message, intentEntryId) };
	});
	const cards = prepared.map((entry) => entry.card);
	const reconciliations = prepared.map((entry) => entry.reconciliation);
	protectedMessages(owner).push(
		...reconciliations.map((message) => ({ message, delivery, phase: "queued" as const })),
	);
	return { owner, cards, reconciliations };
}

function emitProtectedAdmission(admission: ProtectedAdmission): AgentSession {
	let owner = admission.owner;
	for (const card of admission.cards) {
		owner = resolveWorkflowStageDeliveryTarget(owner);
		emitDurableDisplayCard(owner, card);
	}
	return resolveWorkflowStageDeliveryTarget(owner);
}

/** Persist one visible card and register its hidden model-facing turn. */
export async function admitProtectedStreamingCustomMessage(
	session: AgentSession,
	message: CustomMessage,
	delivery: ProtectedDelivery,
): Promise<CustomMessage> {
	const admission = await prepareProtectedAdmission(session, [message], delivery);
	emitProtectedAdmission(admission);
	return admission.reconciliations[0]!;
}

/** Queue one hidden turn before public listeners can transfer its ownership. */
export async function queueProtectedStreamingCustomMessage(
	session: AgentSession,
	message: CustomMessage,
	delivery: ProtectedDelivery,
): Promise<void> {
	const admission = await prepareProtectedAdmission(session, [message], delivery);
	admission.owner._queueAgentMessage(admission.reconciliations[0]!, delivery);
	emitProtectedAdmission(admission);
}

/** Queue a whole hidden batch before public listeners can transfer ownership. */
export async function queueProtectedStreamingCustomMessages(
	session: AgentSession,
	messages: CustomMessage[],
	delivery: ProtectedDelivery,
): Promise<void> {
	const admission = await prepareProtectedAdmission(session, messages, delivery);
	for (const reconciliation of admission.reconciliations) {
		admission.owner._queueAgentMessage(reconciliation, delivery);
	}
	emitProtectedAdmission(admission);
}

/** Start or queue an idle protected batch before exposing its display cards. */
export async function triggerProtectedStreamingCustomMessages(
	session: AgentSession,
	messages: CustomMessage[],
	delivery: ProtectedDelivery,
): Promise<void> {
	const admission = await prepareProtectedAdmission(session, messages, delivery);
	for (const reconciliation of admission.reconciliations) {
		admission.owner._queueAgentMessage(reconciliation, delivery);
	}
	const owner = emitProtectedAdmission(admission);
	if (owner.isStreaming || owner._queuedMessagesPaused) return;
	for (const reconciliation of admission.reconciliations) {
		removeQueuedProtectedReference(owner, reconciliation);
	}
	const turn = owner._runAgentPrompt(admission.reconciliations);
	void turn.catch(() => {});
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

export function isProtectedStreamingCustomMessage(session: AgentSession, message: CustomMessage): boolean {
	return protectedMessages(session).some((entry) => entry.message === message);
}

/**
 * Persist a consumed hidden reconciliation exactly once. Its visible card was
 * already committed at admission, so a transient failure never re-adds a card
 * or re-injects another provider message.
 */
export function persistProtectedStreamingCustomMessage(session: AgentSession, message: CustomMessage): boolean {
	const pending = protectedMessages(session);
	const index = pending.findIndex((entry) => entry.message === message);
	if (index === -1) return false;
	const entry = pending[index];
	const admitted = message as StageAdmittedCustomMessage;
	if (entry.phase !== "consumed-unpersisted" && entry.phase !== "persistence-failed") return true;
	session.sessionManager.appendCustomMessageEntry(
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
export function retryConsumedProtectedStreamingCustomMessages(session: AgentSession): void {
	for (const entry of [...protectedMessages(session)]) {
		if (entry.phase !== "persistence-failed") continue;
		try {
			persistProtectedStreamingCustomMessage(session, entry.message);
		} catch {
			// The visible lifecycle card is already durable. Keep this consumed phase
			// for a later event rather than duplicating either the card or model turn.
		}
	}
}

/** Flush consumed reconciliations before session state can be discarded. */
export function flushConsumedProtectedStreamingCustomMessages(session: AgentSession): void {
	for (const entry of [...protectedMessages(session)]) {
		if (entry.phase === "queued") continue;
		// Do not swallow the final write failure: callers must keep this session
		// alive rather than discard the only remaining recovery state.
		persistProtectedStreamingCustomMessage(session, entry.message);
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
export function prepareProtectedStreamingCustomMessagesForDisposal(session: AgentSession): void {
	const pending = protectedMessages(session);
	const queued = pending.filter((entry) => entry.phase === "queued");
	if (queued.some((entry) => !isPausedHeldProtectedReference(session, entry.message))) {
		throw new Error("Cannot dispose a session with a queued protected reconciliation");
	}
	for (const entry of queued) {
		const admitted = entry.message as StageAdmittedCustomMessage;
		session.sessionManager.appendCustomMessageEntry(
			entry.message.customType,
			entry.message.content,
			entry.message.display,
			entry.message.details,
			customMessageExcludesContext(entry.message),
			undefined,
			admitted.stageAdmissionKey,
		);
		removeQueuedProtectedReference(session, entry.message);
		const index = pending.indexOf(entry);
		if (index >= 0) pending.splice(index, 1);
	}
	flushConsumedProtectedStreamingCustomMessages(session);
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

/** Move protection only for message references that transfer with native queues. */
export function transferProtectedStreamingCustomMessages(
	source: AgentSession,
	target: AgentSession,
	transferred: DrainedAgentQueues,
): void {
	const transferredReferences = new Set([...transferred.steering, ...transferred.followUp]);
	const retained: ProtectedStreamingCustomMessage[] = [];
	const moved: ProtectedStreamingCustomMessage[] = [];
	for (const entry of protectedMessages(source)) {
		if (entry.phase === "queued" && transferredReferences.has(entry.message)) moved.push(entry);
		else retained.push(entry);
	}
	source._protectedStreamingCustomMessages = retained;
	protectedMessages(target).unshift(...moved);
}
