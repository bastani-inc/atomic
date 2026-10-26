import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type net from "node:net";
import { join } from "node:path";
import { openNodeSqliteDatabase, type SqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
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
} from "../../packages/intercom/broker/multinode-state-store.js";
import {
	borrowedDatabase,
	type OpenedBrokerState,
	openIntercomBrokerState,
	resolveBrokerStateSource,
	type SharedDatabaseSource,
} from "../../packages/intercom/broker/open-broker-state.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import { RESTORING_RECIPIENT_HOLD_MS } from "../../packages/intercom/broker/restoring-recipients.js";
import {
	type BrokerConnectedSession,
	handleBrokerSend,
	type SendClientMessage,
} from "../../packages/intercom/broker/send-handler.js";
import { buildMessageSendSignature } from "../../packages/intercom/broker/send-signature.js";
import type { BrokerOutboundFrame } from "../../packages/intercom/broker/socket-writes.js";
import { openSqlKnownSessionStore } from "../../packages/intercom/broker/sql-known-session-store.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import type { WakeUpBus } from "../../packages/intercom/broker/wake-up-bus.js";
import { normalizeGroup } from "../../packages/intercom/group.js";
import { NON_AGENT_RECIPIENT_REFUSAL, TERMINAL_CHILD_ASK_REFUSAL } from "../../packages/intercom/recipient-purpose.js";
import {
	RECIPIENT_RECEIPT_TIMEOUT_MS,
	RECIPIENT_SAVING_REPORT_INTERVAL_MS,
	SEND_RESPONSE_TIMEOUT_MS,
} from "../../packages/intercom/retry-policy.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import {
	type OpenSharedStoreFixture,
	registerKnownSessionStoreConformance,
	type SharedStoreFixture,
} from "../helpers/intercom-multinode-contract.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";

/**
 * S5 (specs/2026-10-19-intercom-multi-node.md §12, §14): in-process brokers that share one SQLite file route sends
 * through the real send handler, the real router and the real S1–S4 stores and database wake-up bus.
 */

/** Cross-node hops ride the database-polled bus; this bounds a healthy delivery, far above the poll interval. */
const CROSS_NODE_WAIT_MS = 10_000;
const BUS_POLL_INTERVAL_MS = 20;
const ATTACHMENTS = [{ type: "snippet" as const, name: " a.ts ", content: "const x = 1;\r\n", language: "ts" }];
const VERBATIM = "  cross-node\tparity\u0000 ünïcödé ✓  \n";

type FakeSocket = net.Socket & { frames: BrokerOutboundFrame[] };

function fakeSocket(): FakeSocket {
	return { destroyed: false, writableEnded: false, frames: [] } as unknown as FakeSocket;
}

class Node {
	readonly sessions = new Map<string, BrokerConnectedSession>();
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
			socket: fakeSocket(),
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
			undefined,
			undefined,
			undefined,
			undefined,
			(target, frame, onSettled) => onSettled(this.write(target, frame)),
			undefined,
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

async function heldSendRoundTrip(wrapBus?: (node: number, bus: WakeUpBus) => WakeUpBus) {
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
	const heldAt = Date.now();
	const child = await b!.connect("restored-child", {
		group: "crew",
		supervisorId: supervisor.info.id,
		consumed: { capability },
	});
	const frame = await waitFor(() => messageFrames(child, sent.id)[0], RESTORING_RECIPIENT_HOLD_MS);
	assert.deepEqual(frame, { type: "message", from: sender.info, message: sent });
	b!.router.received(child, sent.id);
	const outcome = await waitFor(() => outcomeOf(sender, sent.id));
	return { outcome, elapsedMs: Date.now() - heldAt };
}

test("a send held through one broker for a child restored on another gets send_held and is delivered after it registers", async () => {
	const { outcome } = await heldSendRoundTrip();
	assert.equal(outcome.type, "delivered");
});

test(
	"a lost outcome hint for a held send is noticed by the outcome poll before the hold times out",
	async () => {
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
		const { outcome, elapsedMs } = await heldSendRoundTrip(dropOutcomes);
		assert.equal(outcome.type, "delivered", JSON.stringify(outcome));
		assert.ok(elapsedMs < RESTORING_RECIPIENT_HOLD_MS, `noticed after ${elapsedMs} ms`);
	},
	RESTORING_RECIPIENT_HOLD_MS + CROSS_NODE_WAIT_MS,
);

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
