import { randomUUID } from "node:crypto";
import type {
	BrokerLeaseStore,
	HeldSend,
	HeldSendStore,
	InvalidStateInput,
	Lease,
	LeaseKey,
	LeaseState,
	LeaseSubject,
	OutboxClaim,
	OutboxClaimWriteRejection,
	OutboxRow,
	OutboxRowState,
	OutboxStore,
	PendingAsk,
	PendingAskStore,
	ReplyRoute,
	SentMessageAuthority,
	SentMessageState,
	SentQuestionRoute,
	StateStoreInvalidReason,
} from "../../packages/intercom/broker/multinode-state-store.js";
import type { WakeUpBus, WakeUpEvent, WakeUpListener } from "../../packages/intercom/broker/wake-up-bus.js";
import type { SharedStoreFixture, WakeUpBusFixture } from "./intercom-multinode-contract.js";

/**
 * Test-only reference for the multi-node contract suite. It exists to prove the suite runs green; it is not a
 * product implementation. Every `connect()` returns another view of one shared in-memory state, standing in for
 * brokers on different hosts that share one database.
 */

const invalid = (reason: StateStoreInvalidReason): InvalidStateInput => ({ status: "invalid", reason });
const ageOf = (since: number): number => Math.max(0, Date.now() - since);
const isLive = (since: number, staleAfterMs: number): boolean => ageOf(since) <= staleAfterMs;

function subjectId(subject: LeaseSubject): string {
	return subject.kind === "broker" ? subject.brokerId : subject.targetIdentity;
}

function keyId(key: LeaseKey): string {
	return key.kind === "broker" ? key.brokerId : key.targetIdentity;
}

function keyOf(subject: LeaseSubject): LeaseKey {
	return subject.kind === "broker"
		? { kind: "broker", brokerId: subject.brokerId }
		: { kind: "presence", targetIdentity: subject.targetIdentity };
}

function invalidKey(kind: LeaseKey["kind"], id: string): InvalidStateInput | undefined {
	if (id.length > 0) return undefined;
	return invalid(kind === "broker" ? "empty-broker-id" : "empty-target-identity");
}

interface LeaseHolder {
	readonly holderId: string;
	readonly fencingToken: number;
	subject: LeaseSubject;
	renewedAt: number;
}

interface LeaseRecord {
	readonly order: number;
	lastToken: number;
	holder?: LeaseHolder;
}

function leaseStore(records: Map<string, LeaseRecord>, nextOrder: { value: number }): BrokerLeaseStore {
	const storageKey = (kind: LeaseKey["kind"], id: string): string => JSON.stringify([kind, id]);
	const lease = (holder: LeaseHolder): Lease => ({
		key: keyOf(holder.subject),
		holderId: holder.holderId,
		fencingToken: holder.fencingToken,
	});
	const state = (holder: LeaseHolder): LeaseState => ({
		...lease(holder),
		subject: structuredClone(holder.subject),
		ageMs: ageOf(holder.renewedAt),
	});
	const current = (candidate: Lease): LeaseRecord | InvalidStateInput | undefined => {
		const bad = invalidKey(candidate.key.kind, keyId(candidate.key));
		if (bad !== undefined) return bad;
		if (candidate.holderId.length === 0) return invalid("empty-holder-id");
		return records.get(storageKey(candidate.key.kind, keyId(candidate.key)));
	};
	const owns = (record: LeaseRecord | undefined, candidate: Lease): boolean =>
		record?.holder !== undefined &&
		record.holder.holderId === candidate.holderId &&
		record.holder.fencingToken === candidate.fencingToken;
	const stale = (record: LeaseRecord | undefined) =>
		record?.holder === undefined
			? ({ status: "stale" } as const)
			: ({ status: "stale", currentFencingToken: record.holder.fencingToken } as const);
	return {
		async acquire(subject, holderId, staleAfterMs) {
			const bad = invalidKey(subject.kind, subjectId(subject));
			if (bad !== undefined) return bad;
			if (holderId.length === 0) return invalid("empty-holder-id");
			const key = storageKey(subject.kind, subjectId(subject));
			let record = records.get(key);
			if (record === undefined) {
				record = { order: nextOrder.value++, lastToken: 0 };
				records.set(key, record);
			}
			const holder = record.holder;
			if (holder !== undefined && holder.holderId === holderId) {
				holder.subject = structuredClone(subject);
				holder.renewedAt = Date.now();
				return { status: "acquired", lease: lease(holder) };
			}
			if (holder !== undefined && isLive(holder.renewedAt, staleAfterMs)) {
				return { status: "held", holderId: holder.holderId, fencingToken: holder.fencingToken };
			}
			record.lastToken += 1;
			record.holder = {
				holderId,
				fencingToken: record.lastToken,
				subject: structuredClone(subject),
				renewedAt: Date.now(),
			};
			return { status: "acquired", lease: lease(record.holder) };
		},
		async renew(candidate, subject) {
			const record = current(candidate);
			if (record !== undefined && "status" in record) return record;
			if (subject !== undefined && JSON.stringify(keyOf(subject)) !== JSON.stringify(candidate.key)) {
				return invalid("subject-key-mismatch");
			}
			if (!owns(record, candidate)) return stale(record);
			const holder = record!.holder!;
			if (subject !== undefined) holder.subject = structuredClone(subject);
			holder.renewedAt = Date.now();
			return { status: "renewed" };
		},
		async release(candidate) {
			const record = current(candidate);
			if (record !== undefined && "status" in record) return record;
			if (!owns(record, candidate)) return stale(record);
			record!.holder = undefined;
			return { status: "released" };
		},
		async read(key) {
			const bad = invalidKey(key.kind, keyId(key));
			if (bad !== undefined) return bad;
			const holder = records.get(storageKey(key.kind, keyId(key)))?.holder;
			return holder === undefined ? { status: "missing" } : { status: "found", lease: state(holder) };
		},
		async listLive(kind, staleAfterMs) {
			return [...records.values()]
				.sort((left, right) => left.order - right.order)
				.flatMap((record) =>
					record.holder !== undefined &&
					record.holder.subject.kind === kind &&
					isLive(record.holder.renewedAt, staleAfterMs)
						? [state(record.holder)]
						: [],
				);
		},
	};
}

