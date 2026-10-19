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
	/** Return the row to `queued`, for example when its recipient disconnected before acknowledging. */
	releaseClaim(claim: OutboxClaim): Promise<OutboxReleaseClaimResult>;
	/** The recipient acknowledged `received`; only now may its sender be told `delivered`. */
	markDelivered(claim: OutboxClaim): Promise<OutboxDeliveredResult>;
	/** The recipient's broker refused the row; `reason` is reported to the sender verbatim. */
	markFailed(claim: OutboxClaim, reason: string): Promise<OutboxFailedResult>;
	read(messageId: string): Promise<OutboxReadResult>;
	/** The recipient's `queued` and `claimed` rows in insertion order, without claiming them. */
	listUndelivered(targetIdentity: string): Promise<OutboxListResult>;
	/** Delete `delivered` and `failed` rows settled more than `settledOlderThanMs` ago; returns the count. */
	prune(settledOlderThanMs: number): Promise<number>;
}

export interface HeldSend {
	/** Restoring-recipient reservation the send waits on (the supervisor capability for that child). */
	readonly reservationKey: string;
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
	drop(messageId: string): Promise<HeldSendDropResult>;
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

/** S3: shared pending-ask routes, recorded by the recipient's broker when the recipient acknowledges the ask. */
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

/** One broker's view of the shared Intercom state. */
export interface IntercomBrokerStateStore {
	readonly leases: BrokerLeaseStore;
	readonly outbox: OutboxStore;
	readonly heldSends: HeldSendStore;
	readonly pendingAsks: PendingAskStore;
	readonly sentMessages: SentMessageAuthority;
	close(): Promise<void>;
}

export interface IntercomBrokerStateOptions {
	/** The database of the selected shared `storage` adapter; the store does not close it. */
	readonly database: SqliteDatabase;
	/** The adapter's validated table prefix. */
	readonly prefix: string;
}

export type OpenIntercomBrokerStateStore = (options: IntercomBrokerStateOptions) => Promise<IntercomBrokerStateStore>;
