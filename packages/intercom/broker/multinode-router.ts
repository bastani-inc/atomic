import { OFFLINE_SESSION_TARGET } from "./held-reply-targets.js";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { normalizeGroup } from "../group.js";
import { isAgentRecipient, NON_AGENT_RECIPIENT_REFUSAL, TERMINAL_CHILD_ASK_REFUSAL } from "../recipient-purpose.js";
import {
	DELIVERED_MESSAGE_TTL_MS,
	RECIPIENT_RECEIPT_TIMEOUT_MS,
	RECIPIENT_SAVE_MAX_WAIT_MS,
} from "../retry-policy.js";
import {
	resolveSessionTarget,
	resolveSessionTargetByHostSessionId,
	type SessionTargetResolution,
	sessionTargetFailureReason,
} from "../session-target.js";
import type { DeliveryFailureReasonCode, Message, SessionInfo } from "../types.js";
import { ASK_FAILURE_QUEUED, crashPoint } from "./crash-points.js";
import type { DeliveredMessageCache } from "./delivered-message-cache.js";
import { sameGroup } from "./group-isolation.js";
import {
	reachesGroups,
	reachesSession,
	type ReservationSender,
	reservationSender,
	sessionGroups,
} from "./group-membership.js";
import { outsideReachReason, reachesAnyGroup } from "../reach-policy.js";
import {
	BROKER_LEASE_RENEW_INTERVAL_MS,
	BROKER_LEASE_STALE_AFTER_MS,
	type HeldSendRequest,
	type IntercomBrokerStateStore,
	type IntercomDeliveryFrame,
	holdsSessionId,
	KNOWN_SESSION_RETENTION_MS,
	type KnownSession,
	type KnownSessionBindResult,
	type KnownSessionOwner,
	type KnownSessionOwnership,
	type KnownSessionState,
	type Lease,
	type LeaseState,
	OUTBOX_BACKUP_POLL_INTERVAL_MS,
	OUTBOX_CLAIM_STALE_AFTER_MS,
	type OutboxClaim,
	type OutboxEnqueueRequest,
	type OutboxEnqueueResult,
	type OutboxRow,
	type PendingAsk,
	type BrokerMembershipSubject,
	type RecipientPresenceSubject,
	type ReleasedAskerReplyFrame,
	type ReleasedAskRecord,
	type RestoringReservation,
	type RestoringReservationLease,
	reservationKeyFor,
	returnAddressOf,
	type SentMessageReservation,
	type SessionIdReclaimResult,
} from "./multinode-state-store.js";
import type { PendingQuestion, PendingQuestionIndex } from "./pending-question-index.js";
import { ROUTE_UNAVAILABLE_REASON } from "./delivery-failure-reason.js";
import { UNCERTAIN_RECEIPT_REASON } from "./recipient-receipts.js";
import {
	decideReleasedAskerReply,
	isReleasedReplyCandidate,
	keepReleasedAsks,
	ownerOfAsker,
	ownerOfReleasedReplyRow,
	type ReleasedRegistration,
	type ReleasedReplyDelivery,
	type ReleasedTarget,
	rebindParkedAsks,
	releasedAskAnswered,
	releasedReplyAckOutcome,
	releasedReplyHandoffRefusal,
	settleAsksToDeparted,
} from "./released-asker-remote-replies.js";
import { isReleasedReservationKey, releasedReservationKey } from "./released-children.js";
import { type IntercomReleasedReplyError, serializeIntercomReleasedReplyError } from "./released-reply-errors.js";
import {
	RESTORING_RECIPIENT_HOLD_MS,
	restoringRecipientRetryReason,
	unrestoredReasonCode,
} from "./restoring-recipients.js";
import {
	type BrokerConnectedSession,
	deliveryTargetIdentity,
	messageFrameFor,
	type RemoteSendRequest,
	mayUseReturnPath,
	type ReturnPathAuthority,
	returnPathParty,
	type SendClientMessage,
	senderGroupIdentity,
} from "./send-handler.js";
import { type ReturnPathParty, returnPathClosedReason } from "./return-paths.js";
import { deliverHeldToAsker } from "./ask-failures.js";
import { brokerHostIdentity, isProcessAlive, processStartedAt } from "./broker-instance.js";
import { type LostRecipientBounds, lostRecipientBounds, lostRecipientReason } from "./lost-recipients.js";
import type { BrokerOutboundFrame } from "./socket-writes.js";
import type { SupervisorChannelCache } from "./supervisor-channel.js";
import type { WakeUpBus, WakeUpEvent, WakeUpSubscription } from "./wake-up-bus.js";

export { readSharedStorageSetting } from "./shared-storage-setting.js";

/**
 * Multi-node S5 (specs/2026-10-19-intercom-multi-node.md §4–§8, §14): routes sends to sessions hosted by other
 * brokers through the shared state, and delivers the shared outbox to this broker's own sessions. Local delivery
 * never comes here. Brokers coordinate only through the shared store and the wake-up bus; hints are only hints, so
 * catch-up scans run on every resync, presence acquisition and backup poll.
 */

/**
 * How often the origin re-reads the outcome of sends it is waiting on and of sends it holds for a restoring
 * recipient. Shorter than the 20 s hold, so a lost `outcome` hint for a held send is noticed before it times out.
 */
export const MULTI_NODE_OUTCOME_POLL_INTERVAL_MS = 5_000;
export { OFFLINE_SESSION_TARGET };
/** A send for another node while the shared database cannot be reached (spec §8, "Database unavailable"). */
/** #4997: a broker that renewed its membership within this long, and has missed its renewals since, is down. */
const ROUTE_HOLDER_DOWN_WINDOW_MS = 10 * 60_000;
/** #4997: a broker that has not renewed its membership within this long has missed a renewal. */
const BROKER_UNRESPONSIVE_AFTER_MS = (3 * BROKER_LEASE_RENEW_INTERVAL_MS) / 2;
export const SHARED_STORAGE_UNAVAILABLE_REASON =
	"Session not found on this node, and Intercom could not reach the shared storage database to look for it on other nodes. Try again once the database is available.";
const MAX_HELD_SENDS = 256;
/**
 * #3983: how long the decision to keep a sender waiting may take before the sender is told to keep waiting while it
 * finishes. Well inside the sender's own wait past the receipt wait (`SEND_RESPONSE_TIMEOUT_MS` minus
 * `RECIPIENT_RECEIPT_TIMEOUT_MS`).
 */
const HOLD_CHECK_GRACE_MS = 500;
/** A session that moved here may find its presence lease still held by the broker it just left. */
const PRESENCE_HANDOVER_ATTEMPTS = 4;
const PRESENCE_HANDOVER_RETRY_MS = 50;
/**
 * #5138: how many times a session's store steps (ending its reservations, rebinding its parked asks, failing a terminal
 * session's asks) are tried, once when due and then at each renewal, before a failure that keeps recurring is given up.
 */
export const REGISTRATION_STEP_ATTEMPTS = 30;
/**
 * The longest a registration waits for its presence lease. A hung shared database must not hang registration (the
 * client gives up after 10 s); the lease is still written when the database answers.
 */
export const PRESENCE_REGISTRATION_BOUND_MS = 5_000;
/**
 * The longest a registration that asks for its id back waits for the shared database to bind it, before the presence
 * wait: both together stay within the client's 10 s. Past it the session gets a fresh id, never an unchecked one.
 */
export const SESSION_ID_CLAIM_BOUND_MS = 2_500;
/**
 * #5607: waits between a returning registration's attempts at an id that another registration of the same session
 * still owns, as when its broker is still releasing it after that session moved here. Tried while within the claim's
 * bound; still owned after that, the session gets a fresh id.
 */
const SESSION_ID_OWNER_RETRY_MS = [50, 100, 200, 400, 800] as const;
/**
 * #5607: how long after the last write that confirmed it (counted from just before that write was sent) a registration's
 * id is taken as still its own without asking the shared database again. Another registration may take an id only once
 * its owner went unrenewed for `BROKER_LEASE_STALE_AFTER_MS`, so this leaves a third of that as margin; it spans two
 * renewals, so a broker that renews on time never asks. Past it (the broker was paused, or its renewals failed), one
 * conditional renewal is made before a send to or from the session, a list or a delivery is handled for it.
 */
export const SESSION_ID_OWNER_SAFE_MS = 2 * BROKER_LEASE_RENEW_INTERVAL_MS;
/**
 * The longest a send to a local recipient waits for the shared outbox to say whether it is a retry of a cross-node
 * send. Local delivery does not depend on the shared database (spec §8): past this bound the send is delivered
 * locally, with the local accepted-delivery cache as its duplicate protection.
 */
export const LOCAL_RETRY_LOOKUP_BOUND_MS = 300;
/**
 * The longest a reservation's acknowledgement waits for the shared database to record it, so a sender on another broker
 * that learns of the child after the acknowledgement finds it held. The client's reserve request gives up after 5 s; past
 * this bound the reservation is still written when the database answers.
 */
export const RESERVATION_PUBLISH_BOUND_MS = 2_500;
/** The longest `list` waits for other nodes' sessions; the client's list request gives up after 5 s. */
const REMOTE_SESSIONS_BOUND_MS = 2_000;
const MAX_SUPERSEDED_HOPS = 8;
/**
 * How often renewal refreshes a live session's known-session record. Far below `KNOWN_SESSION_RETENTION_MS`, so a
 * session that stays connected for longer than the retention is still known (queued for) after its broker crashes.
 */
export const KNOWN_SESSION_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const TARGET_GROUP_REFUSAL = "Target session is in a different intercom group";

/** How a registration's claim of its preferred id ended (`MultiNodeRouter.claimSessionId`). */
export type SessionIdClaim =
	| { readonly status: "granted"; readonly grant: SessionIdGrant }
	| { readonly status: "refused" }
	/** #5607: the shared database did not answer in time; see `SessionIdReclaimRequest`. */
	| { readonly status: "unanswered"; readonly unanswered: UnansweredSessionIdClaim };

/**
 * #5607: a moment read from both clocks. The monotonic clock does not advance while some hosts sleep; the wall clock can
 * be set back. Time since it is the larger of the two, so neither hides a pause.
 */
export interface ClockMark {
	readonly monotonic: number;
	readonly wall: number;
}

export function clockMark(): ClockMark {
	return { monotonic: performance.now(), wall: Date.now() };
}

export function elapsedSince(mark: ClockMark): number {
	return Math.max(performance.now() - mark.monotonic, Date.now() - mark.wall);
}

/**
 * #5607: how a claim took its id: the owner token its registration holds it with, and the moment just before the write
 * that granted it was sent.
 */
export interface SessionIdGrant {
	readonly token: string;
	readonly confirmed: ClockMark;
}

/**
 * #5607: a claim the shared database did not answer in time: the id it asked for, the value it wrote with it, and the
 * owner token its writes carry.
 */
export interface UnansweredSessionIdClaim {
	readonly sessionId: string;
	readonly claim: string;
	readonly token: string;
}

/**
 * #5607: given to `sessionRegistered` for a session whose claim went unanswered. The session is not registered on this
 * broker yet: `settle` registers it, once, under the claimed id (`keep`) or the fresh one its registration started
 * with, and reports whether it kept the claimed id. It cannot keep it once its registration has been answered or a
 * session here holds that id, and does nothing after the first call.
 */
export interface SessionIdReclaimRequest extends UnansweredSessionIdClaim {
	readonly settle: (keep: boolean) => boolean;
	/** Whether `settle` is still to be called: false once the registration settled without it, as when it was answered. */
	readonly unsettled: () => boolean;
}

/** What the broker uses of `open-broker-state.ts`, which it loads lazily (replaceable in tests). */
export interface BrokerStateOpener<Source> {
	resolveBrokerStateSource(
		setting: Record<string, unknown>,
		agentDir: string,
	): Promise<{ readonly status: "off"; readonly reason: string } | { readonly status: "shared"; readonly source: Source }>;
	openIntercomBrokerState(source: Source): Promise<{ readonly state: IntercomBrokerStateStore; readonly bus: WakeUpBus }>;
}

export type MultiNodeStartup<Source> =
	| { readonly status: "off"; readonly reason: string; readonly error?: Error }
	| { readonly status: "shared"; readonly opener: BrokerStateOpener<Source>; readonly source: Source };

/**
 * Decide whether a top-level `storage` value gives this broker a shared database. Multi-node routing is off, and
 * Intercom behaves exactly as a single-node broker, unless it does: also when the host storage module or the adapter
 * cannot be loaded, or the selection cannot be resolved to a database. Only a selection that resolved to a database
 * whose connection then fails makes cross-node sends fail explicitly.
 */
export async function resolveMultiNodeStartup<Source>(
	setting: Record<string, unknown>,
	agentDir: string,
	load: () => Promise<BrokerStateOpener<Source>>,
): Promise<MultiNodeStartup<Source>> {
	try {
		const opener = await load();
		const resolved = await opener.resolveBrokerStateSource(setting, agentDir);
		return resolved.status === "off"
			? { status: "off", reason: resolved.reason }
			: { status: "shared", opener, source: resolved.source };
	} catch (cause) {
		const error = cause instanceof Error ? cause : new Error(String(cause));
		return { status: "off", reason: error.message, error };
	}
}

/** The unkeyed SHA-256 of the canonical send, the digest of every cross-node row (decision 2). */
export function crossNodeDigest(signature: string): string {
	return createHash("sha256").update(signature, "utf8").digest("hex");
}

const normalizeTarget = (target: string): string => target.trim().toLowerCase();

export interface MultiNodeHost {
	readonly sessions: ReadonlyMap<string, BrokerConnectedSession>;
	/** Write a frame unless the socket is closed; false when nothing was written. */
	write(socket: BrokerConnectedSession["socket"], frame: BrokerOutboundFrame): boolean;
	/** Write a frame and report the socket write callback's outcome. */
	writeConfirmed(
		socket: BrokerConnectedSession["socket"],
		frame: BrokerOutboundFrame,
		onSettled: (written: boolean) => void,
	): void;
	readonly supervisorCache: SupervisorChannelCache;
	/** This broker's return paths: a session here may answer a sender outside its groups whose message reached it here. */
	readonly returnPaths?: ReturnPathAuthority;
	/** This broker's own ask routes: an ask whose asker and recipient are both here is answered on the local path. */
	readonly pendingQuestions: PendingQuestionIndex;
	/** This broker's local accepted deliveries: a retry whose recipient moved to another broker is answered from them. */
	readonly deliveredMessages: Pick<DeliveredMessageCache, "lookupForTarget" | "lookupQuestionTarget">;
	/** Route a held send again as its sender, exactly like a new send (local delivery or the outbox). */
	dispatch(socket: BrokerConnectedSession["socket"], clientMessage: SendClientMessage, senderId: string): void;
	revokeReleasedReservation(reservationKey: string, ownerSessionId: string): void;
	/**
	 * #5352: whether this broker still holds the reservation the owner made under `capability` (its capability or
	 * released-child key): false once it was released, taken by its child, or replaced by a newer reservation of the child.
	 */
	holdsReservation(capability: string, ownerSessionId: string): boolean;
	/**
	 * #5607: another live registration of the same session owns this session's id: disconnect it here, leaving what is
	 * shared under the id alone, so it reconnects and gets a fresh id.
	 */
	fence(session: BrokerConnectedSession): void;
}

export interface MultiNodeRouterOptions {
	readonly state: IntercomBrokerStateStore;
	readonly bus: WakeUpBus;
	readonly host: MultiNodeHost;
	readonly brokerId?: string;
	readonly nodeId?: string;
	/** #4997: this broker's durable state on its host (`BrokerMembershipSubject.home`). */
	readonly home?: string;
	/**
	 * #5038: what stays the same when this broker restarts (its socket path); with the node and host identity it
	 * names the earlier instances, whose leases and claims this one retires as it starts once their process exited.
	 */
	readonly instanceKey?: string;
	/**
	 * #5038: tells this host from another with the same name (`brokerHostIdentity`); `null` when there is no reliable
	 * one, so no earlier instance is retired early.
	 */
	readonly hostIdentity?: string | null;
	/** #5038: this broker's process id; `process.pid` by default. */
	readonly pid?: number;
	/** #5038: whether a process of this host still runs (`isProcessAlive`). */
	readonly isProcessAlive?: (pid: number) => boolean;
	/**
	 * #5252: when a process of this host started, in ms since the epoch; `undefined` when that cannot be read, `null` where
	 * this host does not read it (`processStartedAt`).
	 */
	readonly processStartedAt?: (pid: number) => number | null | undefined | Promise<number | null | undefined>;
	/** #5154: how long a recipient whose end was lost stays gone before its asks fail; `lostRecipientBounds()`. */
	readonly lostRecipientBounds?: LostRecipientBounds;
}

interface Inflight {
	readonly claim: OutboxClaim;
	readonly row: OutboxRow;
	readonly session: BrokerConnectedSession;
	readonly identity: string;
	/** #4386: a released asker's reply; only the owner's answer to this handoff settles the row. */
	readonly released?: ReleasedReplyHandoff;
}

interface ReleasedReplyHandoff {
	readonly handoffId: string;
	readonly frame: ReleasedAskerReplyFrame;
}

interface Waiter {
	readonly messageId: string;
	readonly digest: string;
	readonly socket: BrokerConnectedSession["socket"];
	readonly attemptId?: string;
	readonly senderSessionId: string;
	/** The sender's groups: the released child's reservation it may read when its send is queued (#4512). */
	readonly sender: ReservationSender;
	readonly expectsReply: boolean;
	readonly resolveReplyTarget: boolean;
	readonly targetSessionId: string;
	readonly targetIdentity: string;
	/** Told `queued` already: `delivered` follows only while the sender is connected, and it never expires. */
	readonly queued: boolean;
	timer: ReturnType<typeof setTimeout> | undefined;
	/** When, by `performance.now()`, the sender started waiting; a recipient's save reports never keep it waiting past the save cap (#3983). */
	readonly waitingSince: number;
	/** Ends the wait as uncertain at the save cap, whatever the store does (#3983). */
	capTimer?: ReturnType<typeof setTimeout>;
	/** The hold check whose outbox read is in flight; a wait that ends meanwhile reuses it (#3983). */
	holdCheck?: Promise<void>;
	/**
	 * The last hold check found the recipient still holding the message with no saving report within the receipt
	 * wait. One such wait is forgiven, since a recipient stalled under load reports late; a second in a row ends the
	 * wait as uncertain (#4443).
	 */
	missedSavingReport?: boolean;
}

interface TrackedHold {
	readonly messageId: string;
	readonly reservationKey: string;
	readonly childName: string;
	readonly socket: BrokerConnectedSession["socket"];
	readonly senderId: string;
	readonly attemptId?: string;
	readonly clientMessage: SendClientMessage;
	readonly reasonCode: DeliveryFailureReasonCode;
	readonly timer: ReturnType<typeof setTimeout>;
}

interface PresenceEntry {
	lease?: Lease;
	/** `Date.now()` when this broker last wrote the session's known-session record. */
	knownAt?: number;
	/** The session's asks were failed once it turned terminal. */
	terminal?: boolean;
	/** #4386: a released subagent that registered before the broker it left gave up its presence rebinds once it has it. */
	rebind?: ReleasedRegistration;
	/** #5138: the session's store steps not yet done, recorded before they run so a failed one is retried. */
	unfinished?: UnfinishedRegistration;
	/**
	 * Its Intercom id is bound to another session's return address: it is never known, present or routed to under that
	 * id across nodes, and its departure leaves that session's shared state alone.
	 */
	unbound?: true;
	/** #5607: the id this registration owns in the shared store, renewed while it is live and released as it leaves. */
	owner?: OwnedSessionId;
	/**
	 * #5607: a session registered while routing was still opening: its first binding write, while it is in flight.
	 * Nothing confirmed its id is its own before that write answers.
	 */
	adopting?: Promise<OwnerVerdict>;
	/**
	 * #5607: another live registration owns its id: it was disconnected here to reconnect for a fresh id, and its
	 * departure leaves what is shared under the id to that registration.
	 */
	fenced?: true;
}

/** #5607: what a check of a registration's id found: still its own, another registration's, or no answer. */
type OwnerVerdict = "own" | "lost" | "unknown";

/** #5607: the checks of a send's sender and local recipient. */
interface SendOwnerVerdicts {
	readonly sender: OwnerVerdict;
	readonly target: OwnerVerdict;
}

