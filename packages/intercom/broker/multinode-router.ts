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
import type { DeliveryFailureReasonCode, SessionInfo } from "../types.js";
import type { DeliveredMessageCache } from "./delivered-message-cache.js";
import { sameGroup } from "./group-isolation.js";
import { sessionGroups } from "./group-membership.js";
import {
	BROKER_LEASE_RENEW_INTERVAL_MS,
	BROKER_LEASE_STALE_AFTER_MS,
	type HeldSendRequest,
	type IntercomBrokerStateStore,
	type IntercomDeliveryFrame,
	KNOWN_SESSION_RETENTION_MS,
	type KnownSession,
	type KnownSessionState,
	type Lease,
	type LeaseState,
	OUTBOX_BACKUP_POLL_INTERVAL_MS,
	OUTBOX_CLAIM_STALE_AFTER_MS,
	type OutboxClaim,
	type OutboxRow,
	type RecipientPresenceSubject,
	type ReleasedAskerReplyFrame,
	type ReleasedAskRecord,
	type RestoringReservation,
	type RestoringReservationLease,
	reservationKeyFor,
} from "./multinode-state-store.js";
import type { PendingQuestionIndex } from "./pending-question-index.js";
import { UNCERTAIN_RECEIPT_REASON } from "./recipient-receipts.js";
import {
	decideReleasedAskerReply,
	isReleasedReplyCandidate,
	keepReleasedAsks,
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
	type RemoteSendRequest,
	type SendClientMessage,
	senderGroupIdentity,
} from "./send-handler.js";
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
/** The `queued` frame's target for a send waiting in the shared outbox for an offline session (decision 1). */
export const OFFLINE_SESSION_TARGET = "offline session";
/** A send for another node while the shared database cannot be reached (spec §8, "Database unavailable"). */
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
 * The longest a registration waits for its presence lease. A hung shared database must not hang registration (the
 * client gives up after 10 s); the lease is still written when the database answers.
 */
export const PRESENCE_REGISTRATION_BOUND_MS = 5_000;
/**
 * The longest a send to a local recipient waits for the shared outbox to say whether it is a retry of a cross-node
 * send. Local delivery does not depend on the shared database (spec §8): past this bound the send is delivered
 * locally, with the local accepted-delivery cache as its duplicate protection.
 */
export const LOCAL_RETRY_LOOKUP_BOUND_MS = 300;
/** The longest `list` waits for other nodes' sessions; the client's list request gives up after 5 s. */
const REMOTE_SESSIONS_BOUND_MS = 2_000;
const MAX_SUPERSEDED_HOPS = 8;
/**
 * How often renewal refreshes a live session's known-session record. Far below `KNOWN_SESSION_RETENTION_MS`, so a
 * session that stays connected for longer than the retention is still known (queued for) after its broker crashes.
 */
export const KNOWN_SESSION_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const TARGET_GROUP_REFUSAL = "Target session is in a different intercom group";

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
	/** This broker's own ask routes: an ask whose asker and recipient are both here is answered on the local path. */
	readonly pendingQuestions: PendingQuestionIndex;
	/** This broker's local accepted deliveries: a retry whose recipient moved to another broker is answered from them. */
	readonly deliveredMessages: Pick<DeliveredMessageCache, "lookupForTarget" | "lookupQuestionTarget">;
	/** Route a held send again as its sender, exactly like a new send (local delivery or the outbox). */
	dispatch(socket: BrokerConnectedSession["socket"], clientMessage: SendClientMessage, senderId: string): void;
	revokeReleasedReservation(reservationKey: string, ownerSessionId: string): void;
}

