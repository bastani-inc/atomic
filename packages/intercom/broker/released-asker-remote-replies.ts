import { ASK_REPLY_TIMEOUT_MS } from "../retry-policy.js";
import type { Message, SessionInfo } from "../types.js";
import {
	BROKER_LEASE_STALE_AFTER_MS,
	type IntercomBrokerStateStore,
	KNOWN_SESSION_RETENTION_MS,
	type RecipientPresenceSubject,
	type ReleasedAsk,
	type ReleasedAskerReplyFrame,
	type ReleasedAskRecord,
} from "./multinode-state-store.js";
import { UNCERTAIN_RECEIPT_REASON } from "./recipient-receipts.js";
import { normalizeReservationTarget, releasedReservationKey } from "./released-children.js";
import {
	type IntercomReleasedReplyError,
	ReleasedReplyAnsweredError,
	ReleasedReplyInFlightError,
} from "./released-reply-errors.js";

/**
 * #4386: replies to supervised subagents that were released while they waited on a question asked of a session on
 * another node. The asker's broker keeps the question in the shared state when the asker leaves; a broker that a
 * reply reaches claims it there once, and sends the reply through the shared outbox to the subagent's owner, which
 * wakes the subagent with it exactly as for a reply on its own broker (#4326).
 */

/** Why the owner refused a reply to its released subagent: the subagent no longer waits for it. */
export function releasedAskerReplyRefusal(childName: string): string {
	return `Subagent \`${childName}\` is released and no longer waiting for this reply`;
}

export interface ReleasedReplyRequest {
	readonly from: { readonly info: SessionInfo };
	readonly message: Message;
	/** The trimmed `to`. */
	readonly target: string;
	readonly supervisorSend: boolean;
	readonly expectedRecipientId?: string;
}

/** A reply that may answer a released asker: it answers a question, is not itself one, and is no supervisor send. */
export function isReleasedReplyCandidate<Request extends Pick<ReleasedReplyRequest, "message" | "supervisorSend">>(
	request: Request,
): request is Request & { readonly message: Message & { readonly replyTo: string } } {
	return !request.supervisorSend && request.message.replyTo !== undefined && request.message.expectsReply !== true;
}

/** The reply is addressed to the asker: by its session id or its name, and to the recipient it expects, if any. */
export function addressesReleasedAsker(ask: ReleasedAsk, target: string, expectedRecipientId?: string): boolean {
	if (expectedRecipientId !== undefined && expectedRecipientId !== ask.askerSessionId) return false;
	return target === ask.askerSessionId || normalizeReservationTarget(target) === normalizeReservationTarget(ask.childName);
}

/** The released asker's owner, where the reply goes: live on `hostBrokerId`, or offline when it is absent. */
export interface ReleasedReplyOwner {
	readonly identity: string;
	readonly sessionId: string;
	readonly hostBrokerId?: string;
}

export type ReleasedReplyDecision =
	| { readonly kind: "refused"; readonly error: IntercomReleasedReplyError }
	/** This reply holds the question: send `frame` to the owner, or answer a retry from the row already sent. */
	| { readonly kind: "deliver"; readonly owner: ReleasedReplyOwner; readonly frame: ReleasedAskerReplyFrame };

export type ReleasedReplyState = Pick<
	IntercomBrokerStateStore,
	"releasedAsks" | "reservations" | "leases" | "knownSessions" | "outbox"
>;

function refusalFor(ask: ReleasedAskRecord, messageId: string): ReleasedReplyDecision {
	const fields = { messageId, questionId: ask.questionId, childName: ask.childName };
	return {
		kind: "refused",
		error: ask.state === "answered" ? new ReleasedReplyAnsweredError(fields) : new ReleasedReplyInFlightError(fields),
	};
}

/** The first live presence that matches, with the broker hosting it. */
async function liveSession(
	state: ReleasedReplyState,
	matches: (subject: RecipientPresenceSubject) => boolean,
): Promise<ReleasedReplyOwner | undefined> {
	for (const lease of await state.leases.listLive("presence", BROKER_LEASE_STALE_AFTER_MS)) {
		const subject = lease.subject as RecipientPresenceSubject;
		if (matches(subject)) {
			return { identity: subject.targetIdentity, sessionId: subject.session.id, hostBrokerId: lease.holderId };
		}
	}
	return undefined;
}

