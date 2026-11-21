import { createHash } from "node:crypto";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import type { BrokerMessage, ClientMessage, ReachPolicyFrame, SessionInfo } from "../types.js";
import type { EndedChildQueueStore } from "./sql-ended-child-queue-store.js";
import { isReleasedReservationKey } from "./released-children.js";

/**
 * Multi-node broker state seams (specs/2026-10-19-intercom-multi-node.md). Brokers on different hosts share this
 * state through the selected `storage` adapter; the database is the source of truth and wake-ups are only hints.
 *
 * Shared conventions:
 * - Every operation reports its outcome as a discriminated result; an empty identifier yields `invalid`.
 * - Ages are measured on the store clock (the database clock for SQL stores), never the caller's clock.
 * - A lease or claim is live while `ageMs <= staleAfterMs`; a negative `staleAfterMs` treats it as expired.
 * - Expiry only makes a lease or claim takeable. Its token is fenced (rejected as `stale`) once another
 *   acquisition supersedes it; until then the holder may still renew it.
 * - Text, frames and requests are stored and returned verbatim, and returned values are detached copies.
 * - Lists come back in insertion order unless an operation says otherwise.
 */

/** How often a broker renews its membership and presence leases. */
export const BROKER_LEASE_RENEW_INTERVAL_MS = 10_000;
/** Age after which another broker may take a membership or presence lease over. */
export const BROKER_LEASE_STALE_AFTER_MS = 30_000;
/** Age after which another broker may claim an outbox row whose claimant stopped renewing. */
export const OUTBOX_CLAIM_STALE_AFTER_MS = 30_000;
/** Safety-net outbox scan interval for brokers whose wake-ups were lost. */
export const OUTBOX_BACKUP_POLL_INTERVAL_MS = 30_000;
/** How long a session that left stays known, so a send to it is queued for its return (spec §14, S5 amendment). */
export const KNOWN_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * #4896: most undelivered outbox rows one recipient may have; a send past it is refused, and rows already queued stay.
 * Undelivered rows are those queued for a session that is away, or still being delivered.
 */
export const OUTBOX_TARGET_MAX_ROWS = 1_000;
/** #4896: most bytes of serialized frames one recipient's undelivered outbox rows may hold together. */
export const OUTBOX_TARGET_MAX_BYTES = 64 * 1024 * 1024;
/** #4896: the failure an outbox row records when it expires unclaimed, after its recipient stayed away too long. */
export const OUTBOX_EXPIRED_REASON = `The recipient did not return within the known-session retention of ${
	KNOWN_SESSION_RETENTION_MS / (24 * 60 * 60 * 1000)
} days; the queued message expired undelivered`;

/** The exact frame a broker writes to a recipient's socket; a cross-node delivery writes the same frame. */
export type IntercomDeliveryFrame = Extract<BrokerMessage, { type: "message" }> & {
	readonly senderReach?: ReachPolicyFrame;
};

/**
 * #4386: a reply to a subagent released while it waited on the question, for the subagent's owner. The owner's broker
 * writes it with a new `handoffId` for each handoff, and the owner answers it with `released_child_reply_ack`.
 */
export type ReleasedAskerReplyFrame = Omit<Extract<BrokerMessage, { type: "released_child_reply" }>, "handoffId">;

/** What an outbox row writes to its recipient; its `message.id` is the row's message id. */
export type OutboxFrame = IntercomDeliveryFrame | ReleasedAskerReplyFrame;

/** A send held for a recipient being restored (#3760), dispatched again verbatim when the hold ends. */
export type HeldSendRequest = Extract<ClientMessage, { type: "send" | "supervisor_send" }>;

export type StateStoreInvalidReason =
	| "empty-broker-id"
	| "empty-holder-id"
	| "empty-claimant-id"
	| "empty-target-identity"
	| "empty-message-id"
	| "empty-reservation-key"
	| "empty-session-id"
	| "empty-child-name"
	| "empty-target"
	| "empty-group"
	| "subject-key-mismatch";

export interface InvalidStateInput {
	readonly status: "invalid";
	readonly reason: StateStoreInvalidReason;
}

export type LeaseKind = "broker" | "presence";

/** Broker membership: one row per running broker process, keyed by its random `brokerId`. */
export interface BrokerMembershipSubject {
	readonly kind: "broker";
	readonly brokerId: string;
	/** Host label for diagnostics and future direct forwarding; not used for routing. */
	readonly nodeId: string;
	readonly startedAt: number;
	/**
	 * #4997: the broker's durable state on its host, the same across its restarts: a broker that crashed and is not back
	 * under the same home may keep ask routes no other broker has. Absent from older brokers.
	 */
	readonly home?: string;
	/**
	 * #5038: what a restart of this broker keeps: its host (node, boot and process namespace) and its socket path. A
	 * broker starting with the same key retires the leases and claims of an earlier instance whose `pid` has exited.
	 */
	readonly instanceKey?: string;
	/** #5038: the broker's process id, checked on its host before a later instance supersedes it. */
	readonly pid?: number;
}

/** Recipient presence: which broker currently hosts the recipient's socket. */
export interface RecipientPresenceSubject {
	readonly kind: "presence";
	/** Stable recipient authority (`deliveryTargetIdentity`), which survives reconnects. */
	readonly targetIdentity: string;
	readonly session: SessionInfo;
}

export type LeaseSubject = BrokerMembershipSubject | RecipientPresenceSubject;

export type LeaseKey =
	| { readonly kind: "broker"; readonly brokerId: string }
	| { readonly kind: "presence"; readonly targetIdentity: string };

export interface Lease {
	readonly key: LeaseKey;
	/** The `brokerId` holding the lease. */
	readonly holderId: string;
	/** Positive safe integer, strictly greater than every earlier token for the same key, including released ones. */
	readonly fencingToken: number;
}

export interface LeaseState extends Lease {
	readonly subject: LeaseSubject;
	/** Store-clock milliseconds since the lease was acquired or last renewed; a non-negative safe integer. */
	readonly ageMs: number;
}

export type LeaseAcquireResult =
	| { readonly status: "acquired"; readonly lease: Lease }
	| { readonly status: "held"; readonly holderId: string; readonly fencingToken: number }
	| InvalidStateInput;

