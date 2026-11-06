import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type net from "node:net";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const { MultiNodeRouter } = await import("../../packages/intercom/broker/multinode-router.js");
const { PendingQuestionIndex } = await import("../../packages/intercom/broker/pending-question-index.js");
const { SupervisorChannelCache } = await import("../../packages/intercom/broker/supervisor-channel.js");
const { releasedReservationKey } = await import("../../packages/intercom/broker/released-children.js");
const { deliveryTargetIdentity } = await import("../../packages/intercom/broker/send-handler.js");
const { UNCERTAIN_RECEIPT_REASON } = await import("../../packages/intercom/broker/recipient-receipts.js");
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
			pendingQuestions: new PendingQuestionIndex(),
			deliveredMessages: { lookupForTarget: () => "miss", lookupQuestionTarget: () => undefined },
			dispatch: () => {},
			revokeReleasedReservation: () => {},
		},
	});
	cleanups.push(() => router.close());
	await flush();
	return { router, sessions, state, deferred };
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

describe("released-asker reply decisions (#4386)", () => {
	const ask = { questionId: "q", askerSessionId: "asker-id", replierSessionId: "replier", childName: " Worker One " };

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
