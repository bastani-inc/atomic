import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type net from "node:net";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const { crossNodeDigest, LOCAL_RETRY_LOOKUP_BOUND_MS, MultiNodeRouter } = await import(
	"../../packages/intercom/broker/multinode-router.js"
);
const { PendingQuestionIndex } = await import("../../packages/intercom/broker/pending-question-index.js");
const { SupervisorChannelCache } = await import("../../packages/intercom/broker/supervisor-channel.js");
const { releasedReservationKey } = await import("../../packages/intercom/broker/released-children.js");
const { deliveryTargetIdentity } = await import("../../packages/intercom/broker/send-handler.js");
const { UNCERTAIN_RECEIPT_REASON } = await import("../../packages/intercom/broker/recipient-receipts.js");
const { BROKER_LEASE_RENEW_INTERVAL_MS, BROKER_LEASE_STALE_AFTER_MS, OUTBOX_CLAIM_STALE_AFTER_MS } = await import(
	"../../packages/intercom/broker/multinode-state-store.js"
);
const { normalizeGroup } = await import("../../packages/intercom/group.js");
const { addressesReleasedAsker, isReleasedReplyCandidate, releasedAskerReplyRefusal, releasedReplyAckOutcome } =
	await import("../../packages/intercom/broker/released-asker-remote-replies.js");
const {
	isReleasedReplyAnsweredError,
	isReleasedReplyInFlightError,
	readSerializedIntercomReleasedReplyError,
	rehydrateIntercomReleasedReplyError,
} = await import("../../packages/intercom/broker/released-reply-errors.js");
const memory = await import("../helpers/intercom-multinode-memory-reference.js");

type Router = import("../../packages/intercom/broker/multinode-router.js").MultiNodeRouter;
type State = import("../../packages/intercom/broker/multinode-state-store.js").IntercomBrokerStateStore;
type Session = import("../../packages/intercom/broker/send-handler.js").BrokerConnectedSession;
type RemoteSendRequest = import("../../packages/intercom/broker/send-handler.js").RemoteSendRequest;
type Frame = import("../../packages/intercom/broker/socket-writes.js").BrokerOutboundFrame;
type WakeUpBus = import("../../packages/intercom/broker/wake-up-bus.js").WakeUpBus;
type FakeSocket = net.Socket & { frames: Frame[] };
type HandoffFrame = Extract<Frame, { type: "released_child_reply" }>;

const CREW = normalizeGroup("crew");
const PENDING_REPLY_REFUSAL = "Pending question route does not authorize this public reply";
const SLOW_LOOKUP_MS = 40;

interface Cluster {
	connectState(): Promise<State>;
	connectBus(): Promise<WakeUpBus>;
}

interface Node {
	readonly router: Router;
	readonly sessions: Map<string, Session>;
	readonly state: State;
	/** This broker's own ask routes. */
	readonly pendingQuestions: InstanceType<typeof PendingQuestionIndex>;
	/** Write outcomes held back by `WriteFaults.defer`, to report later. */
	readonly deferred: Array<(written: boolean) => void>;
}

/** Frames whose confirmed write fails, or reports its outcome only when the test says so. */
interface WriteFaults {
	readonly fail?: (frame: Frame) => boolean;
	readonly defer?: (frame: Frame) => boolean;
}

const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function cluster(): Promise<Cluster> {
	const fixtures = {
		leases: await memory.openMemoryLeaseStoreFixture(),
		outbox: await memory.openMemoryOutboxFixture(),
		heldSends: await memory.openMemoryHeldSendFixture(),
		reservations: await memory.openMemoryRestoringReservationFixture(),
		pendingAsks: await memory.openMemoryPendingAskFixture(),
		releasedAsks: await memory.openMemoryReleasedAskFixture(),
		sentMessages: await memory.openMemorySentMessageFixture(),
		knownSessions: await memory.openMemoryKnownSessionFixture(),
	};
	const bus = await memory.openMemoryWakeUpBusFixture();
	cleanups.push(() => bus.close());
	return {
		async connectState() {
			return {
				leases: await fixtures.leases.connect(),
				outbox: await fixtures.outbox.connect(),
				heldSends: await fixtures.heldSends.connect(),
				reservations: await fixtures.reservations.connect(),
				pendingAsks: await fixtures.pendingAsks.connect(),
				releasedAsks: await fixtures.releasedAsks.connect(),
				sentMessages: await fixtures.sentMessages.connect(),
				knownSessions: await fixtures.knownSessions.connect(),
				close: async () => {},
			};
		},
		connectBus: () => bus.connect(),
	};
}

async function startNode(
	shared: Cluster,
	wrap: (state: State) => State = (state) => state,
	faults: WriteFaults = {},
): Promise<Node> {
	const state = wrap(await shared.connectState());
	const sessions = new Map<string, Session>();
	const deferred: Array<(written: boolean) => void> = [];
	const pendingQuestions = new PendingQuestionIndex();
	const router = await MultiNodeRouter.start({
		state,
		bus: await shared.connectBus(),
		host: {
			sessions,
			write: (socket, frame) => {
				(socket as FakeSocket).frames.push(frame);
				return true;
			},
			writeConfirmed: (socket, frame, onSettled) => {
				(socket as FakeSocket).frames.push(frame);
				if (faults.defer?.(frame) === true) deferred.push(onSettled);
				else onSettled(faults.fail?.(frame) !== true);
			},
			supervisorCache: new SupervisorChannelCache(),
			pendingQuestions,
			deliveredMessages: { lookupForTarget: () => "miss", lookupQuestionTarget: () => undefined },
			dispatch: () => {},
			revokeReleasedReservation: () => {},
		},
	});
	cleanups.push(() => router.close());
	await flush();
	return { router, sessions, state, pendingQuestions, deferred };
}