export type LeaseStaleResult = {
	readonly status: "stale";
	/** Present while the key has a holder. */
	readonly currentFencingToken?: number;
};

export type LeaseRenewResult = { readonly status: "renewed" } | LeaseStaleResult | InvalidStateInput;
export type LeaseReleaseResult = { readonly status: "released" } | LeaseStaleResult | InvalidStateInput;
export type LeaseReadResult =
	| { readonly status: "found"; readonly lease: LeaseState }
	| { readonly status: "missing" }
	| InvalidStateInput;

/** S1: broker membership and recipient presence leases with fencing tokens. */
export interface BrokerLeaseStore {
	/**
	 * Take the subject's lease when it is unheld or older than `staleAfterMs`. The current holder re-acquiring keeps
	 * its token, resets the age and replaces the subject. Otherwise the live holder is reported as `held`.
	 */
	acquire(subject: LeaseSubject, holderId: string, staleAfterMs: number): Promise<LeaseAcquireResult>;
	/** Reset the age, replacing the subject when one is given. A superseded token is `stale`. */
	renew(lease: Lease, subject?: LeaseSubject): Promise<LeaseRenewResult>;
	/** Give the lease up; the next acquisition still gets a greater token. A non-holder's release is `stale`. */
	release(lease: Lease): Promise<LeaseReleaseResult>;
	/** Current holder of the key at any age; `missing` when unheld. */
	read(key: LeaseKey): Promise<LeaseReadResult>;
	/** Live leases of one kind, in the order their keys were first acquired. */
	listLive(kind: LeaseKind, staleAfterMs: number): Promise<LeaseState[]>;
	/**
	 * #5038: give up every lease `holderId` holds, as its own `release` would, so their next acquisitions need not
	 * wait for them to go stale. Resolves to the number of leases retired.
	 */
	retireHolder(holderId: string): Promise<number>;
}

export type OutboxRowState = "queued" | "claimed" | "delivered" | "failed";

export interface OutboxEnqueueRequest {
	/** Stable recipient authority the row is addressed to. */
	readonly targetIdentity: string;
	/** Broker holding the sender's socket; it is woken with `outcome` once the row settles. */
	readonly originBrokerId: string;
	/** Caller-computed send digest; the same message id with another digest is a conflict. */
	readonly digest: string;
	/** Written verbatim to the recipient; its `message.id` is the row's message id. */
	readonly frame: OutboxFrame;
	/**
	 * #4992: a failure the broker owes the recipient for one of its open asks. It is queued past the recipient's
	 * `OUTBOX_TARGET_MAX_ROWS` and `OUTBOX_TARGET_MAX_BYTES`: it is small, there is at most one per open ask, and
	 * refusing it would leave the ask waiting forever.
	 */
	readonly owed?: boolean;
	/**
	 * #5607: the sender found the recipient offline. In the write that inserts the row, the broker holding the
	 * recipient's presence lease, renewed within this many milliseconds, is sent a wake-up hint for it (the database
	 * wake-up bus's `outbox` hint), so a recipient that registered elsewhere meanwhile gets the row at once. A store that
	 * ignores it wakes nobody; the backup poll still finds the row.
	 */
	readonly wakeHostWithinMs?: number;
}

export interface OutboxRow {
	/** Store-assigned positive safe integer, strictly increasing in insertion order across the outbox. */
	readonly sequence: number;
	readonly messageId: string;
	readonly targetIdentity: string;
	readonly originBrokerId: string;
	readonly digest: string;
	readonly frame: OutboxFrame;
	readonly state: OutboxRowState;
	/** Number of claims taken on this row so far. */
	readonly claimAttempts: number;
	/** Present only when `state` is `failed`; verbatim. */
	readonly failureReason?: string;
	/**
	 * #3983: store-clock milliseconds since the claimed row's recipient last reported it is still saving it; absent
	 * when it never reported, and on rows from a store that does not record it.
	 */
	readonly savingAgeMs?: number;
}

export interface OutboxClaim {
	readonly messageId: string;
	/** The `brokerId` that claimed the row. */
	readonly claimantId: string;
	/** Random token, different for every claim of the row. */
	readonly token: string;
	/** Equals the row's `claimAttempts` when this claim was taken. */
	readonly attempt: number;
}

export interface ClaimedOutboxRow {
	readonly row: OutboxRow;
	readonly claim: OutboxClaim;
}

export interface OutboxClaimRequest {
	readonly claimantId: string;
	readonly targetIdentity: string;
	readonly staleAfterMs: number;
}

export type OutboxEnqueueResult =
	| {
			readonly status: "inserted";
			readonly row: OutboxRow;
			/** #5607: with `wakeHostWithinMs`, the broker the write sent a wake-up hint for the row. */
			readonly woke?: string;
	  }
	/** Same id and digest: no second row is written and the existing row reports its current state. */
	| { readonly status: "duplicate"; readonly row: OutboxRow }
	| { readonly status: "conflict"; readonly messageId: string }
	/** #4896: the recipient already has its maximum of undelivered rows or bytes; nothing was written. */
	| { readonly status: "full"; readonly limit: number; readonly byteLimit: number }
	| InvalidStateInput;

export type OutboxClaimResult =
	/** The recipient's newly claimed rows in insertion order; empty when there is nothing to deliver. */
	| { readonly status: "claimed"; readonly rows: ClaimedOutboxRow[] }
	/** Another claimant holds a live claim on this recipient, so its rows stay in order with that claimant. */
	| { readonly status: "held"; readonly claimantId: string }
	| InvalidStateInput;

/** The row is already `delivered` or `failed`; every later write for it reports this, whatever its token. */
export type OutboxSettledResult = { readonly status: "settled"; readonly row: OutboxRow };
export type OutboxClaimWriteRejection =
	| OutboxSettledResult
	| { readonly status: "stale" }
	| { readonly status: "unknown" }
	| InvalidStateInput;

export type OutboxRenewClaimResult = { readonly status: "renewed" } | OutboxClaimWriteRejection;
export type OutboxReleaseClaimResult = { readonly status: "released" } | OutboxClaimWriteRejection;
export type OutboxDeliveredResult =
	| { readonly status: "delivered"; readonly row: OutboxRow }
	| OutboxClaimWriteRejection;
