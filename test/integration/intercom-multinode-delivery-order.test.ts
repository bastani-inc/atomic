import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type net from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { MultiNodeRouter } from "../../packages/intercom/broker/multinode-router.js";
import { borrowedDatabase, openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import {
	type BrokerConnectedSession,
	handleBrokerSend,
	type SendClientMessage,
} from "../../packages/intercom/broker/send-handler.js";
import type { BrokerOutboundFrame } from "../../packages/intercom/broker/socket-writes.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import { normalizeGroup } from "../../packages/intercom/group.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { startFakeLibsqlServer } from "../helpers/fake-libsql-server.js";
import {
	TWO_BROKER_HARNESS_START_TIMEOUT_MS,
	TwoBrokerHarness,
	twoBrokerHarnessStartTimeoutMs,
} from "../helpers/intercom-two-broker-harness.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** Spawning two real broker processes sharing one SQLite file is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = TWO_BROKER_HARNESS_START_TIMEOUT_MS;
const GATED_STARTUP_TIMEOUT_MS = twoBrokerHarnessStartTimeoutMs({ gatedStorageOpening: "a" }) + 30_000;
const DELIVERY_WAIT_MS = 15_000;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);
beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

test("two real brokers on one SQLite file preserve per-(sender, target) order across mixed local replies, plain sends, and address forms", async () => {
	assert.equal(harness.multiNodeRouting, true, "expected multi-node routing on shared SQLite");
	const group = unique("local-order");
	const sender = await harness.connect("a", unique("sender"), { group });
	const targetName = unique("target");
	const targetOnB = await harness.connect("b", targetName, { group });
	const targetId = targetOnB.sessionId;
	const targetReturn = targetOnB.returnAddress;

	// Create two cross-node asks while target is on broker b, then move target to broker a so both ask routes live
	// in shared pendingAsks (forcing extra shared-DB round trips for replies relative to concurrent plain sends).
	const ask1 = await targetOnB.client.send(sender.sessionId, { text: "ask-1", expectsReply: true });
	const ask2 = await targetOnB.client.send(sender.sessionId, { text: "ask-2", expectsReply: true });
	assert.equal(ask1.delivered, true, ask1.reason);
	assert.equal(ask2.delivered, true, ask2.reason);
	await vi.waitFor(() => assert.equal(sender.received.length, 2), { timeout: DELIVERY_WAIT_MS, interval: 20 });
	await targetOnB.client.disconnect({ resumable: true });
	targetOnB.disconnected = true;

	const target = await harness.connect("a", targetName, {
		group,
		returnAddress: targetReturn,
		preferredSessionId: targetId,
	});
	// Keep a live peer on broker b so both brokers actively share the SQLite store.
	const peerB = await harness.connect("b", unique("peer-b"), { group });

	const expected: string[] = [];
	const sends: Promise<unknown>[] = [];
	for (let i = 0; i < 16; i++) {
		const text = `local-seq-${i}`;
		expected.push(text);
		const address = i % 3 === 0 ? target.name : i % 3 === 1 ? target.sessionId : target.sessionId.slice(0, 8);
		if (i === 0) {
			sends.push(
				sender.client.send(target.sessionId, {
					text,
					replyTo: ask1.id,
					requirePendingReply: true,
					expectedRecipientId: target.sessionId,
				}),
			);
		} else if (i === 5) {
			sends.push(
				sender.client.send(target.sessionId, {
					text,
					replyTo: ask2.id,
					requirePendingReply: true,
					expectedRecipientId: target.sessionId,
				}),
			);
		} else {
			sends.push(sender.client.send(address, { text }));
		}
	}
	await Promise.all(sends);
	await vi.waitFor(
		() =>
			assert.deepEqual(
				target.received.map((frame) => frame.message.content.text),
				expected,
			),
		{
			timeout: DELIVERY_WAIT_MS,
			interval: 20,
		},
	);
	await harness.disconnect(peerB);
	await harness.disconnect(sender);
	await harness.disconnect(target);
});