async function flush(): Promise<void> {
	for (let turn = 0; turn < 12; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function session(name: string, options: { supervisorId?: string; returnAddress?: string; id?: string } = {}): Session {
	return {
		socket: { destroyed: false, writableEnded: false, frames: [] } as unknown as FakeSocket,
		info: {
			id: options.id ?? randomUUID(),
			name,
			cwd: "/work",
			model: "test/model",
			pid: 1,
			startedAt: 1,
			lastActivity: 1,
			status: "idle",
			group: CREW,
			groups: [CREW],
		},
		registrationGroup: CREW,
		registrationName: name,
		registrationReturnAddress: options.returnAddress ?? randomUUID(),
		acknowledgesReceipt: true,
		...(options.supervisorId === undefined ? {} : { supervisorId: options.supervisorId }),
	};
}

/** The same host session reconnected: same return address and name, new socket. */
function reconnected(previous: Session, id = previous.info.id): Session {
	return session(previous.info.name ?? "", {
		id,
		...(previous.registrationReturnAddress === undefined
			? {}
			: { returnAddress: previous.registrationReturnAddress }),
		...(previous.supervisorId === undefined ? {} : { supervisorId: previous.supervisorId }),
	});
}

async function register(node: Node, target: Session): Promise<void> {
	node.sessions.set(target.info.id, target);
	await node.router.sessionRegistered(target);
	await flush();
}

async function leave(node: Node, target: Session): Promise<void> {
	node.sessions.delete(target.info.id);
	node.router.sessionLeft(target);
	await flush();
}

const framesOf = (target: Session): Frame[] => (target.socket as FakeSocket).frames;
const handoffsTo = (owner: Session): HandoffFrame[] =>
	framesOf(owner).filter((frame): frame is HandoffFrame => frame.type === "released_child_reply");
const outcomesFor = (sender: Session, messageId: string): Frame[] =>
	framesOf(sender).filter(
		(frame) =>
			(frame.type === "delivered" || frame.type === "delivery_failed" || frame.type === "queued") &&
			frame.messageId === messageId,
	);

function reserveReleased(node: Node, owner: Session, childName: string): void {
	node.router.restoringReserved(releasedReservationKey(childName), owner.info.id, childName, CREW, [], true, {
		wake: true,
		replaceAliases: true,
	});
}

interface ReplyOptions {
	readonly id?: string;
	readonly expectedRecipientId?: string;
	readonly text?: string;
	readonly expectsReply?: boolean;
}

function reply(from: Session, target: string, questionId: string, options: ReplyOptions = {}) {
	const id = options.id ?? randomUUID();
	const attemptId = randomUUID();
	const message = {
		id,
		timestamp: 1,
		replyTo: questionId,
		content: { text: options.text ?? `answer to ${questionId}` },
		...(options.expectsReply === undefined ? {} : { expectsReply: options.expectsReply }),
	};
	const notFound: string[] = [];
	const request: RemoteSendRequest = {
		socket: from.socket,
		from,
		clientMessage: { type: "send", to: target, message, attemptId, requirePendingReply: true },
		message,
		target,
		signature: JSON.stringify([target, message.replyTo, message.content.text, options.expectedRecipientId]),
		attemptId,
		supervisorSend: false,
		requirePendingReply: true,
		...(options.expectedRecipientId === undefined ? {} : { expectedRecipientId: options.expectedRecipientId }),
		resolveReplyTarget: false,
		awaitRestoringRecipient: false,
		notFound: () => notFound.push(id),
	};
	return { id, attemptId, request, notFound };
}

interface ReleasedScene {
	readonly shared: Cluster;
	readonly a: Node;
	readonly b: Node;
	readonly owner: Session;
	readonly replier: Session;
	readonly children: Array<{ readonly child: Session; readonly questionId: string }>;
}

/**
 * Owner and its supervised children on node A, the replier on node B. Each child asked the replier through the
 * outbox (its shared pending ask is recorded), the owner reserved it released, and it left A.
 */
async function releasedScene(
	options: {
		childNames?: readonly string[];
		wrapB?: (state: State) => State;
		wrapA?: (state: State) => State;
		writesA?: WriteFaults;
	} = {},
): Promise<ReleasedScene> {
	const shared = await cluster();
	const a = await startNode(shared, options.wrapA, options.writesA);
	const b = await startNode(shared, options.wrapB);
	const owner = session("owner");
	await register(a, owner);
	const replier = session("replier");
	await register(b, replier);
	const children: Array<{ child: Session; questionId: string }> = [];
	for (const name of options.childNames ?? ["worker"]) children.push(await releaseChild(a, owner, name, replier));
	return { shared, a, b, owner, replier, children };
}

/** A supervised child of `owner` on `node` asked `replier` across the nodes, was reserved released, and left. */
async function releaseChild(
	node: Node,
	owner: Session,
	name: string,
	replier: Session,
): Promise<{ readonly child: Session; readonly questionId: string }> {
	const child = session(name, { supervisorId: owner.info.id });
	await register(node, child);
	const questionId = randomUUID();
	await node.state.pendingAsks.record({
		senderSessionId: child.info.id,
		targetSessionId: replier.info.id,
		messageId: questionId,
	});
	reserveReleased(node, owner, name);
	await flush();
	await leave(node, child);
	return { child, questionId };
}

function only<Item>(items: readonly Item[], label: string): Item {
	assert.equal(items.length, 1, `${label}: ${JSON.stringify(items)}`);
	return items[0] as Item;
}

async function settled(sender: Session, messageId: string, count = 1): Promise<Frame> {
	await vi.waitFor(() => assert.equal(outcomesFor(sender, messageId).length, count), { timeout: 2_000, interval: 5 });
	return outcomesFor(sender, messageId)[count - 1] as Frame;
}

describe("replies to released askers across nodes (#4386)", () => {
	test("a reply through another node reaches the released asker's owner once and its sender hears it was delivered (#4386)", async () => {
		const { a, b, owner, replier, children } = await releasedScene();
		const [{ child, questionId }] = children as [{ child: Session; questionId: string }];
		const sent = reply(replier, child.info.id, questionId, { expectedRecipientId: child.info.id });
		b.router.routeSend(sent.request);
		await vi.waitFor(() => assert.equal(handoffsTo(owner).length, 1), { timeout: 2_000, interval: 5 });
		const handoff = only(handoffsTo(owner), "handoffs");
		assert.deepEqual(handoff, {
			type: "released_child_reply",
			childName: "worker",
			replyTo: questionId,
			from: replier.info,
			message: sent.request.message,
			handoffId: handoff.handoffId,
		});
		assert.match(handoff.handoffId, /^[0-9a-f-]{36}$/);
		await flush();
		assert.deepEqual(outcomesFor(replier, sent.id), [], "nothing is settled before the owner answers");
		assert.equal(a.router.received(owner, sent.id), false, "a plain receipt does not settle a released reply");
		assert.equal(a.router.releasedReplyAcknowledged(owner, sent.id, randomUUID(), true), false, "another handoff");
		assert.equal(a.router.releasedReplyAcknowledged(owner, sent.id, undefined, true), false, "no handoff");
		assert.equal(
			a.router.releasedReplyAcknowledged(session("impostor"), sent.id, handoff.handoffId, true),
			false,
			"another session",
		);
		assert.equal(a.router.releasedReplyAcknowledged(owner, randomUUID(), handoff.handoffId, true), false);
		await flush();
		assert.deepEqual(outcomesFor(replier, sent.id), []);
		assert.equal(a.router.releasedReplyAcknowledged(owner, sent.id, handoff.handoffId, true), true);
		assert.deepEqual(await settled(replier, sent.id), {
			type: "delivered",
			messageId: sent.id,
			attemptId: sent.attemptId,
		});
		assert.equal(a.router.releasedReplyAcknowledged(owner, sent.id, handoff.handoffId, true), false, "settled once");
		assert.deepEqual(await a.state.releasedAsks.lookup({ questionId, replierSessionId: replier.info.id }), {
			status: "found",
			ask: {
				questionId,
				askerSessionId: child.info.id,
				replierSessionId: replier.info.id,
				childName: "worker",
				ownerSessionId: owner.info.id,
				state: "answered",
				replyMessageId: sent.id,
			},
		});
		const row = await a.state.outbox.read(sent.id);
		assert.equal(row.status === "found" && row.row.state, "delivered");
		assert.deepEqual(sent.notFound, []);
		assert.equal(handoffsTo(owner).length, 1);
		assert.deepEqual(
			framesOf(owner).filter((frame) => frame.type === "message"),
			[],
			"never an ordinary message",
		);
	});

	test("a reply reaches the owner of a released asker that woke for another reason first (#4386)", async () => {
		const { a, b, owner, replier, children } = await releasedScene();
		const [{ child, questionId }] = children as [{ child: Session; questionId: string }];
		const woken = reconnected(child);
		a.sessions.set(woken.info.id, woken);
		await a.router.sessionRegistered(woken, {
			childName: "worker",
			groups: new Set([CREW]),
			authorizedBy: owner.info.id,
		});
		await flush();
		const reservation = await a.state.reservations.read(releasedReservationKey("worker"));
		assert.deepEqual(reservation.status === "ended" && reservation.end, { outcome: "consumed" });
		const sent = reply(replier, child.info.id, questionId, { expectedRecipientId: child.info.id });
		b.router.routeSend(sent.request);
		await vi.waitFor(() => assert.equal(handoffsTo(owner).length, 1), { timeout: 2_000, interval: 5 });
		const handoff = only(handoffsTo(owner), "handoffs");
		assert.equal(handoff.message.id, sent.id);
		a.router.releasedReplyAcknowledged(owner, sent.id, handoff.handoffId, true);
		assert.equal((await settled(replier, sent.id)).type, "delivered");
		assert.deepEqual(
			framesOf(woken).filter((frame) => frame.type === "message"),
			[],
			"the reply goes to the owner",
		);
	});

	test("a reply reaches the owner of a released asker that woke on the replier's broker under the same id, and its retries are answered from its row (#4386)", async () => {
		type Fault = "answers" | "stalls" | "fails";
		let lookup: Fault = "answers";
		let presence: Fault = "answers";
		let lookups = 0;
		let presenceReads = 0;
		const stalledReads: Array<() => void> = [];
		const { a, b, owner, replier, children } = await releasedScene({
			wrapB: (state) => ({
				...state,
				releasedAsks: {
					...state.releasedAsks,
					lookup: (key) => {
						if (lookup === "stalls") return new Promise<never>(() => {});
						if (lookup === "fails") return Promise.reject(new Error("released-ask lookup failed"));
						lookups++;
						return state.releasedAsks.lookup(key);
					},
				},
				leases: {
					...state.leases,
					listLive: (kind, staleAfterMs) => {
						if (kind !== "presence") return state.leases.listLive(kind, staleAfterMs);
						presenceReads++;
						if (presence === "fails") return Promise.reject(new Error("presence read failed"));
						if (presence === "answers") return state.leases.listLive(kind, staleAfterMs);
						return new Promise((resolve) =>
							stalledReads.push(() => resolve(state.leases.listLive(kind, staleAfterMs))),
						);
					},
				},
			}),
		});
		const [{ child, questionId }] = children as [{ child: Session; questionId: string }];
		const woken = reconnected(child);
		b.sessions.set(woken.info.id, woken);
		await b.router.sessionRegistered(woken, {
			childName: "worker",
			groups: new Set([CREW]),
			authorizedBy: owner.info.id,
		});
		await flush();
		const sent = reply(replier, child.info.id, questionId, { expectedRecipientId: child.info.id });
		const retry = (attempt: number, label: string) => {
			const retried = reply(replier, child.info.id, questionId, { id: sent.id, expectedRecipientId: child.info.id });
			b.router.routeSend({ ...retried.request, localTarget: woken });
			return async (expected: Frame["type"]) => {
				const outcome = await vi.waitFor(
					() => outcomesFor(replier, sent.id)[attempt - 1] ?? assert.fail("no outcome"),
					{
						timeout: LOCAL_RETRY_LOOKUP_BOUND_MS + 1_000,
						interval: 5,
					},
				);
				assert.equal(outcome.type, expected, label);
				assert.deepEqual(retried.notFound, [], label);
			};
		};
		b.router.routeSend({ ...sent.request, localTarget: woken });
		await vi.waitFor(() => assert.equal(handoffsTo(owner).length, 1), { timeout: 2_000, interval: 5 });
		assert.deepEqual(sent.notFound, [], "not delivered on the local path");
		assert.equal(lookups, 1, "the question is looked up once");
		assert.deepEqual(outcomesFor(replier, sent.id), [], "the reply waits for the owner");
		const waiting = reply(replier, child.info.id, questionId, { id: sent.id, expectedRecipientId: child.info.id });
		const readsBeforeWaiting = presenceReads;
		b.router.routeSend({ ...waiting.request, localTarget: woken });
		await vi.waitFor(() => assert.ok(presenceReads > readsBeforeWaiting), { timeout: 2_000, interval: 5 });
		await flush();
		assert.deepEqual(outcomesFor(replier, sent.id), [], "a retry waits for the owner where it is live");
		assert.deepEqual(waiting.notFound, []);
		for (const [attempt, read] of [
			[1, "stalls"],
			[2, "fails"],
		] as const) {
			presence = read;
			await retry(attempt, `owner's presence ${read}`)("queued");
		}
		presence = "answers";
		for (const release of stalledReads.splice(0)) release();
		const handoff = only(handoffsTo(owner), "handoffs");
		assert.equal(handoff.message.id, sent.id);
		a.router.releasedReplyAcknowledged(owner, sent.id, handoff.handoffId, true);
		assert.equal((await settled(replier, sent.id, 3)).type, "delivered");
		const readsBeforeSettledRetries = presenceReads;
		for (const [attempt, retried] of [
			[4, "stalls"],
			[5, "fails"],
		] as const) {
			lookup = retried;
			await retry(attempt, `released-ask lookup ${retried}`)("delivered");
		}
		assert.equal(presenceReads, readsBeforeSettledRetries, "a settled reply's owner is not looked up");
		assert.equal(handoffsTo(owner).length, 1);
	});

	test("a retry of a moved reply its owner refused is answered from its row without reading the owner's presence (#4386)", async () => {
		let presenceReads = 0;
		const scene = await releasedScene({
			wrapB: (state) => ({
				...state,
				leases: {
					...state.leases,
					listLive: (kind, staleAfterMs) => {
						if (kind === "presence") presenceReads++;
						return state.leases.listLive(kind, staleAfterMs);
					},
				},
			}),
		});
		const [{ child, questionId }] = scene.children as [{ child: Session; questionId: string }];
		const woken = reconnected(child);
		scene.b.sessions.set(woken.info.id, woken);
		await scene.b.router.sessionRegistered(woken, {
			childName: "worker",
			groups: new Set([CREW]),
			authorizedBy: scene.owner.info.id,
		});
		const sent = reply(scene.replier, child.info.id, questionId, { expectedRecipientId: child.info.id });
		scene.b.router.routeSend({ ...sent.request, localTarget: woken });
		await vi.waitFor(() => assert.equal(handoffsTo(scene.owner).length, 1), { timeout: 2_000, interval: 5 });
		const handoff = only(handoffsTo(scene.owner), "handoffs");
		scene.a.router.releasedReplyAcknowledged(scene.owner, sent.id, handoff.handoffId, false);
		const refused = await settled(scene.replier, sent.id);
		assert.ok(refused.type === "delivery_failed");
		const readsBeforeRetry = presenceReads;
		const retried = reply(scene.replier, child.info.id, questionId, {
			id: sent.id,
			expectedRecipientId: child.info.id,
		});
		scene.b.router.routeSend({ ...retried.request, localTarget: woken });
		const again = await settled(scene.replier, sent.id, 2);
		assert.equal(again.type === "delivery_failed" && again.reason, refused.reason);
		assert.deepEqual(retried.notFound, []);
		assert.equal(presenceReads, readsBeforeRetry, "a settled reply's owner is not looked up");
	});

	test("a same-id send whose row went to another session than the one it resolves to on this broker is a conflict (#4386)", async () => {
		const shared = await cluster();
		const b = await startNode(shared);
		const [first, second, sender] = [session("first"), session("second"), session("sender")];
		for (const target of [first, second, sender]) await register(b, target);
		const sent = reply(sender, second.info.id, randomUUID());
		await b.state.outbox.enqueue({
			targetIdentity: deliveryTargetIdentity(first),
			originBrokerId: "another-broker",
			digest: crossNodeDigest(sent.request.signature),
			frame: { type: "message", from: sender.info, message: sent.request.message },
		});
		b.router.routeSend({ ...sent.request, localTarget: second });
		const outcome = await settled(sender, sent.id);
		assert.equal(outcome.type === "delivery_failed" && outcome.reasonCode, "message_id_conflict");
		assert.deepEqual(sent.notFound, []);
	});

	test("an outbox read that fails after the local bound is reported, and the send has taken the local path (#4386)", async () => {
		const shared = await cluster();
		const b = await startNode(shared, (state) => ({
			...state,
			outbox: {
				...state.outbox,
				read: () =>
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error("late outbox read failed")), LOCAL_RETRY_LOOKUP_BOUND_MS + 50),
					),
			},
		}));
		const [asker, sender] = [session("asker"), session("sender")];
		for (const target of [asker, sender]) await register(b, target);
		const sent = reply(sender, asker.info.id, randomUUID(), { expectsReply: true });
		b.router.routeSend({ ...sent.request, localTarget: asker });
		await vi.waitFor(() => assert.deepEqual(sent.notFound, [sent.id]), {
			timeout: LOCAL_RETRY_LOOKUP_BOUND_MS + 1_000,
			interval: 5,
		});
		await vi.waitFor(
			() =>
				assert.ok(
					vi.mocked(console.error).mock.calls.some(([text]) => String(text).includes("late outbox read failed")),
				),
			{ timeout: 2_000, interval: 5 },
		);
	});

	test("a reply whose released-ask lookup stalls or fails takes the local path within the local bound (#4386)", async () => {
		for (const lookup of ["stalls", "fails"] as const) {
			const shared = await cluster();
			const b = await startNode(shared, (state) => ({
				...state,
				releasedAsks: {
					...state.releasedAsks,
					lookup: () =>
						lookup === "stalls"
							? new Promise<never>(() => {})
							: Promise.reject(new Error("released-ask lookup failed")),
				},
			}));
			const asker = session("asker");
			await register(b, asker);
			const replier = session("replier");
			await register(b, replier);
			const sent = reply(replier, asker.info.id, randomUUID());
			b.router.routeSend({ ...sent.request, localTarget: asker });
			await vi.waitFor(() => assert.deepEqual(sent.notFound, [sent.id], lookup), {
				timeout: LOCAL_RETRY_LOOKUP_BOUND_MS + 1_000,
				interval: 5,
			});
		}
		assert.ok(
			vi.mocked(console.error).mock.calls.some(([text]) => String(text).includes("released-ask lookup failed")),
		);
	});

	test("a reply this broker's own ask routes answer takes the local path without reading the shared state (#4386)", async () => {
		let lookups = 0;
		const shared = await cluster();
		const b = await startNode(shared, (state) => ({
			...state,
			releasedAsks: {
				...state.releasedAsks,
				lookup: (key) => {
					lookups++;
					return state.releasedAsks.lookup(key);
				},
			},
		}));
		const asker = session("asker");
		await register(b, asker);
		const replier = session("replier");
		await register(b, replier);
		const questionId = randomUUID();
		b.pendingQuestions.record(asker.info.id, replier.info.id, questionId);
		const sent = reply(replier, asker.info.id, questionId);
		b.router.routeSend({ ...sent.request, localTarget: asker });
		await vi.waitFor(() => assert.deepEqual(sent.notFound, [sent.id]), { timeout: 2_000, interval: 5 });
		assert.equal(lookups, 0);
	});

	test("a reply does not reach another owner that reserved the released asker's name after its own owner dropped it (#4386)", async () => {
		const { a, b, owner, replier, children } = await releasedScene();
		const [{ child, questionId }] = children as [{ child: Session; questionId: string }];
		a.router.restoringReleased(releasedReservationKey("worker"), owner.info.id);
		await flush();
		const other = session("other-owner");
		await register(b, other);
		reserveReleased(b, other, "worker");
		await flush();
		const reservation = await b.state.reservations.read(releasedReservationKey("worker"));
		assert.equal(reservation.status === "active" && reservation.reservation.ownerSessionId, other.info.id);
		const sent = reply(replier, child.info.id, questionId);
		b.router.routeSend(sent.request);
		const refused = await settled(replier, sent.id);
		assert.ok(refused.type === "delivery_failed");
		assert.equal(refused.reason, PENDING_REPLY_REFUSAL);
		assert.deepEqual(handoffsTo(other), []);
		assert.deepEqual(handoffsTo(owner), []);
	});

	test("a reply addressed by the released asker's name, in any case, reaches its owner (#4386)", async () => {
		const { a, b, owner, replier, children } = await releasedScene({ childNames: ["Worker One"] });
		const [{ questionId }] = children as [{ child: Session; questionId: string }];
		const sent = reply(replier, " worker one ".trim().toUpperCase(), questionId);
		b.router.routeSend(sent.request);
		await vi.waitFor(() => assert.equal(handoffsTo(owner).length, 1), { timeout: 2_000, interval: 5 });
		const handoff = only(handoffsTo(owner), "handoffs");
		assert.equal(handoff.childName, "Worker One", "the asker's name is kept verbatim");
		a.router.releasedReplyAcknowledged(owner, sent.id, handoff.handoffId, true);
		assert.equal((await settled(replier, sent.id)).type, "delivered");
	});

	test("replies from one sender reach the owner in the order they were sent, even when the first is slower to route (#4386)", async () => {
		let slowQuestion: string | undefined;
		const { a, b, owner, replier, children } = await releasedScene({
			childNames: ["worker-1", "worker-2"],
			wrapB: (state) => ({
				...state,
				releasedAsks: {
					...state.releasedAsks,
					lookup: async (key) => {
						if (key.questionId === slowQuestion)
							await new Promise((resolve) => setTimeout(resolve, SLOW_LOOKUP_MS));
						return state.releasedAsks.lookup(key);
					},
				},
			}),
		});
		const [first, second] = children as [
			{ child: Session; questionId: string },
			{ child: Session; questionId: string },
		];
		slowQuestion = first.questionId;
		const replies = [reply(replier, "worker-1", first.questionId), reply(replier, "worker-2", second.questionId)];
		for (const sent of replies) b.router.routeSend(sent.request);
		await vi.waitFor(() => assert.equal(handoffsTo(owner).length, 2), { timeout: 2_000, interval: 5 });
		assert.deepEqual(
			handoffsTo(owner).map((handoff) => [handoff.childName, handoff.replyTo]),
			[
				["worker-1", first.questionId],
				["worker-2", second.questionId],
			],
		);
		for (const handoff of handoffsTo(owner))
			a.router.releasedReplyAcknowledged(owner, handoff.message.id, handoff.handoffId, true);
		for (const sent of replies) assert.equal((await settled(replier, sent.id)).type, "delivered");
	});

	test("a second reply is refused with a typed error, and a retry of the first is answered from its row, never handed over again (#4386)", async () => {
		const { a, b, owner, replier, children } = await releasedScene();
		const [{ child, questionId }] = children as [{ child: Session; questionId: string }];
		const first = reply(replier, child.info.id, questionId);
		b.router.routeSend(first.request);
		await vi.waitFor(() => assert.equal(handoffsTo(owner).length, 1), { timeout: 2_000, interval: 5 });

		const competing = reply(replier, child.info.id, questionId);
		b.router.routeSend(competing.request);
		const inFlight = await settled(replier, competing.id);
		assert.equal(inFlight.type, "delivery_failed");
		assert.ok(inFlight.type === "delivery_failed");
		assert.equal(inFlight.reasonCode, "released_reply_in_flight");
		const inFlightError = rehydrateIntercomReleasedReplyError(
			readSerializedIntercomReleasedReplyError(JSON.parse(JSON.stringify(inFlight.error))) ??
				assert.fail("no error"),
		);
		assert.ok(isReleasedReplyInFlightError(inFlightError));
		assert.equal(inFlightError.retryable, true);
		assert.equal(inFlight.reason, inFlightError.message);
		assert.deepEqual(
			{
				messageId: inFlightError.messageId,
				questionId: inFlightError.questionId,
				childName: inFlightError.childName,
			},
			{ messageId: competing.id, questionId, childName: "worker" },
		);

		const retry = reply(replier, child.info.id, questionId, { id: first.id });
		b.router.routeSend(retry.request);
		await flush();
		assert.deepEqual(
			framesOf(replier).filter((frame) => "attemptId" in frame && frame.attemptId === retry.attemptId),
			[],
			"a retry while the live owner holds the reply waits for it, without a queued notice",
		);
		const handoff = only(handoffsTo(owner), "a retry is not handed over again");
		a.router.releasedReplyAcknowledged(owner, first.id, handoff.handoffId, true);
		await vi.waitFor(
			() =>
				assert.ok(
					outcomesFor(replier, first.id).some(
						(frame) => frame.type === "delivered" && frame.attemptId === retry.attemptId,
					),
				),
			{
				timeout: 2_000,
				interval: 5,
			},
		);

		const late = reply(replier, child.info.id, questionId);
		b.router.routeSend(late.request);
		const answered = await settled(replier, late.id);
		assert.ok(answered.type === "delivery_failed");
		assert.equal(answered.reasonCode, "released_reply_answered");
		assert.ok(
			answered.error !== undefined &&
				isReleasedReplyAnsweredError(rehydrateIntercomReleasedReplyError(answered.error)),
		);
		assert.equal(answered.error.retryable, false);

		const afterSettle = reply(replier, child.info.id, questionId, { id: first.id });
		b.router.routeSend(afterSettle.request);
		assert.deepEqual(await settled(replier, first.id, outcomesFor(replier, first.id).length + 1), {
			type: "delivered",
			messageId: first.id,
			attemptId: afterSettle.attemptId,
		});
		assert.equal(handoffsTo(owner).length, 1, "the owner was handed the reply exactly once");
		const listed = await a.state.outbox.listUndelivered(
			JSON.stringify(["return", owner.registrationReturnAddress, CREW]),
		);
		assert.deepEqual(listed.status === "listed" ? listed.rows : undefined, []);
	});

	test("an owner's refusal of the first handoff tells the sender the subagent no longer waits, and opens the question to another reply (#4386)", async () => {
		const { a, b, owner, replier, children } = await releasedScene();
		const [{ child, questionId }] = children as [{ child: Session; questionId: string }];
		const refused = reply(replier, child.info.id, questionId);
		b.router.routeSend(refused.request);
		await vi.waitFor(() => assert.equal(handoffsTo(owner).length, 1), { timeout: 2_000, interval: 5 });
		a.router.releasedReplyAcknowledged(owner, refused.id, only(handoffsTo(owner), "first").handoffId, false);
		assert.deepEqual(await settled(replier, refused.id), {
			type: "delivery_failed",
			messageId: refused.id,
			attemptId: refused.attemptId,
			reason: releasedAskerReplyRefusal("worker"),
		});
		const next = reply(replier, child.info.id, questionId);
		b.router.routeSend(next.request);
		await vi.waitFor(() => assert.equal(handoffsTo(owner).length, 2), { timeout: 2_000, interval: 5 });
		const handoff = handoffsTo(owner)[1] as HandoffFrame;
		assert.equal(handoff.message.id, next.id);
		a.router.releasedReplyAcknowledged(owner, next.id, handoff.handoffId, true);
		assert.equal((await settled(replier, next.id)).type, "delivered");
	});

	test("an owner that reconnects before answering gets the reply again under a new handoff; refusing that one is uncertain and closes the question (#4386)", async () => {
		const { a, b, owner, replier, children } = await releasedScene();
		const [{ child, questionId }] = children as [{ child: Session; questionId: string }];
		const sent = reply(replier, child.info.id, questionId);
		b.router.routeSend(sent.request);
		await vi.waitFor(() => assert.equal(handoffsTo(owner).length, 1), { timeout: 2_000, interval: 5 });
		const firstHandoff = only(handoffsTo(owner), "first");
		await leave(a, owner);
		const returned = reconnected(owner);
		await register(a, returned);
		reserveReleased(a, returned, "worker");
		await vi.waitFor(() => assert.equal(handoffsTo(returned).length, 1), { timeout: 2_000, interval: 5 });
		const secondHandoff = only(handoffsTo(returned), "redelivered");
		assert.notEqual(secondHandoff.handoffId, firstHandoff.handoffId);
		assert.deepEqual({ ...secondHandoff, handoffId: firstHandoff.handoffId }, firstHandoff, "the same reply");
		assert.equal(a.router.releasedReplyAcknowledged(returned, sent.id, firstHandoff.handoffId, true), false);
		assert.equal(a.router.releasedReplyAcknowledged(returned, sent.id, secondHandoff.handoffId, false), true);
		assert.deepEqual(await settled(replier, sent.id), {
			type: "delivery_failed",
			messageId: sent.id,
			attemptId: sent.attemptId,
			reason: UNCERTAIN_RECEIPT_REASON,
		});
		const another = reply(replier, child.info.id, questionId);
		b.router.routeSend(another.request);
		const refused = await settled(replier, another.id);
		assert.ok(refused.type === "delivery_failed");
		assert.equal(refused.reasonCode, "released_reply_answered");
		assert.equal(handoffsTo(returned).length, 1);
	});

	test("a restart of the asker's broker between the release and the reply loses nothing (#4386)", async () => {
		const { shared, a, b, owner, replier, children } = await releasedScene();
		const [{ child, questionId }] = children as [{ child: Session; questionId: string }];
		await a.router.close();
		const restarted = await startNode(shared);
		const returned = reconnected(owner);
		await register(restarted, returned);
		reserveReleased(restarted, returned, "worker");
		await flush();
		const sent = reply(replier, child.info.id, questionId);
		b.router.routeSend(sent.request);
		await vi.waitFor(() => assert.equal(handoffsTo(returned).length, 1), { timeout: 2_000, interval: 5 });
		const handoff = only(handoffsTo(returned), "handoffs");
		assert.equal(handoff.replyTo, questionId);
		assert.deepEqual(handoffsTo(owner), []);
		restarted.router.releasedReplyAcknowledged(returned, sent.id, handoff.handoffId, true);
		assert.equal((await settled(replier, sent.id)).type, "delivered");
	});

	test("a reply while the owner's broker is down is queued, and handed over once when the owner returns (#4386)", async () => {
		const { shared, a, b, owner, replier, children } = await releasedScene();
		const [{ child, questionId }] = children as [{ child: Session; questionId: string }];
		await a.router.close();
		const sent = reply(replier, child.info.id, questionId);
		b.router.routeSend(sent.request);
		const queued = await settled(replier, sent.id);
		assert.deepEqual(queued, {
			type: "queued",
			messageId: sent.id,
			attemptId: sent.attemptId,
			target: "offline session",
			position: 1,
		});
		const retry = reply(replier, child.info.id, questionId, { id: sent.id });
		b.router.routeSend(retry.request);
		assert.equal(
			(await settled(replier, sent.id, 2)).type,
			"queued",
			"a retry while it waits is answered from its row",
		);

		const restarted = await startNode(shared);
		const returned = reconnected(owner);
		await register(restarted, returned);
		await vi.waitFor(() => assert.equal(handoffsTo(returned).length, 1), { timeout: 2_000, interval: 5 });
		const handoff = only(handoffsTo(returned), "handoffs");
		restarted.router.releasedReplyAcknowledged(returned, sent.id, handoff.handoffId, true);
		await vi.waitFor(() => assert.ok(outcomesFor(replier, sent.id).some((frame) => frame.type === "delivered")), {
			timeout: 2_000,
			interval: 5,
		});
		assert.deepEqual(handoffsTo(owner), []);
		assert.equal(handoffsTo(returned).length, 1);
	});

	test("a supervised asker that left without being released is not reached through its owner (#4386)", async () => {
		const shared = await cluster();
		const a = await startNode(shared);
		const b = await startNode(shared);
		const owner = session("owner");
		await register(a, owner);
		const replier = session("replier");
		await register(b, replier);
		const child = session("worker", { supervisorId: owner.info.id });
		await register(a, child);
		const questionId = randomUUID();
		await a.state.pendingAsks.record({
			senderSessionId: child.info.id,
			targetSessionId: replier.info.id,
			messageId: questionId,
		});
		await leave(a, child);
		const sent = reply(replier, child.info.id, questionId);
		b.router.routeSend(sent.request);
		const refused = await settled(replier, sent.id);
		assert.ok(refused.type === "delivery_failed");
		assert.equal(refused.reason, PENDING_REPLY_REFUSAL);
		assert.deepEqual(handoffsTo(owner), []);
	});

	test("an unsupervised session's question is not kept, so a reply after it leaves is refused as before (#4386)", async () => {
		const shared = await cluster();
		const a = await startNode(shared);
		const b = await startNode(shared);
		const asker = session("plain");
		await register(a, asker);
		const replier = session("replier");
		await register(b, replier);
		const questionId = randomUUID();
		await a.state.pendingAsks.record({
			senderSessionId: asker.info.id,
			targetSessionId: replier.info.id,
			messageId: questionId,
		});
		await leave(a, asker);
		assert.deepEqual(await a.state.releasedAsks.lookup({ questionId, replierSessionId: replier.info.id }), {
			status: "missing",
		});
		const sent = reply(replier, asker.info.id, questionId);
		b.router.routeSend(sent.request);
		const refused = await settled(replier, sent.id);
		assert.ok(refused.type === "delivery_failed");
		assert.equal(refused.reason, PENDING_REPLY_REFUSAL);
	});

	test("a reply to a released asker that is dropped, gone or ownerless, or not addressed to it, is routed as any other reply (#4386)", async () => {
		const { a, b, owner, replier, children } = await releasedScene({
			childNames: ["dropped", "gone", "ownerless", "kept"],
		});
		const [dropped, gone, ownerless, kept] = children as Array<{ child: Session; questionId: string }> as [
			{ child: Session; questionId: string },
			{ child: Session; questionId: string },
			{ child: Session; questionId: string },
			{ child: Session; questionId: string },
		];
		a.router.restoringReleased(releasedReservationKey("dropped"), owner.info.id);
		a.router.restoringReleased(releasedReservationKey("gone"), owner.info.id, "Subagent `gone` is gone");
		a.router.restoringReleased(releasedReservationKey("ownerless"), owner.info.id);
		await flush();
		const ghost = await a.state.reservations.reserve({
			reservationKey: releasedReservationKey("ownerless"),
			ownerSessionId: randomUUID(),
			ownerBrokerId: "a-broker-that-never-ran",
			childName: "ownerless",
			childTarget: "ownerless",
			aliases: [],
			group: CREW,
			dormant: true,
			wake: true,
		});
		assert.equal(ghost.status, "reserved");
		const cases = [
			[reply(replier, dropped.child.info.id, dropped.questionId), PENDING_REPLY_REFUSAL],
			[reply(replier, gone.child.info.id, gone.questionId), PENDING_REPLY_REFUSAL],
			[reply(replier, ownerless.child.info.id, ownerless.questionId), PENDING_REPLY_REFUSAL],
			[reply(replier, "someone-else", kept.questionId), "not found"],
			[
				reply(replier, kept.child.info.id, kept.questionId, { expectedRecipientId: randomUUID() }),
				"Reply target does not match the expected recipient",
			],
			[reply(replier, kept.child.info.id, dropped.questionId), PENDING_REPLY_REFUSAL],
			[reply(replier, kept.child.info.id, kept.questionId, { expectsReply: true }), PENDING_REPLY_REFUSAL],
		] as const;
		for (const [sent, expected] of cases) {
			b.router.routeSend(sent.request);
			const outcome = await vi.waitFor(
				() => {
					const [frame] = outcomesFor(replier, sent.id);
					if (frame?.type === "delivery_failed") return frame.reason;
					assert.equal(frame, undefined, JSON.stringify(frame));
					assert.ok(sent.notFound.length > 0, "unanswered");
					return "not found";
				},
				{ timeout: 2_000, interval: 5 },
			);
			assert.equal(outcome, expected, sent.request.target);
		}
		assert.deepEqual(handoffsTo(owner), []);
		const read = await a.state.releasedAsks.lookup({
			questionId: kept.questionId,
			replierSessionId: replier.info.id,
		});
		assert.equal(read.status === "found" && read.ask.state, "open", "an unaddressed reply claims nothing");
	});

	test("a failed write of a released asker's questions is reported once and the rest of its departure still runs (#4386)", async () => {
		const shared = await cluster();
		const a = await startNode(shared, (state) => ({
			...state,
			releasedAsks: {
				...state.releasedAsks,
				keep: async () => {
					throw new Error("shared database is unavailable");
				},
			},
		}));
		const owner = session("owner");
		await register(a, owner);
		const child = session("worker", { supervisorId: owner.info.id });
		await register(a, child);
		await a.state.pendingAsks.record({
			senderSessionId: child.info.id,
			targetSessionId: randomUUID(),
			messageId: randomUUID(),
		});
		await leave(a, child);
		await vi.waitFor(async () => {
			assert.deepEqual(await a.state.pendingAsks.listForSender(child.info.id), { status: "listed", asks: [] });
		});
		assert.ok(
			vi.mocked(console.error).mock.calls.some(([text]) => String(text).includes("shared database is unavailable")),
		);
	});
});

