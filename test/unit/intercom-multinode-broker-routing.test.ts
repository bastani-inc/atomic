import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import {
	openNodeSqliteDatabase,
	type SqliteDatabase,
	type SqliteExecutor,
	type SqliteRow,
	type SqliteValue,
} from "@bastani/atomic/storage";
import { afterEach, beforeEach, test, vi } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import {
	KNOWN_SESSION_REFRESH_INTERVAL_MS,
	LOCAL_RETRY_LOOKUP_BOUND_MS,
	MULTI_NODE_OUTCOME_POLL_INTERVAL_MS,
	MultiNodeRouter,
	OFFLINE_SESSION_TARGET,
	PRESENCE_REGISTRATION_BOUND_MS,
	readSharedStorageSetting,
	resolveMultiNodeStartup,
} from "../../packages/intercom/broker/multinode-router.js";
import {
	BROKER_LEASE_RENEW_INTERVAL_MS,
	type IntercomBrokerStateOptions,
	KNOWN_SESSION_RETENTION_MS,
	OUTBOX_BACKUP_POLL_INTERVAL_MS,
	OUTBOX_CLAIM_STALE_AFTER_MS,
	OUTBOX_EXPIRED_REASON,
	OUTBOX_TARGET_MAX_BYTES,
	OUTBOX_TARGET_MAX_ROWS,
} from "../../packages/intercom/broker/multinode-state-store.js";
import {
	borrowedDatabase,
	type OpenedBrokerState,
	openIntercomBrokerState,
	resolveBrokerStateSource,
	type SharedDatabaseSource,
} from "../../packages/intercom/broker/open-broker-state.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import { UNCERTAIN_RECEIPT_REASON } from "../../packages/intercom/broker/recipient-receipts.js";
import { releasedReservationKey } from "../../packages/intercom/broker/released-children.js";
import { RESTORING_RECIPIENT_HOLD_MS } from "../../packages/intercom/broker/restoring-recipients.js";
import {
	type BrokerConnectedSession,
	deliveryTargetIdentity,
	handleBrokerSend,
	type SendClientMessage,
} from "../../packages/intercom/broker/send-handler.js";
import { buildMessageSendSignature } from "../../packages/intercom/broker/send-signature.js";
import type { BrokerOutboundFrame } from "../../packages/intercom/broker/socket-writes.js";
import { openSqlKnownSessionStore } from "../../packages/intercom/broker/sql-known-session-store.js";
import { openSqlBrokerLeaseStore } from "../../packages/intercom/broker/sql-lease-store.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import type { WakeUpBus } from "../../packages/intercom/broker/wake-up-bus.js";
import { normalizeGroup } from "../../packages/intercom/group.js";
import { NON_AGENT_RECIPIENT_REFUSAL, TERMINAL_CHILD_ASK_REFUSAL } from "../../packages/intercom/recipient-purpose.js";
import {
	RECIPIENT_RECEIPT_TIMEOUT_MS,
	RECIPIENT_SAVE_MAX_WAIT_MS,
	RECIPIENT_SAVING_REPORT_INTERVAL_MS,
	SEND_RESPONSE_TIMEOUT_MS,
} from "../../packages/intercom/retry-policy.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import {
	type OpenSharedStoreFixture,
	registerIdOwnerConformance,
	registerKnownSessionStoreConformance,
	type SharedStoreFixture,
} from "../helpers/intercom-multinode-contract.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";
import { type ConnectionRequestTracker, trackConnectionRequests } from "../helpers/sqlite-connection-requests.js";

/**
 * S5 (specs/2026-10-19-intercom-multi-node.md §12, §14): in-process brokers that share one SQLite file route sends
 * through the real send handler, the real router and the real S1–S4 stores and database wake-up bus.
 */

/** Cross-node hops ride the database-polled bus; this bounds a healthy delivery, far above the poll interval. */
const CROSS_NODE_WAIT_MS = 10_000;
const BUS_POLL_INTERVAL_MS = 20;
const ATTACHMENTS = [{ type: "snippet" as const, name: " a.ts ", content: "const x = 1;\r\n", language: "ts" }];
const VERBATIM = "  cross-node\tparity\u0000 ünïcödé ✓  \n";

type FakeSocket = net.Socket & { frames: BrokerOutboundFrame[]; written?: () => void };

function fakeSocket(): FakeSocket {
	return { destroyed: false, writableEnded: false, frames: [] } as unknown as FakeSocket;
}

class Node {
	readonly sessions = new Map<string, BrokerConnectedSession>();
	readonly revoked: { readonly key: string; readonly ownerSessionId: string }[] = [];
	/** Reservations this broker no longer holds (released, taken by their child, or replaced), by capability. */
	readonly dropped = new Set<string>();
	readonly supervisorCache = new SupervisorChannelCache();
	readonly pendingQuestions = new PendingQuestionIndex();
	readonly deliveredMessages: DeliveredMessageCache;
	router!: MultiNodeRouter;
	opened!: OpenedBrokerState;
	database!: SqliteDatabase;

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

	/**
	 * In-process brokers share one connection: node:sqlite waits for a lock synchronously, so a second connection in
	 * this process would block the event loop that has to finish the first connection's transaction.
	 */
	static async start(
		name: string,
		directory: string,
		shared: SqliteDatabase,
		wrapBus?: (bus: WakeUpBus) => WakeUpBus,
	): Promise<Node> {
		const node = new Node(name, directory);
		node.database = shared;
		node.opened = await openIntercomBrokerState(
			{ openDatabase: async () => borrowedDatabase(shared), prefix: "mn_" },
			{ pollIntervalMs: BUS_POLL_INTERVAL_MS },
		);
		node.router = await MultiNodeRouter.start({
			state: node.opened.state,
			bus: wrapBus === undefined ? node.opened.bus : wrapBus(node.opened.bus),
			host: {
				sessions: node.sessions,
				write: (socket, frame) => node.write(socket, frame),
				writeConfirmed: (socket, frame, onSettled) => onSettled(node.write(socket, frame)),
				supervisorCache: node.supervisorCache,
				pendingQuestions: node.pendingQuestions,
				deliveredMessages: node.deliveredMessages,
				dispatch: (socket, clientMessage, senderId) => node.dispatch(socket, clientMessage, senderId),
				revokeReleasedReservation: (key, ownerSessionId) => node.revoked.push({ key, ownerSessionId }),
				holdsReservation: (capability) => !node.dropped.has(capability),
				fence: () => {},
			},
		});
		return node;
	}

	write(socket: net.Socket, frame: BrokerOutboundFrame): boolean {
		const fake = socket as Partial<FakeSocket>;
		if (fake.frames !== undefined) {
			fake.frames.push(frame);
			fake.written?.();
		} else writeMessage(socket, frame);
		return true;
	}

	async connect(
		name: string,
		options: {
			group?: string;
			/** Current memberships when they differ from the registration group (it left that group). */
			groups?: string[];
			returnAddress?: string;
			id?: string;
			supervisorId?: string;
			consumed?: { capability: string };
			recipientPurpose?: SessionInfo["recipientPurpose"];
			replyCapability?: SessionInfo["replyCapability"];
			/** A real broker connection, for a session served through the real Intercom client. */
			socket?: net.Socket;
		} = {},
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
			group: options.groups?.[0] ?? group,
			groups: options.groups ?? [group],
			...(options.recipientPurpose === undefined ? {} : { recipientPurpose: options.recipientPurpose }),
			...(options.replyCapability === undefined ? {} : { replyCapability: options.replyCapability }),
		};
		const session: BrokerConnectedSession = {
			socket: options.socket ?? fakeSocket(),
			info,
			registrationGroup: normalizeGroup(group),
			registrationName: name,
			registrationReturnAddress: options.returnAddress ?? randomUUID(),
			acknowledgesReceipt: true,
			...(options.supervisorId === undefined ? {} : { supervisorId: options.supervisorId }),
		};
		this.sessions.set(info.id, session);
		await this.router.sessionRegistered(
			session,
			options.consumed === undefined
				? undefined
				: { capability: options.consumed.capability, childName: name, groups: new Set([normalizeGroup(group)]) },
		);
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

	send(from: BrokerConnectedSession, to: string, message: Message, extra: Record<string, unknown> = {}): void {
		this.dispatch(from.socket, { type: "send", to, message, attemptId: randomUUID(), ...extra }, from.info.id);
	}

	async close(): Promise<void> {
		await this.router.close();
		this.deliveredMessages.close();
	}
}

function message(overrides: Partial<Message> = {}): Message {
	return {
		id: randomUUID(),
		timestamp: 1_700_000_000_000,
		content: { text: VERBATIM, attachments: ATTACHMENTS },
		...overrides,
	};
}

function framesOf(session: BrokerConnectedSession): BrokerOutboundFrame[] {
	return (session.socket as FakeSocket).frames;
}

function messageFrames(session: BrokerConnectedSession, id: string) {
	return framesOf(session).filter((frame) => frame.type === "message" && frame.message.id === id);
}

function outcomeOf(session: BrokerConnectedSession, id: string) {
	return framesOf(session).find(
		(frame) =>
			(frame.type === "delivered" || frame.type === "delivery_failed" || frame.type === "queued") &&
			frame.messageId === id,
	);
}

async function waitFor<T>(read: () => T | undefined, timeout = CROSS_NODE_WAIT_MS): Promise<T> {
	return vi.waitFor(
		() => {
			const value = read();
			assert.ok(value !== undefined, "not yet");
			return value;
		},
		{ timeout, interval: 10 },
	);
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function cluster(count = 2, wrapBus?: (node: number, bus: WakeUpBus) => WakeUpBus): Promise<Node[]> {
	const directory = makeTempDirectory("intercom-multinode-routing-");
	const nodes: Node[] = [];
	const shared = await openNodeSqliteDatabase(join(directory, "shared.sqlite"));
	cleanups.push(async () => {
		for (const node of nodes) await node.close();
		await shared.close();
		removeTempDirectory(directory);
	});
	for (let index = 0; index < count; index++) {
		nodes.push(await Node.start(`node-${index}`, directory, shared, wrapBus && ((bus) => wrapBus(index, bus))));
	}
	return nodes;
}

test("a remote send writes the frame a local send writes and reports delivered only after the recipient saves it", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	const sent = message({ source: { subagentRunId: "run-1", subagentAgent: "worker", subagentIndex: 0 } });
	a!.send(sender, "recipient", sent);

	const [frame] = await waitFor(() =>
		messageFrames(recipient, sent.id).length > 0 ? messageFrames(recipient, sent.id) : undefined,
	);
	assert.deepEqual(frame, { type: "message", from: sender.info, message: sent });
	const row = await a!.opened.state.outbox.read(sent.id);
	assert.equal(row.status, "found");
	if (row.status === "found") {
		assert.equal(row.row.state, "claimed", "written but not yet saved by the recipient");
		const signature = buildMessageSendSignature(
			"recipient",
			sent,
			sender.registrationReturnAddress ?? sender.info.id,
		);
		assert.equal(row.row.digest, createHash("sha256").update(signature).digest("hex"), "unkeyed SHA-256 digest");
	}
	assert.equal(outcomeOf(sender, sent.id), undefined, "no outcome before the recipient's received");

	assert.equal(b!.router.received(recipient, sent.id), true);
	const outcome = await waitFor(() => outcomeOf(sender, sent.id));
	assert.equal(outcome.type, "delivered");
	assert.equal(messageFrames(recipient, sent.id).length, 1);
});

test("an ask routes its reply back on the reverse route, retargets nothing, and a second reply is refused", async () => {
	const [a, b] = await cluster();
	const asker = await a!.connect("asker");
	const replier = await b!.connect("replier");
	const ask = message({ expectsReply: true });
	const attemptId = randomUUID();
	a!.dispatch(
		asker.socket,
		{ type: "send", to: "replier", message: ask, attemptId, resolveReplyTarget: true },
		asker.info.id,
	);
	await waitFor(() => messageFrames(replier, ask.id)[0]);
	assert.deepEqual(
		framesOf(asker).find((frame) => frame.type === "question_target"),
		{ type: "question_target", messageId: ask.id, attemptId, sessionId: replier.info.id },
	);
	b!.router.received(replier, ask.id);
	assert.equal((await waitFor(() => outcomeOf(asker, ask.id))).type, "delivered");

	const reply = message({ replyTo: ask.id, content: { text: "all green" } });
	b!.send(replier, asker.info.id, reply, { requirePendingReply: true, expectedRecipientId: asker.info.id });
	const [replyFrame] = await waitFor(() =>
		messageFrames(asker, reply.id).length > 0 ? messageFrames(asker, reply.id) : undefined,
	);
	assert.deepEqual(replyFrame, { type: "message", from: replier.info, message: reply });
	a!.router.received(asker, reply.id);
	assert.equal((await waitFor(() => outcomeOf(replier, reply.id))).type, "delivered");

	const again = message({ replyTo: ask.id, content: { text: "again" } });
	b!.send(replier, asker.info.id, again, { requirePendingReply: true });
	const refused = await waitFor(() => outcomeOf(replier, again.id));
	assert.equal(refused.type, "delivery_failed");
	assert.equal(
		refused.type === "delivery_failed" && refused.reason,
		"Pending question route does not authorize this public reply",
	);
	assert.deepEqual(messageFrames(asker, again.id), []);
});

test("a supervisor send reaches its supervisor on another node on the supervisor channel", async () => {
	const [a, b] = await cluster();
	const supervisor = await b!.connect("supervisor", { group: "parent" });
	const child = await a!.connect("child", { group: "isolated-child", supervisorId: supervisor.info.id });
	const sent = message();
	a!.dispatch(
		child.socket,
		{ type: "supervisor_send", to: supervisor.info.id, message: sent, attemptId: randomUUID() },
		child.info.id,
	);
	const frame = await waitFor(() => messageFrames(supervisor, sent.id)[0]);
	assert.deepEqual(frame, { type: "message", from: child.info, message: sent, channel: "supervisor" });
	b!.router.received(supervisor, sent.id);
	assert.equal((await waitFor(() => outcomeOf(child, sent.id))).type, "delivered");
});

test("a supervisor's reply by name reaches its child in another group on another node, live or offline", async () => {
	const [a, b] = await cluster();
	const supervisor = await b!.connect("supervisor", { group: "parent" });
	const child = await a!.connect("isolated-child", { group: "isolated-child", supervisorId: supervisor.info.id });
	const sent = message();
	a!.dispatch(
		child.socket,
		{ type: "supervisor_send", to: supervisor.info.id, message: sent, attemptId: randomUUID() },
		child.info.id,
	);
	await waitFor(() => messageFrames(supervisor, sent.id)[0]);
	b!.router.received(supervisor, sent.id);

	const reply = message({ replyTo: sent.id, content: { text: "by name" } });
	b!.send(supervisor, "isolated-child", reply);
	await waitFor(() => messageFrames(child, reply.id)[0]);
	a!.router.received(child, reply.id);
	assert.equal((await waitFor(() => outcomeOf(supervisor, reply.id))).type, "delivered");

	a!.leave(child);
	await waitOffline(a!, child);
	const offline = message({ replyTo: sent.id, content: { text: "by name, offline" } });
	b!.send(supervisor, "isolated-child", offline);
	assert.equal((await waitFor(() => outcomeOf(supervisor, offline.id))).type, "queued");

	const unrelated = message({ content: { text: "no reply relationship" } });
	b!.send(supervisor, "isolated-child", unrelated);
	const refused = await waitFor(() => outcomeOf(supervisor, unrelated.id));
	assert.equal(refused.type === "delivery_failed" && refused.reason, "Session not found");
});