/** #5607: the id a registration owns in the shared store. */
interface OwnedSessionId extends KnownSessionOwnership {
	/** Just before the last write that found the id this registration's was sent. */
	confirmed: ClockMark;
	/** The one conditional renewal of this id alone that routing for it waits for, while it is in flight. */
	checking?: Promise<OwnerVerdict>;
}

/** `promise`'s value, or `fallback` once `boundMs` passed first; the promise keeps running either way. */
function withinBound<T, F>(promise: Promise<T>, boundMs: number, fallback: F): Promise<T | F> {
	let bound: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<F>((resolve) => {
			bound = setTimeout(() => resolve(fallback), boundMs);
			bound.unref?.();
		}),
	]).finally(() => clearTimeout(bound));
}

/** #5607: the later of two marks. Both are this process's, so the monotonic clock orders them. */
function laterMark(earlier: ClockMark | undefined, later: ClockMark): ClockMark {
	return earlier !== undefined && earlier.monotonic > later.monotonic ? earlier : later;
}

function ownershipKey({ intercomSessionId, token }: KnownSessionOwnership): string {
	return JSON.stringify([intercomSessionId, token]);
}

interface UnfinishedRegistration {
	consume?: ConsumedReservation;
	/** The reservations' insertion mark read as the registration began, until `consume` takes it. */
	mark?: Promise<number> | undefined;
	rebind?: ReleasedRegistration | undefined;
	/** The session turned terminal: the asks delivered to it fail. */
	failTerminal?: true;
	attempts: number;
}

interface ConsumedReservation {
	readonly capability?: string;
	readonly childName?: string;
	readonly groups: ReadonlySet<string>;
	readonly authorizedBy?: string;
	/** The reservations' insertion mark when the registration began: later ones never end by the child's name (#4488). */
	readonly insertedBy?: number;
}

interface MirroredReservation {
	lease: RestoringReservationLease;
	readonly capability?: string;
	wake: boolean;
	/** The session ids the owner reserved for the child besides its name: the sessions it registered as. */
	readonly aliases: readonly string[];
	/** The group the owner reserved the child in: the one it registered in. */
	readonly group: string;
	/** This broker told the owner to wake the child while this reservation stands (#4401). */
	woken?: true;
	/**
	 * The reservations this one took over, and those they took over: sends held for them wait for this one, and are
	 * handed on when the child consumes it (#4488).
	 */
	readonly superseded?: readonly string[];
	/** #5352: what was written, to write it again if a stale retry of an older reservation of the child ends it. */
	readonly publication?: UnpublishedReservation;
}

/**
 * A reservation made here that the shared database does not hold yet: its write failed, or has not answered. It is
 * written again at each renewal until it lands, or until it is released, consumed or made again (#5352).
 */
interface UnpublishedReservation {
	readonly capability: string;
	readonly ownerSessionId: string;
	/** The owner's connection when it reserved: a reservation it no longer holds is not written. */
	readonly owner: BrokerConnectedSession | undefined;
	readonly childName: string;
	readonly group: string;
	readonly aliases: readonly string[];
	readonly dormant: boolean;
	readonly options: ReservationOptions;
}

/** How a mirrored reservation differs from a plain restoring one. */
export interface ReservationOptions {
	readonly wake?: boolean;
	readonly replaceAliases?: boolean;
}

interface RemoteTarget {
	readonly identity: string;
	readonly sessionId: string;
	readonly groups: ReadonlySet<string>;
	/**
	 * The recipient attributes that gate delivery, from its live presence or its known-session record: every route
	 * to a session, live or offline, refuses non-agent recipients and asks to terminal ones alike.
	 */
	readonly gates: Pick<SessionInfo, "recipientPurpose" | "replyCapability">;
	/** The broker hosting it now; absent for an offline session. */
	readonly hostBrokerId?: string;
}

/** #4896: why a send was refused because its recipient's undelivered outbox rows reached their cap. */
function outboxFullReason(full: { readonly limit: number; readonly byteLimit: number }): string {
	return `The recipient already has the most queued Intercom messages it accepts (${full.limit} messages or ${
		full.byteLimit / (1024 * 1024)
	} MiB); this message was not queued. Messages already queued for it are kept. Try again after it returns and receives them.`;
}

/**
 * #5607: what an enqueue for a recipient the sender found offline (`hostBrokerId` absent) also does: wake the broker
 * holding the recipient's live presence as the row is written, should it have registered meanwhile.
 */
function offlineHost(hostBrokerId: string | undefined): Pick<OutboxEnqueueRequest, "wakeHostWithinMs"> {
	return hostBrokerId === undefined ? { wakeHostWithinMs: BROKER_LEASE_STALE_AFTER_MS } : {};
}

function queuedFrame(messageId: string, attemptId: string | undefined, position: number): BrokerOutboundFrame {
	return {
		type: "queued",
		messageId,
		...(attemptId === undefined ? {} : { attemptId }),
		target: OFFLINE_SESSION_TARGET,
		position,
	};
}

/**
 * The delivery identities a session that registered with `id` in `group` has, as `deliveryTargetIdentity` forms them:
 * `id` as its return address, or as its Intercom session id when it gave none (#4401).
 */
function forgottenSessionIdentities(id: string, group: string): readonly string[] {
	return [JSON.stringify(["return", id, normalizeGroup(group)]), JSON.stringify(["session", id])];
}

/** #4997: one ask's route, as a set key. */
function askKey(question: PendingQuestion): string {
	return JSON.stringify([question.senderSessionId, question.targetSessionId, question.messageId]);
}

export class MultiNodeRouter {
	readonly brokerId: string;
	private readonly home: string | undefined;

	/**
	 * #5999 durable wake queue: what this broker's rows in the shared database are kept under, the same across its
	 * restarts on this host and never another host's: its instance key (node, host identity and socket path), or, on a
	 * host with no reliable identity, its home.
	 */
	get durableHome(): string {
		return this.instanceKey.startsWith(`${this.nodeId}:${this.brokerId}`) ? (this.home ?? this.instanceKey) : this.instanceKey;
	}

	/**
	 * #4997: whether a broker that may keep ask routes no other broker has is down: it renewed its membership within
	 * `ROUTE_HOLDER_DOWN_WINDOW_MS` but has missed its renewals since, and no broker is back under its home.
	 */
	private async routeHolderDown(): Promise<boolean> {
		const [recent, responsive] = await Promise.all([
			this.state.leases.listLive("broker", ROUTE_HOLDER_DOWN_WINDOW_MS),
			this.state.leases.listLive("broker", BROKER_UNRESPONSIVE_AFTER_MS),
		]);
		const homeOf = (lease: LeaseState) => (lease.subject.kind === "broker" ? lease.subject.home : undefined);
		const answering = new Set(responsive.map((lease) => lease.holderId));
		const homesBack = new Set(responsive.map(homeOf));
		return recent.some((lease) => {
			const home = homeOf(lease);
			return home !== undefined && !answering.has(lease.holderId) && !homesBack.has(home);
		});
	}

	/**
	 * A reply no ask route authorizes: refused, as retryable while a broker that may keep its route is down (#4997).
	 */
	/**
	 * #4997: whether the ask's route may be kept by a broker this one cannot reach: not answered or failed already, and
	 * either both the asker and the replier were last present on one other broker (a route between them lives there
	 * even before that broker is noticed down), or a broker that may keep routes is down (`routeHolderDown`).
	 */
	private async routeMayBeElsewhere(
		request: RemoteSendRequest,
		askerSessionId: string,
		askerIdentity: string,
	): Promise<boolean> {
		const replyTo = request.message.replyTo;
		if (replyTo === undefined) return false;
		const route = { replySenderSessionId: request.from.info.id, replyTargetSessionId: askerSessionId, replyTo };
		if (await this.state.pendingAsks.isSettled(route)) return false;
		const holderOf = async (targetIdentity: string) => {
			const read = await this.state.leases.read({ kind: "presence", targetIdentity });
			return read.status === "found" ? read.lease.holderId : undefined;
		};
		const [askerHolder, replierHolder] = await Promise.all([
			holderOf(askerIdentity),
			holderOf(deliveryTargetIdentity(request.from)),
		]);
		if (askerHolder !== undefined && askerHolder !== this.brokerId && askerHolder === replierHolder) return true;
		return this.routeHolderDown();
	}

	private async refuseUnauthorizedReply(
		request: RemoteSendRequest,
		asker: { readonly sessionId: string; readonly identity: string },
	): Promise<void> {
		if (!(await this.routeMayBeElsewhere(request, asker.sessionId, asker.identity).catch(() => false))) {
			this.fail(request, "Pending question route does not authorize this public reply");
			return;
		}
		this.refuseRouteUnavailable(request);
	}

	/** #4997: refuse a reply as retryable (`route_unavailable`): a route that would authorize it may be unreachable. */
	private refuseRouteUnavailable(request: RemoteSendRequest): void {
		this.host.write(request.socket, {
			type: "delivery_failed",
			messageId: request.message.id,
			attemptId: request.attemptId,
			reason: ROUTE_UNAVAILABLE_REASON,
			routeUnavailable: true,
		});
	}
	private readonly state: IntercomBrokerStateStore;
	private readonly bus: WakeUpBus;
	private readonly host: MultiNodeHost;
	private readonly nodeId: string;
	private readonly instanceKey: string;
	private readonly pid: number;
	private readonly isProcessAlive: (pid: number) => boolean;
	private readonly processStartedAt: (pid: number) => number | null | undefined | Promise<number | null | undefined>;
	private readonly lostBounds: LostRecipientBounds;
	private membership: Lease | undefined;
	private subscription: WakeUpSubscription | undefined;
	private readonly presence = new Map<BrokerConnectedSession, PresenceEntry>();
	private readonly inflight = new Map<string, Inflight>();
	private readonly waiters = new Map<string, Waiter>();
	private readonly holds = new Map<string, TrackedHold>();
	private readonly mirrored = new Map<string, MirroredReservation>();
	/** Reservations with a backup-poll wake check queued or running: one each while the store stalls, not a backlog. */
	private readonly pendingWakeChecks = new Set<string>();
	/** #5352: reservations made here whose shared write has not landed, by reservation key. */
	private readonly unpublished = new Map<string, UnpublishedReservation>();
	private readonly pendingPublishRetries = new Set<string>();
	private readonly heldIdentities = new Set<string>();
	private readonly scanning = new Map<string, { rescan: boolean }>();
	private readonly serials = new Map<string, Promise<void>>();
	private readonly settling = new Set<Promise<void>>();
	/** #5607: sessions registered before routing turned on, until `sessionRegistered` takes them up. */
	private readonly adopting = new WeakSet<BrokerConnectedSession>();
	private readonly timers: ReturnType<typeof setInterval>[] = [];
	private checkingOutcomes: { again: boolean } | undefined;
	private closed = false;
	private lastError: string | undefined;

	private constructor(options: MultiNodeRouterOptions, hostIdentity: string | null | undefined) {
		this.state = options.state;
		this.bus = options.bus;
		this.host = options.host;
		this.brokerId = options.brokerId ?? randomUUID();
		this.nodeId = options.nodeId ?? hostname();
		this.home = options.home;
		this.host.pendingQuestions.onAnswered((question) => this.answeredHere(question));
		// Without a key of its own, no earlier broker can be this one.
		this.instanceKey =
			hostIdentity == null || options.instanceKey === undefined
				? `${this.nodeId}:${this.brokerId}`
				: `${this.nodeId}:${hostIdentity}:${options.instanceKey}`;
		this.pid = options.pid ?? process.pid;
		this.isProcessAlive = options.isProcessAlive ?? isProcessAlive;
		this.processStartedAt = options.processStartedAt ?? ((pid) => processStartedAt(pid));
		this.lostBounds = options.lostRecipientBounds ?? lostRecipientBounds();
	}

	/** Take the membership lease, subscribe to wake-ups and adopt the sessions already connected. */
	static async start(options: MultiNodeRouterOptions): Promise<MultiNodeRouter> {
		const router = new MultiNodeRouter(
			options,
			options.hostIdentity === undefined ? await brokerHostIdentity() : options.hostIdentity,
		);
		await router.retirePreviousInstances();
		const acquired = await router.state.leases.acquire(
			router.membershipSubject(),
			router.brokerId,
			BROKER_LEASE_STALE_AFTER_MS,
		);
		if (acquired.status === "acquired") router.membership = acquired.lease;
		const subscribed = await router.bus.subscribe(router.brokerId, (event) => router.onWakeUp(event));
		if (subscribed.status === "subscribed") router.subscription = subscribed.subscription;
		router.every(BROKER_LEASE_RENEW_INTERVAL_MS, () => router.renew());
		router.every(OUTBOX_BACKUP_POLL_INTERVAL_MS, () => router.backupPoll());
		// #4992: what a broker that stopped mid-departure left is finished now, and at every backup poll.
		// #5154: and the asks to recipients lost long enough.
		void router
			.sweepEndedAsks()
			.then(() => router.sweepLostRecipients())
			.catch((error: Error) => router.report(error));
		router.every(MULTI_NODE_OUTCOME_POLL_INTERVAL_MS, () => router.outcomePoll());
		// #5607: renewed apart from the leases, so neither waits for the other's statements.
		router.every(BROKER_LEASE_RENEW_INTERVAL_MS, () => router.renewOwners());
		for (const session of options.host.sessions.values()) {
			router.adopting.add(session);
			void router.sessionRegistered(session);
		}
		return router;
	}

	// ---------------------------------------------------------------------------------------------------------
	// Session lifecycle

	/**
	 * Whether a registration with `returnAddress` may take the Intercom id `sessionId`, binding the id to it when free.
	 * In multi-node mode an id carries authority (shared ask routes and known sessions name sessions by id), so only the
	 * session that registered it gets it back, and (#5607) only while no other live registration of that session owns
	 * it: an owned id is tried again while within the claim's bound, then refused. `unanswered` when the shared store
	 * does not answer in time: the session registers under a fresh id, and its registration's binding write tries once
	 * more to keep this one (#5607).
	 */
	async claimSessionId(sessionId: string, returnAddress: string): Promise<SessionIdClaim> {
		if (this.closed) return { status: "refused" };
		// #5607: written with the binding, so a later write can tell whether the binding is still this claim's.
		const claim = randomUUID();
		const owner = this.newOwner();
		const deadline = performance.now() + SESSION_ID_CLAIM_BOUND_MS;
		let expired = false;
		const attempts = (async (): Promise<SessionIdClaim> => {
			for (let attempt = 0; ; attempt++) {
				const confirmed = clockMark();
				const result = await this.state.knownSessions.bind(
					sessionId,
					returnAddress,
					KNOWN_SESSION_RETENTION_MS,
					claim,
					owner,
				);
				if (result.status === "bound") return { status: "granted", grant: { token: owner.token, confirmed } };
				if (result.status !== "held") return { status: "refused" };
				const wait = SESSION_ID_OWNER_RETRY_MS[Math.min(attempt, SESSION_ID_OWNER_RETRY_MS.length - 1)]!;
				if (expired || performance.now() + wait >= deadline) return { status: "refused" };
				await new Promise<void>((resolve) => setTimeout(resolve, wait).unref());
				// A broker that stalled through the wait does not try again past the claim's bound.
				if (expired || performance.now() >= deadline) return { status: "refused" };
			}
		})();
		let bound: ReturnType<typeof setTimeout> | undefined;
		try {
			const claimed = await Promise.race<SessionIdClaim>([
				attempts,
				new Promise<SessionIdClaim>((resolve) => {
					bound = setTimeout(
						() => resolve({ status: "unanswered", unanswered: { sessionId, claim, token: owner.token } }),
						SESSION_ID_CLAIM_BOUND_MS,
					);
					bound.unref?.();
				}),
			]);
			// An attempt in flight decides nothing more: the registration's binding write does (`reclaimOrBind`).
			if (claimed.status === "unanswered") {
				expired = true;
				attempts.catch(() => {});
			}
			return claimed;
		} catch (error) {
			this.report(error);
			return { status: "refused" };
		} finally {
			clearTimeout(bound);
		}
	}

	/** #5607: a registration's owner token, unique to it, on this broker. */
	private newOwner(token: string = randomUUID()): KnownSessionOwner {
		return { token, brokerId: this.brokerId, staleAfterMs: BROKER_LEASE_STALE_AFTER_MS };
	}

	/**
	 * #5607: give an owned id back; a store without owners has nothing to give back. A failure is reported: the id is free
	 * again once its owner is no longer renewed.
	 */
	async releaseOwner(ownership: KnownSessionOwnership): Promise<void> {
		await this.state.knownSessions.owners?.release(ownership).catch((error: Error) => this.report(error));
	}

	/**
	 * #5607: the binding write of a registration whose claim of its preferred id went unanswered, in the slot today's
	 * fresh-id binding takes. One write keeps the preferred id when the binding is still the one that claim wrote, no
	 * other broker presents a session of its return address, in any group, and no other live registration owns it;
	 * otherwise it binds the fresh id. The session is then registered here under the id the write chose, or under the
	 * fresh id when the claimed one can no longer be given (its registration was answered meanwhile, or a session here
	 * holds it), which is then bound as today.
	 */
	private async reclaimOrBind(
		session: BrokerConnectedSession,
		reclaim: SessionIdReclaimRequest,
		owner: KnownSessionOwner,
	): Promise<KnownSessionBindResult> {
		const { knownSessions } = this.state;
		const returnAddress = session.registrationReturnAddress ?? "";
		const freshId = session.info.id;
		const bindFresh = async () => {
			reclaim.settle(false);
			// A grant its claim's own write made, which this registration does not use, is given back.
			await this.releaseOwner({ intercomSessionId: reclaim.sessionId, token: owner.token });
			return knownSessions.bind(freshId, returnAddress, KNOWN_SESSION_RETENTION_MS, undefined, owner);
		};
		if (knownSessions.reclaim === undefined || !reclaim.unsettled()) return bindFresh();
		let reclaimed: SessionIdReclaimResult;
		try {
			reclaimed = await knownSessions.reclaim({
				intercomSessionId: reclaim.sessionId,
				returnAddress,
				claim: reclaim.claim,
				retentionMs: KNOWN_SESSION_RETENTION_MS,
				brokerId: this.brokerId,
				presenceStaleAfterMs: BROKER_LEASE_STALE_AFTER_MS,
				freshId,
				owner,
			});
		} catch (error) {
			reclaim.settle(false);
			throw error;
		}
		if (reclaimed.status === "fresh") {
			reclaim.settle(false);
			return reclaimed.binding;
		}
		if (reclaimed.status === "kept" && reclaim.settle(true)) return { status: "bound" };
		return bindFresh();
	}

	/**
	 * #5607: whether routing for `session` as the owner of its id must wait for the shared store: undefined when it need
	 * not (its id was confirmed within `SESSION_ID_OWNER_SAFE_MS`, or the store keeps no owners), so a broker that renews
	 * on time waits for nothing. Otherwise the verdict of the one conditional renewal of its id alone, in flight until the
	 * store answers it (or the first binding write of a session registered while routing was opening). On `lost` the
	 * session has been disconnected here.
	 */
	private ownerCheck(session: BrokerConnectedSession): Promise<OwnerVerdict> | undefined {
		const entry = this.presence.get(session);
		if (entry === undefined) return undefined;
		if (entry.fenced === true) return Promise.resolve("lost");
		if (entry.adopting !== undefined) return entry.adopting;
		const owned = entry.owner;
		if (owned === undefined || elapsedSince(owned.confirmed) < SESSION_ID_OWNER_SAFE_MS) return undefined;
		if (owned.checking === undefined) {
			const checking = this.checkOwner(session, entry, owned);
			owned.checking = checking;
			void checking.finally(() => {
				if (owned.checking === checking) delete owned.checking;
			});
		}
		return owned.checking;
	}

	/**
	 * #5607: renew the id `session` owns, conditionally on its own token: never a write that would take the id again. A
	 * check that does not answer keeps running; whenever it answers, a lost id is acted on then.
	 */
	private async checkOwner(session: BrokerConnectedSession, entry: PresenceEntry, owned: OwnedSessionId): Promise<OwnerVerdict> {
		const owners = this.state.knownSessions.owners;
		if (owners === undefined) return "unknown";
		const confirmed = clockMark();
		let renewed: KnownSessionOwnership[];
		try {
			renewed = await owners.renew([{ intercomSessionId: owned.intercomSessionId, token: owned.token }]);
		} catch (error) {
			this.report(error);
			return "unknown";
		}
		const key = ownershipKey(owned);
		return this.settleOwned(session, entry, owned, renewed.some((ownership) => ownershipKey(ownership) === key), confirmed);
	}