export type OutboxFailedResult = { readonly status: "failed"; readonly row: OutboxRow } | OutboxClaimWriteRejection;
export type OutboxReadResult =
	| { readonly status: "found"; readonly row: OutboxRow }
	| { readonly status: "missing" }
	| InvalidStateInput;
export type OutboxListResult = { readonly status: "listed"; readonly rows: OutboxRow[] } | InvalidStateInput;
export type OutboxPositionResult =
	| { readonly status: "positioned"; readonly position: number }
	| { readonly status: "missing" }
	| InvalidStateInput;

/** S2: the durable outbox, deduplicated by message id, with exclusive claim leases. */
export interface OutboxStore {
	enqueue(request: OutboxEnqueueRequest): Promise<OutboxEnqueueResult>;
	/**
	 * Claim the recipient's queued rows and rows whose claim is older than `staleAfterMs`, in insertion order.
	 * Rows the same claimant already holds live stay in flight and are not returned again.
	 */
	claim(request: OutboxClaimRequest): Promise<OutboxClaimResult>;
	renewClaim(claim: OutboxClaim): Promise<OutboxRenewClaimResult>;
	/**
	 * #3983: the claim's recipient reports it is still saving the row, so the sender's broker keeps its sender
	 * waiting. Optional: a store without it never extends a sender's wait.
	 */
	reportSaving?(claim: OutboxClaim): Promise<OutboxRenewClaimResult>;
	/**
	 * Return the row to `queued`, for example when its recipient disconnected before acknowledging. `unwritten`: the
	 * claim never wrote the row to any recipient (it left before), so the attempt is not counted and the row reads as
	 * never claimed, as it was before this claim.
	 */
	releaseClaim(claim: OutboxClaim, options?: { readonly unwritten?: boolean }): Promise<OutboxReleaseClaimResult>;
	/**
	 * #5038: return every row `claimantId` holds to `queued`, as its own `releaseClaim` would, so a dead broker's
	 * claims stop holding its recipients' queues until they go stale. Resolves to the number of rows released.
	 */
	releaseClaimsOf(claimantId: string): Promise<number>;
	/**
	 * The recipient acknowledged `received`; only now may its sender be told `delivered`. For an ask, record its
	 * route with `PendingAskStore.record` first: a settled row is never claimed again, so a route written after it
	 * would be lost if the broker stopped between the two writes.
	 */
	markDelivered(claim: OutboxClaim): Promise<OutboxDeliveredResult>;
	/** The recipient's broker refused the row; `reason` is reported to the sender verbatim. */
	markFailed(claim: OutboxClaim, reason: string): Promise<OutboxFailedResult>;
	read(messageId: string): Promise<OutboxReadResult>;
	/**
	 * The recipient's `queued` and `claimed` rows in insertion order, without claiming them; with `limit`, only the
	 * first `limit` of them.
	 */
	listUndelivered(targetIdentity: string, limit?: number): Promise<OutboxListResult>;
	/**
	 * #4896: where `messageId` stands in its recipient's undelivered rows, from 1 for the oldest, counted without
	 * reading any row: `missing` when it is not one of them.
	 */
	undeliveredPosition(targetIdentity: string, messageId: string): Promise<OutboxPositionResult>;
	/**
	 * Delete `delivered` and `failed` rows settled more than `settledOlderThanMs` ago; returns the count. With
	 * `queuedOlderThanMs`, first fail rows queued more than that long ago that no live claim holds, with
	 * `OUTBOX_EXPIRED_REASON` (#4896).
	 */
	prune(settledOlderThanMs: number, queuedOlderThanMs?: number): Promise<number>;
}

/**
 * The shared key of a restoring-recipient reservation: the lowercase hex SHA-256 of the supervisor capability.
 * The capability is a bearer secret with a random nonce, so the shared database stores only this digest. A released
 * child's reservation is made by child name, not capability, and keeps its `released:<name>` key as it is.
 */
export function reservationKeyFor(capability: string): string {
	if (isReleasedReservationKey(capability)) return capability;
	return createHash("sha256").update(capability, "utf8").digest("hex");
}

export interface HeldSend {
	/** `reservationKeyFor(capability)` of the restoring-recipient reservation the send waits on; never the capability. */
	readonly reservationKey: string;
	/** The broker holding the sender's socket and wait; it dispatches or refuses the send when the hold ends. */
	readonly originBrokerId: string;
	readonly senderSessionId: string;
	/** Its `message.id` identifies the held send. */
	readonly request: HeldSendRequest;
}

export type HeldSendHoldResult = { readonly status: "held" } | { readonly status: "duplicate" } | InvalidStateInput;
export type HeldSendListResult = { readonly status: "listed"; readonly sends: HeldSend[] } | InvalidStateInput;
export type HeldSendTakeResult = { readonly status: "taken"; readonly sends: HeldSend[] } | InvalidStateInput;
export type HeldSendDropResult = { readonly status: "dropped" } | { readonly status: "missing" } | InvalidStateInput;

/** S3: sends held for recipients being restored, so any broker can dispatch them when the hold ends. */
export interface HeldSendStore {
	/** A message id already held, under any reservation, is a `duplicate` and is not held twice. */
	hold(send: HeldSend): Promise<HeldSendHoldResult>;
	list(reservationKey: string): Promise<HeldSendListResult>;
	/** Atomically remove and return the reservation's held sends in insertion order, so each is handed over once. */
	take(reservationKey: string): Promise<HeldSendTakeResult>;
	/** Remove only this send; `dropped` tells exactly one caller that it now owns the send's dispatch. */
	drop(messageId: string): Promise<HeldSendDropResult>;
}