test("two real brokers on one SQLite file preserve per-(sender, target) send order across nodes with mixed replies and address forms", async () => {
	assert.equal(harness.multiNodeRouting, true, "expected multi-node routing on shared SQLite");
	const group = unique("cross-order");
	const sender = await harness.connect("a", unique("sender"), { group });
	const target = await harness.connect("b", unique("target"), { group });

	// Establish a cross-node ask so sender interleaves a correlated reply with plain sends.
	const ask = await target.client.send(sender.sessionId, { text: "cross-ask", expectsReply: true });
	assert.equal(ask.delivered, true, ask.reason);
	await vi.waitFor(() => assert.equal(sender.received.length, 1), { timeout: DELIVERY_WAIT_MS, interval: 20 });

	const expected: string[] = [];
	const sends: Promise<unknown>[] = [];
	for (let i = 0; i < 12; i++) {
		const text = `cross-seq-${i}`;
		expected.push(text);
		const address = i % 3 === 0 ? target.name : i % 3 === 1 ? target.sessionId : target.sessionId.slice(0, 8);
		if (i === 0) {
			sends.push(
				sender.client.send(target.sessionId, {
					text,
					replyTo: ask.id,
					requirePendingReply: true,
					expectedRecipientId: target.sessionId,
				}),
			);
		} else {
			sends.push(sender.client.send(address, { text }));
		}
	}
	await Promise.all(sends);
	await vi.waitFor(
		() =>
			assert.deepEqual(
				target.received.map((frame) => frame.message.content.text),
				expected,
			),
		{
			timeout: DELIVERY_WAIT_MS,
			interval: 25,
		},
	);
	await harness.disconnect(sender);
	await harness.disconnect(target);
});

test("two real brokers on one SQLite file deliver offline outbox rows before immediate local sends after target moves to sender's broker", async () => {
	assert.equal(harness.multiNodeRouting, true, "expected multi-node routing on shared SQLite");
	const group = unique("offline-to-local");
	const sender = await harness.connect("a", unique("sender"), { group });
	const targetName = unique("mover");
	const initialOnB = await harness.connect("b", targetName, { group });
	const targetId = initialOnB.sessionId;
	const targetReturn = initialOnB.returnAddress;
	await harness.disconnect(initialOnB);

	// Queue 4 messages in the shared outbox while target is offline.
	const queuedTexts = ["queued-0", "queued-1", "queued-2", "queued-3"];
	for (const text of queuedTexts) {
		const res = await sender.client.send(targetId, { text });
		assert.equal(res.queued, true, `expected queued for ${text}: ${JSON.stringify(res)}`);
	}

	// Target reconnects on broker a (same broker as sender); sender immediately fires 4 local sends.
	const returnedOnA = await harness.connect("a", targetName, {
		group,
		returnAddress: targetReturn,
		preferredSessionId: targetId,
	});
	const localTexts = ["local-0", "local-1", "local-2", "local-3"];
	await Promise.all(localTexts.map((text) => sender.client.send(targetId, { text })));

	await vi.waitFor(
		() =>
			assert.deepEqual(
				returnedOnA.received.map((frame) => frame.message.content.text),
				[...queuedTexts, ...localTexts],
			),
		{ timeout: DELIVERY_WAIT_MS, interval: 25 },
	);
	await harness.disconnect(sender);
	await harness.disconnect(returnedOnA);
});

test(
	"sends arriving while multi-node startup transitions from starting to on preserve FIFO order",
	async () => {
		const gated = await TwoBrokerHarness.start({ gatedStorageOpening: "a" });
		cleanups.push(() => gated.cleanup());
		const group = unique("startup-order");
		const sender = await gated.connect("a", unique("sender"), { group });
		const target = await gated.connect("a", unique("target"), { group });

		const firstBatch = ["start-0", "start-1", "start-2"];
		const pending = firstBatch.map((text) => sender.client.send(target.sessionId, { text }));
		gated.setStorageOpening("open");
		const secondBatch = ["after-0", "after-1", "after-2"];
		const after = secondBatch.map((text) => sender.client.send(target.sessionId, { text }));
		await Promise.all([...pending, ...after]);

		await vi.waitFor(
			() =>
				assert.deepEqual(
					target.received.map((frame) => frame.message.content.text),
					[...firstBatch, ...secondBatch],
				),
			{ timeout: DELIVERY_WAIT_MS, interval: 20 },
		);
	},
	GATED_STARTUP_TIMEOUT_MS,
);