describe("released-asker replies under races and faults (#4386)", () => {
	const waitFor = { timeout: 2_000, interval: 5 };

	test("a retry of an accepted reply is answered from its row after the owner dropped the asker (#4386)", async () => {
		const { a, b, owner, replier, children } = await releasedScene();
		const [{ child, questionId }] = children as [{ child: Session; questionId: string }];
		const first = reply(replier, child.info.id, questionId);
		b.router.routeSend(first.request);
		await vi.waitFor(() => assert.equal(handoffsTo(owner).length, 1), waitFor);
		a.router.releasedReplyAcknowledged(owner, first.id, only(handoffsTo(owner), "handoff").handoffId, true);
		assert.equal((await settled(replier, first.id)).type, "delivered");
		a.router.restoringReleased(releasedReservationKey("worker"), owner.info.id);
		await flush();
		const retry = reply(replier, child.info.id, questionId, { id: first.id });
		b.router.routeSend(retry.request);
		assert.deepEqual(await settled(replier, first.id, 2), {
			type: "delivered",
			messageId: first.id,
			attemptId: retry.attemptId,
		});
		const another = reply(replier, child.info.id, questionId);
		b.router.routeSend(another.request);
		const refused = await settled(replier, another.id);
		assert.ok(refused.type === "delivery_failed");
		assert.equal(refused.reasonCode, "released_reply_answered", "still answered, though the owner dropped the asker");
		assert.equal(handoffsTo(owner).length, 1);
	});

	test("a reply that claimed its question but stopped before its row was written is handed over on retry (#4386)", async () => {
		const { a, b, owner, replier, children } = await releasedScene();
		const [{ child, questionId }] = children as [{ child: Session; questionId: string }];
		const replyMessageId = randomUUID();
		const claimed = await b.state.releasedAsks.claim({
			questionId,
			replierSessionId: replier.info.id,
			replyMessageId,
		});
		assert.equal(claimed.status, "claimed");
		const retry = reply(replier, child.info.id, questionId, { id: replyMessageId });
		b.router.routeSend(retry.request);
		await vi.waitFor(() => assert.equal(handoffsTo(owner).length, 1), waitFor);
		a.router.releasedReplyAcknowledged(owner, replyMessageId, only(handoffsTo(owner), "handoff").handoffId, true);
		assert.equal((await settled(replier, replyMessageId)).type, "delivered");
	});

	test("a reply that loses its question to another between lookup and claim is refused typed; one whose question is pruned meanwhile is routed as any other (#4386)", async () => {
		const races = new Map<string, "taken" | "missing">();
		const { b, owner, replier, children } = await releasedScene({
			childNames: ["worker-1", "worker-2"],
			wrapB: (state) => ({
				...state,
				releasedAsks: {
					...state.releasedAsks,
					claim: async (claim) => {
						const race = races.get(claim.questionId);
						if (race === "missing") return { status: "missing" };
						if (race === "taken") await state.releasedAsks.claim({ ...claim, replyMessageId: "the-other-reply" });
						return state.releasedAsks.claim(claim);
					},
				},
			}),
		});
		const [lost, pruned] = children as [
			{ child: Session; questionId: string },
			{ child: Session; questionId: string },
		];
		races.set(lost.questionId, "taken");
		races.set(pruned.questionId, "missing");
		const loser = reply(replier, lost.child.info.id, lost.questionId);
		b.router.routeSend(loser.request);
		const refused = await settled(replier, loser.id);
		assert.ok(refused.type === "delivery_failed");
		assert.equal(refused.reasonCode, "released_reply_in_flight");
		const late = reply(replier, pruned.child.info.id, pruned.questionId);
		b.router.routeSend(late.request);
		const routed = await settled(replier, late.id);
		assert.ok(routed.type === "delivery_failed");
		assert.equal(routed.reason, PENDING_REPLY_REFUSAL);
		assert.deepEqual(handoffsTo(owner), []);
	});

	test("the reply goes to the owner's own presence and record, not to a session listed before it under its id (#4386)", async () => {
		const shared = await cluster();
		const a = await startNode(shared);
		const b = await startNode(shared);
		const owner = session("owner");
		const impostor = session(owner.info.id);
		await register(a, impostor);
		await register(a, owner);
		const replier = session("replier");
		await register(b, replier);
		const live = await releaseChild(a, owner, "live-worker", replier);
		const offline = await releaseChild(a, owner, "offline-worker", replier);
		const toLive = reply(replier, live.child.info.id, live.questionId);
		b.router.routeSend(toLive.request);
		await vi.waitFor(() => assert.equal(handoffsTo(owner).length, 1), waitFor);
		await a.router.close();
		const toOffline = reply(replier, offline.child.info.id, offline.questionId);
		b.router.routeSend(toOffline.request);
		assert.equal((await settled(replier, toOffline.id)).type, "queued");
		const row = await b.state.outbox.read(toOffline.id);
		assert.equal(row.status === "found" && row.row.targetIdentity, deliveryTargetIdentity(owner));
		assert.deepEqual(handoffsTo(impostor), []);
	});

	test("a reply waiting on the shared store holds back only its own sender's later replies (#4386)", async () => {
		const gate = Promise.withResolvers<void>();
		let blocked: string | undefined;
		const shared = await cluster();
		const a = await startNode(shared);
		const b = await startNode(shared, (state) => ({
			...state,
			releasedAsks: {
				...state.releasedAsks,
				lookup: async (key) => {
					if (key.questionId === blocked) await gate.promise;
					return state.releasedAsks.lookup(key);
				},
			},
		}));
		const owner = session("owner");
		await register(a, owner);
		const [first, second] = [session("replier-1"), session("replier-2")];
		await register(b, first);
		await register(b, second);
		const stalled = await releaseChild(a, owner, "worker-1", first);
		const free = await releaseChild(a, owner, "worker-2", second);
		blocked = stalled.questionId;
		const held = reply(first, stalled.child.info.id, stalled.questionId);
		b.router.routeSend(held.request);
		const other = reply(second, free.child.info.id, free.questionId);
		b.router.routeSend(other.request);
		await vi.waitFor(() => assert.equal(handoffsTo(owner).length, 1), waitFor);
		assert.equal(only(handoffsTo(owner), "the other sender's reply").replyTo, free.questionId);
		const plain = { id: randomUUID(), timestamp: 1, content: { text: "not a reply" } };
		b.router.routeSend({
			...held.request,
			clientMessage: { type: "send", to: owner.info.id, message: plain, attemptId: held.attemptId },
			message: plain,
			target: owner.info.id,
			signature: plain.id,
			requirePendingReply: false,
		});
		await vi.waitFor(
			() => assert.ok(framesOf(owner).some((frame) => frame.type === "message" && frame.message.id === plain.id)),
			waitFor,
		);
		assert.equal(handoffsTo(owner).length, 1, "the stalled reply is still waiting");
		gate.resolve();
		await vi.waitFor(() => assert.equal(handoffsTo(owner).length, 2), waitFor);
		assert.equal(handoffsTo(owner)[1]?.replyTo, stalled.questionId);
	});

	test("an owner's answer that cannot be saved is reported once and the reply is handed over again (#4386)", async () => {
		let failures = 1;
		const { a, b, owner, replier, children } = await releasedScene({
			wrapA: (state) => ({
				...state,
				outbox: {
					...state.outbox,
					markDelivered: async (claim) => {
						if (failures-- > 0) throw new Error("database is locked");
						return state.outbox.markDelivered(claim);
					},
				},
			}),
		});
		const [{ child, questionId }] = children as [{ child: Session; questionId: string }];
		const sent = reply(replier, child.info.id, questionId);
		b.router.routeSend(sent.request);
		await vi.waitFor(() => assert.equal(handoffsTo(owner).length, 1), waitFor);
		const first = only(handoffsTo(owner), "first");
		assert.equal(a.router.releasedReplyAcknowledged(owner, sent.id, first.handoffId, true), true);
		await vi.waitFor(() => assert.equal(handoffsTo(owner).length, 2), waitFor);
		const second = handoffsTo(owner)[1] as HandoffFrame;
		assert.notEqual(second.handoffId, first.handoffId);
		assert.equal(second.message.id, sent.id);
		assert.ok(vi.mocked(console.error).mock.calls.some(([text]) => String(text).includes("database is locked")));
		assert.equal(a.router.releasedReplyAcknowledged(owner, sent.id, second.handoffId, true), true);
		assert.equal((await settled(replier, sent.id)).type, "delivered");
	});

	test("a handoff that cannot be written to the owner is handed back and handed over once it is back (#4386)", async () => {
		let refuseWrites = true;
		const { a, b, owner, replier, children } = await releasedScene({
			writesA: { fail: (frame) => refuseWrites && frame.type === "released_child_reply" },
		});
		const [{ child, questionId }] = children as [{ child: Session; questionId: string }];
		const sent = reply(replier, child.info.id, questionId);
		b.router.routeSend(sent.request);
		await vi.waitFor(async () => {
			const row = await a.state.outbox.read(sent.id);
			assert.ok(row.status === "found" && row.row.state === "queued" && row.row.claimAttempts === 1);
		}, waitFor);
		const unwritten = only(handoffsTo(owner), "the handoff that was not written");
		assert.equal(a.router.releasedReplyAcknowledged(owner, sent.id, unwritten.handoffId, true), false);
		refuseWrites = false;
		const returned = reconnected(owner);
		await register(a, returned);
		await vi.waitFor(() => assert.equal(handoffsTo(returned).length, 1), waitFor);
		a.router.releasedReplyAcknowledged(returned, sent.id, only(handoffsTo(returned), "handoff").handoffId, true);
		assert.equal((await settled(replier, sent.id)).type, "delivered");
	});

	test("a retry with another payload under the same id is a conflict, and a row the store refuses fails the reply (#4386)", async () => {
		let refuseRows = false;
		const { b, owner, replier, children } = await releasedScene({
			childNames: ["worker-1", "worker-2"],
			wrapB: (state) => ({
				...state,
				outbox: {
					...state.outbox,
					enqueue: async (request) =>
						refuseRows ? { status: "invalid", reason: "empty-message-id" } : state.outbox.enqueue(request),
				},
			}),
		});
		const [first, second] = children as [
			{ child: Session; questionId: string },
			{ child: Session; questionId: string },
		];
		const original = reply(replier, first.child.info.id, first.questionId, { text: "config.ts" });
		b.router.routeSend(original.request);
		await vi.waitFor(() => assert.equal(handoffsTo(owner).length, 1), waitFor);
		const changed = reply(replier, first.child.info.id, first.questionId, { id: original.id, text: "settings.ts" });
		b.router.routeSend(changed.request);
		const conflict = await vi.waitFor(() => {
			const frame = outcomesFor(replier, original.id).find((candidate) => candidate.type === "delivery_failed");
			assert.ok(frame?.type === "delivery_failed");
			return frame;
		}, waitFor);
		assert.equal(conflict.reasonCode, "message_id_conflict");
		refuseRows = true;
		const refused = reply(replier, second.child.info.id, second.questionId);
		b.router.routeSend(refused.request);
		const failed = await settled(replier, refused.id);
		assert.ok(failed.type === "delivery_failed");
		assert.equal(failed.reason, "Session not found");
		assert.equal(handoffsTo(owner).length, 1);
	});

	test("a message to a recipient that never confirms saves is delivered once written, as before (#4386)", async () => {
		const shared = await cluster();
		const a = await startNode(shared);
		const b = await startNode(shared);
		const recipient: Session = { ...session("legacy"), acknowledgesReceipt: undefined };
		await register(a, recipient);
		const sender = session("sender");
		await register(b, sender);
		const message = { id: randomUUID(), timestamp: 1, content: { text: "hello" } };
		const attemptId = randomUUID();
		b.router.routeSend({
			socket: sender.socket,
			from: sender,
			clientMessage: { type: "send", to: recipient.info.id, message, attemptId },
			message,
			target: recipient.info.id,
			signature: message.id,
			attemptId,
			supervisorSend: false,
			requirePendingReply: false,
			resolveReplyTarget: false,
			awaitRestoringRecipient: false,
			notFound: () => {},
		});
		assert.deepEqual(await settled(sender, message.id), { type: "delivered", messageId: message.id, attemptId });
	});

	test("a departing supervised child writes its questions to the shared store only when it has any, and only with a name (#4386)", async () => {
		const kept: number[] = [];
		const shared = await cluster();
		const a = await startNode(shared, (state) => ({
			...state,
			releasedAsks: {
				...state.releasedAsks,
				keep: async (asks, ttlMs) => {
					kept.push(asks.length);
					return state.releasedAsks.keep(asks, ttlMs);
				},
			},
		}));
		const owner = session("owner");
		await register(a, owner);
		const idle = session("idle", { supervisorId: owner.info.id });
		await register(a, idle);
		await leave(a, idle);
		const nameless: Session = {
			...session("nameless", { supervisorId: owner.info.id }),
			registrationName: undefined,
		};
		await register(a, nameless);
		await a.state.pendingAsks.record({
			senderSessionId: nameless.info.id,
			targetSessionId: randomUUID(),
			messageId: randomUUID(),
		});
		await leave(a, nameless);
		assert.deepEqual(kept, [], "no write for a child with no questions or no name");
		await releaseChild(a, owner, "asking", session("replier"));
		assert.deepEqual(kept, [1]);
	});

	test("a write outcome that arrives after the owner reconnected leaves the new handoff alone (#4386)", async () => {
		let deferring = true;
		const { a, b, owner, replier, children } = await releasedScene({
			writesA: { defer: (frame) => deferring && frame.type === "released_child_reply" },
		});
		const [{ child, questionId }] = children as [{ child: Session; questionId: string }];
		const sent = reply(replier, child.info.id, questionId);
		b.router.routeSend(sent.request);
		await vi.waitFor(() => assert.equal(a.deferred.length, 1), waitFor);
		deferring = false;
		await leave(a, owner);
		const returned = reconnected(owner);
		await register(a, returned);
		await vi.waitFor(() => assert.equal(handoffsTo(returned).length, 1), waitFor);
		a.deferred[0]?.(false);
		await flush();
		const handoff = only(handoffsTo(returned), "the new handoff");
		assert.equal(a.router.releasedReplyAcknowledged(returned, sent.id, handoff.handoffId, true), true);
		assert.equal((await settled(replier, sent.id)).type, "delivered");
	});

	test("a claim that cannot be handed back after a fault is reported, not dropped silently (#4386)", async () => {
		const failingRelease = (state: State, text: string): State => ({
			...state,
			outbox: {
				...state.outbox,
				markDelivered: async () => {
					throw new Error("the owner's answer could not be saved");
				},
				releaseClaim: async () => {
					throw new Error(text);
				},
			},
		});
		for (const [label, writesA] of [
			["after a failed save", {}],
			["after a failed write", { fail: (frame: Frame) => frame.type === "released_child_reply" }],
		] as const) {
			const text = `claim release failed ${label}`;
			const { a, b, owner, replier, children } = await releasedScene({
				wrapA: (state) => failingRelease(state, text),
				writesA,
			});
			const [{ child, questionId }] = children as [{ child: Session; questionId: string }];
			const sent = reply(replier, child.info.id, questionId);
			b.router.routeSend(sent.request);
			await vi.waitFor(() => assert.equal(handoffsTo(owner).length, 1), waitFor);
			a.router.releasedReplyAcknowledged(owner, sent.id, only(handoffsTo(owner), label).handoffId, true);
			await vi.waitFor(
				() =>
					assert.ok(
						vi.mocked(console.error).mock.calls.some(([line]) => String(line).includes(text)),
						label,
					),
				waitFor,
			);
		}
	});
});