export interface RestoringReservationRequest {
	/** `reservationKeyFor(capability)`. */
	readonly reservationKey: string;
	readonly ownerSessionId: string;
	/** The broker holding the owner's socket. */
	readonly ownerBrokerId: string;
	/** Verbatim, for refusal texts. */
	readonly childName: string;
	/** The normalized child name: a lookup target, and the identity a newer restoration or a registration matches. */
	readonly childTarget: string;
	/** Further normalized targets, such as the child's Atomic session id and pre-restart Intercom id. */
	readonly aliases: readonly string[];
	/** The child's normalized group; senders in it are admitted. */
	readonly group: string;
	/** Kept only until the supervisor that restores the child reserves it or the child registers. */
	readonly dormant: boolean;
	/** The child is released: the first send held for it asks the owner's broker to wake it (#4326). */
	readonly wake: boolean;
	/** The aliases given are all the child has, not additions to those reserved before. */
	readonly replaceAliases?: boolean;
	readonly staleAfterMs?: number;
}

export interface RestoringReservation {
	readonly reservationKey: string;
	readonly ownerSessionId: string;
	readonly ownerBrokerId: string;
	readonly childName: string;
	readonly childTarget: string;
	/** `childTarget` first, then every other target once, in the order it was added. */
	readonly targets: string[];
	readonly group: string;
	readonly dormant: boolean;
	readonly wake: boolean;
	/** Increases when this reservation is parked again or moves to another broker. */
	readonly wakeGeneration: number;
	readonly fencingToken: number;
	/** Set once the owner reports the child gone; verbatim. */
	readonly gone?: string;
}

export interface RestoringReservationLease {
	readonly reservationKey: string;
	readonly ownerSessionId: string;
	/** Positive safe integer, greater than every token issued earlier for the key, including ended or pruned ones. */
	readonly fencingToken: number;
}

/** How a reservation ended; brokers holding sends for it read this to dispatch or refuse them. */
export type RestoringReservationEnd =
	/** The child registered: held sends are routed again. */
	| { readonly outcome: "consumed" }
	/** The owner ended it: held sends are refused with `refusal` when given, otherwise routed again. */
	| { readonly outcome: "released"; readonly refusal?: string }
	/** A newer restoration of the same child took it over: held sends keep waiting on `by`. */
	| { readonly outcome: "superseded"; readonly by: string };

export interface RestoringReservationSender {
	readonly sessionId: string;
	/** The sender's normalized groups. */
	readonly groups: readonly string[];
	readonly home?: string;
}

export interface RestoringReservationRegistration {
	/** The registered child's normalized name. */
	readonly childTarget: string;
	/** The registered child's normalized groups. */
	readonly groups: readonly string[];
	/** The child registered without a supervisor capability: only released children's reservations end with it. */
	readonly releasedOnly?: true;
	/** The supervisor whose capability the registering child proved; a released child's reservation ends only with its owner's. */
	readonly authorizedBy?: string;
	/**
	 * The `insertionMark` read when the child began registering. Only reservations inserted up to it end by the child's
	 * name: a later one was made by a release of the child after its registration began (#4488).
	 */
	readonly insertedBy?: number;
}

export interface RestoringReservationReleaseOutcome {
	/** Keep the reservation as a gone marker that refuses held and later sends with this text. */
	readonly gone?: string;
	/** End the reservation and refuse only the sends held now with this text. Ignored when `gone` is given. */
	readonly refusal?: string;
}

export type RestoringReservationReserveResult =
	/** `superseded` lists the reservations this one took over, in insertion order. */
	| { readonly status: "reserved"; readonly lease: RestoringReservationLease; readonly superseded: string[] }
	| { readonly status: "not-owner"; readonly ownerSessionId: string }
	| InvalidStateInput;
export type RestoringReservationLookupResult =
	| { readonly status: "none" }
	| { readonly status: "reserved"; readonly reservation: RestoringReservation }
	| { readonly status: "gone"; readonly reservation: RestoringReservation }
	| InvalidStateInput;
export type RestoringReservationRenewResult = { readonly status: "renewed" } | LeaseStaleResult | InvalidStateInput;
export type RestoringReservationReleaseResult =
	| { readonly status: "released" }
	| { readonly status: "gone" }
	| LeaseStaleResult
	| InvalidStateInput;
/** A reservation whose owner's broker should wake its released child, because a send started holding for it. */
export interface RestoringReservationWakeRequest {
	readonly reservationKey: string;
	readonly ownerSessionId: string;
	readonly childName: string;
}
export type RestoringReservationRequestWakeResult =
	| { readonly status: "requested" }
	| { readonly status: "not-wakeable" }
	| InvalidStateInput;
export type RestoringReservationTakeWakeResult =
	| { readonly status: "taken"; readonly requests: RestoringReservationWakeRequest[] }
	| InvalidStateInput;
export type RestoringReservationConsumeResult =
	/** The reservations this registration ended, in insertion order; empty when none. */
	| { readonly status: "consumed"; readonly reservationKeys: string[] }
	| InvalidStateInput;
export type RestoringReservationReadResult =
	| { readonly status: "active"; readonly reservation: RestoringReservation; readonly ageMs: number }
	| { readonly status: "ended"; readonly end: RestoringReservationEnd }
	| { readonly status: "missing" }
	| InvalidStateInput;

/**
 * S3: #3760 restoring-recipient reservations shared by every broker, so a sender on any host sees a child being
 * restored and holds its send. Targets and groups are matched exactly; callers pass normalized values.
 */