export interface MultiNodeRouterOptions {
	readonly state: IntercomBrokerStateStore;
	readonly bus: WakeUpBus;
	readonly host: MultiNodeHost;
	readonly brokerId?: string;
	readonly nodeId?: string;
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
	readonly senderGroups: readonly string[];
	readonly expectsReply: boolean;
	readonly resolveReplyTarget: boolean;
	readonly targetSessionId: string;
	readonly targetIdentity: string;
	/** Told `queued` already: `delivered` follows only while the sender is connected, and it never expires. */
	readonly queued: boolean;
	timer: ReturnType<typeof setTimeout> | undefined;
	/** When the sender started waiting; a recipient's save reports never keep it waiting past the save cap (#3983). */
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

function returnAddressOf(identity: string): string | undefined {
	try {
		const parsed = JSON.parse(identity) as unknown;
		return Array.isArray(parsed) && parsed[0] === "return" && typeof parsed[1] === "string" ? parsed[1] : undefined;
	} catch {
		return undefined;
	}
}

function sharesGroup(groups: ReadonlySet<string>, sender: SessionInfo): boolean {
	const senderGroups = sessionGroups(sender);
	return [...groups].some((group) => senderGroups.has(group));
}

export class MultiNodeRouter {
	readonly brokerId: string;
	private readonly state: IntercomBrokerStateStore;
	private readonly bus: WakeUpBus;
	private readonly host: MultiNodeHost;
	private readonly nodeId: string;
	private membership: Lease | undefined;
	private subscription: WakeUpSubscription | undefined;
	private readonly presence = new Map<BrokerConnectedSession, PresenceEntry>();
	private readonly inflight = new Map<string, Inflight>();
	private readonly waiters = new Map<string, Waiter>();
	private readonly holds = new Map<string, TrackedHold>();
	private readonly mirrored = new Map<string, MirroredReservation>();
	/** Reservations with a backup-poll wake check queued or running: one each while the store stalls, not a backlog. */
	private readonly pendingWakeChecks = new Set<string>();
	private readonly heldIdentities = new Set<string>();
	private readonly scanning = new Map<string, { rescan: boolean }>();
	private readonly serials = new Map<string, Promise<void>>();
	private readonly settling = new Set<Promise<void>>();
	private readonly timers: ReturnType<typeof setInterval>[] = [];
	private checkingOutcomes: { again: boolean } | undefined;
	private closed = false;
	private lastError: string | undefined;

	private constructor(options: MultiNodeRouterOptions) {
		this.state = options.state;
		this.bus = options.bus;
		this.host = options.host;
		this.brokerId = options.brokerId ?? randomUUID();
		this.nodeId = options.nodeId ?? hostname();
	}

	/** Take the membership lease, subscribe to wake-ups and adopt the sessions already connected. */
	static async start(options: MultiNodeRouterOptions): Promise<MultiNodeRouter> {
		const router = new MultiNodeRouter(options);
		const acquired = await router.state.leases.acquire(
			{ kind: "broker", brokerId: router.brokerId, nodeId: router.nodeId, startedAt: Date.now() },
			router.brokerId,
			BROKER_LEASE_STALE_AFTER_MS,
		);
		if (acquired.status === "acquired") router.membership = acquired.lease;
		const subscribed = await router.bus.subscribe(router.brokerId, (event) => router.onWakeUp(event));
		if (subscribed.status === "subscribed") router.subscription = subscribed.subscription;
		router.every(BROKER_LEASE_RENEW_INTERVAL_MS, () => router.renew());
		router.every(OUTBOX_BACKUP_POLL_INTERVAL_MS, () => router.backupPoll());
		router.every(MULTI_NODE_OUTCOME_POLL_INTERVAL_MS, () => router.outcomePoll());
		for (const session of options.host.sessions.values()) void router.sessionRegistered(session);
		return router;
	}

	// ---------------------------------------------------------------------------------------------------------
	// Session lifecycle

