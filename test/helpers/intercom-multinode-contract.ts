import assert from "node:assert/strict";
import type {
	BrokerLeaseStore,
	BrokerMembershipSubject,
	ClaimedOutboxRow,
	HeldSend,
	HeldSendStore,
	IntercomDeliveryFrame,
	LeaseSubject,
	OutboxClaim,
	OutboxEnqueueRequest,
	OutboxRow,
	OutboxStore,
	PendingAskStore,
	RecipientPresenceSubject,
	RestoringReservation,
	RestoringReservationRequest,
	RestoringReservationStore,
	SentMessageAuthority,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { reservationKeyFor } from "../../packages/intercom/broker/multinode-state-store.js";
import type {
	WakeUpBus,
	WakeUpEvent,
	WakeUpHint,
	WakeUpListener,
	WakeUpSubscription,
} from "../../packages/intercom/broker/wake-up-bus.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import { sleep } from "./runtime.js";

/**
 * Contract (conformance) suite for the multi-node seams in specs/2026-10-19-intercom-multi-node.md. Register it with
 * a fixture factory; every `connect()` must return another handle on the same shared state, standing in for a
 * broker on another host.
 */

export type MultiNodeConformanceRunner = (name: string, body: () => Promise<void>) => void;

export interface SharedStoreFixture<Store> {
	/** Another handle on the fixture's shared state, as a broker on another host would open. */
	connect(): Promise<Store>;
	close(): Promise<void>;
}

export type OpenSharedStoreFixture<Store> = () => Promise<SharedStoreFixture<Store>>;

export interface WakeUpBusFixture {
	/** Another connection to the fixture's shared bus. */
	connect(): Promise<WakeUpBus>;
	/** Drop this connection's transport once; the bus reconnects and reports a `reconnected` resync. */
	interrupt(bus: WakeUpBus): Promise<void>;
	close(): Promise<void>;
}

export type OpenWakeUpBusFixture = () => Promise<WakeUpBusFixture>;

export interface CrossNodeFixtures {
	readonly openOutbox: OpenSharedStoreFixture<OutboxStore>;
	readonly openPendingAsks: OpenSharedStoreFixture<PendingAskStore>;
	readonly openBus: OpenWakeUpBusFixture;
}

export interface CrossNodeHeldFixtures {
	readonly openReservations: OpenSharedStoreFixture<RestoringReservationStore>;
	readonly openHeldSends: OpenSharedStoreFixture<HeldSendStore>;
	readonly openOutbox: OpenSharedStoreFixture<OutboxStore>;
	readonly openBus: OpenWakeUpBusFixture;
}

/** Passed as `staleAfterMs` to treat a lease or claim of any realistic age as live. */
const LIVE_MS = 3_600_000;
/** Passed as `staleAfterMs` to treat every lease or claim as expired. */
const EXPIRED_MS = -1;
/** Upper bound for a healthy bus to deliver a published hint or a resync. */
const WAKE_UP_DELIVERY_BOUND_MS = 5_000;
/** How long a closed subscription is watched for stray events. */
const CLOSED_SUBSCRIPTION_QUIET_MS = 100;
/** Wait between taking a lease or claim and renewing it, so a renewal that leaves the age unchanged is observable. */
const RENEWAL_GAP_MS = 1_000;
/** Store-clock rounding allowed when a store age is compared with an interval the caller measured. */
const CLOCK_TOLERANCE_MS = 25;

const RECIPIENT = JSON.stringify(["return", "recipient-address", "team"]);
const SENDER_IDENTITY = JSON.stringify(["return", "sender-address", "team"]);
const OTHER_RECIPIENT = JSON.stringify(["session", "other-recipient"]);
const THIRD_RECIPIENT = JSON.stringify(["session", "third-recipient"]);

function sessionInfo(id: string, name: string): SessionInfo {
	return {
		id,
		name,
		cwd: "/work/ünï code ",
		model: "provider/model",
		pid: 4242,
		startedAt: 1_700_000_000_000,
		lastActivity: 1_700_000_000_500,
		status: "idle",
		groups: ["team", "Review Crew"],
		replyCapability: "live",
	};
}

const SENDER = sessionInfo("sender-session", "  sender\t");
const RECIPIENT_SESSION = sessionInfo("recipient-session", "recipient");

function frameFor(id: string, text: string, from: SessionInfo = SENDER): IntercomDeliveryFrame {
	return { type: "message", from, message: { id, timestamp: 1_700_000_001_000, content: { text } } };
}

/** Every optional field the recipient's card, reply routing and supervisor routing read. */
function richFrame(id: string): IntercomDeliveryFrame {
	const message: Message = {
		id,
		timestamp: 1_700_000_002_000,
		replyTo: "earlier-question",
		expectsReply: true,
		source: { subagentRunId: "run-7", subagentAgent: "worker", subagentIndex: 0 },
		content: {
			text: "  leading space\tand tab\n ünï 🚀 \u0000 nul and trailing  ",
			attachments: [
				{ type: "snippet", name: " notes.ts ", content: "const x = 1;\r\n", language: "ts" },
				{ type: "file", name: "empty.txt", content: "" },
			],
		},
	};
	return { type: "message", from: SENDER, message, channel: "supervisor" };
}

function request(frame: IntercomDeliveryFrame, overrides: Partial<OutboxEnqueueRequest> = {}): OutboxEnqueueRequest {
	return {
		targetIdentity: RECIPIENT,
		originBrokerId: "broker-a",
		digest: `digest:${frame.message.id}`,
		frame,
		...overrides,
	};
}

function expectStatus<Result extends { readonly status: string }, Status extends Result["status"]>(
	result: Result,
	status: Status,
): Extract<Result, { readonly status: Status }> {
	assert.equal(result.status, status, `expected ${status}, got ${JSON.stringify(result)}`);
	return result as Extract<Result, { readonly status: Status }>;
}

function assertPositiveSafeInteger(value: number, label: string): void {
	assert.ok(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer, got ${value}`);
}

function withShared<Store>(
	runner: MultiNodeConformanceRunner,
	name: string,
	open: OpenSharedStoreFixture<Store>,
): (label: string, body: (connect: () => Promise<Store>) => Promise<void>) => void {
	return (label, body) => {
		runner(`${name}: ${label}`, async () => {
			const fixture = await open();
			try {
				await body(() => fixture.connect());
			} finally {
				await fixture.close();
			}
		});
	};
}

function presence(targetIdentity: string, session: SessionInfo = RECIPIENT_SESSION): RecipientPresenceSubject {
	return { kind: "presence", targetIdentity, session };
}

function membership(brokerId: string): BrokerMembershipSubject {
	return { kind: "broker", brokerId, nodeId: ` host of ${brokerId} `, startedAt: 1_700_000_000_000 };
}

export function registerBrokerLeaseStoreConformance(
	runner: MultiNodeConformanceRunner,
	name: string,
	open: OpenSharedStoreFixture<BrokerLeaseStore>,
): void {
	const check = withShared(runner, `${name} leases`, open);
	const acquire = async (store: BrokerLeaseStore, holderId: string, subject: LeaseSubject = presence(RECIPIENT)) =>
		expectStatus(await store.acquire(subject, holderId, LIVE_MS), "acquired").lease;

	check("admits exactly one live holder per key across brokers", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		const attempts = await Promise.all([
			a.acquire(presence(RECIPIENT), "broker-a", LIVE_MS),
			b.acquire(presence(RECIPIENT), "broker-b", LIVE_MS),
		]);
		const acquired = attempts.filter((attempt) => attempt.status === "acquired");
		const held = attempts.filter((attempt) => attempt.status === "held");
		assert.equal(acquired.length, 1);
		assert.equal(held.length, 1);
		const lease = expectStatus(acquired[0]!, "acquired").lease;
		assertPositiveSafeInteger(lease.fencingToken, "fencingToken");
		assert.deepEqual(lease.key, { kind: "presence", targetIdentity: RECIPIENT });
		assert.deepEqual(held[0], { status: "held", holderId: lease.holderId, fencingToken: lease.fencingToken });
		const loser = lease.holderId === "broker-a" ? b : a;
		assert.deepEqual(await loser.acquire(presence(RECIPIENT), "broker-c", LIVE_MS), held[0]);
	});

	check("takes over only after expiry, with a greater fencing token that fences the old holder", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		const first = await acquire(a, "broker-a");
		const second = expectStatus(await b.acquire(presence(RECIPIENT), "broker-b", EXPIRED_MS), "acquired").lease;
		assert.equal(second.holderId, "broker-b");
		assert.ok(second.fencingToken > first.fencingToken);
		const fenced = { status: "stale", currentFencingToken: second.fencingToken };
		assert.deepEqual(await a.renew(first), fenced);
		assert.deepEqual(await a.renew(first, presence(RECIPIENT)), fenced);
		assert.deepEqual(await a.release(first), fenced);
		assert.deepEqual(await b.renew(second), { status: "renewed" });
		assert.equal(expectStatus(await a.read(first.key), "found").lease.holderId, "broker-b");
		assert.deepEqual(await a.acquire(presence(RECIPIENT), "broker-a", LIVE_MS), {
			status: "held",
			holderId: "broker-b",
			fencingToken: second.fencingToken,
		});
	});

	check("lets the holder renew and re-acquire an expired lease that nobody took over", async (connect) => {
		const a = await connect();
		const lease = await acquire(a, "broker-a");
		assert.deepEqual(await a.renew(lease), { status: "renewed" });
		const busy = presence(RECIPIENT, { ...RECIPIENT_SESSION, status: "thinking" });
		assert.deepEqual(await a.acquire(busy, "broker-a", EXPIRED_MS), { status: "acquired", lease });
		assert.deepEqual(expectStatus(await a.read(lease.key), "found").lease.subject, busy);
		const renamed = presence(RECIPIENT, { ...RECIPIENT_SESSION, name: "renamed" });
		assert.deepEqual(await a.renew(lease, renamed), { status: "renewed" });
		assert.deepEqual(expectStatus(await a.read(lease.key), "found").lease.subject, renamed);
	});

	check("resets the lease age when the holder renews or re-acquires it", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		const lease = await acquire(a, "broker-a");
		const assertResetsAge = async (reset: () => Promise<void>) => {
			await sleep(RENEWAL_GAP_MS);
			const before = expectStatus(await b.read(lease.key), "found").lease.ageMs;
			assert.ok(
				before >= RENEWAL_GAP_MS - CLOCK_TOLERANCE_MS,
				`age ${before} ms did not grow over ${RENEWAL_GAP_MS} ms`,
			);
			const resetAt = Date.now();
			await reset();
			const after = expectStatus(await b.read(lease.key), "found").lease.ageMs;
			const sinceReset = Date.now() - resetAt + CLOCK_TOLERANCE_MS;
			assert.ok(after <= sinceReset, `age ${after} ms exceeds the ${sinceReset} ms since the reset`);
		};
		await assertResetsAge(async () => assert.deepEqual(await a.renew(lease), { status: "renewed" }));
		await assertResetsAge(async () =>
			assert.deepEqual(await a.acquire(presence(RECIPIENT), "broker-a", LIVE_MS), { status: "acquired", lease }),
		);
	});

	check("keeps fencing tokens increasing across release and refuses a non-holder", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		const first = await acquire(a, "broker-a");
		const current = { status: "stale", currentFencingToken: first.fencingToken };
		assert.deepEqual(await b.release({ ...first, holderId: "broker-b" }), current);
		assert.deepEqual(await b.renew({ ...first, fencingToken: first.fencingToken + 1 }), current);
		assert.deepEqual(await a.release(first), { status: "released" });
		assert.deepEqual(await a.read(first.key), { status: "missing" });
		assert.deepEqual(await a.release(first), { status: "stale" });
		assert.deepEqual(await a.renew(first), { status: "stale" });
		const next = await acquire(b, "broker-b");
		assert.ok(next.fencingToken > first.fencingToken);
		assert.deepEqual(await a.renew(first), { status: "stale", currentFencingToken: next.fencingToken });
	});

	check("reads detached lease state with the subject verbatim", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		const subject = presence(RECIPIENT, { ...RECIPIENT_SESSION, name: "  spaced\tname ünï 🚀 " });
		const snapshot = structuredClone(subject);
		const lease = expectStatus(await a.acquire(subject, "broker-a", LIVE_MS), "acquired").lease;
		Reflect.set(subject.session, "name", "mutated after acquire");
		const found = expectStatus(await b.read(lease.key), "found").lease;
		assert.ok(Number.isSafeInteger(found.ageMs) && found.ageMs >= 0);
		assert.deepEqual(found, { ...lease, subject: snapshot, ageMs: found.ageMs });
		Reflect.set(found, "holderId", "mutated after read");
		Reflect.set(found.subject, "kind", "broker");
		const again = expectStatus(await b.read(lease.key), "found").lease;
		assert.deepEqual(again, { ...lease, subject: snapshot, ageMs: again.ageMs });
	});

	check("lists live leases of one kind in first-acquisition order", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		const second = await acquire(a, "broker-a", presence("target-2"));
		await acquire(b, "broker-b", presence("target-1"));
		await acquire(a, "broker-a", membership("broker-a"));
		const targets = async () =>
			(await b.listLive("presence", LIVE_MS)).map((lease) =>
				lease.subject.kind === "presence" ? lease.subject.targetIdentity : lease.subject.brokerId,
			);
		assert.deepEqual(await targets(), ["target-2", "target-1"]);
		assert.deepEqual(
			(await b.listLive("broker", LIVE_MS)).map((lease) => lease.subject),
			[membership("broker-a")],
		);
		assert.deepEqual(await b.listLive("presence", EXPIRED_MS), []);
		await a.release(second);
		assert.deepEqual(await targets(), ["target-1"]);
		await acquire(a, "broker-c", presence("target-2"));
		assert.deepEqual(await targets(), ["target-2", "target-1"]);
	});

	check("rejects empty identifiers and a renewal subject for another key", async (connect) => {
		const a = await connect();
		const empty = (reason: string) => ({ status: "invalid", reason });
		assert.deepEqual(await a.acquire(presence(""), "broker-a", LIVE_MS), empty("empty-target-identity"));
		assert.deepEqual(await a.acquire(membership(""), "broker-a", LIVE_MS), empty("empty-broker-id"));
		assert.deepEqual(await a.acquire(presence(RECIPIENT), "", LIVE_MS), empty("empty-holder-id"));
		assert.deepEqual(await a.read({ kind: "presence", targetIdentity: "" }), empty("empty-target-identity"));
		assert.deepEqual(await a.read({ kind: "broker", brokerId: "" }), empty("empty-broker-id"));
		assert.deepEqual(await a.listLive("presence", LIVE_MS), []);
		const lease = await acquire(a, "broker-a");
		assert.deepEqual(await a.renew(lease, presence(OTHER_RECIPIENT)), empty("subject-key-mismatch"));
		assert.deepEqual(await a.renew({ ...lease, holderId: "" }), empty("empty-holder-id"));
		assert.deepEqual(
			await a.release({ ...lease, key: { kind: "presence", targetIdentity: "" } }),
			empty("empty-target-identity"),
		);
		assert.deepEqual(await a.read({ kind: "presence", targetIdentity: "never acquired" }), { status: "missing" });
		assert.deepEqual(await a.renew(lease), { status: "renewed" });
	});

	check("renews with a structurally equal lease key whose properties come in another order", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		const presenceLease = await acquire(a, "broker-a");
		const reorderedPresence = { ...presenceLease, key: { targetIdentity: RECIPIENT, kind: "presence" as const } };
		assert.deepEqual(await b.renew(reorderedPresence, presence(RECIPIENT)), { status: "renewed" });
		const memberLease = await acquire(a, "broker-a", membership("broker-a"));
		const reorderedMember = { ...memberLease, key: { brokerId: "broker-a", kind: "broker" as const } };
		assert.deepEqual(await b.renew(reorderedMember, membership("broker-a")), { status: "renewed" });
	});
}

export function registerOutboxStoreConformance(
	runner: MultiNodeConformanceRunner,
	name: string,
	open: OpenSharedStoreFixture<OutboxStore>,
): void {
	const check = withShared(runner, `${name} outbox`, open);
	const insert = async (
		store: OutboxStore,
		frame: IntercomDeliveryFrame,
		overrides: Partial<OutboxEnqueueRequest> = {},
	) => expectStatus(await store.enqueue(request(frame, overrides)), "inserted").row;
	const claimAll = async (
		store: OutboxStore,
		claimantId: string,
		staleAfterMs = LIVE_MS,
		targetIdentity = RECIPIENT,
	) => expectStatus(await store.claim({ claimantId, targetIdentity, staleAfterMs }), "claimed").rows;
	const ids = (rows: ReadonlyArray<ClaimedOutboxRow | OutboxRow>) =>
		rows.map((entry) => ("claim" in entry ? entry.row.messageId : entry.messageId));

	check("writes one row per message id and reports duplicates and conflicts", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		const frame = frameFor("m1", "hello");
		const row = await insert(a, frame);
		assertPositiveSafeInteger(row.sequence, "sequence");
		assert.deepEqual(row, {
			sequence: row.sequence,
			messageId: "m1",
			targetIdentity: RECIPIENT,
			originBrokerId: "broker-a",
			digest: "digest:m1",
			frame,
			state: "queued",
			claimAttempts: 0,
		});
		assert.deepEqual(await b.enqueue(request(frame)), { status: "duplicate", row });
		assert.deepEqual(await b.enqueue(request(frame, { originBrokerId: "broker-b" })), { status: "duplicate", row });
		assert.deepEqual(await b.enqueue(request(frame, { targetIdentity: OTHER_RECIPIENT })), {
			status: "duplicate",
			row,
		});
		assert.deepEqual(await b.enqueue(request(frame, { digest: "other digest" })), {
			status: "conflict",
			messageId: "m1",
		});
		assert.deepEqual(await b.enqueue(request(frame, { targetIdentity: OTHER_RECIPIENT, digest: "other digest" })), {
			status: "conflict",
			messageId: "m1",
		});
		assert.deepEqual(expectStatus(await b.listUndelivered(OTHER_RECIPIENT), "listed").rows, []);
		const racing = await Promise.all([
			a.enqueue(request(frameFor("m2", "race"))),
			b.enqueue(request(frameFor("m2", "race"))),
		]);
		assert.deepEqual(racing.map((result) => result.status).sort(), ["duplicate", "inserted"]);
		assert.deepEqual(ids(expectStatus(await b.listUndelivered(RECIPIENT), "listed").rows), ["m1", "m2"]);
	});

	check("stores and returns the delivery frame verbatim and detached", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		const frame = richFrame("rich");
		const snapshot = structuredClone(frame);
		await insert(a, frame);
		Reflect.set(frame.message.content, "text", "mutated after enqueue");
		const found = expectStatus(await b.read("rich"), "found").row;
		assert.deepEqual(found.frame, snapshot);
		Reflect.set(found.frame.message.content, "text", "mutated after read");
		const claimed = await claimAll(b, "broker-b");
		assert.deepEqual(
			claimed.map((entry) => entry.row.frame),
			[snapshot],
		);
	});

	check("claims a recipient's rows in insertion order and keeps recipients apart", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		const first = await insert(a, frameFor("z-9", "one"));
		await insert(b, frameFor("x1", "other"), { targetIdentity: OTHER_RECIPIENT });
		await insert(a, frameFor("a-1", "two"));
		await insert(b, frameFor("m-5", "three"), { originBrokerId: "broker-c" });
		const listed = expectStatus(await a.listUndelivered(RECIPIENT), "listed").rows;
		assert.deepEqual(ids(listed), ["z-9", "a-1", "m-5"]);
		assert.ok(listed.every((row) => row.state === "queued" && row.claimAttempts === 0));
		const claimed = await claimAll(b, "broker-b");
		assert.deepEqual(ids(claimed), ["z-9", "a-1", "m-5"]);
		assert.ok(claimed.every((entry, index) => index === 0 || entry.row.sequence > claimed[index - 1]!.row.sequence));
		assert.ok(claimed[0]!.row.sequence >= first.sequence);
		for (const entry of claimed) {
			assert.equal(entry.row.state, "claimed");
			assert.equal(entry.row.claimAttempts, 1);
			assert.equal(entry.claim.attempt, 1);
			assert.equal(entry.claim.claimantId, "broker-b");
			assert.equal(entry.claim.messageId, entry.row.messageId);
			assert.ok(entry.claim.token.length > 0);
		}
		assert.equal(new Set(claimed.map((entry) => entry.claim.token)).size, 3);
		assert.deepEqual(ids(expectStatus(await a.listUndelivered(OTHER_RECIPIENT), "listed").rows), ["x1"]);
		const inFlight = expectStatus(await a.listUndelivered(RECIPIENT), "listed").rows;
		assert.deepEqual(ids(inFlight), ["z-9", "a-1", "m-5"]);
		assert.ok(inFlight.every((row) => row.state === "claimed" && row.claimAttempts === 1));
	});

	check("keeps one claimant per recipient while its claims are live", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		await insert(a, frameFor("m1", "one"));
		assert.deepEqual(ids(await claimAll(a, "broker-a")), ["m1"]);
		assert.deepEqual(await b.claim({ claimantId: "broker-b", targetIdentity: RECIPIENT, staleAfterMs: LIVE_MS }), {
			status: "held",
			claimantId: "broker-a",
		});
		assert.deepEqual(await claimAll(a, "broker-a"), []);
		await insert(b, frameFor("m2", "two"));
		assert.deepEqual(ids(await claimAll(a, "broker-a")), ["m2"]);
		await insert(a, frameFor("race", "race"), { targetIdentity: OTHER_RECIPIENT });
		const racing = await Promise.all([
			a.claim({ claimantId: "broker-a", targetIdentity: OTHER_RECIPIENT, staleAfterMs: LIVE_MS }),
			b.claim({ claimantId: "broker-b", targetIdentity: OTHER_RECIPIENT, staleAfterMs: LIVE_MS }),
		]);
		assert.deepEqual(racing.map((result) => result.status).sort(), ["claimed", "held"]);
		const winner = expectStatus(racing.find((result) => result.status === "claimed")!, "claimed");
		assert.deepEqual(ids(winner.rows), ["race"]);
	});

	check("lets another broker claim a different recipient while one recipient's claim is live", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		await insert(a, frameFor("m1", "one"));
		await insert(a, frameFor("m2", "two"), { targetIdentity: OTHER_RECIPIENT });
		assert.deepEqual(ids(await claimAll(a, "broker-a")), ["m1"]);
		const other = await claimAll(b, "broker-b", LIVE_MS, OTHER_RECIPIENT);
		assert.deepEqual(ids(other), ["m2"]);
		assert.equal(other[0]!.claim.claimantId, "broker-b");
		assert.deepEqual(
			await a.claim({ claimantId: "broker-a", targetIdentity: OTHER_RECIPIENT, staleAfterMs: LIVE_MS }),
			{ status: "held", claimantId: "broker-b" },
		);
		assert.deepEqual(await b.claim({ claimantId: "broker-b", targetIdentity: RECIPIENT, staleAfterMs: LIVE_MS }), {
			status: "held",
			claimantId: "broker-a",
		});
	});

	check("resets a claim's age when its claimant renews it", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		await insert(a, frameFor("m1", "one"));
		const [claimed] = await claimAll(a, "broker-a");
		assert.ok(claimed);
		await sleep(RENEWAL_GAP_MS);
		const renewedAt = Date.now();
		assert.deepEqual(await a.renewClaim(claimed.claim), { status: "renewed" });
		const window = Date.now() - renewedAt + RENEWAL_GAP_MS / 2;
		assert.deepEqual(await b.claim({ claimantId: "broker-b", targetIdentity: RECIPIENT, staleAfterMs: window }), {
			status: "held",
			claimantId: "broker-a",
		});
		assert.equal(expectStatus(await a.markDelivered(claimed.claim), "delivered").row.messageId, "m1");
	});

	check("redelivers after claim expiry with a new token and fences the stale claimant", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		await insert(a, frameFor("m1", "one"));
		const [stale] = await claimAll(a, "broker-a");
		const [fresh] = await claimAll(b, "broker-b", EXPIRED_MS);
		assert.ok(stale && fresh);
		assert.notEqual(fresh.claim.token, stale.claim.token);
		assert.equal(fresh.claim.attempt, 2);
		assert.equal(fresh.row.claimAttempts, 2);
		assert.deepEqual(await a.markDelivered(stale.claim), { status: "stale" });
		assert.deepEqual(await a.markFailed(stale.claim, "late"), { status: "stale" });
		assert.deepEqual(await a.renewClaim(stale.claim), { status: "stale" });
		assert.deepEqual(await a.releaseClaim(stale.claim), { status: "stale" });
		assert.deepEqual(await a.renewClaim({ ...fresh.claim, claimantId: "broker-a" }), { status: "stale" });
		assert.equal(expectStatus(await a.read("m1"), "found").row.state, "claimed");
		const delivered = expectStatus(await b.markDelivered(fresh.claim), "delivered").row;
		assert.deepEqual(delivered, { ...fresh.row, state: "delivered" });
	});

	check("fences a claimant's own superseded token after it re-claims an expired row", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		await insert(a, frameFor("m1", "one"));
		const [old] = await claimAll(a, "broker-a");
		const [renewed] = await claimAll(a, "broker-a", EXPIRED_MS);
		assert.ok(old && renewed);
		assert.notEqual(renewed.claim.token, old.claim.token);
		assert.equal(renewed.claim.attempt, 2);
		assert.equal(renewed.claim.claimantId, "broker-a");
		assert.deepEqual(await a.markDelivered(old.claim), { status: "stale" });
		assert.deepEqual(await a.markFailed(old.claim, "late"), { status: "stale" });
		assert.deepEqual(await a.renewClaim(old.claim), { status: "stale" });
		assert.deepEqual(await a.releaseClaim(old.claim), { status: "stale" });
		assert.equal(expectStatus(await b.read("m1"), "found").row.state, "claimed");
		assert.deepEqual(await a.renewClaim(renewed.claim), { status: "renewed" });
		const delivered = expectStatus(await a.markDelivered(renewed.claim), "delivered").row;
		assert.deepEqual(delivered, { ...renewed.row, state: "delivered" });
	});

	check("reports delivered only after the recipient's acknowledgement, then settles later writes", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		await insert(a, frameFor("m1", "one"));
		const [claimed] = await claimAll(b, "broker-b");
		assert.ok(claimed);
		assert.equal(expectStatus(await a.read("m1"), "found").row.state, "claimed");
		assert.deepEqual(await b.renewClaim(claimed.claim), { status: "renewed" });
		assert.equal(expectStatus(await a.read("m1"), "found").row.state, "claimed");
		const delivered = expectStatus(await b.markDelivered(claimed.claim), "delivered").row;
		assert.equal(delivered.state, "delivered");
		assert.deepEqual(await a.read("m1"), { status: "found", row: delivered });
		const settled = { status: "settled", row: delivered };
		assert.deepEqual(await b.markDelivered(claimed.claim), settled);
		assert.deepEqual(await b.renewClaim(claimed.claim), settled);
		assert.deepEqual(await b.releaseClaim(claimed.claim), settled);
		assert.deepEqual(await a.markFailed({ ...claimed.claim, token: "forged" }, "late"), settled);
		assert.deepEqual(await claimAll(a, "broker-a", EXPIRED_MS), []);
		assert.deepEqual(expectStatus(await a.listUndelivered(RECIPIENT), "listed").rows, []);
		assert.deepEqual(await a.enqueue(request(frameFor("m1", "one"))), { status: "duplicate", row: delivered });
	});

	check("returns a released claim to the queue and redelivers it in order", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		await insert(a, frameFor("z-first", "one"));
		await insert(a, frameFor("a-second", "two"));
		const [first, second] = await claimAll(a, "broker-a");
		assert.ok(first && second);
		assert.equal(first.row.messageId, "z-first");
		assert.deepEqual(await a.releaseClaim(first.claim), { status: "released" });
		assert.equal(expectStatus(await b.read("z-first"), "found").row.state, "queued");
		assert.deepEqual(await b.markDelivered(first.claim), { status: "stale" });
		assert.deepEqual(await b.claim({ claimantId: "broker-b", targetIdentity: RECIPIENT, staleAfterMs: LIVE_MS }), {
			status: "held",
			claimantId: "broker-a",
		});
		const [again] = await claimAll(a, "broker-a");
		assert.ok(again);
		assert.equal(again.row.messageId, "z-first");
		assert.equal(again.claim.attempt, 2);
		assert.deepEqual(ids(await claimAll(b, "broker-b", EXPIRED_MS)), ["z-first", "a-second"]);
	});

	check("settles a refused row as failed with its reason verbatim", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		await insert(a, frameFor("m1", "one"));
		const [claimed] = await claimAll(b, "broker-b");
		assert.ok(claimed);
		const reason = "  refused: recipient left group `team` \n";
		const failed = expectStatus(await b.markFailed(claimed.claim, reason), "failed").row;
		assert.deepEqual(failed, { ...claimed.row, state: "failed", failureReason: reason });
		assert.deepEqual(await a.read("m1"), { status: "found", row: failed });
		assert.deepEqual(await b.markDelivered(claimed.claim), { status: "settled", row: failed });
		assert.deepEqual(await claimAll(a, "broker-a", EXPIRED_MS), []);
	});

	check("rejects empty identifiers and reports unknown rows explicitly", async (connect) => {
		const a = await connect();
		const empty = (reason: string) => ({ status: "invalid", reason });
		const frame = frameFor("m1", "one");
		assert.deepEqual(await a.enqueue(request(frame, { targetIdentity: "" })), empty("empty-target-identity"));
		assert.deepEqual(await a.enqueue(request(frame, { originBrokerId: "" })), empty("empty-broker-id"));
		assert.deepEqual(await a.enqueue(request(frameFor("", "no id"))), empty("empty-message-id"));
		assert.deepEqual(
			await a.claim({ claimantId: "", targetIdentity: RECIPIENT, staleAfterMs: LIVE_MS }),
			empty("empty-claimant-id"),
		);
		assert.deepEqual(
			await a.claim({ claimantId: "broker-a", targetIdentity: "", staleAfterMs: LIVE_MS }),
			empty("empty-target-identity"),
		);
		assert.deepEqual(await a.read(""), empty("empty-message-id"));
		assert.deepEqual(await a.listUndelivered(""), empty("empty-target-identity"));
		assert.deepEqual(await a.read("unknown"), { status: "missing" });
		assert.deepEqual(await claimAll(a, "broker-a"), []);
		const unknown: OutboxClaim = { messageId: "unknown", claimantId: "broker-a", token: "token", attempt: 1 };
		assert.deepEqual(await a.markDelivered(unknown), { status: "unknown" });
		assert.deepEqual(await a.markFailed(unknown, "reason"), { status: "unknown" });
		assert.deepEqual(await a.renewClaim(unknown), { status: "unknown" });
		assert.deepEqual(await a.releaseClaim(unknown), { status: "unknown" });
		assert.deepEqual(await a.markDelivered({ ...unknown, messageId: "" }), empty("empty-message-id"));
		assert.deepEqual(await a.markDelivered({ ...unknown, claimantId: "" }), empty("empty-claimant-id"));
		assert.deepEqual(await a.listUndelivered(RECIPIENT), { status: "listed", rows: [] });
	});

	check("prunes only settled rows, after which a message id is new again", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		const queued = await insert(a, frameFor("m3", "three"), { targetIdentity: OTHER_RECIPIENT });
		await insert(a, frameFor("in-flight", "in flight"), { targetIdentity: THIRD_RECIPIENT });
		const [inFlight] = await claimAll(a, "broker-a", LIVE_MS, THIRD_RECIPIENT);
		assert.ok(inFlight);
		await insert(a, frameFor("m1", "one"));
		await insert(a, frameFor("m2", "two"));
		const [first, second] = await claimAll(b, "broker-b");
		assert.ok(first && second);
		await b.markDelivered(first.claim);
		await b.markFailed(second.claim, "refused");
		assert.ok(second.row.sequence > queued.sequence);
		assert.equal(await a.prune(LIVE_MS), 0);
		assert.equal(await a.prune(EXPIRED_MS), 2);
		assert.deepEqual(await b.read("m1"), { status: "missing" });
		assert.deepEqual(await b.read("m2"), { status: "missing" });
		assert.equal(expectStatus(await b.read("m3"), "found").row.state, "queued");
		assert.deepEqual(await b.read("in-flight"), { status: "found", row: inFlight.row });
		assert.equal(expectStatus(await a.markDelivered(inFlight.claim), "delivered").row.messageId, "in-flight");
		const reinserted = await insert(b, frameFor("m1", "one"));
		assert.ok(
			reinserted.sequence > second.row.sequence,
			`sequence ${reinserted.sequence} reused after pruning the newest row ${second.row.sequence}`,
		);
	});
}

export function registerHeldSendStoreConformance(
	runner: MultiNodeConformanceRunner,
	name: string,
	open: OpenSharedStoreFixture<HeldSendStore>,
): void {
	const check = withShared(runner, `${name} held sends`, open);
	const held = (messageId: string, reservationKey = "capability-1", text = "held"): HeldSend => ({
		reservationKey,
		originBrokerId: "broker-a",
		senderSessionId: "sender-session",
		request: {
			type: "send",
			to: " worker ",
			awaitRestoringRecipient: true,
			attemptId: `attempt-${messageId}`,
			message: { id: messageId, timestamp: 1_700_000_003_000, content: { text } },
		},
	});

	check("holds sends per reservation in insertion order and hands each over once", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		const first = held("z-held", "capability-1", "  first \u0000 ünï ");
		const snapshot = structuredClone(first);
		assert.deepEqual(await a.hold(first), { status: "held" });
		Reflect.set(first.request, "to", "mutated after hold");
		assert.deepEqual(await b.hold(held("m-held", "capability-2")), { status: "held" });
		assert.deepEqual(await a.hold(held("a-held")), { status: "held" });
		assert.deepEqual(await b.hold(held("z-held", "capability-2")), { status: "duplicate" });
		const listed = expectStatus(await b.list("capability-1"), "listed").sends;
		assert.deepEqual(listed, [snapshot, held("a-held")]);
		Reflect.set(listed[0]!.request, "to", "mutated after list");
		const racing = await Promise.all([a.take("capability-1"), b.take("capability-1")]);
		const taken = racing.flatMap((result) => expectStatus(result, "taken").sends);
		assert.deepEqual(taken, [snapshot, held("a-held")]);
		assert.deepEqual(await a.take("capability-1"), { status: "taken", sends: [] });
		assert.deepEqual(await a.list("capability-2"), { status: "listed", sends: [held("m-held", "capability-2")] });
		assert.deepEqual(await a.hold(held("b-held", "capability-2")), { status: "held" });
		assert.deepEqual(await a.drop("m-held"), { status: "dropped" });
		assert.deepEqual(await b.drop("m-held"), { status: "missing" });
		assert.deepEqual(await b.list("capability-2"), { status: "listed", sends: [held("b-held", "capability-2")] });
		assert.deepEqual(await b.hold(held("z-held")), { status: "held" });
	});

	check("rejects empty identifiers", async (connect) => {
		const a = await connect();
		const empty = (reason: string) => ({ status: "invalid", reason });
		assert.deepEqual(await a.hold({ ...held("h1"), reservationKey: "" }), empty("empty-reservation-key"));
		assert.deepEqual(await a.hold({ ...held("h1"), originBrokerId: "" }), empty("empty-broker-id"));
		assert.deepEqual(await a.hold({ ...held("h1"), senderSessionId: "" }), empty("empty-session-id"));
		assert.deepEqual(await a.hold(held("")), empty("empty-message-id"));
		assert.deepEqual(await a.list(""), empty("empty-reservation-key"));
		assert.deepEqual(await a.take(""), empty("empty-reservation-key"));
		assert.deepEqual(await a.drop(""), empty("empty-message-id"));
		assert.deepEqual(await a.list("capability-1"), { status: "listed", sends: [] });
	});
}

const RESERVATION_KEY = reservationKeyFor("capability-worker");
const TEAMMATE = { sessionId: "teammate-session", groups: ["Review Crew", "team"] };
const OUTSIDER = { sessionId: "outsider-session", groups: ["other"] };

function reservationRequest(overrides: Partial<RestoringReservationRequest> = {}): RestoringReservationRequest {
	return {
		reservationKey: RESERVATION_KEY,
		ownerSessionId: "supervisor-session",
		ownerBrokerId: "broker-b",
		childName: " Worker ",
		childTarget: "worker",
		aliases: ["atomic-session-7", "intercom-old-7"],
		group: "team",
		dormant: false,
		...overrides,
	};
}

export function registerRestoringReservationStoreConformance(
	runner: MultiNodeConformanceRunner,
	name: string,
	open: OpenSharedStoreFixture<RestoringReservationStore>,
): void {
	const check = withShared(runner, `${name} restoring reservations`, open);
	const reserve = async (store: RestoringReservationStore, overrides: Partial<RestoringReservationRequest> = {}) =>
		expectStatus(await store.reserve(reservationRequest(overrides)), "reserved");
	const expected = (fencingToken: number, overrides: Partial<RestoringReservation> = {}): RestoringReservation => ({
		reservationKey: RESERVATION_KEY,
		ownerSessionId: "supervisor-session",
		ownerBrokerId: "broker-b",
		childName: " Worker ",
		childTarget: "worker",
		targets: ["worker", "atomic-session-7", "intercom-old-7"],
		group: "team",
		dormant: false,
		fencingToken,
		...overrides,
	});

	check(
		"finds a reservation by every target for its owner and its group only, as detached copies",
		async (connect) => {
			const [a, b] = [await connect(), await connect()];
			const aliases = ["atomic-session-7", "intercom-old-7"];
			const reserved = await reserve(b, { aliases });
			aliases.push("late-alias");
			aliases[0] = "mutated-alias";
			assertPositiveSafeInteger(reserved.lease.fencingToken, "fencingToken");
			assert.deepEqual(reserved, {
				status: "reserved",
				lease: {
					reservationKey: RESERVATION_KEY,
					ownerSessionId: "supervisor-session",
					fencingToken: reserved.lease.fencingToken,
				},
				superseded: [],
			});
			const reservation = expected(reserved.lease.fencingToken);
			for (const target of reservation.targets) {
				assert.deepEqual(await a.lookup(target, TEAMMATE, LIVE_MS), { status: "reserved", reservation });
			}
			assert.deepEqual(await a.lookup("worker", { sessionId: "supervisor-session", groups: [] }, LIVE_MS), {
				status: "reserved",
				reservation,
			});
			assert.deepEqual(await a.lookup("worker", OUTSIDER, LIVE_MS), { status: "none" });
			for (const target of [" Worker ", "Worker", "late-alias", "mutated-alias", "unknown"]) {
				assert.deepEqual(await a.lookup(target, TEAMMATE, LIVE_MS), { status: "none" });
			}
			const found = expectStatus(await a.lookup("worker", TEAMMATE, LIVE_MS), "reserved").reservation;
			found.targets.push("mutated-target");
			Reflect.set(found, "group", "other");
			const read = expectStatus(await b.read(RESERVATION_KEY), "active");
			assert.deepEqual(read.reservation, reservation);
			assert.ok(Number.isSafeInteger(read.ageMs) && read.ageMs >= 0, `ageMs ${read.ageMs}`);
			read.reservation.targets.length = 0;
			assert.deepEqual(await a.lookup("intercom-old-7", TEAMMATE, LIVE_MS), { status: "reserved", reservation });
		},
	);

	check("refuses as gone while marked gone and ends on release, with an optional refusal", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		const { lease } = await reserve(b);
		const gone = "  Subagent `Worker` is gone:\t ünï \u0000 ";
		assert.deepEqual(await b.release(lease, { gone }), { status: "gone" });
		assert.deepEqual(await a.lookup("atomic-session-7", TEAMMATE, LIVE_MS), {
			status: "gone",
			reservation: expected(lease.fencingToken, { gone }),
		});
		assert.deepEqual(await b.renew(lease), { status: "renewed" });
		assert.deepEqual(await b.release(lease), { status: "released" });
		assert.deepEqual(await a.read(RESERVATION_KEY), { status: "ended", end: { outcome: "released" } });
		assert.deepEqual(await a.lookup("worker", TEAMMATE, LIVE_MS), { status: "none" });
		assert.deepEqual(await b.renew(lease), { status: "stale" });
		assert.deepEqual(await b.release(lease), { status: "stale" });
		const refusingKey = reservationKeyFor("capability-refusing");
		const refusing = await reserve(b, { reservationKey: refusingKey });
		const refusal = " restored on another host \n";
		assert.deepEqual(await b.release(refusing.lease, { refusal }), { status: "released" });
		assert.deepEqual(await a.read(refusingKey), { status: "ended", end: { outcome: "released", refusal } });
		const bothKey = reservationKeyFor("capability-both");
		const both = await reserve(b, { reservationKey: bothKey });
		assert.deepEqual(await b.release(both.lease, { gone: "gone wins", refusal }), { status: "gone" });
		assert.equal(expectStatus(await a.lookup("worker", TEAMMATE, LIVE_MS), "gone").reservation.gone, "gone wins");
	});

	check("stops holding new sends once its owner stops renewing, until renewed", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		const { lease } = await reserve(b);
		assert.deepEqual(await a.lookup("worker", TEAMMATE, EXPIRED_MS), { status: "none" });
		assert.equal((await a.lookup("worker", TEAMMATE, LIVE_MS)).status, "reserved");
		await sleep(RENEWAL_GAP_MS);
		const before = expectStatus(await a.read(RESERVATION_KEY), "active").ageMs;
		assert.ok(before >= RENEWAL_GAP_MS - CLOCK_TOLERANCE_MS, `age ${before} before renewing`);
		const renewStarted = Date.now();
		assert.deepEqual(await b.renew(lease), { status: "renewed" });
		const after = expectStatus(await a.read(RESERVATION_KEY), "active").ageMs;
		assert.ok(after <= Date.now() - renewStarted + CLOCK_TOLERANCE_MS, `age ${after} after renewing`);
		const window = Date.now() - renewStarted + RENEWAL_GAP_MS / 2;
		assert.equal((await a.lookup("worker", TEAMMATE, window)).status, "reserved");
	});

	check("fences renew and release to the current owner, and lets the capability holder take over", async (connect) => {
		const [a, b, c] = [await connect(), await connect(), await connect()];
		const first = await reserve(b);
		const again = await reserve(b, { aliases: ["extra-alias"] });
		assert.deepEqual(again, first);
		const current = { status: "stale", currentFencingToken: first.lease.fencingToken };
		const intruder = { ...first.lease, ownerSessionId: "intruder-session" };
		const superseded = { ...first.lease, fencingToken: first.lease.fencingToken + 1_000 };
		for (const lease of [intruder, superseded]) {
			assert.deepEqual(await a.renew(lease), current);
			assert.deepEqual(await a.release(lease), current);
			assert.deepEqual(await a.release(lease, { gone: "not the owner" }), current);
		}
		const takeover = await reserve(c, {
			ownerSessionId: "restarted-supervisor",
			ownerBrokerId: "broker-c",
			aliases: [],
		});
		assert.deepEqual(takeover.superseded, []);
		assert.equal(takeover.lease.ownerSessionId, "restarted-supervisor");
		assert.ok(takeover.lease.fencingToken > first.lease.fencingToken);
		const fenced = { status: "stale", currentFencingToken: takeover.lease.fencingToken };
		assert.deepEqual(await b.renew(first.lease), fenced);
		assert.deepEqual(await b.release(first.lease), fenced);
		assert.deepEqual(expectStatus(await a.read(RESERVATION_KEY), "active").reservation, {
			...expected(takeover.lease.fencingToken),
			ownerSessionId: "restarted-supervisor",
			ownerBrokerId: "broker-c",
			targets: ["worker", "atomic-session-7", "intercom-old-7", "extra-alias"],
		});
		assert.deepEqual(await c.renew(takeover.lease), { status: "renewed" });
		assert.deepEqual(await c.release(takeover.lease), { status: "released" });
		assert.deepEqual(await c.renew(takeover.lease), { status: "stale" });
		const reopened = await reserve(b);
		assert.ok(reopened.lease.fencingToken > takeover.lease.fencingToken);
	});

	check("replaces its owner's earlier reservation of the same child, gone marker included", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		const earlierKey = reservationKeyFor("capability-earlier");
		const earlier = await reserve(b, { reservationKey: earlierKey });
		assert.deepEqual(await b.release(earlier.lease, { gone: "gone before the restart" }), { status: "gone" });
		const fresh = await reserve(b, { aliases: ["fresh-alias"] });
		assert.deepEqual(fresh.superseded, [earlierKey]);
		assert.deepEqual(await a.read(earlierKey), {
			status: "ended",
			end: { outcome: "superseded", by: RESERVATION_KEY },
		});
		assert.deepEqual(await a.lookup("worker", TEAMMATE, LIVE_MS), {
			status: "reserved",
			reservation: expected(fresh.lease.fencingToken, {
				targets: ["worker", "atomic-session-7", "intercom-old-7", "fresh-alias"],
			}),
		});
		assert.deepEqual(await b.renew(earlier.lease), { status: "stale" });
		const peerKey = reservationKeyFor("capability-peer");
		const peer = await reserve(a, { reservationKey: peerKey, ownerSessionId: "peer-supervisor", aliases: [] });
		assert.deepEqual(peer.superseded, []);
		assert.equal((await a.read(RESERVATION_KEY)).status, "active");
	});

	check(
		"consumes a registered child's reservation and its dormant reservations in the child's groups",
		async (connect) => {
			const [a, b, c] = [await connect(), await connect(), await connect()];
			const dormantKey = reservationKeyFor("capability-dormant");
			const otherGroupKey = reservationKeyFor("capability-other-group");
			const lateKey = reservationKeyFor("capability-late");
			const goneKey = reservationKeyFor("capability-gone");
			const launcher = await reserve(a, {
				reservationKey: dormantKey,
				ownerSessionId: "launcher-session",
				ownerBrokerId: "broker-a",
				aliases: ["atomic-session-7"],
				dormant: true,
			});
			await reserve(a, {
				reservationKey: otherGroupKey,
				ownerSessionId: "other-launcher",
				aliases: [],
				group: "other",
				dormant: true,
			});
			const restoring = await reserve(b, { aliases: ["intercom-old-7"] });
			assert.deepEqual(restoring.superseded, [dormantKey]);
			assert.deepEqual(await c.read(dormantKey), {
				status: "ended",
				end: { outcome: "superseded", by: RESERVATION_KEY },
			});
			assert.deepEqual(await c.lookup("atomic-session-7", TEAMMATE, LIVE_MS), {
				status: "reserved",
				reservation: expected(restoring.lease.fencingToken),
			});
			assert.deepEqual(await a.renew(launcher.lease), { status: "stale" });
			const peerKey = reservationKeyFor("capability-peer-restorer");
			const peer = await reserve(b, { reservationKey: peerKey, ownerSessionId: "peer-supervisor", aliases: [] });
			assert.deepEqual(peer.superseded, []);
			const late = await reserve(a, {
				reservationKey: lateKey,
				ownerSessionId: "late-launcher",
				aliases: [],
				dormant: true,
			});
			assert.deepEqual(late.superseded, []);
			assert.deepEqual(
				await c.consume(RESERVATION_KEY, { childTarget: "worker", groups: ["team", "Review Crew"] }),
				{
					status: "consumed",
					reservationKeys: [RESERVATION_KEY, lateKey],
				},
			);
			for (const key of [RESERVATION_KEY, lateKey]) {
				assert.deepEqual(await a.read(key), { status: "ended", end: { outcome: "consumed" } });
			}
			assert.equal(
				expectStatus(await a.lookup("worker", TEAMMATE, LIVE_MS), "reserved").reservation.reservationKey,
				peerKey,
			);
			const otherGroup = expectStatus(
				await a.lookup("worker", { sessionId: "other-launcher", groups: [] }, LIVE_MS),
				"reserved",
			);
			assert.equal(otherGroup.reservation.reservationKey, otherGroupKey);
			assert.deepEqual(await b.consume(RESERVATION_KEY, { childTarget: "worker", groups: ["team"] }), {
				status: "consumed",
				reservationKeys: [],
			});
			const gone = await reserve(b, { reservationKey: goneKey, ownerSessionId: "gone-owner", aliases: [] });
			assert.deepEqual(await b.release(gone.lease, { gone: "gone" }), { status: "gone" });
			assert.deepEqual(await c.consume(goneKey), { status: "consumed", reservationKeys: [] });
			assert.equal((await a.lookup("worker", { sessionId: "gone-owner", groups: [] }, LIVE_MS)).status, "gone");
		},
	);

	check("prunes ended and unrenewed reservations, and keeps later tokens greater", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		const first = await reserve(b);
		const endedKey = reservationKeyFor("capability-reviewer");
		const ended = await reserve(b, {
			reservationKey: endedKey,
			childName: "reviewer",
			childTarget: "reviewer",
			aliases: [],
		});
		assert.deepEqual(await b.release(ended.lease), { status: "released" });
		assert.equal(await a.prune(LIVE_MS), 0);
		assert.equal((await a.read(RESERVATION_KEY)).status, "active");
		assert.equal(await a.prune(EXPIRED_MS), 2);
		assert.deepEqual(await a.read(RESERVATION_KEY), { status: "missing" });
		assert.deepEqual(await a.read(endedKey), { status: "missing" });
		const reopened = await reserve(b);
		assert.ok(reopened.lease.fencingToken > first.lease.fencingToken);
		assert.deepEqual(await b.renew(first.lease), {
			status: "stale",
			currentFencingToken: reopened.lease.fencingToken,
		});
	});

	check("rejects empty identifiers", async (connect) => {
		const a = await connect();
		const empty = (reason: string) => ({ status: "invalid", reason });
		const lease = { reservationKey: RESERVATION_KEY, ownerSessionId: "supervisor-session", fencingToken: 1 };
		assert.deepEqual(await a.reserve(reservationRequest({ reservationKey: "" })), empty("empty-reservation-key"));
		assert.deepEqual(await a.reserve(reservationRequest({ ownerSessionId: "" })), empty("empty-session-id"));
		assert.deepEqual(await a.reserve(reservationRequest({ ownerBrokerId: "" })), empty("empty-broker-id"));
		assert.deepEqual(await a.reserve(reservationRequest({ childName: "" })), empty("empty-child-name"));
		assert.deepEqual(await a.reserve(reservationRequest({ childTarget: "" })), empty("empty-target"));
		assert.deepEqual(await a.reserve(reservationRequest({ aliases: ["alias", ""] })), empty("empty-target"));
		assert.deepEqual(await a.reserve(reservationRequest({ group: "" })), empty("empty-group"));
		assert.deepEqual(await a.lookup("", TEAMMATE, LIVE_MS), empty("empty-target"));
		assert.deepEqual(
			await a.lookup("worker", { sessionId: "", groups: ["team"] }, LIVE_MS),
			empty("empty-session-id"),
		);
		assert.deepEqual(await a.renew({ ...lease, reservationKey: "" }), empty("empty-reservation-key"));
		assert.deepEqual(await a.renew({ ...lease, ownerSessionId: "" }), empty("empty-session-id"));
		assert.deepEqual(await a.release({ ...lease, reservationKey: "" }), empty("empty-reservation-key"));
		assert.deepEqual(await a.release({ ...lease, ownerSessionId: "" }, { gone: "gone" }), empty("empty-session-id"));
		assert.deepEqual(await a.consume(""), empty("empty-reservation-key"));
		assert.deepEqual(await a.consume(RESERVATION_KEY, { childTarget: "", groups: ["team"] }), empty("empty-target"));
		assert.deepEqual(await a.read(""), empty("empty-reservation-key"));
		assert.deepEqual(await a.read(RESERVATION_KEY), { status: "missing" });
	});
}

export function registerPendingAskStoreConformance(
	runner: MultiNodeConformanceRunner,
	name: string,
	open: OpenSharedStoreFixture<PendingAskStore>,
): void {
	const check = withShared(runner, `${name} pending asks`, open);
	const ask = (senderSessionId: string, targetSessionId: string, messageId: string) => ({
		senderSessionId,
		targetSessionId,
		messageId,
	});
	const reply = (replySenderSessionId: string, replyTargetSessionId: string, replyTo: string) => ({
		replySenderSessionId,
		replyTargetSessionId,
		replyTo,
	});

	check("matches only the exact reverse route of a recorded ask and clears it once", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		assert.deepEqual(await a.record(ask("sender", "target", "q1")), { status: "recorded" });
		assert.deepEqual(await b.record(ask("sender", "target", "q1")), { status: "duplicate" });
		const second = ask("sender", "target", "q3");
		assert.deepEqual(await b.record(second), { status: "recorded" });
		Reflect.set(second, "messageId", "mutated after record");
		assert.deepEqual(await b.matchesReply(reply("target", "sender", "q1")), { status: "match" });
		assert.deepEqual(await b.matchesReply(reply("sender", "target", "q1")), { status: "no-match" });
		assert.deepEqual(await b.matchesReply(reply("target", "sender", "q2")), { status: "no-match" });
		assert.deepEqual(await b.matchesReply(reply("someone", "sender", "q1")), { status: "no-match" });
		assert.deepEqual(await b.matchesReply(reply("target", "someone", "q1")), { status: "no-match" });
		assert.deepEqual(await b.clearReply(reply("target", "sender", "q1")), { status: "cleared" });
		assert.deepEqual(await a.clearReply(reply("target", "sender", "q1")), { status: "no-match" });
		assert.deepEqual(await a.matchesReply(reply("target", "sender", "q1")), { status: "no-match" });
		assert.deepEqual(await a.matchesReply(reply("target", "sender", "q3")), { status: "match" });
		assert.deepEqual(await a.clearReply(reply("target", "sender", "q3")), { status: "cleared" });
		assert.deepEqual(await b.matchesReply(reply("target", "sender", "q3")), { status: "no-match" });
	});

	check("prunes a sender's asks and hands a target's asks over in insertion order", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		await a.record(ask("sender", "target", "q1"));
		await b.record(ask("sender-2", "target", "q-z"));
		await a.record(ask("sender", "target-2", "q3"));
		await b.record(ask("sender-2", "target", "q-a"));
		await a.record(ask("both", "target-3", "q-both-sent"));
		await b.record(ask("sender-3", "both", "q-both-asked"));
		assert.deepEqual(await b.pruneSender("sender"), { status: "pruned", removed: 2 });
		assert.deepEqual(await b.pruneSender("unknown"), { status: "pruned", removed: 0 });
		assert.deepEqual(await a.takeForTarget("target"), {
			status: "taken",
			asks: [ask("sender-2", "target", "q-z"), ask("sender-2", "target", "q-a")],
		});
		assert.deepEqual(await b.takeForTarget("target"), { status: "taken", asks: [] });
		assert.deepEqual(await b.matchesReply(reply("target-2", "sender", "q3")), { status: "no-match" });
		assert.deepEqual(await a.takeForTarget("both"), {
			status: "taken",
			asks: [ask("sender-3", "both", "q-both-asked")],
		});
		assert.deepEqual(await b.matchesReply(reply("target-3", "both", "q-both-sent")), { status: "match" });
		await b.record(ask("sender-4", "both", "q-both-later"));
		assert.deepEqual(await a.pruneSender("both"), { status: "pruned", removed: 1 });
		assert.deepEqual(await b.takeForTarget("both"), {
			status: "taken",
			asks: [ask("sender-4", "both", "q-both-later")],
		});
	});

	check("rejects empty identifiers", async (connect) => {
		const a = await connect();
		const empty = (reason: string) => ({ status: "invalid", reason });
		assert.deepEqual(await a.record(ask("", "target", "q1")), empty("empty-session-id"));
		assert.deepEqual(await a.record(ask("sender", "", "q1")), empty("empty-session-id"));
		assert.deepEqual(await a.record(ask("sender", "target", "")), empty("empty-message-id"));
		assert.deepEqual(await a.matchesReply(reply("", "sender", "q1")), empty("empty-session-id"));
		assert.deepEqual(await a.matchesReply(reply("target", "sender", "")), empty("empty-message-id"));
		assert.deepEqual(await a.clearReply(reply("target", "", "q1")), empty("empty-session-id"));
		assert.deepEqual(await a.pruneSender(""), empty("empty-session-id"));
		assert.deepEqual(await a.takeForTarget(""), empty("empty-session-id"));
	});
}

export function registerSentMessageAuthorityConformance(
	runner: MultiNodeConformanceRunner,
	name: string,
	open: OpenSharedStoreFixture<SentMessageAuthority>,
): void {
	const check = withShared(runner, `${name} sent messages`, open);
	const route = { targetSessionId: "recipient-session", senderGroupIdentity: "team" };

	check("recognizes a same-id retry through another broker and refuses a different payload", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		const key = { messageId: "m1", digest: "d1" };
		const reservedRoute = { ...route };
		assert.deepEqual(await a.reserve({ ...key, targetIdentity: RECIPIENT, questionRoute: reservedRoute }), {
			status: "reserved",
		});
		Reflect.set(reservedRoute, "targetSessionId", "mutated after reserve");
		assert.deepEqual(await b.reserve({ ...key, targetIdentity: RECIPIENT }), { status: "match", state: "reserved" });
		assert.deepEqual(await b.reserve({ ...key, digest: "d2", targetIdentity: RECIPIENT }), { status: "conflict" });
		const found = expectStatus(await b.lookup(key), "match");
		assert.deepEqual(found, { status: "match", state: "reserved", targetIdentity: RECIPIENT, questionRoute: route });
		Reflect.set(found.questionRoute!, "senderGroupIdentity", "mutated after lookup");
		assert.deepEqual(await b.lookup(key), {
			status: "match",
			state: "reserved",
			targetIdentity: RECIPIENT,
			questionRoute: route,
		});
		assert.deepEqual(await b.accept({ ...key, digest: "d2" }), { status: "conflict" });
		assert.deepEqual(await b.accept(key), { status: "accepted" });
		assert.deepEqual(await a.accept(key), { status: "accepted" });
		assert.deepEqual(await a.reserve({ ...key, targetIdentity: RECIPIENT }), { status: "match", state: "accepted" });
		assert.deepEqual(await a.lookup({ ...key, digest: "d2" }), { status: "conflict" });
		assert.deepEqual(await a.lookup({ messageId: "unknown", digest: "d1" }), { status: "miss" });
		assert.deepEqual(await a.accept({ messageId: "unknown", digest: "d1" }), { status: "missing" });
		await a.reserve({ messageId: "plain", digest: "d", targetIdentity: OTHER_RECIPIENT });
		assert.deepEqual(await b.lookup({ messageId: "plain", digest: "d" }), {
			status: "match",
			state: "reserved",
			targetIdentity: OTHER_RECIPIENT,
		});
	});

	check("forgets a failed reservation so a retry is new, and prunes old records", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		const key = { messageId: "m1", digest: "d1" };
		await a.reserve({ ...key, targetIdentity: RECIPIENT });
		assert.deepEqual(await b.forget({ ...key, digest: "d2" }), { status: "conflict" });
		assert.deepEqual(await b.forget(key), { status: "forgotten" });
		assert.deepEqual(await a.lookup(key), { status: "miss" });
		assert.deepEqual(await a.forget(key), { status: "missing" });
		assert.deepEqual(await a.reserve({ ...key, targetIdentity: RECIPIENT }), { status: "reserved" });
		assert.equal(await b.prune(LIVE_MS), 0);
		assert.equal(await b.prune(EXPIRED_MS), 1);
		assert.deepEqual(await a.lookup(key), { status: "miss" });
	});

	check("rejects empty identifiers", async (connect) => {
		const a = await connect();
		const empty = (reason: string) => ({ status: "invalid", reason });
		assert.deepEqual(
			await a.reserve({ messageId: "", digest: "d", targetIdentity: RECIPIENT }),
			empty("empty-message-id"),
		);
		assert.deepEqual(
			await a.reserve({ messageId: "m1", digest: "d", targetIdentity: "" }),
			empty("empty-target-identity"),
		);
		assert.deepEqual(await a.accept({ messageId: "", digest: "d" }), empty("empty-message-id"));
		assert.deepEqual(await a.lookup({ messageId: "", digest: "d" }), empty("empty-message-id"));
		assert.deepEqual(await a.forget({ messageId: "", digest: "d" }), empty("empty-message-id"));
		assert.deepEqual(await a.lookup({ messageId: "m1", digest: "d" }), { status: "miss" });
	});
}

/** Collects one subscription's events and waits for the next matching one. */
class WakeUpRecorder {
	readonly events: WakeUpEvent[] = [];
	private readonly waiters: Array<() => void> = [];
	readonly listener: WakeUpListener = (event) => {
		this.events.push(event);
		for (const wake of this.waiters.splice(0)) wake();
	};

	mark(): number {
		return this.events.length;
	}

	hints(): WakeUpHint[] {
		return this.events.flatMap((event) => (event.kind === "hint" ? [event.hint] : []));
	}

	async next(predicate: (event: WakeUpEvent) => boolean, from = 0): Promise<WakeUpEvent> {
		const deadline = Date.now() + WAKE_UP_DELIVERY_BOUND_MS;
		for (;;) {
			const found = this.events.slice(from).find(predicate);
			if (found !== undefined) return found;
			const remaining = deadline - Date.now();
			if (remaining <= 0) assert.fail(`no matching wake-up event within ${WAKE_UP_DELIVERY_BOUND_MS} ms`);
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, remaining);
				this.waiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	}
}

async function subscribe(
	bus: WakeUpBus,
	brokerId: string,
): Promise<{ recorder: WakeUpRecorder; subscription: WakeUpSubscription }> {
	const recorder = new WakeUpRecorder();
	const subscription = expectStatus(await bus.subscribe(brokerId, recorder.listener), "subscribed").subscription;
	assert.equal(subscription.brokerId, brokerId);
	return { recorder, subscription };
}

const isHintFor = (brokerId: string, reason: WakeUpHint["reason"]) => (event: WakeUpEvent) =>
	event.kind === "hint" && event.hint.brokerId === brokerId && event.hint.reason === reason;

export function registerWakeUpBusConformance(
	runner: MultiNodeConformanceRunner,
	name: string,
	open: OpenWakeUpBusFixture,
): void {
	const check = (label: string, body: (fixture: WakeUpBusFixture) => Promise<void>) => {
		runner(`${name} wake-up bus: ${label}`, async () => {
			const fixture = await open();
			try {
				await body(fixture);
			} finally {
				await fixture.close();
			}
		});
	};

	check("starts every subscription with a resync so the broker catches up", async (fixture) => {
		const bus = await fixture.connect();
		const { recorder } = await subscribe(bus, "broker-a");
		await recorder.next((event) => event.kind === "resync");
		assert.deepEqual(recorder.events[0], { kind: "resync", cause: "subscribed" });
	});

	check("delivers a hint only to the addressed broker, carrying nothing but the hint", async (fixture) => {
		const [a, b] = [await fixture.connect(), await fixture.connect()];
		const onA = await subscribe(a, "broker-a");
		const onB = await subscribe(b, "broker-b");
		const toB: WakeUpHint = { brokerId: "broker-b", reason: "outbox", version: 3 };
		assert.deepEqual(await a.publish(toB), { status: "published" });
		assert.deepEqual(await onB.recorder.next(isHintFor("broker-b", "outbox")), { kind: "hint", hint: toB });
		const toA: WakeUpHint = { brokerId: "broker-a", reason: "outcome", version: 4 };
		assert.deepEqual(await b.publish(toA), { status: "published" });
		assert.deepEqual(await onA.recorder.next(isHintFor("broker-a", "outcome")), { kind: "hint", hint: toA });
		assert.ok(onA.recorder.hints().every((hint) => hint.brokerId === "broker-a"));
		assert.ok(onB.recorder.hints().every((hint) => hint.brokerId === "broker-b"));
	});

	check("treats a hint for a broker with no subscriber as a harmless no-op", async (fixture) => {
		const bus = await fixture.connect();
		const result = await bus.publish({ brokerId: "broker-without-subscriber", reason: "outbox", version: 1 });
		assert.ok(result.status === "published" || result.status === "unavailable");
	});

	check("resyncs after a reconnect and keeps delivering hints", async (fixture) => {
		const [a, b] = [await fixture.connect(), await fixture.connect()];
		const { recorder } = await subscribe(b, "broker-b");
		await recorder.next((event) => event.kind === "resync");
		const mark = recorder.mark();
		await fixture.interrupt(b);
		assert.deepEqual(await recorder.next((event) => event.kind === "resync", mark), {
			kind: "resync",
			cause: "reconnected",
		});
		const hint: WakeUpHint = { brokerId: "broker-b", reason: "outbox", version: 9 };
		const afterReconnect = recorder.mark();
		await a.publish(hint);
		assert.deepEqual(await recorder.next(isHintFor("broker-b", "outbox"), afterReconnect), { kind: "hint", hint });
	});

	check(
		"stops delivering after a subscription or connection closes, and refuses a later subscribe",
		async (fixture) => {
			const [a, b] = [await fixture.connect(), await fixture.connect()];
			const closed = await subscribe(b, "broker-b");
			await closed.recorder.next((event) => event.kind === "resync");
			await closed.subscription.close();
			await closed.subscription.close();
			const mark = closed.recorder.mark();
			await a.publish({ brokerId: "broker-b", reason: "outbox", version: 1 });
			await sleep(CLOSED_SUBSCRIPTION_QUIET_MS);
			assert.equal(closed.recorder.mark(), mark);
			const open = await subscribe(b, "broker-b");
			await open.recorder.next((event) => event.kind === "resync");
			await b.close();
			await b.close();
			const openMark = open.recorder.mark();
			await a.publish({ brokerId: "broker-b", reason: "outbox", version: 2 });
			await sleep(CLOSED_SUBSCRIPTION_QUIET_MS);
			assert.equal(open.recorder.mark(), openMark);
			assert.deepEqual(await b.publish({ brokerId: "broker-a", reason: "outbox", version: 1 }), {
				status: "unavailable",
			});
			assert.deepEqual(await b.subscribe("broker-b", () => {}), { status: "unavailable" });
		},
	);

	check("rejects an empty broker id", async (fixture) => {
		const bus = await fixture.connect();
		const empty = { status: "invalid", reason: "empty-broker-id" };
		assert.deepEqual(await bus.publish({ brokerId: "", reason: "outbox", version: 1 }), empty);
		assert.deepEqual(await bus.subscribe("", () => {}), empty);
	});
}

interface SimulatedBroker {
	readonly brokerId: string;
	readonly outbox: OutboxStore;
	readonly asks: PendingAskStore;
	readonly bus: WakeUpBus;
	readonly recorder: WakeUpRecorder;
}

/**
 * Two brokers that share only the store and the bus, as the spec's round trip describes. "Writing a frame to the
 * recipient's socket" is the claimed row's frame; "the recipient acknowledges `received`" is `markDelivered`.
 */
export function registerCrossNodeRoundTripConformance(
	runner: MultiNodeConformanceRunner,
	name: string,
	fixtures: CrossNodeFixtures,
): void {
	const check = (
		label: string,
		body: (a: SimulatedBroker, b: SimulatedBroker, bus: WakeUpBusFixture) => Promise<void>,
	) => {
		runner(`${name} cross-node round trip: ${label}`, async () => {
			const outboxFixture = await fixtures.openOutbox();
			const askFixture = await fixtures.openPendingAsks();
			const busFixture = await fixtures.openBus();
			try {
				const broker = async (brokerId: string): Promise<SimulatedBroker> => {
					const bus = await busFixture.connect();
					const { recorder } = await subscribe(bus, brokerId);
					await recorder.next((event) => event.kind === "resync");
					return {
						brokerId,
						outbox: await outboxFixture.connect(),
						asks: await askFixture.connect(),
						bus,
						recorder,
					};
				};
				await body(await broker("broker-a"), await broker("broker-b"), busFixture);
			} finally {
				await busFixture.close();
				await askFixture.close();
				await outboxFixture.close();
			}
		});
	};
	const send = async (
		origin: SimulatedBroker,
		host: SimulatedBroker,
		targetIdentity: string,
		frame: IntercomDeliveryFrame,
	) => {
		const row = expectStatus(
			await origin.outbox.enqueue({
				targetIdentity,
				originBrokerId: origin.brokerId,
				digest: `digest:${frame.message.id}`,
				frame,
			}),
			"inserted",
		).row;
		await origin.bus.publish({ brokerId: host.brokerId, reason: "outbox", version: row.sequence });
		return row;
	};
	const claimFor = async (host: SimulatedBroker, targetIdentity: string) =>
		expectStatus(
			await host.outbox.claim({ claimantId: host.brokerId, targetIdentity, staleAfterMs: LIVE_MS }),
			"claimed",
		).rows;
	const acknowledge = async (host: SimulatedBroker, claimed: ClaimedOutboxRow) => {
		const row = expectStatus(await host.outbox.markDelivered(claimed.claim), "delivered").row;
		await host.bus.publish({ brokerId: row.originBrokerId, reason: "outcome", version: row.sequence });
		return row;
	};

	check("delivers the local frame across nodes and reports delivered only after the acknowledgement", async (a, b) => {
		const localFrames = [richFrame("z-cross"), frameFor("a-cross", "  plain peer message  ")];
		const mark = b.recorder.mark();
		for (const frame of localFrames) await send(a, b, RECIPIENT, frame);
		await b.recorder.next(isHintFor("broker-b", "outbox"), mark);
		const claimed = await claimFor(b, RECIPIENT);
		assert.deepEqual(
			claimed.map((entry) => entry.row.frame),
			localFrames,
		);
		for (const frame of localFrames) {
			assert.equal(expectStatus(await a.outbox.read(frame.message.id), "found").row.state, "claimed");
		}
		const outcomeMark = a.recorder.mark();
		for (const entry of claimed) await acknowledge(b, entry);
		await a.recorder.next(isHintFor("broker-a", "outcome"), outcomeMark);
		for (const frame of localFrames) {
			assert.equal(expectStatus(await a.outbox.read(frame.message.id), "found").row.state, "delivered");
		}
	});

	check("routes an ask and its reply back across nodes through the shared ask route", async (a, b) => {
		const question = frameFor("ask-1", "Which file?");
		const askFrame: IntercomDeliveryFrame = { ...question, message: { ...question.message, expectsReply: true } };
		const replyRoute = {
			replySenderSessionId: RECIPIENT_SESSION.id,
			replyTargetSessionId: SENDER.id,
			replyTo: "ask-1",
		};
		await send(a, b, RECIPIENT, askFrame);
		const [claimedAsk] = await claimFor(b, RECIPIENT);
		assert.ok(claimedAsk);
		assert.deepEqual(claimedAsk.row.frame, askFrame);
		assert.deepEqual(await b.asks.matchesReply(replyRoute), { status: "no-match" });
		assert.deepEqual(
			await b.asks.record({ senderSessionId: SENDER.id, targetSessionId: RECIPIENT_SESSION.id, messageId: "ask-1" }),
			{ status: "recorded" },
		);
		await acknowledge(b, claimedAsk);
		const replyFrame: IntercomDeliveryFrame = {
			type: "message",
			from: RECIPIENT_SESSION,
			message: {
				id: "reply-1",
				timestamp: 1_700_000_004_000,
				replyTo: "ask-1",
				content: { text: " src/index.ts " },
			},
		};
		assert.deepEqual(await b.asks.matchesReply(replyRoute), { status: "match" });
		const mark = a.recorder.mark();
		await send(b, a, SENDER_IDENTITY, replyFrame);
		await a.recorder.next(isHintFor("broker-a", "outbox"), mark);
		const [claimedReply] = await claimFor(a, SENDER_IDENTITY);
		assert.ok(claimedReply);
		assert.deepEqual(claimedReply.row.frame, replyFrame);
		const outcomeMark = b.recorder.mark();
		await acknowledge(a, claimedReply);
		assert.deepEqual(await a.asks.clearReply(replyRoute), { status: "cleared" });
		await b.recorder.next(isHintFor("broker-b", "outcome"), outcomeMark);
		assert.equal(expectStatus(await b.outbox.read("reply-1"), "found").row.state, "delivered");
		assert.equal(expectStatus(await a.outbox.read("ask-1"), "found").row.state, "delivered");
		assert.deepEqual(await b.asks.matchesReply(replyRoute), { status: "no-match" });
	});

	check("keeps an ask's reply route when its broker stops before marking it delivered", async (a, b) => {
		const question = frameFor("ask-interrupted", "Which branch?");
		const askFrame: IntercomDeliveryFrame = { ...question, message: { ...question.message, expectsReply: true } };
		const ask = { senderSessionId: SENDER.id, targetSessionId: RECIPIENT_SESSION.id, messageId: "ask-interrupted" };
		const replyRoute = {
			replySenderSessionId: RECIPIENT_SESSION.id,
			replyTargetSessionId: SENDER.id,
			replyTo: "ask-interrupted",
		};
		await send(a, b, RECIPIENT, askFrame);
		const [first] = await claimFor(b, RECIPIENT);
		assert.ok(first);
		// The recipient saved the ask: its route is recorded first, then broker B stops before `markDelivered`.
		assert.deepEqual(await b.asks.record(ask), { status: "recorded" });
		assert.deepEqual(await a.asks.matchesReply(replyRoute), { status: "match" });
		assert.equal(expectStatus(await a.outbox.read("ask-interrupted"), "found").row.state, "claimed");
		// The unsettled row is claimed again after the claim expires; repeating both writes is safe.
		const reclaimed = expectStatus(
			await a.outbox.claim({ claimantId: "broker-c", targetIdentity: RECIPIENT, staleAfterMs: EXPIRED_MS }),
			"claimed",
		).rows;
		assert.deepEqual(
			reclaimed.map((entry) => entry.row.messageId),
			["ask-interrupted"],
		);
		assert.deepEqual(await a.asks.record(ask), { status: "duplicate" });
		expectStatus(await a.outbox.markDelivered(reclaimed[0]!.claim), "delivered");
		assert.deepEqual(await b.asks.matchesReply(replyRoute), { status: "match" });
	});

	check("recovers lost wake-ups from the outbox alone, including after a reconnect", async (a, b, bus) => {
		for (const id of ["lost-z", "lost-a", "lost-m"]) {
			expectStatus(await a.outbox.enqueue(request(frameFor(id, id))), "inserted");
		}
		assert.deepEqual(b.recorder.hints(), []);
		assert.deepEqual(
			(await claimFor(b, RECIPIENT)).map((entry) => entry.row.messageId),
			["lost-z", "lost-a", "lost-m"],
		);
		const mark = b.recorder.mark();
		await bus.interrupt(b.bus);
		await b.recorder.next((event) => event.kind === "resync" && event.cause === "reconnected", mark);
		expectStatus(await a.outbox.enqueue(request(frameFor("while-away", "while away"))), "inserted");
		assert.deepEqual(
			(await claimFor(b, RECIPIENT)).map((entry) => entry.row.messageId),
			["while-away"],
		);
	});

	check("collapses coalesced and duplicate wake-ups into one outbox read", async (a, b) => {
		const mark = b.recorder.mark();
		for (const id of ["burst-z", "burst-a", "burst-m"]) await send(a, b, RECIPIENT, frameFor(id, id));
		await b.recorder.next(isHintFor("broker-b", "outbox"), mark);
		const reads = [await claimFor(b, RECIPIENT), await claimFor(b, RECIPIENT), await claimFor(b, RECIPIENT)];
		assert.deepEqual(
			reads.map((rows) => rows.map((entry) => entry.row.messageId)),
			[["burst-z", "burst-a", "burst-m"], [], []],
		);
		await a.bus.publish({ brokerId: "broker-b", reason: "outbox", version: 0 });
		assert.deepEqual(await claimFor(b, OTHER_RECIPIENT), []);
	});
}

interface SimulatedHeldBroker {
	readonly brokerId: string;
	readonly reservations: RestoringReservationStore;
	readonly heldSends: HeldSendStore;
	readonly outbox: OutboxStore;
	readonly bus: WakeUpBus;
	readonly recorder: WakeUpRecorder;
}

const CHILD_IDENTITY = JSON.stringify(["session", "restored-worker"]);
const SENDER_IN_GROUP = { sessionId: SENDER.id, groups: ["team", "Review Crew"] };

/**
 * The held path of the spec's round trip: the sender's broker A sees a child its supervisor restores on broker B,
 * holds the send and owns its dispatch; the broker that ends the hold only records the end and wakes A.
 */
export function registerCrossNodeHeldRoundTripConformance(
	runner: MultiNodeConformanceRunner,
	name: string,
	fixtures: CrossNodeHeldFixtures,
): void {
	const check = (label: string, body: (a: SimulatedHeldBroker, b: SimulatedHeldBroker) => Promise<void>) => {
		runner(`${name} cross-node held round trip: ${label}`, async () => {
			const reservationFixture = await fixtures.openReservations();
			const heldFixture = await fixtures.openHeldSends();
			const outboxFixture = await fixtures.openOutbox();
			const busFixture = await fixtures.openBus();
			try {
				const broker = async (brokerId: string): Promise<SimulatedHeldBroker> => {
					const bus = await busFixture.connect();
					const { recorder } = await subscribe(bus, brokerId);
					await recorder.next((event) => event.kind === "resync");
					return {
						brokerId,
						reservations: await reservationFixture.connect(),
						heldSends: await heldFixture.connect(),
						outbox: await outboxFixture.connect(),
						bus,
						recorder,
					};
				};
				await body(await broker("broker-a"), await broker("broker-b"));
			} finally {
				await busFixture.close();
				await outboxFixture.close();
				await heldFixture.close();
				await reservationFixture.close();
			}
		});
	};
	const heldRequest = (id: string, text: string): HeldSend["request"] => ({
		type: "send",
		to: "worker",
		awaitRestoringRecipient: true,
		attemptId: `attempt-${id}`,
		message: { id, timestamp: 1_700_000_005_000, content: { text } },
	});
	const holdThroughOrigin = async (origin: SimulatedHeldBroker, request: HeldSend["request"]) => {
		const found = expectStatus(await origin.reservations.lookup("worker", SENDER_IN_GROUP, LIVE_MS), "reserved");
		const send: HeldSend = {
			reservationKey: found.reservation.reservationKey,
			originBrokerId: origin.brokerId,
			senderSessionId: SENDER.id,
			request,
		};
		assert.deepEqual(await origin.heldSends.hold(send), { status: "held" });
		return send;
	};
	const wakeOrigins = async (ending: SimulatedHeldBroker, reservationKey: string) => {
		const sends = expectStatus(await ending.heldSends.list(reservationKey), "listed").sends;
		for (const brokerId of new Set(sends.map((send) => send.originBrokerId))) {
			await ending.bus.publish({ brokerId, reason: "outcome", version: 0 });
		}
		return sends;
	};

	check(
		"holds a send for a child restored on another node and delivers it once the child registers there",
		async (a, b) => {
			const reserved = expectStatus(await b.reservations.reserve(reservationRequest()), "reserved");
			assert.deepEqual(await a.reservations.lookup("worker", OUTSIDER, LIVE_MS), { status: "none" });
			const request = heldRequest("held-z", "  held across nodes \u0000 ünï ");
			const send = await holdThroughOrigin(a, request);
			assert.equal(send.reservationKey, RESERVATION_KEY);
			assert.ok(!send.reservationKey.includes("capability-worker"));

			const heldMark = a.recorder.mark();
			assert.deepEqual(
				await b.reservations.consume(reserved.lease.reservationKey, { childTarget: "worker", groups: ["team"] }),
				{
					status: "consumed",
					reservationKeys: [RESERVATION_KEY],
				},
			);
			assert.deepEqual(await wakeOrigins(b, RESERVATION_KEY), [send]);
			await a.recorder.next(isHintFor("broker-a", "outcome"), heldMark);
			assert.deepEqual(await a.reservations.read(RESERVATION_KEY), {
				status: "ended",
				end: { outcome: "consumed" },
			});
			assert.deepEqual(await a.heldSends.drop(request.message.id), { status: "dropped" });
			assert.deepEqual(await b.heldSends.drop(request.message.id), { status: "missing" });
			assert.deepEqual(await a.reservations.lookup("worker", SENDER_IN_GROUP, LIVE_MS), { status: "none" });

			const frame: IntercomDeliveryFrame = { type: "message", from: SENDER, message: request.message };
			const outboxMark = b.recorder.mark();
			const row = expectStatus(
				await a.outbox.enqueue({
					targetIdentity: CHILD_IDENTITY,
					originBrokerId: a.brokerId,
					digest: "digest:held-z",
					frame,
				}),
				"inserted",
			).row;
			await a.bus.publish({ brokerId: b.brokerId, reason: "outbox", version: row.sequence });
			await b.recorder.next(isHintFor("broker-b", "outbox"), outboxMark);
			const [claimed] = expectStatus(
				await b.outbox.claim({ claimantId: b.brokerId, targetIdentity: CHILD_IDENTITY, staleAfterMs: LIVE_MS }),
				"claimed",
			).rows;
			assert.ok(claimed);
			assert.deepEqual(claimed.row.frame, frame);
			const outcomeMark = a.recorder.mark();
			expectStatus(await b.outbox.markDelivered(claimed.claim), "delivered");
			await b.bus.publish({ brokerId: a.brokerId, reason: "outcome", version: row.sequence });
			await a.recorder.next(isHintFor("broker-a", "outcome"), outcomeMark);
			assert.equal(expectStatus(await a.outbox.read("held-z"), "found").row.state, "delivered");
			assert.deepEqual(await a.heldSends.list(RESERVATION_KEY), { status: "listed", sends: [] });
		},
	);

	check("refuses a held send with the gone reason its supervisor reports on another node", async (a, b) => {
		const { lease } = expectStatus(await b.reservations.reserve(reservationRequest()), "reserved");
		const request = heldRequest("held-gone", "are you there?");
		const send = await holdThroughOrigin(a, request);
		const gone = "Subagent `Worker` did not survive the restart and is gone.";
		const mark = a.recorder.mark();
		assert.deepEqual(await b.reservations.release(lease, { gone }), { status: "gone" });
		assert.deepEqual(await wakeOrigins(b, RESERVATION_KEY), [send]);
		await a.recorder.next(isHintFor("broker-a", "outcome"), mark);
		assert.equal(expectStatus(await a.reservations.read(RESERVATION_KEY), "active").reservation.gone, gone);
		assert.deepEqual(await a.heldSends.drop(request.message.id), { status: "dropped" });
		const later = expectStatus(await a.reservations.lookup("atomic-session-7", SENDER_IN_GROUP, LIVE_MS), "gone");
		assert.equal(later.reservation.gone, gone);
		assert.deepEqual(await a.outbox.read("held-gone"), { status: "missing" });
	});
}