export interface RestoringReservationStore {
	/**
	 * Reserve the key, or add targets to it. The same owner keeps its token; another owner takes the reservation
	 * over with a greater token, because holding the capability is the authority. A released child's key is the
	 * exception (#4326): while it is active under another owner that renewed it within `staleAfterMs` (any age when
	 * absent), the reserve changes nothing and is `not-owner`. A new or ended key supersedes other active
	 * reservations of the same `childTarget` made by the same owner, or dormant in the same group, merging their
	 * targets.
	 */
	reserve(request: RestoringReservationRequest): Promise<RestoringReservationReserveResult>;
	/**
	 * The first live reservation (`ageMs <= staleAfterMs`), in insertion order, with the target and owned by the
	 * sender or in one of the sender's groups. A gone marker is reported as `gone`.
	 */
	lookup(
		target: string,
		sender: RestoringReservationSender,
		staleAfterMs: number,
	): Promise<RestoringReservationLookupResult>;
	/** Reset the age, also of a gone marker. A superseded token or an ended reservation is `stale`. */
	renew(lease: RestoringReservationLease): Promise<RestoringReservationRenewResult>;
	/** Owner only: mark the reservation gone, or end it as `released`. */
	release(
		lease: RestoringReservationLease,
		outcome?: RestoringReservationReleaseOutcome,
	): Promise<RestoringReservationReleaseResult>;
	/**
	 * Ask the broker that owns this active, non-gone `wake` reservation to wake its child: the request stays until
	 * that broker takes it. Asking again before then is the same single request. With a claim, the same send and
	 * fencing token cannot request another wake in that generation even after take; stale epochs cannot wake a later release.
	 */
	requestWake(
		reservationKey: string,
		claim?: { readonly fencingToken: number; readonly wakeGeneration: number; readonly messageId: string },
	): Promise<RestoringReservationRequestWakeResult>;
	/** Atomically remove and return the wake requests of the active reservations owned by this broker, once each. */
	takeWakeRequests(ownerBrokerId: string): Promise<RestoringReservationTakeWakeResult>;
	/**
	 * The child registered with this key through any broker: end its reservation unless it is a gone marker, and
	 * with `registered`, every other dormant, non-gone reservation of that child in one of its groups, and its
	 * released one when `registered.authorizedBy` owns it. Age is ignored.
	 */
	consume(
		reservationKey: string,
		registered?: RestoringReservationRegistration,
	): Promise<RestoringReservationConsumeResult>;
	/**
	 * The insertion order of the latest reservation inserted so far: one inserted after this was read has a greater
	 * one (#4488).
	 */
	insertionMark(): Promise<number>;
	read(reservationKey: string): Promise<RestoringReservationReadResult>;
	/** Delete ended records ended, and reservations last renewed, more than `olderThanMs` ago; returns the count. */
	prune(olderThanMs: number): Promise<number>;
}

/** A delivered ask whose reply route stays open until the reply or either peer leaves. */
export interface PendingAsk {
	readonly senderSessionId: string;
	readonly targetSessionId: string;
	readonly messageId: string;
}

/** A reply travels the reverse route: from the ask's target back to the ask's sender. */
export interface ReplyRoute {
	readonly replySenderSessionId: string;
	readonly replyTargetSessionId: string;
	readonly replyTo: string;
}

export type PendingAskRecordResult =
	| { readonly status: "recorded" }
	| { readonly status: "duplicate" }
	/** #4997: the ask was answered or failed already (`clearReply`): it is not recorded again. */
	| { readonly status: "settled" }
	| InvalidStateInput;

/**
 * #4997: how long an answered or failed ask is remembered, so a copy of its route a stopped broker kept is not recorded
 * again. Longer than such a copy is kept (`AWAY_ASK_RETENTION_MS`, 7 days).
 */
export const SETTLED_ASK_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
export type PendingAskMatchResult = { readonly status: "match" } | { readonly status: "no-match" } | InvalidStateInput;
export type PendingAskClearResult =
	| { readonly status: "cleared" }
	| { readonly status: "no-match" }
	| InvalidStateInput;
export type PendingAskMarkResult = { readonly status: "marked" } | { readonly status: "no-match" } | InvalidStateInput;
export type PendingAskPruneResult = { readonly status: "pruned"; readonly removed: number } | InvalidStateInput;
export type PendingAskListResult = { readonly status: "listed"; readonly asks: PendingAsk[] } | InvalidStateInput;
export type PendingAskTakeResult = { readonly status: "taken"; readonly asks: PendingAsk[] } | InvalidStateInput;

/** #4386: who keeps a released subagent's asks while it holds no session: its owner, under its released reservation. */
export interface PendingAskPark {
	readonly ownerSessionId: string;
	/** `releasedReservationKey(childName)`. */
	readonly reservationKey: string;
}

/** A parked ask moved to the session its subagent registered again with. */
export interface ReboundPendingAsk extends PendingAsk {
	readonly previousTargetSessionId: string;
}

export type PendingAskParkResult = { readonly status: "parked"; readonly parked: number } | InvalidStateInput;
export type PendingAskRebindResult = { readonly status: "rebound"; readonly asks: ReboundPendingAsk[] } | InvalidStateInput;

/**
 * S3: shared pending-ask routes, recorded by the recipient's broker when the recipient acknowledges the ask and
 * before its outbox row is marked delivered. A broker that stops between the two leaves the row claimed, so the next
 * claimant redelivers it and records again; `record` answers that repeat with `duplicate`.
 */