test("a remote session in another group is refused exactly as a local one is", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender", { group: "team" });
	const isolated = await b!.connect("isolated", { group: "elsewhere" });
	const sent = message();
	a!.send(sender, isolated.info.id, sent);
	const refused = await waitFor(() => outcomeOf(sender, sent.id));
	assert.deepEqual(
		{ type: refused.type, reason: refused.type === "delivery_failed" ? refused.reason : undefined },
		{ type: "delivery_failed", reason: "Target session is in a different intercom group" },
	);
	assert.deepEqual(framesOf(isolated), []);
});

test("a session that quit is queued for at once and delivered when it reconnects on any broker, then reported delivered", async () => {
	const [a, b, c] = await cluster(3);
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	const returnAddress = recipient.registrationReturnAddress!;
	b!.leave(recipient);
	const sent = message();
	await vi.waitFor(
		async () => {
			const lease = await a!.opened.state.leases.listLive("presence", 30_000);
			assert.ok(
				!lease.some((entry) => entry.subject.kind === "presence" && entry.subject.session.id === recipient.info.id),
			);
		},
		{ timeout: CROSS_NODE_WAIT_MS },
	);
	a!.send(sender, "recipient", sent);
	const queued = await waitFor(() => outcomeOf(sender, sent.id));
	assert.equal(queued.type, "queued");
	assert.equal(queued.type === "queued" && queued.target, OFFLINE_SESSION_TARGET);
	assert.equal(queued.type === "queued" && queued.position, 1);

	const back = await c!.connect("recipient", { returnAddress, id: recipient.info.id });
	const frame = await waitFor(() => messageFrames(back, sent.id)[0]);
	assert.deepEqual(frame, { type: "message", from: sender.info, message: sent });
	c!.router.received(back, sent.id);
	await waitFor(() => framesOf(sender).find((entry) => entry.type === "delivered" && entry.messageId === sent.id));
});

test("a send that races its recipient's clean quit is queued for it, not reported uncertain, and delivered when it reconnects", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	const returnAddress = recipient.registrationReturnAddress!;
	// The recipient's broker records the quit only after the sender's broker has routed to it as live.
	const leases = b!.opened.state.leases;
	const release = leases.release.bind(leases);
	let recordQuit!: () => void;
	const quitRecorded = new Promise<void>((resolve) => {
		recordQuit = resolve;
	});
	const spy = vi.spyOn(leases, "release").mockImplementation(async (lease) => {
		await quitRecorded;
		return release(lease);
	});
	try {
		b!.leave(recipient);
		const sent = message();
		const sentAt = Date.now();
		a!.send(sender, "recipient", sent);
		await vi.waitFor(async () => assert.equal((await a!.opened.state.outbox.read(sent.id)).status, "found"), {
			timeout: CROSS_NODE_WAIT_MS,
		});
		recordQuit();
		const outcome = await waitFor(() => outcomeOf(sender, sent.id), RECIPIENT_RECEIPT_TIMEOUT_MS * 2);
		assert.equal(outcome.type, "queued", JSON.stringify(outcome));
		assert.equal(outcome.type === "queued" && outcome.target, OFFLINE_SESSION_TARGET);
		const waited = Date.now() - sentAt;
		assert.ok(waited < RECIPIENT_RECEIPT_TIMEOUT_MS, `the sender heard queued after ${waited} ms`);

		const back = await b!.connect("recipient", { returnAddress, id: recipient.info.id });
		await waitFor(() => messageFrames(back, sent.id)[0]);
		b!.router.received(back, sent.id);
		await waitFor(() => framesOf(sender).find((entry) => entry.type === "delivered" && entry.messageId === sent.id));
		assert.equal(messageFrames(back, sent.id).length, 1);
	} finally {
		spy.mockRestore();
	}
});

/** The sender's broker reads the recipient's presence behind a write stall on its shared connection. */
const PRESENCE_READ_STALL_MS = 3_000;

/** A broker socket served by `node`, so a sender uses the real Intercom client, with its own send timeout. */
async function realClientOn(node: Node, name: string) {
	const agentDir = makeTempDirectory("intercom-multinode-client-");
	const socketPath = getBrokerSocketPath(process.platform, agentDir);
	mkdirSync(join(agentDir, "intercom"), { recursive: true });
	const sessions: BrokerConnectedSession[] = [];
	const server = net.createServer((socket) => {
		socket.on("error", () => {});
		socket.on(
			"data",
			createMessageReader(
				(frame) => {
					const received = frame as { type: string; registrationGroup?: string; returnAddress?: string };
					if (received.type === "register") {
						void node
							.connect(name, {
								socket,
								...(received.returnAddress === undefined ? {} : { returnAddress: received.returnAddress }),
							})
							.then((session) => {
								sessions.push(session);
								writeMessage(socket, {
									type: "registered",
									sessionId: session.info.id,
									acknowledgesReceipt: true,
								});
							});
					} else if (received.type === "send" && sessions[0] !== undefined) {
						node.dispatch(socket, frame as SendClientMessage, sessions[0].info.id);
					}
				},
				(error) => socket.destroy(error),
			),
		);
	});
	await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));
	const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
	const client = new IntercomClient(undefined, { acknowledgesReceipt: true, brokerSocketPath: socketPath });
	client.on("error", () => {});
	cleanups.push(async () => {
		await client.disconnect().catch(() => undefined);
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		removeTempDirectory(agentDir);
	});
	await client.connect({ name, cwd: "/work", model: "test/model", pid: 1, startedAt: 1, lastActivity: 1 });
	return { client, session: sessions[0]! };
}

test("a send whose recipient quits before its receipt wait ends is told to keep waiting while slow reads decide it is queued", async () => {
	const dropOutcomes = (node: number, bus: WakeUpBus): WakeUpBus =>
		node === 1
			? {
					publish: (hint) =>
						hint.reason === "outcome" ? Promise.resolve({ status: "published" }) : bus.publish(hint),
					subscribe: (brokerId, listener) => bus.subscribe(brokerId, listener),
					close: () => bus.close(),
				}
			: bus;
	const [a, b] = await cluster(2, dropOutcomes);
	const { client, session: sender } = await realClientOn(a!, "sender");
	const recipient = await b!.connect("recipient");
	// The recipient's broker records its quit only just before the sender's receipt wait ends, and its wake-up is lost.
	const leases = b!.opened.state.leases;
	const release = leases.release.bind(leases);
	let recordQuit!: () => void;
	const quitRecorded = new Promise<void>((resolveQuit) => {
		recordQuit = resolveQuit;
	});
	const releaseSpy = vi.spyOn(leases, "release").mockImplementation(async (lease) => {
		await quitRecorded;
		return release(lease);
	});
	const presence = a!.opened.state.leases;
	const read = presence.read.bind(presence);
	const readSpy = vi.spyOn(presence, "read").mockImplementation(async (key) => {
		await new Promise((resolveStall) => setTimeout(resolveStall, PRESENCE_READ_STALL_MS));
		return read(key);
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	const toSender: Array<{ readonly type: string; readonly at: number }> = [];
	const write = a!.write.bind(a!);
	const writeSpy = vi.spyOn(a!, "write").mockImplementation((socket, frame) => {
		if (socket === sender.socket) toSender.push({ type: frame.type, at: Date.now() });
		return write(socket, frame);
	});
	const dispatch = a!.dispatch.bind(a!);
	let dispatched!: (messageId: string) => void;
	const sentId = new Promise<string>((resolveSent) => {
		dispatched = resolveSent;
	});
	const dispatchSpy = vi.spyOn(a!, "dispatch").mockImplementation((socket, clientMessage, senderId) => {
		dispatched((clientMessage.message as Message).id);
		return dispatch(socket, clientMessage, senderId);
	});
	try {
		b!.leave(recipient);
		const sentAt = Date.now();
		const sent = client.send("recipient", { text: "sent as its recipient quits" }).then(
			(result) => ({ result, at: Date.now() }),
			(error: Error) => ({ error, at: Date.now() }),
		);
		// The send crosses a real socket to its broker, which queues it in the shared outbox and starts its receipt wait.
		// Fake time moves on only once that real I/O is done, so the broker's wait and the sender's own start together.
		await untilOutboxHas(a!, await sentId);
		await advance(RECIPIENT_RECEIPT_TIMEOUT_MS - 500);
		recordQuit();
		await advance(RECIPIENT_RECEIPT_TIMEOUT_MS + PRESENCE_READ_STALL_MS);
		const settled = await sent;
		if (!("result" in settled))
			assert.fail(`the send failed after ${settled.at - sentAt} ms: ${String(settled.error)}`);
		assert.equal(settled.result.queued, true, JSON.stringify(settled.result));
		assert.equal(settled.result.target, OFFLINE_SESSION_TARGET);
		const held = toSender.find((frame) => frame.type === "send_held");
		assert.ok(held !== undefined, `the sender heard only ${JSON.stringify(toSender)}`);
		// The sender's client gives up `SEND_RESPONSE_TIMEOUT_MS` after its send unless a hold reaches it first.
		assert.ok(held.at - sentAt < SEND_RESPONSE_TIMEOUT_MS, `held only ${held.at - sentAt} ms after the send`);
		assert.deepEqual(
			toSender.map((frame) => frame.type),
			["send_held", "queued"],
		);
	} finally {
		vi.useRealTimers();
		dispatchSpy.mockRestore();
		writeSpy.mockRestore();
		readSpy.mockRestore();
		releaseSpy.mockRestore();
	}
});

/** Waits, without stepping fake time, until `node` has the message in the shared outbox. */
async function untilOutboxHas(node: Node, messageId: string): Promise<void> {
	while ((await node.opened.state.outbox.read(messageId)).status !== "found") await settleFileIo();
	await settleFileIo();
}

test("a target no presence lease and no known session names is not found, as on a single node", async () => {
	const [a] = await cluster(1);
	const sender = await a!.connect("sender");
	const plain = message();
	a!.send(sender, randomUUID(), plain);
	const failed = await waitFor(() => outcomeOf(sender, plain.id));
	assert.deepEqual(
		{ type: failed.type, reason: failed.type === "delivery_failed" ? failed.reason : undefined },
		{ type: "delivery_failed", reason: "Session not found" },
	);
});

async function holdSendForRestoringChild(wrapBus?: (node: number, bus: WakeUpBus) => WakeUpBus) {
	const [a, b] = await cluster(2, wrapBus);
	const sender = await a!.connect("sender", { group: "crew" });
	const supervisor = await b!.connect("supervisor", { group: "crew" });
	const capability = `${randomUUID()}.capability`;
	b!.router.restoringReserved(capability, supervisor.info.id, "restored-child", normalizeGroup("crew"), [], false);
	await vi.waitFor(
		async () => {
			const lookup = await a!.opened.state.reservations.lookup(
				"restored-child",
				{ sessionId: sender.info.id, groups: [normalizeGroup("crew")] },
				30_000,
			);
			assert.equal(lookup.status, "reserved");
		},
		{ timeout: CROSS_NODE_WAIT_MS },
	);
	const sent = message();
	a!.send(sender, "restored-child", sent, { awaitRestoringRecipient: true });
	await waitFor(() => framesOf(sender).find((frame) => frame.type === "send_held" && frame.messageId === sent.id));
	const connectChild = () =>
		b!.connect("restored-child", { group: "crew", supervisorId: supervisor.info.id, consumed: { capability } });
	return { a: a!, b: b!, sender, sent, connectChild };
}

async function heldSendRoundTrip(wrapBus?: (node: number, bus: WakeUpBus) => WakeUpBus) {
	const { b, sender, sent, connectChild } = await holdSendForRestoringChild(wrapBus);
	const heldAt = Date.now();
	const child = await connectChild();
	const frame = await waitFor(() => messageFrames(child, sent.id)[0], RESTORING_RECIPIENT_HOLD_MS);
	assert.deepEqual(frame, { type: "message", from: sender.info, message: sent });
	b.router.received(child, sent.id);
	const outcome = await waitFor(() => outcomeOf(sender, sent.id));
	return { outcome, elapsedMs: Date.now() - heldAt };
}

test("a send held through one broker for a child restored on another gets send_held and is delivered after it registers", async () => {
	const { outcome } = await heldSendRoundTrip();
	assert.equal(outcome.type, "delivered");
});

async function advanceUntil<T>(
	read: () => T | undefined,
	limitMs: number,
	stepMs = BUS_POLL_INTERVAL_MS,
): Promise<{ value: T; elapsedMs: number } | undefined> {
	for (let elapsedMs = 0; elapsedMs <= limitMs; elapsedMs += stepMs) {
		const value = read();
		if (value !== undefined) return { value, elapsedMs };
		await vi.advanceTimersByTimeAsync(stepMs);
		await settleFileIo();
	}
	return undefined;
}

/**
 * Lets the store finish the file I/O a fake-time step started before time moves on: the store's transactions check
 * their writers' queue and records off the event loop, so a step's work can need several real turns. It waits for
 * that I/O to finish, not for a number of turns: on a loaded machine a fixed count of turns can pass while the I/O is
 * still running, and fake time would then run ahead of the work it is meant to time. Every file request completes,
 * so the wait ends; the test's own timeout bounds a store that never does.
 */
async function settleFileIo(): Promise<void> {
	do await new Promise((resolveTurn) => setImmediate(resolveTurn));
	while (
		process.getActiveResourcesInfo().some((kind) => kind.startsWith("FSReq")) ||
		// A connection answers on its own thread, on a real turn too (#5376).
		(connectionRequests?.pending ?? 0) > 0
	);
}

let connectionRequests: ConnectionRequestTracker | undefined;
beforeEach(() => {
	connectionRequests = trackConnectionRequests();
});
afterEach(() => {
	connectionRequests?.restore();
	connectionRequests = undefined;
});

test("a lost outcome hint for a held send is noticed by the outcome poll before the hold times out", async () => {
	assert.ok(MULTI_NODE_OUTCOME_POLL_INTERVAL_MS < RESTORING_RECIPIENT_HOLD_MS);
	const dropOutcomes = (node: number, bus: WakeUpBus): WakeUpBus =>
		node === 1
			? {
					publish: (hint) =>
						hint.reason === "outcome" ? Promise.resolve({ status: "published" }) : bus.publish(hint),
					subscribe: (brokerId, listener) => bus.subscribe(brokerId, listener),
					close: () => bus.close(),
				}
			: bus;
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
	});
	try {
		const { b, sender, sent, connectChild } = await holdSendForRestoringChild(dropOutcomes);
		const child = await connectChild();
		assert.equal(messageFrames(child, sent.id).length, 0, "the lost hint cannot dispatch before the poll");
		const pollSettleBudgetMs = BUS_POLL_INTERVAL_MS * 10;
		const dispatched = await advanceUntil(() => messageFrames(child, sent.id)[0], RESTORING_RECIPIENT_HOLD_MS);
		assert.ok(dispatched !== undefined, "the held send was never dispatched to the registered child");
		assert.deepEqual(dispatched.value, { type: "message", from: sender.info, message: sent });
		assert.ok(
			dispatched.elapsedMs < MULTI_NODE_OUTCOME_POLL_INTERVAL_MS + pollSettleBudgetMs,
			`dispatched ${dispatched.elapsedMs} ms after the child registered`,
		);
		b.router.received(child, sent.id);
		assert.equal(outcomeOf(sender, sent.id), undefined, "the delivered hint is lost, so no outcome yet");
		const noticed = await advanceUntil(() => outcomeOf(sender, sent.id), RESTORING_RECIPIENT_HOLD_MS);
		assert.ok(noticed !== undefined, "the outcome poll never noticed the delivery");
		assert.equal(noticed.value.type, "delivered", JSON.stringify(noticed.value));
		assert.ok(
			noticed.elapsedMs < MULTI_NODE_OUTCOME_POLL_INTERVAL_MS + pollSettleBudgetMs,
			`the outcome was noticed ${noticed.elapsedMs} ms after the delivery`,
		);
		assert.ok(
			dispatched.elapsedMs + noticed.elapsedMs < RESTORING_RECIPIENT_HOLD_MS,
			`noticed after ${dispatched.elapsedMs + noticed.elapsedMs} ms`,
		);
		assert.equal(messageFrames(child, sent.id).length, 1, "delivered once");
	} finally {
		vi.useRealTimers();
	}
});