describe("a released asker's question is never held by a reply that cannot settle it (#4386)", () => {
	const waitFor = { timeout: 2_000, interval: 5 };

	async function deliveredOnce(scene: ReleasedScene, child: Session, questionId: string): Promise<void> {
		const next = reply(scene.replier, child.info.id, questionId);
		scene.b.router.routeSend(next.request);
		await vi.waitFor(() => assert.equal(handoffsTo(scene.owner).length, 1), waitFor);
		const handoff = only(handoffsTo(scene.owner), "the one handoff");
		assert.equal(handoff.message.id, next.id);
		scene.a.router.releasedReplyAcknowledged(scene.owner, next.id, handoff.handoffId, true);
		assert.equal((await settled(scene.replier, next.id)).type, "delivered");
	}

	test("a reply whose row could not be written gives its question back to the next reply (#4386)", async () => {
		const failures: Array<"throw" | "invalid"> = ["throw", "invalid"];
		const scene = await releasedScene({
			childNames: ["worker-1", "worker-2"],
			wrapB: (state) => ({
				...state,
				outbox: {
					...state.outbox,
					enqueue: async (request) => {
						const failure = failures.shift();
						if (failure === "throw") throw new Error("database is locked");
						if (failure === "invalid") return { status: "invalid", reason: "empty-message-id" };
						return state.outbox.enqueue(request);
					},
				},
			}),
		});
		const [thrown, refused] = scene.children as [
			{ child: Session; questionId: string },
			{ child: Session; questionId: string },
		];
		const first = reply(scene.replier, thrown.child.info.id, thrown.questionId);
		scene.b.router.routeSend(first.request);
		const unavailable = await settled(scene.replier, first.id);
		assert.ok(unavailable.type === "delivery_failed");
		assert.equal(unavailable.reasonCode, "session_not_found");
		const second = reply(scene.replier, refused.child.info.id, refused.questionId);
		scene.b.router.routeSend(second.request);
		const invalid = await settled(scene.replier, second.id);
		assert.ok(invalid.type === "delivery_failed");
		assert.equal(invalid.reason, "Session not found");
		for (const { questionId } of scene.children) {
			const ask = await scene.b.state.releasedAsks.lookup({ questionId, replierSessionId: scene.replier.info.id });
			assert.equal(ask.status === "found" && ask.ask.state, "open");
		}
		const reported = vi.mocked(console.error).mock.calls.map(([line]) => String(line));
		assert.ok(reported.some((line) => line.includes("database is locked")));
		assert.ok(
			!reported.some((line) => line.includes("reopening its question failed")),
			"the question was given back",
		);
		await deliveredOnce(scene, thrown.child, thrown.questionId);
	});

	test("while one reply is being handed over, another is refused as in flight even after the owner dropped the asker (#4386)", async () => {
		const scene = await releasedScene();
		const [{ child, questionId }] = scene.children as [{ child: Session; questionId: string }];
		const first = reply(scene.replier, child.info.id, questionId);
		scene.b.router.routeSend(first.request);
		await vi.waitFor(() => assert.equal(handoffsTo(scene.owner).length, 1), waitFor);
		scene.a.router.restoringReleased(releasedReservationKey("worker"), scene.owner.info.id);
		await flush();
		const second = reply(scene.replier, child.info.id, questionId);
		scene.b.router.routeSend(second.request);
		const refused = await settled(scene.replier, second.id);
		assert.ok(refused.type === "delivery_failed");
		assert.equal(refused.reasonCode, "released_reply_in_flight");
	});

	test("a reply whose question is gone by its handoff is refused there, and its sender is told at once (#4386)", async () => {
		const scene = await releasedScene();
		const [{ child, questionId }] = scene.children as [{ child: Session; questionId: string }];
		await scene.a.router.close();
		const stranded = reply(scene.replier, child.info.id, questionId);
		scene.b.router.routeSend(stranded.request);
		assert.equal((await settled(scene.replier, stranded.id)).type, "queued");
		const key = { questionId, replierSessionId: scene.replier.info.id };
		await scene.b.state.releasedAsks.supersede({
			...key,
			replyMessageId: "the-other-reply",
			staleReplyMessageId: stranded.id,
			staleAfterMs: -1,
		});
		await scene.b.state.releasedAsks.answer({ ...key, replyMessageId: "the-other-reply" });
		const orphan = randomUUID();
		await scene.b.state.outbox.enqueue({
			targetIdentity: deliveryTargetIdentity(scene.owner),
			originBrokerId: "b-broker",
			digest: "orphan",
			frame: {
				type: "released_child_reply",
				childName: "worker",
				replyTo: randomUUID(),
				from: scene.replier.info,
				message: { id: orphan, timestamp: 1, replyTo: "x", content: { text: "no question" } },
			},
		});
		const restarted = await startNode(scene.shared);
		const returned = reconnected(scene.owner);
		await register(restarted, returned);
		const refused = await vi.waitFor(
			() => {
				const frame = outcomesFor(scene.replier, stranded.id).find(
					(candidate) => candidate.type === "delivery_failed",
				);
				assert.ok(frame?.type === "delivery_failed");
				return frame;
			},
			{ timeout: 1_500, interval: 5 },
		);
		assert.match(refused.reason, /released_reply_answered/);
		const row = await restarted.state.outbox.read(orphan);
		assert.ok(row.status === "found" && row.row.state === "failed");
		assert.equal(row.row.failureReason, releasedAskerReplyRefusal("worker"));
		assert.deepEqual(handoffsTo(returned), []);
	});

	test("a reply that cannot give its question back fails with both failures (#4386)", async () => {
		const scene = await releasedScene({
			wrapB: (state) => ({
				...state,
				outbox: {
					...state.outbox,
					enqueue: async () => {
						throw new Error("database is locked");
					},
				},
				releasedAsks: {
					...state.releasedAsks,
					reopen: async () => {
						throw new Error("database went away");
					},
				},
			}),
		});
		const [{ child, questionId }] = scene.children as [{ child: Session; questionId: string }];
		const sent = reply(scene.replier, child.info.id, questionId);
		scene.b.router.routeSend(sent.request);
		assert.equal((await settled(scene.replier, sent.id)).type, "delivery_failed");
		assert.ok(
			vi
				.mocked(console.error)
				.mock.calls.some(([line]) =>
					String(line).includes("database is locked; reopening its question failed too: database went away"),
				),
		);
	});

	test("a retry of a reply its owner refused is answered from its row and leaves the question open (#4386)", async () => {
		const scene = await releasedScene();
		const [{ child, questionId }] = scene.children as [{ child: Session; questionId: string }];
		const refused = reply(scene.replier, child.info.id, questionId);
		scene.b.router.routeSend(refused.request);
		await vi.waitFor(() => assert.equal(handoffsTo(scene.owner).length, 1), waitFor);
		scene.a.router.releasedReplyAcknowledged(
			scene.owner,
			refused.id,
			only(handoffsTo(scene.owner), "first").handoffId,
			false,
		);
		await settled(scene.replier, refused.id);
		const retry = reply(scene.replier, child.info.id, questionId, { id: refused.id });
		scene.b.router.routeSend(retry.request);
		const again = await settled(scene.replier, refused.id, 2);
		assert.ok(again.type === "delivery_failed");
		assert.equal(again.reason, releasedAskerReplyRefusal("worker"));
		const ask = await scene.b.state.releasedAsks.lookup({ questionId, replierSessionId: scene.replier.info.id });
		assert.equal(ask.status === "found" && ask.ask.state, "open");
		const next = reply(scene.replier, child.info.id, questionId);
		scene.b.router.routeSend(next.request);
		await vi.waitFor(() => assert.equal(handoffsTo(scene.owner).length, 2), waitFor);
		assert.equal(handoffsTo(scene.owner)[1]?.message.id, next.id);
	});

	test("a reply whose id another send already used is a conflict and claims nothing (#4386)", async () => {
		const scene = await releasedScene();
		const [{ child, questionId }] = scene.children as [{ child: Session; questionId: string }];
		const taken = randomUUID();
		const other = session("someone");
		await register(scene.a, other);
		await scene.b.state.outbox.enqueue({
			targetIdentity: deliveryTargetIdentity(other),
			originBrokerId: "a-broker",
			digest: "another send",
			frame: {
				type: "message",
				from: scene.replier.info,
				message: { id: taken, timestamp: 1, content: { text: "hi" } },
			},
		});
		const colliding = reply(scene.replier, child.info.id, questionId, { id: taken });
		scene.b.router.routeSend(colliding.request);
		const conflict = await vi.waitFor(() => {
			const frame = outcomesFor(scene.replier, taken).find((candidate) => candidate.type === "delivery_failed");
			assert.ok(frame?.type === "delivery_failed");
			return frame;
		}, waitFor);
		assert.equal(conflict.reasonCode, "message_id_conflict");
		await deliveredOnce(scene, child, questionId);
	});

	test("a claim abandoned before its row was written is taken over once it is as old as a stale outbox claim (#4386)", async () => {
		const scene = await releasedScene();
		const [{ child, questionId }] = scene.children as [{ child: Session; questionId: string }];
		const key = { questionId, replierSessionId: scene.replier.info.id };
		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - OUTBOX_CLAIM_STALE_AFTER_MS - 1_000 });
		await scene.b.state.releasedAsks.claim({ ...key, replyMessageId: "abandoned" });
		vi.useRealTimers();
		await deliveredOnce(scene, child, questionId);
		const fresh = await releasedScene();
		const [{ child: freshChild, questionId: freshQuestion }] = fresh.children as [
			{ child: Session; questionId: string },
		];
		await fresh.b.state.releasedAsks.claim({
			questionId: freshQuestion,
			replierSessionId: fresh.replier.info.id,
			replyMessageId: "recent",
		});
		const early = reply(fresh.replier, freshChild.info.id, freshQuestion);
		fresh.b.router.routeSend(early.request);
		const refused = await settled(fresh.replier, early.id);
		assert.ok(refused.type === "delivery_failed");
		assert.equal(refused.reasonCode, "released_reply_in_flight");
		assert.deepEqual(handoffsTo(fresh.owner), []);
	});

	test("an accepted reply whose answer was never recorded is recorded by the next reply, which is refused (#4386)", async () => {
		let recordAnswers = false;
		const scene = await releasedScene({
			wrapA: (state) => ({
				...state,
				releasedAsks: {
					...state.releasedAsks,
					answer: async (claim) => (recordAnswers ? state.releasedAsks.answer(claim) : { status: "settled" }),
				},
			}),
		});
		const [{ child, questionId }] = scene.children as [{ child: Session; questionId: string }];
		await deliveredOnce(scene, child, questionId);
		recordAnswers = true;
		const late = reply(scene.replier, child.info.id, questionId);
		scene.b.router.routeSend(late.request);
		const refused = await settled(scene.replier, late.id);
		assert.ok(refused.type === "delivery_failed");
		assert.equal(refused.reasonCode, "released_reply_answered");
		const ask = await scene.b.state.releasedAsks.lookup({ questionId, replierSessionId: scene.replier.info.id });
		assert.equal(ask.status === "found" && ask.ask.state, "answered");
		assert.equal(handoffsTo(scene.owner).length, 1);
	});

	test("a reply whose failed row still holds its question is taken over at once, and a late row of a superseded reply never reaches the owner (#4386)", async () => {
		const scene = await releasedScene();
		const [{ child, questionId }] = scene.children as [{ child: Session; questionId: string }];
		const key = { questionId, replierSessionId: scene.replier.info.id };
		const superseded = randomUUID();
		await scene.b.state.releasedAsks.claim({ ...key, replyMessageId: superseded });
		const frame = {
			type: "released_child_reply" as const,
			childName: "worker",
			replyTo: questionId,
			from: scene.replier.info,
			message: { id: superseded, timestamp: 1, replyTo: questionId, content: { text: "late" } },
		};
		const failedRow = await scene.b.state.outbox.enqueue({
			targetIdentity: "nobody-claims-this",
			originBrokerId: "b-broker",
			digest: "late",
			frame,
		});
		assert.equal(failedRow.status, "inserted");
		const held = await scene.b.state.outbox.claim({
			claimantId: "a-broker",
			targetIdentity: "nobody-claims-this",
			staleAfterMs: 30_000,
		});
		assert.ok(held.status === "claimed" && held.rows[0] !== undefined);
		await scene.b.state.outbox.markFailed(held.rows[0].claim, "the owner's broker stopped before reopening it");
		await deliveredOnce(scene, child, questionId);
		const late = await scene.b.state.outbox.enqueue({
			targetIdentity: deliveryTargetIdentity(scene.owner),
			originBrokerId: "b-broker",
			digest: "late-again",
			frame: { ...frame, message: { ...frame.message, id: randomUUID() } },
		});
		assert.equal(late.status, "inserted");
		const returned = reconnected(scene.owner);
		await register(scene.a, returned);
		await vi.waitFor(async () => {
			const row = late.status === "inserted" ? await scene.a.state.outbox.read(late.row.messageId) : undefined;
			assert.ok(row?.status === "found" && row.row.state === "failed");
			assert.equal(row.row.failureReason?.includes("released_reply_answered"), true);
		}, waitFor);
		assert.deepEqual(handoffsTo(returned), [], "the owner never sees the superseded reply");
	});

	test("a released asker's question is kept before its presence ends, so no reply finds it offline with only its pending ask (#4386)", async () => {
		const seen: string[] = [];
		let watched: { identity: string; questionId: string; replier: string } | undefined;
		const shared = await cluster();
		const a = await startNode(shared, (state) => ({
			...state,
			leases: {
				...state.leases,
				release: async (lease) => {
					if (
						watched !== undefined &&
						lease.key.kind === "presence" &&
						lease.key.targetIdentity === watched.identity
					) {
						const kept = await state.releasedAsks.lookup({
							questionId: watched.questionId,
							replierSessionId: watched.replier,
						});
						seen.push(kept.status);
					}
					return state.leases.release(lease);
				},
			},
		}));
		const owner = session("owner");
		await register(a, owner);
		const replier = session("replier");
		const child = session("worker", { supervisorId: owner.info.id });
		await register(a, child);
		const questionId = randomUUID();
		await a.state.pendingAsks.record({
			senderSessionId: child.info.id,
			targetSessionId: replier.info.id,
			messageId: questionId,
		});
		watched = { identity: deliveryTargetIdentity(child), questionId, replier: replier.info.id };
		await leave(a, child);
		assert.deepEqual(seen, ["found"]);
	});
});