export interface PendingAskStore {
	record(ask: PendingAsk): Promise<PendingAskRecordResult>;
	/** Only the exact reverse route of a recorded ask matches. */
	matchesReply(route: ReplyRoute): Promise<PendingAskMatchResult>;
	/**
	 * The ask is answered or failed: its route is removed, and the ask is remembered as settled (#4997), whether or not
	 * a route was still recorded, so `record` does not record it again.
	 */
	clearReply(route: ReplyRoute): Promise<PendingAskClearResult>;
	/** #4997: whether the ask was answered or failed (`clearReply`) within `SETTLED_ASK_RETENTION_MS`. */
	isSettled(route: ReplyRoute): Promise<boolean>;
	/** #4997: the ask's route moves to one broker's own routes: it is removed without settling the ask. */
	releaseRoute(route: ReplyRoute): Promise<PendingAskClearResult>;
	/**
	 * #4992: a reply to the ask is queued: its route stays, so the reply is still authorized when it is delivered, but
	 * the ask is answered: `listForTarget` and `listParked` no longer return it, so it does not also fail.
	 */
	markReplied(route: ReplyRoute): Promise<PendingAskMarkResult>;
	pruneSender(senderSessionId: string): Promise<PendingAskPruneResult>;
	/** The sender's asks, in insertion order, without removing them. */
	listForSender(senderSessionId: string): Promise<PendingAskListResult>;
	/** Remove and return the asks addressed to this target, in insertion order. */
	takeForTarget(targetSessionId: string): Promise<PendingAskTakeResult>;
	/**
	 * #4992: the unanswered asks addressed to this target, in insertion order, without removing them: each is removed
	 * with `clearReply` only once its asker's failure is delivered or queued.
	 */
	listForTarget(targetSessionId: string): Promise<PendingAskListResult>;
	/**
	 * #4386: the target is a subagent its owner released: keep its asks, still matching replies from it, for its
	 * owner instead of removing them.
	 */
	parkForTarget(targetSessionId: string, park: PendingAskPark): Promise<PendingAskParkResult>;
	/** The parked subagent registered again: its parked asks now target this session, in insertion order. */
	rebindParked(park: PendingAskPark, targetSessionId: string): Promise<PendingAskRebindResult>;
	/** Remove and return the owner's parked asks, of every subagent or only of the one reserved under `reservationKey`. */
	takeParked(ownerSessionId: string, reservationKey?: string): Promise<PendingAskTakeResult>;
	/** #4992: the owner's unanswered parked asks, as `takeParked` selects them, without removing them. */
	listParked(ownerSessionId: string, reservationKey?: string): Promise<PendingAskListResult>;
	/**
	 * #4992: the target ended: its unanswered asks are marked ended, durably, before their askers are told, and returned
	 * as `listForTarget` would. An ask stays marked until `clearReply` removes it or `unmarkEnded` keeps only its route,
	 * so another broker finishes what a broker that stopped meanwhile left (`listEnded`).
	 */
	endForTarget(targetSessionId: string): Promise<PendingAskListResult>;
	/** #4992: as `endForTarget`, for the owner's parked asks, as `listParked` selects them. */
	endParked(ownerSessionId: string, reservationKey?: string): Promise<PendingAskListResult>;
	/** #4992: the unanswered asks marked ended more than `olderThanMs` ago, by store clock, oldest first. */
	listEnded(olderThanMs: number): Promise<PendingAskListResult>;
	/**
	 * #5154: the target is lost: mark its unanswered, unparked asks ended, as `endForTarget` does, and return only those
	 * this call marked, so of brokers that find it lost at once only one tells each asker. An ask marked earlier is
	 * left to whoever marked it, or to `listEnded` once that broker stopped.
	 */
	endLost(targetSessionId: string): Promise<PendingAskListResult>;
	/** #4992: the ended ask's failure is queued; its route stays only to authorize that failure when it is delivered. */
	unmarkEnded(route: ReplyRoute): Promise<PendingAskMarkResult>;
}

/**
 * #4386: an ask whose asker, a supervised subagent, was released while it waited for the reply. A reply to it from
 * the ask's target goes to the subagent's owner, wherever either is connected.
 */
export interface ReleasedAsk {
	readonly questionId: string;
	readonly askerSessionId: string;
	readonly replierSessionId: string;
	/** The asker's registration name, verbatim: its owner holds it under `releasedReservationKey(childName)`. */
	readonly childName: string;
	/** The asker's supervisor when it left: its owner still after its reservation ends because it woke. */
	readonly ownerSessionId: string;
}

/** `open` until a reply claims it; `claimed` while that reply is handed to the owner; `answered` once accepted. */
export type ReleasedAskState = "open" | "claimed" | "answered";

export interface ReleasedAskRecord extends ReleasedAsk {
	readonly state: ReleasedAskState;
	/** The reply that claimed or answered the ask; absent while it is open. */
	readonly replyMessageId?: string;
}

export interface ReleasedAskKey {
	readonly questionId: string;
	readonly replierSessionId: string;
}

export interface ReleasedAskClaim extends ReleasedAskKey {
	readonly replyMessageId: string;
}

export interface ReleasedAskSupersede extends ReleasedAskClaim {
	readonly staleReplyMessageId: string;
	readonly staleAfterMs: number;
}

export type ReleasedAskKeepResult = { readonly status: "kept"; readonly kept: number } | InvalidStateInput;
export type ReleasedAskLookupResult =
	| { readonly status: "found"; readonly ask: ReleasedAskRecord }
	| { readonly status: "missing" }
	| InvalidStateInput;
export type ReleasedAskListResult = { readonly status: "listed"; readonly asks: ReleasedAskRecord[] } | InvalidStateInput;
export type ReleasedAskClaimResult =
	/** This reply holds the ask: it claimed it now, or had claimed or answered it before. */
	| { readonly status: "claimed"; readonly ask: ReleasedAskRecord }
	/** Another reply claimed or answered it. */
	| { readonly status: "taken"; readonly ask: ReleasedAskRecord }
	| { readonly status: "missing" }
	| InvalidStateInput;
export type ReleasedAskSettleResult =
	| { readonly status: "settled" }
	/** The ask is not claimed by this reply. */
	| { readonly status: "stale" }
	| { readonly status: "missing" }
	| InvalidStateInput;

/**
 * S3 (#4386): released askers' asks, kept by the asker's broker when the asker leaves, before its pending asks are
 * pruned, so a reply through any broker reaches the asker's owner exactly once. An ask still open past its deadline
 * is missing; a claimed or answered one keeps answering its reply, and refusing others, until it is pruned.
 */
export interface ReleasedAskStore {
	/** Keep each ask open for `ttlMs` of store time; an ask kept before is left as it is. */
	keep(asks: readonly ReleasedAsk[], ttlMs: number): Promise<ReleasedAskKeepResult>;
	lookup(key: ReleasedAskKey): Promise<ReleasedAskLookupResult>;
	/** #4852: the asks to this replier still open, which no reply has claimed, oldest first. */
	openForReplier(replierSessionId: string): Promise<ReleasedAskListResult>;
	/** Claim an open ask for this reply, atomically, so only one reply is ever handed to the owner at a time. */
	claim(claim: ReleasedAskClaim): Promise<ReleasedAskClaimResult>;
	/** The owner accepted the claiming reply. Answering again for the same reply is `settled`. */
	answer(claim: ReleasedAskClaim): Promise<ReleasedAskSettleResult>;
	/** The claiming reply could not be handed over: the ask is open to another reply. */
	reopen(claim: ReleasedAskClaim): Promise<ReleasedAskSettleResult>;
	/**
	 * Take a claim over from a reply whose handoff can no longer settle it: claimed by `staleReplyMessageId` more than
	 * `staleAfterMs` of store time ago (any age when negative). Otherwise `taken`, or `claimed` when this reply already
	 * holds it.
	 */
	supersede(claim: ReleasedAskSupersede): Promise<ReleasedAskClaimResult>;
	/** Delete asks whose deadline passed more than `olderThanMs` ago; returns the count. */
	prune(olderThanMs: number): Promise<number>;
}