test("no top-level storage, memory, or a domain-only adapter leaves multi-node routing off", async () => {
	const agentDir = makeTempDirectory("intercom-multinode-off-");
	try {
		assert.equal(readSharedStorageSetting(agentDir), undefined, "no settings file");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessions: { storage: { memory: true } } }));
		assert.equal(readSharedStorageSetting(agentDir), undefined, "a domain-only session selection");
		for (const memory of [{ memory: true }, { memory: true, path: "" }, { path: ":memory:" }]) {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ storage: memory }));
			assert.equal(readSharedStorageSetting(agentDir), undefined, `in-memory ${JSON.stringify(memory)}`);
		}
		// `path: ""` selects the default storage file, which brokers on this host share.
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ storage: { path: "" } }));
		assert.deepEqual(readSharedStorageSetting(agentDir), { path: "" });

		assert.deepEqual(await resolveBrokerStateSource(undefined, agentDir), { status: "off", reason: "no-storage" });
		assert.deepEqual(await resolveBrokerStateSource({ memory: true }, agentDir), { status: "off", reason: "memory" });
		const domainOnly = join(agentDir, "domain-only-adapter.mjs");
		writeFileSync(
			domainOnly,
			"export default { atomicStorageAdapter: 1, async openSessionStore() { throw new Error('unused'); } };\n",
		);
		assert.deepEqual(await resolveBrokerStateSource({ adapter: domainOnly }, agentDir), {
			status: "off",
			reason: "domain-only-adapter",
		});

		const adapter = join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts");
		mkdirSync(join(agentDir, "shared"), { recursive: true });
		const setting = { adapter, options: { path: join(agentDir, "shared", "db.sqlite") }, prefix: "mn_" };
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ storage: setting }));
		assert.deepEqual(readSharedStorageSetting(agentDir), setting);
		const source = await resolveBrokerStateSource(setting, agentDir);
		assert.equal(source.status, "shared");
		if (source.status === "shared") {
			const database = await source.source.openDatabase();
			const probe = await database.get<{ domain: string }>("SELECT domain FROM adapter_probe");
			assert.equal(probe?.domain, "intercom");
			await database.close();
		}
	} finally {
		removeTempDirectory(agentDir);
	}
});

test("multi-node routing stays off when the host storage module cannot load or the selection resolves to no database", async () => {
	const agentDir = makeTempDirectory("intercom-multinode-startup-");
	const realOpener = async () => {
		const loaded = await import("../../packages/intercom/broker/open-broker-state.js");
		return {
			resolveBrokerStateSource: (value: Record<string, unknown>, directory: string) =>
				loaded.resolveBrokerStateSource(value as Parameters<typeof loaded.resolveBrokerStateSource>[0], directory),
			openIntercomBrokerState: (source: SharedDatabaseSource) => loaded.openIntercomBrokerState(source),
		};
	};
	try {
		const adapter = join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts");
		const setting = { adapter, options: { path: join(agentDir, "db.sqlite") }, prefix: "mn_" };
		// A host without the storage module: `open-broker-state.ts` cannot import `@bastani/atomic/storage`.
		const missingHost = await resolveMultiNodeStartup(setting, agentDir, () =>
			Promise.reject(new Error("Cannot find package '@bastani/atomic'")),
		);
		assert.equal(missingHost.status, "off");
		assert.equal(missingHost.status === "off" ? missingHost.reason : "", "Cannot find package '@bastani/atomic'");

		const domainOnly = join(agentDir, "domain-only-adapter.mjs");
		writeFileSync(domainOnly, "export default { atomicStorageAdapter: 1, async openSessionStore() {} };\n");
		assert.deepEqual(await resolveMultiNodeStartup({ adapter: domainOnly }, agentDir, realOpener), {
			status: "off",
			reason: "domain-only-adapter",
		});
		const unloadable = await resolveMultiNodeStartup(
			{ adapter: join(agentDir, "missing.mjs") },
			agentDir,
			realOpener,
		);
		assert.equal(unloadable.status, "off");
		assert.ok(unloadable.status === "off" && unloadable.error !== undefined);

		const shared = await resolveMultiNodeStartup(setting, agentDir, realOpener);
		assert.equal(shared.status, "shared");
	} finally {
		removeTempDirectory(agentDir);
	}
});

test(
	"registration waits for its presence lease at most the bound while the shared database does not answer",
	async () => {
		const [node] = await cluster(1);
		const knownSessions = node!.opened.state.knownSessions;
		const record = knownSessions.record.bind(knownSessions);
		let answer: () => void = () => {};
		const answered = new Promise<void>((resolveAnswer) => {
			answer = resolveAnswer;
		});
		Object.assign(knownSessions, {
			record: async (...args: Parameters<typeof record>) => {
				await answered;
				return record(...args);
			},
		});
		try {
			const started = Date.now();
			await node!.connect("hung-database");
			const elapsedMs = Date.now() - started;
			assert.ok(elapsedMs >= PRESENCE_REGISTRATION_BOUND_MS - 100, `resolved after ${elapsedMs} ms`);
		} finally {
			answer();
		}
	},
	PRESENCE_REGISTRATION_BOUND_MS + CROSS_NODE_WAIT_MS,
);

function knownSessionFixture(): OpenSharedStoreFixture<Awaited<ReturnType<typeof openSqlKnownSessionStore>>> {
	return async (): Promise<SharedStoreFixture<Awaited<ReturnType<typeof openSqlKnownSessionStore>>>> => {
		const directory = makeTempDirectory("intercom-multinode-known-");
		const connections: SqliteDatabase[] = [];
		return {
			async connect() {
				const database = await openNodeSqliteDatabase(join(directory, "intercom.sqlite"));
				connections.push(database);
				const options: IntercomBrokerStateOptions = { database, prefix: "team_" };
				// The lease store's table, which a broker opens first: an unanswered claim's `reclaim` reads it.
				await openSqlBrokerLeaseStore(options);
				return openSqlKnownSessionStore(options);
			},
			async close() {
				await Promise.all(connections.map((database) => database.close()));
				removeTempDirectory(directory);
			},
		};
	};
}

registerKnownSessionStoreConformance(test, "SQL on two node:sqlite connections to one file", knownSessionFixture());
registerIdOwnerConformance(test, "SQL on two node:sqlite connections to one file", knownSessionFixture());

/** Wait until no live presence lease names this session, so a send to it is queued for an offline session. */
async function waitOffline(node: Node, session: BrokerConnectedSession): Promise<void> {
	await vi.waitFor(
		async () => {
			const live = await node.opened.state.leases.listLive("presence", 30_000);
			assert.ok(
				!live.some((lease) => lease.subject.kind === "presence" && lease.subject.session.id === session.info.id),
			);
		},
		{ timeout: CROSS_NODE_WAIT_MS },
	);
}

function reasonOf(frame: BrokerOutboundFrame | undefined): string | undefined {
	return frame?.type === "delivery_failed" ? frame.reason : undefined;
}

test("a queued message with an unrelated replyTo is refused when its recipient left the sender's group in transit", async () => {
	const [a, b, c] = await cluster(3);
	const sender = await a!.connect("sender", { group: "team" });
	const recipient = await b!.connect("recipient", { group: "team" });
	b!.leave(recipient);
	await waitOffline(a!, recipient);
	const sent = message({ replyTo: "no-such-question" });
	a!.send(sender, "recipient", sent);
	assert.equal((await waitFor(() => outcomeOf(sender, sent.id))).type, "queued");

	const back = await c!.connect("recipient", {
		group: "team",
		groups: ["elsewhere"],
		returnAddress: recipient.registrationReturnAddress!,
		id: recipient.info.id,
	});
	const refused = await waitFor(() =>
		framesOf(sender).find((frame) => frame.type === "delivery_failed" && frame.messageId === sent.id),
	);
	assert.equal(reasonOf(refused), "Target session is in a different intercom group");
	assert.deepEqual(messageFrames(back, sent.id), []);
});

test("an ask queued for an offline session that reconnects on the asker's broker can be answered there", async () => {
	const [a, b] = await cluster();
	const asker = await a!.connect("asker");
	const replier = await b!.connect("replier");
	b!.leave(replier);
	await waitOffline(a!, replier);
	const ask = message({ expectsReply: true });
	a!.send(asker, "replier", ask);
	assert.equal((await waitFor(() => outcomeOf(asker, ask.id))).type, "queued");

	const back = await a!.connect("replier", { returnAddress: replier.registrationReturnAddress!, id: replier.info.id });
	await waitFor(() => messageFrames(back, ask.id)[0]);
	a!.router.received(back, ask.id);
	await waitFor(() => framesOf(asker).find((frame) => frame.type === "delivered" && frame.messageId === ask.id));

	const reply = message({ replyTo: ask.id, content: { text: "answered locally" } });
	a!.send(back, asker.info.id, reply, { requirePendingReply: true, expectedRecipientId: asker.info.id });
	const frame = await waitFor(() => messageFrames(asker, reply.id)[0] ?? reasonOf(outcomeOf(back, reply.id)));
	assert.deepEqual(frame, { type: "message", from: back.info, message: reply });
});

test("a same-id retry of a message delivered across nodes is not delivered again after its recipient moves to the sender's broker", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	const sent = message();
	a!.send(sender, "recipient", sent);
	await waitFor(() => messageFrames(recipient, sent.id)[0]);
	b!.router.received(recipient, sent.id);
	assert.equal((await waitFor(() => outcomeOf(sender, sent.id))).type, "delivered");

	b!.leave(recipient);
	const back = await a!.connect("recipient", {
		returnAddress: recipient.registrationReturnAddress!,
		id: recipient.info.id,
	});
	a!.send(sender, "recipient", sent);
	const outcomes = await waitFor(() => {
		const all = framesOf(sender).filter(
			(frame) => (frame.type === "delivered" || frame.type === "delivery_failed") && frame.messageId === sent.id,
		);
		return all.length >= 2 ? all : undefined;
	});
	assert.equal(outcomes[1]?.type, "delivered");
	assert.deepEqual(messageFrames(back, sent.id), []);
});

test("a local send is delivered at once when the shared database stops answering its retry lookup, and only once", async () => {
	const [a] = await cluster(1);
	const sender = await a!.connect("sender");
	const recipient = await a!.connect("recipient");
	const outbox = a!.opened.state.outbox;
	let answerLate: (result: Awaited<ReturnType<typeof outbox.read>>) => void = () => {};
	Object.assign(outbox, {
		read: () =>
			new Promise<Awaited<ReturnType<typeof outbox.read>>>((resolve) => {
				answerLate = resolve;
			}),
	});
	const sent = message();
	a!.send(sender, "recipient", sent);
	await waitFor(() => messageFrames(recipient, sent.id)[0], LOCAL_RETRY_LOOKUP_BOUND_MS + 2_000);
	a!.router.received(recipient, sent.id);
	answerLate({ status: "missing" });
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(messageFrames(recipient, sent.id).length, 1);
	const outcomes = framesOf(sender).filter(
		(frame) => (frame.type === "delivered" || frame.type === "delivery_failed") && frame.messageId === sent.id,
	);
	assert.ok(outcomes.length <= 1, JSON.stringify(outcomes));
});

test("a reply whose ask's only route is on another broker is refused as retryable even when the shared database is slow to answer its retry lookup (#4997)", async () => {
	const [a, b] = await cluster();
	// The ask is kept by broker b, where both of its peers are present.
	const asker = await b!.connect("asker");
	const recipient = await b!.connect("recipient");
	const ask = message({ expectsReply: true });
	b!.send(asker, "recipient", ask);
	await waitFor(() => messageFrames(recipient, ask.id)[0]);
	// Broker b stops answering: both sessions come back on broker a, whose routes do not have the ask. #5607: their ids
	// are free once b's ownership of them lapsed, as when it is down long enough or restarted.
	await b!.opened.state.knownSessions.owners?.retireBroker(b!.router.brokerId);
	const askerOnA = await a!.connect("asker", { returnAddress: asker.registrationReturnAddress!, id: asker.info.id });
	const recipientOnA = await a!.connect("recipient", {
		returnAddress: recipient.registrationReturnAddress!,
		id: recipient.info.id,
	});
	const bystander = await a!.connect("bystander");
	// The shared outbox never answers whether the reply is a retry of a cross-node send within the local bound.
	const outbox = a!.opened.state.outbox;
	Object.assign(outbox, { read: () => new Promise<Awaited<ReturnType<typeof outbox.read>>>(() => {}) });

	const reply = message({ replyTo: ask.id, content: { text: "answer" } });
	a!.send(recipientOnA, asker.info.id, reply, { requirePendingReply: true, expectedRecipientId: asker.info.id });
	const refused = await waitFor(() => outcomeOf(recipientOnA, reply.id));
	assert.equal(refused.type, "delivery_failed");
	assert.equal(refused.type === "delivery_failed" && refused.routeUnavailable, true, reasonOf(refused));
	assert.deepEqual(messageFrames(askerOnA, reply.id), []);

	// A session no route could authorize is still refused for good.
	const forged = message({ replyTo: ask.id, content: { text: "forged" } });
	a!.send(bystander, asker.info.id, forged, { requirePendingReply: true, expectedRecipientId: asker.info.id });
	const unauthorized = await waitFor(() => outcomeOf(bystander, forged.id));
	assert.equal(unauthorized.type === "delivery_failed" && unauthorized.routeUnavailable, undefined);
	assert.match(reasonOf(unauthorized) ?? "", /does not authorize this public reply/);
	assert.deepEqual(messageFrames(askerOnA, forged.id), []);
});

test(
	"a reply that no local route authorizes is answered once, as retryable, when the shared database stops answering whether its route is elsewhere (#4997)",
	async () => {
		const [a] = await cluster(1);
		const asker = await a!.connect("asker");
		const replier = await a!.connect("replier");
		const { outbox, leases } = a!.opened.state;
		// Both reads stop answering until the end of the test, when they answer, late.
		const stalled: Array<() => void> = [];
		const stall =
			<A extends unknown[], R>(read: (...args: A) => Promise<R>) =>
			(...args: A) =>
				new Promise<R>((resolve, reject) => stalled.push(() => read(...args).then(resolve, reject)));
		const [outboxRead, leasesRead] = [outbox.read.bind(outbox), leases.read.bind(leases)];
		Object.assign(outbox, { read: stall(outboxRead) });
		Object.assign(leases, { read: stall(leasesRead) });
		cleanups.push(async () => {
			Object.assign(outbox, { read: outboxRead });
			Object.assign(leases, { read: leasesRead });
			for (const answer of stalled.splice(0)) answer();
		});

		const reply = message({ replyTo: randomUUID(), content: { text: "answer" } });
		a!.send(replier, asker.info.id, reply, { requirePendingReply: true, expectedRecipientId: asker.info.id });
		const refused = await waitFor(
			() => outcomeOf(replier, reply.id),
			LOCAL_RETRY_LOOKUP_BOUND_MS + 2 * PRESENCE_REGISTRATION_BOUND_MS + 2_000,
		);
		assert.equal(refused.type === "delivery_failed" && refused.routeUnavailable, true, reasonOf(refused));
		// The late answers decide nothing more.
		for (const answer of stalled.splice(0)) answer();
		await new Promise((resolve) => setTimeout(resolve, 200));
		const outcomes = framesOf(replier).filter(
			(frame) => (frame.type === "delivered" || frame.type === "delivery_failed") && frame.messageId === reply.id,
		);
		assert.equal(outcomes.length, 1, JSON.stringify(outcomes));
		assert.deepEqual(messageFrames(asker, reply.id), []);
	},
	LOCAL_RETRY_LOOKUP_BOUND_MS + 2 * PRESENCE_REGISTRATION_BOUND_MS + 10_000,
);

