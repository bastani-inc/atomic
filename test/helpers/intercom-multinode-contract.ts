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
	SentMessageAuthority,
} from "../../packages/intercom/broker/multinode-state-store.js";
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

/** Passed as `staleAfterMs` to treat a lease or claim of any realistic age as live. */
const LIVE_MS = 3_600_000;
/** Passed as `staleAfterMs` to treat every lease or claim as expired. */
const EXPIRED_MS = -1;
/** Upper bound for a healthy bus to deliver a published hint or a resync. */
const WAKE_UP_DELIVERY_BOUND_MS = 5_000;
/** How long a closed subscription is watched for stray events. */
const CLOSED_SUBSCRIPTION_QUIET_MS = 100;

const RECIPIENT = JSON.stringify(["return", "recipient-address", "team"]);
const SENDER_IDENTITY = JSON.stringify(["return", "sender-address", "team"]);
const OTHER_RECIPIENT = JSON.stringify(["session", "other-recipient"]);

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
		assert.deepEqual(await b.enqueue(request(frame, { digest: "other digest" })), {
			status: "conflict",
			messageId: "m1",
		});
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
		const first = await insert(a, frameFor("m1", "one"));
		await insert(b, frameFor("x1", "other"), { targetIdentity: OTHER_RECIPIENT });
		await insert(a, frameFor("m2", "two"));
		await insert(b, frameFor("m3", "three"), { originBrokerId: "broker-c" });
		const claimed = await claimAll(b, "broker-b");
		assert.deepEqual(ids(claimed), ["m1", "m2", "m3"]);
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
		assert.deepEqual(ids(expectStatus(await a.listUndelivered(RECIPIENT), "listed").rows), ["m1", "m2", "m3"]);
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
		await insert(a, frameFor("m1", "one"));
		await insert(a, frameFor("m2", "two"));
		const [first, second] = await claimAll(a, "broker-a");
		assert.ok(first && second);
		assert.deepEqual(await a.releaseClaim(first.claim), { status: "released" });
		assert.equal(expectStatus(await b.read("m1"), "found").row.state, "queued");
		assert.deepEqual(await b.markDelivered(first.claim), { status: "stale" });
		assert.deepEqual(await b.claim({ claimantId: "broker-b", targetIdentity: RECIPIENT, staleAfterMs: LIVE_MS }), {
			status: "held",
			claimantId: "broker-a",
		});
		const [again] = await claimAll(a, "broker-a");
		assert.ok(again);
		assert.equal(again.row.messageId, "m1");
		assert.equal(again.claim.attempt, 2);
		assert.deepEqual(ids(await claimAll(b, "broker-b", EXPIRED_MS)), ["m1", "m2"]);
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
		await insert(a, frameFor("m1", "one"));
		await insert(a, frameFor("m2", "two"));
		const [first, second] = await claimAll(b, "broker-b");
		assert.ok(first && second);
		await b.markDelivered(first.claim);
		await b.markFailed(second.claim, "refused");
		const queued = await insert(a, frameFor("m3", "three"));
		assert.equal(await a.prune(LIVE_MS), 0);
		assert.equal(await a.prune(EXPIRED_MS), 2);
		assert.deepEqual(await b.read("m1"), { status: "missing" });
		assert.deepEqual(await b.read("m2"), { status: "missing" });
		assert.equal(expectStatus(await b.read("m3"), "found").row.state, "queued");
		const reinserted = await insert(b, frameFor("m1", "one"));
		assert.ok(reinserted.sequence > queued.sequence);
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
		const first = held("h1", "capability-1", "  first \u0000 ünï ");
		const snapshot = structuredClone(first);
		assert.deepEqual(await a.hold(first), { status: "held" });
		Reflect.set(first.request, "to", "mutated after hold");
		assert.deepEqual(await b.hold(held("h2", "capability-2")), { status: "held" });
		assert.deepEqual(await a.hold(held("h3")), { status: "held" });
		assert.deepEqual(await b.hold(held("h1", "capability-2")), { status: "duplicate" });
		assert.deepEqual(await b.list("capability-1"), { status: "listed", sends: [snapshot, held("h3")] });
		const racing = await Promise.all([a.take("capability-1"), b.take("capability-1")]);
		const taken = racing.flatMap((result) => expectStatus(result, "taken").sends);
		assert.deepEqual(taken, [snapshot, held("h3")]);
		assert.deepEqual(await a.take("capability-1"), { status: "taken", sends: [] });
		assert.deepEqual(await a.list("capability-2"), { status: "listed", sends: [held("h2", "capability-2")] });
		assert.deepEqual(await a.drop("h2"), { status: "dropped" });
		assert.deepEqual(await b.drop("h2"), { status: "missing" });
		assert.deepEqual(await b.list("capability-2"), { status: "listed", sends: [] });
		assert.deepEqual(await b.hold(held("h1")), { status: "held" });
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
		assert.deepEqual(await b.matchesReply(reply("target", "sender", "q1")), { status: "match" });
		assert.deepEqual(await b.matchesReply(reply("sender", "target", "q1")), { status: "no-match" });
		assert.deepEqual(await b.matchesReply(reply("target", "sender", "q2")), { status: "no-match" });
		assert.deepEqual(await b.matchesReply(reply("someone", "sender", "q1")), { status: "no-match" });
		assert.deepEqual(await b.clearReply(reply("target", "sender", "q1")), { status: "cleared" });
		assert.deepEqual(await a.clearReply(reply("target", "sender", "q1")), { status: "no-match" });
		assert.deepEqual(await a.matchesReply(reply("target", "sender", "q1")), { status: "no-match" });
	});

	check("prunes a sender's asks and hands a target's asks over in insertion order", async (connect) => {
		const [a, b] = [await connect(), await connect()];
		await a.record(ask("sender", "target", "q1"));
		await b.record(ask("sender-2", "target", "q2"));
		await a.record(ask("sender", "target-2", "q3"));
		await b.record(ask("sender-2", "target", "q4"));
		assert.deepEqual(await b.pruneSender("sender"), { status: "pruned", removed: 2 });
		assert.deepEqual(await b.pruneSender("unknown"), { status: "pruned", removed: 0 });
		assert.deepEqual(await a.takeForTarget("target"), {
			status: "taken",
			asks: [ask("sender-2", "target", "q2"), ask("sender-2", "target", "q4")],
		});
		assert.deepEqual(await b.takeForTarget("target"), { status: "taken", asks: [] });
		assert.deepEqual(await b.matchesReply(reply("target-2", "sender", "q3")), { status: "no-match" });
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
		assert.deepEqual(await a.reserve({ ...key, targetIdentity: RECIPIENT, questionRoute: route }), {
			status: "reserved",
		});
		assert.deepEqual(await b.reserve({ ...key, targetIdentity: RECIPIENT }), { status: "match", state: "reserved" });
		assert.deepEqual(await b.reserve({ ...key, digest: "d2", targetIdentity: RECIPIENT }), { status: "conflict" });
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

	check("stops delivering after a subscription or connection closes", async (fixture) => {
		const [a, b] = [await fixture.connect(), await fixture.connect()];
		const closed = await subscribe(b, "broker-b");
		await closed.recorder.next((event) => event.kind === "resync");
		await closed.subscription.close();
		await closed.subscription.close();
		const mark = closed.recorder.mark();
		await a.publish({ brokerId: "broker-b", reason: "outbox", version: 1 });
		await sleep(CLOSED_SUBSCRIPTION_QUIET_MS);
		assert.equal(closed.recorder.mark(), mark);
		await b.close();
		await b.close();
		assert.deepEqual(await b.publish({ brokerId: "broker-a", reason: "outbox", version: 1 }), {
			status: "unavailable",
		});
	});

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
		const localFrames = [richFrame("cross-1"), frameFor("cross-2", "  plain peer message  ")];
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
		await acknowledge(b, claimedAsk);
		assert.deepEqual(
			await b.asks.record({ senderSessionId: SENDER.id, targetSessionId: RECIPIENT_SESSION.id, messageId: "ask-1" }),
			{ status: "recorded" },
		);
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

	check("recovers lost wake-ups from the outbox alone, including after a reconnect", async (a, b, bus) => {
		for (const id of ["lost-1", "lost-2", "lost-3"]) {
			expectStatus(await a.outbox.enqueue(request(frameFor(id, id))), "inserted");
		}
		assert.deepEqual(b.recorder.hints(), []);
		assert.deepEqual(
			(await claimFor(b, RECIPIENT)).map((entry) => entry.row.messageId),
			["lost-1", "lost-2", "lost-3"],
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
		for (const id of ["burst-1", "burst-2", "burst-3"]) await send(a, b, RECIPIENT, frameFor(id, id));
		await b.recorder.next(isHintFor("broker-b", "outbox"), mark);
		const reads = [await claimFor(b, RECIPIENT), await claimFor(b, RECIPIENT), await claimFor(b, RECIPIENT)];
		assert.deepEqual(
			reads.map((rows) => rows.map((entry) => entry.row.messageId)),
			[["burst-1", "burst-2", "burst-3"], [], []],
		);
		await a.bus.publish({ brokerId: "broker-b", reason: "outbox", version: 0 });
		assert.deepEqual(await claimFor(b, OTHER_RECIPIENT), []);
	});
}
