import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type net from "node:net";
import { join } from "node:path";
import { openNodeSqliteDatabase, type SqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import {
	crossNodeDigest,
	LOCAL_RETRY_LOOKUP_BOUND_MS,
	MultiNodeRouter,
	PRESENCE_REGISTRATION_BOUND_MS,
} from "../../packages/intercom/broker/multinode-router.js";
import {
	borrowedDatabase,
	type OpenedBrokerState,
	openIntercomBrokerState,
} from "../../packages/intercom/broker/open-broker-state.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import { releasedReservationKey } from "../../packages/intercom/broker/released-children.js";
import {
	type BrokerConnectedSession,
	deliveryTargetIdentity,
	detachSend,
	handleBrokerSend,
	type SendClientMessage,
} from "../../packages/intercom/broker/send-handler.js";
import { buildMessageSendSignature } from "../../packages/intercom/broker/send-signature.js";
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
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function withFakeClocks(fn: () => Promise<void>): Promise<void> {
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
	});
	try {
		await fn();
	} finally {
		vi.useRealTimers();
	}
}

/** Flush microtasks and I/O turns without advancing fake timers. */
async function flushImmediate(turns = 12): Promise<void> {
	for (let index = 0; index < turns; index++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

/** Poll via `setImmediate` (without advancing fake timers) up to a real-clock safety cap. */
async function waitImmediate(check: () => void | Promise<void>, maxRealMs = WAIT_MS): Promise<void> {
	const deadline = process.hrtime.bigint() + BigInt(maxRealMs) * 1_000_000n;
	let lastError: unknown;
	while (process.hrtime.bigint() < deadline) {
		try {
			await check();
			return;
		} catch (error) {
			lastError = error;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}
	throw lastError ?? new Error("waitImmediate timed out");
}

/** Advance fake timers in `stepMs` increments until `check` passes, bounded by a real-clock safety cap. */
async function waitWithFakeStep(
	check: () => void | Promise<void>,
	stepMs = BUS_POLL_INTERVAL_MS,
	maxRealMs = WAIT_MS,
): Promise<void> {
	const deadline = process.hrtime.bigint() + BigInt(maxRealMs) * 1_000_000n;
	let lastError: unknown;
	while (process.hrtime.bigint() < deadline) {
		await flushImmediate(3);
		try {
			await check();
			return;
		} catch (error) {
			lastError = error;
			await vi.advanceTimersByTimeAsync(stepMs);
		}
	}
	throw lastError ?? new Error("waitWithFakeStep timed out");
}

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
	await withFakeClocks(async () => {
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
		await flushImmediate();
		assert.deepEqual(receivedTexts(target), [], "m2 and m3 must wait for earlier m1 to commit");

		m1Gate.resolve();
		await waitImmediate(() => assert.deepEqual(receivedTexts(target), ["first", "second", "third"]));
	});
});

test("a restored detached send and a reconnected live send from the same sender return address stay in send order", async () => {
	await withFakeClocks(async () => {
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
		const keptClientMessage: SendClientMessage = {
			type: "send",
			to: "target",
			message: kept,
			attemptId: randomUUID(),
		};
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
		await flushImmediate();
		assert.deepEqual(receivedTexts(target), []);

		keptGate.resolve();
		await waitImmediate(() => assert.deepEqual(receivedTexts(target), ["kept-before-restart", "live-after-restart"]));
	});
});

test("mixed reply and plain send from one sender to one local target stay in send order", async () => {
	await withFakeClocks(async () => {
		const { nodes } = await cluster(1);
		const a = nodes[0]!;
		const asker = await a.connect("asker");
		const replier = await a.connect("replier");

		// Establish a real ask so replier can send a correlated reply.
		const ask = makeMessage("question", { expectsReply: true });
		a.send(asker, "replier", ask);
		await waitImmediate(() => assert.deepEqual(receivedTexts(replier), ["question"]));
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
		await flushImmediate();
		assert.deepEqual(receivedTexts(asker), []);

		replyGate.resolve();
		await waitImmediate(() => assert.deepEqual(receivedTexts(asker), ["answer", "after-answer"]));
	});
});

test("cross-node sends from one sender to one remote target stay in send order when resolution finishes out of order", async () => {
	await withFakeClocks(async () => {
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
		await flushImmediate();
		// m2 and m3 must not have been enqueued ahead of m1!
		assert.equal((await outbox.read(m2.id)).status, "missing");
		assert.equal((await outbox.read(m3.id)).status, "missing");

		m1Gate.resolve();
		await waitWithFakeStep(() => assert.deepEqual(receivedTexts(remote), ["remote-1", "remote-2", "remote-3"]));
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
	await withFakeClocks(async () => {
		const { nodes } = await cluster(1);
		const a = nodes[0]!;
		const sender = await a.connect("sender");
		const targetReturn = randomUUID();
		const initial = await a.connect("target", { returnAddress: targetReturn });
		const targetId = initial.info.id;
		const targetIdentity = deliveryTargetIdentity(initial);
		a.leave(initial);
		await waitImmediate(async () => {
			const lease = await a.opened.state.leases.read({ kind: "presence", targetIdentity });
			assert.equal(lease.status, "missing");
		});

		// Send m1 while target is offline -> queued in shared outbox.
		const m1 = makeMessage("from-outbox");
		a.send(sender, targetId, m1);
		await waitImmediate(() => assert.equal(outcomeOf(sender, m1.id)?.type, "queued"));

		// Hold claim while fake timers freeze LOCAL_RETRY_LOOKUP_BOUND_MS so load cannot expire the 300 ms bound early.
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
		await flushImmediate();
		assert.deepEqual(receivedTexts(returned), [], "local m2 must not overtake in-flight outbox claim of m1");

		releaseClaimGate.resolve();
		await waitImmediate(() => assert.deepEqual(receivedTexts(returned), ["from-outbox", "local-after-return"]));
	});
});

test("re-entrant local-to-remote fallback when target moves mid-lookup never deadlocks and keeps m1 before m2", async () => {
	await withFakeClocks(async () => {
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

		// m1 enters while target is local on A; fake timers prevent 300ms expiry during b.connect under load.
		a.send(sender, targetId, m1);
		await m1Started.promise;

		// Target moves from A to B while m1's local lookup is in flight.
		const targetIdentity = deliveryTargetIdentity(targetOnA);
		a.leave(targetOnA);
		await waitImmediate(async () => {
			const lease = await a.opened.state.leases.read({ kind: "presence", targetIdentity });
			assert.equal(lease.status, "missing");
		});
		const targetOnB = await b.connect("target", { returnAddress: targetReturn, id: targetId });

		// m2 enters after target moved (goes directly to remote route!).
		a.send(sender, targetId, m2);
		await flushImmediate();
		assert.equal(
			(await origRead(m2.id)).status,
			"missing",
			"m2 must wait behind m1's in-flight local-to-remote fallback",
		);

		m1Gate.resolve();
		await waitImmediate(async () => {
			assert.equal((await origRead(m1.id)).status, "found");
			assert.equal((await origRead(m2.id)).status, "found");
		});
		await waitWithFakeStep(() => assert.deepEqual(receivedTexts(targetOnB), ["moved-1", "moved-2"]));
	});
});

test("pipelined local sends on a hung shared database all deliver within one LOCAL_RETRY_LOOKUP_BOUND_MS, in order", async () => {
	await withFakeClocks(async () => {
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
		const expected: string[] = [];
		for (let i = 0; i < count; i++) {
			const text = `burst-${i}`;
			expected.push(text);
			a.send(sender, "target", makeMessage(text));
		}

		await vi.advanceTimersByTimeAsync(LOCAL_RETRY_LOOKUP_BOUND_MS - 1);
		assert.deepEqual(receivedTexts(target), []);

		// All 12 pipelined local sends must complete at exact 1x LOCAL_RETRY_LOOKUP_BOUND_MS (never 12x).
		await vi.advanceTimersByTimeAsync(1);
		await waitImmediate(() => assert.deepEqual(receivedTexts(target), expected));
	});
});

test("a slow or hung send to one target does not block sends from the same sender to another target or from another sender", async () => {
	await withFakeClocks(async () => {
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

		// Independent sends deliver at simulated t=0 (without advancing the 300ms local timer at all!).
		a.send(sender1, "target-2", mOtherTarget);
		a.send(sender2, "target-1", mOtherSender);

		await waitImmediate(() => {
			assert.deepEqual(receivedTexts(target2), ["fast-s1-t2"]);
			assert.deepEqual(receivedTexts(target1), ["fast-s2-t1"]);
		});
		slowGate.resolve();
	});
});

test("a hung remote send does not block a local send to an already-local target or hang router.close()", async () => {
	await withFakeClocks(async () => {
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

		// Already-local target delivers at simulated t=0 (zero wait on 300ms bound).
		a.send(sender, "local-target", makeMessage("fast-local"));
		await waitImmediate(() => assert.deepEqual(receivedTexts(localTarget), ["fast-local"]));

		// router.close() must return promptly even while the remote send is still hung in listLive().
		await a.router.close();
	});
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
	await withFakeClocks(async () => {
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
		await flushImmediate();
		// Even though m2's DB read threw immediately, deliverLocally waits for m1 before committing!
		assert.deepEqual(receivedTexts(target), []);

		m1Gate.resolve();
		await waitImmediate(() => assert.deepEqual(receivedTexts(target), ["m1-ok-slow", "m2-db-error-fast"]));
	});
});

test("a hung outbox claim during target reconnect still lets a local send deliver within LOCAL_RETRY_LOOKUP_BOUND_MS", async () => {
	await withFakeClocks(async () => {
		const { nodes } = await cluster(1);
		const a = nodes[0]!;
		const sender = await a.connect("sender");
		const targetReturn = randomUUID();
		const initial = await a.connect("target", { returnAddress: targetReturn });
		const targetId = initial.info.id;
		const targetIdentity = deliveryTargetIdentity(initial);
		a.leave(initial);
		await waitImmediate(async () => {
			const lease = await a.opened.state.leases.read({ kind: "presence", targetIdentity });
			assert.equal(lease.status, "missing");
		});

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
		a.send(sender, targetId, makeMessage("bounded-local"));
		await vi.advanceTimersByTimeAsync(LOCAL_RETRY_LOOKUP_BOUND_MS);
		await waitImmediate(() => assert.deepEqual(receivedTexts(returned), ["bounded-local"]));
	});
});

test("a hung remote send followed by a local send to a newly joined target still delivers locally within LOCAL_RETRY_LOOKUP_BOUND_MS", async () => {
	await withFakeClocks(async () => {
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
		a.send(sender, "late-joiner", makeMessage("local-bounded"));
		await vi.advanceTimersByTimeAsync(LOCAL_RETRY_LOOKUP_BOUND_MS);
		await waitImmediate(() => assert.deepEqual(receivedTexts(joined), ["local-bounded"]));
	});
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
	await withFakeClocks(async () => {
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
		const targetIdentity = deliveryTargetIdentity(targetOld);
		a.leave(targetOld);
		await waitImmediate(async () => {
			const lease = await a.opened.state.leases.read({ kind: "presence", targetIdentity });
			assert.equal(lease.status, "missing");
		});
		m1Gate.resolve();
		await m1ReenteredRemote.promise;

		// target reconnects as targetNew on A BEFORE m2 finishes its lookup!
		const targetNew = await a.connect("target", { returnAddress: targetReturn, id: targetId });
		m2Gate.resolve();
		await flushImmediate();
		// m2 must NOT skip m1's re-entered remote ticket (even though presence.get(targetOld) is undefined!).
		assert.deepEqual(receivedTexts(targetNew), []);

		m1RemoteGate.resolve();
		await waitImmediate(() => assert.deepEqual(receivedTexts(targetNew), ["m1-reentered", "m2-after-reconnect"]));
	});
});

test("a slow presence write during registration does not delay healthy local sends with no unsettled outbox rows", async () => {
	await withFakeClocks(async () => {
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

		// Sender has zero unsettled outbox rows for target -> local delivery completes at simulated t=0 (no 300ms wait!).
		a.send(sender, "slow-reg-target", makeMessage("fast-during-slow-reg"));
		await waitImmediate(() => assert.deepEqual(receivedTexts(target), ["fast-during-slow-reg"]));
		acquireGate.resolve();
		await regPromise;
	});
});

test("an unrelated remote sender's slow outbox claim does not stall a local sender to the same target", async () => {
	await withFakeClocks(async () => {
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
		let claimBegan = false;
		void claimStarted.promise.then(() => {
			claimBegan = true;
		});
		await waitWithFakeStep(() => assert.equal(claimBegan, true));

		// Unrelated local sender on A has no unsettled outbox rows -> delivers immediately without advancing timers!
		a.send(localSender, "target", makeMessage("from-local-s1"));
		await waitImmediate(() => assert.deepEqual(receivedTexts(target), ["from-local-s1"]));
		claimGate.resolve();
	});
});

test("a late database error during answerLocalRetry shares the remaining LOCAL_RETRY_LOOKUP_BOUND_MS budget in deliverLocally", async () => {
	await withFakeClocks(async () => {
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

		a.send(sender, "late-target", m2);
		// Must finish at exact remaining local bound (180ms + 120ms = 300ms), NOT 180ms + fresh 300ms = 480ms!
		await vi.advanceTimersByTimeAsync(LOCAL_RETRY_LOOKUP_BOUND_MS);
		await waitImmediate(() => assert.deepEqual(receivedTexts(joined), ["late-error-local"]));
	});
});

test("when m1 re-enters into a hung remote lookup after m2 already started waiting, local m2 still finishes within LOCAL_RETRY_LOOKUP_BOUND_MS", async () => {
	await withFakeClocks(async () => {
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
		a.send(sender, targetId, m2);
		await m2ReadDone.promise;
		await flushImmediate();

		// targetOld leaves -> m1 falls back into hung remote listLive -> target reconnects as targetNew on A!
		const targetIdentity = deliveryTargetIdentity(targetOld);
		a.leave(targetOld);
		await waitImmediate(async () => {
			const lease = await a.opened.state.leases.read({ kind: "presence", targetIdentity });
			assert.equal(lease.status, "missing");
		});
		m1Gate.resolve();
		await m1HungInRemote.promise;
		const targetNew = await a.connect("target", { returnAddress: targetReturn, id: targetId });

		// m2 must wake when m1 transitions local -> remote and deliver locally at exact LOCAL_RETRY_LOOKUP_BOUND_MS!
		await vi.advanceTimersByTimeAsync(LOCAL_RETRY_LOOKUP_BOUND_MS);
		await waitImmediate(() => assert.deepEqual(receivedTexts(targetNew), ["m2-bounded-local"]));
	});
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

test("a plain local send behind a local reply parked behind a hung remote reply still completes within LOCAL_RETRY_LOOKUP_BOUND_MS", async () => {
	await withFakeClocks(async () => {
		const { nodes } = await cluster(1);
		const a = nodes[0]!;
		const sender = await a.connect("sender");
		const localTarget = await a.connect("local-target");
		a.pendingQuestions.record(localTarget.info.id, sender.info.id, "ask-local-r1");

		const leases = a.opened.state.leases;
		const origListLive = leases.listLive.bind(leases);
		const releaseListLive = deferred();
		cleanups.push(async () => {
			Object.assign(leases, { listLive: origListLive });
			releaseListLive.resolve();
		});
		Object.assign(leases, {
			listLive: async (...args: Parameters<typeof origListLive>) => {
				await releaseListLive.promise;
				return origListLive(...args);
			},
		});

		// Remote reply r0 hangs in listLive inside serial("reply:S"), parking local reply r1 behind it;
		// plain local send m2 must still finish at exact LOCAL_RETRY_LOOKUP_BOUND_MS (never hang!).
		a.send(sender, "remote-r", makeMessage("r0-remote-reply", { replyTo: "ask-remote-r0" }));
		a.send(sender, localTarget.info.id, makeMessage("r1-local-reply", { replyTo: "ask-local-r1" }));
		a.send(sender, localTarget.info.id, makeMessage("m2-plain-local"));

		await vi.advanceTimersByTimeAsync(LOCAL_RETRY_LOOKUP_BOUND_MS);
		await waitImmediate(() => assert.deepEqual(receivedTexts(localTarget), ["m2-plain-local"]));
	});
});

test("a plain local send behind a local requirePendingReply or soft reply on a hung DB still finishes within LOCAL_RETRY_LOOKUP_BOUND_MS", async () => {
	for (const requirePendingReply of [true, false]) {
		await withFakeClocks(async () => {
			const { nodes } = await cluster(1);
			const a = nodes[0]!;
			const sender = await a.connect("sender");
			const target = await a.connect("target");

			const { outbox, pendingAsks, leases } = a.opened.state;
			const origRead = outbox.read.bind(outbox);
			const origMatches = pendingAsks.matchesReply.bind(pendingAsks);
			const origListLive = leases.listLive.bind(leases);
			const release = deferred();
			cleanups.push(async () => {
				Object.assign(outbox, { read: origRead });
				Object.assign(pendingAsks, { matchesReply: origMatches });
				Object.assign(leases, { listLive: origListLive });
				release.resolve();
			});
			Object.assign(outbox, { read: () => release.promise.then(() => ({ status: "missing" as const })) });
			Object.assign(pendingAsks, {
				matchesReply: () => release.promise.then(() => ({ status: "miss" as const })),
			});
			Object.assign(leases, { listLive: () => release.promise.then(() => []) });

			a.send(sender, target.info.id, makeMessage("r1-reply", { replyTo: "ask-crossnode" }), {
				...(requirePendingReply ? { requirePendingReply: true } : {}),
			});
			a.send(sender, target.info.id, makeMessage("m2-plain"));

			await vi.advanceTimersByTimeAsync(LOCAL_RETRY_LOOKUP_BOUND_MS);
			await waitImmediate(() => assert.ok(receivedTexts(target).includes("m2-plain")));
		});
	}
});

test("a plain local send behind an already-delivered local retry whose accept hangs still delivers immediately", async () => {
	await withFakeClocks(async () => {
		const { nodes } = await cluster(1);
		const a = nodes[0]!;
		const sender = await a.connect("sender");
		const target = await a.connect("target");

		const m1 = makeMessage("m1-retry");
		const sig = buildMessageSendSignature(target.info.id, m1, sender.registrationReturnAddress ?? sender.info.id);
		const digest = createHash("sha256").update(sig).digest("hex");
		const syntheticRow = {
			messageId: m1.id,
			sequence: 1,
			targetIdentity: deliveryTargetIdentity(target),
			originBrokerId: "broker-other",
			digest,
			state: "delivered" as const,
			claimAttempts: 1,
			frame: { type: "message" as const, from: sender.info, message: m1 },
		};

		const { outbox, sentMessages } = a.opened.state;
		const origRead = outbox.read.bind(outbox);
		const origAccept = sentMessages.accept.bind(sentMessages);
		const releaseAccept = deferred();
		cleanups.push(async () => {
			Object.assign(outbox, { read: origRead });
			Object.assign(sentMessages, { accept: origAccept });
			releaseAccept.resolve();
		});
		Object.assign(outbox, {
			read: async (id: string) => (id === m1.id ? { status: "found" as const, row: syntheticRow } : origRead(id)),
		});
		Object.assign(sentMessages, {
			accept: async (...args: Parameters<typeof origAccept>) => {
				await releaseAccept.promise;
				return origAccept(...args);
			},
		});

		a.send(sender, target.info.id, m1);
		a.send(sender, target.info.id, makeMessage("m2-plain-local"));

		// Delivered immediately at simulated t=0 (does NOT wait for hung sentMessages.accept or 300ms bound!).
		await waitImmediate(() => assert.deepEqual(receivedTexts(target), ["m2-plain-local"]));
	});
});

test("a plain local send already waiting on m1 wakes and stays bounded if m1 later enters a hung reply or outbox path", async () => {
	await withFakeClocks(async () => {
		const { nodes } = await cluster(1);
		const a = nodes[0]!;
		const sender = await a.connect("sender");
		const target = await a.connect("target");

		const m1 = makeMessage("m1-soft-reply", { replyTo: "ask-slow" });
		const m2 = makeMessage("m2-waiting-plain");
		const { outbox, pendingAsks } = a.opened.state;
		const origRead = outbox.read.bind(outbox);
		const origMatches = pendingAsks.matchesReply.bind(pendingAsks);
		const m1ReadGate = deferred();
		const m2ReadDone = deferred();
		const matchesEntered = deferred();
		const releaseMatches = deferred();
		cleanups.push(async () => {
			Object.assign(outbox, { read: origRead });
			Object.assign(pendingAsks, { matchesReply: origMatches });
			m1ReadGate.resolve();
			releaseMatches.resolve();
		});
		Object.assign(outbox, {
			read: async (id: string) => {
				if (id === m1.id) {
					const res = await origRead(id);
					await m1ReadGate.promise;
					return res;
				}
				const res = await origRead(id);
				if (id === m2.id) m2ReadDone.resolve();
				return res;
			},
		});
		Object.assign(pendingAsks, {
			matchesReply: async (...args: Parameters<typeof origMatches>) => {
				matchesEntered.resolve();
				await releaseMatches.promise;
				return origMatches(...args);
			},
		});

		// m1 starts slow outbox.read; m2 finishes outbox.read first and enters waitLoop BEFORE m1 reaches adoptSharedRouteWithin.
		// Case 1: soft reply starts bounded, finishes outbox.read at 80ms, then hangs in adoptSharedRouteWithin (soft bound 300ms):
		// m2 waits through m1's silence window (80 + 300 = 380ms) and both deliver in FIFO order without stalling 5s.
		a.send(sender, target.info.id, m1);
		a.send(sender, target.info.id, m2);
		await m2ReadDone.promise;
		await flushImmediate();

		// Now m1's outbox.read finishes at t=80ms (recording store progress) and m1 enters hung adoptSharedRouteWithin!
		await vi.advanceTimersByTimeAsync(80);
		m1ReadGate.resolve();
		await matchesEntered.promise;
		await flushImmediate();

		await vi.advanceTimersByTimeAsync(LOCAL_RETRY_LOOKUP_BOUND_MS);
		await waitImmediate(() => assert.deepEqual(receivedTexts(target), ["m1-soft-reply", "m2-waiting-plain"]));

		// Case 2: m3 starts as a plain local send (unbounded=false) while m4 waits on it via awaitUnbounded, then m3's
		// outbox.read returns an unsettled row at t+80ms and hangs in answerExistingRow (5s/30s wait): m4 must wake via
		// awaitUnbounded and deliver after one silence window (80 + 300 = 380ms) while m3 remains hung!
		const m3 = makeMessage("m3-unsettled-retry");
		const m4 = makeMessage("m4-waiting-plain");
		const m3ReadGate = deferred();
		const m4ReadDone = deferred();
		const publishEntered = deferred();
		const busPublishHang = deferred();
		const origPublish = a.opened.bus.publish.bind(a.opened.bus);
		cleanups.push(async () => {
			Object.assign(a.opened.bus, { publish: origPublish });
			m3ReadGate.resolve();
			busPublishHang.resolve();
		});
		Object.assign(a.opened.bus, {
			publish: async () => {
				publishEntered.resolve();
				await busPublishHang.promise;
			},
		});
		const m3Sig = buildMessageSendSignature(target.info.id, m3, sender.registrationReturnAddress ?? sender.info.id);
		const m3Row = {
			messageId: m3.id,
			sequence: 1,
			targetIdentity: deliveryTargetIdentity(target),
			originBrokerId: "broker-other",
			digest: crossNodeDigest(m3Sig),
			state: "queued" as const,
			claimAttempts: 0,
			frame: { type: "message" as const, from: sender.info, message: m3 },
		};
		Object.assign(outbox, {
			read: async (id: string) => {
				if (id === m3.id) {
					await m3ReadGate.promise;
					return { status: "found" as const, row: m3Row };
				}
				const res = await origRead(id);
				if (id === m4.id) m4ReadDone.resolve();
				return res;
			},
		});

		a.send(sender, target.info.id, m3);
		a.send(sender, target.info.id, m4);
		await m4ReadDone.promise;
		await flushImmediate();

		await vi.advanceTimersByTimeAsync(80);
		m3ReadGate.resolve();
		await publishEntered.promise;
		await flushImmediate();

		await vi.advanceTimersByTimeAsync(LOCAL_RETRY_LOOKUP_BOUND_MS);
		await waitImmediate(() =>
			assert.deepEqual(receivedTexts(target), ["m1-soft-reply", "m2-waiting-plain", "m4-waiting-plain"]),
		);
	});
});

test("holdForRemoteReservation and routeReleasedReply (remote and local) are not blocked by a hung remote send to an unrelated target", async () => {
	await withFakeClocks(async () => {
		const { nodes } = await cluster(2);
		const [a, b] = [nodes[0]!, nodes[1]!];
		const sender = await a.connect("sender");
		const ownerB = await b.connect("ownerB");

		// Broker B reserves restoring child-c and released-child-c.
		await b.router.restoringReserved("cap-child-c", ownerB.info.id, "child-c", "default", [], false, { wake: false });
		await b.router.restoringReserved(
			releasedReservationKey("released-child-c"),
			ownerB.info.id,
			"released-child-c",
			"default",
			[],
			false,
			{ wake: true },
		);

		const remoteChildId = randomUUID();
		const remoteAskId = randomUUID();
		const wokenChild = await a.connect("released-child-c");
		const localAskId = randomUUID();
		await a.opened.state.releasedAsks.keep(
			[
				{
					questionId: remoteAskId,
					askerSessionId: remoteChildId,
					replierSessionId: sender.info.id,
					childName: "released-child-c",
					ownerSessionId: ownerB.info.id,
				},
				{
					questionId: localAskId,
					askerSessionId: wokenChild.info.id,
					replierSessionId: sender.info.id,
					childName: "released-child-c",
					ownerSessionId: ownerB.info.id,
				},
			],
			60_000,
		);

		// Hang knownSessions.lookup ONLY for unrelated "target-1".
		const ks = a.opened.state.knownSessions;
		const origLookup = ks.lookup.bind(ks);
		const releaseLookup = deferred();
		cleanups.push(async () => {
			Object.assign(ks, { lookup: origLookup });
			releaseLookup.resolve();
		});
		Object.assign(ks, {
			lookup: async (target: string, retentionMs: number) => {
				if (target === "target-1") await releaseLookup.promise;
				return origLookup(target, retentionMs);
			},
		});

		// Unrelated hung remote send enters phase="resolving".
		a.send(sender, "target-1", makeMessage("hung-unrelated"));
		await flushImmediate();

		// R3a: holdForRemoteReservation to child-c must hold immediately without waiting on target-1!
		const holdMsg = makeMessage("to-child-c");
		a.send(sender, "child-c", holdMsg, { awaitRestoringRecipient: true });
		await waitImmediate(() =>
			assert.ok(
				(sender.socket as FakeSocket).frames.some(
					(frame) => frame.type === "send_held" && frame.messageId === holdMsg.id,
				),
			),
		);

		// R3b + R3c: remote and local routeReleasedReply must enqueue immediately without waiting on target-1!
		const rRemote = makeMessage("reply-remote-released", { replyTo: remoteAskId });
		const rLocal = makeMessage("reply-local-released", { replyTo: localAskId });
		a.send(sender, remoteChildId, rRemote, { requirePendingReply: true });
		a.send(sender, wokenChild.info.id, rLocal, { requirePendingReply: true });
		// Wait for Broker A to enqueue both replies at simulated t=0 before stepping Broker B's bus poll timer.
		await waitImmediate(async () => {
			assert.equal((await a.opened.state.outbox.read(rRemote.id)).status, "found");
			assert.equal((await a.opened.state.outbox.read(rLocal.id)).status, "found");
		});
		await waitWithFakeStep(() => {
			const handoffs = (ownerB.socket as FakeSocket).frames.filter((frame) => frame.type === "released_child_reply");
			assert.equal(handoffs.length, 2);
		});

		// sessionLeft(sender) must also finish promptly (serial("reply:sender") is not blocked on target-1)!
		a.leave(sender);
		await waitImmediate(async () => {
			const lease = await a.opened.state.leases.read({
				kind: "presence",
				targetIdentity: deliveryTargetIdentity(sender),
			});
			assert.equal(lease.status, "missing");
		});
	});
});

test("sequential local sends to a newly registered target do not wait on a hung remote send to an unrelated target", async () => {
	await withFakeClocks(async () => {
		const { nodes } = await cluster(1);
		const a = nodes[0]!;
		const sender = await a.connect("sender");

		const ks = a.opened.state.knownSessions;
		const origLookup = ks.lookup.bind(ks);
		const releaseLookup = deferred();
		cleanups.push(async () => {
			Object.assign(ks, { lookup: origLookup });
			releaseLookup.resolve();
		});
		Object.assign(ks, {
			lookup: async (target: string, retentionMs: number) => {
				if (target === "remote-bob") await releaseLookup.promise;
				return origLookup(target, retentionMs);
			},
		});

		// m1 to unrelated "remote-bob" hangs in knownSessions.lookup BEFORE local-alice registers.
		a.send(sender, "remote-bob", makeMessage("hung-bob"));
		await flushImmediate();

		// local-alice registers AFTER m1 started (registeredSeq > m1.arrivedRegSeq).
		const alice = await a.connect("local-alice");

		// All 4 sequential local sends must deliver at simulated t=0 (zero 300ms stalls!).
		for (let i = 0; i < 4; i++) {
			const text = `alice-${i}`;
			a.send(sender, alice.info.id, makeMessage(text));
			await waitImmediate(() => assert.ok(receivedTexts(alice).includes(text)));
		}
		assert.deepEqual(receivedTexts(alice), ["alice-0", "alice-1", "alice-2", "alice-3"]);
	});
});

test("mixed burst with two serialized shared-route local replies preserves FIFO when cumulative reply steps exceed LOCAL_RETRY_LOOKUP_BOUND_MS", async () => {
	await withFakeClocks(async () => {
		const { nodes } = await cluster(1);
		const a = nodes[0]!;
		const sender = await a.connect("sender");
		const target = await a.connect("target");

		const ask1 = randomUUID();
		const ask2 = randomUUID();
		await a.opened.state.pendingAsks.record({
			senderSessionId: target.info.id,
			targetSessionId: sender.info.id,
			messageId: ask1,
		});
		await a.opened.state.pendingAsks.record({
			senderSessionId: target.info.id,
			targetSessionId: sender.info.id,
			messageId: ask2,
		});

		// Inject healthy 90ms per shared-DB reply step (< 300ms per step, but 5 serialized steps including clearReply = 450ms > 300ms).
		const pendingAsks = a.opened.state.pendingAsks;
		const origMatches = pendingAsks.matchesReply.bind(pendingAsks);
		const origRelease = pendingAsks.releaseRoute.bind(pendingAsks);
		const origClearReply = pendingAsks.clearReply.bind(pendingAsks);
		const stepMs = 90;
		const stepsStarted = [deferred(), deferred(), deferred(), deferred(), deferred()];
		let stepIndex = 0;
		const runStep = async <T>(op: () => Promise<T>): Promise<T> => {
			const res = await op();
			const gate = stepsStarted[stepIndex++];
			gate?.resolve();
			await new Promise((resolve) => setTimeout(resolve, stepMs));
			return res;
		};
		Object.assign(pendingAsks, {
			matchesReply: (...args: Parameters<typeof origMatches>) => runStep(() => origMatches(...args)),
			releaseRoute: (...args: Parameters<typeof origRelease>) => runStep(() => origRelease(...args)),
			clearReply: (...args: Parameters<typeof origClearReply>) => runStep(() => origClearReply(...args)),
		});
		cleanups.push(async () => {
			Object.assign(pendingAsks, {
				matchesReply: origMatches,
				releaseRoute: origRelease,
				clearReply: origClearReply,
			});
		});

		const expected: string[] = [];
		for (let i = 0; i < 16; i++) {
			const text = `local-seq-${i}`;
			expected.push(text);
			if (i === 0) {
				a.send(sender, target.info.id, makeMessage(text, { replyTo: ask1 }), {
					requirePendingReply: true,
					expectedRecipientId: target.info.id,
				});
			} else if (i === 5) {
				a.send(sender, target.info.id, makeMessage(text, { replyTo: ask2 }), {
					requirePendingReply: true,
					expectedRecipientId: target.info.id,
				});
			} else {
				a.send(sender, target.info.id, makeMessage(text));
			}
		}

		// Step deterministically through all 5 serialized DB steps so fake timers never outrun SQLite I/O under load:
		// Step 1 (seq-0 matchesReply, 90ms), Step 2 (seq-0 releaseRoute, 180ms -> seq-0..4 deliver + clearReply starts),
		// Step 3 (seq-0 clearReply awaited by seq-5 settling, 270ms), Step 4 (seq-5 matchesReply, 360ms > 300ms bound!),
		// Step 5 (seq-5 releaseRoute, 450ms -> seq-5..15 deliver in strict FIFO!).
		for (let step = 0; step < 5; step++) {
			await stepsStarted[step]!.promise;
			await vi.advanceTimersByTimeAsync(stepMs);
		}
		await waitImmediate(() => assert.deepEqual(receivedTexts(target), expected));
	});
});

test("a single shared-route local reply spanning multiple healthy 120ms store steps stays ahead of a following plain local send", async () => {
	await withFakeClocks(async () => {
		const { nodes } = await cluster(1);
		const a = nodes[0]!;
		const sender = await a.connect("sender");
		const target = await a.connect("target");

		const askId = randomUUID();
		await a.opened.state.pendingAsks.record({
			senderSessionId: target.info.id,
			targetSessionId: sender.info.id,
			messageId: askId,
		});

		const replyMsg = makeMessage("slow-healthy-reply", { replyTo: askId });
		const plainMsg = makeMessage("plain-after-reply");
		const { outbox, pendingAsks } = a.opened.state;
		const origRead = outbox.read.bind(outbox);
		const origMatches = pendingAsks.matchesReply.bind(pendingAsks);
		const origRelease = pendingAsks.releaseRoute.bind(pendingAsks);
		const rttMs = 120;
		const readStarted = deferred();
		const matchesStarted = deferred();
		const releaseStarted = deferred();
		Object.assign(outbox, {
			read: async (id: string) => {
				const res = await origRead(id);
				if (id === replyMsg.id) {
					readStarted.resolve();
					await new Promise((resolve) => setTimeout(resolve, rttMs));
				}
				return res;
			},
		});
		Object.assign(pendingAsks, {
			matchesReply: async (...args: Parameters<typeof origMatches>) => {
				const res = await origMatches(...args);
				matchesStarted.resolve();
				await new Promise((resolve) => setTimeout(resolve, rttMs));
				return res;
			},
			releaseRoute: async (...args: Parameters<typeof origRelease>) => {
				const res = await origRelease(...args);
				releaseStarted.resolve();
				await new Promise((resolve) => setTimeout(resolve, rttMs));
				return res;
			},
		});
		cleanups.push(async () => {
			Object.assign(outbox, { read: origRead });
			Object.assign(pendingAsks, { matchesReply: origMatches, releaseRoute: origRelease });
		});

		// Reply takes 3 * 120ms = 360ms (> 300ms), while plain's outbox.read finishes immediately!
		a.send(sender, target.info.id, replyMsg, { requirePendingReply: true, expectedRecipientId: target.info.id });
		a.send(sender, target.info.id, plainMsg);

		await readStarted.promise;
		await vi.advanceTimersByTimeAsync(rttMs); // t = 120ms
		await matchesStarted.promise;
		await vi.advanceTimersByTimeAsync(rttMs); // t = 240ms
		await releaseStarted.promise;
		// Cross plainMsg's initial 300ms bound while reply's releaseRoute is still in flight (last progress at 240ms).
		await vi.advanceTimersByTimeAsync(60); // t = 300ms
		await flushImmediate();
		assert.deepEqual(receivedTexts(target), [], "plain send must not skip progressing reply at 300ms");

		await vi.advanceTimersByTimeAsync(60); // t = 360ms
		await waitImmediate(() => assert.deepEqual(receivedTexts(target), ["slow-healthy-reply", "plain-after-reply"]));
	});
});

test("progress-extended local gate waits are still hard-capped at PRESENCE_REGISTRATION_BOUND_MS", async () => {
	await withFakeClocks(async () => {
		const { SendOrderGate } = await import("../../packages/intercom/broker/send-order-gate.js");
		const gate = new SendOrderGate();
		const t1 = gate.begin({ senderKey: "s", rawTarget: "t", arrivedRegSeq: 1, isLocal: true, targetIdentity: "T" });
		gate.markUnbounded(t1);
		const t2 = gate.begin({ senderKey: "s", rawTarget: "t", arrivedRegSeq: 1, isLocal: true, targetIdentity: "T" });

		const startedAt = performance.now();
		let boundExpired = false;
		const localBound = new Promise<"expired">((resolve) => {
			setTimeout(() => {
				boundExpired = true;
				resolve("expired");
			}, LOCAL_RETRY_LOOKUP_BOUND_MS);
		});
		let settled = false;
		const wait = gate.waitForEarlier(t2, {
			targetIdentity: "T",
			localBound,
			localBoundExpired: boundExpired,
			// Blocker reports continuous fresh progress at every check; hard cap must still release t2!
			blockerProgressAt: () => performance.now(),
			progressSilenceMs: LOCAL_RETRY_LOOKUP_BOUND_MS,
			maxLocalWaitUntil: startedAt + PRESENCE_REGISTRATION_BOUND_MS,
		});
		assert.ok(wait !== undefined);
		void wait.then(() => {
			settled = true;
		});

		await vi.advanceTimersByTimeAsync(PRESENCE_REGISTRATION_BOUND_MS - 1);
		await flushImmediate(3);
		assert.equal(settled, false);

		await vi.advanceTimersByTimeAsync(1);
		await waitImmediate(() => assert.equal(settled, true));
		gate.finish(t2);
		gate.finish(t1);
	});
});