/**
 * Loopback HTTP proxy in front of a Hrana 2 libSQL server that can hold a matching `/pipeline` response until
 * a later concurrent `/pipeline` response has already been delivered, reproducing out-of-order pooled HTTP responses.
 */
async function startReorderingHttpProxy(upstreamUrl: string) {
	let holdNeedle: string | undefined;
	let releaseNeedle: string | undefined;
	let heldRespond: (() => void) | undefined;
	let releaseSeen = false;
	let reorderedCount = 0;
	const sockets = new Set<net.Socket>();

	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		const body = Buffer.concat(chunks);
		const bodyText = body.toString("utf8");
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(req.headers)) {
			if (typeof v === "string" && k.toLowerCase() !== "host" && k.toLowerCase() !== "content-length") {
				headers[k] = v;
			}
		}
		const upstream = await fetch(new URL(req.url ?? "/", upstreamUrl), {
			method: req.method ?? "POST",
			headers,
			...(body.length > 0 ? { body } : {}),
		});
		const responseBody = Buffer.from(await upstream.arrayBuffer());
		const respond = () => {
			if (res.writableEnded) return;
			res.writeHead(upstream.status, {
				"content-type": upstream.headers.get("content-type") ?? "application/json",
			});
			res.end(responseBody);
		};

		if (
			holdNeedle !== undefined &&
			heldRespond === undefined &&
			bodyText.includes(holdNeedle) &&
			!bodyText.includes("INSERT")
		) {
			if (releaseSeen) {
				holdNeedle = undefined;
				respond();
			} else {
				heldRespond = respond;
			}
			return;
		}
		respond();
		if (releaseNeedle !== undefined && bodyText.includes(releaseNeedle) && !bodyText.includes("INSERT")) {
			releaseSeen = true;
			const flush = heldRespond;
			heldRespond = undefined;
			holdNeedle = undefined;
			releaseNeedle = undefined;
			if (flush !== undefined) {
				reorderedCount++;
				setTimeout(flush, 15);
			}
		}
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		get reorderedCount() {
			return reorderedCount;
		},
		reorder(firstMessageId: string, secondMessageId: string) {
			holdNeedle = firstMessageId;
			releaseNeedle = secondMessageId;
			releaseSeen = false;
			heldRespond = undefined;
		},
		flushHeld() {
			const flush = heldRespond;
			heldRespond = undefined;
			holdNeedle = undefined;
			releaseNeedle = undefined;
			flush?.();
		},
		async close() {
			this.flushHeld();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

type FakeSocket = net.Socket & { frames: BrokerOutboundFrame[] };

function fakeSocket(): FakeSocket {
	return { destroyed: false, writableEnded: false, frames: [] } as unknown as FakeSocket;
}

test("two brokers sharing a loopback libSQL HTTP server keep local and cross-node send order when pooled HTTP reads return out of order", async () => {
	const fakeServer = await startFakeLibsqlServer();
	const proxy = await startReorderingHttpProxy(fakeServer.url);
	const tempDir = makeTempDirectory("intercom-libsql-order-");
	// Broker A uses a 3-connection pool over the loopback libSQL HTTP server (mirroring a pooled remote SQL server
	// where concurrent SELECTs run on separate connections and can complete out of order); writes and transactions
	// still go through the primary connection.
	const dbAPrimary = await openLibsqlDatabase({ url: proxy.url });
	const dbAReadPool = [
		dbAPrimary,
		await openLibsqlDatabase({ url: proxy.url }),
		await openLibsqlDatabase({ url: proxy.url }),
	];
	let readSlot = 0;
	const dbAPooled = Object.create(borrowedDatabase(dbAPrimary), {
		get: {
			value: <Row>(sql: string, ...params: unknown[]) => {
				const conn = dbAReadPool[readSlot++ % dbAReadPool.length]!;
				return conn.get<Row & Record<string, never>>(sql, ...(params as never[]));
			},
		},
		all: {
			value: <Row>(sql: string, ...params: unknown[]) => {
				const conn = dbAReadPool[readSlot++ % dbAReadPool.length]!;
				return conn.all<Row & Record<string, never>>(sql, ...(params as never[]));
			},
		},
	}) as typeof dbAPrimary;
	const dbB = await openLibsqlDatabase({ url: proxy.url });
	const openedA = await openIntercomBrokerState(
		{ openDatabase: async () => dbAPooled, prefix: "ls_" },
		{ pollIntervalMs: 25 },
	);
	const openedB = await openIntercomBrokerState(
		{ openDatabase: async () => borrowedDatabase(dbB), prefix: "ls_" },
		{ pollIntervalMs: 25 },
	);
	const deliveredA = new DeliveredMessageCache(undefined, undefined, join(tempDir, "a-delivered.sqlite"));
	const deliveredB = new DeliveredMessageCache(undefined, undefined, join(tempDir, "b-delivered.sqlite"));
	const sessionsA = new Map<string, BrokerConnectedSession>();
	const sessionsB = new Map<string, BrokerConnectedSession>();
	const supA = new SupervisorChannelCache();
	const supB = new SupervisorChannelCache();
	const pqA = new PendingQuestionIndex();
	const pqB = new PendingQuestionIndex();

	const writeFrame = (socket: net.Socket, frame: BrokerOutboundFrame): boolean => {
		(socket as FakeSocket).frames.push(frame);
		return true;
	};
	let routerA!: MultiNodeRouter;
	let routerB!: MultiNodeRouter;
	const dispatchOn = (
		sessions: Map<string, BrokerConnectedSession>,
		delivered: DeliveredMessageCache,
		sup: SupervisorChannelCache,
		pq: PendingQuestionIndex,
		getRouter: () => MultiNodeRouter,
	) => {
		const dispatch = (socket: net.Socket, clientMessage: SendClientMessage, senderId: string) => {
			handleBrokerSend(
				socket,
				clientMessage,
				senderId,
				sessions,
				delivered,
				writeFrame,
				sup,
				pq,
				(target, frame, onSettled) => onSettled(writeFrame(target, frame)),
				undefined,
				undefined,
				(request) => getRouter().routeSend(request),
			);
		};
		return dispatch;
	};
	const dispatchA = dispatchOn(sessionsA, deliveredA, supA, pqA, () => routerA);
	const dispatchB = dispatchOn(sessionsB, deliveredB, supB, pqB, () => routerB);

	routerA = await MultiNodeRouter.start({
		state: openedA.state,
		bus: openedA.bus,
		host: {
			sessions: sessionsA,
			write: writeFrame,
			writeConfirmed: (target, frame, onSettled) => onSettled(writeFrame(target, frame)),
			supervisorCache: supA,
			pendingQuestions: pqA,
			deliveredMessages: deliveredA,
			dispatch: dispatchA,
			revokeReleasedReservation: () => {},
			holdsReservation: () => false,
			fence: () => {},
		},
	});
	routerB = await MultiNodeRouter.start({
		state: openedB.state,
		bus: openedB.bus,
		host: {
			sessions: sessionsB,
			write: writeFrame,
			writeConfirmed: (target, frame, onSettled) => onSettled(writeFrame(target, frame)),
			supervisorCache: supB,
			pendingQuestions: pqB,
			deliveredMessages: deliveredB,
			dispatch: dispatchB,
			revokeReleasedReservation: () => {},
			holdsReservation: () => false,
			fence: () => {},
		},
	});
	cleanups.push(async () => {
		proxy.flushHeld();
		await routerA.close();
		await routerB.close();
		deliveredA.close();
		deliveredB.close();
		for (const conn of dbAReadPool) await conn.close();
		await dbB.close();
		await proxy.close();
		await fakeServer.close();
		removeTempDirectory(tempDir);
	});

	const connect = async (
		sessions: Map<string, BrokerConnectedSession>,
		router: MultiNodeRouter,
		name: string,
	): Promise<BrokerConnectedSession> => {
		const info: SessionInfo = {
			id: randomUUID(),
			name,
			cwd: "/work",
			model: "test",
			pid: 1,
			startedAt: 1,
			lastActivity: 1,
			status: "idle",
			group: "default",
			groups: ["default"],
		};
		const session: BrokerConnectedSession = {
			socket: fakeSocket(),
			info,
			registrationGroup: normalizeGroup("default"),
			registrationName: name,
			registrationReturnAddress: randomUUID(),
			acknowledgesReceipt: true,
		};
		sessions.set(info.id, session);
		await router.sessionRegistered(session);
		return session;
	};
	const received = (session: BrokerConnectedSession) =>
		(session.socket as FakeSocket).frames
			.filter((frame): frame is Extract<BrokerOutboundFrame, { type: "message" }> => frame.type === "message")
			.map((frame) => frame.message.content.text);

	const senderA = await connect(sessionsA, routerA, "sender-a");
	const localTargetA = await connect(sessionsA, routerA, "local-a");
	const remoteTargetB = await connect(sessionsB, routerB, "remote-b");

	// 1. Local-to-local on Broker A over pooled libSQL HTTP: hold HTTP response for m1 until m2 returns!
	const l1: Message = { id: randomUUID(), timestamp: Date.now(), content: { text: "libsql-local-1" } };
	const l2: Message = { id: randomUUID(), timestamp: Date.now(), content: { text: "libsql-local-2" } };
	const l3: Message = { id: randomUUID(), timestamp: Date.now(), content: { text: "libsql-local-3" } };
	proxy.reorder(l1.id, l2.id);
	dispatchA(senderA.socket, { type: "send", to: "local-a", message: l1, attemptId: randomUUID() }, senderA.info.id);
	dispatchA(
		senderA.socket,
		{ type: "send", to: localTargetA.info.id, message: l2, attemptId: randomUUID() },
		senderA.info.id,
	);
	dispatchA(
		senderA.socket,
		{ type: "send", to: localTargetA.info.id.slice(0, 8), message: l3, attemptId: randomUUID() },
		senderA.info.id,
	);
	await vi.waitFor(
		() => assert.deepEqual(received(localTargetA), ["libsql-local-1", "libsql-local-2", "libsql-local-3"]),
		{
			timeout: DELIVERY_WAIT_MS,
			interval: 20,
		},
	);

	// 2. Cross-node Broker A -> Broker B over pooled libSQL HTTP: hold HTTP response for r1 until r2 returns!
	const r1: Message = { id: randomUUID(), timestamp: Date.now(), content: { text: "libsql-remote-1" } };
	const r2: Message = { id: randomUUID(), timestamp: Date.now(), content: { text: "libsql-remote-2" } };
	const r3: Message = { id: randomUUID(), timestamp: Date.now(), content: { text: "libsql-remote-3" } };
	proxy.reorder(r1.id, r2.id);
	dispatchA(senderA.socket, { type: "send", to: "remote-b", message: r1, attemptId: randomUUID() }, senderA.info.id);
	dispatchA(
		senderA.socket,
		{ type: "send", to: remoteTargetB.info.id, message: r2, attemptId: randomUUID() },
		senderA.info.id,
	);
	dispatchA(
		senderA.socket,
		{ type: "send", to: remoteTargetB.info.id.slice(0, 8), message: r3, attemptId: randomUUID() },
		senderA.info.id,
	);
	await vi.waitFor(
		() => assert.deepEqual(received(remoteTargetB), ["libsql-remote-1", "libsql-remote-2", "libsql-remote-3"]),
		{
			timeout: DELIVERY_WAIT_MS,
			interval: 25,
		},
	);
	// Confirm the proxy actually reordered concurrent HTTP responses rather than passing vacuously!
	assert.ok(
		proxy.reorderedCount >= 1,
		`expected proxy to reorder concurrent HTTP responses, got ${proxy.reorderedCount}`,
	);
});
