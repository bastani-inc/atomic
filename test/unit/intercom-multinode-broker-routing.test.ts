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
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import {
	KNOWN_SESSION_REFRESH_INTERVAL_MS,
	LOCAL_RETRY_LOOKUP_BOUND_MS,
	MULTI_NODE_OUTCOME_POLL_INTERVAL_MS,
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
	resolveBrokerStateSource,
	type SharedDatabaseSource,
} from "../../packages/intercom/broker/open-broker-state.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { releasedReservationKey } from "../../packages/intercom/broker/released-children.js";
import { RESTORING_RECIPIENT_HOLD_MS } from "../../packages/intercom/broker/restoring-recipients.js";
import type { BrokerConnectedSession, SendClientMessage } from "../../packages/intercom/broker/send-handler.js";
import { buildMessageSendSignature } from "../../packages/intercom/broker/send-signature.js";
import { openSqlKnownSessionStore } from "../../packages/intercom/broker/sql-known-session-store.js";
import { openSqlBrokerLeaseStore } from "../../packages/intercom/broker/sql-lease-store.js";
import type { WakeUpBus } from "../../packages/intercom/broker/wake-up-bus.js";
import { normalizeGroup } from "../../packages/intercom/group.js";
import { NON_AGENT_RECIPIENT_REFUSAL, TERMINAL_CHILD_ASK_REFUSAL } from "../../packages/intercom/recipient-purpose.js";
import { RECIPIENT_RECEIPT_TIMEOUT_MS, SEND_RESPONSE_TIMEOUT_MS } from "../../packages/intercom/retry-policy.js";
import type { Message } from "../../packages/intercom/types.js";
import {
	type OpenSharedStoreFixture,
	registerIdOwnerConformance,
	registerKnownSessionStoreConformance,
	type SharedStoreFixture,
} from "../helpers/intercom-multinode-contract.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";
import {
	advance,
	advanceUntil,
	BUS_POLL_INTERVAL_MS,
	CROSS_NODE_WAIT_MS,
	cleanups,
	cluster,
	framesOf,
	message,
	messageFrames,
	type Node,
	outcomeOf,
	reasonOf,
	runCleanups,
	sendAndSettle,
	settleFileIo,
	startConnectionTracking,
	stopConnectionTracking,
	waitFor,
	waitOffline,
} from "./intercom-multinode-broker-routing-helpers.js";

/**
 * S5 (specs/2026-10-19-intercom-multi-node.md §12, §14): in-process brokers that share one SQLite file route sends
 * through the real send handler, the real router and the real S1–S4 stores and database wake-up bus.
 */

afterEach(runCleanups);
beforeEach(startConnectionTracking);
afterEach(stopConnectionTracking);

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
 * Counts the statements `databases` run for calls made inside `within`, those of their transactions included, and the
 * rows their reads return: a broker's polls and renewals run outside any send, so what runs inside a send's context is
 * what that send costs. The broker's reader handles are connections to the same database, so their reads count as the
 * writer's do (#6560).
 */
function countStatements(databases: readonly SqliteDatabase[], within: AsyncLocalStorage<true>) {
	let count = 0;
	let rows = 0;
	const tally = () => {
		const inside = within.getStore() === true;
		if (inside) count++;
		return inside;
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
		get: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
			const inside = tally();
			const row = await executor.get<T>(sql, ...params);
			if (inside && row !== undefined) rows++;
			return row;
		},
		all: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
			const inside = tally();
			const read = await executor.all<T>(sql, ...params);
			if (inside) rows += read.length;
			return read;
		},
	});
	const restores = databases.map((database) => {
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
		return () => Object.assign(database, original);
	});
	return {
		count: () => count,
		rows: () => rows,
		restore: () => {
			for (const restore of restores) restore();
		},
	};
}

/**
 * What queuing one send for an offline session costs the shared database, through the broker's write handle and its
 * reader handle together, as before either existed: on the reader (#6560), the presences its target may name (by
 * index, #6560), its known session and its id's binding; on the writer, its target's reservation read, its row looked
 * up, then one transaction that reads its reservation, its row and its recipient's queue, writes the row (which comes
 * back from its insert, with the broker its recipient's presence names, #5607) and its reservation, and one read of its
 * position once it is written.
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
	const statements = countStatements([a!.database, ...a!.readers], within);
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

test("a send to a session on another broker reads as many rows of the shared database however many other sessions are present (#6560)", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	const within = new AsyncLocalStorage<true>();
	const rowsPerSend = async () => {
		const sends = 4;
		const statements = countStatements([a!.database, ...a!.readers], within);
		try {
			for (let index = 0; index < sends; index++) {
				const sent = message({ content: { text: `reads ${index}` } });
				within.run(true, () => a!.send(sender, "recipient", sent));
				await waitFor(() => messageFrames(recipient, sent.id)[0]);
				b!.router.received(recipient, sent.id);
				assert.equal((await waitFor(() => outcomeOf(sender, sent.id))).type, "delivered");
			}
		} finally {
			statements.restore();
		}
		return statements.rows() / sends;
	};
	const alone = await rowsPerSend();
	for (let index = 0; index < 32; index++) await b!.connect(`bystander-${index}`);
	for (let index = 0; index < 32; index++) await a!.connect(`neighbour-${index}`);
	assert.equal(await rowsPerSend(), alone);
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