/** The owner where it is connected now, or where it last was, so the reply waits there for it. */
async function ownerOfSession(state: ReleasedReplyState, ownerSessionId: string): Promise<ReleasedReplyOwner | undefined> {
	const live = await liveSession(state, (subject) => subject.session.id === ownerSessionId);
	if (live !== undefined) return live;
	const known = await state.knownSessions.lookup(ownerSessionId, KNOWN_SESSION_RETENTION_MS);
	const session =
		known.status === "found" ? known.sessions.find((candidate) => candidate.intercomSessionId === ownerSessionId) : undefined;
	return session === undefined ? undefined : { identity: session.targetIdentity, sessionId: ownerSessionId };
}

/** The owner that holds the released asker now; none once the owner dropped it or the asker came back. */
async function ownerOfAsker(state: ReleasedReplyState, ask: ReleasedAsk): Promise<ReleasedReplyOwner | undefined> {
	const read = await state.reservations.read(releasedReservationKey(ask.childName));
	if (read.status !== "active" || read.reservation.gone !== undefined) return undefined;
	return ownerOfSession(state, read.reservation.ownerSessionId);
}

/** A reply already sent, retried, goes where its row went, whoever holds the asker now. */
async function ownerOfRow(state: ReleasedReplyState, messageId: string): Promise<ReleasedReplyOwner | undefined> {
	const read = await state.outbox.read(messageId);
	if (read.status !== "found") return undefined;
	const identity = read.row.targetIdentity;
	return (await liveSession(state, (subject) => subject.targetIdentity === identity)) ?? { identity, sessionId: "" };
}

/**
 * Decide whether a reply answers a released asker's question, and claim the question for it. A question another reply
 * holds refuses this one with a typed error. Anything that is not such a reply is `undefined`: route it as any other
 * send.
 */
export async function decideReleasedAskerReply(
	state: ReleasedReplyState,
	request: ReleasedReplyRequest,
): Promise<ReleasedReplyDecision | undefined> {
	if (!isReleasedReplyCandidate(request)) return undefined;
	const replyTo = request.message.replyTo;
	const key = { questionId: replyTo, replierSessionId: request.from.info.id };
	const found = await state.releasedAsks.lookup(key);
	if (found.status !== "found" || !addressesReleasedAsker(found.ask, request.target, request.expectedRecipientId)) {
		return undefined;
	}
	const { ask } = found;
	const messageId = request.message.id;
	if (ask.state !== "open" && ask.replyMessageId !== messageId) return refusalFor(ask, messageId);
	const owner = (await ownerOfRow(state, messageId)) ?? (await ownerOfAsker(state, ask));
	if (owner === undefined) return undefined;
	const claimed = await state.releasedAsks.claim({ ...key, replyMessageId: messageId });
	if (claimed.status === "taken") return refusalFor(claimed.ask, messageId);
	if (claimed.status !== "claimed") return undefined;
	return {
		kind: "deliver",
		owner,
		frame: { type: "released_child_reply", childName: ask.childName, replyTo, from: request.from.info, message: request.message },
	};
}

/**
 * A supervised subagent left: its asks still waiting in the shared state are kept for its owner before they are
 * pruned, so a reply after it was released still reaches it (the local path keeps its own questions likewise).
 */
export async function keepReleasedAsks(
	state: Pick<IntercomBrokerStateStore, "pendingAsks" | "releasedAsks">,
	asker: { readonly info: SessionInfo; readonly supervisorId?: string; readonly registrationName?: string },
): Promise<void> {
	const childName = asker.registrationName;
	if (asker.supervisorId === undefined || childName === undefined) return;
	const listed = await state.pendingAsks.listForSender(asker.info.id);
	if (listed.status !== "listed" || listed.asks.length === 0) return;
	await state.releasedAsks.keep(
		listed.asks.map((ask) => ({
			questionId: ask.messageId,
			askerSessionId: ask.senderSessionId,
			replierSessionId: ask.targetSessionId,
			childName,
		})),
		ASK_REPLY_TIMEOUT_MS,
	);
}

export type ReleasedReplyAckOutcome =
	| { readonly kind: "delivered" }
	/** `reopen`: the question may take another reply; `answer`: an earlier handoff may have been saved, so it may not. */
	| { readonly kind: "refused"; readonly reason: string; readonly question: "reopen" | "answer" };

/**
 * The owner's answer to a handoff. A refusal of the first handoff means the subagent no longer waits for the reply.
 * A refusal of a later one may only mean the owner saved an earlier handoff whose answer was lost, so the sender is
 * told the outcome is uncertain and no other reply is handed over.
 */
export function releasedReplyAckOutcome(accepted: boolean, attempt: number, childName: string): ReleasedReplyAckOutcome {
	if (accepted) return { kind: "delivered" };
	return attempt <= 1
		? { kind: "refused", reason: releasedAskerReplyRefusal(childName), question: "reopen" }
		: { kind: "refused", reason: UNCERTAIN_RECEIPT_REASON, question: "answer" };
}