	/**
	 * #5607: the store answered a renewal of `owned` sent at `confirmed`: still this registration's, or another's (or
	 * none's) now, which is final: this registration never takes an id again. An answer for a registration that left, or
	 * whose owned id changed meanwhile, decides nothing.
	 */
	private settleOwned(
		session: BrokerConnectedSession,
		entry: PresenceEntry,
		owned: OwnedSessionId,
		still: boolean,
		confirmed: ClockMark,
	): OwnerVerdict {
		if (entry.fenced === true) return "lost";
		if (this.presence.get(session) !== entry || entry.owner !== owned) return "unknown";
		if (still) {
			owned.confirmed = laterMark(owned.confirmed, confirmed);
			return "own";
		}
		this.lostSessionId(session, entry);
		return "lost";
	}

	/** #5607: every owned id renewed in one write per batch; one the store no longer names for its registration is lost. */
	private async renewOwners(): Promise<void> {
		const owners = this.state.knownSessions.owners;
		if (owners === undefined) return;
		const held = [...this.presence].flatMap(([session, entry]) =>
			entry.owner === undefined || entry.fenced === true ? [] : [{ session, entry, owned: entry.owner }],
		);
		if (held.length === 0) return;
		const confirmed = clockMark();
		const renewed = await owners.renew(
			held.map(({ owned }) => ({ intercomSessionId: owned.intercomSessionId, token: owned.token })),
		);
		const still = new Set(renewed.map(ownershipKey));
		for (const { session, entry, owned } of held)
			this.settleOwned(session, entry, owned, still.has(ownershipKey(owned)), confirmed);
	}

	/** #5607: another registration owns `session`'s id: it is disconnected here, once, to reconnect for a fresh id. */
	private lostSessionId(session: BrokerConnectedSession, entry: PresenceEntry): void {
		if (this.presence.get(session) !== entry || entry.fenced === true) return;
		entry.fenced = true;
		this.host.fence(session);
	}

	/**
	 * #5607: the checks a send waits for: its sender's and its local recipient's ids, where either needs one. Undefined on
	 * the healthy path.
	 */
	private sendOwnerChecks(request: RemoteSendRequest): Promise<SendOwnerVerdicts> | undefined {
		const sender = this.ownerCheck(request.from);
		const target = request.localTarget === undefined ? undefined : this.ownerCheck(request.localTarget);
		if (sender === undefined && target === undefined) return undefined;
		return Promise.all([sender ?? "own", target ?? "own"]).then(([from, to]) => ({ sender: from, target: to }));
	}

	private holdsSessionId(sessionId: string, returnAddress: string | undefined): Promise<boolean> {
		return holdsSessionId(this.state.knownSessions, sessionId, returnAddress);
	}

	/**
	 * A session registered here: record it as known and take its presence lease, retrying briefly while the broker
	 * it left still holds it. Resolves once other brokers can resolve it, or after `PRESENCE_REGISTRATION_BOUND_MS`
	 * while the database does not answer; what waits for it is delivered after.
	 */
	sessionRegistered(
		session: BrokerConnectedSession,
		consumed?: ConsumedReservation,
		reclaim?: SessionIdReclaimRequest,
		grant?: SessionIdGrant,
	): Promise<void> {
		if (this.closed || this.presence.has(session)) return Promise.resolve();
		const entry: PresenceEntry = {};
		// #5607: the token its claim took the id with, or one of its own for an id given here. A granted id is its own as
		// of its claim's write.
		const owner = this.newOwner(grant?.token ?? reclaim?.token);
		if (grant !== undefined && this.state.knownSessions.owners !== undefined)
			entry.owner = { intercomSessionId: session.info.id, token: owner.token, confirmed: grant.confirmed };
		// #5607: a session registered while routing was still opening got its id with nothing shared to check it against:
		// until its first binding write answers, nothing is routed for it as that id's owner.
		const adopted = this.adopting.delete(session);
		let bindingAnswered: (verdict: OwnerVerdict) => void = () => {};
		if (adopted && this.state.knownSessions.owners !== undefined)
			entry.adopting = new Promise<OwnerVerdict>((answered) => {
				bindingAnswered = (verdict) => {
					delete entry.adopting;
					answered(verdict);
				};
			});
		this.presence.set(session, entry);
		const identity = deliveryTargetIdentity(session);
		// #4488: read as the registration begins, so a reservation a release of the child makes from here on is newer.
		const insertedBy = consumed?.childName === undefined ? undefined : this.state.reservations.insertionMark();
		insertedBy?.catch(() => {});
		return new Promise<void>((resolve) => {
			const bound = setTimeout(resolve, PRESENCE_REGISTRATION_BOUND_MS);
			bound.unref?.();
			this.serial(identity, async () => {
				try {
					// An id bound to another session's return address is not this session's across nodes (see `claimSessionId`).
					const confirmed = clockMark();
					let binding: KnownSessionBindResult;
					try {
						binding =
							reclaim === undefined
								? await this.state.knownSessions.bind(
										session.info.id,
										session.registrationReturnAddress ?? "",
										KNOWN_SESSION_RETENTION_MS,
										undefined,
										owner,
									)
								: await this.reclaimOrBind(session, reclaim, owner);
					} catch (error) {
						bindingAnswered("unknown");
						throw error;
					}
					if (binding.status === "refused") {
						bindingAnswered("unknown");
						entry.unbound = true;
						return;
					}
					// #5607: another live registration of the same session owns the id (it registered on another broker while
					// this one was opening its shared routing, or took the id once this one's went unrenewed): that registration
					// keeps it, and this one reconnects for a fresh id.
					if (binding.status === "held") {
						bindingAnswered("lost");
						this.lostSessionId(session, entry);
						return;
					}
					if (binding.status === "bound" && this.state.knownSessions.owners !== undefined)
						entry.owner = {
							intercomSessionId: session.info.id,
							token: owner.token,
							confirmed: laterMark(entry.owner?.confirmed, confirmed),
						};
					bindingAnswered("own");
					await this.recordKnown(session, entry);
					for (let attempt = 0; ; attempt++) {
						await this.acquirePresence(session, entry);
						if (entry.lease !== undefined || attempt >= PRESENCE_HANDOVER_ATTEMPTS || this.presence.get(session) !== entry)
							break;
						await new Promise<void>((wait) => setTimeout(wait, PRESENCE_HANDOVER_RETRY_MS * 2 ** attempt).unref());
					}
					if (consumed !== undefined) {
						// #5138: recorded before the store is asked, so a step a store error interrupts is retried at renewal.
						const { childName, authorizedBy } = consumed;
						const registration =
							childName !== undefined && authorizedBy !== undefined ? { childName, authorizedBy } : undefined;
						if (entry.lease === undefined) entry.rebind = registration;
						entry.unfinished = {
							consume: consumed,
							mark: insertedBy,
							rebind: registration,
							attempts: 0,
						};
						await this.finishRegistration(session, entry);
					}
				} finally {
					clearTimeout(bound);
					resolve();
				}
				this.scanIdentity(identity);
			});
		});
	}

	/**
	 * #5138: run the session's store steps not yet done. Each runs once more after a failure, at each renewal, until
	 * it succeeds or `REGISTRATION_STEP_ATTEMPTS` attempts failed; a failure is reported.
	 */
	private async finishRegistration(session: BrokerConnectedSession, entry: PresenceEntry): Promise<void> {
		const unfinished = entry.unfinished;
		if (unfinished === undefined) return;
		unfinished.attempts++;
		const failures: unknown[] = [];
		const { consume } = unfinished;
		if (consume !== undefined) {
			try {
				await this.consumeReservation(await this.registeredConsumption(session, entry, unfinished, consume));
				delete unfinished.consume;
			} catch (error) {
				failures.push(error);
			}
		}
		const { rebind } = unfinished;
		if (rebind !== undefined) {
			try {
				await this.rebindParked(session, rebind);
				delete unfinished.rebind;
			} catch (error) {
				failures.push(error);
			}
		}
		if (unfinished.failTerminal === true) {
			try {
				await this.failTerminalAsks(session);
				delete unfinished.failTerminal;
			} catch (error) {
				failures.push(error);
			}
		}
		const done =
			unfinished.consume === undefined && unfinished.rebind === undefined && unfinished.failTerminal === undefined;
		// Steps run one at a time per session (`serial`), so `entry.unfinished` is still this record.
		if (done || unfinished.attempts >= REGISTRATION_STEP_ATTEMPTS) delete entry.unfinished;
		if (failures.length > 0) throw failures[0];
	}

	/**
	 * What a registration's consume ends. #4488: the child may have been released since the registration began, while
	 * its presence was being taken over. A reservation its owner made for that release must stay, or the released child
	 * is unreachable: by the child's name, only reservations older than the registration end, none once the session
	 * left, and none when the mark could not be read (#5138); the capability's own one always ends.
	 */
	private async registeredConsumption(
		session: BrokerConnectedSession,
		entry: PresenceEntry,
		unfinished: UnfinishedRegistration,
		consumed: ConsumedReservation,
	): Promise<ConsumedReservation> {
		const ownOnly: ConsumedReservation = {
			groups: consumed.groups,
			...(consumed.capability === undefined ? {} : { capability: consumed.capability }),
		};
		if (this.presence.get(session) !== entry) return ownOnly;
		// A retried consume ends the same reservations: the mark is read once, as the registration began.
		const { mark } = unfinished;
		if (mark === undefined) return consumed;
		try {
			const insertedBy = await mark;
			unfinished.consume = { ...consumed, insertedBy };
		} catch (error) {
			this.report(error);
			unfinished.consume = ownOnly;
		}
		delete unfinished.mark;
		return unfinished.consume;
	}

	/** Presence or memberships changed: the shared subject follows them. */
	sessionUpdated(session: BrokerConnectedSession): void {
		const entry = this.presence.get(session);
		if (this.closed || entry === undefined) return;
		this.serial(deliveryTargetIdentity(session), async () => {
			if (entry.unbound === true) return;
			if (session.info.replyCapability === "terminal" && entry.terminal !== true) {
				entry.terminal = true;
				// #5138: recorded before the store is asked, so a store error is retried at renewal, not lost.
				entry.unfinished = { ...entry.unfinished, failTerminal: true, attempts: 0 };
			}
			await this.recordKnown(session, entry);
			if (entry.unfinished?.failTerminal === true) await this.finishRegistration(session, entry);
			if (entry.lease === undefined) return;
			const renewed = await this.state.leases.renew(entry.lease, this.presenceSubject(session));
			if (renewed.status !== "renewed") entry.lease = undefined;
		});
	}

	/**
	 * The session can no longer answer: the asks other nodes delivered to it get the terminal error a local asker gets
	 * (`failTerminalQuestions`), as a reply correlated to each ask. A remote asker's error travels the outbox, so its
	 * route stays open until that reply is delivered and then closes like any answered ask.
	 */
	private async failTerminalAsks(target: BrokerConnectedSession): Promise<void> {
		const listed = await this.state.pendingAsks.listForTarget(target.info.id);
		if (listed.status !== "listed") return;
		await this.failAsksTo(target.info, listed.asks, TERMINAL_CHILD_ASK_REFUSAL, "terminal", "always");
	}

	/**
	 * #4842: the session ended without replying: the asks other nodes delivered to it fail as a local asker's do
	 * (`Session "<name>" ended before replying`), each asker told once through the outbox, held for an away asker. Its
	 * routes end with it: one is reopened only for an asker outside its groups, whose failure needs one to be delivered.
	 */
	private async failEndedAsks(target: BrokerConnectedSession, asks: readonly PendingAsk[]): Promise<void> {
		const reason = `Session "${target.info.name ?? target.info.id}" ended before replying`;
		await this.failAsksTo(target.info, asks, reason, "ended", "outside-groups");
	}

	/**
	 * #4992: the owner of released subagents left, or dropped one (`reservationKey`): the asks parked for them end, as
	 * its local parked questions do (`failParkedQuestions`), and each asker is told once on any node that the subagent
	 * ended before replying, through the outbox, held for an away asker.
	 */
	private async failParkedAsks(ownerSessionId: string, reservationKey?: string): Promise<void> {
		const ended = await this.state.pendingAsks.endParked(ownerSessionId, reservationKey);
		if (ended.status === "listed") await this.failAsksOfEnded(ended.asks);
	}

	/**
	 * #4992: asks whose target ended, marked so in the shared state, each failed for its asker as sent by that target, as
	 * Intercom last knew it. The departure that marked them fails them; `sweepEndedAsks` fails those a broker that stopped
	 * meanwhile left.
	 */
	private async failAsksOfEnded(endedAsks: readonly PendingAsk[]): Promise<void> {
		const byTarget = new Map<string, PendingAsk[]>();
		for (const ask of endedAsks) byTarget.set(ask.targetSessionId, [...(byTarget.get(ask.targetSessionId) ?? []), ask]);
		for (const [targetSessionId, asks] of byTarget) {
			const known = await this.state.knownSessions.lookup(targetSessionId, KNOWN_SESSION_RETENTION_MS);
			const subagent =
				known.status === "found"
					? known.sessions.find((session) => session.intercomSessionId === targetSessionId)
					: undefined;
			const from: SessionInfo = {
				id: targetSessionId,
				...(subagent?.name === undefined ? {} : { name: subagent.name }),
				...(subagent === undefined ? {} : { group: subagent.group, groups: [...subagent.groups] }),
				cwd: "",
				model: "",
				pid: 0,
				startedAt: 0,
				lastActivity: Date.now(),
			};
			const reason = `Session "${from.name ?? targetSessionId}" ended before replying`;
			await this.failAsksTo(from, asks, reason, "ended", "outside-groups");
		}
	}

	/** #4992: fail the asks that ended more than a stale claim's age ago, which the broker that marked them left. */
	private async sweepEndedAsks(): Promise<void> {
		const ended = await this.state.pendingAsks.listEnded(OUTBOX_CLAIM_STALE_AFTER_MS);
		if (ended.status === "listed") await this.failAsksOfEnded(ended.asks);
	}

	/**
	 * #5154: a recipient whose broker stopped before it recorded the recipient leaving looks like a session that may come
	 * back. One that has not, within its bound (`LOST_RECIPIENT_UNAVAILABLE_AFTER_MS` once its broker restarted, or
	 * `LOST_RECIPIENT_STALE_LEASE_AFTER_MS` past its presence lease going stale) and whose owner holds no reservation
	 * for its return, has its unparked asks failed as "unavailable": marked ended, so of brokers that find it lost at
	 * once only the one that marked an ask tells its asker, through the outbox as an ended recipient's failure.
	 */
	private async sweepLostRecipients(): Promise<void> {
		const { afterRestartMs, afterStaleLeaseMs } = this.lostBounds;
		const presences = await this.state.leases.listLive("presence", Number.MAX_SAFE_INTEGER);
		const live = new Set<string>();
		const lost = new Map<string, { from: SessionInfo; targetIdentity: string; boundMs: number }>();
		for (const lease of presences) {
			const subject = lease.subject as RecipientPresenceSubject;
			if (lease.ageMs <= BROKER_LEASE_STALE_AFTER_MS) {
				live.add(subject.session.id);
				live.add(subject.targetIdentity);
			} else if (lease.ageMs >= BROKER_LEASE_STALE_AFTER_MS + afterStaleLeaseMs) {
				lost.set(subject.session.id, {
					from: subject.session,
					targetIdentity: subject.targetIdentity,
					boundMs: afterStaleLeaseMs,
				});
			}
		}
		for (const known of await this.state.knownSessions.listLost(afterRestartMs)) {
			const from: SessionInfo = {
				id: known.intercomSessionId,
				...(known.name === undefined ? {} : { name: known.name }),
				group: known.group,
				groups: [...known.groups],
				cwd: "",
				model: "",
				pid: 0,
				startedAt: 0,
				lastActivity: Date.now(),
			};
			lost.set(known.intercomSessionId, { from, targetIdentity: known.targetIdentity, boundMs: afterRestartMs });
		}
		for (const [sessionId, { from, targetIdentity, boundMs }] of lost) {
			if (live.has(sessionId) || live.has(targetIdentity) || this.host.sessions.has(sessionId)) continue;
			if (await this.reservedForReturn(sessionId, targetIdentity, from)) continue;
			const ended = await this.state.pendingAsks.endLost(sessionId);
			if (ended.status !== "listed") continue;
			const reason = lostRecipientReason(from.name ?? sessionId, boundMs);
			await this.failAsksTo(from, ended.asks, reason, "ended", "outside-groups", true);
		}
	}

	/** #5154: whether an owner holds a reservation for this session's return, as for a released subagent. */
	private async reservedForReturn(sessionId: string, targetIdentity: string, from: SessionInfo): Promise<boolean> {
		const sender = { sessionId, groups: [...sessionGroups(from)] };
		for (const id of [sessionId, returnAddressOf(targetIdentity)]) {
			if (id === undefined) continue;
			const lookup = await this.state.reservations.lookup(normalizeTarget(id), sender, BROKER_LEASE_STALE_AFTER_MS);
			if (lookup.status === "reserved") return true;
		}
		return false;
	}

	/**
	 * #4852: the session ended: the open questions released subagents asked it fail through each subagent's owner, as a
	 * reply to them would arrive, so the subagent is told once that its recipient ended before replying.
	 */
	private async failReleasedAsksTo(target: BrokerConnectedSession): Promise<void> {
		const open = await this.state.releasedAsks.openForReplier(target.info.id);
		if (open.status !== "listed") return;
		const reason = `Session "${target.info.name ?? target.info.id}" ended before replying`;
		for (const ask of open.asks) {
			const message: Message = {
				id: `ended:${ask.questionId}`,
				timestamp: Date.now(),
				replyTo: ask.questionId,
				replyError: reason,
				content: { text: reason },
			};
			const owner = await ownerOfAsker(this.state, ask);
			if (owner === undefined) continue;
			const frame: ReleasedAskerReplyFrame = {
				type: "released_child_reply",
				childName: ask.childName,
				replyTo: ask.questionId,
				from: target.info,
				message,
			};
			// #4992: queued before its question is claimed. The owner's broker hands it over only while it holds the
			// question (`releasedReplyHandoffRefusal`), so a broker that stops before the claim still has it delivered, and
			// a reply that claimed the question first has it refused. Owed to the open question, so a full queue takes it.
			const enqueued = await this.state.outbox.enqueue({
				targetIdentity: owner.identity,
				originBrokerId: this.brokerId,
				digest: crossNodeDigest(JSON.stringify(frame)),
				frame,
				owed: true,
				...offlineHost(owner.hostBrokerId),
			});
			if (enqueued.status === "invalid" || enqueued.status === "full") continue;
			if (enqueued.status === "inserted" && owner.hostBrokerId !== undefined) {
				await this.bus.publish({ brokerId: owner.hostBrokerId, reason: "outbox", version: enqueued.row.sequence });
			}
			await this.state.releasedAsks.claim({
				questionId: ask.questionId,
				replierSessionId: ask.replierSessionId,
				replyMessageId: message.id,
			});
		}
	}