interface OutboxRecord {
	readonly sequence: number;
	readonly messageId: string;
	readonly targetIdentity: string;
	readonly originBrokerId: string;
	readonly digest: string;
	readonly frame: OutboxRow["frame"];
	state: OutboxRowState;
	claimAttempts: number;
	failureReason?: string;
	claim?: { readonly claimantId: string; readonly token: string; readonly attempt: number; renewedAt: number };
	settledAt?: number;
}

interface OutboxState {
	readonly rows: Map<string, OutboxRecord>;
	nextSequence: number;
}

function outboxStore(shared: OutboxState): OutboxStore {
	const row = (record: OutboxRecord): OutboxRow => ({
		sequence: record.sequence,
		messageId: record.messageId,
		targetIdentity: record.targetIdentity,
		originBrokerId: record.originBrokerId,
		digest: record.digest,
		frame: structuredClone(record.frame),
		state: record.state,
		claimAttempts: record.claimAttempts,
		...(record.failureReason === undefined ? {} : { failureReason: record.failureReason }),
	});
	const settled = (record: OutboxRecord): boolean => record.state === "delivered" || record.state === "failed";
	const undelivered = (targetIdentity: string): OutboxRecord[] =>
		[...shared.rows.values()]
			.filter((record) => record.targetIdentity === targetIdentity && !settled(record))
			.sort((left, right) => left.sequence - right.sequence);
	const heldClaim = (claim: OutboxClaim): OutboxRecord | OutboxClaimWriteRejection => {
		if (claim.messageId.length === 0) return invalid("empty-message-id");
		if (claim.claimantId.length === 0) return invalid("empty-claimant-id");
		const record = shared.rows.get(claim.messageId);
		if (record === undefined) return { status: "unknown" };
		if (settled(record)) return { status: "settled", row: row(record) };
		if (record.claim?.token !== claim.token || record.claim.claimantId !== claim.claimantId)
			return { status: "stale" };
		return record;
	};
	const settle = (record: OutboxRecord, state: "delivered" | "failed", reason?: string): OutboxRow => {
		record.state = state;
		record.claim = undefined;
		record.settledAt = Date.now();
		if (reason !== undefined) record.failureReason = reason;
		return row(record);
	};
	return {
		async enqueue(request) {
			if (request.targetIdentity.length === 0) return invalid("empty-target-identity");
			if (request.originBrokerId.length === 0) return invalid("empty-broker-id");
			const messageId = request.frame.message.id;
			if (messageId.length === 0) return invalid("empty-message-id");
			const existing = shared.rows.get(messageId);
			if (existing !== undefined) {
				return existing.digest === request.digest
					? { status: "duplicate", row: row(existing) }
					: { status: "conflict", messageId };
			}
			const record: OutboxRecord = {
				sequence: shared.nextSequence++,
				messageId,
				targetIdentity: request.targetIdentity,
				originBrokerId: request.originBrokerId,
				digest: request.digest,
				frame: structuredClone(request.frame),
				state: "queued",
				claimAttempts: 0,
			};
			shared.rows.set(messageId, record);
			return { status: "inserted", row: row(record) };
		},
		async claim(request) {
			if (request.claimantId.length === 0) return invalid("empty-claimant-id");
			if (request.targetIdentity.length === 0) return invalid("empty-target-identity");
			const records = undelivered(request.targetIdentity);
			const other = records.find(
				(record) =>
					record.claim !== undefined &&
					record.claim.claimantId !== request.claimantId &&
					isLive(record.claim.renewedAt, request.staleAfterMs),
			);
			if (other?.claim !== undefined) return { status: "held", claimantId: other.claim.claimantId };
			const rows = records.flatMap((record) => {
				if (
					record.claim !== undefined &&
					record.claim.claimantId === request.claimantId &&
					isLive(record.claim.renewedAt, request.staleAfterMs)
				) {
					return [];
				}
				record.claimAttempts += 1;
				record.state = "claimed";
				record.claim = {
					claimantId: request.claimantId,
					token: randomUUID(),
					attempt: record.claimAttempts,
					renewedAt: Date.now(),
				};
				const claim: OutboxClaim = {
					messageId: record.messageId,
					claimantId: request.claimantId,
					token: record.claim.token,
					attempt: record.claim.attempt,
				};
				return [{ row: row(record), claim }];
			});
			return { status: "claimed", rows };
		},
		async renewClaim(claim) {
			const record = heldClaim(claim);
			if ("status" in record) return record;
			record.claim!.renewedAt = Date.now();
			return { status: "renewed" };
		},
		async releaseClaim(claim) {
			const record = heldClaim(claim);
			if ("status" in record) return record;
			record.claim = undefined;
			record.state = "queued";
			return { status: "released" };
		},
		async markDelivered(claim) {
			const record = heldClaim(claim);
			if ("status" in record) return record;
			return { status: "delivered", row: settle(record, "delivered") };
		},
		async markFailed(claim, reason) {
			const record = heldClaim(claim);
			if ("status" in record) return record;
			return { status: "failed", row: settle(record, "failed", reason) };
		},
		async read(messageId) {
			if (messageId.length === 0) return invalid("empty-message-id");
			const record = shared.rows.get(messageId);
			return record === undefined ? { status: "missing" } : { status: "found", row: row(record) };
		},
		async listUndelivered(targetIdentity) {
			if (targetIdentity.length === 0) return invalid("empty-target-identity");
			return { status: "listed", rows: undelivered(targetIdentity).map(row) };
		},
		async prune(settledOlderThanMs) {
			let removed = 0;
			for (const [messageId, record] of shared.rows) {
				if (record.settledAt !== undefined && ageOf(record.settledAt) > settledOlderThanMs) {
					shared.rows.delete(messageId);
					removed++;
				}
			}
			return removed;
		},
	};
}

