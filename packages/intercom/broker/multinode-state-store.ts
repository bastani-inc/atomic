import { createHash } from "node:crypto";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import type { BrokerMessage, ClientMessage, SessionInfo } from "../types.js";

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

/** The exact frame a broker writes to a recipient's socket; a cross-node delivery writes the same frame. */
export type IntercomDeliveryFrame = Extract<BrokerMessage, { type: "message" }>;

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
	readonly frame: IntercomDeliveryFrame;
}

export interface OutboxRow {
	/** Store-assigned positive safe integer, strictly increasing in insertion order across the outbox. */
	readonly sequence: number;
	readonly messageId: string;
	readonly targetIdentity: string;
	readonly originBrokerId: string;
	readonly digest: string;
	readonly frame: IntercomDeliveryFrame;
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
	| { readonly status: "inserted"; readonly row: OutboxRow }
	/** Same id and digest: no second row is written and the existing row reports its current state. */
	| { readonly status: "duplicate"; readonly row: OutboxRow }
	| { readonly status: "conflict"; readonly messageId: string }
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
	/** Return the row to `queued`, for example when its recipient disconnected before acknowledging. */
	releaseClaim(claim: OutboxClaim): Promise<OutboxReleaseClaimResult>;
	/**
	 * The recipient acknowledged `received`; only now may its sender be told `delivered`. For an ask, record its
	 * route with `PendingAskStore.record` first: a settled row is never claimed again, so a route written after it
	 * would be lost if the broker stopped between the two writes.
	 */
	markDelivered(claim: OutboxClaim): Promise<OutboxDeliveredResult>;
	/** The recipient's broker refused the row; `reason` is reported to the sender verbatim. */
	markFailed(claim: OutboxClaim, reason: string): Promise<OutboxFailedResult>;
	read(messageId: string): Promise<OutboxReadResult>;
	/** The recipient's `queued` and `claimed` rows in insertion order, without claiming them. */
	listUndelivered(targetIdentity: string): Promise<OutboxListResult>;
	/** Delete `delivered` and `failed` rows settled more than `settledOlderThanMs` ago; returns the count. */
	prune(settledOlderThanMs: number): Promise<number>;
}

/**
 * The shared key of a restoring-recipient reservation: the lowercase hex SHA-256 of the supervisor capability.
 * The capability is a bearer secret with a random nonce, so the shared database stores only this digest.
 */
export function reservationKeyFor(capability: string): string {
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
}

export interface RestoringReservationRegistration {
	/** The registered child's normalized name. */
	readonly childTarget: string;
	/** The registered child's normalized groups. */
	readonly groups: readonly string[];
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
	 * over with a greater token, because holding the capability is the authority. A new or ended key supersedes
	 * other active reservations of the same `childTarget` made by the same owner, or dormant in the same group,
	 * merging their targets.
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
	 * The child registered with this key through any broker: end its reservation unless it is a gone marker, and
	 * with `registered`, every other dormant, non-gone reservation of that child in one of its groups. Age is ignored.
	 */
	consume(
		reservationKey: string,
		registered?: RestoringReservationRegistration,
	): Promise<RestoringReservationConsumeResult>;
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
	| InvalidStateInput;
export type PendingAskMatchResult = { readonly status: "match" } | { readonly status: "no-match" } | InvalidStateInput;
export type PendingAskClearResult =
	| { readonly status: "cleared" }
	| { readonly status: "no-match" }
	| InvalidStateInput;
export type PendingAskPruneResult = { readonly status: "pruned"; readonly removed: number } | InvalidStateInput;
export type PendingAskTakeResult = { readonly status: "taken"; readonly asks: PendingAsk[] } | InvalidStateInput;

/**
 * S3: shared pending-ask routes, recorded by the recipient's broker when the recipient acknowledges the ask and
 * before its outbox row is marked delivered. A broker that stops between the two leaves the row claimed, so the next
 * claimant redelivers it and records again; `record` answers that repeat with `duplicate`.
 */
export interface PendingAskStore {
	record(ask: PendingAsk): Promise<PendingAskRecordResult>;
	/** Only the exact reverse route of a recorded ask matches. */
	matchesReply(route: ReplyRoute): Promise<PendingAskMatchResult>;
	clearReply(route: ReplyRoute): Promise<PendingAskClearResult>;
	pruneSender(senderSessionId: string): Promise<PendingAskPruneResult>;
	/** Remove and return the asks addressed to this target, in insertion order. */
	takeForTarget(targetSessionId: string): Promise<PendingAskTakeResult>;
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
	/** Delete records last recorded more than `olderThanMs` ago; returns the count. */
	prune(olderThanMs: number): Promise<number>;
}

/** One broker's view of the shared Intercom state. */
export interface IntercomBrokerStateStore {
	readonly leases: BrokerLeaseStore;
	readonly outbox: OutboxStore;
	readonly heldSends: HeldSendStore;
	readonly reservations: RestoringReservationStore;
	readonly pendingAsks: PendingAskStore;
	readonly sentMessages: SentMessageAuthority;
	readonly knownSessions: KnownSessionStore;
	close(): Promise<void>;
}

export interface IntercomBrokerStateOptions {
	/** The database of the selected shared `storage` adapter; the store does not close it. */
	readonly database: SqliteDatabase;
	/** The adapter's validated table prefix. */
	readonly prefix: string;
}

export type OpenIntercomBrokerStateStore = (options: IntercomBrokerStateOptions) => Promise<IntercomBrokerStateStore>;