describe("an ask to a subagent that is then released keeps waiting for it across nodes (#4386)", () => {
	const waitFor = { timeout: 2_000, interval: 5 };

	interface ParkedScene {
		readonly a: Node;
		readonly b: Node;
		readonly c: Node;
		readonly owner: Session;
		readonly child: Session;
		readonly remoteAsker: Session;
		readonly localAsker: Session;
		readonly questions: { readonly remote: string; readonly local: string };
	}

	/** The child and its owner on B; one asker on A and one on C asked the child, and the owner released it. */
	async function parkedScene(wrapB?: (state: State) => State): Promise<ParkedScene> {
		const shared = await cluster();
		const [a, b, c] = [await startNode(shared), await startNode(shared, wrapB), await startNode(shared)];
		const owner = session("owner");
		await register(b, owner);
		const child = session("worker", { supervisorId: owner.info.id });
		await register(b, child);
		const remoteAsker = session("remote-asker");
		await register(a, remoteAsker);
		const localAsker = session("local-asker");
		await register(c, localAsker);
		const questions = { remote: randomUUID(), local: randomUUID() };
		for (const [asker, messageId] of [
			[remoteAsker, questions.remote],
			[localAsker, questions.local],
		] as const) {
			await b.state.pendingAsks.record({
				senderSessionId: asker.info.id,
				targetSessionId: child.info.id,
				messageId,
			});
		}
		b.sessions.delete(child.info.id);
		b.router.sessionLeft(child, { ownerSessionId: owner.info.id, childName: "worker" });
		await flush();
		return { a, b, c, owner, child, remoteAsker, localAsker, questions };
	}

	function answer(from: Session, asker: Session, questionId: string) {
		return reply(from, asker.info.id, questionId, { expectedRecipientId: asker.info.id });
	}

	async function registerWoken(node: Node, woken: Session, owner: Session): Promise<void> {
		node.sessions.set(woken.info.id, woken);
		await node.router.sessionRegistered(woken, {
			childName: "worker",
			groups: new Set([CREW]),
			authorizedBy: owner.info.id,
		});
		await flush();
	}

	test("the woken subagent answers through any node, under its own id, exactly once (#4386)", async () => {
		const scene = await parkedScene();
		const woken = reconnected(scene.child);
		await registerWoken(scene.c, woken, scene.owner);
		const sent = answer(woken, scene.remoteAsker, scene.questions.remote);
		scene.c.router.routeSend(sent.request);
		await vi.waitFor(
			() =>
				assert.ok(
					framesOf(scene.remoteAsker).some((frame) => frame.type === "message" && frame.message.id === sent.id),
				),
			waitFor,
		);
		assert.deepEqual(
			framesOf(scene.localAsker).filter((frame) => frame.type === "peer_rebound"),
			[],
		);
	});

	test("a subagent woken under another id takes its asks along, and an asker on its node is told (#4386)", async () => {
		const scene = await parkedScene();
		const woken = reconnected(scene.child, randomUUID());
		await registerWoken(scene.c, woken, scene.owner);
		assert.deepEqual(
			framesOf(scene.localAsker).filter((frame) => frame.type === "peer_rebound"),
			[
				{
					type: "peer_rebound",
					replyTo: scene.questions.local,
					previousSessionId: scene.child.info.id,
					sessionId: woken.info.id,
				},
			],
		);
		const sent = answer(woken, scene.remoteAsker, scene.questions.remote);
		scene.c.router.routeSend(sent.request);
		await vi.waitFor(
			() =>
				assert.ok(
					framesOf(scene.remoteAsker).some((frame) => frame.type === "message" && frame.message.id === sent.id),
				),
			waitFor,
		);
		assert.deepEqual(
			framesOf(scene.remoteAsker).filter((frame) => frame.type === "peer_rebound"),
			[],
		);
	});

	const reboundFrames = (scene: ParkedScene, woken: Session) => [
		{
			type: "peer_rebound",
			replyTo: scene.questions.local,
			previousSessionId: scene.child.info.id,
			sessionId: woken.info.id,
		},
	];

	async function childPresenceLive(scene: ParkedScene): Promise<boolean> {
		const identity = deliveryTargetIdentity(scene.child);
		const live = await scene.b.state.leases.listLive("presence", BROKER_LEASE_STALE_AFTER_MS);
		return live.some((lease) => lease.subject.kind === "presence" && lease.subject.targetIdentity === identity);
	}

	test("a subagent woken under another id as soon as the broker it left gives its presence up takes its asks along (#4386)", async () => {
		const presenceGiven = Promise.withResolvers<void>();
		const scene = await parkedScene((state) => ({
			...state,
			leases: {
				...state.leases,
				release: async (lease) => {
					const released = await state.leases.release(lease);
					if (lease.key.kind === "presence") await presenceGiven.promise;
					return released;
				},
			},
		}));
		cleanups.push(async () => presenceGiven.resolve());
		await vi.waitFor(async () => assert.equal(await childPresenceLive(scene), false), waitFor);
		const woken = reconnected(scene.child, randomUUID());
		await registerWoken(scene.c, woken, scene.owner);
		presenceGiven.resolve();
		await vi.waitFor(
			() =>
				assert.deepEqual(
					framesOf(scene.localAsker).filter((frame) => frame.type === "peer_rebound"),
					reboundFrames(scene, woken),
				),
			waitFor,
		);
		const matched = await scene.c.state.pendingAsks.matchesReply({
			replySenderSessionId: woken.info.id,
			replyTargetSessionId: scene.remoteAsker.info.id,
			replyTo: scene.questions.remote,
		});
		assert.equal(matched.status, "match");
	});

	test("a subagent woken under another id while the broker it left still holds its presence takes its asks along once it has it (#4386)", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			const parking = Promise.withResolvers<void>();
			const scene = await parkedScene((state) => ({
				...state,
				pendingAsks: {
					...state.pendingAsks,
					parkForTarget: async (targetSessionId, park) => {
						await parking.promise;
						return state.pendingAsks.parkForTarget(targetSessionId, park);
					},
				},
			}));
			cleanups.push(async () => parking.resolve());
			const woken = reconnected(scene.child, randomUUID());
			await registerWoken(scene.c, woken, scene.owner);
			assert.equal(await childPresenceLive(scene), true, "the broker it left still holds its presence");
			vi.advanceTimersByTime(BROKER_LEASE_RENEW_INTERVAL_MS);
			await flush();
			assert.equal(await childPresenceLive(scene), true, "a renewal while it is held takes nothing over");
			parking.resolve();
			await vi.waitFor(async () => assert.equal(await childPresenceLive(scene), false), waitFor);
			assert.deepEqual(
				framesOf(scene.localAsker).filter((frame) => frame.type === "peer_rebound"),
				[],
			);
			vi.advanceTimersByTime(BROKER_LEASE_RENEW_INTERVAL_MS);
			await vi.waitFor(
				() =>
					assert.deepEqual(
						framesOf(scene.localAsker).filter((frame) => frame.type === "peer_rebound"),
						reboundFrames(scene, woken),
					),
				waitFor,
			);
			vi.advanceTimersByTime(BROKER_LEASE_RENEW_INTERVAL_MS);
			await flush();
			assert.equal(
				framesOf(scene.localAsker).filter((frame) => frame.type === "peer_rebound").length,
				1,
				"rebinds once",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a departing subagent whose asks cannot be parked is reported, and its presence still ends (#4386)", async () => {
		const scene = await parkedScene((state) => ({
			...state,
			pendingAsks: {
				...state.pendingAsks,
				parkForTarget: async () => {
					throw new Error("parking failed: shared database is unavailable");
				},
			},
		}));
		await vi.waitFor(async () => assert.equal(await childPresenceLive(scene), false), waitFor);
		assert.ok(vi.mocked(console.error).mock.calls.some(([text]) => String(text).includes("parking failed")));
	});

	test("asks to a subagent its owner dropped, or whose owner left, end, and a later answer is refused (#4386)", async () => {
		for (const ending of ["dropped", "owner-left"] as const) {
			const scene = await parkedScene();
			if (ending === "dropped")
				scene.b.router.restoringReleased(releasedReservationKey("worker"), scene.owner.info.id);
			else await leave(scene.b, scene.owner);
			await flush();
			const woken = reconnected(scene.child);
			await registerWoken(scene.c, woken, scene.owner);
			const sent = answer(woken, scene.remoteAsker, scene.questions.remote);
			scene.c.router.routeSend(sent.request);
			const refused = await settled(woken, sent.id);
			assert.ok(refused.type === "delivery_failed", ending);
			assert.equal(refused.reason, PENDING_REPLY_REFUSAL, ending);
		}
	});

	test("only the subagent its owner authorized takes its parked asks, without errors for any other registration (#4386)", async () => {
		const scene = await parkedScene();
		for (const consumed of [
			{ childName: "worker", groups: new Set([CREW]) },
			{ groups: new Set([CREW]), authorizedBy: scene.owner.info.id },
		]) {
			const impostor = session("worker");
			scene.c.sessions.set(impostor.info.id, impostor);
			await scene.c.router.sessionRegistered(impostor, consumed);
			await flush();
			assert.deepEqual(
				await scene.c.state.pendingAsks.matchesReply({
					replySenderSessionId: impostor.info.id,
					replyTargetSessionId: scene.remoteAsker.info.id,
					replyTo: scene.questions.remote,
				}),
				{ status: "no-match" },
			);
		}
		assert.deepEqual(vi.mocked(console.error).mock.calls, []);
		assert.deepEqual(framesOf(scene.localAsker), []);
	});

	test("asks to a subagent that simply left end with it, as before (#4386)", async () => {
		const shared = await cluster();
		const [a, b] = [await startNode(shared), await startNode(shared)];
		const asker = session("asker");
		await register(a, asker);
		const child = session("worker");
		await register(b, child);
		const questionId = randomUUID();
		await b.state.pendingAsks.record({
			senderSessionId: asker.info.id,
			targetSessionId: child.info.id,
			messageId: questionId,
		});
		await leave(b, child);
		assert.deepEqual(
			await a.state.pendingAsks.matchesReply({
				replySenderSessionId: child.info.id,
				replyTargetSessionId: asker.info.id,
				replyTo: questionId,
			}),
			{ status: "no-match" },
		);
	});
});

describe("released-asker reply decisions (#4386)", () => {
	const ask = {
		questionId: "q",
		askerSessionId: "asker-id",
		replierSessionId: "replier",
		childName: " Worker One ",
		ownerSessionId: "owner-id",
	};

	test("only a plain reply that answers a question is offered to a released asker (#4386)", () => {
		const message = (fields: object) => ({ id: "m", timestamp: 1, content: { text: "x" }, ...fields });
		assert.equal(isReleasedReplyCandidate({ supervisorSend: false, message: message({ replyTo: "q" }) }), true);
		assert.equal(isReleasedReplyCandidate({ supervisorSend: true, message: message({ replyTo: "q" }) }), false);
		assert.equal(isReleasedReplyCandidate({ supervisorSend: false, message: message({}) }), false);
		assert.equal(
			isReleasedReplyCandidate({ supervisorSend: false, message: message({ replyTo: "q", expectsReply: true }) }),
			false,
		);
		assert.equal(
			isReleasedReplyCandidate({ supervisorSend: false, message: message({ replyTo: "q", expectsReply: false }) }),
			true,
		);
	});

	test("a reply addresses the asker by its id or its name, and only the recipient it expects (#4386)", () => {
		assert.equal(addressesReleasedAsker(ask, "asker-id"), true);
		assert.equal(addressesReleasedAsker(ask, "worker one"), true);
		assert.equal(addressesReleasedAsker(ask, "  WORKER ONE"), true);
		assert.equal(addressesReleasedAsker(ask, "worker"), false);
		assert.equal(addressesReleasedAsker(ask, "ASKER-ID"), false);
		assert.equal(addressesReleasedAsker(ask, "asker-id", "asker-id"), true);
		assert.equal(addressesReleasedAsker(ask, "worker one", "someone-else"), false);
	});

	test("the owner's answer settles the handoff: refusing a redelivery is uncertain and closes the question (#4386)", () => {
		assert.deepEqual(releasedReplyAckOutcome(true, 1, "w"), { kind: "delivered" });
		assert.deepEqual(releasedReplyAckOutcome(true, 3, "w"), { kind: "delivered" });
		assert.deepEqual(releasedReplyAckOutcome(false, 1, "w"), {
			kind: "refused",
			reason: "Subagent `w` is released and no longer waiting for this reply",
			question: "reopen",
		});
		assert.deepEqual(releasedReplyAckOutcome(false, 2, "w"), {
			kind: "refused",
			reason: UNCERTAIN_RECEIPT_REASON,
			question: "answer",
		});
	});
});