	/**
	 * Send each asker a failure correlated to its ask. `reopenRoute`: when the ask's route stays recorded, so the
	 * failure is authorized as its reply and the route closes once it is delivered. #4992: each ask is still recorded
	 * when it gets here, and its route is removed only once its failure is written or queued, so a broker that stops
	 * in between leaves the ask open rather than its asker untold; a failure queued again has the same message id and
	 * is not queued twice.
	 */
	private async failAsksTo(
		from: SessionInfo,
		asks: readonly PendingAsk[],
		reason: string,
		idPrefix: string,
		reopenRoute: "always" | "outside-groups",
		retryLater = false,
	): Promise<void> {
		if (asks.length === 0) return;
		const live = (await this.state.leases.listLive("presence", BROKER_LEASE_STALE_AFTER_MS)).filter(
			(lease) => lease.subject.kind === "presence",
		);
		const targetGroups = sessionGroups(from);
		for (const ask of asks) {
			const settled = () =>
				this.state.pendingAsks.clearReply({
					replySenderSessionId: ask.targetSessionId,
					replyTargetSessionId: ask.senderSessionId,
					replyTo: ask.messageId,
				});
			const frame: IntercomDeliveryFrame = {
				type: "message",
				from,
				message: {
					id: `${idPrefix}:${ask.messageId}`,
					timestamp: Date.now(),
					replyTo: ask.messageId,
					replyError: reason,
					// #5154: the recipient may only be away: asking again later may reach it.
					...(retryLater ? { retryLater: true as const } : {}),
					content: { text: reason },
				},
			};
			const local = this.host.sessions.get(ask.senderSessionId);
			if (local !== undefined) {
				// #5145: a broker that stopped after queueing this failure, before it cleared the ask, left the failure to its
				// row: this broker's outbox scans deliver it (at the asker's registration and every backup poll, which runs
				// before this sweep), or already did, so only the ask is settled here. A row that expired was never delivered.
				const queued = await this.state.outbox.read(frame.message.id);
				if (queued.status === "found" && queued.row.state !== "failed") {
					await settled();
					continue;
				}
				// #5004: held until the asker saved it, like a reply.
				deliverHeldToAsker(
					{
						asker: local,
						question: ask,
						from,
						pending: this.host.pendingQuestions,
						write: (socket, written) => this.host.write(socket, written),
						legacy: frame,
					},
					frame.message,
				);
				await settled();
				continue;
			}
			const hosted = live.find((lease) => (lease.subject as RecipientPresenceSubject).session.id === ask.senderSessionId);
			let asker: Pick<KnownSession, "targetIdentity" | "groups"> | undefined;
			if (
				hosted !== undefined &&
				(await this.holdsSessionId(
					ask.senderSessionId,
					returnAddressOf((hosted.subject as RecipientPresenceSubject).targetIdentity),
				))
			) {
				const subject = hosted.subject as RecipientPresenceSubject;
				asker = { targetIdentity: subject.targetIdentity, groups: [...sessionGroups(subject.session)] };
			} else {
				// The first record under the id is the bound session's: its binding was taken from that record or before it.
				const known = await this.state.knownSessions.lookup(ask.senderSessionId, KNOWN_SESSION_RETENTION_MS);
				asker =
					known.status === "found"
						? known.sessions.find((session) => session.intercomSessionId === ask.senderSessionId)
						: undefined;
			}
			if (asker === undefined) {
				await settled();
				continue;
			}
			const enqueued = await this.state.outbox.enqueue({
				targetIdentity: asker.targetIdentity,
				originBrokerId: this.brokerId,
				digest: crossNodeDigest(JSON.stringify(frame)),
				frame,
				owed: true,
				...offlineHost(hosted?.holderId),
			});
			// Not queued: the ask stays marked ended, so a later sweep tries again.
			if (enqueued.status === "full" || enqueued.status === "invalid") continue;
			crashPoint(ASK_FAILURE_QUEUED);
			if (reopenRoute === "outside-groups" && asker.groups.some((group) => targetGroups.has(group))) await settled();
			else {
				await this.state.pendingAsks.unmarkEnded({
					replySenderSessionId: ask.targetSessionId,
					replyTargetSessionId: ask.senderSessionId,
					replyTo: ask.messageId,
				});
			}
			if (enqueued.status === "inserted" && hosted !== undefined) {
				await this.bus.publish({ brokerId: hosted.holderId, reason: "outbox", version: enqueued.row.sequence });
			}
		}
	}

	/**
	 * A session left (cleanly or not): it stays known, so sends to it are queued until it returns anywhere. `ended`: it
	 * ended for good; otherwise a top-level session is only away, and its asks, sent and received, stay open (#4751).
	 */
	sessionLeft(session: BrokerConnectedSession, released?: ReleasedTarget, ended = true): void {
		const entry = this.presence.get(session);
		if (this.closed || entry === undefined) return;
		this.presence.delete(session);
		// Its id names another session across nodes: that session's asks and records are not this one's to end.
		const unbound = entry.unbound === true;
		const identity = deliveryTargetIdentity(session);
		const claims = [...this.inflight.values()].filter((inflight) => inflight.session === session);
		for (const inflight of claims) this.inflight.delete(inflight.row.messageId);
		for (const waiter of [...this.waiters.values()]) {
			// #4642: a hosted session shares its host's socket; only its own sends end with it.
			const sentBySession =
				session.hostedBy === undefined ? waiter.socket === session.socket : waiter.senderSessionId === session.info.id;
			if (sentBySession) this.dropWaiter(waiter);
		}
		const holds = [...this.holds.values()].filter((hold) => hold.senderId === session.info.id);
		for (const hold of holds) {
			clearTimeout(hold.timer);
			this.holds.delete(hold.messageId);
		}
		const sessionId = session.info.id;
		this.serial(identity, async () => {
			if (unbound) return;
			// #5607: another registration owns its id now, and what is shared under the id is that registration's: only what
			// this registration held itself is given back.
			if (entry.fenced === true) {
				for (const inflight of claims) await this.state.outbox.releaseClaim(inflight.claim);
				const stillHere = [...this.presence.keys()].some((other) => deliveryTargetIdentity(other) === identity);
				if (entry.lease !== undefined && !stillHere) {
					await this.state.leases.release(entry.lease);
					await this.wakeWaitingOrigins(identity);
				}
				for (const hold of holds) await this.state.heldSends.drop(hold.messageId);
				await this.releaseMirrorsOf(sessionId);
				return;
			}
			// #5607: first, so the session is free to take its id again on any broker while the rest of its departure runs.
			if (entry.owner !== undefined) await this.releaseOwner(entry.owner);
			// #4751: a top-level session that is only away keeps its asks: a reply to it is queued in the outbox like any
			// send to an offline session, and its own recipient may still answer once it is back.
			const away = session.supervisorId === undefined && !ended;
			// #4842: a terminal session's remaining routes are the failures it already sent, so they are not sent again.
			const terminal = session.info.replyCapability === "terminal";
			// #4992: the replies it sent before it left are queued first, so the asks they answer do not fail. Then, before
			// anything else, the asks that end with it are marked so in the shared state: should this broker stop before
			// their askers are told, another broker tells them (`sweepEndedAsks`).
			// #4386: asks to a released subagent are parked instead; registering again on any node takes its presence over
			// first, so its rebinding always finds them.
			await this.serials.get(`reply:${sessionId}`);
			// #4997: its kept asks that move to the shared state get there first, so they end there, once.
			if (!away && !terminal) await this.moveAsksTo(session).catch((error: Error) => this.report(error));
			const ending = (async () => ({
				asks:
					away || (terminal && released === undefined)
						? []
						: await settleAsksToDeparted(this.state, sessionId, released),
				// #4992: the asks parked for its released subagents end with it, ended or away, as its local ones do.
				parked: await this.state.pendingAsks.endParked(sessionId),
			}))();
			const marked = await ending.catch((error: Error) => {
				this.report(error);
				return undefined;
			});
			// #4386: a released subagent's asks outlive its pending-ask routes, and are kept before it stops being live, so
			// a reply never finds it offline with only its pending asks. A failed write loses them, as a lost local route
			// does: the subagent then wakes at its reply deadline.
			await keepReleasedAsks(this.state, session).catch((error: Error) => this.report(error));
			for (const inflight of claims) await this.state.outbox.releaseClaim(inflight.claim);
			// #4842: an ask that ends with its recipient fails for its asker on any node.
			await (away ? Promise.resolve() : this.state.pendingAsks.pruneSender(sessionId).then(() => undefined))
				.then(async () => {
					if (!away && terminal && released === undefined) {
						await this.state.pendingAsks.takeForTarget(sessionId);
					} else if (!away && !terminal) {
						await this.failEndedAsks(session, marked?.asks ?? []);
						// #4852: so are the questions released subagents asked it, through their owners.
						if (released === undefined) await this.failReleasedAsksTo(session);
					}
					if (marked?.parked.status === "listed") await this.failAsksOfEnded(marked.parked.asks);
				})
				.catch((error: Error) => this.report(error));
			// A session that reconnected here before its old connection was noticed gone holds the same presence lease (same
			// holder, same token): the old connection leaving must not end it for the live one.
			const stillHere = [...this.presence.keys()].some((other) => deliveryTargetIdentity(other) === identity);
			if (entry.lease !== undefined && !stillHere) {
				await this.state.leases.release(entry.lease);
				await this.wakeWaitingOrigins(identity);
			}
			await this.recordKnown(session, entry);
			// #4488: a released child's departure queues again what it never confirmed, and ends its presence, only now.
			// Its owner's broker may have looked for sends waiting for it before then, as it made the child wakeable.
			this.wakeIfWaitedFor(session);
			for (const hold of holds) await this.state.heldSends.drop(hold.messageId);
			await this.releaseMirrorsOf(sessionId);
		});
	}

	/** The reservations this broker mirrors for the owner `ownerSessionId`, released as it leaves. */
	private async releaseMirrorsOf(ownerSessionId: string): Promise<void> {
		for (const [key, mirror] of [...this.mirrored]) {
			if (mirror.lease.ownerSessionId !== ownerSessionId) continue;
			this.mirrored.delete(key);
			await this.state.reservations.release(mirror.lease);
			await this.wakeHeldOrigins(key);
		}
	}

	/** #4488: behind any reserve of it still checking, look again whether sends wait for a released child that left. */
	private wakeIfWaitedFor(session: BrokerConnectedSession): void {
		const ids = new Set(
			[session.info.id, session.registrationReturnAddress].flatMap((id) => (id === undefined ? [] : [normalizeTarget(id)])),
		);
		for (const [key, mirror] of this.mirrored) {
			if (!mirror.wake || mirror.woken === true || !mirror.aliases.some((alias) => ids.has(normalizeTarget(alias)))) continue;
			this.serial(`reservation:${key}`, () => this.wakeWaitingChild(key));
		}
	}

	/** #3761 `received` from a local recipient; true when it confirms a message row this broker claimed for it. */
	received(recipient: BrokerConnectedSession, messageId: string): boolean {
		const inflight = this.inflight.get(messageId);
		if (inflight === undefined || inflight.identity !== deliveryTargetIdentity(recipient)) return false;
		if (inflight.row.frame.type !== "message") return false;
		this.settleDelivered(inflight, recipient, inflight.row.frame);
		return true;
	}

	/**
	 * #4386: the owner answered a handoff of its released subagent's reply that this broker claimed from the shared
	 * outbox; true when it was one. Only an answer to the handoff it was written with settles the row.
	 */
	releasedReplyAcknowledged(
		owner: BrokerConnectedSession,
		messageId: string,
		handoffId: string | undefined,
		accepted: boolean,
	): boolean {
		const inflight = this.inflight.get(messageId);
		if (inflight?.released === undefined || inflight.released.handoffId !== handoffId) return false;
		if (inflight.identity !== deliveryTargetIdentity(owner)) return false;
		this.inflight.delete(messageId);
		void this.settleReleasedReply(inflight, inflight.released.frame, accepted).catch((error: Error) => {
			this.report(error);
			// Not settled: hand the row back so it is handed over again and settled then.
			void this.state.outbox
				.releaseClaim(inflight.claim)
				.then(() => this.scanIdentity(inflight.identity))
				.catch((released: Error) => this.report(released));
		});
		return true;
	}

	private async settleReleasedReply(
		inflight: Inflight,
		frame: ReleasedAskerReplyFrame,
		accepted: boolean,
	): Promise<void> {
		const outcome = releasedReplyAckOutcome(accepted, inflight.claim.attempt, frame.childName);
		const question = { questionId: frame.replyTo, replierSessionId: frame.from.id, replyMessageId: frame.message.id };
		if (outcome.kind === "delivered") {
			if ((await this.state.outbox.markDelivered(inflight.claim)).status !== "delivered") return;
			await this.state.releasedAsks.answer(question);
		} else {
			if ((await this.state.outbox.markFailed(inflight.claim, outcome.reason)).status !== "failed") return;
			if (outcome.question === "reopen") await this.state.releasedAsks.reopen(question);
			else await this.state.releasedAsks.answer(question);
		}
		await this.wakeOrigin(inflight.row);
	}

	/**
	 * #3983 `saving` from a local recipient: it is still saving a row this broker claimed for it. Recorded on the
	 * row, so the sender's broker keeps its sender waiting. True when it matches such a row.
	 */
	saving(recipient: BrokerConnectedSession, messageId: string): boolean {
		const inflight = this.inflight.get(messageId);
		if (inflight === undefined || inflight.identity !== deliveryTargetIdentity(recipient)) return false;
		const report = this.state.outbox.reportSaving?.(inflight.claim);
		if (report !== undefined) void report.catch((error: Error) => this.report(error));
		return true;
	}

	/**
	 * Sessions other brokers host now (live presence leases), keyed by session id, for `list`: a session connected
	 * through another node is a live peer exactly like a local one. Group visibility is the caller's, as for local
	 * sessions. A database that fails or does not answer within `REMOTE_SESSIONS_BOUND_MS` yields none.
	 */
	remoteSessions(): Promise<Map<string, { readonly info: SessionInfo }>> {
		const remote = new Map<string, { readonly info: SessionInfo }>();
		if (this.closed) return Promise.resolve(remote);
		// #5607: the local sessions whose ids need checking are checked within the same bound, so one that lost its id is
		// disconnected before the list is answered. Without an answer it is listed, as the local list never depends on the
		// shared database.
		const owners = [...this.host.sessions.values()].flatMap((session) => this.ownerCheck(session) ?? []);
		const checked = owners.length === 0 ? undefined : withinBound(Promise.all(owners), REMOTE_SESSIONS_BOUND_MS, undefined);
		return Promise.all([checked, this.listRemoteSessions(remote)]).then(([, listed]) => {
			for (const id of [...listed.keys()]) if (this.host.sessions.has(id)) listed.delete(id);
			return listed;
		});
	}

	private listRemoteSessions(
		remote: Map<string, { readonly info: SessionInfo }>,
	): Promise<Map<string, { readonly info: SessionInfo }>> {
		return new Promise((resolve) => {
			const bound = setTimeout(() => resolve(new Map()), REMOTE_SESSIONS_BOUND_MS);
			bound.unref?.();
			void this.state.leases.listLive("presence", BROKER_LEASE_STALE_AFTER_MS).then(
				(live) => {
					clearTimeout(bound);
					for (const lease of live) {
						if (lease.subject.kind !== "presence" || lease.holderId === this.brokerId) continue;
						const info = lease.subject.session;
						if (!remote.has(info.id)) remote.set(info.id, { info });
					}
					resolve(remote);
				},
				(error: Error) => {
					clearTimeout(bound);
					this.report(error);
					resolve(new Map());
				},
			);
		});
	}

	/**
	 * Whether another broker holds the live presence of `targetIdentity`: a registration of that identity is connected
	 * there. Read behind what this broker already queued for the identity, without holding up what it queues next, so a
	 * slow read never delays a later registration of it. A database that fails or does not answer within
	 * `REMOTE_SESSIONS_BOUND_MS` counts as no, and its late answer is ignored.
	 */
	identityPresentElsewhere(targetIdentity: string): Promise<boolean> {
		if (this.closed) return Promise.resolve(false);
		const earlier = this.serials.get(targetIdentity) ?? Promise.resolve();
		return new Promise((resolve) => {
			const bound = setTimeout(() => resolve(false), REMOTE_SESSIONS_BOUND_MS);
			bound.unref?.();
			void earlier
				.then(() => this.state.leases.read({ kind: "presence", targetIdentity }))
				.then(
					(read) =>
						resolve(
							read.status === "found" &&
								read.lease.holderId !== this.brokerId &&
								read.lease.ageMs < BROKER_LEASE_STALE_AFTER_MS,
						),
					(error: Error) => {
						this.report(error);
						resolve(false);
					},
				)
				.finally(() => clearTimeout(bound));
		});
	}