function heldSendStore(held: Map<string, HeldSend>): HeldSendStore {
	const forReservation = (reservationKey: string): HeldSend[] =>
		[...held.values()].filter((send) => send.reservationKey === reservationKey).map((send) => structuredClone(send));
	return {
		async hold(send) {
			if (send.reservationKey.length === 0) return invalid("empty-reservation-key");
			if (send.originBrokerId.length === 0) return invalid("empty-broker-id");
			if (send.senderSessionId.length === 0) return invalid("empty-session-id");
			const messageId = send.request.message.id;
			if (messageId.length === 0) return invalid("empty-message-id");
			if (held.has(messageId)) return { status: "duplicate" };
			held.set(messageId, structuredClone(send));
			return { status: "held" };
		},
		async list(reservationKey) {
			if (reservationKey.length === 0) return invalid("empty-reservation-key");
			return { status: "listed", sends: forReservation(reservationKey) };
		},
		async take(reservationKey) {
			if (reservationKey.length === 0) return invalid("empty-reservation-key");
			const sends = forReservation(reservationKey);
			for (const send of sends) held.delete(send.request.message.id);
			return { status: "taken", sends };
		},
		async drop(messageId) {
			if (messageId.length === 0) return invalid("empty-message-id");
			return held.delete(messageId) ? { status: "dropped" } : { status: "missing" };
		},
	};
}

