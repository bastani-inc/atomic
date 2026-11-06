import { ASK_REPLY_TIMEOUT_MS } from "../retry-policy.js";
import type { Message, SessionInfo } from "../types.js";
import {
	BROKER_LEASE_STALE_AFTER_MS,
	type IntercomBrokerStateStore,
	KNOWN_SESSION_RETENTION_MS,
	OUTBOX_CLAIM_STALE_AFTER_MS,
	type RecipientPresenceSubject,
	type ReboundPendingAsk,
	type ReleasedAsk,
	type ReleasedAskClaim,
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
	| {
			readonly kind: "deliver";
			readonly owner: ReleasedReplyOwner;
			readonly frame: ReleasedAskerReplyFrame;
			/** The claim this decision took; a reply answered from its row took none. */
			readonly claim?: ReleasedAskClaim;
	  };

export type ReleasedReplyDelivery = Extract<ReleasedReplyDecision, { readonly kind: "deliver" }>;

export type ReleasedReplyState = Pick<
	IntercomBrokerStateStore,
	"releasedAsks" | "reservations" | "leases" | "knownSessions" | "outbox"
>;

function refusalOf(ask: ReleasedAskRecord, messageId: string): IntercomReleasedReplyError {
	const fields = { messageId, questionId: ask.questionId, childName: ask.childName };
	return ask.state === "answered" ? new ReleasedReplyAnsweredError(fields) : new ReleasedReplyInFlightError(fields);
}

function refusalFor(ask: ReleasedAskRecord, messageId: string): ReleasedReplyDecision {
	return { kind: "refused", error: refusalOf(ask, messageId) };
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

/**
 * The owner that holds the released asker: the owner it left under, while that owner still holds its reservation or,
 * once the asker woke for another reason and its reservation ended that way, whose saved call still takes the reply.
 * None once the owner dropped it or left, another owner reserved its name, or it is gone, as for a route on the
 * asker's own broker.
 */
async function ownerOfAsker(state: ReleasedReplyState, ask: ReleasedAsk): Promise<ReleasedReplyOwner | undefined> {
	const read = await state.reservations.read(releasedReservationKey(ask.childName));
	if (read.status === "active") {
		const { reservation } = read;
		return reservation.gone === undefined && reservation.ownerSessionId === ask.ownerSessionId
			? ownerOfSession(state, ask.ownerSessionId)
			: undefined;
	}
	return read.status === "ended" && read.end.outcome !== "released"
		? ownerOfSession(state, ask.ownerSessionId)
		: undefined;
}

/** A reply already sent, retried, goes where its row went, whoever holds the asker now. */
async function ownerOfRow(state: ReleasedReplyState, messageId: string): Promise<ReleasedReplyOwner | undefined> {
	const read = await state.outbox.read(messageId);
	if (read.status !== "found") return undefined;
	const identity = read.row.targetIdentity;
	return (await liveSession(state, (subject) => subject.targetIdentity === identity)) ?? { identity, sessionId: "" };
}

/** How another reply's hold on the ask stands: still in force, or abandoned and takeable after `staleAfterMs`. */
type OtherReplyHold =
	| { readonly kind: "holds"; readonly ask: ReleasedAskRecord }
	| { readonly kind: "abandoned"; readonly other: string; readonly staleAfterMs: number };

/**
 * How the reply holding the ask stands. A claim whose reply's row failed is abandoned at once; one whose reply has no
 * row once it is as old as a stale outbox claim (this reply's own claim from before a crash is then simply kept). A
 * delivered row whose answer was never recorded is recorded now.
 */
async function otherReplyHold(state: ReleasedReplyState, ask: ReleasedAskRecord, other: string): Promise<OtherReplyHold> {
	const row = await state.outbox.read(other);
	if (row.status !== "found") return { kind: "abandoned", other, staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS };
	if (row.row.state === "failed") return { kind: "abandoned", other, staleAfterMs: Number.NEGATIVE_INFINITY };
	if (row.row.state !== "delivered") return { kind: "holds", ask };
	await state.releasedAsks.answer({ questionId: ask.questionId, replierSessionId: ask.replierSessionId, replyMessageId: other });
	return { kind: "holds", ask: { ...ask, state: "answered" } };
}

/**
 * Decide whether a reply answers a released asker's question, and claim the question for it. A reply already sent is
 * answered from its row and never claims again; a question another reply holds refuses this one with a typed error,
 * unless that reply's claim can no longer settle. Anything that is not such a reply is `undefined`: route it as any
 * other send.
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
	const frame: ReleasedAskerReplyFrame = {
		type: "released_child_reply",
		childName: ask.childName,
		replyTo,
		from: request.from.info,
		message: request.message,
	};
	const sent = await ownerOfRow(state, messageId);
	if (sent !== undefined) return { kind: "deliver", owner: sent, frame };
	const holder = ask.replyMessageId;
	const hold = holder === undefined ? undefined : await otherReplyHold(state, ask, holder);
	if (hold?.kind === "holds") return refusalFor(hold.ask, messageId);
	const owner = await ownerOfAsker(state, ask);
	if (owner === undefined) return undefined;
	const claim = { ...key, replyMessageId: messageId };
	const claimed =
		hold?.kind === "abandoned"
			? await state.releasedAsks.supersede({ ...claim, staleReplyMessageId: hold.other, staleAfterMs: hold.staleAfterMs })
			: await state.releasedAsks.claim(claim);
	if (claimed.status === "taken") return refusalFor(claimed.ask, messageId);
	if (claimed.status !== "claimed") return undefined;
	return { kind: "deliver", owner, frame, claim };
}

/**
 * The owner's broker hands a reply over only while the reply holds its question, so the late row of a reply whose
 * claim another reply took over is refused instead of reaching the owner as a second answer. The refusal, if any.
 */
export async function releasedReplyHandoffRefusal(
	state: Pick<IntercomBrokerStateStore, "releasedAsks">,
	frame: ReleasedAskerReplyFrame,
): Promise<string | undefined> {
	const claimed = await state.releasedAsks.claim({
		questionId: frame.replyTo,
		replierSessionId: frame.from.id,
		replyMessageId: frame.message.id,
	});
	if (claimed.status === "claimed") return undefined;
	return claimed.status === "taken"
		? refusalOf(claimed.ask, frame.message.id).message
		: releasedAskerReplyRefusal(frame.childName);
}

/**
 * A supervised subagent left: its asks still waiting in the shared state are kept for its owner before they are
 * pruned, so a reply after it was released still reaches it (the local path keeps its own questions likewise).
 */
export async function keepReleasedAsks(
	state: Pick<IntercomBrokerStateStore, "pendingAsks" | "releasedAsks">,
	asker: { readonly info: SessionInfo; readonly supervisorId?: string; readonly registrationName?: string },
): Promise<void> {
	const { registrationName: childName, supervisorId: ownerSessionId } = asker;
	if (ownerSessionId === undefined || childName === undefined) return;
	const listed = await state.pendingAsks.listForSender(asker.info.id);
	if (listed.status !== "listed" || listed.asks.length === 0) return;
	await state.releasedAsks.keep(
		listed.asks.map((ask) => ({
			questionId: ask.messageId,
			askerSessionId: ask.senderSessionId,
			replierSessionId: ask.targetSessionId,
			childName,
			ownerSessionId,
		})),
		ASK_REPLY_TIMEOUT_MS,
	);
}

/** The subagent a departing session's owner released, as broker.ts knows it when the session leaves. */
export interface ReleasedTarget {
	readonly ownerSessionId: string;
	readonly childName: string;
}

/**
 * #4386: asks addressed to a departing session end with it, unless its owner released it: those are parked for the
 * owner, still answerable by the subagent, until it registers again on any node. A departing owner's parked asks end
 * with it, as its local parked questions do.
 */
export async function settleAsksToDeparted(
	state: Pick<IntercomBrokerStateStore, "pendingAsks">,
	sessionId: string,
	released: ReleasedTarget | undefined,
): Promise<void> {
	if (released === undefined) await state.pendingAsks.takeForTarget(sessionId);
	else {
		await state.pendingAsks.parkForTarget(sessionId, {
			ownerSessionId: released.ownerSessionId,
			reservationKey: releasedReservationKey(released.childName),
		});
	}
	await state.pendingAsks.takeParked(sessionId);
}

/** A released subagent registering again under the capability its owner issued. */
export interface ReleasedRegistration {
	readonly childName: string;
	readonly authorizedBy: string;
}

/**
 * The released subagent registered again, on any node, under the capability its owner issued: its parked asks follow
 * it to this session. Returns the asks whose target changed, whose askers must be told (`peer_rebound`).
 */
export async function rebindParkedAsks(
	state: Pick<IntercomBrokerStateStore, "pendingAsks">,
	registered: ReleasedRegistration,
	sessionId: string,
): Promise<ReboundPendingAsk[]> {
	const rebound = await state.pendingAsks.rebindParked(
		{ ownerSessionId: registered.authorizedBy, reservationKey: releasedReservationKey(registered.childName) },
		sessionId,
	);
	return rebound.status === "rebound" ? rebound.asks.filter((ask) => ask.previousTargetSessionId !== sessionId) : [];
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