test("a reply the shared database never decides is refused as retryable within one bound, before its sender stops waiting (#5607)", async () => {
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
	});
	try {
		const [a] = await cluster(1);
		const asker = await a!.connect("asker");
		const replier = await a!.connect("replier");
		const { outbox, pendingAsks } = a!.opened.state;
		// Whether the reply is a retry, its ask's route in the shared state, and whether that ask was answered: no
		// answer until the end of the test, when they answer, late.
		const stalled: Array<() => void> = [];
		const stall =
			<A extends unknown[], R>(read: (...args: A) => Promise<R>) =>
			(...args: A) =>
				new Promise<R>((resolve, reject) => stalled.push(() => read(...args).then(resolve, reject)));
		const reads = {
			outbox: { read: outbox.read.bind(outbox) },
			pendingAsks: {
				matchesReply: pendingAsks.matchesReply.bind(pendingAsks),
				isSettled: pendingAsks.isSettled.bind(pendingAsks),
			},
		};
		Object.assign(outbox, { read: stall(reads.outbox.read) });
		Object.assign(pendingAsks, {
			matchesReply: stall(reads.pendingAsks.matchesReply),
			isSettled: stall(reads.pendingAsks.isSettled),
		});
		cleanups.push(async () => {
			Object.assign(outbox, reads.outbox);
			Object.assign(pendingAsks, reads.pendingAsks);
			for (const answer of stalled.splice(0)) answer();
		});

		const reply = message({ replyTo: randomUUID(), content: { text: "answer" } });
		a!.send(replier, asker.info.id, reply, { requirePendingReply: true, expectedRecipientId: asker.info.id });
		const stepMs = 100;
		const refused = await advanceUntil(() => outcomeOf(replier, reply.id), SEND_RESPONSE_TIMEOUT_MS, stepMs);
		assert.ok(refused !== undefined, "the reply was answered only after its sender stopped waiting");
		assert.equal(
			refused.value.type === "delivery_failed" && refused.value.routeUnavailable,
			true,
			reasonOf(refused.value),
		);
		// The retry lookup's bound, then one bound for both lookups of the ask's route.
		assert.ok(
			refused.elapsedMs <= LOCAL_RETRY_LOOKUP_BOUND_MS + PRESENCE_REGISTRATION_BOUND_MS + stepMs,
			`answered ${refused.elapsedMs} ms after it was sent`,
		);
		assert.deepEqual(messageFrames(asker, reply.id), []);
	} finally {
		vi.useRealTimers();
	}
});

test("a same-id retry of a message delivered locally is not delivered again after its recipient moves to another broker", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await a!.connect("recipient");
	const sent = message();
	a!.send(sender, "recipient", sent);
	await waitFor(() => messageFrames(recipient, sent.id)[0]);
	assert.equal((await waitFor(() => outcomeOf(sender, sent.id))).type, "delivered");

	a!.leave(recipient);
	const moved = await b!.connect("recipient", {
		returnAddress: recipient.registrationReturnAddress!,
		id: recipient.info.id,
	});
	a!.send(sender, "recipient", sent);
	const outcomes = () =>
		framesOf(sender).filter(
			(frame) => (frame.type === "delivered" || frame.type === "delivery_failed") && frame.messageId === sent.id,
		);
	await waitFor(() => (outcomes().length >= 2 || messageFrames(moved, sent.id).length > 0 ? true : undefined));
	await new Promise((resolve) => setTimeout(resolve, 20 * BUS_POLL_INTERVAL_MS));
	assert.deepEqual(messageFrames(moved, sent.id), [], "one logical message, one recipient frame");
	assert.equal(messageFrames(recipient, sent.id).length, 1);
	assert.equal(outcomes()[1]?.type, "delivered");
});

test("a restoring reservation released while its shared reserve is still being written ends in the shared store", async () => {
	const [a, b] = await cluster();
	const supervisor = await b!.connect("supervisor", { group: "crew" });
	const sender = await a!.connect("sender", { group: "crew" });
	const capability = `${randomUUID()}.capability`;
	b!.router.restoringReserved(capability, supervisor.info.id, "restored-child", normalizeGroup("crew"), [], false);
	b!.router.restoringReleased(capability, supervisor.info.id);
	await vi.waitFor(
		async () => {
			const read = await a!.opened.state.reservations.read(createHash("sha256").update(capability).digest("hex"));
			assert.equal(read.status, "ended", JSON.stringify(read));
		},
		{ timeout: CROSS_NODE_WAIT_MS },
	);
	const lookup = await a!.opened.state.reservations.lookup(
		"restored-child",
		{ sessionId: sender.info.id, groups: [normalizeGroup("crew")] },
		30_000,
	);
	assert.equal(lookup.status, "none");
});

test("a released child reserved through one broker is not taken over through another: the store refuses and that broker revokes its own reservation (#4326)", async () => {
	const [a, b] = await cluster();
	const owner = await b!.connect("owner", { group: "crew" });
	const intruder = await a!.connect("intruder", { group: "crew" });
	const key = releasedReservationKey("released-child");
	const options = { wake: true, replaceAliases: true } as const;
	b!.router.restoringReserved(key, owner.info.id, "released-child", normalizeGroup("crew"), [], true, options);
	await vi.waitFor(
		async () => {
			const read = await a!.opened.state.reservations.read(key);
			assert.equal(read.status === "active" ? read.reservation.ownerSessionId : read.status, owner.info.id);
		},
		{ timeout: CROSS_NODE_WAIT_MS },
	);
	a!.router.restoringReserved(key, intruder.info.id, "released-child", normalizeGroup("crew"), [], true, options);
	await vi.waitFor(() => assert.deepEqual(a!.revoked, [{ key, ownerSessionId: intruder.info.id }]), {
		timeout: CROSS_NODE_WAIT_MS,
	});
	const read = await a!.opened.state.reservations.read(key);
	assert.equal(read.status, "active");
	assert.equal(read.status === "active" ? read.reservation.ownerSessionId : undefined, owner.info.id);
	assert.equal(read.status === "active" ? read.reservation.ownerBrokerId : undefined, b!.router.brokerId);
	assert.deepEqual(b!.revoked, []);
});

test("a restoring reservation whose shared reserve is still being written when its supervisor leaves ends in the shared store", async () => {
	const [a, b] = await cluster();
	const supervisor = await b!.connect("supervisor", { group: "crew" });
	const sender = await a!.connect("sender", { group: "crew" });
	const reservations = b!.opened.state.reservations;
	const reserve = reservations.reserve.bind(reservations);
	let written: () => void = () => {};
	const writing = new Promise<void>((resolve) => {
		written = resolve;
	});
	Object.assign(reservations, {
		reserve: async (...args: Parameters<typeof reserve>) => {
			await writing;
			return reserve(...args);
		},
	});
	const capability = `${randomUUID()}.capability`;
	b!.router.restoringReserved(capability, supervisor.info.id, "restored-child", normalizeGroup("crew"), [], false);
	b!.leave(supervisor);
	await new Promise((resolve) => setTimeout(resolve, 50));
	written();
	await vi.waitFor(
		async () => {
			const read = await a!.opened.state.reservations.read(createHash("sha256").update(capability).digest("hex"));
			assert.equal(read.status, "ended", JSON.stringify(read));
		},
		{ timeout: CROSS_NODE_WAIT_MS },
	);
	const lookup = await a!.opened.state.reservations.lookup(
		"restored-child",
		{ sessionId: sender.info.id, groups: [normalizeGroup("crew")] },
		30_000,
	);
	assert.equal(lookup.status, "none");
});

test(
	"a retried reservation write still running when its child takes the reservation does not leave it in the shared store (#5352)",
	async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const reported = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const [a, b] = await cluster();
			const supervisor = await b!.connect("supervisor", { group: "crew" });
			const sender = await a!.connect("sender", { group: "crew" });
			const reservations = b!.opened.state.reservations;
			const reserve = reservations.reserve.bind(reservations);
			let attempts = 0;
			let retrying: () => void = () => {};
			const retryStarted = new Promise<void>((resolve) => {
				retrying = resolve;
			});
			let written: () => void = () => {};
			const writing = new Promise<void>((resolve) => {
				written = resolve;
			});
			let retried: (status: string) => void = () => {};
			const retryWritten = new Promise<string>((resolve) => {
				retried = resolve;
			});
			Object.assign(reservations, {
				reserve: async (...args: Parameters<typeof reserve>) => {
					if (attempts++ === 0) throw new Error("reserve failed: shared database is busy");
					retrying();
					await writing;
					const result = await reserve(...args);
					retried(result.status);
					return result;
				},
			});
			const capability = `${randomUUID()}.capability`;
			const key = createHash("sha256").update(capability).digest("hex");
			const published = await b!.router.restoringReserved(
				capability,
				supervisor.info.id,
				"restored-child",
				normalizeGroup("crew"),
				[],
				false,
			);
			assert.equal(published, false);

			vi.advanceTimersByTime(BROKER_LEASE_RENEW_INTERVAL_MS);
			await retryStarted;
			// The child takes its reservation, on its own registration's queue, while the retried write runs.
			b!.dropped.add(capability);
			await b!.connect("restored-child", { group: "crew", consumed: { capability } });
			written();
			assert.equal(await retryWritten, "reserved", "the retry wrote the reservation after the child took it");

			await vi.waitFor(
				async () => {
					const read = await a!.opened.state.reservations.read(key);
					assert.equal(read.status, "ended", JSON.stringify(read));
				},
				{ timeout: CROSS_NODE_WAIT_MS },
			);
			const lookup = await a!.opened.state.reservations.lookup(
				"restored-child",
				{ sessionId: sender.info.id, groups: [normalizeGroup("crew")] },
				30_000,
			);
			assert.equal(lookup.status, "none");
		} finally {
			vi.useRealTimers();
			reported.mockRestore();
		}
	},
	2 * CROSS_NODE_WAIT_MS,
);

test("a child that turns terminal fails the asks delivered to it from another node with the terminal error", async () => {
	const [a, b] = await cluster();
	const asker = await a!.connect("asker");
	const child = await b!.connect("child");
	const ask = message({ expectsReply: true });
	a!.send(asker, "child", ask);
	await waitFor(() => messageFrames(child, ask.id)[0]);
	b!.router.received(child, ask.id);
	assert.equal((await waitFor(() => outcomeOf(asker, ask.id))).type, "delivered");

	child.info.replyCapability = "terminal";
	b!.router.sessionUpdated(child);
	const terminal = await waitFor(() =>
		framesOf(asker).find((frame) => frame.type === "message" && frame.message.replyTo === ask.id),
	);
	assert.equal(terminal.type === "message" && terminal.message.replyError, TERMINAL_CHILD_ASK_REFUSAL);
	assert.ok(terminal.type === "message");
	assert.equal(terminal.message.id, `terminal:${ask.id}`);
	// The route stays open for the error until the asker has it.
	assert.deepEqual(
		await a!.opened.state.pendingAsks.matchesReply({
			replySenderSessionId: child.info.id,
			replyTargetSessionId: asker.info.id,
			replyTo: ask.id,
		}),
		{ status: "match" },
	);
	a!.router.received(asker, terminal.message.id);
	await vi.waitFor(
		async () =>
			assert.deepEqual(
				await a!.opened.state.pendingAsks.matchesReply({
					replySenderSessionId: child.info.id,
					replyTargetSessionId: asker.info.id,
					replyTo: ask.id,
				}),
				{ status: "no-match" },
			),
		{ timeout: CROSS_NODE_WAIT_MS },
	);
});

test("an old connection of a session that reconnected to the same broker leaves without taking the live one's presence with it", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const returnAddress = randomUUID();
	const old = await b!.connect("recipient", { returnAddress });
	// The session reconnected before this broker noticed its old connection was gone: same identity, a new id.
	const live = await b!.connect("recipient", { returnAddress });
	b!.leave(old);
	// The old connection's departure is done once it recorded the session as it last knew it.
	await vi.waitFor(
		async () => {
			const known = await b!.opened.state.knownSessions.lookup(old.info.id, KNOWN_SESSION_RETENTION_MS);
			assert.equal(known.status, "found");
		},
		{ timeout: CROSS_NODE_WAIT_MS },
	);

	const sent = message();
	a!.send(sender, live.info.id, sent);
	// Well before the presence renewal would take the lease again.
	await waitFor(() => messageFrames(live, sent.id)[0], BROKER_LEASE_RENEW_INTERVAL_MS / 2);
	b!.router.received(live, sent.id);
	assert.equal((await waitFor(() => outcomeOf(sender, sent.id))).type, "delivered");
	const leases = await b!.opened.state.leases.listLive("presence", BROKER_LEASE_RENEW_INTERVAL_MS);
	assert.ok(
		leases.some((lease) => lease.subject.kind === "presence" && lease.subject.session.id === live.info.id),
		"the live session's presence is still held",
	);
});

test(
	"a child that turns terminal while the shared store fails listing its asks once fails them once the store recovers (#5138)",
	async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const reported = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const [a, b] = await cluster();
			const asker = await a!.connect("asker");
			const child = await b!.connect("child");
			const ask = message({ expectsReply: true });
			a!.send(asker, "child", ask);
			await waitFor(() => messageFrames(child, ask.id)[0]);
			b!.router.received(child, ask.id);
			assert.equal((await waitFor(() => outcomeOf(asker, ask.id))).type, "delivered");

			const pendingAsks = b!.opened.state.pendingAsks;
			const listForTarget = pendingAsks.listForTarget.bind(pendingAsks);
			let failures = 0;
			pendingAsks.listForTarget = async (targetSessionId) => {
				if (failures++ === 0) throw new Error("listForTarget failed: shared database is busy");
				return listForTarget(targetSessionId);
			};
			child.info.replyCapability = "terminal";
			b!.router.sessionUpdated(child);
			await vi.waitFor(() => assert.equal(failures, 1), { timeout: CROSS_NODE_WAIT_MS });
			assert.ok(reported.mock.calls.some(([text]) => String(text).includes("listForTarget failed")));
			assert.equal(
				framesOf(asker).find((frame) => frame.type === "message" && frame.message.replyTo === ask.id),
				undefined,
				"nothing is failed while the store fails",
			);

			vi.advanceTimersByTime(BROKER_LEASE_RENEW_INTERVAL_MS);
			const terminal = await waitFor(() =>
				framesOf(asker).find((frame) => frame.type === "message" && frame.message.replyTo === ask.id),
			);
			assert.ok(terminal.type === "message");
			assert.equal(terminal.message.replyError, TERMINAL_CHILD_ASK_REFUSAL);
			assert.equal(terminal.message.id, `terminal:${ask.id}`);
			const listed = failures;
			vi.advanceTimersByTime(BROKER_LEASE_RENEW_INTERVAL_MS);
			b!.router.sessionUpdated(child);
			await new Promise((settle) => setTimeout(settle, 50));
			assert.equal(failures, listed, "a terminal child's asks are failed once");
		} finally {
			vi.useRealTimers();
			reported.mockRestore();
		}
	},
	2 * CROSS_NODE_WAIT_MS,
);