function pendingAskStore(asks: PendingAsk[]): PendingAskStore {
	const invalidRoute = (route: ReplyRoute): InvalidStateInput | undefined => {
		if (route.replySenderSessionId.length === 0 || route.replyTargetSessionId.length === 0) {
			return invalid("empty-session-id");
		}
		return route.replyTo.length === 0 ? invalid("empty-message-id") : undefined;
	};
	const reverseOf = (route: ReplyRoute): number =>
		asks.findIndex(
			(ask) =>
				ask.targetSessionId === route.replySenderSessionId &&
				ask.senderSessionId === route.replyTargetSessionId &&
				ask.messageId === route.replyTo,
		);
	return {
		async record(ask) {
			if (ask.senderSessionId.length === 0 || ask.targetSessionId.length === 0) return invalid("empty-session-id");
			if (ask.messageId.length === 0) return invalid("empty-message-id");
			const exists = asks.some(
				(entry) =>
					entry.senderSessionId === ask.senderSessionId &&
					entry.targetSessionId === ask.targetSessionId &&
					entry.messageId === ask.messageId,
			);
			if (exists) return { status: "duplicate" };
			asks.push({ ...ask });
			return { status: "recorded" };
		},
		async matchesReply(route) {
			return invalidRoute(route) ?? (reverseOf(route) >= 0 ? { status: "match" } : { status: "no-match" });
		},
		async clearReply(route) {
			const bad = invalidRoute(route);
			if (bad !== undefined) return bad;
			const index = reverseOf(route);
			if (index < 0) return { status: "no-match" };
			asks.splice(index, 1);
			return { status: "cleared" };
		},
		async pruneSender(senderSessionId) {
			if (senderSessionId.length === 0) return invalid("empty-session-id");
			const before = asks.length;
			const kept = asks.filter((ask) => ask.senderSessionId !== senderSessionId);
			asks.splice(0, asks.length, ...kept);
			return { status: "pruned", removed: before - kept.length };
		},
		async takeForTarget(targetSessionId) {
			if (targetSessionId.length === 0) return invalid("empty-session-id");
			const taken = asks.filter((ask) => ask.targetSessionId === targetSessionId);
			asks.splice(0, asks.length, ...asks.filter((ask) => ask.targetSessionId !== targetSessionId));
			return { status: "taken", asks: taken.map((ask) => ({ ...ask })) };
		},
	};
}

interface SentRecord {
	readonly digest: string;
	readonly targetIdentity: string;
	readonly questionRoute?: SentQuestionRoute;
	state: SentMessageState;
	readonly recordedAt: number;
}

function sentMessageAuthority(sent: Map<string, SentRecord>): SentMessageAuthority {
	return {
		async reserve(reservation) {
			if (reservation.messageId.length === 0) return invalid("empty-message-id");
			if (reservation.targetIdentity.length === 0) return invalid("empty-target-identity");
			const existing = sent.get(reservation.messageId);
			if (existing !== undefined) {
				return existing.digest === reservation.digest
					? { status: "match", state: existing.state }
					: { status: "conflict" };
			}
			sent.set(reservation.messageId, {
				digest: reservation.digest,
				targetIdentity: reservation.targetIdentity,
				...(reservation.questionRoute === undefined ? {} : { questionRoute: { ...reservation.questionRoute } }),
				state: "reserved",
				recordedAt: Date.now(),
			});
			return { status: "reserved" };
		},
		async accept(key) {
			if (key.messageId.length === 0) return invalid("empty-message-id");
			const existing = sent.get(key.messageId);
			if (existing === undefined) return { status: "missing" };
			if (existing.digest !== key.digest) return { status: "conflict" };
			existing.state = "accepted";
			return { status: "accepted" };
		},
		async lookup(key) {
			if (key.messageId.length === 0) return invalid("empty-message-id");
			const existing = sent.get(key.messageId);
			if (existing === undefined) return { status: "miss" };
			if (existing.digest !== key.digest) return { status: "conflict" };
			return {
				status: "match",
				state: existing.state,
				targetIdentity: existing.targetIdentity,
				...(existing.questionRoute === undefined ? {} : { questionRoute: { ...existing.questionRoute } }),
			};
		},
		async forget(key) {
			if (key.messageId.length === 0) return invalid("empty-message-id");
			const existing = sent.get(key.messageId);
			if (existing === undefined) return { status: "missing" };
			if (existing.digest !== key.digest) return { status: "conflict" };
			sent.delete(key.messageId);
			return { status: "forgotten" };
		},
		async prune(olderThanMs) {
			let removed = 0;
			for (const [messageId, record] of sent) {
				if (ageOf(record.recordedAt) > olderThanMs) {
					sent.delete(messageId);
					removed++;
				}
			}
			return removed;
		},
	};
}