export type SentMessageState = "reserved" | "accepted";

export interface SentQuestionRoute {
	readonly targetSessionId: string;
	readonly senderGroupIdentity: string;
}

export interface SentMessageReservation {
	readonly messageId: string;
	readonly digest: string;
	readonly targetIdentity: string;
	readonly questionRoute?: SentQuestionRoute;
}

export interface SentMessageKey {
	readonly messageId: string;
	readonly digest: string;
}

export type SentMessageReserveResult =
	| { readonly status: "reserved" }
	| { readonly status: "match"; readonly state: SentMessageState }
	| { readonly status: "conflict" }
	| InvalidStateInput;
export type SentMessageAcceptResult =
	| { readonly status: "accepted" }
	| { readonly status: "conflict" }
	| { readonly status: "missing" }
	| InvalidStateInput;
export type SentMessageLookupResult =
	| { readonly status: "miss" }
	| {
			readonly status: "match";
			readonly state: SentMessageState;
			readonly targetIdentity: string;
			readonly questionRoute?: SentQuestionRoute;
	  }
	| { readonly status: "conflict" }
	| InvalidStateInput;
export type SentMessageForgetResult =
	| { readonly status: "forgotten" }
	| { readonly status: "missing" }
	| { readonly status: "conflict" }
	| InvalidStateInput;

/** S3: duplicate-send authority shared by every broker, so a same-id retry through any broker is recognized. */
export interface SentMessageAuthority {
	reserve(reservation: SentMessageReservation): Promise<SentMessageReserveResult>;
	accept(key: SentMessageKey): Promise<SentMessageAcceptResult>;
	lookup(key: SentMessageKey): Promise<SentMessageLookupResult>;
	/** Drop a reservation whose forwarding failed, so a retry is not refused as a duplicate. */
	forget(key: SentMessageKey): Promise<SentMessageForgetResult>;
	/** Delete records recorded more than `olderThanMs` ago; returns the count. */
	prune(olderThanMs: number): Promise<number>;
}

/**
 * A session some broker hosted, recorded when it registers and when it leaves (spec §14, S5 amendment). A send
 * to a known session with no live presence lease is queued for its return instead of failing.
 */
export interface KnownSession {
	/** Stable recipient authority (`deliveryTargetIdentity`); one record per identity. */
	readonly targetIdentity: string;
	/** The Intercom session id it last registered with. */
	readonly intercomSessionId: string;
	/** Verbatim. */
	readonly name?: string;
	/** The host (Atomic) session id: the registration's return address. */
	readonly atomicSessionId?: string;
	/** The normalized registration group. */
	readonly group: string;
	/** The normalized memberships at its last record. */
	readonly groups: readonly string[];
	/** The host-declared connection purpose at its last record; only agents receive Intercom messages. */
	readonly recipientPurpose?: SessionInfo["recipientPurpose"];
	/** The reply capability at its last record: an ask to a terminal session is refused, offline as live. */
	readonly replyCapability?: SessionInfo["replyCapability"];
}

export interface KnownSessionState extends KnownSession {
	readonly groups: string[];
	/** Store-clock milliseconds since the session was last recorded. */
	readonly ageMs: number;
}

export type KnownSessionRecordResult = { readonly status: "recorded" } | InvalidStateInput;
/**
 * Which return address an Intercom session id is bound to: `""` for a session that registered with none. `bound`
 * means `returnAddress` holds the id (it is the requester's own, or the id was free); `refused` names the other one.
 */
export type KnownSessionBindResult =
	| { readonly status: "bound" }
	| { readonly status: "refused"; readonly returnAddress: string }
	/** #5607: bound to this return address, but another live registration of it owns the id (`KnownSessionOwner`). */
	| { readonly status: "held" }
	| InvalidStateInput;

/**
 * #5607: the registration taking an id: a value unique to it, and its broker. An id has at most one owner: a
 * registration takes it only while no other registration owns it, or its owner went unrenewed for `staleAfterMs`. The
 * owner's broker renews it while the registration is live and releases it when the registration leaves.
 */
export interface KnownSessionOwner {
	readonly token: string;
	readonly brokerId: string;
	readonly staleAfterMs: number;
}

/** #5607: an id and the token of the registration that owns it. */
export interface KnownSessionOwnership {
	readonly intercomSessionId: string;
	readonly token: string;
}

/** #5607: see `KnownSessionStore.reclaim`. */
export interface SessionIdReclaim {
	readonly intercomSessionId: string;
	readonly returnAddress: string;
	/** The `claim` the registration's own `bind` was given. */
	readonly claim: string;
	readonly retentionMs: number;
	/** The broker reclaiming; a presence lease it holds itself does not count. */
	readonly brokerId: string;
	/** A presence lease renewed within this many milliseconds is live. */
	readonly presenceStaleAfterMs: number;
	/** The id bound instead when the id is not kept. */
	readonly freshId: string;
	/**
	 * The owner the registration's `bind` was given, on a store that keeps owners: the id is kept only when it takes
	 * the id for that registration too, as `bind` would.
	 */
	readonly owner?: KnownSessionOwner;
}

export type SessionIdReclaimResult =
	| { readonly status: "kept" }
	/** Not kept: `freshId` was bound as `bind` binds it, with its result. */
	| { readonly status: "fresh"; readonly binding: KnownSessionBindResult }
	| InvalidStateInput;

export type KnownSessionBindingResult =
	| { readonly status: "bound"; readonly returnAddress: string }
	| { readonly status: "unbound" }
	| InvalidStateInput;
export type KnownSessionLookupResult =
	| { readonly status: "found"; readonly sessions: KnownSessionState[] }
	| InvalidStateInput;