test("a terminal child that then ends does not fail an ask from another node a second time (#4842)", async () => {
	const [a, b] = await cluster();
	const asker = await a!.connect("asker");
	const child = await b!.connect("child");
	const ask = message({ expectsReply: true });
	a!.send(asker, "child", ask);
	await waitFor(() => messageFrames(child, ask.id)[0]);
	b!.router.received(child, ask.id);
	assert.equal((await waitFor(() => outcomeOf(asker, ask.id))).type, "delivered");
	const failures = () =>
		framesOf(asker).filter((frame) => frame.type === "message" && frame.message.replyTo === ask.id);

	child.info.replyCapability = "terminal";
	b!.router.sessionUpdated(child);
	await waitFor(() => failures()[0]);
	// The asker has not confirmed the terminal error yet when the child ends.
	b!.leave(child);
	// A second failure would cross the nodes as fast as the first did.
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));

	assert.equal(failures().length, 1, "the asker is told once");
	assert.ok(
		failures().every((frame) => frame.type === "message" && frame.message.replyError === TERMINAL_CHILD_ASK_REFUSAL),
	);
});

test("a recipient that ends fails an ask from another node with the reason a local asker gets, and its route ends with it (#4842)", async () => {
	const [a, b] = await cluster();
	const asker = await a!.connect("asker");
	const recipient = await b!.connect("recipient");
	const ask = message({ expectsReply: true });
	a!.send(asker, "recipient", ask);
	await waitFor(() => messageFrames(recipient, ask.id)[0]);
	b!.router.received(recipient, ask.id);
	assert.equal((await waitFor(() => outcomeOf(asker, ask.id))).type, "delivered");

	b!.leave(recipient);
	const failure = await waitFor(() =>
		framesOf(asker).find((frame) => frame.type === "message" && frame.message.replyTo === ask.id),
	);
	assert.ok(failure.type === "message");
	assert.equal(failure.message.id, `ended:${ask.id}`);
	assert.equal(failure.message.replyError, 'Session "recipient" ended before replying');
	assert.equal(failure.from.id, recipient.info.id);
	// The asker shares its group: the failure needs no route, and a late reply from the ended session is refused.
	assert.deepEqual(
		await a!.opened.state.pendingAsks.matchesReply({
			replySenderSessionId: recipient.info.id,
			replyTargetSessionId: asker.info.id,
			replyTo: ask.id,
		}),
		{ status: "no-match" },
	);
});

test("an asker that shares only one of its groups with an ended recipient gets its failure without a route reopened for it (#4842)", async () => {
	const [a, b] = await cluster();
	const asker = await a!.connect("asker", { groups: ["default", "elsewhere"] });
	const recipient = await b!.connect("recipient");
	const ask = message({ expectsReply: true });
	a!.send(asker, "recipient", ask);
	await waitFor(() => messageFrames(recipient, ask.id)[0]);
	b!.router.received(recipient, ask.id);
	assert.equal((await waitFor(() => outcomeOf(asker, ask.id))).type, "delivered");

	b!.leave(recipient);
	const failure = await waitFor(() =>
		framesOf(asker).find((frame) => frame.type === "message" && frame.message.replyTo === ask.id),
	);
	assert.ok(failure.type === "message");
	assert.equal(failure.message.replyError, 'Session "recipient" ended before replying');
	// One shared group is enough: a late reply from the ended session is refused.
	assert.deepEqual(
		await a!.opened.state.pendingAsks.matchesReply({
			replySenderSessionId: recipient.info.id,
			replyTargetSessionId: asker.info.id,
			replyTo: ask.id,
		}),
		{ status: "no-match" },
	);
});

test("a recipient that ends still fails a known asker's ask after an ask whose asker is no longer known (#4842)", async () => {
	const [a, b] = await cluster();
	const asker = await a!.connect("asker");
	const recipient = await b!.connect("recipient");
	// An older ask whose asker is neither live nor remembered any more: no one can be told about it.
	await b!.opened.state.pendingAsks.record({
		senderSessionId: randomUUID(),
		targetSessionId: recipient.info.id,
		messageId: randomUUID(),
	});
	const ask = message({ expectsReply: true });
	a!.send(asker, "recipient", ask);
	await waitFor(() => messageFrames(recipient, ask.id)[0]);
	b!.router.received(recipient, ask.id);
	assert.equal((await waitFor(() => outcomeOf(asker, ask.id))).type, "delivered");

	b!.leave(recipient);
	const failure = await waitFor(() =>
		framesOf(asker).find((frame) => frame.type === "message" && frame.message.replyTo === ask.id),
	);
	assert.ok(failure.type === "message");
	assert.equal(failure.message.replyError, 'Session "recipient" ended before replying');
});

test("an asker that moved to its recipient's broker while away gets the failure there when the recipient ends (#4842)", async () => {
	const [a, b] = await cluster();
	const returnAddress = randomUUID();
	const asker = await a!.connect("asker", { returnAddress });
	const recipient = await b!.connect("recipient");
	const ask = message({ expectsReply: true });
	a!.send(asker, "recipient", ask);
	await waitFor(() => messageFrames(recipient, ask.id)[0]);
	b!.router.received(recipient, ask.id);
	assert.equal((await waitFor(() => outcomeOf(asker, ask.id))).type, "delivered");
	// The asker is only away, and comes back on the recipient's broker under the same id.
	a!.sessions.delete(asker.info.id);
	a!.router.sessionLeft(asker, undefined, false);
	const back = await b!.connect("asker", { returnAddress, id: asker.info.id });

	b!.leave(recipient);
	const failure = await waitFor(() =>
		framesOf(back).find((frame) => frame.type === "message" && frame.message.replyTo === ask.id),
	);
	assert.ok(failure.type === "message");
	assert.equal(failure.message.replyError, 'Session "recipient" ended before replying');
});

/**
 * Counts the statements `database` runs for calls made inside `within`, those of its transactions included: a broker's
 * polls and renewals run outside any send, so what runs inside a send's context is what that send costs.
 */
function countStatements(database: SqliteDatabase, within: AsyncLocalStorage<true>) {
	let count = 0;
	const tally = () => {
		if (within.getStore() === true) count++;
	};
	const counted = (executor: SqliteExecutor): SqliteExecutor => ({
		exec: (sql) => {
			tally();
			return executor.exec(sql);
		},
		run: (sql, ...params) => {
			tally();
			return executor.run(sql, ...params);
		},
		get: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
			tally();
			return executor.get<T>(sql, ...params);
		},
		all: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
			tally();
			return executor.all<T>(sql, ...params);
		},
	});
	const original = {
		exec: database.exec.bind(database),
		run: database.run.bind(database),
		get: database.get.bind(database),
		all: database.all.bind(database),
		transaction: database.transaction.bind(database),
	};
	Object.assign(database, counted(original), {
		transaction: <T>(
			callback: (transaction: SqliteExecutor) => Promise<T>,
			options?: Parameters<SqliteDatabase["transaction"]>[1],
		) => original.transaction((transaction) => callback(counted(transaction)), options),
	});
	return { count: () => count, restore: () => Object.assign(database, original) };
}

/**
 * What queuing one send for an offline session costs the shared database: its target resolved (the live presences, a
 * reservation, its known session and its id's binding), its row looked up, reserved and written in one transaction (the
 * write reads the row back, with the broker its recipient's presence names, #5607), and one read once it is written.
 */
const QUEUED_SEND_STATEMENTS = 11;

test("sends queued for a session that stays offline cost the shared database no more statements each than before (#5607)", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("away");
	b!.leave(recipient);
	await waitOffline(a!, recipient);
	const sends = 64;
	const within = new AsyncLocalStorage<true>();
	const statements = countStatements(a!.database, within);
	try {
		for (let index = 0; index < sends; index++) {
			const sent = message({ content: { text: `queued ${index}` } });
			const outcome = await within.run(true, () => sendAndSettle(a!, sender, "away", sent));
			assert.ok(outcome.type === "queued");
			assert.equal(outcome.position, index + 1);
		}
		// What a send still does after its sender heard it is queued is counted too.
		await vi.waitFor(() => assert.ok(statements.count() >= sends * QUEUED_SEND_STATEMENTS), {
			timeout: CROSS_NODE_WAIT_MS,
		});
		await new Promise((resolveSettled) => setTimeout(resolveSettled, 250));
	} finally {
		statements.restore();
	}
	assert.equal(statements.count(), sends * QUEUED_SEND_STATEMENTS);
});

test("an ask whose route write fails is redelivered and keeps its reply route instead of settling without one", async () => {
	const [a, b] = await cluster();
	const asker = await a!.connect("asker");
	const replier = await b!.connect("replier");
	const pendingAsks = b!.opened.state.pendingAsks;
	const record = pendingAsks.record.bind(pendingAsks);
	let failures = 1;
	Object.assign(pendingAsks, {
		record: async (...args: Parameters<typeof record>) => {
			if (failures-- > 0) throw new Error("stopped between the route and delivered writes");
			return record(...args);
		},
	});
	const ask = message({ expectsReply: true });
	a!.send(asker, "replier", ask);
	await waitFor(() => messageFrames(replier, ask.id)[0]);
	b!.router.received(replier, ask.id);
	await waitFor(() => (messageFrames(replier, ask.id).length >= 2 ? true : undefined));
	b!.router.received(replier, ask.id);
	assert.equal((await waitFor(() => outcomeOf(asker, ask.id))).type, "delivered");

	const reply = message({ replyTo: ask.id, content: { text: "route kept" } });
	b!.send(replier, asker.info.id, reply, { requirePendingReply: true, expectedRecipientId: asker.info.id });
	const frame = await waitFor(() => messageFrames(asker, reply.id)[0] ?? reasonOf(outcomeOf(replier, reply.id)));
	assert.deepEqual(frame, { type: "message", from: replier.info, message: reply });
});

test("an away session's asks move to the shared state only once it has them, and stay here otherwise (#4997)", async () => {
	const [a] = await cluster(1);
	const pendingAsks = a!.opened.state.pendingAsks;
	const record = pendingAsks.record.bind(pendingAsks);
	const question = () => ({ senderSessionId: randomUUID(), targetSessionId: randomUUID(), messageId: randomUUID() });
	const [moved, refused, takenUp, failed] = [question(), question(), question(), question()];
	let failedAttempted = false;
	Object.assign(pendingAsks, {
		record: async (ask: Parameters<typeof record>[0]) => {
			if (ask.messageId === refused.messageId) return { status: "invalid", reason: "empty-target-identity" };
			if (ask.messageId === failed.messageId) {
				failedAttempted = true;
				throw new Error("shared database stopped answering");
			}
			const recorded = await record(ask);
			// This broker answers it while its shared route is being written.
			if (ask.messageId === takenUp.messageId) a!.pendingQuestions.forgetDormant(takenUp);
			return recorded;
		},
	});
	const shared = async (route: typeof moved) =>
		(
			await pendingAsks.matchesReply({
				replySenderSessionId: route.targetSessionId,
				replyTargetSessionId: route.senderSessionId,
				replyTo: route.messageId,
			})
		).status;
	const kept = [moved, refused, takenUp, failed];
	a!.pendingQuestions.keepDormant(kept, "asker-return-address");
	void a!.router.publishAwayRoutes(kept);

	await vi.waitFor(() => assert.equal(failedAttempted, true), { timeout: CROSS_NODE_WAIT_MS, interval: 10 });
	// Taken up here while its shared route was written, so the shared route is settled.
	await vi.waitFor(async () => assert.equal(await shared(takenUp), "no-match"), { timeout: CROSS_NODE_WAIT_MS });
	assert.equal(await shared(moved), "match", "the shared state has the moved ask");
	assert.equal(a!.pendingQuestions.isDormant(refused), true, "a refused ask stays kept here");
	assert.equal(a!.pendingQuestions.isDormant(failed), true, "an ask the shared state failed to take stays kept here");
	assert.equal(await shared(refused), "no-match");
	assert.equal(await shared(failed), "no-match");
	assert.equal(a!.pendingQuestions.isDormant(takenUp), false);

	// Both of its peers are back on this broker, which takes the moved ask up again: its shared route is settled.
	a!.router.settleRestoredRoutes([moved]);
	await vi.waitFor(async () => assert.equal(await shared(moved), "no-match"), { timeout: CROSS_NODE_WAIT_MS });
});

test(
	"a session that stays connected past the known-session retention is still known after its broker stops",
	async () => {
		const [a] = await cluster(1);
		const session = await a!.connect("long-lived");
		const shared = a!.opened.state.knownSessions;
		const aged = KNOWN_SESSION_RETENTION_MS + 60_000;
		const lookup = async () => {
			const found = await shared.lookup(session.info.id, KNOWN_SESSION_RETENTION_MS);
			return found.status === "found" && found.sessions.length > 0;
		};
		// Its record was written when it registered, longer ago than the retention.
		await a!.database.run("UPDATE mn_intercom_known_sessions SET recorded_at = recorded_at - ?", aged);
		assert.equal(await lookup(), false, "the aged record is past the retention");
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(Date.now() + KNOWN_SESSION_REFRESH_INTERVAL_MS);
			const deadline = performance.now() + BROKER_LEASE_RENEW_INTERVAL_MS + CROSS_NODE_WAIT_MS;
			while (!(await lookup()) && performance.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 50));
		} finally {
			vi.useRealTimers();
		}
		assert.equal(await lookup(), true, "renewal refreshed the record of the live session");
	},
	BROKER_LEASE_RENEW_INTERVAL_MS + 2 * CROSS_NODE_WAIT_MS,
);

test("an offline workflow control connection is refused like a live one, by id and by name, and never queued", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const control = await b!.connect("workflow-control", { recipientPurpose: "control" });
	const refusals = async () => {
		const reasons: (string | undefined)[] = [];
		for (const target of [control.info.id, "workflow-control"]) {
			const sent = message();
			a!.send(sender, target, sent);
			const outcome = await waitFor(() => outcomeOf(sender, sent.id));
			reasons.push(outcome.type === "delivery_failed" ? outcome.reason : outcome.type);
		}
		return reasons;
	};
	assert.deepEqual(await refusals(), [NON_AGENT_RECIPIENT_REFUSAL, NON_AGENT_RECIPIENT_REFUSAL], "live");

	b!.leave(control);
	await waitOffline(a!, control);
	assert.deepEqual(await refusals(), [NON_AGENT_RECIPIENT_REFUSAL, NON_AGENT_RECIPIENT_REFUSAL], "offline");
	const back = await b!.connect("workflow-control", {
		recipientPurpose: "control",
		returnAddress: control.registrationReturnAddress!,
		id: control.info.id,
	});
	await new Promise((resolve) => setTimeout(resolve, 10 * BUS_POLL_INTERVAL_MS));
	assert.deepEqual(
		framesOf(back).filter((frame) => frame.type === "message"),
		[],
	);
});

test("an outbox row for a workflow control connection is refused when it is claimed, not written to it", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const returnAddress = randomUUID();
	const sent = message();
	// A row a broker wrote for this identity before it registered as a control connection.
	const enqueued = await a!.opened.state.outbox.enqueue({
		targetIdentity: JSON.stringify(["return", returnAddress, normalizeGroup("default")]),
		originBrokerId: a!.router.brokerId,
		digest: "digest",
		frame: { type: "message", from: sender.info, message: sent },
	});
	assert.equal(enqueued.status, "inserted");
	const control = await b!.connect("workflow-control", { recipientPurpose: "control", returnAddress });
	await vi.waitFor(
		async () => {
			const read = await a!.opened.state.outbox.read(sent.id);
			assert.ok(read.status === "found" && read.row.state === "failed", JSON.stringify(read));
			assert.equal(read.row.failureReason, NON_AGENT_RECIPIENT_REFUSAL);
		},
		{ timeout: CROSS_NODE_WAIT_MS },
	);
	assert.deepEqual(messageFrames(control, sent.id), []);
});

