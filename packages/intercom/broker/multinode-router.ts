import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { normalizeGroup } from "../group.js";
import { isAgentRecipient, NON_AGENT_RECIPIENT_REFUSAL, TERMINAL_CHILD_ASK_REFUSAL } from "../recipient-purpose.js";
import { DELIVERED_MESSAGE_TTL_MS, RECIPIENT_RECEIPT_TIMEOUT_MS } from "../retry-policy.js";
import {
	resolveSessionTarget,
	resolveSessionTargetByHostSessionId,
	type SessionTargetResolution,
	sessionTargetFailureReason,
} from "../session-target.js";
import type { SessionInfo } from "../types.js";
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
	type RestoringReservationLease,
	reservationKeyFor,
} from "./multinode-state-store.js";
import type { PendingQuestionIndex } from "./pending-question-index.js";
import { UNCERTAIN_RECEIPT_REASON } from "./recipient-receipts.js";
import { RESTORING_RECIPIENT_HOLD_MS, restoringRecipientRetryReason } from "./restoring-recipients.js";
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
}

interface Waiter {
	readonly messageId: string;
	readonly digest: string;
	readonly socket: BrokerConnectedSession["socket"];
	readonly attemptId?: string;
	readonly senderSessionId: string;
	readonly expectsReply: boolean;
	readonly resolveReplyTarget: boolean;
	readonly targetSessionId: string;
	readonly targetIdentity: string;
	/** Told `queued` already: `delivered` follows only while the sender is connected, and it never expires. */
	readonly queued: boolean;
	timer: ReturnType<typeof setTimeout> | undefined;
}

interface TrackedHold {
	readonly messageId: string;
	readonly reservationKey: string;
	readonly childName: string;
	readonly socket: BrokerConnectedSession["socket"];
	readonly senderId: string;
	readonly attemptId?: string;
	readonly clientMessage: SendClientMessage;
	readonly timer: ReturnType<typeof setTimeout>;
}

interface PresenceEntry {
	lease?: Lease;
	/** `Date.now()` when this broker last wrote the session's known-session record. */
	knownAt?: number;
	/** The session's asks were failed once it turned terminal. */
	terminal?: boolean;
}