function sharedFixture<Store>(connect: () => Store): Promise<SharedStoreFixture<Store>> {
	return Promise.resolve({ connect: async () => connect(), close: async () => {} });
}

export function openMemoryLeaseStoreFixture(): Promise<SharedStoreFixture<BrokerLeaseStore>> {
	const records = new Map<string, LeaseRecord>();
	const nextOrder = { value: 1 };
	return sharedFixture(() => leaseStore(records, nextOrder));
}

export function openMemoryOutboxFixture(): Promise<SharedStoreFixture<OutboxStore>> {
	const shared: OutboxState = { rows: new Map(), nextSequence: 1 };
	return sharedFixture(() => outboxStore(shared));
}

export function openMemoryHeldSendFixture(): Promise<SharedStoreFixture<HeldSendStore>> {
	const held = new Map<string, HeldSend>();
	return sharedFixture(() => heldSendStore(held));
}

export function openMemoryPendingAskFixture(): Promise<SharedStoreFixture<PendingAskStore>> {
	const asks: PendingAsk[] = [];
	return sharedFixture(() => pendingAskStore(asks));
}

export function openMemorySentMessageFixture(): Promise<SharedStoreFixture<SentMessageAuthority>> {
	const sent = new Map<string, SentRecord>();
	return sharedFixture(() => sentMessageAuthority(sent));
}

interface MemorySubscription {
	readonly brokerId: string;
	readonly listener: WakeUpListener;
	readonly connection: MemoryConnection;
	open: boolean;
}

interface MemoryConnection {
	open: boolean;
	readonly subscriptions: Set<MemorySubscription>;
}

export function openMemoryWakeUpBusFixture(): Promise<WakeUpBusFixture> {
	const subscriptions = new Set<MemorySubscription>();
	const connections = new Map<WakeUpBus, MemoryConnection>();
	const deliver = (subscription: MemorySubscription, event: WakeUpEvent): void => {
		queueMicrotask(() => {
			if (subscription.open) subscription.listener(structuredClone(event));
		});
	};
	const closeSubscription = (subscription: MemorySubscription): void => {
		subscription.open = false;
		subscriptions.delete(subscription);
		subscription.connection.subscriptions.delete(subscription);
	};
	const connect = async (): Promise<WakeUpBus> => {
		const connection: MemoryConnection = { open: true, subscriptions: new Set() };
		const bus: WakeUpBus = {
			async publish(hint) {
				if (hint.brokerId.length === 0) return { status: "invalid", reason: "empty-broker-id" };
				if (!connection.open) return { status: "unavailable" };
				for (const subscription of subscriptions) {
					if (subscription.brokerId === hint.brokerId) deliver(subscription, { kind: "hint", hint });
				}
				return { status: "published" };
			},
			async subscribe(brokerId, listener) {
				if (brokerId.length === 0) return { status: "invalid", reason: "empty-broker-id" };
				const subscription: MemorySubscription = { brokerId, listener, connection, open: true };
				subscriptions.add(subscription);
				connection.subscriptions.add(subscription);
				deliver(subscription, { kind: "resync", cause: "subscribed" });
				return {
					status: "subscribed",
					subscription: { brokerId, close: async () => closeSubscription(subscription) },
				};
			},
			async close() {
				connection.open = false;
				for (const subscription of [...connection.subscriptions]) closeSubscription(subscription);
			},
		};
		connections.set(bus, connection);
		return bus;
	};
	return Promise.resolve({
		connect,
		async interrupt(bus) {
			for (const subscription of connections.get(bus)?.subscriptions ?? []) {
				deliver(subscription, { kind: "resync", cause: "reconnected" });
			}
		},
		async close() {
			for (const bus of connections.keys()) await bus.close();
		},
	});
}