test("an ask to an offline terminal child is refused like an ask to a live one", async () => {
	const [a, b] = await cluster();
	const asker = await a!.connect("asker");
	const child = await b!.connect("child", { replyCapability: "terminal" });
	const live = message({ expectsReply: true });
	a!.send(asker, "child", live);
	assert.equal(reasonOf(await waitFor(() => outcomeOf(asker, live.id))), TERMINAL_CHILD_ASK_REFUSAL);

	b!.leave(child);
	await waitOffline(a!, child);
	const offline = message({ expectsReply: true });
	a!.send(asker, "child", offline);
	assert.equal(reasonOf(await waitFor(() => outcomeOf(asker, offline.id))), TERMINAL_CHILD_ASK_REFUSAL);
	const plain = message();
	a!.send(asker, "child", plain);
	assert.equal((await waitFor(() => outcomeOf(asker, plain.id))).type, "queued", "a plain send is still queued");
});

/** A write stall on the sender's shared connection: longer than the sender's wait past the receipt wait. */
const OUTBOX_READ_STALL_MS = 5_000;
const SLOW_HOLD_TEST_TIMEOUT_MS = 4 * (RECIPIENT_RECEIPT_TIMEOUT_MS + OUTBOX_READ_STALL_MS);

test(
	"a remote recipient still saving keeps its sender waiting even when the hold check's outbox read is slow (#3983)",
	async () => {
		const [a, b] = await cluster();
		const sender = await a!.connect("sender");
		const recipient = await b!.connect("recipient");
		const sent = message();
		const sentAt = Date.now();
		a!.send(sender, "recipient", sent);
		await waitFor(() => (messageFrames(recipient, sent.id).length > 0 ? true : undefined));
		// The recipient's save is held while it reports progress, as a pooled stage's journal commit can wait.
		const saving = setInterval(() => b!.router.saving(recipient, sent.id), RECIPIENT_SAVING_REPORT_INTERVAL_MS);
		b!.router.saving(recipient, sent.id);
		// From now on the sender's broker reads the outbox behind a write stall on its shared connection.
		const outbox = a!.opened.state.outbox;
		const read = outbox.read.bind(outbox);
		const spy = vi.spyOn(outbox, "read").mockImplementation(async (messageId) => {
			await new Promise((resolveStall) => setTimeout(resolveStall, OUTBOX_READ_STALL_MS));
			return read(messageId);
		});
		try {
			const held = await waitFor(
				() =>
					framesOf(sender).find((frame) => frame.type === "send_held" && frame.messageId === sent.id) === undefined
						? undefined
						: Date.now(),
				SEND_RESPONSE_TIMEOUT_MS + OUTBOX_READ_STALL_MS,
			);
			// The sender's client gives up `SEND_RESPONSE_TIMEOUT_MS` after its send unless a hold reaches it first.
			assert.ok(
				held - sentAt < SEND_RESPONSE_TIMEOUT_MS,
				`the sender was told to keep waiting only ${held - sentAt} ms after its send`,
			);
			assert.equal(outcomeOf(sender, sent.id), undefined, "no outcome while the recipient is still saving");
			// The recipient keeps reporting through another receipt wait, then saves.
			await new Promise((resolveSave) => setTimeout(resolveSave, RECIPIENT_RECEIPT_TIMEOUT_MS));
			clearInterval(saving);
			b!.router.received(recipient, sent.id);
			const outcome = await waitFor(() => outcomeOf(sender, sent.id), CROSS_NODE_WAIT_MS + OUTBOX_READ_STALL_MS);
			assert.equal(outcome.type, "delivered", JSON.stringify(outcome));
			assert.equal(
				framesOf(sender).filter((frame) => frame.type === "delivery_failed" && frame.messageId === sent.id).length,
				0,
			);
			assert.equal(messageFrames(recipient, sent.id).length, 1, "delivered once");
		} finally {
			clearInterval(saving);
			spy.mockRestore();
		}
	},
	SLOW_HOLD_TEST_TIMEOUT_MS,
);

/** Steps fake time forward, letting the real store and bus settle between steps. */
async function advance(totalMs: number, stepMs = 500): Promise<void> {
	for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
		await vi.advanceTimersByTimeAsync(stepMs);
		await settleFileIo();
	}
}

test(
	"a send whose hold check meets a permanently stalled store keeps one read in flight and ends uncertain within the save cap (#3983)",
	async () => {
		const [a, b] = await cluster();
		const sender = await a!.connect("sender");
		const recipient = await b!.connect("recipient");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
		const outbox = a!.opened.state.outbox;
		const read = outbox.read.bind(outbox);
		let stalled = false;
		let inFlight = 0;
		let mostInFlight = 0;
		const spy = vi.spyOn(outbox, "read").mockImplementation(async (messageId) => {
			if (!stalled) return read(messageId);
			inFlight += 1;
			mostInFlight = Math.max(mostInFlight, inFlight);
			return new Promise<never>(() => {});
		});
		try {
			const sent = message();
			const sentAt = Date.now();
			a!.send(sender, "recipient", sent);
			await waitFor(() => (messageFrames(recipient, sent.id).length > 0 ? true : undefined));
			b!.router.saving(recipient, sent.id);
			stalled = true;
			await advance(RECIPIENT_SAVE_MAX_WAIT_MS + RECIPIENT_RECEIPT_TIMEOUT_MS);
			const outcome = outcomeOf(sender, sent.id);
			assert.equal(outcome?.type, "delivery_failed", JSON.stringify(outcome));
			assert.equal(mostInFlight, 1, `${mostInFlight} hold-check reads were in flight at once`);
			const holds = framesOf(sender).filter((frame) => frame.type === "send_held" && frame.messageId === sent.id);
			for (const hold of holds)
				assert.ok(
					hold.type === "send_held" && hold.timeoutMs <= RECIPIENT_SAVE_MAX_WAIT_MS,
					"no hold reaches past the save cap",
				);
			assert.ok(Date.now() - sentAt >= RECIPIENT_RECEIPT_TIMEOUT_MS);
		} finally {
			spy.mockRestore();
			vi.useRealTimers();
		}
	},
	CROSS_NODE_WAIT_MS * 6,
);

test(
	"a remote recipient that keeps reporting progress with a fast store keeps its sender waiting until the save cap (#3983)",
	async () => {
		const [a, b] = await cluster();
		const sender = await a!.connect("sender");
		const recipient = await b!.connect("recipient");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
		try {
			const sent = message();
			const sentAt = Date.now();
			a!.send(sender, "recipient", sent);
			await waitFor(() => (messageFrames(recipient, sent.id).length > 0 ? true : undefined));
			let outcomeAt: number | undefined;
			for (let elapsed = 0; elapsed < RECIPIENT_SAVE_MAX_WAIT_MS + RECIPIENT_RECEIPT_TIMEOUT_MS; ) {
				b!.router.saving(recipient, sent.id);
				await advance(RECIPIENT_SAVING_REPORT_INTERVAL_MS);
				elapsed += RECIPIENT_SAVING_REPORT_INTERVAL_MS;
				if (outcomeAt === undefined && outcomeOf(sender, sent.id) !== undefined) outcomeAt = Date.now();
			}
			assert.equal(outcomeOf(sender, sent.id)?.type, "delivery_failed");
			assert.ok(outcomeAt !== undefined);
			const waited = outcomeAt - sentAt;
			assert.ok(
				waited >= RECIPIENT_SAVE_MAX_WAIT_MS - RECIPIENT_RECEIPT_TIMEOUT_MS,
				`the sender heard the outcome after ${waited} ms, before the save cap`,
			);
			assert.ok(
				waited <= RECIPIENT_SAVE_MAX_WAIT_MS + RECIPIENT_SAVING_REPORT_INTERVAL_MS,
				`the sender waited ${waited} ms, past the save cap`,
			);
			assert.ok(
				framesOf(sender).filter((frame) => frame.type === "send_held" && frame.messageId === sent.id).length > 1,
				"progress reports held the sender",
			);
		} finally {
			vi.useRealTimers();
		}
	},
	CROSS_NODE_WAIT_MS * 6,
);

/** Fine enough that a hold check's real outbox read answers before its `send_held`-while-reading grace. */
const DECISION_STEP_MS = 100;

function holdsOf(session: BrokerConnectedSession, id: string) {
	return framesOf(session).filter((frame) => frame.type === "send_held" && frame.messageId === id);
}

/** Steps fake time until the sender's broker decides its next receipt wait: one more hold, or an outcome. */
async function nextReceiptDecision(sender: BrokerConnectedSession, id: string): Promise<void> {
	const holdsBefore = holdsOf(sender, id).length;
	const decided = await advanceUntil(
		() => (holdsOf(sender, id).length > holdsBefore || outcomeOf(sender, id) !== undefined ? true : undefined),
		2 * RECIPIENT_RECEIPT_TIMEOUT_MS,
		DECISION_STEP_MS,
	);
	assert.ok(decided !== undefined, "the sender's broker decided the receipt wait");
}

test("a remote recipient whose saving report lands only after a receipt wait keeps its sender waiting and is delivered once (#4443)", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	try {
		const sent = message();
		a!.send(sender, "recipient", sent);
		await waitFor(() => (messageFrames(recipient, sent.id).length > 0 ? true : undefined));
		// The recipient is stalled through the first receipt wait, so its saving report lands after that wait ends.
		await nextReceiptDecision(sender, sent.id);
		assert.equal(outcomeOf(sender, sent.id), undefined, JSON.stringify(outcomeOf(sender, sent.id)));
		assert.equal(holdsOf(sender, sent.id).length, 1);
		assert.equal(b!.router.saving(recipient, sent.id), true);
		await nextReceiptDecision(sender, sent.id);
		assert.equal(outcomeOf(sender, sent.id), undefined, JSON.stringify(outcomeOf(sender, sent.id)));
		assert.equal(holdsOf(sender, sent.id).length, 2, "the late report kept the sender waiting");
		assert.equal(b!.router.received(recipient, sent.id), true);
		const delivered = await advanceUntil(() => outcomeOf(sender, sent.id), CROSS_NODE_WAIT_MS, DECISION_STEP_MS);
		assert.equal(delivered?.value.type, "delivered", JSON.stringify(delivered));
		assert.equal(
			framesOf(sender).filter((frame) => frame.type === "delivery_failed" && frame.messageId === sent.id).length,
			0,
		);
		assert.equal(messageFrames(recipient, sent.id).length, 1, "delivered once");
	} finally {
		vi.useRealTimers();
	}
});

test("a remote recipient that holds a message but has stopped saving still ends its sender's wait uncertain, one forgiven receipt wait later and within the save cap (#4443)", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	try {
		const sent = message();
		const sentAt = Date.now();
		a!.send(sender, "recipient", sent);
		await waitFor(() => (messageFrames(recipient, sent.id).length > 0 ? true : undefined));
		await nextReceiptDecision(sender, sent.id);
		assert.equal(outcomeOf(sender, sent.id), undefined, "one missed report does not decide the outcome");
		await nextReceiptDecision(sender, sent.id);
		const outcome = outcomeOf(sender, sent.id);
		assert.equal(reasonOf(outcome), UNCERTAIN_RECEIPT_REASON, JSON.stringify(outcome));
		assert.equal(holdsOf(sender, sent.id).length, 1, "exactly one receipt wait was forgiven");
		const waited = Date.now() - sentAt;
		assert.ok(waited >= 2 * RECIPIENT_RECEIPT_TIMEOUT_MS, `uncertain after only ${waited} ms`);
		assert.ok(waited < 3 * RECIPIENT_RECEIPT_TIMEOUT_MS, `a stalled recipient held its sender ${waited} ms`);
		assert.ok(waited < RECIPIENT_SAVE_MAX_WAIT_MS);
		assert.equal(messageFrames(recipient, sent.id).length, 1, "delivered to the recipient once");
	} finally {
		vi.useRealTimers();
	}
});

test("only two receipt waits in a row without a fresh saving report end a remote send uncertain, and a fresh report forgives the next miss (#4443)", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	const outbox = a!.opened.state.outbox;
	const read = outbox.read.bind(outbox);
	// The store clock is real, so the age of the recipient's last report as the sender's broker reads it is scripted.
	let scriptedSavingAgeMs: number | undefined;
	const spy = vi.spyOn(outbox, "read").mockImplementation(async (messageId) => {
		const result = await read(messageId);
		if (scriptedSavingAgeMs === undefined || result.status !== "found" || result.row.state !== "claimed")
			return result;
		return { ...result, row: { ...result.row, savingAgeMs: scriptedSavingAgeMs } };
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	try {
		const sent = message();
		a!.send(sender, "recipient", sent);
		await waitFor(() => (messageFrames(recipient, sent.id).length > 0 ? true : undefined));
		const decisions: Array<string | undefined> = [];
		const decide = async (savingAgeMs: number | undefined) => {
			scriptedSavingAgeMs = savingAgeMs;
			const holdsBefore = holdsOf(sender, sent.id).length;
			await nextReceiptDecision(sender, sent.id);
			decisions.push(holdsOf(sender, sent.id).length > holdsBefore ? "held" : reasonOf(outcomeOf(sender, sent.id)));
		};
		await decide(undefined);
		await decide(RECIPIENT_RECEIPT_TIMEOUT_MS - 1);
		await decide(RECIPIENT_RECEIPT_TIMEOUT_MS);
		await decide(RECIPIENT_RECEIPT_TIMEOUT_MS);
		assert.deepEqual(decisions, ["held", "held", "held", UNCERTAIN_RECEIPT_REASON]);
		for (const hold of holdsOf(sender, sent.id))
			assert.ok(hold.type === "send_held" && hold.timeoutMs === RECIPIENT_RECEIPT_TIMEOUT_MS);
	} finally {
		spy.mockRestore();
		vi.useRealTimers();
	}
});

test("a hold check that finds no outbox row ends the remote send uncertain without reporting a routing error (#4443)", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	const outbox = a!.opened.state.outbox;
	const read = outbox.read.bind(outbox);
	let rowGone = false;
	const spy = vi
		.spyOn(outbox, "read")
		.mockImplementation(async (messageId) => (rowGone ? { status: "missing" } : read(messageId)));
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	try {
		const sent = message();
		a!.send(sender, "recipient", sent);
		await waitFor(() => (messageFrames(recipient, sent.id).length > 0 ? true : undefined));
		rowGone = true;
		await nextReceiptDecision(sender, sent.id);
		assert.equal(reasonOf(outcomeOf(sender, sent.id)), UNCERTAIN_RECEIPT_REASON);
		assert.equal(holdsOf(sender, sent.id).length, 0);
		assert.deepEqual(errors.mock.calls, []);
	} finally {
		errors.mockRestore();
		spy.mockRestore();
		vi.useRealTimers();
	}
});