interface MirroredReservation {
	lease: RestoringReservationLease;
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
		consumed?: { readonly capability: string; readonly childName?: string; readonly groups: ReadonlySet<string> },
	): Promise<void> {
		if (this.closed || this.presence.has(session)) return Promise.resolve();
		const entry: PresenceEntry = {};
		this.presence.set(session, entry);
		const identity = deliveryTargetIdentity(session);
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
					if (consumed !== undefined) await this.consumeReservation(consumed);
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
	sessionLeft(session: BrokerConnectedSession): void {
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
			for (const inflight of claims) await this.state.outbox.releaseClaim(inflight.claim);
			if (entry.lease !== undefined) await this.state.leases.release(entry.lease);
			await this.recordKnown(session, entry);
			await this.state.pendingAsks.pruneSender(sessionId);
			await this.state.pendingAsks.takeForTarget(sessionId);
			for (const hold of holds) await this.state.heldSends.drop(hold.messageId);
			for (const [key, mirror] of [...this.mirrored]) {
				if (mirror.lease.ownerSessionId !== sessionId) continue;
				this.mirrored.delete(key);
				await this.state.reservations.release(mirror.lease);
				await this.wakeHeldOrigins(key);
			}
		});
	}

	/** #3761 `received` from a local recipient; true when it confirms a row this broker claimed for it. */
	received(recipient: BrokerConnectedSession, messageId: string): boolean {
		const inflight = this.inflight.get(messageId);
		if (inflight === undefined || inflight.identity !== deliveryTargetIdentity(recipient)) return false;
		this.settleDelivered(inflight, recipient);
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
	): void {
		if (this.closed) return;
		const reservationKey = reservationKeyFor(capability);
		const owner = this.host.sessions.get(ownerSessionId);
		this.serial(`reservation:${reservationKey}`, async () => {
			const reserved = await this.state.reservations.reserve({
				reservationKey,
				ownerSessionId,
				ownerBrokerId: this.brokerId,
				childName,
				childTarget: normalizeTarget(childName),
				aliases: aliases.map(normalizeTarget).filter((alias) => alias.length > 0),
				group,
				dormant,
			});
			if (reserved.status !== "reserved") return;
			// The owner left (or its id was taken over) while the reserve was being written: its departure scanned the
			// mirrors before this one existed, so end the reservation here instead of renewing it for a gone owner.
			if (this.host.sessions.get(ownerSessionId) !== owner) {
				await this.state.reservations.release(reserved.lease);
				await this.wakeHeldOrigins(reservationKey);
				return;
			}
			this.mirrored.set(reservationKey, { lease: reserved.lease });
		});
	}

	/** The owner released the reservation; `gone` is the formatted gone refusal kept as a marker. */
	restoringReleased(capability: string, ownerSessionId: string, gone?: string, refusal?: string): void {
		if (this.closed) return;
		const reservationKey = reservationKeyFor(capability);
		// Behind the reserve on the same key: a release while the reserve is still being written ends what it wrote.
		this.serial(`reservation:${reservationKey}`, async () => {
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

	private async consumeReservation(consumed: {
		readonly capability: string;
		readonly childName?: string;
		readonly groups: ReadonlySet<string>;
	}): Promise<void> {
		const reservationKey = reservationKeyFor(consumed.capability);
		const result = await this.state.reservations.consume(
			reservationKey,
			consumed.childName === undefined
				? undefined
				: { childTarget: normalizeTarget(consumed.childName), groups: [...consumed.groups] },
		);
		if (result.status !== "consumed") return;
		for (const key of result.reservationKeys) {
			this.mirrored.delete(key);
			await this.wakeHeldOrigins(key);
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
		void this.routeSendSafely(request);
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

	/**
	 * A send that resolved to a session on this broker: a same-id retry of a send that already went through the shared
	 * outbox (its recipient has since moved here) is answered from that row, never delivered again; any other send
	 * takes the local path. A lookup the shared database does not answer within `LOCAL_RETRY_LOOKUP_BOUND_MS` takes the
	 * local path too, and its late answer is ignored: the send has been answered once already.
	 */
	private async answerLocalRetry(request: RemoteSendRequest, target: BrokerConnectedSession): Promise<void> {
		const lookup = this.state.outbox.read(request.message.id);
		let bound: ReturnType<typeof setTimeout> | undefined;
		const expired = new Promise<"expired">((resolve) => {
			bound = setTimeout(() => resolve("expired"), LOCAL_RETRY_LOOKUP_BOUND_MS);
			bound.unref?.();
		});
		const existing = await Promise.race([lookup, expired]).finally(() => clearTimeout(bound));
		if (existing === "expired") {
			lookup.catch((error: Error) => this.report(error));
			request.notFound();
			return;
		}
		if (existing.status !== "found") {
			request.notFound();
			return;
		}
		await this.answerExistingRow(
			request,
			{
				identity: deliveryTargetIdentity(target),
				sessionId: target.info.id,
				groups: sessionGroups(target.info),
				gates: target.info,
				hostBrokerId: this.brokerId,
			},
			crossNodeDigest(request.signature),
			existing.row,
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
			expectsReply: message.expectsReply === true,
			resolveReplyTarget: request.resolveReplyTarget,
			targetSessionId: target.sessionId,
			targetIdentity: target.identity,
			queued: offline,
			timer: undefined,
		};
		waiter.timer = setTimeout(
			() => {
				if (this.waiters.get(message.id) !== waiter) return;
				this.dropWaiter(waiter);
				if (!offline) {
					this.host.write(request.socket, {
						type: "delivery_failed",
						messageId: message.id,
						attemptId: request.attemptId,
						reason: UNCERTAIN_RECEIPT_REASON,
					});
				}
			},
			offline ? DELIVERED_MESSAGE_TTL_MS : RECIPIENT_RECEIPT_TIMEOUT_MS,
		);
		waiter.timer.unref?.();
		this.waiters.set(message.id, waiter);
		if (offline) {
			const listed = await this.state.outbox.listUndelivered(target.identity);
			const index = listed.status === "listed" ? listed.rows.findIndex((entry) => entry.messageId === message.id) : -1;
			this.host.write(request.socket, {
				type: "queued",
				messageId: message.id,
				...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
				target: OFFLINE_SESSION_TARGET,
				position: index + 1 || 1,
			});
			return;
		}
		if (asksTarget) await this.writeQuestionTarget(request.socket, message.id, request.attemptId, target);
		await this.bus.publish({ brokerId: target.hostBrokerId!, reason: "outbox", version: row.sequence });
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
		if (!request.awaitRestoringRecipient || count >= MAX_HELD_SENDS) {
			this.fail(request, restoringRecipientRetryReason(reservation.childName));
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
			timer,
		});
		this.host.write(request.socket, {
			type: "send_held",
			messageId: message.id,
			...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
			timeoutMs: RESTORING_RECIPIENT_HOLD_MS,
		});
		return true;
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
		this.writeHoldFailure(hold, restoringRecipientRetryReason(hold.childName));
	}

	private writeHoldFailure(hold: TrackedHold, reason: string): void {
		this.host.write(hold.socket, {
			type: "delivery_failed",
			messageId: hold.messageId,
			...(hold.attemptId === undefined ? {} : { attemptId: hold.attemptId }),
			reason,
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
			const refusal = await this.transitRefusal(row.frame, session);
			if (refusal !== undefined) {
				const failed = await this.state.outbox.markFailed(claim, refusal);
				if (failed.status === "failed") await this.wakeOrigin(row);
				continue;
			}
			const inflight: Inflight = { claim, row, session, identity };
			this.inflight.set(row.messageId, inflight);
			this.host.writeConfirmed(session.socket, row.frame, (written) => {
				if (this.inflight.get(row.messageId) !== inflight) return;
				if (!written) {
					this.inflight.delete(row.messageId);
					void this.state.outbox.releaseClaim(claim).catch((error: Error) => this.report(error));
					return;
				}
				// A recipient that never confirms saves is delivered once the frame is written, as locally.
				if (session.acknowledgesReceipt !== true) this.settleDelivered(inflight, session);
			});
		}
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

	private settleDelivered(inflight: Inflight, recipient: BrokerConnectedSession): void {
		this.inflight.delete(inflight.row.messageId);
		const { frame } = inflight.row;
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

	private dropWaiter(waiter: Waiter): void {
		if (this.waiters.get(waiter.messageId) === waiter) this.waiters.delete(waiter.messageId);
		if (waiter.timer !== undefined) clearTimeout(waiter.timer);
	}

	// ---------------------------------------------------------------------------------------------------------
	// Hints, polls and renewals

	private onWakeUp(event: WakeUpEvent): void {
		if (this.closed) return;
		if (event.kind === "resync") {
			this.scanAll();
			void this.checkOutcomes();
			void this.guard(this.checkHolds());
			return;
		}
		if (event.hint.reason === "outbox") this.scanAll();
		else {
			void this.checkOutcomes();
			void this.guard(this.checkHolds());
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
					if (entry.lease !== undefined) this.scanIdentity(deliveryTargetIdentity(session));
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
		await this.state.outbox.prune(DELIVERED_MESSAGE_TTL_MS);
		await this.state.sentMessages.prune(DELIVERED_MESSAGE_TTL_MS);
		await this.state.reservations.prune(DELIVERED_MESSAGE_TTL_MS);
		await this.state.knownSessions.prune(KNOWN_SESSION_RETENTION_MS);
	}

	private async outcomePoll(): Promise<void> {
		if ([...this.waiters.values()].some((waiter) => !waiter.queued)) await this.checkOutcomes();
		if (this.holds.size > 0) await this.checkHolds();
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

	private fail(request: RemoteSendRequest, reason: string, reasonCode?: "session_not_found"): void {
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
