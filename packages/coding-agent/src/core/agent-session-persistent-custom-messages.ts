import type { DrainedAgentQueues } from "./agent-session-types.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { customMessageExcludesContext } from "./agent-session-types.ts";
import type { CustomMessage } from "./messages.ts";

type ProtectedDelivery = "steer" | "followUp";
type ProtectedPhase = "queued" | "consumed-unpersisted" | "persistence-failed";

export const PROTECTED_RECONCILIATION_CUSTOM_TYPE = "atomic:protected-streaming-reconciliation";

export interface ProtectedStreamingCustomMessage {
	message: CustomMessage;
	delivery: ProtectedDelivery;
	phase: ProtectedPhase;
}

function protectedMessages(session: AgentSession): ProtectedStreamingCustomMessage[] {
	return session._protectedStreamingCustomMessages ??= [];
}

function appendDurableDisplayCard(
	session: AgentSession,
	message: CustomMessage,
): CustomMessage & { excludeFromContext: true } {
	const card = { ...message, excludeFromContext: true } satisfies CustomMessage & { excludeFromContext: true };
	// Persist first: an admission receipt must never precede the durable card.
	session.sessionManager.appendCustomMessageEntry(
		card.customType,
		card.content,
		card.display,
		card.details,
		true,
	);
	session.agent.state.messages.push(card);
	return card;
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

/**
 * Persist the user-visible card, then create the hidden model-facing turn that
 * must wait for agent-core's protocol-safe steering/follow-up boundary.
 */
export async function admitProtectedStreamingCustomMessage(
	session: AgentSession,
	message: CustomMessage,
	delivery: ProtectedDelivery,
): Promise<CustomMessage> {
	// While the initiating workflow tool is still executing, its assistant call
	// may be ahead of SessionManager's async event writer. Wait only in that
	// protocol-sensitive phase; at ordinary turn boundaries the hidden steer must
	// be queued synchronously so agent-core's next native poll observes it.
	if (session.agent.state.pendingToolCalls.size > 0) await session._agentEventQueue;
	const card = appendDurableDisplayCard(session, message);
	const reconciliation = {
		role: "custom" as const,
		customType: PROTECTED_RECONCILIATION_CUSTOM_TYPE,
		content: message.content,
		display: false,
		details: undefined,
		timestamp: message.timestamp,
	} satisfies CustomMessage;
	// Register protection before notifying public card listeners. A reentrant
	// teardown must see this queued reconciliation and fail closed rather than
	// disconnecting the only session that can consume it.
	protectedMessages(session).push({ message: reconciliation, delivery, phase: "queued" });
	emitDurableDisplayCard(session, card);
	return reconciliation;
}

/** Queue a protected model-facing reconciliation after its card is durable. */
export async function queueProtectedStreamingCustomMessage(
	session: AgentSession,
	message: CustomMessage,
	delivery: ProtectedDelivery,
): Promise<void> {
	const reconciliation = await admitProtectedStreamingCustomMessage(session, message, delivery);
	session._queueAgentMessage(reconciliation, delivery);
}

/** Record that agent-core drained and consumed the hidden reconciliation. */
export function markProtectedStreamingCustomMessageConsumed(
	session: AgentSession,
	message: CustomMessage,
): boolean {
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
export function persistProtectedStreamingCustomMessage(
	session: AgentSession,
	message: CustomMessage,
): boolean {
	const pending = protectedMessages(session);
	const index = pending.findIndex((entry) => entry.message === message);
	if (index === -1) return false;
	const entry = pending[index];
	if (entry.phase !== "consumed-unpersisted" && entry.phase !== "persistence-failed") return true;
	session.sessionManager.appendCustomMessageEntry(
		message.customType,
		message.content,
		message.display,
		message.details,
		customMessageExcludesContext(message),
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

/** Fail closed for queued input, then flush consumed recovery state. */
export function prepareProtectedStreamingCustomMessagesForDisposal(session: AgentSession): void {
	if (protectedMessages(session).some((entry) => entry.phase === "queued")) {
		throw new Error("Cannot dispose a session with a queued protected reconciliation");
	}
	flushConsumedProtectedStreamingCustomMessages(session);
}

/** Restore only protected references actually removed from native queues/hold. */
export function restoreProtectedStreamingCustomMessages(
	session: AgentSession,
	removed: DrainedAgentQueues,
): void {
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
	protectedMessages(target).push(...moved);
}