test("a hold check whose read answers after the save cap has passed ends the remote send uncertain, never holding it for no time (#4443)", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	const outbox = a!.opened.state.outbox;
	const read = outbox.read.bind(outbox);
	let answerPastCap = false;
	const spy = vi.spyOn(outbox, "read").mockImplementation(async (messageId) => {
		const result = await read(messageId);
		if (!answerPastCap || result.status !== "found" || result.row.state !== "claimed") return result;
		// The read answers once the cap has passed, before the cap's own timer has run: a fresh report cannot hold.
		vi.setSystemTime(Date.now() + RECIPIENT_SAVE_MAX_WAIT_MS);
		// The cap is timed on the monotonic clock (#5058).
		const elapsed = performance.now.bind(performance);
		vi.spyOn(performance, "now").mockImplementation(() => elapsed() + RECIPIENT_SAVE_MAX_WAIT_MS);
		return { ...result, row: { ...result.row, savingAgeMs: 0 } };
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	try {
		const sent = message();
		a!.send(sender, "recipient", sent);
		await waitFor(() => (messageFrames(recipient, sent.id).length > 0 ? true : undefined));
		answerPastCap = true;
		await nextReceiptDecision(sender, sent.id);
		assert.equal(reasonOf(outcomeOf(sender, sent.id)), UNCERTAIN_RECEIPT_REASON);
		assert.deepEqual(holdsOf(sender, sent.id), []);
	} finally {
		spy.mockRestore();
		vi.restoreAllMocks();
		vi.useRealTimers();
	}
});

/**
 * Run `act`, then resolve with `read()` once it is defined, checked as each frame is written to `session` rather than
 * polled: a flood polled for its frames took a timer tick apiece (about 16 ms on Windows) on top of the work itself.
 */
async function whenWritten<T>(
	session: BrokerConnectedSession,
	read: () => T | undefined,
	what: string,
	act: () => void = () => {},
): Promise<T> {
	const socket = session.socket as FakeSocket;
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	const check = () => {
		const value = read();
		if (value !== undefined) resolve(value);
	};
	const timer = setTimeout(() => reject(new Error(`no ${what} within ${CROSS_NODE_WAIT_MS} ms`)), CROSS_NODE_WAIT_MS);
	socket.written = check;
	try {
		act();
		check();
		return await promise;
	} finally {
		clearTimeout(timer);
		socket.written = undefined;
	}
}

/** Send and wait for the sender's outcome of that send, as the broker writes it. */
function sendAndSettle(node: Node, from: BrokerConnectedSession, to: string, sent: Message) {
	return whenWritten(
		from,
		() => outcomeOf(from, sent.id),
		`outcome for ${sent.id}`,
		() => node.send(from, to, sent),
	);
}

/**
 * #4896: the most one send queued for an offline session may take on a loaded CI host. It is a few database reads and
 * one commit, which a Windows disk syncs in about 3 ms when idle and several times that beside other suites. A flood
 * makes `OUTBOX_TARGET_MAX_ROWS` such sends one after another, so its budget is this per send, not a fixed total.
 */
const QUEUED_SEND_BUDGET_MS = 60;
/** The flood's budget: every send it makes at `QUEUED_SEND_BUDGET_MS`, then its setup and its delivery, each a hop. */
const FLOOD_BUDGET_MS = (OUTBOX_TARGET_MAX_ROWS + 1) * QUEUED_SEND_BUDGET_MS + 2 * CROSS_NODE_WAIT_MS;
/**
 * #4992: a test that fills an away asker's queue queues `OUTBOX_TARGET_MAX_ROWS` messages, each at
 * `QUEUED_SEND_BUDGET_MS`, and waits seven hops around them: two for its ask, one for the asker going away, one for
 * the failure's row and three for the queue delivered when the asker returns.
 */
const FULL_QUEUE_BUDGET_MS = (OUTBOX_TARGET_MAX_ROWS + 1) * QUEUED_SEND_BUDGET_MS + 7 * CROSS_NODE_WAIT_MS;

test(
	"flooding an offline known session through another broker stops at the per-target outbox cap and keeps every queued message (#4896)",
	async () => {
		const [a, b] = await cluster();
		const sender = await a!.connect("sender");
		const recipient = await b!.connect("away");
		const returnAddress = recipient.registrationReturnAddress!;
		b!.leave(recipient);
		await waitOffline(a!, recipient);

		const sentIds: string[] = [];
		for (let index = 0; index < OUTBOX_TARGET_MAX_ROWS; index++) {
			const sent = message({ content: { text: `flood ${index}` } });
			sentIds.push(sent.id);
			assert.equal((await sendAndSettle(a!, sender, "away", sent)).type, "queued");
		}
		const overflow = message({ content: { text: "one too many" } });
		const refused = await sendAndSettle(a!, sender, "away", overflow);
		assert.equal(refused.type, "delivery_failed");
		assert.match(
			reasonOf(refused) ?? "",
			/already has the most queued Intercom messages it accepts \(1000 messages or 64 MiB\)/,
		);
		// Nothing was written for it: no row, and no reservation of its id.
		assert.deepEqual(await a!.opened.state.outbox.read(overflow.id), { status: "missing" });
		assert.deepEqual(await a!.opened.state.sentMessages.lookup({ messageId: overflow.id, digest: "" }), {
			status: "miss",
		});

		// Nothing already queued was lost: every message reaches the recipient when it returns.
		const delivered = (session: BrokerConnectedSession) =>
			framesOf(session).flatMap((frame) => (frame.type === "message" ? [frame.message.id] : []));
		const back = await b!.connect("away", { returnAddress, id: recipient.info.id });
		await whenWritten(
			back,
			() => (delivered(back).length === sentIds.length ? true : undefined),
			"delivery of every queued message",
		);
		assert.deepEqual(delivered(back), sentIds);
	},
	FLOOD_BUDGET_MS,
);

/** A delivery frame of `text`, as an outbox row holds it. */
function outboxFrame(id: string, text: string) {
	return {
		type: "message",
		from: { id: "s", name: "s", cwd: "/", model: "m", pid: 1, startedAt: 1, lastActivity: 1 },
		message: { id, timestamp: 1, content: { text } },
	} as const;
}

function enqueueFrame(node: Node, id: string, text: string, targetIdentity = "away") {
	return node.opened.state.outbox.enqueue({
		targetIdentity,
		originBrokerId: node.name,
		digest: id,
		frame: outboxFrame(id, text),
	});
}

test("the per-target outbox byte cap refuses a frame that would pass it, across connections (#4896)", async () => {
	const [a, b] = await cluster();
	const big = "x".repeat(OUTBOX_TARGET_MAX_BYTES / 4);
	for (let index = 0; index < 3; index++)
		assert.equal((await enqueueFrame(index % 2 === 0 ? a! : b!, `big-${index}`, big)).status, "inserted");
	assert.deepEqual(await enqueueFrame(b!, "big-3", big), {
		status: "full",
		limit: OUTBOX_TARGET_MAX_ROWS,
		byteLimit: OUTBOX_TARGET_MAX_BYTES,
	});
	assert.equal((await enqueueFrame(a!, "small", "fits")).status, "inserted");
	// A frame that brings the target to exactly the byte cap is admitted; one more byte is not.
	const frameBytes = (id: string, text: string) => Buffer.byteLength(JSON.stringify(outboxFrame(id, text)));
	const used = 3 * frameBytes("big-0", big) + frameBytes("small", "fits");
	const fill = "f".repeat(OUTBOX_TARGET_MAX_BYTES - used - frameBytes("exact", ""));
	assert.equal((await enqueueFrame(b!, "over-by-one", `${fill}x`)).status, "full");
	assert.equal((await enqueueFrame(b!, "exact", fill)).status, "inserted");
	assert.equal((await enqueueFrame(a!, "after-exact", "")).status, "full");
	assert.equal((await enqueueFrame(b!, "other-target", big, "elsewhere")).status, "inserted");
	assert.equal(
		(await enqueueFrame(a!, "big-0", big)).status,
		"duplicate",
		"a retry of a queued row is still answered",
	);
});

test("rows an older broker queued without their frame size still count toward the byte cap, by their frames (#4896)", async () => {
	const [a] = await cluster(1);
	const big = "x".repeat(OUTBOX_TARGET_MAX_BYTES / 4);
	for (let index = 0; index < 3; index++)
		assert.equal((await enqueueFrame(a!, `big-${index}`, big)).status, "inserted");
	// An older broker records no frame size.
	await a!.database.run("UPDATE mn_intercom_outbox SET frame_bytes = NULL");
	assert.equal((await enqueueFrame(a!, "big-3", big)).status, "full");
	assert.equal((await enqueueFrame(a!, "small", "fits")).status, "inserted");
});

test(
	"queued outbox rows expire once their recipient's known-session retention lapses, and a retry is told why (#4896)",
	async () => {
		vi.useFakeTimers({ toFake: ["setInterval"] });
		try {
			const [a, b] = await cluster();
			const sender = await a!.connect("sender");
			const recipient = await b!.connect("away");
			b!.leave(recipient);
			await waitOffline(a!, recipient);
			const old = message({ content: { text: "old" } });
			const recent = message({ content: { text: "recent" } });
			assert.equal((await sendAndSettle(a!, sender, "away", old)).type, "queued");
			assert.equal((await sendAndSettle(a!, sender, "away", recent)).type, "queued");
			// The clock moves past the retention for the older row only.
			await a!.database.run(
				"UPDATE mn_intercom_outbox SET queued_at = queued_at - ? WHERE message_id = ?",
				KNOWN_SESSION_RETENTION_MS + 60_000,
				old.id,
			);
			await a!.database.run(
				"UPDATE mn_intercom_outbox SET queued_at = queued_at - ? WHERE message_id = ?",
				KNOWN_SESSION_RETENTION_MS - 60_000,
				recent.id,
			);
			vi.advanceTimersByTime(OUTBOX_BACKUP_POLL_INTERVAL_MS);
			const expired = await vi.waitFor(
				async () => {
					const read = await a!.opened.state.outbox.read(old.id);
					assert.ok(read.status === "found" && read.row.state === "failed", "not yet expired");
					return read.row;
				},
				{ timeout: CROSS_NODE_WAIT_MS },
			);
			assert.equal(expired.failureReason, OUTBOX_EXPIRED_REASON);
			const kept = await a!.opened.state.outbox.read(recent.id);
			assert.equal(kept.status === "found" && kept.row.state, "queued");

			framesOf(sender).length = 0;
			const retried = await sendAndSettle(a!, sender, "away", old);
			assert.equal(reasonOf(retried), OUTBOX_EXPIRED_REASON);
		} finally {
			vi.useRealTimers();
		}
	},
	2 * CROSS_NODE_WAIT_MS,
);

/** An ask from `asker` that `recipient`, on `recipientNode`, saved: its route is in the shared store. */
async function savedAsk(
	askerNode: Node,
	asker: BrokerConnectedSession,
	recipientNode: Node,
	recipient: BrokerConnectedSession,
) {
	const ask = message({ expectsReply: true });
	askerNode.send(asker, recipient.info.id, ask);
	await waitFor(() => messageFrames(recipient, ask.id)[0]);
	recipientNode.router.received(recipient, ask.id);
	assert.equal((await waitFor(() => outcomeOf(asker, ask.id))).type, "delivered");
	return ask;
}

function failuresOf(session: BrokerConnectedSession, askId: string) {
	return framesOf(session).filter(
		(frame) => frame.type === "message" && frame.message.replyTo === askId && frame.message.replyError !== undefined,
	);
}

/**
 * #5145: asker on a, recipient on b. Broker b stops right after it queued the asker's failure for the ended recipient:
 * it never clears the ask nor wakes the asker's broker, so the ask stays marked ended, as long ago as a stale claim.
 * `beforeSweep` changes the queued row before the asker's broker sweeps the ask at its next backup poll, which also
 * delivers a row still queued. Resolves to the ids of the failures the asker got.
 */
async function sweptAfterQueuedFailure(beforeSweep: (node: Node, askId: string) => Promise<void> = async () => {}) {
	vi.useFakeTimers({ toFake: ["setInterval"] });
	try {
		const [a, b] = await cluster();
		const asker = await a!.connect("asker");
		const recipient = await b!.connect("recipient");
		const ask = await savedAsk(a!, asker, b!, recipient);
		const stopped = () => Promise.reject(new Error("broker b stopped"));
		Object.assign(b!.opened.state.pendingAsks, { clearReply: stopped, unmarkEnded: stopped });
		b!.leave(recipient);
		const queued = await vi.waitFor(
			async () => {
				const read = await a!.opened.state.outbox.read(`ended:${ask.id}`);
				assert.equal(read.status, "found", "the failure is not queued yet");
				return read;
			},
			{ timeout: CROSS_NODE_WAIT_MS },
		);
		assert.ok(queued.status === "found" && queued.row.state === "queued");
		const ended = async () => {
			const listed = await a!.opened.state.pendingAsks.listEnded(0);
			return listed.status === "listed" && listed.asks.some((pending) => pending.messageId === ask.id);
		};
		assert.equal(await ended(), true, "the ask is still marked ended");

		await beforeSweep(a!, ask.id);
		await a!.database.run(
			"UPDATE mn_intercom_pending_asks SET ended_at = ended_at - ? WHERE message_id = ?",
			OUTBOX_CLAIM_STALE_AFTER_MS + 60_000,
			ask.id,
		);
		vi.advanceTimersByTime(OUTBOX_BACKUP_POLL_INTERVAL_MS);
		await vi.waitFor(async () => assert.equal(await ended(), false, "the ended ask is not swept yet"), {
			timeout: CROSS_NODE_WAIT_MS,
		});
		await waitFor(() => (failuresOf(asker, ask.id).length > 0 ? true : undefined));
		vi.advanceTimersByTime(OUTBOX_BACKUP_POLL_INTERVAL_MS);
		await new Promise((resolve) => setTimeout(resolve, 10 * BUS_POLL_INTERVAL_MS));
		return {
			askId: ask.id,
			failures: failuresOf(asker, ask.id).map((frame) => (frame.type === "message" ? frame.message.id : undefined)),
		};
	} finally {
		vi.useRealTimers();
	}
}

test(
	"an asker on another node is told once when the ended recipient's broker stops after queueing its failure and before clearing the ask (#5145)",
	async () => {
		const { askId, failures } = await sweptAfterQueuedFailure();
		assert.deepEqual(failures, [`ended:${askId}`], "told once");
	},
	3 * CROSS_NODE_WAIT_MS,
);

test(
	"an asker is still told its ask failed when the failure a stopped broker queued for it expired undelivered (#5145)",
	async () => {
		const { askId, failures } = await sweptAfterQueuedFailure(async (node, id) => {
			const outbox = node.opened.state.outbox;
			const queued = await outbox.read(`ended:${id}`);
			assert.ok(queued.status === "found");
			const claimed = await outbox.claim({
				claimantId: "expiry",
				targetIdentity: queued.row.targetIdentity,
				staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS,
			});
			assert.ok(claimed.status === "claimed" && claimed.rows.length === 1);
			assert.equal((await outbox.markFailed(claimed.rows[0]!.claim, OUTBOX_EXPIRED_REASON)).status, "failed");
		});
		assert.deepEqual(failures, [`ended:${askId}`], "told once, by its own broker");
	},
	3 * CROSS_NODE_WAIT_MS,
);

/** Owner and its released subagent on b, asker on a: the asker's ask to the subagent is parked for the owner. */
async function parkedAskScene() {
	const [a, b] = await cluster();
	// Not the default group: the failure is authorized by the subagent's own group, as its sends were.
	const asker = await a!.connect("asker", { group: "crew" });
	const owner = await b!.connect("owner", { group: "crew" });
	const child = await b!.connect("child", { group: "crew", supervisorId: owner.info.id });
	const ask = await savedAsk(a!, asker, b!, child);
	b!.sessions.delete(child.info.id);
	b!.router.sessionLeft(child, { ownerSessionId: owner.info.id, childName: "child" });
	await vi.waitFor(
		async () =>
			assert.deepEqual(await a!.opened.state.pendingAsks.listParked(owner.info.id), {
				status: "listed",
				asks: [{ senderSessionId: asker.info.id, targetSessionId: child.info.id, messageId: ask.id }],
			}),
		{ timeout: CROSS_NODE_WAIT_MS },
	);
	assert.deepEqual(failuresOf(asker, ask.id), [], "a released subagent's ask is still open");
	return { a: a!, b: b!, asker, owner, child, ask };
}

async function toldOnce(scene: Awaited<ReturnType<typeof parkedAskScene>>): Promise<void> {
	const failure = await waitFor(() => failuresOf(scene.asker, scene.ask.id)[0]);
	assert.ok(failure.type === "message");
	assert.equal(failure.message.id, `ended:${scene.ask.id}`);
	assert.equal(failure.message.replyError, 'Session "child" ended before replying');
	assert.deepEqual(failure.from, {
		id: scene.child.info.id,
		name: "child",
		group: "crew",
		groups: ["crew"],
		cwd: "",
		model: "",
		pid: 0,
		startedAt: 0,
		lastActivity: failure.from.lastActivity,
	});
	await new Promise((resolve) => setTimeout(resolve, 10 * BUS_POLL_INTERVAL_MS));
	assert.equal(failuresOf(scene.asker, scene.ask.id).length, 1, "told once");
	await vi.waitFor(
		async () =>
			assert.deepEqual(await scene.a.opened.state.pendingAsks.listParked(scene.owner.info.id), {
				status: "listed",
				asks: [],
			}),
		{ timeout: CROSS_NODE_WAIT_MS },
	);
}

test("an ask parked for a released subagent fails once for its asker on another node when the owner ends (#4992)", async () => {
	const scene = await parkedAskScene();
	scene.b.leave(scene.owner);
	await toldOnce(scene);
});

test("an ask parked for a released subagent fails once for its asker on another node when the owner goes away (#4992)", async () => {
	const scene = await parkedAskScene();
	scene.b.sessions.delete(scene.owner.info.id);
	scene.b.router.sessionLeft(scene.owner, undefined, false);
	await toldOnce(scene);
});

test("an ask parked for a released subagent fails once for its asker on another node when the owner drops the subagent (#4992)", async () => {
	const scene = await parkedAskScene();
	scene.b.router.restoringReleased(releasedReservationKey("child"), scene.owner.info.id);
	await toldOnce(scene);
});

test(
	"a recipient that ends fails an away asker's ask even when the asker's queue is full (#4992)",
	async () => {
		const [a, b] = await cluster();
		const returnAddress = randomUUID();
		const asker = await a!.connect("asker", { returnAddress });
		const recipient = await b!.connect("recipient");
		const ask = await savedAsk(a!, asker, b!, recipient);
		a!.sessions.delete(asker.info.id);
		a!.router.sessionLeft(asker, undefined, false);
		await waitOffline(b!, asker);
		// The away asker's queue reaches its cap.
		const filler = (id: string) =>
			b!.opened.state.outbox.enqueue({
				targetIdentity: deliveryTargetIdentity(asker),
				originBrokerId: b!.name,
				digest: id,
				frame: { type: "message", from: recipient.info, message: { id, timestamp: 1, content: { text: id } } },
			});
		const queued: string[] = [];
		for (let index = 0; index < OUTBOX_TARGET_MAX_ROWS; index++) {
			const id = `filler-${index}`;
			assert.equal((await filler(id)).status, "inserted");
			queued.push(id);
		}
		assert.equal((await filler("one-too-many")).status, "full");

		b!.leave(recipient);
		// The ask's route ends only once its failure is queued.
		await vi.waitFor(
			async () =>
				assert.deepEqual(
					await a!.opened.state.pendingAsks.matchesReply({
						replySenderSessionId: recipient.info.id,
						replyTargetSessionId: asker.info.id,
						replyTo: ask.id,
					}),
					{ status: "no-match" },
				),
			{ timeout: CROSS_NODE_WAIT_MS },
		);
		const back = await a!.connect("asker", { returnAddress, id: asker.info.id });
		await waitFor(() => (failuresOf(back, ask.id).length > 0 ? true : undefined), 3 * CROSS_NODE_WAIT_MS);
		const delivered = framesOf(back).flatMap((frame) => (frame.type === "message" ? [frame.message.id] : []));
		assert.deepEqual(
			delivered.filter((id) => id.startsWith("filler-")),
			queued,
			"every queued message is still delivered",
		);
		assert.equal(failuresOf(back, ask.id).length, 1);
	},
	FULL_QUEUE_BUDGET_MS,
);

test(
	"a recipient that turns terminal fails an away asker's ask even when the asker's queue is full (#4992)",
	async () => {
		const [a, b] = await cluster();
		const returnAddress = randomUUID();
		const asker = await a!.connect("asker", { returnAddress });
		const child = await b!.connect("child");
		const ask = await savedAsk(a!, asker, b!, child);
		a!.sessions.delete(asker.info.id);
		a!.router.sessionLeft(asker, undefined, false);
		await waitOffline(b!, asker);
		for (let index = 0; index < OUTBOX_TARGET_MAX_ROWS; index++) {
			const id = `filler-${index}`;
			const queued = await b!.opened.state.outbox.enqueue({
				targetIdentity: deliveryTargetIdentity(asker),
				originBrokerId: b!.name,
				digest: id,
				frame: { type: "message", from: child.info, message: { id, timestamp: 1, content: { text: id } } },
			});
			assert.equal(queued.status, "inserted");
		}

		child.info.replyCapability = "terminal";
		b!.router.sessionUpdated(child);
		await vi.waitFor(
			async () => {
				const row = await b!.opened.state.outbox.read(`terminal:${ask.id}`);
				assert.equal(row.status === "found" && row.row.targetIdentity, deliveryTargetIdentity(asker));
			},
			{ timeout: CROSS_NODE_WAIT_MS },
		);
		const back = await a!.connect("asker", { returnAddress, id: asker.info.id });
		await waitFor(() => (failuresOf(back, ask.id).length > 0 ? true : undefined), 3 * CROSS_NODE_WAIT_MS);
		const failures = failuresOf(back, ask.id);
		assert.equal(failures.length, 1);
		const failure = failures[0]!;
		assert.ok(failure.type === "message");
		assert.equal(failure.message.replyError, TERMINAL_CHILD_ASK_REFUSAL);
	},
	FULL_QUEUE_BUDGET_MS,
);

test("an ask whose replier ends right after replying gets only the reply on another node (#4992)", async () => {
	const [a, b] = await cluster();
	const asker = await a!.connect("asker");
	const replier = await b!.connect("replier");
	const ask = await savedAsk(a!, asker, b!, replier);
	const answer = message({ replyTo: ask.id, content: { text: "port 8080" } });
	b!.send(replier, asker.info.id, answer, { requirePendingReply: true });
	b!.leave(replier);
	const replied = await waitFor(() => messageFrames(asker, answer.id)[0]);
	assert.equal(replied.type, "message");
	await new Promise((resolve) => setTimeout(resolve, 20 * BUS_POLL_INTERVAL_MS));
	assert.deepEqual(failuresOf(asker, ask.id), [], "the reply is the ask's only outcome");
});

test("an away asker of a child that turned terminal and then ended gets only the terminal failure (#4992)", async () => {
	const [a, b] = await cluster();
	const returnAddress = randomUUID();
	const asker = await a!.connect("asker", { returnAddress });
	const child = await b!.connect("child");
	const ask = await savedAsk(a!, asker, b!, child);
	a!.sessions.delete(asker.info.id);
	a!.router.sessionLeft(asker, undefined, false);
	await waitOffline(b!, asker);
	child.info.replyCapability = "terminal";
	b!.router.sessionUpdated(child);
	await vi.waitFor(
		async () => {
			const row = await b!.opened.state.outbox.read(`terminal:${ask.id}`);
			assert.equal(row.status, "found");
		},
		{ timeout: CROSS_NODE_WAIT_MS },
	);
	b!.leave(child);
	await vi.waitFor(
		async () =>
			assert.deepEqual(await a!.opened.state.pendingAsks.listForTarget(child.info.id), {
				status: "listed",
				asks: [],
			}),
		{ timeout: CROSS_NODE_WAIT_MS },
	);
	assert.deepEqual(await b!.opened.state.outbox.read(`ended:${ask.id}`), { status: "missing" }, "not failed again");
	const back = await a!.connect("asker", { returnAddress, id: asker.info.id });
	await waitFor(() => (failuresOf(back, ask.id).length > 0 ? true : undefined));
	await new Promise((resolve) => setTimeout(resolve, 10 * BUS_POLL_INTERVAL_MS));
	assert.deepEqual(
		failuresOf(back, ask.id).map((frame) => (frame.type === "message" ? frame.message.replyError : undefined)),
		[TERMINAL_CHILD_ASK_REFUSAL],
	);
});

test("a recipient that is only away keeps the asks from another node open (#4992)", async () => {
	const [a, b] = await cluster();
	const asker = await a!.connect("asker");
	const recipient = await b!.connect("recipient");
	const ask = await savedAsk(a!, asker, b!, recipient);
	b!.sessions.delete(recipient.info.id);
	b!.router.sessionLeft(recipient, undefined, false);
	await waitOffline(a!, recipient);
	await new Promise((resolve) => setTimeout(resolve, 10 * BUS_POLL_INTERVAL_MS));
	assert.deepEqual(failuresOf(asker, ask.id), []);
	assert.deepEqual(
		await a!.opened.state.pendingAsks.matchesReply({
			replySenderSessionId: recipient.info.id,
			replyTargetSessionId: asker.info.id,
			replyTo: ask.id,
		}),
		{ status: "match" },
	);
	assert.deepEqual(await a!.opened.state.pendingAsks.listEnded(0), { status: "listed", asks: [] });
});

test("an ask parked for a subagent Intercom no longer knows fails as sent by its session id when the owner ends (#4992)", async () => {
	const [a, b] = await cluster();
	const asker = await a!.connect("asker");
	const owner = await b!.connect("owner");
	const forgotten = randomUUID();
	const ask = { senderSessionId: asker.info.id, targetSessionId: forgotten, messageId: randomUUID() };
	await b!.opened.state.pendingAsks.record(ask);
	await b!.opened.state.pendingAsks.parkForTarget(forgotten, {
		ownerSessionId: owner.info.id,
		reservationKey: releasedReservationKey("forgotten"),
	});
	b!.leave(owner);
	const failure = await waitFor(() => failuresOf(asker, ask.messageId)[0]);
	assert.ok(failure.type === "message");
	assert.equal(failure.message.replyError, `Session "${forgotten}" ended before replying`);
	assert.deepEqual(failure.from, {
		id: forgotten,
		cwd: "",
		model: "",
		pid: 0,
		startedAt: 0,
		lastActivity: failure.from.lastActivity,
	});
});

test("a cross-node send whose routing queries consume part of the client response wait extends the sender before its deadline instead of timing out", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	const leases = a!.opened.state.leases;
	const listLive = leases.listLive.bind(leases);
	let delayRouting = true;
	const spy = vi.spyOn(leases, "listLive").mockImplementation(async (kind, staleAfterMs) => {
		if (delayRouting && kind === "presence") {
			delayRouting = false;
			await new Promise((resolve) => setTimeout(resolve, 3_000));
		}
		return listLive(kind, staleAfterMs);
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	const now = performance.now.bind(performance);
	const basePerf = now();
	const baseDate = Date.now();
	const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => basePerf + (Date.now() - baseDate));
	try {
		const sent = message();
		const sentAt = Date.now();
		a!.send(sender, "recipient", sent);
		// Routing consumes 3 s; advance past enqueue and wait for b's wake-up poll to deliver before 10 s.
		await advance(4_000);
		await waitFor(() => (messageFrames(recipient, sent.id).length === 1 ? true : undefined));
		await advance(SEND_RESPONSE_TIMEOUT_MS - 500 - (Date.now() - sentAt));
		assert.ok(
			holdsOf(sender, sent.id).length >= 1,
			`expected send_held before client deadline (${Date.now() - sentAt} ms elapsed)`,
		);
		// Recipient confirms at 10.5 s (> SEND_RESPONSE_TIMEOUT_MS, < T_enqueue + RECIPIENT_RECEIPT_TIMEOUT_MS).
		await advance(1_000);
		assert.equal(b!.router.received(recipient, sent.id), true);
		const delivered = await advanceUntil(() => outcomeOf(sender, sent.id), CROSS_NODE_WAIT_MS, DECISION_STEP_MS);
		assert.equal(delivered?.value.type, "delivered", JSON.stringify(delivered));
		assert.equal(
			framesOf(sender).filter((frame) => frame.type === "delivery_failed" && frame.messageId === sent.id).length,
			0,
		);
	} finally {
		perfSpy.mockRestore();
		spy.mockRestore();
		vi.useRealTimers();
	}
});

test("a cross-node send whose routing queries make slow progress past the receipt wait extends the sender, while a hung database does not", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	const leases = a!.opened.state.leases;
	const listLive = leases.listLive.bind(leases);
	const outbox = a!.opened.state.outbox;
	const readOutbox = outbox.read.bind(outbox);
	let mode: "slow-progress" | "hung" | "off" = "slow-progress";
	const leaseSpy = vi.spyOn(leases, "listLive").mockImplementation(async (kind, staleAfterMs) => {
		if (mode === "hung" && kind === "presence") return new Promise<never>(() => {});
		if (mode === "slow-progress" && kind === "presence") {
			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
		return listLive(kind, staleAfterMs);
	});
	const outboxSpy = vi.spyOn(outbox, "read").mockImplementation(async (messageId) => {
		if (mode === "slow-progress") {
			mode = "off";
			await new Promise((resolve) => setTimeout(resolve, RECIPIENT_RECEIPT_TIMEOUT_MS));
		}
		return readOutbox(messageId);
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	const now = performance.now.bind(performance);
	const basePerf = now();
	const baseDate = Date.now();
	const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => basePerf + (Date.now() - baseDate));
	try {
		// Part 1: leases.listLive answers after 1 s, then outbox.read takes 8 s -> total routing = 9 s > 8 s.
		const slow = message();
		a!.send(sender, "recipient", slow);
		await advance(RECIPIENT_RECEIPT_TIMEOUT_MS + 500);
		assert.ok(holdsOf(sender, slow.id).length >= 1, "slow-but-progressing routing sent send_held before 10 s");
		await advance(2_000);
		await waitFor(() => (messageFrames(recipient, slow.id).length === 1 ? true : undefined));
		assert.equal(b!.router.received(recipient, slow.id), true);
		const delivered = await advanceUntil(() => outcomeOf(sender, slow.id), CROSS_NODE_WAIT_MS, DECISION_STEP_MS);
		assert.equal(delivered?.value.type, "delivered", JSON.stringify(delivered));

		// Part 2: permanently hung database (0 store answers) sends no send_held.
		mode = "hung";
		const hung = message();
		a!.send(sender, "recipient", hung);
		await advance(SEND_RESPONSE_TIMEOUT_MS + 1_000);
		assert.deepEqual(holdsOf(sender, hung.id), [], "a hung database must not extend the sender");
	} finally {
		perfSpy.mockRestore();
		outboxSpy.mockRestore();
		leaseSpy.mockRestore();
		vi.useRealTimers();
	}
});

test("a slow sent-message acceptance near the client deadline extends the sender before finishing delivery", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	const sentMessages = a!.opened.state.sentMessages;
	const accept = sentMessages.accept.bind(sentMessages);
	let stallAccept = false;
	const acceptSpy = vi.spyOn(sentMessages, "accept").mockImplementation(async (args) => {
		if (stallAccept) {
			stallAccept = false;
			await new Promise((resolve) => setTimeout(resolve, 1_500));
		}
		return accept(args);
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	const now = performance.now.bind(performance);
	const basePerf = now();
	const baseDate = Date.now();
	const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => basePerf + (Date.now() - baseDate));
	try {
		const sent = message();
		a!.send(sender, "recipient", sent);
		await waitFor(() => (messageFrames(recipient, sent.id).length > 0 ? true : undefined));
		// Advance to 7.5 s (within 2.5 s of 10 s deadline; waiter expires at 8 s).
		await advance(RECIPIENT_RECEIPT_TIMEOUT_MS - 500);
		stallAccept = true;
		assert.equal(b!.router.received(recipient, sent.id), true);
		// Wait past HOLD_CHECK_GRACE_MS while sentMessages.accept is stalled (1.5 s).
		await advance(1_000);
		assert.ok(holdsOf(sender, sent.id).length >= 1, "slow sentMessages.accept emitted send_held");
		const delivered = await advanceUntil(() => outcomeOf(sender, sent.id), CROSS_NODE_WAIT_MS, DECISION_STEP_MS);
		assert.equal(delivered?.value.type, "delivered", JSON.stringify(delivered));
	} finally {
		perfSpy.mockRestore();
		acceptSpy.mockRestore();
		vi.useRealTimers();
	}
});