/** S5 amendment: sessions brokers hosted, kept for `KNOWN_SESSION_RETENTION_MS` so sends to them are queued. */
export interface KnownSessionStore {
	/** Insert or replace the identity's record and reset its age; the identity keeps its first-record order. */
	record(session: KnownSession): Promise<KnownSessionRecordResult>;
	/**
	 * Records last recorded within `retentionMs` whose Intercom id or Atomic session id equals `target`, or whose
	 * name equals it case-insensitively (`toLowerCase`), in first-record order.
	 */
	lookup(target: string, retentionMs: number): Promise<KnownSessionLookupResult>;
	/**
	 * Bind the Intercom id `intercomSessionId` to the return address of the session registering under it (`""` when it
	 * gave none), unless another return address has held it within `retentionMs`, and reset the binding's age. In multi-node mode an id carries
	 * authority: it is granted, and delivered to, only the session it is bound to. An id with no binding yet is bound
	 * first to the return address its earliest known-session record has, so a record kept from before bindings existed
	 * still holds it. #5607: `claim`, a value unique to this registration, is recorded as the binding's latest claim
	 * when it binds, so `reclaim` can tell later whether the binding is still the one this registration wrote. With
	 * `owner`, on a store that keeps owners, it also takes the id for that registration, unless another live
	 * registration owns it (`held`); without it, ownership is left as it is. `bound` then means the binding names that
	 * owner.
	 */
	bind(
		intercomSessionId: string,
		returnAddress: string,
		retentionMs: number,
		claim?: string,
		owner?: KnownSessionOwner,
	): Promise<KnownSessionBindResult>;
	/**
	 * #5607: the one write a returning registration makes when its `bind` did not answer in time. It keeps the id when
	 * the binding is still the one that `bind` wrote (same return address and claim, within `retentionMs`) and no other
	 * broker holds a live presence lease for a session of that return address, in any group, resetting the binding's age. Otherwise
	 * it binds `freshId` as `bind` does. Optional: without it such a registration gets a fresh id, bound as `bind` binds it.
	 */
	reclaim?(request: SessionIdReclaim): Promise<SessionIdReclaimResult>;
	/**
	 * #5607: whether the store keeps id owners. A store without it (an older schema a role may not change) binds as
	 * before and has none of the owner methods.
	 */
	readonly owners?: {
		/** The registration with `token` gives the id up; an owner with another token is left as it is. */
		release(ownership: KnownSessionOwnership): Promise<void>;
		/**
		 * Renew each of these ids that its registration still owns, resetting its binding's age with it, and return
		 * those: an id missing from the result is owned by another registration now, or by none.
		 */
		renew(ownerships: readonly KnownSessionOwnership[]): Promise<KnownSessionOwnership[]>;
		/** Every id the broker `brokerId` owns is given up: that broker instance is gone. */
		retireBroker(brokerId: string): Promise<void>;
	};
	/** The return address the id is bound to, if a binding recorded within `retentionMs` holds it. */
	binding(intercomSessionId: string, retentionMs: number): Promise<KnownSessionBindingResult>;
	/** Delete records and bindings last recorded more than `olderThanMs` ago; returns the count of records. */
	prune(olderThanMs: number): Promise<number>;
	/**
	 * #5154: these identities' sessions were present on a broker that stopped and was retired before it recorded them
	 * leaving: mark them lost, keeping an earlier mark. `record` clears the mark.
	 */
	markLost(targetIdentities: readonly string[]): Promise<void>;
	/** #5154: the records marked lost more than `olderThanMs` ago, by store clock. */
	listLost(olderThanMs: number): Promise<KnownSessionState[]>;
}

/** The return address a delivery identity (`deliveryTargetIdentity`) names; none for a session that gave none. */
export function returnAddressOf(identity: string): string | undefined {
	try {
		const parsed = JSON.parse(identity) as unknown;
		return Array.isArray(parsed) && parsed[0] === "return" && typeof parsed[1] === "string" ? parsed[1] : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether the Intercom id `sessionId` is bound to `returnAddress` (`undefined` for none), or to no session at all. In
 * multi-node mode a presence or record under an id bound to another return address is not that session.
 */
export async function holdsSessionId(
	knownSessions: Pick<KnownSessionStore, "binding">,
	sessionId: string,
	returnAddress: string | undefined,
): Promise<boolean> {
	const bound = await knownSessions.binding(sessionId, KNOWN_SESSION_RETENTION_MS);
	return bound.status !== "bound" || bound.returnAddress === (returnAddress ?? "");
}

/** One broker's view of the shared Intercom state. */
export interface IntercomBrokerStateStore {
	readonly leases: BrokerLeaseStore;
	readonly outbox: OutboxStore;
	readonly heldSends: HeldSendStore;
	readonly reservations: RestoringReservationStore;
	readonly pendingAsks: PendingAskStore;
	readonly releasedAsks: ReleasedAskStore;
	readonly sentMessages: SentMessageAuthority;
	readonly knownSessions: KnownSessionStore;
	/**
	 * A send's `sentMessages.reserve` and `outbox.enqueue` as one write, so a queued send costs one commit, not two. A
	 * conflicting reservation is answered `conflict`, and a recipient whose queue is full is answered `full` with
	 * nothing written: no row, and no reservation, an earlier attempt's included. Optional: without it, the broker
	 * reserves, enqueues, and forgets the reservation of a send the full queue refused.
	 */
	reserveAndEnqueue?(reservation: SentMessageReservation, request: OutboxEnqueueRequest): Promise<OutboxEnqueueResult>;
	/**
	 * #5999 durable wake queue: the messages queued for subagents that ended, in this database, for one broker home;
	 * `holder` is the broker instance taking them. Optional: without it they stay in broker memory.
	 */
	openEndedChildQueue?(owner: {
		readonly home: string;
		readonly holder: string;
		readonly retire?: boolean;
		readonly servedSinceLastHolder?: (storeId: string) => boolean;
		readonly pid?: string;
	}): Promise<EndedChildQueueStore>;
	close(): Promise<void>;
}

export interface IntercomBrokerStateOptions {
	/** The database of the selected shared `storage` adapter; the store does not close it. */
	readonly database: SqliteDatabase;
	/** The adapter's validated table prefix. */
	readonly prefix: string;
}

export type OpenIntercomBrokerStateStore = (options: IntercomBrokerStateOptions) => Promise<IntercomBrokerStateStore>;