	/**
	 * The host names of the other brokers whose membership lease is live, for status reports. `undefined` when the
	 * database fails or does not answer within `REMOTE_SESSIONS_BOUND_MS`.
	 */
	peerBrokers(): Promise<string[] | undefined> {
		if (this.closed) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			const bound = setTimeout(() => resolve(undefined), REMOTE_SESSIONS_BOUND_MS);
			bound.unref?.();
			void this.state.leases.listLive("broker", BROKER_LEASE_STALE_AFTER_MS).then(
				(live) => {
					clearTimeout(bound);
					resolve(
						live.flatMap((lease) =>
							lease.subject.kind === "broker" && lease.holderId !== this.brokerId ? [lease.subject.nodeId] : [],
						),
					);
				},
				(error: Error) => {
					clearTimeout(bound);
					this.report(error);
					resolve(undefined);
				},
			);
		});
	}

	// ---------------------------------------------------------------------------------------------------------
	// Restoring reservations (§5.7): mirror this broker's reservations so senders on any host hold their sends.

	/**
	 * Resolves true once other brokers can find the reservation, or false when its shared write failed or did not answer
	 * within `RESERVATION_PUBLISH_BOUND_MS`: the reservation then holds sends on this broker, and the write is retried at
	 * each renewal until it lands or the reservation ends.
	 */
	restoringReserved(
		capability: string,
		ownerSessionId: string,
		childName: string,
		group: string,
		aliases: readonly string[],
		dormant: boolean,
		options: ReservationOptions = {},
	): Promise<boolean> {
		if (this.closed) return Promise.resolve(true);
		const reservationKey = reservationKeyFor(capability);
		const pending: UnpublishedReservation = {
			capability,
			ownerSessionId,
			owner: this.host.sessions.get(ownerSessionId),
			childName,
			group,
			aliases,
			dormant,
			options,
		};
		this.unpublished.set(reservationKey, pending);
		this.serial(`reservation:${reservationKey}`, () => this.publishReservation(reservationKey, pending, false));
		// #5352: the owner is acknowledged once other brokers can find the reservation, so a sender that learns of the
		// child afterwards is held rather than told it is not found. A database that does not answer is waited for only
		// up to `RESERVATION_PUBLISH_BOUND_MS`.
		const written = this.serials.get(`reservation:${reservationKey}`) ?? Promise.resolve();
		return new Promise<boolean>((resolve) => {
			const settle = () => resolve(this.unpublished.get(reservationKey) !== pending);
			const bound = setTimeout(settle, RESERVATION_PUBLISH_BOUND_MS);
			bound.unref?.();
			void written.finally(() => {
				clearTimeout(bound);
				settle();
			});
		});
	}

	/**
	 * Write a reservation made here to the shared database. It stays unpublished, for the renewal to write again, only
	 * while the write fails. The first write runs in its key's order, so a release or departure after it ends what it
	 * wrote; a `retry` writes nothing once the reservation was released, consumed, replaced or made again, or its owner
	 * left, and ends what it wrote when that happened while it was writing.
	 */
	private async publishReservation(reservationKey: string, pending: UnpublishedReservation, retry: boolean): Promise<void> {
		const { capability, ownerSessionId, owner, childName, group, aliases, dormant, options } = pending;
		if (
			retry &&
			(this.unpublished.get(reservationKey) !== pending ||
				this.host.sessions.get(ownerSessionId) !== owner ||
				!this.host.holdsReservation(capability, ownerSessionId))
		) {
			if (this.unpublished.get(reservationKey) === pending) this.unpublished.delete(reservationKey);
			return;
		}
		const settled = () => {
			if (this.unpublished.get(reservationKey) === pending) this.unpublished.delete(reservationKey);
		};
		const wake = options.wake === true;
		const previous = this.mirrored.get(reservationKey);
		const reserved = await this.state.reservations.reserve({
			reservationKey,
			ownerSessionId,
			ownerBrokerId: this.brokerId,
			childName,
			childTarget: normalizeTarget(childName),
			aliases: aliases.map(normalizeTarget).filter((alias) => alias.length > 0),
			group,
			dormant,
			wake,
			...(options.replaceAliases === true ? { replaceAliases: true } : {}),
			staleAfterMs: BROKER_LEASE_STALE_AFTER_MS,
		});
		settled();
		if (reserved.status === "not-owner") {
			this.host.revokeReleasedReservation(reservationKey, ownerSessionId);
			return;
		}
		if (reserved.status !== "reserved") return;
		// The owner left (or its id was taken over) while the reserve was being written: its departure scanned the
		// mirrors before this one existed, so end the reservation here instead of renewing it for a gone owner. A retry
		// likewise ends what it wrote for a reservation its child took, or a newer one replaced, meanwhile: those ran
		// outside this key's order.
		if (
			this.host.sessions.get(ownerSessionId) !== owner ||
			(retry && !this.host.holdsReservation(capability, ownerSessionId))
		) {
			await this.state.reservations.release(reserved.lease);
			await this.wakeHeldOrigins(reservationKey);
			if (retry) this.republishSuperseded(reserved.superseded);
			return;
		}
		const woken =
			wake && previous?.woken === true && previous.lease.fencingToken === reserved.lease.fencingToken;
		const superseded = new Set(
			previous?.lease.fencingToken === reserved.lease.fencingToken ? previous.superseded : undefined,
		);
		for (const key of reserved.superseded) {
			superseded.add(key);
			for (const earlier of this.mirrored.get(key)?.superseded ?? []) superseded.add(earlier);
		}
		this.mirrored.set(reservationKey, {
			lease: reserved.lease,
			wake,
			aliases,
			group,
			...(woken ? { woken } : {}),
			...(superseded.size > 0 ? { superseded: [...superseded] } : {}),
			...(isReleasedReservationKey(capability) ? {} : { capability }),
			publication: pending,
		});
		await this.wakeWaitingChild(reservationKey);
	}

	/**
	 * #5352: a stale retry ended the newer reservations of its child that it superseded as it wrote: the ones this broker
	 * still holds are written again, in their keys' order.
	 */
	private republishSuperseded(keys: readonly string[]): void {
		for (const key of keys) {
			const publication = this.mirrored.get(key)?.publication;
			if (publication === undefined || !this.host.holdsReservation(publication.capability, publication.ownerSessionId))
				continue;
			this.mirrored.delete(key);
			this.unpublished.set(key, publication);
			this.serial(`reservation:${key}`, () => this.publishReservation(key, publication, true));
		}
	}

	/**
	 * #4401: ask the owner to wake a released child it reserved here while sends wait for it, once per reservation.
	 * Derived from the shared state on every reserve and backup poll, so a broker that restarted, or a new owner
	 * process that reserves the child again, replays a wake a crash lost.
	 */
	private async wakeWaitingChild(reservationKey: string): Promise<void> {
		const mirror = this.mirrored.get(reservationKey);
		if (mirror?.wake !== true || mirror.woken === true) return;
		const reservation = await this.activeReservation(reservationKey);
		if (reservation?.wake !== true) return;
		const messageId = await this.sendsWaitFor(reservationKey, mirror.aliases, mirror.group);
		if (messageId === undefined || mirror.woken === true) return;
		await this.requestWake(reservation, messageId);
	}

	/**
	 * Sends held for the reservation, or queued in the shared outbox for a session the child registered as while no
	 * broker hosts that session. A session is matched only by the exact ids its owner reserved, never by name. An id no
	 * known session holds any more, because the brokers forgot the child after `KNOWN_SESSION_RETENTION_MS` while its
	 * owner was away, still finds the sends queued for it: under the delivery identities a session registered with that
	 * id in the reserved group has (#4401).
	 */
	private async sendsWaitFor(reservationKey: string, aliases: readonly string[], group: string): Promise<string | undefined> {
		const held = await this.state.heldSends.list(reservationKey);
		if (held.status === "listed" && held.sends.length > 0) return held.sends[0].request.message.id;
		for (const alias of aliases) {
			const known = await this.state.knownSessions.lookup(alias, KNOWN_SESSION_RETENTION_MS);
			if (known.status !== "found") continue;
			const matching = known.sessions.filter(
				(session) => session.intercomSessionId === alias || session.atomicSessionId === alias,
			);
			const identities =
				matching.length > 0
					? matching.map((session) => session.targetIdentity)
					: forgottenSessionIdentities(alias, group);
			for (const targetIdentity of identities) {
				const presence = await this.state.leases.read({ kind: "presence", targetIdentity });
				if (presence.status === "found" && presence.lease.ageMs < BROKER_LEASE_STALE_AFTER_MS) continue;
				const queued = await this.state.outbox.listUndelivered(targetIdentity, 1);
				if (queued.status === "listed" && queued.rows.length > 0) return queued.rows[0].messageId;
			}
		}
		return undefined;
	}

	/** Ask the broker that owns a released child's reservation to wake it; this broker when it is the owner. */
	private async requestWake(reservation: RestoringReservation, messageId: string): Promise<void> {
		const { reservationKey, ownerBrokerId, fencingToken, wakeGeneration } = reservation;
		const requested = await this.state.reservations.requestWake(reservationKey, { fencingToken, wakeGeneration, messageId });
		if (requested.status !== "requested") return;
		if (ownerBrokerId === this.brokerId) await this.deliverWakeRequests();
		else await this.bus.publish({ brokerId: ownerBrokerId, reason: "outcome", version: 0 });
	}

	/** Tell the owners connected here that a send started holding for a released child they reserved (#4326). */
	private async deliverWakeRequests(): Promise<void> {
		const taken = await this.state.reservations.takeWakeRequests(this.brokerId);
		if (taken.status !== "taken") return;
		for (const request of taken.requests) {
			const owner = this.host.sessions.get(request.ownerSessionId);
			if (owner === undefined) continue;
			const mirror = this.mirrored.get(request.reservationKey);
			this.host.write(owner.socket, {
				type: "restoring_recipient_wake",
				childName: request.childName,
				...(mirror?.capability === undefined ? {} : { capability: mirror.capability }),
			});
			if (mirror !== undefined) mirror.woken = true;
		}
	}

	/** The owner released the reservation; `gone` is the formatted gone refusal kept as a marker. */
	restoringReleased(capability: string, ownerSessionId: string, gone?: string, refusal?: string): void {
		if (this.closed) return;
		const reservationKey = reservationKeyFor(capability);
		// #5352: a reservation whose write has not landed is not written after its release.
		if (this.unpublished.get(reservationKey)?.ownerSessionId === ownerSessionId) this.unpublished.delete(reservationKey);
		// Behind the reserve on the same key: a release while the reserve is still being written ends what it wrote.
		this.serial(`reservation:${reservationKey}`, async () => {
			// #4386: asks parked for a released subagent its owner no longer holds end here, as its local ones do; #4992:
			// each asker is told, on any node.
			await this.failParkedAsks(ownerSessionId, reservationKey);
			const mirror = this.mirrored.get(reservationKey);
			if (mirror === undefined || mirror.lease.ownerSessionId !== ownerSessionId) return;
			if (gone === undefined) this.mirrored.delete(reservationKey);
			await this.state.reservations.release(
				mirror.lease,
				gone !== undefined ? { gone } : refusal !== undefined ? { refusal } : undefined,
			);
			await this.wakeHeldOrigins(reservationKey);
		});
	}

	private async consumeReservation(consumed: ConsumedReservation): Promise<void> {
		const reservationKey =
			consumed.capability !== undefined
				? reservationKeyFor(consumed.capability)
				: consumed.childName === undefined
					? undefined
					: releasedReservationKey(consumed.childName);
		if (reservationKey === undefined) return;
		// #5352: the child took its reservation; one whose write has not landed is not written now.
		this.unpublished.delete(reservationKey);
		const result = await this.state.reservations.consume(
			reservationKey,
			consumed.childName === undefined
				? undefined
				: {
						childTarget: normalizeTarget(consumed.childName),
						groups: [...consumed.groups],
						...(consumed.authorizedBy === undefined ? {} : { authorizedBy: consumed.authorizedBy }),
						...(consumed.capability === undefined ? { releasedOnly: true as const } : {}),
						...(consumed.insertedBy === undefined ? {} : { insertedBy: consumed.insertedBy }),
					},
		);
		if (result.status !== "consumed") return;
		for (const key of result.reservationKeys) {
			const superseded = this.mirrored.get(key)?.superseded ?? [];
			this.mirrored.delete(key);
			await this.wakeHeldOrigins(key);
			// #4488: a send held for a reservation this one took over, such as a released child's before its wake
			// restored it, is handed on now that the child is back, not at its origin's next outcome poll.
			for (const earlier of superseded) await this.wakeHeldOrigins(earlier);
		}
	}

	/** Tell every origin holding a send for this reservation to read it; drop rows no live broker owns. */
	private async wakeHeldOrigins(reservationKey: string): Promise<void> {
		const listed = await this.state.heldSends.list(reservationKey);
		if (listed.status !== "listed" || listed.sends.length === 0) return;
		const live = new Set(
			(await this.state.leases.listLive("broker", BROKER_LEASE_STALE_AFTER_MS)).map((lease) => lease.holderId),
		);
		const origins = new Set<string>();
		for (const send of listed.sends) {
			if (live.has(send.originBrokerId) || send.originBrokerId === this.brokerId) origins.add(send.originBrokerId);
			else await this.state.heldSends.drop(send.request.message.id);
		}
		for (const origin of origins) {
			if (origin === this.brokerId) void this.checkHolds();
			else await this.bus.publish({ brokerId: origin, reason: "outcome", version: 0 });
		}
	}

	// ---------------------------------------------------------------------------------------------------------
	// Sending to another node

	/** Answer a send no local session resolved: another node's session, a shared hold, an offline session, or none. */
	routeSend(request: RemoteSendRequest): void {
		// #4386: one sender's replies are routed in the order it sent them, so they reach an owner in that order.
		// #4992: a departing replier waits for this queue, so its asks fail only after the replies it sent are queued.
		if (isReleasedReplyCandidate(request)) this.serial(`reply:${request.from.info.id}`, () => this.routeSendSafely(request));
		else void this.routeSendSafely(request);
	}

	private async routeSendSafely(request: RemoteSendRequest): Promise<void> {
		// #5607: a sender or local recipient whose id may have passed to another registration is checked first.
		const owners = this.sendOwnerChecks(request);
		try {
			if (request.localTarget !== undefined) await this.answerLocalRetry(request, request.localTarget, owners);
			else if (owners === undefined || (await this.senderOwns(request, owners))) await this.route(request);
		} catch (error) {
			this.report(error);
			// Local delivery does not depend on the shared database (spec §8).
			if (request.localTarget !== undefined) return request.notFound();
			this.fail(request, SHARED_STORAGE_UNAVAILABLE_REASON, request.requirePendingReply ? "session_not_found" : undefined);
		}
	}

	/**
	 * #5607: a send through the shared state goes out under its sender's id only once the store confirms the id is still
	 * the sender's; it needs the store anyway. A store that does not answer within `SESSION_ID_CLAIM_BOUND_MS` fails it as
	 * an unreachable store does; a sender that lost its id was disconnected here, and nothing goes out for it.
	 */
	private async senderOwns(request: RemoteSendRequest, owners: Promise<SendOwnerVerdicts>): Promise<boolean> {
		const verdict = await withinBound(
			owners.then((verdicts) => verdicts.sender),
			SESSION_ID_CLAIM_BOUND_MS,
			"unknown" as const,
		);
		if (verdict === "own") return true;
		if (verdict === "unknown")
			this.fail(request, SHARED_STORAGE_UNAVAILABLE_REASON, request.requirePendingReply ? "session_not_found" : undefined);
		return false;
	}

	private async route(request: RemoteSendRequest): Promise<void> {
		if (request.message.replyTo !== undefined) await Promise.all([...this.settling]);
		if (await this.routeReleasedReply(request)) return;
		const from = request.from;
		const live = (await this.state.leases.listLive("presence", BROKER_LEASE_STALE_AFTER_MS)).filter(
			(lease) =>
				lease.subject.kind === "presence" &&
				lease.holderId !== this.brokerId &&
				!this.host.sessions.has(lease.subject.session.id),
		);
		const presenceOf = (lease: LeaseState) => lease.subject as RecipientPresenceSubject;
		const exact = live.find((lease) => presenceOf(lease).session.id === request.target);
		let resolved: LeaseState | undefined = exact;
		if (resolved === undefined) {
			const replyAuthorized = await this.replyAuthorizedTargets(
				request,
				live.map((lease) => presenceOf(lease).session.id),
			);
			const visible = live.filter((lease) => {
				const info = presenceOf(lease).session;
				return (
					reachesSession(from, info) ||
					(request.supervisorSend && info.id === from.supervisorId) ||
					replyAuthorized.has(info.id)
				);
			});
			const nonAgentNamed = visible.some(
				(lease) =>
					!isAgentRecipient(presenceOf(lease).session) &&
					presenceOf(lease).session.name?.toLowerCase() === request.target.toLowerCase(),
			);
			const agents = visible.filter((lease) => isAgentRecipient(presenceOf(lease).session));
			const infos = agents.map((lease) => presenceOf(lease).session);
			let resolution: SessionTargetResolution = resolveSessionTarget(infos, request.target);
			if (resolution.kind === "not_found") {
				resolution = resolveSessionTargetByHostSessionId(infos, request.target, (info) => {
					const lease = agents.find((candidate) => presenceOf(candidate).session === info);
					return lease === undefined ? undefined : returnAddressOf(presenceOf(lease).targetIdentity);
				});
			}
			// A sender this one holds a return path to answers to its name only when nothing visible does.
			const answerable = resolution.kind === "not_found"
				? live.filter(
						(lease) =>
							isAgentRecipient(presenceOf(lease).session) &&
							!agents.includes(lease) &&
							this.holdsReturnPath(request, {
								sessionId: presenceOf(lease).session.id,
								identity: stableIdentity(presenceOf(lease).targetIdentity),
							}),
					)
				: [];
			if (answerable.length > 0) {
				const answered = resolveSessionTarget(answerable.map((lease) => presenceOf(lease).session), request.target);
				if (answered.kind !== "not_found") {
					resolution = answered;
					agents.push(...answerable);
				}
			}
			if (resolution.kind === "resolved") {
				const session = resolution.session;
				resolved = agents.find((lease) => presenceOf(lease).session === session);
			} else if (resolution.kind !== "not_found") {
				this.fail(request, sessionTargetFailureReason(request.clientMessage.to, resolution));
				return;
			} else if (nonAgentNamed) {
				this.fail(request, NON_AGENT_RECIPIENT_REFUSAL);
				return;
			}
		}
		// A presence whose id is bound to another session's return address (from a broker that grants ids without
		// binding them) is not that session: what is addressed to the id waits for the session it is bound to.
		if (
			resolved !== undefined &&
			!(await this.holdsSessionId(presenceOf(resolved).session.id, returnAddressOf(presenceOf(resolved).targetIdentity)))
		) {
			resolved = undefined;
		}
		if (resolved !== undefined) {
			const subject = presenceOf(resolved);
			await this.deliverThroughOutbox(request, {
				identity: subject.targetIdentity,
				sessionId: subject.session.id,
				groups: sessionGroups(subject.session),
				gates: subject.session,
				hostBrokerId: resolved.holderId,
			});
			return;
		}
		if (!request.supervisorSend && !request.requirePendingReply && request.expectedRecipientId === undefined) {
			if (await this.holdForRemoteReservation(request)) return;
		}
		const known = await this.resolveKnownSession(request);
		if (known === "answered") return;
		if (known !== undefined) {
			await this.deliverThroughOutbox(request, {
				identity: known.targetIdentity,
				sessionId: known.intercomSessionId,
				groups: new Set(known.groups),
				gates: known,
			});
			return;
		}
		request.notFound();
	}

	/** #4386: a reply to a released asker's question goes to the asker's owner, once; true when it was one. */
	private async routeReleasedReply(request: RemoteSendRequest, answered?: ReleasedAskRecord): Promise<boolean> {
		const decision = await decideReleasedAskerReply(this.state, request, answered);
		if (decision === undefined) return false;
		switch (decision.kind) {
			case "refused":
				this.failReleasedReply(request, decision.error);
				return true;
			case "deliver":
				await this.sendReleasedReply(request, decision);
				return true;
		}
	}

	/**
	 * #4997: a reply to a session on this broker, whose ask this broker's own routes do not know: an ask delivered while
	 * its peers were on different brokers, or kept while one was away, has its route in the shared state. Both peers are
	 * here now, so the route becomes this broker's own, and the shared one is settled, so the ask has one outcome.
	 */
	/**
	 * #4997: a reply to a session here that no route authorizes, here or in the shared state, while a broker that may
	 * keep its ask's route is down, is refused as retryable rather than by the local path's final refusal. True when
	 * the reply was answered.
	 */
	private async routeUnreachable(request: RemoteSendRequest, target: BrokerConnectedSession): Promise<boolean> {
		const replyTo = request.message.replyTo;
		if (!request.requirePendingReply || replyTo === undefined) return false;
		if (this.host.pendingQuestions.matchesReply(request.from.info.id, target.info.id, replyTo)) return false;
		// A retry of a reply already delivered here is answered by the local path.
		if (this.host.deliveredMessages.lookupForTarget(request.message.id, request.signature, deliveryTargetIdentity(target)) !== "miss")
			return false;
		const asker = { sessionId: target.info.id, identity: deliveryTargetIdentity(target) };
		const elsewhere = this.routeMayBeElsewhere(request, asker.sessionId, asker.identity).catch(() => false);
		// A shared database that stops answering leaves the reply undecided: it is refused as retryable, once, within the
		// bound, so neither it nor the sender's later replies wait on that database for good. It authorizes nothing.
		let bound: ReturnType<typeof setTimeout> | undefined;
		const expired = new Promise<"expired">((resolve) => {
			bound = setTimeout(() => resolve("expired"), PRESENCE_REGISTRATION_BOUND_MS);
			bound.unref?.();
		});
		try {
			const decided = await Promise.race([elsewhere, expired]);
			if (decided === false) return false;
		} finally {
			clearTimeout(bound);
		}
		this.refuseRouteUnavailable(request);
		return true;
	}

	private async adoptSharedRouteWithin(request: RemoteSendRequest, target: BrokerConnectedSession): Promise<void> {
		const late = { abandoned: false };
		const adopted = this.adoptSharedRoute(request, target, late);
		// A reply that must answer an open ask can only be authorized by the shared state when this broker's routes do not
		// authorize it, so it waits for that state longer than a send the local path delivers anyway.
		const boundMs = request.requirePendingReply ? PRESENCE_REGISTRATION_BOUND_MS : LOCAL_RETRY_LOOKUP_BOUND_MS;
		let bound: ReturnType<typeof setTimeout> | undefined;
		const expired = new Promise<"expired">((resolve) => {
			bound = setTimeout(() => resolve("expired"), boundMs);
			bound.unref?.();
		});
		try {
			if ((await Promise.race([adopted, expired])) === "expired") {
				// The send takes the local path now: a route found later is left where it is, for a retry to find.
				late.abandoned = true;
				adopted.catch((error: Error) => this.report(error));
			}
		} catch (error) {
			this.report(error);
		} finally {
			clearTimeout(bound);
		}
	}

	private async adoptSharedRoute(
		request: RemoteSendRequest,
		target: BrokerConnectedSession,
		late: { readonly abandoned: boolean },
	): Promise<void> {
		const replyTo = request.message.replyTo;
		const replySenderSessionId = request.from.info.id;
		if (replyTo === undefined) return;
		if (this.host.pendingQuestions.matchesReply(replySenderSessionId, target.info.id, replyTo)) return;
		// An ask whose route is still moving there from this broker is in the shared state once that move is done.
		await Promise.all([...this.settling]);
		if (this.host.pendingQuestions.matchesReply(replySenderSessionId, target.info.id, replyTo)) return;
		const route = { replySenderSessionId, replyTargetSessionId: target.info.id, replyTo };
		if ((await this.state.pendingAsks.matchesReply(route)).status !== "match" || late.abandoned) return;
		this.host.pendingQuestions.record(target.info.id, replySenderSessionId, replyTo);
		await this.settleSharedRoute({ senderSessionId: target.info.id, targetSessionId: replySenderSessionId, messageId: replyTo });
	}

	/**
	 * #4997: the session ended: its kept asks that move to the shared state get there first, so they fail there, once.
	 * One the shared state does not take fails here, as on a single node.
	 */
	private async moveAsksTo(session: BrokerConnectedSession): Promise<void> {
		const pending = this.host.pendingQuestions;
		const moving = pending.movableDormant().filter((ask) => ask.targetSessionId === session.info.id);
		await this.publishAwayRoutes(moving);
		await Promise.all([...this.settling]);
		if (!moving.some((ask) => pending.isDormant(ask))) return;
		const reason = `Session "${session.info.name ?? session.info.id}" ended before replying`;
		pending.failDormantForTarget(session.info, reason, "recipient-ended", session.registrationReturnAddress);
	}

	/**
	 * #4997: a session that left without ending may come back on another broker, so the asks between it and a session
	 * here, kept on this broker (durably, before this is called), move to the shared state, where either broker answers
	 * and settles them. Each stays kept here until its shared route is written, so neither a crash nor a reply in
	 * between finds no route; one this broker took up meanwhile (its peer came back here, or it was answered or failed
	 * here) is this broker's alone, and its shared route is settled. One whose write fails stays here, to move later.
	 */
	publishAwayRoutes(questions: readonly PendingQuestion[]): Promise<void> {
		if (questions.length === 0) return Promise.resolve();
		let finished!: () => void;
		const publishing = new Promise<void>((resolve) => {
			finished = resolve;
		});
		this.settling.add(publishing);
		void publishing.finally(() => this.settling.delete(publishing));
		// One move at a time, so an ask two moves both see kept is written once and dropped here once.
		this.serial("away-routes", async () => {
			try {
				for (const question of questions) {
					if (!this.host.pendingQuestions.isDormant(question)) continue;
					const ask = {
						senderSessionId: question.senderSessionId,
						targetSessionId: question.targetSessionId,
						messageId: question.messageId,
					};
					const recorded = await this.state.pendingAsks.record(ask);
					if (recorded.status === "invalid") continue;
					// #4997: answered or failed on another broker while this one kept its copy: the copy goes.
					if (recorded.status === "settled") {
						this.host.pendingQuestions.takeDormant(question);
						continue;
					}
					if (!this.host.pendingQuestions.takeDormant(question)) await this.settleSharedRoute(ask);
				}
			} finally {
				finished();
			}
		});
		return publishing;
	}

	/** #4997: asks this broker took up again, as both of their peers are here: their shared routes, if any, are settled. */
	settleRestoredRoutes(questions: readonly PendingQuestion[]): void {
		for (const question of questions) {
			void this.settleSharedRoute(question).catch((error: Error) => this.report(error));
		}
	}

	/**
	 * The ask is this broker's own now: its shared route goes, without settling the ask, as the ask may move again. Its
	 * answer here settles it in the shared state (`answeredHere`), so no copy of the route is recorded there again.
	 */
	private async settleSharedRoute(question: PendingQuestion): Promise<void> {
		this.adopted.add(askKey(question));
		await this.state.pendingAsks.releaseRoute({
			replySenderSessionId: question.targetSessionId,
			replyTargetSessionId: question.senderSessionId,
			replyTo: question.messageId,
		});
	}

	/** #4997: the asks this broker took over from the shared state, until they are answered here. */
	private readonly adopted = new Set<string>();

	/**
	 * #4997: an ask this broker took over from the shared state was answered here: it is settled there too, so a copy
	 * of its route that a stopped broker kept is not recorded again, and its recipient's end fails nothing.
	 */
	private answeredHere(question: PendingQuestion): void {
		if (!this.adopted.delete(askKey(question))) return;
		const settling = this.state.pendingAsks
			.clearReply({
				replySenderSessionId: question.targetSessionId,
				replyTargetSessionId: question.senderSessionId,
				replyTo: question.messageId,
			})
			.then(() => undefined)
			.catch((error: Error) => this.report(error));
		this.settling.add(settling);
		void settling.finally(() => this.settling.delete(settling));
	}

	/**
	 * #4386: a released asker that woke on this broker, under the id it asked with, resolves here, but its question to
	 * this reply's sender is kept only in the shared state. The question, for a reply to it that this broker's own ask
	 * routes do not answer: the reply goes to the asker's owner as on any other broker.
	 */
	private async movedReleasedAsk(
		request: RemoteSendRequest,
		target: BrokerConnectedSession,
	): Promise<ReleasedAskRecord | undefined> {
		if (!isReleasedReplyCandidate(request)) return undefined;
		if (this.host.pendingQuestions.matchesReply(request.from.info.id, target.info.id, request.message.replyTo)) {
			return undefined;
		}
		return releasedAskAnswered(this.state, request);
	}

	/**
	 * Where a send answered from its row went: the local session, or for a released asker's reply its owner. A settled
	 * reply needs nothing more; an unsettled one waits for the owner where it is live, or as queued when its presence
	 * cannot be read within the local bound.
	 */
	private async rowRecipient(
		row: OutboxRow,
		target: BrokerConnectedSession,
		expired: Promise<"expired">,
	): Promise<RemoteTarget> {
		if (row.frame.type !== "released_child_reply") {
			return {
				identity: deliveryTargetIdentity(target),
				sessionId: target.info.id,
				groups: sessionGroups(target.info),
				gates: target.info,
				hostBrokerId: this.brokerId,
			};
		}
		const offline: RemoteTarget = { identity: row.targetIdentity, sessionId: "", groups: new Set(), gates: {} };
		if (row.state === "delivered" || row.state === "failed") return offline;
		const owner = ownerOfReleasedReplyRow(this.state, row).catch((error: Error) => {
			this.report(error);
			return undefined;
		});
		const found = await Promise.race([owner, expired]);
		return found === "expired" || found === undefined ? offline : { ...found, groups: new Set(), gates: {} };
	}

	/** Enqueue the owner's frame; a same-id retry is answered from the row it already has, exactly as any send. */
	private async sendReleasedReply(request: RemoteSendRequest, decision: ReleasedReplyDelivery): Promise<void> {
		const { owner, frame } = decision;
		const digest = crossNodeDigest(request.signature);
		const enqueued = await this.state.outbox
			.enqueue({
				targetIdentity: owner.identity,
				originBrokerId: this.brokerId,
				digest,
				frame,
				...offlineHost(owner.hostBrokerId),
			})
			.catch((error: Error) => this.reopenAfter(decision, error));
		if (enqueued.status === "conflict") {
			await this.reopenQuestion(decision);
			this.failConflict(request);
			return;
		}
		if (enqueued.status === "invalid") {
			await this.reopenQuestion(decision);
			this.fail(request, "Session not found");
			return;
		}
		if (enqueued.status === "full") {
			await this.reopenQuestion(decision);
			this.fail(request, outboxFullReason(enqueued));
			return;
		}
		await this.answerExistingRow(request, { ...owner, groups: new Set(), gates: {} }, digest, enqueued.row);
	}

	/** #4386: a reply that claimed its question but left no row to hand over gives the question back to other replies. */
	private async reopenQuestion(decision: ReleasedReplyDelivery): Promise<void> {
		if (decision.claim !== undefined) await this.state.releasedAsks.reopen(decision.claim);
	}

	/** The enqueue failed: give the question back, and fail with that failure, joined by the reopen's if it failed too. */
	private async reopenAfter(decision: ReleasedReplyDelivery, failure: Error): Promise<never> {
		const cleanup = await this.reopenQuestion(decision).then(
			() => undefined,
			(error: Error) => error,
		);
		if (cleanup === undefined) throw failure;
		throw new AggregateError([failure, cleanup], `${failure.message}; reopening its question failed too: ${cleanup.message}`, {
			cause: failure,
		});
	}

	/**
	 * #4386: a released subagent registered again: its parked asks follow it here, and askers on this broker follow it
	 * when it registered under another session id.
	 */
	private async rebindParked(session: BrokerConnectedSession, registration: ReleasedRegistration): Promise<void> {
		const rebound = await rebindParkedAsks(this.state, registration, session.info.id);
		for (const ask of rebound) {
			const asker = this.host.sessions.get(ask.senderSessionId);
			if (asker === undefined) continue;
			this.host.write(asker.socket, {
				type: "peer_rebound",
				replyTo: ask.messageId,
				previousSessionId: ask.previousTargetSessionId,
				sessionId: session.info.id,
			});
		}
	}

	private failReleasedReply(request: RemoteSendRequest, error: IntercomReleasedReplyError): void {
		this.host.write(request.socket, {
			type: "delivery_failed",
			messageId: request.message.id,
			attemptId: request.attemptId,
			reason: error.message,
			reasonCode: error.code,
			error: serializeIntercomReleasedReplyError(error),
		});
	}

	/**
	 * A send that resolved to a session on this broker: a same-id retry of a send that already went through the shared
	 * outbox (its recipient has since moved here) is answered from that row, never delivered again; a reply to a
	 * question that a released asker, since woken here, asked through another broker goes to its owner; any other send
	 * takes the local path. Lookups the shared database does not answer within `LOCAL_RETRY_LOOKUP_BOUND_MS` take the
	 * local path too, and their late answers are ignored: the send has been answered once already.
	 */
	private async answerLocalRetry(
		request: RemoteSendRequest,
		target: BrokerConnectedSession,
		owners?: Promise<SendOwnerVerdicts>,
	): Promise<void> {
		const lookup = this.state.outbox.read(request.message.id);
		const released = this.movedReleasedAsk(request, target).catch((error: Error) => {
			this.report(error);
			return undefined;
		});
		let bound: ReturnType<typeof setTimeout> | undefined;
		const expired = new Promise<"expired">((resolve) => {
			bound = setTimeout(() => resolve("expired"), LOCAL_RETRY_LOOKUP_BOUND_MS);
			bound.unref?.();
		});
		try {
			// #5607: checked within the same bound as the lookup. Without an answer the send takes the local path, which
			// never depends on the shared database (spec §8); the check keeps running, and acts on a lost id when it answers.
			if (owners !== undefined) {
				const verdicts = await Promise.race([owners, expired]);
				if (verdicts !== "expired" && (verdicts.sender === "lost" || verdicts.target === "lost")) {
					lookup.catch((error: Error) => this.report(error));
					// A sender disconnected here has nothing to be answered; a recipient disconnected here is looked for
					// wherever its id lives now.
					if (verdicts.sender !== "lost") request.notFound();
					return;
				}
			}
			const existing = await Promise.race([lookup, expired]);
			if (existing === "expired") {
				lookup.catch((error: Error) => this.report(error));
				await this.adoptSharedRouteWithin(request, target);
				// #4997: a reply whose ask's route may be on a broker that is down is refused as retryable here too, not by
				// the local path's final refusal just because the outbox lookup was slow.
				if (await this.routeUnreachable(request, target)) return;
				request.notFound();
				return;
			}
			if (existing.status === "found") {
				const digest = crossNodeDigest(request.signature);
				const recipient = await this.rowRecipient(existing.row, target, expired);
				await this.answerExistingRow(request, recipient, digest, existing.row);
				return;
			}
			const moved = await Promise.race([released, expired]);
			if (moved !== "expired" && moved !== undefined && (await this.routeReleasedReply(request, moved))) return;
			await this.adoptSharedRouteWithin(request, target);
			if (await this.routeUnreachable(request, target)) return;
			request.notFound();
		} finally {
			clearTimeout(bound);
		}
	}

	/** Whether this send may resolve `target` because its sender holds a return path to it, open or closed. */
	private holdsReturnPath(request: RemoteSendRequest, target: ReturnPathParty): boolean {
		return (
			mayUseReturnPath(request.message, request.supervisorSend, request.from) &&
			this.host.returnPaths?.holds(request.from, target) === true
		);
	}

	/**
	 * The sessions among `sessionIds` this send's `replyTo` answers: a recorded vertical crossing or an open ask route,
	 * exactly as a local reply's candidates (`handleBrokerSend`). Such a session resolves by name across groups; the
	 * outbox write still checks the same authorization.
	 */
	private async replyAuthorizedTargets(request: RemoteSendRequest, sessionIds: readonly string[]): Promise<Set<string>> {
		const authorized = new Set<string>();
		const replyTo = request.message.replyTo;
		if (replyTo === undefined) return authorized;
		const replySenderSessionId = request.from.info.id;
		for (const sessionId of new Set(sessionIds)) {
			if (this.host.supervisorCache.matchReply(replyTo, replySenderSessionId, sessionId)) authorized.add(sessionId);
			else if (
				(await this.state.pendingAsks.matchesReply({ replySenderSessionId, replyTargetSessionId: sessionId, replyTo }))
					.status === "match"
			) {
				authorized.add(sessionId);
			}
		}
		return authorized;
	}

	/**
	 * An offline session, resolved exactly as a live remote one is: an exact id first (its recipient checks follow in
	 * `deliverThroughOutbox`), otherwise a visible agent by name or Atomic session id; a visible non-agent of that
	 * name alone is refused as a live one is.
	 */
	private async resolveKnownSession(request: RemoteSendRequest): Promise<KnownSessionState | "answered" | undefined> {
		const found = await this.state.knownSessions.lookup(request.target, KNOWN_SESSION_RETENTION_MS);
		if (found.status !== "found") return undefined;
		const localIdentities = new Set([...this.host.sessions.values()].map(deliveryTargetIdentity));
		const sessions: KnownSessionState[] = [];
		for (const session of found.sessions) {
			// A record under an id bound to another session's return address is not that session's.
			if (localIdentities.has(session.targetIdentity)) continue;
			if (await this.holdsSessionId(session.intercomSessionId, session.atomicSessionId)) sessions.push(session);
		}
		const byId = sessions.find((session) => session.intercomSessionId === request.target);
		if (byId !== undefined) return byId;
		const replyAuthorized = await this.replyAuthorizedTargets(
			request,
			sessions.map((session) => session.intercomSessionId),
		);
		const shown = sessions.filter(
			(session) =>
				reachesGroups(request.from, session.groups) ||
				(request.supervisorSend && session.intercomSessionId === request.from.supervisorId) ||
				replyAuthorized.has(session.intercomSessionId),
		);
		// A sender this one holds a return path to answers to its name only when nothing visible does.
		const shownNames = new Set(shown.filter(isAgentRecipient).flatMap((session) => [session.name?.toLowerCase(), session.atomicSessionId]));
		const answerable = shownNames.has(request.target.toLowerCase()) || shownNames.has(request.target)
			? []
			: sessions.filter(
					(session) =>
						!shown.includes(session) &&
						this.holdsReturnPath(request, {
							sessionId: session.intercomSessionId,
							identity: stableIdentity(session.targetIdentity),
						}),
				);
		const visible = [...shown, ...answerable];
		const target = request.target.toLowerCase();
		const agents = visible.filter(isAgentRecipient);
		const candidates = [
			["ambiguous_name", agents.filter((session) => session.name?.toLowerCase() === target)],
			["ambiguous_session_id", agents.filter((session) => session.atomicSessionId === request.target)],
		] as const;
		for (const [ambiguity, matches] of candidates) {
			if (matches.length === 1) return matches[0];
			if (matches.length > 1) {
				const infos = matches.map((session) => ({ id: session.intercomSessionId, name: session.name }));
				this.fail(request, sessionTargetFailureReason(request.clientMessage.to, { kind: ambiguity, matches: infos }));
				return "answered";
			}
		}
		if (visible.some((session) => !isAgentRecipient(session) && session.name?.toLowerCase() === target)) {
			this.fail(request, NON_AGENT_RECIPIENT_REFUSAL);
			return "answered";
		}
		return undefined;
	}

	/** Run the origin's routing decisions on the shared state, then enqueue the exact local frame. */
	private async deliverThroughOutbox(request: RemoteSendRequest, target: RemoteTarget): Promise<void> {
		const { message, from } = request;
		if (!isAgentRecipient(target.gates)) {
			this.fail(request, NON_AGENT_RECIPIENT_REFUSAL);
			return;
		}
		if (request.expectedRecipientId !== undefined && request.expectedRecipientId !== target.sessionId) {
			this.fail(request, "Reply target does not match the expected recipient");
			return;
		}
		const digest = crossNodeDigest(request.signature);
		const existing = await this.state.outbox.read(message.id);
		if (existing.status === "found") {
			await this.answerExistingRow(request, target, digest, existing.row);
			return;
		}
		if (this.answerLocalDelivery(request, target)) return;
		const correlatedReply =
			message.replyTo !== undefined &&
			(
				await this.state.pendingAsks.matchesReply({
					replySenderSessionId: from.info.id,
					replyTargetSessionId: target.sessionId,
					replyTo: message.replyTo,
				})
			).status === "match";
		if (request.requirePendingReply && !correlatedReply) {
			await this.refuseUnauthorizedReply(request, { sessionId: target.sessionId, identity: target.identity });
			return;
		}
		const verticalReply =
			message.replyTo !== undefined &&
			this.host.supervisorCache.matchReply(message.replyTo, from.info.id, target.sessionId);
		// A session answers a sender outside its reach whose message reached it here, within the return path's bounds.
		const crossesGroups = !request.supervisorSend && !verticalReply && !correlatedReply && !reachesGroups(from, target.groups);
		const answered: ReturnPathParty | undefined =
			crossesGroups && mayUseReturnPath(message, request.supervisorSend, from)
				? { sessionId: target.sessionId, identity: stableIdentity(target.identity) }
				: undefined;
		const returnPath = answered !== undefined && this.host.returnPaths?.use(from, answered, message.id) === true;
		if (crossesGroups && !returnPath) {
			this.fail(
				request,
				answered !== undefined && this.host.returnPaths?.closed(from, answered) === true
					? returnPathClosedReason(request.clientMessage.to)
					: from.reach === undefined
						? TARGET_GROUP_REFUSAL
						: outsideReachReason(from.reach),
			);
			return;
		}
		if (message.expectsReply === true && target.gates.replyCapability === "terminal") {
			this.fail(request, TERMINAL_CHILD_ASK_REFUSAL);
			return;
		}
		const senderIdentity = returnPathParty(from).identity;
		const frame: IntercomDeliveryFrame = {
			type: "message",
			from: from.info,
			message,
			...(request.supervisorSend ? { channel: "supervisor" as const } : {}),
			...(!request.supervisorSend && from.reach !== undefined
				? { senderReach: { home: from.reach.home, reachable: [...from.reach.reachable] } }
				: {}),
			...(returnPath ? { returnPath: true as const } : {}),
			...(senderIdentity === undefined ? {} : { senderIdentity }),
		};
		const enqueued = await this.reserveAndEnqueue(
			{
				messageId: message.id,
				digest,
				targetIdentity: target.identity,
				...(message.expectsReply === true
					? { questionRoute: { targetSessionId: target.sessionId, senderGroupIdentity: senderGroupIdentity(from) } }
					: {}),
			},
			{ targetIdentity: target.identity, originBrokerId: this.brokerId, digest, frame, ...offlineHost(target.hostBrokerId) },
		);
		if (enqueued.status === "conflict") {
			this.failConflict(request);
			return;
		}
		if (enqueued.status === "invalid") {
			this.fail(request, "Session not found");
			return;
		}
		if (enqueued.status === "full") {
			this.fail(request, outboxFullReason(enqueued));
			return;
		}
		// #4992: the ask is answered once its reply is queued: the replier ending before delivery does not also fail it.
		if (correlatedReply) {
			await this.state.pendingAsks.markReplied({
				replySenderSessionId: from.info.id,
				replyTargetSessionId: target.sessionId,
				replyTo: message.replyTo!,
			});
		}
		await this.answerExistingRow(request, target, digest, enqueued.row);
	}

	/**
	 * Reserve the send and enqueue its row: in one write where the store offers it, otherwise in two, forgetting the
	 * reservation of a send the full queue refused. A conflicting reservation is answered `conflict`.
	 */
	private async reserveAndEnqueue(
		reservation: SentMessageReservation,
		request: OutboxEnqueueRequest,
	): Promise<OutboxEnqueueResult> {
		if (this.state.reserveAndEnqueue !== undefined) return this.state.reserveAndEnqueue(reservation, request);
		const reserved = await this.state.sentMessages.reserve(reservation);
		if (reserved.status === "conflict") return { status: "conflict", messageId: reservation.messageId };
		const enqueued = await this.state.outbox.enqueue(request);
		if (enqueued.status === "full") {
			await this.state.sentMessages.forget({ messageId: reservation.messageId, digest: reservation.digest });
		}
		return enqueued;
	}

	/**
	 * A same-id retry of a send this broker delivered locally, whose recipient has since moved to another broker, is
	 * answered from that local delivery (the same check the local path makes), never sent through the outbox again.
	 * True when the send was answered.
	 */
	private answerLocalDelivery(request: RemoteSendRequest, target: RemoteTarget): boolean {
		const { message } = request;
		const delivered = this.host.deliveredMessages.lookupForTarget(message.id, request.signature, target.identity);
		if (delivered === "miss") return false;
		if (delivered === "conflict") {
			this.failConflict(request);
			return true;
		}
		if (delivered === "invalid") {
			this.fail(request, "Intercom accepted-delivery authority is invalid; refusing possible duplicate delivery");
			return true;
		}
		if (delivered === "uncertain") {
			this.fail(
				request,
				"Intercom cannot prove whether this reserved operation reached its recipient; refusing redelivery",
			);
			return true;
		}
		if (message.expectsReply === true) {
			const questionTarget = this.host.deliveredMessages.lookupQuestionTarget(
				message.id,
				request.signature,
				senderGroupIdentity(request.from),
			);
			if (questionTarget === undefined) {
				this.fail(request, "Accepted Intercom question route could not be securely rebound");
				return true;
			}
			if (request.resolveReplyTarget && request.attemptId !== undefined) {
				this.host.write(request.socket, {
					type: "question_target",
					messageId: message.id,
					attemptId: request.attemptId,
					sessionId: target.sessionId,
				});
			}
		}
		this.host.write(request.socket, { type: "delivered", messageId: message.id, attemptId: request.attemptId });
		return true;
	}

	/** Report a row's current state to its sender, and keep waiting on it until it settles. */
	private async answerExistingRow(
		request: RemoteSendRequest,
		target: RemoteTarget,
		digest: string,
		row: OutboxRow,
	): Promise<void> {
		const { message } = request;
		if (row.digest !== digest || row.targetIdentity !== target.identity) {
			this.failConflict(request);
			return;
		}
		if (row.state === "failed") {
			this.fail(request, row.failureReason ?? "Session not found");
			return;
		}
		const asksTarget = message.expectsReply === true && request.resolveReplyTarget && request.attemptId !== undefined;
		if (row.state === "delivered") {
			await this.state.sentMessages.accept({ messageId: message.id, digest });
			if (asksTarget) await this.writeQuestionTarget(request.socket, message.id, request.attemptId, target);
			this.host.write(request.socket, { type: "delivered", messageId: message.id, attemptId: request.attemptId });
			return;
		}
		const offline = target.hostBrokerId === undefined;
		const previous = this.waiters.get(message.id);
		if (previous !== undefined) this.dropWaiter(previous);
		const waiter: Waiter = {
			messageId: message.id,
			digest,
			socket: request.socket,
			...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
			senderSessionId: request.from.info.id,
			sender: reservationSender(request.from),
			expectsReply: message.expectsReply === true,
			resolveReplyTarget: request.resolveReplyTarget,
			targetSessionId: target.sessionId,
			targetIdentity: target.identity,
			queued: offline,
			timer: undefined,
			waitingSince: performance.now(),
		};
		this.armWaiter(waiter, offline ? DELIVERED_MESSAGE_TTL_MS : RECIPIENT_RECEIPT_TIMEOUT_MS);
		this.waiters.set(message.id, waiter);
		if (offline) {
			await this.writeQueued(request.socket, message.id, request.attemptId, target.identity);
			return;
		}
		if (asksTarget) await this.writeQuestionTarget(request.socket, message.id, request.attemptId, target);
		await this.bus.publish({ brokerId: target.hostBrokerId!, reason: "outbox", version: row.sequence });
		// A clean quit recorded before this send's row was written is seen here; one recorded after it wakes this
		// broker (`wakeWaitingOrigins`), so a send racing its recipient's quit is queued either way. The waiter's own
		// receipt wait keeps running meanwhile, so slow reads here never hold the sender past it.
		void this.queueIfRecipientLeft(waiter).catch((error: Error) => this.report(error));
	}

	private async writeQueued(
		socket: BrokerConnectedSession["socket"],
		messageId: string,
		attemptId: string | undefined,
		identity: string,
	): Promise<void> {
		this.host.write(socket, queuedFrame(messageId, attemptId, await this.queuePosition(identity, messageId)));
	}

	/** #4896: counted, not listed: a send to a busy recipient never reads its whole queue to learn its place. */
	private async queuePosition(identity: string, messageId: string): Promise<number> {
		const counted = await this.state.outbox.undeliveredPosition(identity, messageId);
		return counted.status === "positioned" ? counted.position : 1;
	}

	/**
	 * A send routed to a live recipient that has since quit, before any broker claimed its row: the row was never
	 * written to the recipient and no broker hosts it now, so the sender is to be told `queued`, as for a send routed
	 * after the quit, instead of waiting out a receipt that cannot come and hearing the outcome is uncertain. Presence
	 * is read before the row, so a row still unclaimed was never written to any recipient. Only reads: the row's queue
	 * position when that holds, otherwise undefined.
	 */
	private async positionIfRecipientLeft(waiter: Waiter): Promise<number | undefined> {
		const presence = await this.state.leases.read({ kind: "presence", targetIdentity: waiter.targetIdentity });
		if (presence.status === "invalid") return undefined;
		if (presence.status === "found" && presence.lease.ageMs < BROKER_LEASE_STALE_AFTER_MS) return undefined;
		const read = await this.state.outbox.read(waiter.messageId);
		if (read.status !== "found" || read.row.state !== "queued" || read.row.claimAttempts !== 0) return undefined;
		return this.queuePosition(waiter.targetIdentity, waiter.messageId);
	}

	/** Tell a still-waiting sender `queued`, at once: every read was made before. True when it was told. */
	private settleQueued(waiter: Waiter, position: number): boolean {
		if (waiter.queued || this.waiters.get(waiter.messageId) !== waiter) return false;
		this.dropWaiter(waiter);
		const queued: Waiter = { ...waiter, queued: true, timer: undefined, capTimer: undefined, holdCheck: undefined };
		this.armWaiter(queued, DELIVERED_MESSAGE_TTL_MS);
		this.waiters.set(queued.messageId, queued);
		this.host.write(queued.socket, queuedFrame(queued.messageId, queued.attemptId, position));
		void this.wakeReleasedRecipient(queued).catch((error: Error) => this.report(error));
		return true;
	}

	/**
	 * #4512: a send routed to a released child's presence but written only after the child left, and after its
	 * departure looked for sends waiting for it, is queued with nothing to wake the child before its owner's broker's
	 * next backup poll. This broker makes that check itself: the same reservation, found by the exact ids the
	 * recipient had, the same sends found by the ids its owner reserved, and the same claim on the send it finds, so
	 * the two checks never wake the child twice for one send.
	 */
	private async wakeReleasedRecipient(waiter: Waiter): Promise<void> {
		for (const id of [waiter.targetSessionId, returnAddressOf(waiter.targetIdentity)]) {
			if (id === undefined) continue;
			const lookup = await this.state.reservations.lookup(
				normalizeTarget(id),
				waiter.sender,
				BROKER_LEASE_STALE_AFTER_MS,
			);
			if (lookup.status !== "reserved") continue;
			const { reservation } = lookup;
			if (!reservation.wake) return;
			const aliases = reservation.targets.filter((target) => target !== reservation.childTarget);
			const messageId = await this.sendsWaitFor(reservation.reservationKey, aliases, reservation.group);
			if (messageId !== undefined) await this.requestWake(reservation, messageId);
			return;
		}
	}

	/**
	 * Off the receipt wait (a wake-up, the outcome poll, right after routing): the waiter's own timers keep running
	 * while this reads, so `expireWaiter` still answers the sender in time, and an answer here after that is dropped.
	 */
	private async queueIfRecipientLeft(waiter: Waiter): Promise<void> {
		if (waiter.queued || this.waiters.get(waiter.messageId) !== waiter) return;
		const position = await this.positionIfRecipientLeft(waiter);
		if (position !== undefined) this.settleQueued(waiter, position);
	}

	/** A recipient left: the brokers waiting on its undelivered rows re-read them, and queue the ones never claimed. */
	private async wakeWaitingOrigins(identity: string): Promise<void> {
		const listed = await this.state.outbox.listUndelivered(identity);
		if (listed.status !== "listed") return;
		for (const origin of new Set(listed.rows.map((row) => row.originBrokerId))) {
			if (origin === this.brokerId) void this.checkOutcomes();
			else await this.bus.publish({ brokerId: origin, reason: "outcome", version: 0 });
		}
	}
	private async writeQuestionTarget(
		socket: BrokerConnectedSession["socket"],
		messageId: string,
		attemptId: string | undefined,
		target: Pick<RemoteTarget, "sessionId">,
	): Promise<void> {
		if (attemptId === undefined) return;
		this.host.write(socket, { type: "question_target", messageId, attemptId, sessionId: target.sessionId });
	}

	/** §5.7: a reservation shared by another broker holds this send here, at its origin. */
	private async holdForRemoteReservation(request: RemoteSendRequest): Promise<boolean> {
		const { from, message } = request;
		const lookup = await this.state.reservations.lookup(
			normalizeTarget(request.target),
			reservationSender(from),
			BROKER_LEASE_STALE_AFTER_MS,
		);
		if (lookup.status === "none" || lookup.status === "invalid") return false;
		const reservation = lookup.reservation;
		if (lookup.status === "gone") {
			this.fail(request, reservation.gone ?? restoringRecipientRetryReason(reservation.childName));
			return true;
		}
		const listed = await this.state.heldSends.list(reservation.reservationKey);
		const count = listed.status === "listed" ? listed.sends.length : 0;
		const reasonCode = unrestoredReasonCode(reservation.reservationKey, reservation.wake);
		if (!request.awaitRestoringRecipient || count >= MAX_HELD_SENDS) {
			this.fail(request, restoringRecipientRetryReason(reservation.childName), reasonCode);
			return true;
		}
		const held = {
			reservationKey: reservation.reservationKey,
			originBrokerId: this.brokerId,
			senderSessionId: from.info.id,
			request: request.clientMessage as HeldSendRequest,
		};
		let result = await this.state.heldSends.hold(held);
		if (result.status === "duplicate" && (await this.state.heldSends.drop(message.id)).status === "dropped") {
			result = await this.state.heldSends.hold(held);
		}
		if (result.status !== "held") return true;
		// #4488: a released child is parked while its owner releases it, then made wakeable, and its owner's broker looks
		// for held sends as it makes it wakeable. When that look came before this send was written and this send found it
		// still parked, only a read made now that the send is written sees it wakeable: one of the two asks for the wake.
		const current =
			reservation.wake || count > 0 ? reservation : await this.activeReservation(reservation.reservationKey);
		const wake = current?.wake === true;
		const previous = this.holds.get(message.id);
		if (previous !== undefined) clearTimeout(previous.timer);
		const timer = setTimeout(() => void this.expireHold(message.id), RESTORING_RECIPIENT_HOLD_MS);
		timer.unref?.();
		this.holds.set(message.id, {
			messageId: message.id,
			reservationKey: reservation.reservationKey,
			childName: reservation.childName,
			socket: request.socket,
			senderId: from.info.id,
			...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
			clientMessage: request.clientMessage,
			reasonCode: wake ? unrestoredReasonCode(reservation.reservationKey, true) : reasonCode,
			timer,
		});
		this.host.write(request.socket, {
			type: "send_held",
			messageId: message.id,
			...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
			timeoutMs: RESTORING_RECIPIENT_HOLD_MS,
		});
		if (current?.wake === true && count === 0) {
			await this.requestWake(current, message.id);
		}
		return true;
	}

	private async activeReservation(reservationKey: string): Promise<RestoringReservation | undefined> {
		const read = await this.state.reservations.read(reservationKey);
		return read.status === "active" && read.reservation.gone === undefined ? read.reservation : undefined;
	}

	private async expireHold(messageId: string): Promise<void> {
		const hold = this.holds.get(messageId);
		if (hold === undefined) return;
		this.holds.delete(messageId);
		try {
			if ((await this.state.heldSends.drop(messageId)).status !== "dropped") return;
		} catch (error) {
			this.report(error);
		}
		this.writeHoldFailure(hold, restoringRecipientRetryReason(hold.childName), hold.reasonCode);
	}

	private writeHoldFailure(hold: TrackedHold, reason: string, reasonCode?: DeliveryFailureReasonCode): void {
		this.host.write(hold.socket, {
			type: "delivery_failed",
			messageId: hold.messageId,
			...(hold.attemptId === undefined ? {} : { attemptId: hold.attemptId }),
			reason,
			...(reasonCode === undefined ? {} : { reasonCode }),
		});
	}

	/** Read the reservation of every send held here and dispatch or refuse the ones whose hold ended (§5.7). */
	private async checkHolds(): Promise<void> {
		for (const hold of [...this.holds.values()]) {
			let key = hold.reservationKey;
			let decision: { readonly kind: "keep" } | { readonly kind: "refuse"; readonly reason: string } | { readonly kind: "dispatch" } = {
				kind: "keep",
			};
			for (let hop = 0; hop < MAX_SUPERSEDED_HOPS; hop++) {
				const read = await this.state.reservations.read(key);
				if (read.status === "active") {
					decision = read.reservation.gone === undefined ? { kind: "keep" } : { kind: "refuse", reason: read.reservation.gone };
				} else if (read.status === "ended" && read.end.outcome === "superseded") {
					key = read.end.by;
					continue;
				} else if (read.status === "ended" && read.end.outcome === "released" && read.end.refusal !== undefined) {
					decision = { kind: "refuse", reason: read.end.refusal };
				} else if (read.status !== "invalid") {
					decision = { kind: "dispatch" };
				}
				break;
			}
			if (decision.kind === "keep" || this.holds.get(hold.messageId) !== hold) continue;
			this.holds.delete(hold.messageId);
			clearTimeout(hold.timer);
			if ((await this.state.heldSends.drop(hold.messageId)).status !== "dropped") continue;
			if (decision.kind === "refuse") {
				this.writeHoldFailure(hold, decision.reason);
				continue;
			}
			const sender = this.host.sessions.get(hold.senderId);
			if (sender?.socket === hold.socket) this.host.dispatch(hold.socket, hold.clientMessage, hold.senderId);
		}
	}

	// ---------------------------------------------------------------------------------------------------------
	// Delivering the shared outbox to this broker's sessions

	private scanIdentity(identity: string): void {
		if (this.closed) return;
		const running = this.scanning.get(identity);
		if (running !== undefined) {
			running.rescan = true;
			return;
		}
		const state = { rescan: false };
		this.scanning.set(identity, state);
		void (async () => {
			try {
				do {
					state.rescan = false;
					await this.claimFor(identity);
				} while (state.rescan && !this.closed);
			} catch (error) {
				this.report(error);
			} finally {
				this.scanning.delete(identity);
			}
		})();
	}

	private scanAll(): void {
		for (const identity of new Set([...this.host.sessions.values()].map(deliveryTargetIdentity))) {
			this.scanIdentity(identity);
		}
	}

	private localSessionFor(identity: string): BrokerConnectedSession | undefined {
		for (const session of this.host.sessions.values()) {
			if (deliveryTargetIdentity(session) === identity) return session;
		}
		return undefined;
	}

	private async claimFor(identity: string): Promise<void> {
		const recipient = this.localSessionFor(identity);
		if (recipient === undefined) return;
		// #5607: rows sent to its id across nodes are taken for it only while the store confirms the id is its own; a later
		// scan takes them once it does.
		const owner = this.ownerCheck(recipient);
		if (owner !== undefined && (await withinBound(owner, SESSION_ID_CLAIM_BOUND_MS, "unknown")) !== "own") return;
		const claimed = await this.state.outbox.claim({
			claimantId: this.brokerId,
			targetIdentity: identity,
			staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS,
		});
		if (claimed.status === "held") {
			this.heldIdentities.add(identity);
			return;
		}
		this.heldIdentities.delete(identity);
		if (claimed.status !== "claimed") return;
		for (const { row, claim } of claimed.rows) {
			const session = this.localSessionFor(identity);
			if (session === undefined) {
				// The recipient left while the claim was on its way to the database: the row was never written to it, so it
				// goes back as never claimed. Its sender's broker then still queues it for the recipient's return
				// (`positionIfRecipientLeft`), instead of reporting the send uncertain once its receipt wait ends.
				const released = await this.state.outbox.releaseClaim(claim, { unwritten: true });
				if (released.status === "released") await this.wakeOrigin(row);
				continue;
			}
			if (row.frame.type === "released_child_reply") {
				const handoffRefusal = await releasedReplyHandoffRefusal(this.state, row.frame);
				if (handoffRefusal !== undefined) {
					const failed = await this.state.outbox.markFailed(claim, handoffRefusal);
					if (failed.status === "failed") await this.wakeOrigin(row);
					continue;
				}
				this.handOverReleasedReply({ claim, row, session, identity, released: { handoffId: randomUUID(), frame: row.frame } });
				continue;
			}
			const frame = row.frame;
			const refusal = await this.transitRefusal(frame, session);
			if (refusal !== undefined) {
				const failed = await this.state.outbox.markFailed(claim, refusal);
				if (failed.status === "failed") await this.wakeOrigin(row);
				continue;
			}
			const inflight: Inflight = { claim, row, session, identity };
			this.inflight.set(row.messageId, inflight);
			const delivery = messageFrameFor(session, frame.from, frame.message, frame.channel);
			this.host.writeConfirmed(session.socket, delivery, (written) => {
				if (this.inflight.get(row.messageId) !== inflight) return;
				if (!written) {
					this.inflight.delete(row.messageId);
					void this.state.outbox.releaseClaim(claim).catch((error: Error) => this.report(error));
					return;
				}
				// A recipient that never confirms saves is delivered once the frame is written, as locally.
				if (session.acknowledgesReceipt !== true) this.settleDelivered(inflight, session, frame);
			});
		}
	}

	/**
	 * #4386: hand a released asker's reply to its owner, under a new handoff id. The owner saves it and wakes the asker
	 * (#4326), and only its answer settles the row: it is never settled by being written, nor by a `received`.
	 */
	private handOverReleasedReply(inflight: Inflight & { readonly released: ReleasedReplyHandoff }): void {
		const { messageId } = inflight.row;
		const { handoffId, frame } = inflight.released;
		this.inflight.set(messageId, inflight);
		this.host.writeConfirmed(inflight.session.socket, { ...frame, handoffId }, (written) => {
			if (written || this.inflight.get(messageId) !== inflight) return;
			this.inflight.delete(messageId);
			void this.state.outbox.releaseClaim(inflight.claim).catch((error: Error) => this.report(error));
		});
	}

	/**
	 * What can change in transit, and what a row written without it never checked: the recipient's purpose (only
	 * agents receive messages), groups and reply capability (§8, "Split ownership"). A `replyTo` alone authorizes
	 * nothing: only a reply on an open ask route, or a vertical reply between a child and its supervisor, may cross
	 * groups, exactly as the origin decided.
	 */
	private async transitRefusal(
		frame: IntercomDeliveryFrame,
		recipient: BrokerConnectedSession,
	): Promise<string | undefined> {
		if (!isAgentRecipient(recipient.info)) return NON_AGENT_RECIPIENT_REFUSAL;
		if (frame.message.expectsReply === true && recipient.info.replyCapability === "terminal") {
			return TERMINAL_CHILD_ASK_REFUSAL;
		}
		// The origin broker carried an answer on a return path it holds (its sender's message reached it there first).
		if (frame.channel === "supervisor" || frame.returnPath === true) return undefined;
		if (
			frame.senderReach === undefined
				? sameGroup(recipient.info, frame.from)
				: reachesAnyGroup(frame.senderReach, sessionGroups(recipient.info))
		)
			return undefined;
		const replyTo = frame.message.replyTo;
		if (replyTo === undefined) return TARGET_GROUP_REFUSAL;
		if (recipient.supervisorId === frame.from.id) return undefined;
		if (this.host.supervisorCache.matchReply(replyTo, frame.from.id, recipient.info.id)) return undefined;
		const route = await this.state.pendingAsks.matchesReply({
			replySenderSessionId: frame.from.id,
			replyTargetSessionId: recipient.info.id,
			replyTo,
		});
		return route.status === "match" ? undefined : TARGET_GROUP_REFUSAL;
	}

	private settleDelivered(inflight: Inflight, recipient: BrokerConnectedSession, frame: IntercomDeliveryFrame): void {
		this.inflight.delete(inflight.row.messageId);
		const settling = (async () => {
			// Route first (spec §5.4): a settled row is never claimed again, so a route written after `markDelivered`
			// would be lost if this broker stopped between the writes. Redelivery repeats the route write safely.
			if (frame.message.expectsReply === true) {
				const asker = this.host.sessions.get(frame.from.id);
				// The asker is here too: the reply takes the local path, which answers only local routes.
				if (asker !== undefined) this.host.pendingQuestions.record(frame.from.id, recipient.info.id, frame.message.id);
				else {
					await this.state.pendingAsks.record({
						senderSessionId: frame.from.id,
						targetSessionId: recipient.info.id,
						messageId: frame.message.id,
					});
				}
			}
			const delivered = await this.state.outbox.markDelivered(inflight.claim);
			if (delivered.status !== "delivered") return;
			if (frame.message.replyTo !== undefined) {
				await this.state.pendingAsks.clearReply({
					replySenderSessionId: frame.from.id,
					replyTargetSessionId: recipient.info.id,
					replyTo: frame.message.replyTo,
				});
			}
			if (frame.channel === "supervisor") {
				this.host.supervisorCache.record(frame.message.id, frame.from.id, recipient.info.id);
			}
			// The sender's identity is the one its origin broker wrote; a frame from an older broker carries none.
			this.host.returnPaths?.delivered(
				recipient,
				{ sessionId: frame.from.id, identity: frame.senderIdentity },
				frame.from,
				frame.message.id,
			);
			await this.wakeOrigin(inflight.row);
		})().catch((error: Error) => {
			this.report(error);
			// Not settled: hand the row back so it is delivered again (the recipient deduplicates) and settled then.
			void this.state.outbox
				.releaseClaim(inflight.claim)
				.then(() => this.scanIdentity(inflight.identity))
				.catch((released: Error) => this.report(released));
		});
		this.settling.add(settling);
		void settling.finally(() => this.settling.delete(settling));
	}

	private async wakeOrigin(row: OutboxRow): Promise<void> {
		if (row.originBrokerId === this.brokerId) void this.checkOutcomes();
		else await this.bus.publish({ brokerId: row.originBrokerId, reason: "outcome", version: row.sequence });
	}

	// ---------------------------------------------------------------------------------------------------------
	// Outcomes for the senders this broker serves

	private async checkOutcomes(): Promise<void> {
		if (this.checkingOutcomes !== undefined) {
			this.checkingOutcomes.again = true;
			return;
		}
		const state = { again: false };
		this.checkingOutcomes = state;
		try {
			do {
				state.again = false;
				for (const waiter of [...this.waiters.values()]) {
					const read = await this.state.outbox.read(waiter.messageId);
					if (this.waiters.get(waiter.messageId) !== waiter || read.status !== "found") continue;
					const { row } = read;
					if (row.state === "delivered") await this.finishDelivered(waiter);
					else if (row.state === "failed") {
						this.dropWaiter(waiter);
						this.host.write(waiter.socket, {
							type: "delivery_failed",
							messageId: waiter.messageId,
							attemptId: waiter.attemptId,
							reason: row.failureReason ?? "Session not found",
						});
					} else if (row.state === "queued" && row.claimAttempts === 0 && !waiter.queued) {
						// Not awaited: its reads must not hold back the other senders' outcomes.
						void this.queueIfRecipientLeft(waiter).catch((error: Error) => this.report(error));
					}
				}
			} while (state.again && !this.closed);
		} catch (error) {
			this.report(error);
		} finally {
			this.checkingOutcomes = undefined;
		}
	}

	private async finishDelivered(waiter: Waiter): Promise<void> {
		this.dropWaiter(waiter);
		await this.state.sentMessages.accept({ messageId: waiter.messageId, digest: waiter.digest });
		if (waiter.expectsReply && waiter.resolveReplyTarget && waiter.attemptId !== undefined) {
			// #3777: a recipient that reconnected before confirming answers under its new session id.
			const current = await this.state.leases.read({ kind: "presence", targetIdentity: waiter.targetIdentity });
			if (
				current.status === "found" &&
				current.lease.subject.kind === "presence" &&
				current.lease.subject.session.id !== waiter.targetSessionId
			) {
				await this.writeQuestionTarget(waiter.socket, waiter.messageId, waiter.attemptId, {
					sessionId: current.lease.subject.session.id,
				});
			}
		}
		this.host.write(waiter.socket, { type: "delivered", messageId: waiter.messageId, attemptId: waiter.attemptId });
	}

	private armWaiter(waiter: Waiter, timeoutMs: number): void {
		if (waiter.timer !== undefined) clearTimeout(waiter.timer);
		waiter.timer = setTimeout(() => {
			if (this.waiters.get(waiter.messageId) !== waiter) return;
			if (waiter.queued) {
				this.dropWaiter(waiter);
				return;
			}
			// One hold check per waiter: a wait that ends while the previous check's read is still pending reuses it.
			if (waiter.holdCheck !== undefined) return;
			waiter.holdCheck = this.expireWaiter(waiter)
				.catch((error: Error) => {
					this.report(error);
					this.expireUncertain(waiter);
				})
				.finally(() => {
					waiter.holdCheck = undefined;
				});
		}, timeoutMs);
		waiter.timer.unref?.();
		// #3983: the save cap holds from the sender's own start, whatever the store does.
		if (!waiter.queued && waiter.capTimer === undefined) {
			waiter.capTimer = setTimeout(
				() => this.expireUncertain(waiter),
				Math.max(0, waiter.waitingSince + RECIPIENT_SAVE_MAX_WAIT_MS - performance.now()),
			);
			waiter.capTimer.unref?.();
		}
	}

	/** The sender may wait this much longer under the save cap; 0 once the cap is reached. */
	private capRemaining(waiter: Waiter): number {
		return Math.max(0, waiter.waitingSince + RECIPIENT_SAVE_MAX_WAIT_MS - performance.now());
	}

	/**
	 * #3983: the sender's receipt wait ended. A recipient on another broker that reported, within the last receipt
	 * wait, that it is still saving the message keeps its sender waiting another wait (told `send_held`), within the
	 * save cap. #4443: a recipient that still holds the message but missed that report (it was stalled, or its first
	 * report has not landed yet) gets one more wait to report late; only a second wait in a row without a report
	 * tells the sender that the outcome is uncertain, as does any wait without a recipient holding the message. The
	 * decision reads the outbox row, which can wait behind other writes on the shared connection: a read slower than
	 * `HOLD_CHECK_GRACE_MS` first tells the sender to keep waiting while it finishes (within the cap), and a read that
	 * has not answered within one receipt wait counts as no evidence, so the sender hears the outcome is uncertain. A
	 * row no broker claimed whose recipient has quit is queued for it instead; the reads deciding that run under the
	 * same grace and deadline. Only one decision per waiter is ever in flight, and the cap ends the wait however the
	 * store behaves.
	 */
	private async expireWaiter(waiter: Waiter): Promise<void> {
		const provisional = setTimeout(() => {
			const timeoutMs = Math.min(RECIPIENT_RECEIPT_TIMEOUT_MS, this.capRemaining(waiter));
			if (this.waiters.get(waiter.messageId) !== waiter || timeoutMs === 0) return;
			this.armWaiter(waiter, timeoutMs);
			this.holdSender(waiter, timeoutMs);
		}, HOLD_CHECK_GRACE_MS);
		provisional.unref?.();
		let deadline: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<"timed-out">((resolveTimeout) => {
			deadline = setTimeout(() => resolveTimeout("timed-out"), RECIPIENT_RECEIPT_TIMEOUT_MS);
			deadline.unref?.();
		});
		const decide = async () => {
			const read = await this.state.outbox.read(waiter.messageId);
			const unclaimed = read.status === "found" && read.row.state === "queued" && read.row.claimAttempts === 0;
			return { read, queuedAt: unclaimed ? await this.positionIfRecipientLeft(waiter) : undefined };
		};
		let decision: Awaited<ReturnType<typeof decide>> | "timed-out";
		try {
			decision = await Promise.race([decide(), timedOut]);
		} finally {
			clearTimeout(provisional);
			clearTimeout(deadline);
		}
		if (this.waiters.get(waiter.messageId) !== waiter) return;
		if (decision === "timed-out") {
			this.expireUncertain(waiter);
			return;
		}
		const { read, queuedAt } = decision;
		if (read.status === "found" && read.row.state === "delivered") {
			await this.finishDelivered(waiter);
			return;
		}
		const remaining = this.capRemaining(waiter);
		const held = read.status === "found" && read.row.state === "claimed" ? read.row : undefined;
		if (held !== undefined && remaining > 0) {
			const reported = held.savingAgeMs !== undefined && held.savingAgeMs < RECIPIENT_RECEIPT_TIMEOUT_MS;
			if (reported || waiter.missedSavingReport !== true) {
				waiter.missedSavingReport = !reported;
				const timeoutMs = Math.min(RECIPIENT_RECEIPT_TIMEOUT_MS, remaining);
				this.armWaiter(waiter, timeoutMs);
				this.holdSender(waiter, timeoutMs);
				return;
			}
		}
		if (queuedAt !== undefined && this.settleQueued(waiter, queuedAt)) return;
		this.expireUncertain(waiter);
	}

	private holdSender(waiter: Waiter, timeoutMs: number): void {
		if (this.waiters.get(waiter.messageId) !== waiter) return;
		this.host.write(waiter.socket, {
			type: "send_held",
			messageId: waiter.messageId,
			...(waiter.attemptId === undefined ? {} : { attemptId: waiter.attemptId }),
			timeoutMs,
		});
	}

	private expireUncertain(waiter: Waiter): void {
		if (this.waiters.get(waiter.messageId) !== waiter) return;
		this.dropWaiter(waiter);
		this.host.write(waiter.socket, {
			type: "delivery_failed",
			messageId: waiter.messageId,
			attemptId: waiter.attemptId,
			reason: UNCERTAIN_RECEIPT_REASON,
		});
	}

	private dropWaiter(waiter: Waiter): void {
		if (this.waiters.get(waiter.messageId) === waiter) this.waiters.delete(waiter.messageId);
		if (waiter.timer !== undefined) clearTimeout(waiter.timer);
		if (waiter.capTimer !== undefined) clearTimeout(waiter.capTimer);
	}

	// ---------------------------------------------------------------------------------------------------------
	// Hints, polls and renewals

	private onWakeUp(event: WakeUpEvent): void {
		if (this.closed) return;
		if (event.kind === "resync") {
			this.scanAll();
			void this.checkOutcomes();
			void this.guard(this.checkHolds());
			void this.guard(this.deliverWakeRequests());
			return;
		}
		if (event.hint.reason === "outbox") this.scanAll();
		else {
			void this.checkOutcomes();
			void this.guard(this.checkHolds());
			void this.guard(this.deliverWakeRequests());
		}
	}

	private membershipSubject(): BrokerMembershipSubject {
		return {
			kind: "broker",
			brokerId: this.brokerId,
			nodeId: this.nodeId,
			startedAt: Date.now(),
			instanceKey: this.instanceKey,
			pid: this.pid,
			...(this.home === undefined ? {} : { home: this.home }),
		};
	}

	/**
	 * #5038: an earlier instance of this broker (same host and socket) still listed as live whose process has exited
	 * died without releasing anything. Its presence leases would keep other brokers routing to it, and keep sessions
	 * that re-register here from taking their presence, and its outbox claims would hold its recipients' queues, until
	 * they go stale; retire them now. Its claimed rows are delivered again, once, by whoever claims them next.
	 */
	/**
	 * #5038: whether the process an earlier instance recorded still runs. #5252: where the host reads process starts, a
	 * process that started after that instance recorded its own start is a later one the host gave its id to, and one
	 * whose start cannot be read is unknown, never taken for that instance (a short-lived later process is often gone
	 * before its start is read).
	 */
	private async stillRuns(pid: number, recordedStartedAt: number | undefined): Promise<boolean> {
		if (!this.isProcessAlive(pid)) return false;
		if (recordedStartedAt === undefined) return true;
		const startedAt = await this.processStartedAt(pid);
		if (startedAt === null) return true;
		return startedAt !== undefined && startedAt <= recordedStartedAt;
	}

	private async retirePreviousInstances(): Promise<void> {
		// #5252: also once its leases went stale, as when a loaded host delays this start past the stale window: they are
		// still held, and its recipients count as lost only once it is retired here.
		for (const lease of await this.state.leases.listLive("broker", Number.MAX_SAFE_INTEGER)) {
			const { instanceKey, pid, startedAt } = lease.subject as Partial<BrokerMembershipSubject>;
			if (instanceKey !== this.instanceKey || pid === undefined || (await this.stillRuns(pid, startedAt))) continue;
			// #5154: the sessions it had present may have ended with it unrecorded: they are lost until they register again.
			const present = (await this.state.leases.listLive("presence", Number.MAX_SAFE_INTEGER)).filter(
				(presence) => presence.holderId === lease.holderId,
			);
			await this.state.knownSessions.markLost(
				present.map((presence) => (presence.subject as RecipientPresenceSubject).targetIdentity),
			);
			await this.state.leases.retireHolder(lease.holderId);
			// #5607: the ids its registrations owned are free for those sessions to take again.
			await this.state.knownSessions.owners?.retireBroker(lease.holderId);
			await this.state.outbox.releaseClaimsOf(lease.holderId);
		}
	}

	private async renew(): Promise<void> {
		if (this.membership !== undefined) {
			const renewed = await this.state.leases.renew(this.membership);
			if (renewed.status !== "renewed") this.membership = undefined;
		}
		if (this.membership === undefined) {
			const acquired = await this.state.leases.acquire(
				this.membershipSubject(),
				this.brokerId,
				BROKER_LEASE_STALE_AFTER_MS,
			);
			if (acquired.status === "acquired") this.membership = acquired.lease;
		}
		for (const [session, entry] of this.presence) {
			if (entry.lease !== undefined) {
				const renewed = await this.state.leases.renew(entry.lease, this.presenceSubject(session));
				if (renewed.status !== "renewed") entry.lease = undefined;
				else if (entry.knownAt === undefined || Date.now() - entry.knownAt >= KNOWN_SESSION_REFRESH_INTERVAL_MS) {
					// A live session stays known: retention counts from its last renewal, not from its registration.
					this.serial(deliveryTargetIdentity(session), () => this.recordKnown(session, entry));
				}
				if (entry.unfinished !== undefined) {
					this.serial(deliveryTargetIdentity(session), async () => {
						if (this.presence.get(session) === entry) await this.finishRegistration(session, entry);
					});
				}
			} else {
				this.serial(deliveryTargetIdentity(session), async () => {
					if (this.presence.get(session) !== entry || entry.unbound === true) return;
					await this.acquirePresence(session, entry);
					const { rebind } = entry;
					if (entry.lease !== undefined && rebind !== undefined) {
						// #5138: kept as an unfinished step until it succeeds, so a store error does not lose it.
						delete entry.rebind;
						entry.unfinished = { ...(entry.unfinished ?? { attempts: 0 }), rebind };
					}
					try {
						await this.finishRegistration(session, entry);
					} finally {
						if (entry.lease !== undefined) this.scanIdentity(deliveryTargetIdentity(session));
					}
				});
			}
		}
		for (const inflight of [...this.inflight.values()]) {
			const renewed = await this.state.outbox.renewClaim(inflight.claim);
			if (renewed.status !== "renewed" && this.inflight.get(inflight.row.messageId) === inflight) {
				this.inflight.delete(inflight.row.messageId);
			}
		}
		for (const [key, mirror] of this.mirrored) {
			const renewed = await this.state.reservations.renew(mirror.lease);
			if (renewed.status !== "renewed" && this.mirrored.get(key) === mirror) this.mirrored.delete(key);
		}
		// #5352: a reservation whose write failed or did not answer is written again, in order behind its key's steps.
		for (const [key, pending] of this.unpublished) {
			if (this.pendingPublishRetries.has(key)) continue;
			this.pendingPublishRetries.add(key);
			this.serial(`reservation:${key}`, () =>
				this.publishReservation(key, pending, true).finally(() => this.pendingPublishRetries.delete(key)),
			);
		}
		for (const identity of [...this.heldIdentities]) this.scanIdentity(identity);
	}

	private async backupPoll(): Promise<void> {
		this.scanAll();
		await this.sweepEndedAsks();
		await this.sweepLostRecipients();
		await this.checkOutcomes();
		await this.checkHolds();
		for (const reservationKey of this.mirrored.keys()) {
			if (this.pendingWakeChecks.has(reservationKey)) continue;
			this.pendingWakeChecks.add(reservationKey);
			this.serial(`reservation:${reservationKey}`, () =>
				this.wakeWaitingChild(reservationKey).finally(() => this.pendingWakeChecks.delete(reservationKey)),
			);
		}
		await this.state.outbox.prune(DELIVERED_MESSAGE_TTL_MS, KNOWN_SESSION_RETENTION_MS);
		await this.state.sentMessages.prune(DELIVERED_MESSAGE_TTL_MS);
		await this.state.reservations.prune(DELIVERED_MESSAGE_TTL_MS);
		await this.state.releasedAsks.prune(DELIVERED_MESSAGE_TTL_MS);
		await this.state.knownSessions.prune(KNOWN_SESSION_RETENTION_MS);
	}

	private async outcomePoll(): Promise<void> {
		if ([...this.waiters.values()].some((waiter) => !waiter.queued)) await this.checkOutcomes();
		if (this.holds.size > 0) await this.checkHolds();
		if (this.mirrored.size > 0) await this.deliverWakeRequests();
	}

	private async recordKnown(session: BrokerConnectedSession, entry: PresenceEntry): Promise<void> {
		await this.state.knownSessions.record(this.knownOf(session));
		entry.knownAt = Date.now();
	}

	private async acquirePresence(session: BrokerConnectedSession, entry: PresenceEntry): Promise<void> {
		const acquired = await this.state.leases.acquire(
			this.presenceSubject(session),
			this.brokerId,
			BROKER_LEASE_STALE_AFTER_MS,
		);
		if (acquired.status === "acquired") entry.lease = acquired.lease;
	}

	private presenceSubject(session: BrokerConnectedSession): RecipientPresenceSubject {
		return { kind: "presence", targetIdentity: deliveryTargetIdentity(session), session: session.info };
	}

	private knownOf(session: BrokerConnectedSession): KnownSession {
		return {
			targetIdentity: deliveryTargetIdentity(session),
			intercomSessionId: session.info.id,
			...(session.info.name === undefined ? {} : { name: session.info.name }),
			...(session.registrationReturnAddress === undefined ? {} : { atomicSessionId: session.registrationReturnAddress }),
			group: normalizeGroup(session.registrationGroup),
			groups: [...sessionGroups(session.info)],
			...(session.info.recipientPurpose === undefined ? {} : { recipientPurpose: session.info.recipientPurpose }),
			...(session.info.replyCapability === undefined ? {} : { replyCapability: session.info.replyCapability }),
		};
	}

	private fail(request: RemoteSendRequest, reason: string, reasonCode?: DeliveryFailureReasonCode): void {
		this.host.write(request.socket, {
			type: "delivery_failed",
			messageId: request.message.id,
			attemptId: request.attemptId,
			reason,
			...(reasonCode === undefined ? {} : { reasonCode }),
		});
	}

	private failConflict(request: RemoteSendRequest): void {
		this.host.write(request.socket, {
			type: "delivery_failed",
			messageId: request.message.id,
			attemptId: request.attemptId,
			reason: `Intercom message ID '${request.message.id}' was already delivered with a different target or payload`,
			reasonCode: "message_id_conflict",
		});
	}

	/** Run `operation` after every earlier operation for the same key, so a leave never overtakes its register. */
	private serial(key: string, operation: () => Promise<void>): void {
		const previous = this.serials.get(key) ?? Promise.resolve();
		const next = previous.then(operation).catch((error: Error) => this.report(error));
		this.serials.set(key, next);
		void next.finally(() => {
			if (this.serials.get(key) === next) this.serials.delete(key);
		});
	}

	private every(intervalMs: number, tick: () => Promise<void>): void {
		let running = false;
		const timer = setInterval(() => {
			if (running || this.closed) return;
			running = true;
			void tick()
				.catch((error: Error) => this.report(error))
				.finally(() => {
					running = false;
				});
		}, intervalMs);
		timer.unref?.();
		this.timers.push(timer);
	}

	private async guard(operation: Promise<void>): Promise<void> {
		try {
			await operation;
		} catch (error) {
			this.report(error);
		}
	}

	private report(error: unknown): void {
		const text = error instanceof Error ? error.message : String(error);
		if (text === this.lastError) return;
		this.lastError = text;
		console.error(`Intercom multi-node routing: ${text}`);
	}

	/** Give this broker's presence and membership leases up, then close the bus and the store. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const timer of this.timers) clearInterval(timer);
		for (const waiter of [...this.waiters.values()]) this.dropWaiter(waiter);
		for (const hold of this.holds.values()) clearTimeout(hold.timer);
		this.holds.clear();
		await Promise.all([...this.serials.values()]);
		try {
			for (const inflight of this.inflight.values()) await this.state.outbox.releaseClaim(inflight.claim);
			for (const entry of this.presence.values()) {
				if (entry.lease !== undefined) await this.state.leases.release(entry.lease);
			}
			// #5607: its sessions' ids are free for them to take again on another broker, as their presences are.
			await this.state.knownSessions.owners?.retireBroker(this.brokerId);
			if (this.membership !== undefined) await this.state.leases.release(this.membership);
		} catch (error) {
			this.report(error);
		}
		this.inflight.clear();
		this.presence.clear();
		await this.subscription?.close();
		await this.bus.close();
		await this.state.close();
	}
}

/** A target identity a return path can bind: a registration's return address, never a reusable bare session id. */
function stableIdentity(targetIdentity: string): string | undefined {
	return targetIdentity.startsWith('["return",') ? targetIdentity : undefined;
}