	/**
	 * A session registered here: record it as known and take its presence lease, retrying briefly while the broker
	 * it left still holds it. Resolves once other brokers can resolve it, or after `PRESENCE_REGISTRATION_BOUND_MS`
	 * while the database does not answer; what waits for it is delivered after.
	 */
	sessionRegistered(
		session: BrokerConnectedSession,
		consumed?: ConsumedReservation,
	): Promise<void> {
		if (this.closed || this.presence.has(session)) return Promise.resolve();
		const entry: PresenceEntry = {};
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
					await this.recordKnown(session, entry);
					for (let attempt = 0; ; attempt++) {
						await this.acquirePresence(session, entry);
						if (entry.lease !== undefined || attempt >= PRESENCE_HANDOVER_ATTEMPTS || this.presence.get(session) !== entry)
							break;
						await new Promise<void>((wait) => setTimeout(wait, PRESENCE_HANDOVER_RETRY_MS * 2 ** attempt).unref());
					}
					if (consumed !== undefined) {
						// #4488: the child may have been released since the registration began, while its presence was being
						// taken over. A reservation its owner made for that release must stay, or the released child is
						// unreachable: by the child's name, only reservations older than the registration end, and none
						// once the session left; the capability's own one always ends.
						const ownOnly: ConsumedReservation = {
							groups: consumed.groups,
							...(consumed.capability === undefined ? {} : { capability: consumed.capability }),
						};
						const mark = await insertedBy;
						await this.consumeReservation(
							this.presence.get(session) !== entry
								? ownOnly
								: { ...consumed, ...(mark === undefined ? {} : { insertedBy: mark }) },
						);
						const { childName, authorizedBy } = consumed;
						if (childName !== undefined && authorizedBy !== undefined) {
							const registration = { childName, authorizedBy };
							if (entry.lease === undefined) entry.rebind = registration;
							await this.rebindParked(session, registration);
						}
					}
				} finally {
					clearTimeout(bound);
					resolve();
				}
				this.scanIdentity(identity);
			});
		});
	}

	/** Presence or memberships changed: the shared subject follows them. */
	sessionUpdated(session: BrokerConnectedSession): void {
		const entry = this.presence.get(session);
		if (this.closed || entry === undefined) return;
		this.serial(deliveryTargetIdentity(session), async () => {
			await this.recordKnown(session, entry);
			if (session.info.replyCapability === "terminal" && entry.terminal !== true) {
				entry.terminal = true;
				await this.failTerminalAsks(session);
			}
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
		const taken = await this.state.pendingAsks.takeForTarget(target.info.id);
		if (taken.status !== "taken" || taken.asks.length === 0) return;
		const live = (await this.state.leases.listLive("presence", BROKER_LEASE_STALE_AFTER_MS)).filter(
			(lease) => lease.subject.kind === "presence",
		);
		for (const ask of taken.asks) {
			const frame: IntercomDeliveryFrame = {
				type: "message",
				from: target.info,
				message: {
					id: `terminal:${ask.messageId}`,
					timestamp: Date.now(),
					replyTo: ask.messageId,
					replyError: TERMINAL_CHILD_ASK_REFUSAL,
					content: { text: TERMINAL_CHILD_ASK_REFUSAL },
				},
			};
			const local = this.host.sessions.get(ask.senderSessionId);
			if (local !== undefined) {
				this.host.write(local.socket, frame);
				continue;
			}
			const hosted = live.find((lease) => (lease.subject as RecipientPresenceSubject).session.id === ask.senderSessionId);
			let identity = hosted === undefined ? undefined : (hosted.subject as RecipientPresenceSubject).targetIdentity;
			if (identity === undefined) {
				const known = await this.state.knownSessions.lookup(ask.senderSessionId, KNOWN_SESSION_RETENTION_MS);
				identity =
					known.status === "found"
						? known.sessions.find((session) => session.intercomSessionId === ask.senderSessionId)?.targetIdentity
						: undefined;
			}
			if (identity === undefined) continue;
			await this.state.pendingAsks.record(ask);
			const enqueued = await this.state.outbox.enqueue({
				targetIdentity: identity,
				originBrokerId: this.brokerId,
				digest: crossNodeDigest(JSON.stringify(frame)),
				frame,
			});
			if (enqueued.status === "inserted" && hosted !== undefined) {
				await this.bus.publish({ brokerId: hosted.holderId, reason: "outbox", version: enqueued.row.sequence });
			}
		}
	}

	/** A session left (cleanly or not): it stays known, so sends to it are queued until it returns anywhere. */
	sessionLeft(session: BrokerConnectedSession, released?: ReleasedTarget): void {
		const entry = this.presence.get(session);
		if (this.closed || entry === undefined) return;
		this.presence.delete(session);
		const identity = deliveryTargetIdentity(session);
		const claims = [...this.inflight.values()].filter((inflight) => inflight.session === session);
		for (const inflight of claims) this.inflight.delete(inflight.row.messageId);
		for (const waiter of [...this.waiters.values()]) {
			if (waiter.socket === session.socket) this.dropWaiter(waiter);
		}
		const holds = [...this.holds.values()].filter((hold) => hold.senderId === session.info.id);
		for (const hold of holds) {
			clearTimeout(hold.timer);
			this.holds.delete(hold.messageId);
		}
		const sessionId = session.info.id;
		this.serial(identity, async () => {
			// #4386: a released subagent's asks outlive its pending-ask routes, and are kept before it stops being live, so
			// a reply never finds it offline with only its pending asks. A failed write loses them, as a lost local route
			// does: the subagent then wakes at its reply deadline.
			await keepReleasedAsks(this.state, session).catch((error: Error) => this.report(error));
			for (const inflight of claims) await this.state.outbox.releaseClaim(inflight.claim);
			// #4386: asks to a released subagent are parked before its presence ends; registering again on any node takes
			// that presence over first, so its rebinding always finds them.
			await this.state.pendingAsks
				.pruneSender(sessionId)
				.then(() => settleAsksToDeparted(this.state, sessionId, released))
				.catch((error: Error) => this.report(error));
			if (entry.lease !== undefined) {
				await this.state.leases.release(entry.lease);
				await this.wakeWaitingOrigins(identity);
			}
			await this.recordKnown(session, entry);
			// #4488: a released child's departure queues again what it never confirmed, and ends its presence, only now.
			// Its owner's broker may have looked for sends waiting for it before then, as it made the child wakeable.
			this.wakeIfWaitedFor(session);
			for (const hold of holds) await this.state.heldSends.drop(hold.messageId);
			for (const [key, mirror] of [...this.mirrored]) {
				if (mirror.lease.ownerSessionId !== sessionId) continue;
				this.mirrored.delete(key);
				await this.state.reservations.release(mirror.lease);
				await this.wakeHeldOrigins(key);
			}
		});
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
		return new Promise((resolve) => {
			const bound = setTimeout(() => resolve(new Map()), REMOTE_SESSIONS_BOUND_MS);
			bound.unref?.();
			void this.state.leases.listLive("presence", BROKER_LEASE_STALE_AFTER_MS).then(
				(live) => {
					clearTimeout(bound);
					for (const lease of live) {
						if (lease.subject.kind !== "presence" || lease.holderId === this.brokerId) continue;
						const info = lease.subject.session;
						if (!this.host.sessions.has(info.id) && !remote.has(info.id)) remote.set(info.id, { info });
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

	restoringReserved(
		capability: string,
		ownerSessionId: string,
		childName: string,
		group: string,
		aliases: readonly string[],
		dormant: boolean,
		options: ReservationOptions = {},
	): void {
		if (this.closed) return;
		const reservationKey = reservationKeyFor(capability);
		const owner = this.host.sessions.get(ownerSessionId);
		const wake = options.wake === true;
		this.serial(`reservation:${reservationKey}`, async () => {
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
			if (reserved.status === "not-owner") {
				this.host.revokeReleasedReservation(reservationKey, ownerSessionId);
				return;
			}
			if (reserved.status !== "reserved") return;
			// The owner left (or its id was taken over) while the reserve was being written: its departure scanned the
			// mirrors before this one existed, so end the reservation here instead of renewing it for a gone owner.
			if (this.host.sessions.get(ownerSessionId) !== owner) {
				await this.state.reservations.release(reserved.lease);
				await this.wakeHeldOrigins(reservationKey);
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
			});
			await this.wakeWaitingChild(reservationKey);
		});
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
				const queued = await this.state.outbox.listUndelivered(targetIdentity);
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
		// Behind the reserve on the same key: a release while the reserve is still being written ends what it wrote.
		this.serial(`reservation:${reservationKey}`, async () => {
			// #4386: asks parked for a released subagent its owner no longer holds end here, as its local ones do.
			await this.state.pendingAsks.takeParked(ownerSessionId, reservationKey);
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
		if (isReleasedReplyCandidate(request)) this.serial(`reply:${request.from.info.id}`, () => this.routeSendSafely(request));
		else void this.routeSendSafely(request);
	}

	private async routeSendSafely(request: RemoteSendRequest): Promise<void> {
		try {
			if (request.localTarget !== undefined) await this.answerLocalRetry(request, request.localTarget);
			else await this.route(request);
		} catch (error) {
			this.report(error);
			// Local delivery does not depend on the shared database (spec §8).
			if (request.localTarget !== undefined) return request.notFound();
			this.fail(request, SHARED_STORAGE_UNAVAILABLE_REASON, request.requirePendingReply ? "session_not_found" : undefined);
		}
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
					sameGroup(info, from.info) ||
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
			.enqueue({ targetIdentity: owner.identity, originBrokerId: this.brokerId, digest, frame })
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
	private async answerLocalRetry(request: RemoteSendRequest, target: BrokerConnectedSession): Promise<void> {
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
			const existing = await Promise.race([lookup, expired]);
			if (existing === "expired") {
				lookup.catch((error: Error) => this.report(error));
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
			request.notFound();
		} finally {
			clearTimeout(bound);
		}
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
		const sessions = found.sessions.filter((session) => !localIdentities.has(session.targetIdentity));
		const byId = sessions.find((session) => session.intercomSessionId === request.target);
		if (byId !== undefined) return byId;
		const replyAuthorized = await this.replyAuthorizedTargets(
			request,
			sessions.map((session) => session.intercomSessionId),
		);
		const visible = sessions.filter(
			(session) =>
				sharesGroup(new Set(session.groups), request.from.info) ||
				(request.supervisorSend && session.intercomSessionId === request.from.supervisorId) ||
				replyAuthorized.has(session.intercomSessionId),
		);
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
			this.fail(request, "Pending question route does not authorize this public reply");
			return;
		}
		const verticalReply =
			message.replyTo !== undefined &&
			this.host.supervisorCache.matchReply(message.replyTo, from.info.id, target.sessionId);
		if (!request.supervisorSend && !verticalReply && !correlatedReply && !sharesGroup(target.groups, from.info)) {
			this.fail(request, TARGET_GROUP_REFUSAL);
			return;
		}
		if (message.expectsReply === true && target.gates.replyCapability === "terminal") {
			this.fail(request, TERMINAL_CHILD_ASK_REFUSAL);
			return;
		}
		const reserved = await this.state.sentMessages.reserve({
			messageId: message.id,
			digest,
			targetIdentity: target.identity,
			...(message.expectsReply === true
				? { questionRoute: { targetSessionId: target.sessionId, senderGroupIdentity: senderGroupIdentity(from) } }
				: {}),
		});
		if (reserved.status === "conflict") {
			this.failConflict(request);
			return;
		}
		const frame: IntercomDeliveryFrame = request.supervisorSend
			? { type: "message", from: from.info, message, channel: "supervisor" }
			: { type: "message", from: from.info, message };
		const enqueued = await this.state.outbox.enqueue({
			targetIdentity: target.identity,
			originBrokerId: this.brokerId,
			digest,
			frame,
		});
		if (enqueued.status === "conflict") {
			this.failConflict(request);
			return;
		}
		if (enqueued.status === "invalid") {
			this.fail(request, "Session not found");
			return;
		}
		await this.answerExistingRow(request, target, digest, enqueued.row);
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
			senderGroups: [...sessionGroups(request.from.info)],
			expectsReply: message.expectsReply === true,
			resolveReplyTarget: request.resolveReplyTarget,
			targetSessionId: target.sessionId,
			targetIdentity: target.identity,
			queued: offline,
			timer: undefined,
			waitingSince: Date.now(),
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

	private async queuePosition(identity: string, messageId: string): Promise<number> {
		const listed = await this.state.outbox.listUndelivered(identity);
		const index = listed.status === "listed" ? listed.rows.findIndex((entry) => entry.messageId === messageId) : -1;
		return index + 1 || 1;
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
		const sender = { sessionId: waiter.senderSessionId, groups: waiter.senderGroups };
		for (const id of [waiter.targetSessionId, returnAddressOf(waiter.targetIdentity)]) {
			if (id === undefined) continue;
			const lookup = await this.state.reservations.lookup(normalizeTarget(id), sender, BROKER_LEASE_STALE_AFTER_MS);
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
			{ sessionId: from.info.id, groups: [...sessionGroups(from.info)] },
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
		if (this.localSessionFor(identity) === undefined) return;
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
				await this.state.outbox.releaseClaim(claim);
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
			this.host.writeConfirmed(session.socket, frame, (written) => {
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
		if (frame.channel === "supervisor" || sameGroup(recipient.info, frame.from)) return undefined;
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
				Math.max(0, waiter.waitingSince + RECIPIENT_SAVE_MAX_WAIT_MS - Date.now()),
			);
			waiter.capTimer.unref?.();
		}
	}

	/** The sender may wait this much longer under the save cap; 0 once the cap is reached. */
	private capRemaining(waiter: Waiter): number {
		return Math.max(0, waiter.waitingSince + RECIPIENT_SAVE_MAX_WAIT_MS - Date.now());
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

	private async renew(): Promise<void> {
		if (this.membership !== undefined) {
			const renewed = await this.state.leases.renew(this.membership);
			if (renewed.status !== "renewed") this.membership = undefined;
		}
		if (this.membership === undefined) {
			const acquired = await this.state.leases.acquire(
				{ kind: "broker", brokerId: this.brokerId, nodeId: this.nodeId, startedAt: Date.now() },
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
			} else {
				this.serial(deliveryTargetIdentity(session), async () => {
					if (this.presence.get(session) !== entry) return;
					await this.acquirePresence(session, entry);
					if (entry.lease === undefined) return;
					const { rebind } = entry;
					if (rebind !== undefined) {
						delete entry.rebind;
						await this.rebindParked(session, rebind);
					}
					this.scanIdentity(deliveryTargetIdentity(session));
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
		for (const identity of [...this.heldIdentities]) this.scanIdentity(identity);
	}

	private async backupPoll(): Promise<void> {
		this.scanAll();
		await this.checkOutcomes();
		await this.checkHolds();
		for (const reservationKey of this.mirrored.keys()) {
			if (this.pendingWakeChecks.has(reservationKey)) continue;
			this.pendingWakeChecks.add(reservationKey);
			this.serial(`reservation:${reservationKey}`, () =>
				this.wakeWaitingChild(reservationKey).finally(() => this.pendingWakeChecks.delete(reservationKey)),
			);
		}
		await this.state.outbox.prune(DELIVERED_MESSAGE_TTL_MS);
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
