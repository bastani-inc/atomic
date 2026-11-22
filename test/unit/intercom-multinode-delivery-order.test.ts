import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type net from "node:net";
import { join } from "node:path";
import { openNodeSqliteDatabase, type SqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { LOCAL_RETRY_LOOKUP_BOUND_MS, MultiNodeRouter } from "../../packages/intercom/broker/multinode-router.js";
import {
	borrowedDatabase,
	type OpenedBrokerState,
	openIntercomBrokerState,
} from "../../packages/intercom/broker/open-broker-state.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import {
	type BrokerConnectedSession,
	deliveryTargetIdentity,
	detachSend,
	handleBrokerSend,
	type SendClientMessage,
} from "../../packages/intercom/broker/send-handler.js";
import type { BrokerOutboundFrame } from "../../packages/intercom/broker/socket-writes.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import { normalizeGroup } from "../../packages/intercom/group.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const BUS_POLL_INTERVAL_MS = 20;
const WAIT_MS = 10_000;

type FakeSocket = net.Socket & { frames: BrokerOutboundFrame[] };

function fakeSocket(): FakeSocket {
	return { destroyed: false, writableEnded: false, frames: [] } as unknown as FakeSocket;
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

class BrokerNode {
	readonly sessions = new Map<string, BrokerConnectedSession>();
	readonly supervisorCache = new SupervisorChannelCache();
	readonly pendingQuestions = new PendingQuestionIndex();
	readonly deliveredMessages: DeliveredMessageCache;
	router!: MultiNodeRouter;
	opened!: OpenedBrokerState;

	constructor(
		readonly name: string,
		directory: string,
	) {
		this.deliveredMessages = new DeliveredMessageCache(
			undefined,
			undefined,
			join(directory, `${name}-delivered.sqlite`),
		);
	}

	static async start(name: string, directory: string, shared: SqliteDatabase): Promise<BrokerNode> {
		const node = new BrokerNode(name, directory);
		node.opened = await openIntercomBrokerState(
			{ openDatabase: async () => borrowedDatabase(shared), prefix: "mn_" },
			{ pollIntervalMs: BUS_POLL_INTERVAL_MS },
		);
		node.router = await MultiNodeRouter.start({
			state: node.opened.state,
			bus: node.opened.bus,
			host: {
				sessions: node.sessions,
				write: (socket, frame) => node.write(socket, frame),
				writeConfirmed: (socket, frame, onSettled) => onSettled(node.write(socket, frame)),
				supervisorCache: node.supervisorCache,
				pendingQuestions: node.pendingQuestions,
				deliveredMessages: node.deliveredMessages,
				dispatch: (socket, clientMessage, senderId) => node.dispatch(socket, clientMessage, senderId),
				revokeReleasedReservation: () => {},
				holdsReservation: () => false,
				fence: () => {},
			},
		});
		return node;
	}

	write(socket: net.Socket, frame: BrokerOutboundFrame): boolean {
		(socket as FakeSocket).frames.push(frame);
		return true;
	}

	async connect(
		name: string,
		options: { group?: string; returnAddress?: string; id?: string } = {},
	): Promise<BrokerConnectedSession> {
		const group = options.group ?? "default";
		const info: SessionInfo = {
			id: options.id ?? randomUUID(),
			name,
			cwd: "/work",
			model: "test/model",
			pid: 1,
			startedAt: 1,
			lastActivity: 1,
			status: "idle",
			group,
			groups: [group],
		};
		const session: BrokerConnectedSession = {
			socket: fakeSocket(),
			info,
			registrationGroup: normalizeGroup(group),
			registrationName: name,
			registrationReturnAddress: options.returnAddress ?? randomUUID(),
			acknowledgesReceipt: true,
		};
		this.sessions.set(info.id, session);
		await this.router.sessionRegistered(session);
		return session;
	}

	leave(session: BrokerConnectedSession): void {
		this.sessions.delete(session.info.id);
		this.router.sessionLeft(session);
	}

	dispatch(socket: net.Socket, clientMessage: SendClientMessage, senderId: string): void {
		handleBrokerSend(
			socket,
			clientMessage,
			senderId,
			this.sessions,
			this.deliveredMessages,
			(target, frame) => this.write(target, frame),
			this.supervisorCache,
			this.pendingQuestions,
			(target, frame, onSettled) => onSettled(this.write(target, frame)),
			undefined,
			undefined,
			(request) => this.router.routeSend(request),
		);
	}

	send(from: BrokerConnectedSession, to: string, msg: Message, extra: Record<string, unknown> = {}): void {
		this.dispatch(from.socket, { type: "send", to, message: msg, attemptId: randomUUID(), ...extra }, from.info.id);
	}

	async close(): Promise<void> {
		await this.router.close();
		this.deliveredMessages.close();
	}
}

function makeMessage(text: string, overrides: Partial<Message> = {}): Message {
	return { id: randomUUID(), timestamp: Date.now(), content: { text }, ...overrides };
}

function receivedTexts(session: BrokerConnectedSession): string[] {
	return (session.socket as FakeSocket).frames
		.filter((frame): frame is Extract<BrokerOutboundFrame, { type: "message" }> => frame.type === "message")
		.map((frame) => frame.message.content.text);
}

function outcomeOf(session: BrokerConnectedSession, messageId: string) {
	return (session.socket as FakeSocket).frames.find(
		(frame) =>
			(frame.type === "delivered" || frame.type === "delivery_failed" || frame.type === "queued") &&
			frame.messageId === messageId,
	);
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function cluster(count = 2): Promise<{ nodes: BrokerNode[]; shared: SqliteDatabase }> {
	const directory = makeTempDirectory("intercom-multinode-order-");
	const shared = await openNodeSqliteDatabase(join(directory, "shared.sqlite"));
	const nodes: BrokerNode[] = [];
	cleanups.push(async () => {
		for (const node of nodes) await node.close();
		await shared.close();
		removeTempDirectory(directory);
	});
	for (let index = 0; index < count; index++) {
		nodes.push(await BrokerNode.start(`node-${index}`, directory, shared));
	}
	return { nodes, shared };
}

test("local sends from one sender to one target stay in send order when pooled outbox reads return out of order", async () => {
	const { nodes } = await cluster(1);
	const a = nodes[0]!;
	const sender = await a.connect("sender");
	const target = await a.connect("target");
	const m1 = makeMessage("first");
	const m2 = makeMessage("second");
	const m3 = makeMessage("third");

	const outbox = a.opened.state.outbox;
	const origRead = outbox.read.bind(outbox);
	const m1Gate = deferred();
	const m1Started = deferred();
	const m2Finished = deferred();
	cleanups.push(async () => m1Gate.resolve());
	Object.assign(outbox, {
		read: async (messageId: string) => {
			if (messageId === m1.id) {
				m1Started.resolve();
				await m1Gate.promise;
				return origRead(messageId);
			}
			const result = await origRead(messageId);
			if (messageId === m2.id) m2Finished.resolve();
			return result;
		},
	});

	// Address the same target by name, exact id, and 8-hex prefix to verify canonical target identity keying.
	a.send(sender, "target", m1);
	await m1Started.promise;
	a.send(sender, target.info.id, m2);
	a.send(sender, target.info.id.slice(0, 8), m3);
	await m2Finished.promise;
	// Give m2/m3 a turn to overtake m1 if unserialized.
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.deepEqual(receivedTexts(target), [], "m2 and m3 must wait for earlier m1 to commit");

	m1Gate.resolve();
	await vi.waitFor(() => assert.deepEqual(receivedTexts(target), ["first", "second", "third"]), {
		timeout: WAIT_MS,
		interval: 10,
	});
});

test("a restored detached send and a reconnected live send from the same sender return address stay in send order", async () => {
	const { nodes } = await cluster(1);
	const a = nodes[0]!;
	const senderReturnAddress = randomUUID();
	const liveSender = await a.connect("sender", { returnAddress: senderReturnAddress });
	const target = await a.connect("target");

	// Restored detached sender has the pre-restart sessionId but the same registrationReturnAddress.
	const restoredSender: BrokerConnectedSession = {
		socket: fakeSocket(),
		info: { ...liveSender.info, id: randomUUID() },
		registrationGroup: liveSender.registrationGroup,
		registrationName: liveSender.registrationName,
		registrationReturnAddress: senderReturnAddress,
		acknowledgesReceipt: true,
	};
	const kept = makeMessage("kept-before-restart");
	const live = makeMessage("live-after-restart");
	const keptClientMessage: SendClientMessage = { type: "send", to: "target", message: kept, attemptId: randomUUID() };
	detachSend(keptClientMessage, restoredSender);

	const outbox = a.opened.state.outbox;
	const origRead = outbox.read.bind(outbox);
	const keptGate = deferred();
	const keptStarted = deferred();
	cleanups.push(async () => keptGate.resolve());
	Object.assign(outbox, {
		read: async (messageId: string) => {
			if (messageId === kept.id) {
				keptStarted.resolve();
				await keptGate.promise;
			}
			return origRead(messageId);
		},
	});

	a.dispatch(restoredSender.socket, keptClientMessage, restoredSender.info.id);
	await keptStarted.promise;
	a.send(liveSender, target.info.id, live);
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.deepEqual(receivedTexts(target), []);

	keptGate.resolve();
	await vi.waitFor(() => assert.deepEqual(receivedTexts(target), ["kept-before-restart", "live-after-restart"]), {
		timeout: WAIT_MS,
		interval: 10,
	});
});

test("mixed reply and plain send from one sender to one local target stay in send order", async () => {
	const { nodes } = await cluster(1);
	const a = nodes[0]!;
	const asker = await a.connect("asker");
	const replier = await a.connect("replier");

	// Establish a real ask so replier can send a correlated reply.
	const ask = makeMessage("question", { expectsReply: true });
	a.send(asker, "replier", ask);
	await vi.waitFor(() => assert.deepEqual(receivedTexts(replier), ["question"]), { timeout: WAIT_MS, interval: 10 });
	a.router.received(replier, ask.id);

	const reply = makeMessage("answer", { replyTo: ask.id });
	const followUp = makeMessage("after-answer");

	const outbox = a.opened.state.outbox;
	const origRead = outbox.read.bind(outbox);
	const replyGate = deferred();
	const replyStarted = deferred();
	cleanups.push(async () => replyGate.resolve());
	Object.assign(outbox, {
		read: async (messageId: string) => {
			if (messageId === reply.id) {
				replyStarted.resolve();
				await replyGate.promise;
			}
			return origRead(messageId);
		},
	});

	a.send(replier, asker.info.id, reply, { requirePendingReply: true, expectedRecipientId: asker.info.id });
	await replyStarted.promise;
	a.send(replier, "asker", followUp);
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.deepEqual(receivedTexts(asker), []);

	replyGate.resolve();
	await vi.waitFor(() => assert.deepEqual(receivedTexts(asker), ["answer", "after-answer"]), {
		timeout: WAIT_MS,
		interval: 10,
	});
});

test("cross-node sends from one sender to one remote target stay in send order when resolution finishes out of order", async () => {
	const { nodes } = await cluster(2);
	const [a, b] = [nodes[0]!, nodes[1]!];
	const sender = await a.connect("sender");
	const remote = await b.connect("remote");

	const m1 = makeMessage("remote-1");
	const m2 = makeMessage("remote-2");
	const m3 = makeMessage("remote-3");

	const outbox = a.opened.state.outbox;
	const origRead = outbox.read.bind(outbox);
	const m1Gate = deferred();
	const m1Started = deferred();
	const m2ReadDone = deferred();
	cleanups.push(async () => m1Gate.resolve());
	Object.assign(outbox, {
		read: async (messageId: string) => {
			if (messageId === m1.id) {
				m1Started.resolve();
				await m1Gate.promise;
				return origRead(messageId);
			}
			const result = await origRead(messageId);
			if (messageId === m2.id) m2ReadDone.resolve();
			return result;
		},
	});

	// Mix name, exact id, and 8-hex prefix across nodes.
	a.send(sender, "remote", m1);
	await m1Started.promise;
	a.send(sender, remote.info.id, m2);
	a.send(sender, remote.info.id.slice(0, 8), m3);
	await m2ReadDone.promise;
	await new Promise((resolve) => setTimeout(resolve, 30));
	// m2 and m3 must not have been enqueued ahead of m1!
	assert.equal((await outbox.read(m2.id)).status, "missing");
	assert.equal((await outbox.read(m3.id)).status, "missing");

	m1Gate.resolve();
	await vi.waitFor(() => assert.deepEqual(receivedTexts(remote), ["remote-1", "remote-2", "remote-3"]), {
		timeout: WAIT_MS,
		interval: 15,
	});
});

test("claimFor does not deliver a later row in a claimed batch ahead of an earlier row released on disconnect", async () => {
	const { nodes } = await cluster(2);
	const [a, b] = [nodes[0]!, nodes[1]!];
	const sender = await a.connect("sender");
	const targetReturn = randomUUID();
	// Connect and disconnect target on B so it is a known offline session.
	const initial = await b.connect("target", { returnAddress: targetReturn });
	const targetId = initial.info.id;
	b.leave(initial);
	await vi.waitFor(
		async () => {
			const lease = await a.opened.state.leases.read({
				kind: "presence",
				targetIdentity: deliveryTargetIdentity(initial),
			});
			assert.equal(lease.status, "missing");
		},
		{ timeout: WAIT_MS, interval: 15 },
	);

	// Queue two messages in the shared outbox for offline target.
	const m1 = makeMessage("queued-1");
	const m2 = makeMessage("queued-2");
	a.send(sender, targetId, m1);
	await vi.waitFor(() => assert.equal(outcomeOf(sender, m1.id)?.type, "queued"), { timeout: WAIT_MS, interval: 15 });
	a.send(sender, targetId, m2);
	await vi.waitFor(() => assert.equal(outcomeOf(sender, m2.id)?.type, "queued"), { timeout: WAIT_MS, interval: 15 });

	// Inject mid-batch disconnect right as claim returns [m1, m2], and reconnect during releaseClaim(m1)!
	const bOutbox = b.opened.state.outbox;
	const origClaim = bOutbox.claim.bind(bOutbox);
	const origRelease = bOutbox.releaseClaim.bind(bOutbox);
	let injected = false;
	let reconnected: BrokerConnectedSession | undefined;
	let firstConn: BrokerConnectedSession | undefined;
	Object.assign(bOutbox, {
		claim: async (...args: Parameters<typeof origClaim>) => {
			const result = await origClaim(...args);
			if (!injected && result.status === "claimed" && result.rows.length === 2 && firstConn !== undefined) {
				injected = true;
				// Simulate disconnect right after claim returned [m1, m2], before row 1 checks localSessionFor.
				b.leave(firstConn);
			}
			return result;
		},
		releaseClaim: async (...args: Parameters<typeof origRelease>) => {
			const res = await origRelease(...args);
			if (injected && reconnected === undefined && args[0].messageId === m1.id) {
				// Simulate target reconnecting while row 1's releaseClaim was awaiting!
				const info: SessionInfo = {
					id: randomUUID(),
					name: "target",
					cwd: "/work",
					model: "test/model",
					pid: 1,
					startedAt: 2,
					lastActivity: 2,
					status: "idle",
					group: "default",
					groups: ["default"],
				};
				reconnected = {
					socket: fakeSocket(),
					info,
					registrationGroup: normalizeGroup("default"),
					registrationName: "target",
					registrationReturnAddress: targetReturn,
					acknowledgesReceipt: true,
				};
				b.sessions.set(info.id, reconnected);
			}
			return res;
		},
	});

	firstConn = await b.connect("target", { returnAddress: targetReturn, id: targetId });
	await vi.waitFor(() => assert.ok(reconnected !== undefined), { timeout: WAIT_MS, interval: 15 });
	// Trigger scan for the reconnected session (as real sessionRegistered would).
	await b.router.sessionRegistered(reconnected!);
	await vi.waitFor(() => assert.deepEqual(receivedTexts(reconnected!), ["queued-1", "queued-2"]), {
		timeout: WAIT_MS,
		interval: 15,
	});
});

test("an outbox message queued while target was offline is delivered before a later local send after reconnect", async () => {
	const { nodes } = await cluster(1);
	const a = nodes[0]!;
	const sender = await a.connect("sender");
	const targetReturn = randomUUID();
	const initial = await a.connect("target", { returnAddress: targetReturn });
	const targetId = initial.info.id;
	const targetIdentity = deliveryTargetIdentity(initial);
	a.leave(initial);
	await vi.waitFor(
		async () => {
			const lease = await a.opened.state.leases.read({ kind: "presence", targetIdentity });
			assert.equal(lease.status, "missing");
		},
		{ timeout: WAIT_MS, interval: 15 },
	);

	// Send m1 while target is offline -> queued in shared outbox.
	const m1 = makeMessage("from-outbox");
	a.send(sender, targetId, m1);
	await vi.waitFor(() => assert.equal(outcomeOf(sender, m1.id)?.type, "queued"), { timeout: WAIT_MS, interval: 15 });

	// Slow down claim slightly (50ms < 300ms bound) so a concurrent local send's outbox.read finishes first.
	const outbox = a.opened.state.outbox;
	const origClaim = outbox.claim.bind(outbox);
	const claimStarted = deferred();
	const releaseClaimGate = deferred();
	cleanups.push(async () => releaseClaimGate.resolve());
	Object.assign(outbox, {
		claim: async (...args: Parameters<typeof origClaim>) => {
			if (args[0].targetIdentity === targetIdentity) {
				claimStarted.resolve();
				await releaseClaimGate.promise;
			}
			return origClaim(...args);
		},
	});

	const returned = await a.connect("target", { returnAddress: targetReturn, id: targetId });
	await claimStarted.promise;

	// Immediately send m2 locally while m1's outbox claim is still in flight.
	const m2 = makeMessage("local-after-return");
	a.send(sender, targetId, m2);
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.deepEqual(receivedTexts(returned), [], "local m2 must not overtake in-flight outbox claim of m1");

	releaseClaimGate.resolve();
	await vi.waitFor(() => assert.deepEqual(receivedTexts(returned), ["from-outbox", "local-after-return"]), {
		timeout: WAIT_MS,
		interval: 15,
	});
});

test("re-entrant local-to-remote fallback when target moves mid-lookup never deadlocks and keeps m1 before m2", async () => {
	const { nodes } = await cluster(2);
	const [a, b] = [nodes[0]!, nodes[1]!];
	const sender = await a.connect("sender");
	const targetReturn = randomUUID();
	const targetOnA = await a.connect("target", { returnAddress: targetReturn });
	const targetId = targetOnA.info.id;

	const m1 = makeMessage("moved-1");
	const m2 = makeMessage("moved-2");
	const aOutbox = a.opened.state.outbox;
	const origRead = aOutbox.read.bind(aOutbox);
	const m1Started = deferred();
	const m1Gate = deferred();
	cleanups.push(async () => m1Gate.resolve());
	let m1ReadCount = 0;
	Object.assign(aOutbox, {
		read: async (messageId: string) => {
			if (messageId === m1.id && m1ReadCount === 0) {
				m1ReadCount++;
				m1Started.resolve();
				await m1Gate.promise;
			}
			return origRead(messageId);
		},
	});

	// m1 enters while target is local on A.
	a.send(sender, targetId, m1);
	await m1Started.promise;

	// Target moves from A to B while m1's local lookup is in flight.
	a.leave(targetOnA);
	const targetOnB = await b.connect("target", { returnAddress: targetReturn, id: targetId });

	// m2 enters after target moved (goes directly to remote route!).
	a.send(sender, targetId, m2);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(
		(await origRead(m2.id)).status,
		"missing",
		"m2 must wait behind m1's in-flight local-to-remote fallback",
	);

	m1Gate.resolve();
	await vi.waitFor(() => assert.deepEqual(receivedTexts(targetOnB), ["moved-1", "moved-2"]), {
		timeout: WAIT_MS,
		interval: 15,
	});
});

test("pipelined local sends on a hung shared database all deliver within one LOCAL_RETRY_LOOKUP_BOUND_MS, in order", async () => {
	const { nodes } = await cluster(1);
	const a = nodes[0]!;
	const sender = await a.connect("sender");
	const target = await a.connect("target");

	const outbox = a.opened.state.outbox;
	const origRead = outbox.read.bind(outbox);
	const pendingReads: Array<() => void> = [];
	Object.assign(outbox, {
		read: () =>
			new Promise<Awaited<ReturnType<typeof origRead>>>((resolve) => {
				pendingReads.push(() => resolve({ status: "missing" }));
			}),
	});
	cleanups.push(async () => {
		Object.assign(outbox, { read: origRead });
		for (const finish of pendingReads.splice(0)) finish();
	});

	const count = 12;
	const startedAt = performance.now();
	const expected: string[] = [];
	for (let i = 0; i < count; i++) {
		const text = `burst-${i}`;
		expected.push(text);
		a.send(sender, "target", makeMessage(text));
	}

	await vi.waitFor(() => assert.deepEqual(receivedTexts(target), expected), {
		timeout: LOCAL_RETRY_LOOKUP_BOUND_MS + 1_500,
		interval: 15,
	});
	const elapsedMs = performance.now() - startedAt;
	// Naive full serialization would take 12 * 300ms = 3,600ms; pipelined takes ~1 * 300ms.
	assert.ok(
		elapsedMs < LOCAL_RETRY_LOOKUP_BOUND_MS * 3,
		`expected pipelined burst within ~1 local bound, got ${elapsedMs.toFixed(1)} ms`,
	);
});

test("a slow or hung send to one target does not block sends from the same sender to another target or from another sender", async () => {
	const { nodes } = await cluster(1);
	const a = nodes[0]!;
	const sender1 = await a.connect("sender-1");
	const sender2 = await a.connect("sender-2");
	const target1 = await a.connect("target-1");
	const target2 = await a.connect("target-2");

	const mSlow = makeMessage("slow-s1-t1");
	const mOtherTarget = makeMessage("fast-s1-t2");
	const mOtherSender = makeMessage("fast-s2-t1");

	const outbox = a.opened.state.outbox;
	const origRead = outbox.read.bind(outbox);
	const slowGate = deferred();
	const slowStarted = deferred();
	Object.assign(outbox, {
		read: async (messageId: string) => {
			if (messageId === mSlow.id) {
				slowStarted.resolve();
				await slowGate.promise;
			}
			return origRead(messageId);
		},
	});
	cleanups.push(async () => slowGate.resolve());

	a.send(sender1, "target-1", mSlow);
	await slowStarted.promise;

	const t0 = performance.now();
	a.send(sender1, "target-2", mOtherTarget);
	a.send(sender2, "target-1", mOtherSender);

	await vi.waitFor(
		() => {
			assert.deepEqual(receivedTexts(target2), ["fast-s1-t2"]);
			assert.deepEqual(receivedTexts(target1), ["fast-s2-t1"]);
		},
		{ timeout: WAIT_MS, interval: 10 },
	);
	assert.ok(performance.now() - t0 < LOCAL_RETRY_LOOKUP_BOUND_MS, "independent sends must not wait for hung target-1");
	slowGate.resolve();
});

test("a hung remote send does not block a local send to an already-local target or hang router.close()", async () => {
	const { nodes } = await cluster(1);
	const a = nodes[0]!;
	const sender = await a.connect("sender");
	const localTarget = await a.connect("local-target");

	// Stall listLive forever so a remote send to "missing-remote" hangs inside route().
	const leases = a.opened.state.leases;
	const origListLive = leases.listLive.bind(leases);
	const listLiveStarted = deferred();
	const releaseListLive = deferred();
	Object.assign(leases, {
		listLive: async (...args: Parameters<typeof origListLive>) => {
			listLiveStarted.resolve();
			await releaseListLive.promise;
			return origListLive(...args);
		},
	});
	cleanups.push(async () => {
		Object.assign(leases, { listLive: origListLive });
		releaseListLive.resolve();
	});

	a.send(sender, "missing-remote", makeMessage("hung-remote"));
	await listLiveStarted.promise;

	const t0 = performance.now();
	a.send(sender, "local-target", makeMessage("fast-local"));
	await vi.waitFor(() => assert.deepEqual(receivedTexts(localTarget), ["fast-local"]), {
		timeout: WAIT_MS,
		interval: 10,
	});
	assert.ok(performance.now() - t0 < LOCAL_RETRY_LOOKUP_BOUND_MS, "already-local target must skip hung remote send");

	// router.close() must return promptly even while the remote send is still hung in listLive().
	const closeStart = performance.now();
	await a.router.close();
	assert.ok(performance.now() - closeStart < 2_000, "router.close() must not hang behind hung remote send");
});

test("re-entrant local-to-remote fallback for two correlated replies never deadlocks with reply serial lane and stays ordered", async () => {
	const { nodes } = await cluster(2);
	const [a, b] = [nodes[0]!, nodes[1]!];
	const askerReturn = randomUUID();
	const askerOnA = await a.connect("asker", { returnAddress: askerReturn });
	const askerId = askerOnA.info.id;
	const replier = await a.connect("replier");

	// Asker sends two asks so replier can send two correlated replies.
	const ask1 = makeMessage("q1", { expectsReply: true });
	const ask2 = makeMessage("q2", { expectsReply: true });
	a.send(askerOnA, "replier", ask1);
	a.send(askerOnA, "replier", ask2);
	await vi.waitFor(() => assert.deepEqual(receivedTexts(replier), ["q1", "q2"]), { timeout: WAIT_MS, interval: 10 });
	a.router.received(replier, ask1.id);
	a.router.received(replier, ask2.id);

	const r1 = makeMessage("a1", { replyTo: ask1.id });
	const r2 = makeMessage("a2", { replyTo: ask2.id });
	const aOutbox = a.opened.state.outbox;
	const origRead = aOutbox.read.bind(aOutbox);
	const r1Started = deferred();
	const r1Gate = deferred();
	cleanups.push(async () => r1Gate.resolve());
	let r1ReadCount = 0;
	Object.assign(aOutbox, {
		read: async (messageId: string) => {
			if (messageId === r1.id && r1ReadCount === 0) {
				r1ReadCount++;
				r1Started.resolve();
				await r1Gate.promise;
			}
			return origRead(messageId);
		},
	});

	// r1 enters while asker is local on A; r2 queues behind it in both reply:S and SendOrderGate.
	a.send(replier, askerId, r1, { requirePendingReply: true, expectedRecipientId: askerId });
	await r1Started.promise;
	a.send(replier, askerId, r2, { requirePendingReply: true, expectedRecipientId: askerId });

	// Asker moves cleanly (resumable: ended=false) from A to B while r1's local lookup is in flight.
	a.sessions.delete(askerOnA.info.id);
	const questions = a.pendingQuestions.takeForSender(askerOnA.info.id);
	a.pendingQuestions.keepDormant(questions, askerReturn, () => true);
	await a.router.publishAwayRoutes(questions);
	a.router.sessionLeft(askerOnA, undefined, false);
	const askerOnB = await b.connect("asker", { returnAddress: askerReturn, id: askerId });

	r1Gate.resolve();
	await vi.waitFor(() => assert.deepEqual(receivedTexts(askerOnB), ["a1", "a2"]), {
		timeout: WAIT_MS,
		interval: 15,
	});
});

test("database error on an earlier local send still delivers both messages in send order via deliverLocally", async () => {
	const { nodes } = await cluster(1);
	const a = nodes[0]!;
	const sender = await a.connect("sender");
	const target = await a.connect("target");
	const m1 = makeMessage("m1-ok-slow");
	const m2 = makeMessage("m2-db-error-fast");

	const outbox = a.opened.state.outbox;
	const origRead = outbox.read.bind(outbox);
	const m1Started = deferred();
	const m1Gate = deferred();
	cleanups.push(async () => m1Gate.resolve());
	Object.assign(outbox, {
		read: async (messageId: string) => {
			if (messageId === m1.id) {
				m1Started.resolve();
				await m1Gate.promise;
				return origRead(messageId);
			}
			if (messageId === m2.id) {
				throw new Error("simulated transient pooled connection error");
			}
			return origRead(messageId);
		},
	});

	a.send(sender, "target", m1);
	await m1Started.promise;
	a.send(sender, "target", m2);
	await new Promise((resolve) => setTimeout(resolve, 25));
	// Even though m2's DB read threw immediately, deliverLocally waits for m1 before committing!
	assert.deepEqual(receivedTexts(target), []);

	m1Gate.resolve();
	await vi.waitFor(() => assert.deepEqual(receivedTexts(target), ["m1-ok-slow", "m2-db-error-fast"]), {
		timeout: WAIT_MS,
		interval: 10,
	});
});

test("a hung outbox claim during target reconnect still lets a local send deliver within LOCAL_RETRY_LOOKUP_BOUND_MS", async () => {
	const { nodes } = await cluster(1);
	const a = nodes[0]!;
	const sender = await a.connect("sender");
	const targetReturn = randomUUID();
	const initial = await a.connect("target", { returnAddress: targetReturn });
	const targetId = initial.info.id;
	const targetIdentity = deliveryTargetIdentity(initial);
	a.leave(initial);

	const outbox = a.opened.state.outbox;
	const origClaim = outbox.claim.bind(outbox);
	const releaseHungClaim = deferred();
	cleanups.push(async () => {
		Object.assign(outbox, { claim: origClaim });
		releaseHungClaim.resolve();
	});
	Object.assign(outbox, {
		claim: async (...args: Parameters<typeof origClaim>) => {
			if (args[0].targetIdentity === targetIdentity) {
				await releaseHungClaim.promise;
			}
			return origClaim(...args);
		},
	});

	const returned = await a.connect("target", { returnAddress: targetReturn, id: targetId });
	const t0 = performance.now();
	a.send(sender, targetId, makeMessage("bounded-local"));
	await vi.waitFor(() => assert.deepEqual(receivedTexts(returned), ["bounded-local"]), {
		timeout: LOCAL_RETRY_LOOKUP_BOUND_MS + 1_500,
		interval: 15,
	});
	assert.ok(performance.now() - t0 < LOCAL_RETRY_LOOKUP_BOUND_MS + 1_000);
});

test("a hung remote send followed by a local send to a newly joined target still delivers locally within LOCAL_RETRY_LOOKUP_BOUND_MS", async () => {
	const { nodes } = await cluster(1);
	const a = nodes[0]!;
	const sender = await a.connect("sender");

	const leases = a.opened.state.leases;
	const origListLive = leases.listLive.bind(leases);
	const listLiveStarted = deferred();
	const releaseListLive = deferred();
	cleanups.push(async () => {
		Object.assign(leases, { listLive: origListLive });
		releaseListLive.resolve();
	});
	Object.assign(leases, {
		listLive: async (...args: Parameters<typeof origListLive>) => {
			listLiveStarted.resolve();
			await releaseListLive.promise;
			return origListLive(...args);
		},
	});

	// Remote send enters before target joins A, and hangs in listLive().
	a.send(sender, "late-joiner", makeMessage("hung-remote"));
	await listLiveStarted.promise;

	// Target joins A AFTER the hung remote send arrived (so targetRegSeq > arrivedRegSeq).
	const joined = await a.connect("late-joiner");
	const t0 = performance.now();
	a.send(sender, "late-joiner", makeMessage("local-bounded"));
	await vi.waitFor(() => assert.deepEqual(receivedTexts(joined), ["local-bounded"]), {
		timeout: LOCAL_RETRY_LOOKUP_BOUND_MS + 1_500,
		interval: 15,
	});
	assert.ok(performance.now() - t0 < LOCAL_RETRY_LOOKUP_BOUND_MS + 1_000);
});

test("healthy local multi-node sends add zero outbox rows and zero extra outbox reads", async () => {
	const { nodes, shared } = await cluster(1);
	const a = nodes[0]!;
	const sender = await a.connect("sender");
	const target = await a.connect("target");

	let reads = 0;
	const outbox = a.opened.state.outbox;
	const origRead = outbox.read.bind(outbox);
	Object.assign(outbox, {
		read: async (messageId: string) => {
			reads++;
			return origRead(messageId);
		},
	});

	const count = 20;
	const expected: string[] = [];
	for (let i = 0; i < count; i++) {
		const text = `local-${i}`;
		expected.push(text);
		a.send(sender, "target", makeMessage(text));
	}
	await vi.waitFor(() => assert.deepEqual(receivedTexts(target), expected), { timeout: WAIT_MS, interval: 10 });
	assert.equal(reads, count, "exactly one outbox.read per local send");
	const outboxRows = (await shared.get<{ count: number }>("SELECT COUNT(*) AS count FROM mn_intercom_outbox"))!.count;
	assert.equal(Number(outboxRows), 0, "local sends never write plaintext message bodies to intercom_outbox");
});

test("SendOrderGate prunes idle senders and unblocks waiters immediately on close", async () => {
	const { SendOrderGate } = await import("../../packages/intercom/broker/send-order-gate.js");
	const gate = new SendOrderGate();

	const t1 = gate.begin({ senderKey: "s1", rawTarget: "t1", arrivedRegSeq: 1, isLocal: true, targetIdentity: "T1" });
	const t2 = gate.begin({ senderKey: "s1", rawTarget: "t1", arrivedRegSeq: 1, isLocal: true, targetIdentity: "T1" });
	const tOther = gate.begin({
		senderKey: "s1",
		rawTarget: "t2",
		arrivedRegSeq: 1,
		isLocal: true,
		targetIdentity: "T2",
	});
	assert.equal(gate.activeSenders, 1);
	// Uncontended first ticket & unrelated target return undefined synchronously (fast path).
	assert.equal(gate.waitForEarlier(t1, { targetIdentity: "T1" }), undefined);
	assert.equal(gate.waitForEarlier(tOther, { targetIdentity: "T2" }), undefined);

	const waiting = gate.waitForEarlier(t2, { targetIdentity: "T1" });
	assert.ok(waiting !== undefined);
	let released = false;
	const observed = waiting.then(() => {
		released = true;
	});
	await Promise.resolve();
	assert.equal(released, false);

	gate.finish(tOther);
	await Promise.resolve();
	assert.equal(released, false);

	gate.finish(t1);
	await observed;
	assert.equal(released, true);
	gate.finish(t2);
	assert.equal(gate.activeSenders, 0, "empty sender entry must be deleted immediately");

	// Close unblocks any pending waiter immediately.
	const hung = gate.begin({ senderKey: "s2", rawTarget: "remote", arrivedRegSeq: 1, isLocal: false });
	const behind = gate.begin({ senderKey: "s2", rawTarget: "remote", arrivedRegSeq: 1, isLocal: false });
	const blocked = gate.waitForEarlier(behind, { targetIdentity: "R1" });
	assert.ok(blocked !== undefined);
	gate.close();
	await blocked;
	assert.equal(gate.activeSenders, 0);
	gate.finish(hung);
	gate.finish(behind);
});

test("re-entrant local-to-remote fallback when target disconnects and reconnects mid-lookup keeps m1 ahead of m2", async () => {
	const { nodes } = await cluster(1);
	const a = nodes[0]!;
	const sender = await a.connect("sender");
	const targetReturn = randomUUID();
	const targetOld = await a.connect("target", { returnAddress: targetReturn });
	const targetId = targetOld.info.id;

	const m1 = makeMessage("m1-reentered");
	const m2 = makeMessage("m2-after-reconnect");
	const outbox = a.opened.state.outbox;
	const origRead = outbox.read.bind(outbox);
	const m1Started = deferred();
	const m2Started = deferred();
	const m1Gate = deferred();
	const m2Gate = deferred();
	const m1RemoteGate = deferred();
	cleanups.push(async () => {
		m1Gate.resolve();
		m2Gate.resolve();
		m1RemoteGate.resolve();
	});

	let m1Reads = 0;
	Object.assign(outbox, {
		read: async (messageId: string) => {
			if (messageId === m1.id && m1Reads === 0) {
				m1Reads++;
				m1Started.resolve();
				await m1Gate.promise;
			} else if (messageId === m2.id) {
				m2Started.resolve();
				await m2Gate.promise;
			}
			return origRead(messageId);
		},
	});

	// Both m1 and m2 enter answerLocalRetry against targetOld.
	a.send(sender, targetId, m1);
	await m1Started.promise;
	a.send(sender, targetId, m2);
	await m2Started.promise;

	// Hold m1's remote listLive once it falls back re-entrantly so targetNew can reconnect meanwhile.
	const leases = a.opened.state.leases;
	const origListLive = leases.listLive.bind(leases);
	let heldRemote = false;
	const m1ReenteredRemote = deferred();
	Object.assign(leases, {
		listLive: async (...args: Parameters<typeof origListLive>) => {
			if (!heldRemote) {
				heldRemote = true;
				m1ReenteredRemote.resolve();
				await m1RemoteGate.promise;
			}
			return origListLive(...args);
		},
	});
	cleanups.push(async () => {
		Object.assign(leases, { listLive: origListLive });
	});

	// targetOld disconnects -> release m1 so it re-enters remote routing.
	a.leave(targetOld);
	m1Gate.resolve();
	await m1ReenteredRemote.promise;

	// target reconnects as targetNew on A BEFORE m2 finishes its lookup!
	const targetNew = await a.connect("target", { returnAddress: targetReturn, id: targetId });
	m2Gate.resolve();
	await new Promise((resolve) => setTimeout(resolve, 25));
	// m2 must NOT skip m1's re-entered remote ticket (even though presence.get(targetOld) is undefined!).
	assert.deepEqual(receivedTexts(targetNew), []);

	m1RemoteGate.resolve();
	await vi.waitFor(() => assert.deepEqual(receivedTexts(targetNew), ["m1-reentered", "m2-after-reconnect"]), {
		timeout: WAIT_MS,
		interval: 15,
	});
});

test("a slow presence write during registration does not delay healthy local sends with no unsettled outbox rows", async () => {
	const { nodes } = await cluster(1);
	const a = nodes[0]!;
	const sender = await a.connect("sender");

	const leases = a.opened.state.leases;
	const origAcquire = leases.acquire.bind(leases);
	const acquireGate = deferred();
	const acquireStarted = deferred();
	cleanups.push(async () => {
		Object.assign(leases, { acquire: origAcquire });
		acquireGate.resolve();
	});
	Object.assign(leases, {
		acquire: async (...args: Parameters<typeof origAcquire>) => {
			if (args[0].kind === "presence" && args[0].session.name === "slow-reg-target") {
				acquireStarted.resolve();
				await acquireGate.promise;
			}
			return origAcquire(...args);
		},
	});

	const targetInfo: SessionInfo = {
		id: randomUUID(),
		name: "slow-reg-target",
		cwd: "/work",
		model: "test/model",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
		status: "idle",
		group: "default",
		groups: ["default"],
	};
	const target: BrokerConnectedSession = {
		socket: fakeSocket(),
		info: targetInfo,
		registrationGroup: normalizeGroup("default"),
		registrationName: "slow-reg-target",
		registrationReturnAddress: randomUUID(),
		acknowledgesReceipt: true,
	};
	a.sessions.set(targetInfo.id, target);
	const regPromise = a.router.sessionRegistered(target);
	await acquireStarted.promise;

	// Sender has zero unsettled outbox rows for target -> local delivery must NOT wait 300ms for registration!
	const t0 = performance.now();
	a.send(sender, "slow-reg-target", makeMessage("fast-during-slow-reg"));
	await vi.waitFor(() => assert.deepEqual(receivedTexts(target), ["fast-during-slow-reg"]), {
		timeout: WAIT_MS,
		interval: 5,
	});
	assert.ok(
		performance.now() - t0 < LOCAL_RETRY_LOOKUP_BOUND_MS,
		`expected fast local send without unsettled outbox, took ${(performance.now() - t0).toFixed(1)} ms`,
	);
	acquireGate.resolve();
	await regPromise;
});

test("an unrelated remote sender's slow outbox claim does not stall a local sender to the same target", async () => {
	const { nodes } = await cluster(2);
	const [a, b] = [nodes[0]!, nodes[1]!];
	const localSender = await a.connect("local-sender");
	const remoteSender = await b.connect("remote-sender");
	const target = await a.connect("target");
	const targetIdentity = deliveryTargetIdentity(target);

	const outbox = a.opened.state.outbox;
	const origClaim = outbox.claim.bind(outbox);
	const claimStarted = deferred();
	const claimGate = deferred();
	cleanups.push(async () => {
		Object.assign(outbox, { claim: origClaim });
		claimGate.resolve();
	});
	Object.assign(outbox, {
		claim: async (...args: Parameters<typeof origClaim>) => {
			if (args[0].targetIdentity === targetIdentity) {
				claimStarted.resolve();
				await claimGate.promise;
			}
			return origClaim(...args);
		},
	});

	// Remote sender on B triggers a slow claimFor(target) on A.
	b.send(remoteSender, "target", makeMessage("from-remote-s2"));
	await claimStarted.promise;

	// Unrelated local sender on A has no unsettled outbox rows for target -> must deliver immediately!
	const t0 = performance.now();
	a.send(localSender, "target", makeMessage("from-local-s1"));
	await vi.waitFor(() => assert.deepEqual(receivedTexts(target), ["from-local-s1"]), {
		timeout: WAIT_MS,
		interval: 5,
	});
	assert.ok(
		performance.now() - t0 < LOCAL_RETRY_LOOKUP_BOUND_MS,
		`unrelated local sender must not stall behind remote claim, took ${(performance.now() - t0).toFixed(1)} ms`,
	);
	claimGate.resolve();
});

test("a late database error during answerLocalRetry shares the remaining LOCAL_RETRY_LOOKUP_BOUND_MS budget in deliverLocally", async () => {
	const { nodes } = await cluster(1);
	const a = nodes[0]!;
	const sender = await a.connect("sender");

	// Hang an earlier remote send to a target that joins afterwards.
	const leases = a.opened.state.leases;
	const origListLive = leases.listLive.bind(leases);
	const listLiveStarted = deferred();
	const releaseListLive = deferred();
	cleanups.push(async () => {
		Object.assign(leases, { listLive: origListLive });
		releaseListLive.resolve();
	});
	Object.assign(leases, {
		listLive: async (...args: Parameters<typeof origListLive>) => {
			listLiveStarted.resolve();
			await releaseListLive.promise;
			return origListLive(...args);
		},
	});

	a.send(sender, "late-target", makeMessage("hung-remote"));
	await listLiveStarted.promise;
	const joined = await a.connect("late-target");

	// Inject a transient error on m2's outbox.read after 180 ms (within the 300 ms bound).
	const m2 = makeMessage("late-error-local");
	const outbox = a.opened.state.outbox;
	const origRead = outbox.read.bind(outbox);
	Object.assign(outbox, {
		read: async (messageId: string) => {
			if (messageId === m2.id) {
				await new Promise((resolve) => setTimeout(resolve, 180));
				throw new Error("late pooled read failure");
			}
			return origRead(messageId);
		},
	});
	cleanups.push(async () => {
		Object.assign(outbox, { read: origRead });
	});

	const t0 = performance.now();
	a.send(sender, "late-target", m2);
	await vi.waitFor(() => assert.deepEqual(receivedTexts(joined), ["late-error-local"]), {
		timeout: WAIT_MS,
		interval: 10,
	});
	const elapsedMs = performance.now() - t0;
	// Should finish around 300ms (180ms + 120ms remaining), NOT 480ms (180ms + fresh 300ms)!
	assert.ok(
		elapsedMs < LOCAL_RETRY_LOOKUP_BOUND_MS + 120,
		`deliverLocally must use remaining local bound, took ${elapsedMs.toFixed(1)} ms`,
	);
});

test("when m1 re-enters into a hung remote lookup after m2 already started waiting, local m2 still finishes within LOCAL_RETRY_LOOKUP_BOUND_MS", async () => {
	const { nodes } = await cluster(1);
	const a = nodes[0]!;
	const sender = await a.connect("sender");
	const targetReturn = randomUUID();
	const targetOld = await a.connect("target", { returnAddress: targetReturn });
	const targetId = targetOld.info.id;

	const m1 = makeMessage("m1-reenters-hung-db");
	const m2 = makeMessage("m2-bounded-local");
	const outbox = a.opened.state.outbox;
	const origRead = outbox.read.bind(outbox);
	const m1Started = deferred();
	const m1Gate = deferred();
	const m2ReadDone = deferred();
	const releaseHungRemote = deferred();
	cleanups.push(async () => {
		m1Gate.resolve();
		releaseHungRemote.resolve();
	});

	let m1Reads = 0;
	Object.assign(outbox, {
		read: async (messageId: string) => {
			if (messageId === m1.id && m1Reads === 0) {
				m1Reads++;
				m1Started.resolve();
				await m1Gate.promise;
			}
			const result = await origRead(messageId);
			if (messageId === m2.id) m2ReadDone.resolve();
			return result;
		},
	});

	// Hang listLive when m1 falls back to remote routing.
	const leases = a.opened.state.leases;
	const origListLive = leases.listLive.bind(leases);
	const m1HungInRemote = deferred();
	Object.assign(leases, {
		listLive: async (...args: Parameters<typeof origListLive>) => {
			m1HungInRemote.resolve();
			await releaseHungRemote.promise;
			return origListLive(...args);
		},
	});
	cleanups.push(async () => {
		Object.assign(leases, { listLive: origListLive });
	});

	// m1 enters against targetOld, then m2 enters and immediately finishes its read and starts waiting on local m1!
	a.send(sender, targetId, m1);
	await m1Started.promise;
	const t0 = performance.now();
	a.send(sender, targetId, m2);
	await m2ReadDone.promise;
	await new Promise((resolve) => setTimeout(resolve, 15));

	// targetOld leaves -> m1 falls back into hung remote listLive -> target reconnects as targetNew on A!
	a.leave(targetOld);
	m1Gate.resolve();
	await m1HungInRemote.promise;
	const targetNew = await a.connect("target", { returnAddress: targetReturn, id: targetId });

	// m2 must wake from its wait when m1 transitions local -> remote and deliver locally within 300ms!
	await vi.waitFor(() => assert.deepEqual(receivedTexts(targetNew), ["m2-bounded-local"]), {
		timeout: LOCAL_RETRY_LOOKUP_BOUND_MS + 1_500,
		interval: 15,
	});
	assert.ok(
		performance.now() - t0 < LOCAL_RETRY_LOOKUP_BOUND_MS + 1_000,
		`m2 must not hang when earlier m1 transitions to hung remote, took ${(performance.now() - t0).toFixed(1)} ms`,
	);
});

test("a correlated reply still adopts its shared route when the local asker reconnects on the same broker mid-lookup", async () => {
	const { nodes } = await cluster(1);
	const a = nodes[0]!;
	const askerReturn = randomUUID();
	const askerOld = await a.connect("asker", { returnAddress: askerReturn });
	const askerId = askerOld.info.id;
	const replier = await a.connect("replier");

	// Record the ask in the shared pendingAsks store (simulating an ask whose route moved to shared storage).
	const askId = randomUUID();
	await a.opened.state.pendingAsks.record({
		senderSessionId: askerId,
		targetSessionId: replier.info.id,
		messageId: askId,
	});

	const reply = makeMessage("valid-reply-after-reconnect", { replyTo: askId });
	const outbox = a.opened.state.outbox;
	const origRead = outbox.read.bind(outbox);
	const replyStarted = deferred();
	const replyGate = deferred();
	cleanups.push(async () => replyGate.resolve());
	Object.assign(outbox, {
		read: async (messageId: string) => {
			if (messageId === reply.id) {
				replyStarted.resolve();
				await replyGate.promise;
			}
			return origRead(messageId);
		},
	});

	a.send(replier, askerId, reply, { requirePendingReply: true, expectedRecipientId: askerId });
	await replyStarted.promise;

	// Asker disconnects and reconnects cleanly on the same broker under the same sessionId + returnAddress.
	a.sessions.delete(askerOld.info.id);
	a.router.sessionLeft(askerOld, undefined, false);
	const askerNew = await a.connect("asker", { returnAddress: askerReturn, id: askerId });

	replyGate.resolve();
	await vi.waitFor(() => assert.deepEqual(receivedTexts(askerNew), ["valid-reply-after-reconnect"]), {
		timeout: WAIT_MS,
		interval: 15,
	});
	assert.equal(outcomeOf(replier, reply.id)?.type, "delivered");
});
