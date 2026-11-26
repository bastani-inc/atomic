import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type net from "node:net";
import { join } from "node:path";
import { openNodeSqliteDatabase, type SqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { MultiNodeRouter } from "../../packages/intercom/broker/multinode-router.js";
import {
	borrowedDatabase,
	type OpenedBrokerState,
	openIntercomBrokerState,
} from "../../packages/intercom/broker/open-broker-state.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import {
	RETURN_PATH_MESSAGE_LIMIT,
	ReturnPaths,
	returnPathClosedReason,
} from "../../packages/intercom/broker/return-paths.js";
import {
	type BrokerConnectedSession,
	createReturnPathAuthority,
	handleBrokerSend,
	type ReturnPathAuthority,
} from "../../packages/intercom/broker/send-handler.js";
import type { BrokerOutboundFrame } from "../../packages/intercom/broker/socket-writes.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import { normalizeGroup } from "../../packages/intercom/group.js";
import { createReachPolicy, type IntercomReachPolicy } from "../../packages/intercom/reach-policy.js";
import type { SessionInfo } from "../../packages/intercom/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** Cross-node hops ride the database-polled bus; this bounds a healthy delivery, far above the poll interval. */
const CROSS_NODE_WAIT_MS = 10_000;
const BUS_POLL_INTERVAL_MS = 20;

type FakeSocket = net.Socket & { frames: BrokerOutboundFrame[] };

/** One broker of a cluster sharing a SQLite file, with its return paths. */
class Node {
	readonly sessions = new Map<string, BrokerConnectedSession>();
	readonly supervisorCache = new SupervisorChannelCache();
	readonly pendingQuestions = new PendingQuestionIndex();
	readonly deliveredMessages = new DeliveredMessageCache();
	readonly rawReturnPaths: ReturnPaths;
	readonly returnPaths: ReturnPathAuthority;
	writeConfirmedHook:
		| ((socket: net.Socket, frame: BrokerOutboundFrame, onSettled: (written: boolean) => void) => void)
		| undefined;
	localWriteConfirmedHook:
		| ((socket: net.Socket, frame: BrokerOutboundFrame, onSettled: (written: boolean) => void) => void)
		| undefined;
	router!: MultiNodeRouter;
	opened!: OpenedBrokerState;

	constructor(openingWaitMs?: number) {
		this.rawReturnPaths = new ReturnPaths(undefined, undefined, undefined, undefined, openingWaitMs);
		this.returnPaths = createReturnPathAuthority(this.rawReturnPaths, this.sessions);
	}

	static async start(shared: SqliteDatabase, openingWaitMs?: number): Promise<Node> {
		const node = new Node(openingWaitMs);
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
				writeConfirmed: (socket, frame, onSettled) =>
					node.writeConfirmedHook !== undefined
						? node.writeConfirmedHook(socket, frame, onSettled)
						: onSettled(node.write(socket, frame)),
				supervisorCache: node.supervisorCache,
				returnPaths: node.returnPaths,
				pendingQuestions: node.pendingQuestions,
				deliveredMessages: node.deliveredMessages,
				dispatch: () => {},
				revokeReleasedReservation: () => {},
				holdsReservation: () => true,
				fence: () => {},
			},
		});
		return node;
	}

	write(socket: net.Socket, frame: BrokerOutboundFrame): boolean {
		(socket as FakeSocket).frames.push(frame);
		return true;
	}

	/** Registers a session here; `confirmsSaves`: its deliveries complete only on its `received`. */
	async connect(
		name: string,
		group: string,
		confirmsSaves: boolean,
		reach?: IntercomReachPolicy,
		returnAddress = randomUUID(),
	) {
		const info: SessionInfo = {
			id: randomUUID(),
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
			socket: { destroyed: false, writableEnded: false, frames: [] } as unknown as FakeSocket,
			info,
			registrationGroup: normalizeGroup(group),
			registrationName: name,
			registrationReturnAddress: returnAddress,
			...(confirmsSaves ? { acknowledgesReceipt: true as const } : {}),
			...(reach === undefined ? {} : { reach }),
		};
		this.sessions.set(info.id, session);
		await this.router.sessionRegistered(session);
		return session;
	}

	send(
		from: BrokerConnectedSession,
		to: string,
		id: string,
		extraMsg: Record<string, unknown> = {},
		extraClient: Record<string, unknown> = {},
	): void {
		handleBrokerSend(
			from.socket,
			{
				type: "send",
				to,
				message: { id, timestamp: 1, content: { text: id }, ...extraMsg },
				attemptId: randomUUID(),
				...extraClient,
			},
			from.info.id,
			this.sessions,
			this.deliveredMessages,
			(target, frame) => this.write(target, frame),
			this.supervisorCache,
			this.pendingQuestions,
			(target, frame, onSettled) =>
				this.localWriteConfirmedHook !== undefined
					? this.localWriteConfirmedHook(target, frame, onSettled)
					: onSettled(this.write(target, frame)),
			undefined,
			undefined,
			(request) => this.router.routeSend(request),
			undefined,
			undefined,
			this.returnPaths,
		);
	}

	async close(): Promise<void> {
		await this.router.close();
		this.deliveredMessages.close();
	}
}

const framesOf = (session: BrokerConnectedSession): BrokerOutboundFrame[] => (session.socket as FakeSocket).frames;

function outcomeOf(session: BrokerConnectedSession, id: string) {
	return framesOf(session).find(
		(frame) => (frame.type === "delivered" || frame.type === "delivery_failed") && frame.messageId === id,
	);
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
	return vi.waitFor(
		() => {
			const value = read();
			if (value === undefined) throw new Error("not yet");
			return value;
		},
		{ timeout: CROSS_NODE_WAIT_MS, interval: 10 },
	);
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function cluster(openingWaitMs?: number): Promise<[Node, Node]> {
	const directory = makeTempDirectory("intercom-multinode-return-path-");
	const shared = await openNodeSqliteDatabase(join(directory, "shared.sqlite"));
	const nodes: Node[] = [];
	cleanups.push(async () => {
		for (const node of nodes) await node.close();
		await shared.close();
		removeTempDirectory(directory);
	});
	for (let index = 0; index < 2; index++) nodes.push(await Node.start(shared, openingWaitMs));
	return [nodes[0]!, nodes[1]!];
}

test("an answer read on another node before a newer message's delivery completes counts toward that message's budget", async () => {
	const [a, b] = await cluster();
	const launcher = await a.connect("launcher", "launch", false, createReachPolicy("launch", ["stages"]));
	const stage = await b.connect("stage", "stages", true);
	const note = async (id: string): Promise<void> => {
		a.send(launcher, "stage", id);
		await waitFor(() => framesOf(stage).find((frame) => frame.type === "message" && frame.message.id === id));
	};
	const confirm = async (id: string): Promise<void> => {
		assert.equal(b.router.received(stage, id), true);
		assert.equal((await waitFor(() => outcomeOf(launcher, id))).type, "delivered");
	};
	const answer = async (id: string) => {
		b.send(stage, "launcher", id);
		return waitFor(() => outcomeOf(stage, id));
	};

	await note("first-note");
	await confirm("first-note");
	// The second note reaches the stage, which answers before its delivery completes.
	await note("second-note");
	assert.equal((await answer("answer-1")).type, "delivered");
	await confirm("second-note");

	for (let index = 2; index <= RETURN_PATH_MESSAGE_LIMIT; index++)
		assert.equal((await answer(`answer-${index}`)).type, "delivered");
	const over = await answer("answer-over");
	assert.deepEqual(over.type === "delivery_failed" ? [over.type, over.reason] : [over.type], [
		"delivery_failed",
		returnPathClosedReason("launcher"),
	]);
});

test("an answer read before a newer message's failed settle counts toward that message once it is handed over again", async () => {
	const [a, b] = await cluster();
	const launcher = await a.connect("launcher", "launch", false, createReachPolicy("launch", ["stages"]));
	const stage = await b.connect("stage", "stages", true);
	const handedOver = (id: string) =>
		framesOf(stage).filter((frame) => frame.type === "message" && frame.message.id === id).length;
	const note = async (id: string): Promise<void> => {
		a.send(launcher, "stage", id);
		await waitFor(() => (handedOver(id) > 0 ? true : undefined));
	};
	const answer = async (id: string) => {
		b.send(stage, "launcher", id);
		return waitFor(() => outcomeOf(stage, id));
	};

	await note("first-note");
	assert.equal(b.router.received(stage, "first-note"), true);
	await waitFor(() => outcomeOf(launcher, "first-note"));
	// The second note reaches the stage, which answers it at once.
	await note("second-note");
	assert.equal((await answer("answer-1")).type, "delivered");
	// Its receipt reaches the stage's broker while the shared storage fails the settle once: the row is claimed and
	// handed over again, later than the answer, and only that second hand-over's receipt settles it.
	const outbox = b.opened.state.outbox;
	const markDelivered = outbox.markDelivered.bind(outbox);
	let failures = 1;
	outbox.markDelivered = async (claim) => {
		if (failures-- > 0) throw new Error("database is locked");
		return markDelivered(claim);
	};
	assert.equal(b.router.received(stage, "second-note"), true);
	await waitFor(() => (handedOver("second-note") === 2 ? true : undefined));
	assert.equal(b.router.received(stage, "second-note"), true);
	assert.equal((await waitFor(() => outcomeOf(launcher, "second-note"))).type, "delivered");

	for (let index = 2; index <= RETURN_PATH_MESSAGE_LIMIT; index++)
		assert.equal((await answer(`answer-${index}`)).type, "delivered");
	const over = await answer("answer-over");
	assert.deepEqual(over.type === "delivery_failed" ? [over.type, over.reason] : [over.type], [
		"delivery_failed",
		returnPathClosedReason("launcher"),
	]);
});

test("answers sent on another node while a confirmed message's settle is in flight wait for it without blocking same-group sends", async () => {
	const [a, b] = await cluster();
	const launcher = await a.connect("launcher", "launch", false, createReachPolicy("launch", ["stages"]));
	const remotePeer = await a.connect("remote-peer", "stages", false);
	const stage = await b.connect("stage", "stages", true);

	a.send(launcher, "stage", "first-note");
	await waitFor(() => framesOf(stage).find((frame) => frame.type === "message" && frame.message.id === "first-note"));

	// Hold Node B's outbox.markDelivered while stage confirms receipt and immediately answers launcher.
	const outbox = b.opened.state.outbox;
	const realMarkDelivered = outbox.markDelivered.bind(outbox);
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	outbox.markDelivered = async (claim) => {
		entered.resolve();
		await gate.promise;
		return realMarkDelivered(claim);
	};

	assert.equal(b.router.received(stage, "first-note"), true);
	await entered.promise;

	// Stage immediately answers launcher by name AND by id while markDelivered is still in flight.
	b.send(stage, "launcher", "ans-by-name");
	b.send(stage, launcher.info.id, "ans-by-id");

	// A same-group remote peer send MUST NOT wait on the pending return-path settle.
	b.send(stage, "remote-peer", "same-group-note");
	assert.equal((await waitFor(() => outcomeOf(stage, "same-group-note"))).type, "delivered");
	assert.equal(
		(
			await waitFor(() =>
				framesOf(remotePeer).find((frame) => frame.type === "message" && frame.message.id === "same-group-note"),
			)
		).type,
		"message",
	);

	// Unrelated unknown target also fails without waiting on the held settle.
	b.send(stage, "nonexistent-peer", "unrelated-note");
	assert.equal((await waitFor(() => outcomeOf(stage, "unrelated-note"))).type, "delivery_failed");

	// Neither answer to launcher failed while markDelivered was still running.
	assert.equal(outcomeOf(stage, "ans-by-name"), undefined);
	assert.equal(outcomeOf(stage, "ans-by-id"), undefined);

	// Once markDelivered completes, both answers succeed.
	outbox.markDelivered = realMarkDelivered;
	gate.resolve();
	assert.equal((await waitFor(() => outcomeOf(stage, "ans-by-name"))).type, "delivered");
	assert.equal((await waitFor(() => outcomeOf(stage, "ans-by-id"))).type, "delivered");
	assert.equal((await waitFor(() => outcomeOf(launcher, "first-note"))).type, "delivered");

	// Exhausting the remaining slot closes the path; a follow-up whose settle is held reopens it for immediate answers.
	b.send(stage, "launcher", "ans-3");
	assert.equal((await waitFor(() => outcomeOf(stage, "ans-3"))).type, "delivered");
	b.send(stage, "launcher", "ans-over");
	const closed = await waitFor(() => outcomeOf(stage, "ans-over"));
	assert.deepEqual(closed.type === "delivery_failed" ? [closed.type, closed.reason] : [closed.type], [
		"delivery_failed",
		returnPathClosedReason("launcher"),
	]);

	a.send(launcher, "stage", "second-note");
	await waitFor(() => framesOf(stage).find((frame) => frame.type === "message" && frame.message.id === "second-note"));
	const gate2 = Promise.withResolvers<void>();
	const entered2 = Promise.withResolvers<void>();
	outbox.markDelivered = async (claim) => {
		entered2.resolve();
		await gate2.promise;
		return realMarkDelivered(claim);
	};
	assert.equal(b.router.received(stage, "second-note"), true);
	await entered2.promise;
	b.send(stage, "launcher", "reopened-answer");
	// Still waiting, not refused with closed reason.
	b.send(stage, "remote-peer", "same-group-2");
	assert.equal((await waitFor(() => outcomeOf(stage, "same-group-2"))).type, "delivered");
	assert.equal(outcomeOf(stage, "reopened-answer"), undefined);

	outbox.markDelivered = realMarkDelivered;
	gate2.resolve();
	assert.equal((await waitFor(() => outcomeOf(stage, "reopened-answer"))).type, "delivered");
});

test("answers sent on another node before a non-receipt delivery write completes wait for it and succeed", async () => {
	const [a, b] = await cluster();
	const launcher = await a.connect("launcher", "launch", false, createReachPolicy("launch", ["stages"]));
	const remotePeer = await a.connect("remote-peer", "stages", false);
	const stage = await b.connect("stage", "stages", false);

	// Hold Node B's socket write callback to stage so stage can read the frame and answer before writeConfirmed settles.
	const heldWrites: Array<(written: boolean) => void> = [];
	b.writeConfirmedHook = (socket, frame, onSettled) => {
		if (socket === stage.socket) {
			b.write(socket, frame);
			heldWrites.push(onSettled);
			return;
		}
		onSettled(b.write(socket, frame));
	};

	a.send(launcher, "stage", "first-note");
	await waitFor(() => framesOf(stage).find((frame) => frame.type === "message" && frame.message.id === "first-note"));
	assert.equal(heldWrites.length, 1);

	b.send(stage, "launcher", "immediate-answer");
	// An unrelated same-group send settles immediately while immediate-answer waits on the held write.
	b.send(stage, "remote-peer", "same-group-probe");
	assert.equal((await waitFor(() => outcomeOf(stage, "same-group-probe"))).type, "delivered");
	assert.equal(
		(
			await waitFor(() =>
				framesOf(remotePeer).find((frame) => frame.type === "message" && frame.message.id === "same-group-probe"),
			)
		).type,
		"message",
	);
	assert.equal(outcomeOf(stage, "immediate-answer"), undefined);

	for (const settle of heldWrites.splice(0)) settle(true);
	assert.equal((await waitFor(() => outcomeOf(stage, "immediate-answer"))).type, "delivered");
	assert.equal((await waitFor(() => outcomeOf(launcher, "first-note"))).type, "delivered");
});

test("router close releases pending openings before awaiting serial reply lanes and makes no post-close DB calls", async () => {
	const [a, b] = await cluster();
	const launcher = await a.connect("launcher", "launch", false, createReachPolicy("launch", ["stages"]));
	const stage = await b.connect("stage", "stages", false);
	const heldWrites: Array<(written: boolean) => void> = [];
	b.writeConfirmedHook = (socket, frame, onSettled) => {
		if (socket === stage.socket) {
			b.write(socket, frame);
			heldWrites.push(onSettled);
			return;
		}
		onSettled(b.write(socket, frame));
	};

	a.send(launcher, "stage", "close-open");
	await waitFor(() => framesOf(stage).find((frame) => frame.type === "message" && frame.message.id === "close-open"));

	// Send both a reply-lane candidate (serialized on `reply:<id>`) and a plain send waiting on the pending opening.
	const realWhenForTarget = b.returnPaths.whenOpeningForTarget;
	let waitedCount = 0;
	const bothWaiting = Promise.withResolvers<void>();
	b.returnPaths.whenOpeningForTarget = (...args) => {
		const waited = realWhenForTarget(...args);
		if (waited) {
			waitedCount += 1;
			if (waitedCount >= 2) bothWaiting.resolve();
		}
		return waited;
	};
	b.send(stage, "launcher", "close-reply", { replyTo: "some-ask" });
	b.send(stage, "launcher", "close-plain");
	await bothWaiting.promise;
	b.returnPaths.whenOpeningForTarget = realWhenForTarget;

	let listLiveAfterClose = 0;
	const origListLive = b.opened.state.leases.listLive.bind(b.opened.state.leases);
	// A send reads its presences through `listLive`, which this test stubs, as on a store without `listLiveFor` (#6560).
	Object.assign(b.opened.state.leases, { listLiveFor: undefined });
	let closing = false;
	b.opened.state.leases.listLive = async (...args) => {
		if (closing) listLiveAfterClose += 1;
		return origListLive(...args);
	};

	closing = true;
	const closeDone = await Promise.race([
		b.router.close().then(() => "closed" as const),
		new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 1_500)),
	]);
	for (const settle of heldWrites.splice(0)) settle(false);

	assert.equal(closeDone, "closed", "close() must release pending openings before awaiting serial lanes");
	assert.equal(listLiveAfterClose, 0, "no shared-DB queries may run after close()");
	assert.equal(outcomeOf(stage, "close-plain"), undefined, "no spurious failure frame written after close()");
});

test("a same-group remote peer sharing a name with a pending cross-group sender is never blocked, and requirePendingReply never waits", async () => {
	const [a, b] = await cluster();
	const crossGroupAlice = await a.connect("alice", "launch", false, createReachPolicy("launch", ["stages"]));
	const sameGroupAlice = await a.connect("alice", "stages", false);
	const stage = await b.connect("stage", "stages", true);

	a.send(crossGroupAlice, "stage", "sg-open");
	await waitFor(() => framesOf(stage).find((frame) => frame.type === "message" && frame.message.id === "sg-open"));

	const outbox = b.opened.state.outbox;
	const realMarkDelivered = outbox.markDelivered.bind(outbox);
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	outbox.markDelivered = async (claim) => {
		entered.resolve();
		await gate.promise;
		return realMarkDelivered(claim);
	};
	assert.equal(b.router.received(stage, "sg-open"), true);
	await entered.promise;
	try {
		// Sending to same-group "alice" resolves normally without ever waiting on crossGroupAlice's pending opening.
		b.send(stage, "alice", "sg-msg");
		assert.equal((await waitFor(() => outcomeOf(stage, "sg-msg"))).type, "delivered");
		assert.equal(
			(
				await waitFor(() =>
					framesOf(sameGroupAlice).find((frame) => frame.type === "message" && frame.message.id === "sg-msg"),
				)
			).type,
			"message",
		);
	} finally {
		outbox.markDelivered = realMarkDelivered;
		gate.resolve();
	}
	assert.equal((await waitFor(() => outcomeOf(crossGroupAlice, "sg-open"))).type, "delivered");

	// requirePendingReply cannot be satisfied by a return path, so it fails immediately while a non-receipt write is held.
	const stage2 = await b.connect("stage2", "stages", false);
	const heldWrites: Array<(written: boolean) => void> = [];
	b.writeConfirmedHook = (socket, frame, onSettled) => {
		if (socket === stage2.socket) {
			b.write(socket, frame);
			heldWrites.push(onSettled);
			return;
		}
		onSettled(b.write(socket, frame));
	};
	a.send(crossGroupAlice, "stage2", "sg-open-2");
	await waitFor(() => framesOf(stage2).find((frame) => frame.type === "message" && frame.message.id === "sg-open-2"));
	b.send(stage2, crossGroupAlice.info.id, "req-reply", { replyTo: "missing-ask" }, { requirePendingReply: true });
	assert.equal((await waitFor(() => outcomeOf(stage2, "req-reply"))).type, "delivery_failed");
	for (const settle of heldWrites.splice(0)) settle(true);
});

test("multi-node local sends preserve per-(sender, target) FIFO order across ID and name targeting with one outbox read", async () => {
	const [_a, b] = await cluster();
	const launcher = await b.connect("launcher", "launch", false, createReachPolicy("launch", ["stages"]));
	const stage = await b.connect("stage", "stages", false);

	// Case A: msg-1 (by ID) and msg-2 (by ID)
	const heldLocal: Array<(written: boolean) => void> = [];
	b.localWriteConfirmedHook = (socket, frame, onSettled) => {
		if (socket === stage.socket) {
			b.write(socket, frame);
			heldLocal.push(onSettled);
			return;
		}
		onSettled(b.write(socket, frame));
	};

	let msg1Reads = 0;
	const outbox = b.opened.state.outbox;
	const realRead = outbox.read.bind(outbox);
	const msg1ReadDone = Promise.withResolvers<void>();
	const msg2ReadEntered = Promise.withResolvers<void>();
	const msg2ReadGate = Promise.withResolvers<void>();
	outbox.read = async (messageId) => {
		if (messageId === "fifo-a-1") {
			msg1Reads += 1;
			const result = await realRead(messageId);
			if (msg1Reads === 1) msg1ReadDone.resolve();
			return result;
		}
		if (messageId === "fifo-a-2") {
			msg2ReadEntered.resolve();
			await msg2ReadGate.promise;
			return realRead(messageId);
		}
		return realRead(messageId);
	};

	b.send(launcher, "stage", "fifo-a-open");
	await waitFor(() => framesOf(stage).find((frame) => frame.type === "message" && frame.message.id === "fifo-a-open"));
	const msg1Parked = Promise.withResolvers<void>();
	const realWhenOpening = b.returnPaths.whenOpening;
	b.returnPaths.whenOpening = (...args) => {
		const waited = realWhenOpening(...args);
		if (waited) msg1Parked.resolve();
		return waited;
	};
	b.send(stage, launcher.info.id, "fifo-a-1");
	await msg1ReadDone.promise;
	await msg1Parked.promise;
	b.returnPaths.whenOpening = realWhenOpening;
	b.send(stage, launcher.info.id, "fifo-a-2");
	await msg2ReadEntered.promise;
	for (const settle of heldLocal.splice(0)) settle(true);
	msg2ReadGate.resolve();

	assert.equal((await waitFor(() => outcomeOf(stage, "fifo-a-1"))).type, "delivered");
	assert.equal((await waitFor(() => outcomeOf(stage, "fifo-a-2"))).type, "delivered");
	outbox.read = realRead;

	const orderA = framesOf(launcher)
		.filter((frame) => frame.type === "message" && frame.message.id.startsWith("fifo-a-"))
		.map((frame) => (frame.type === "message" ? frame.message.id : ""));
	assert.equal(msg1Reads, 1, "parked local send must not re-enter routeRemote for a second outbox read");
	assert.deepEqual(orderA, ["fifo-a-1", "fifo-a-2"]);

	// Case B: msg-1 (by NAME) followed by msg-2 (by ID)
	const launcher2 = await b.connect("launcher2", "launch2", false, createReachPolicy("launch2", ["stages2"]));
	const stage2 = await b.connect("stage2", "stages2", false);
	const heldLocal2: Array<(written: boolean) => void> = [];
	b.localWriteConfirmedHook = (socket, frame, onSettled) => {
		if (socket === stage2.socket) {
			b.write(socket, frame);
			heldLocal2.push(onSettled);
			return;
		}
		onSettled(b.write(socket, frame));
	};
	const msg2bEntered = Promise.withResolvers<void>();
	const msg2bGate = Promise.withResolvers<void>();
	outbox.read = async (messageId) => {
		if (messageId === "fifo-b-2") {
			msg2bEntered.resolve();
			await msg2bGate.promise;
			return realRead(messageId);
		}
		return realRead(messageId);
	};

	b.send(launcher2, "stage2", "fifo-b-open");
	await waitFor(() =>
		framesOf(stage2).find((frame) => frame.type === "message" && frame.message.id === "fifo-b-open"),
	);
	const msg1bParked = Promise.withResolvers<void>();
	const realWhenForTargetB = b.returnPaths.whenOpeningForTarget;
	b.returnPaths.whenOpeningForTarget = (...args) => {
		const waited = realWhenForTargetB(...args);
		if (waited) msg1bParked.resolve();
		return waited;
	};
	b.send(stage2, "launcher2", "fifo-b-1");
	b.send(stage2, launcher2.info.id, "fifo-b-2");
	await Promise.all([msg1bParked.promise, msg2bEntered.promise]);
	b.returnPaths.whenOpeningForTarget = realWhenForTargetB;
	// Settle fifo-b-open while fifo-b-2 is in outbox.read, then release fifo-b-2.
	for (const settle of heldLocal2.splice(0)) settle(true);
	msg2bGate.resolve();

	assert.equal((await waitFor(() => outcomeOf(stage2, "fifo-b-1"))).type, "delivered");
	assert.equal((await waitFor(() => outcomeOf(stage2, "fifo-b-2"))).type, "delivered");
	outbox.read = realRead;

	const orderB = framesOf(launcher2)
		.filter((frame) => frame.type === "message" && frame.message.id.startsWith("fifo-b-"))
		.map((frame) => (frame.type === "message" ? frame.message.id : ""));
	assert.deepEqual(orderB, ["fifo-b-1", "fifo-b-2"]);
});

test("hung markDelivered expires within the return-path opening wait bound and releases on sessionLeft", async () => {
	// Part 1: bounded wait expires cleanly when markDelivered hangs
	const [a, b] = await cluster(80);
	const launcher = await a.connect("launcher", "launch", false, createReachPolicy("launch", ["stages"]));
	const stage = await b.connect("stage", "stages", true);
	a.send(launcher, "stage", "hung-m1");
	await waitFor(() => framesOf(stage).find((frame) => frame.type === "message" && frame.message.id === "hung-m1"));

	const outbox = b.opened.state.outbox;
	const realMark = outbox.markDelivered.bind(outbox);
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	outbox.markDelivered = async (claim) => {
		entered.resolve();
		await gate.promise;
		return realMark(claim);
	};
	assert.equal(b.router.received(stage, "hung-m1"), true);
	await entered.promise;

	try {
		b.send(stage, "launcher", "hung-ans");
		const expiredOutcome = await waitFor(() => outcomeOf(stage, "hung-ans"));
		assert.equal(expiredOutcome.type, "delivery_failed");

		// Part 2: sessionLeft releases settling opening and ends responder cleanly (no zombie path on late settle)
		b.sessions.delete(stage.info.id);
		b.rawReturnPaths.revoke(`["return","${stage.registrationReturnAddress}","stages"]`);
		b.router.sessionLeft(stage, undefined, true);
	} finally {
		outbox.markDelivered = realMark;
		gate.resolve();
	}
	await waitFor(() => outcomeOf(launcher, "hung-m1"));
	assert.equal(
		b.returnPaths.holds(stage, {
			sessionId: launcher.info.id,
			identity: `["return","${launcher.registrationReturnAddress}","launch"]`,
		}),
		false,
	);
});

test("joining the sender's group while waiting in enqueueThroughOutbox delivers as same-group once the opening settles", async () => {
	const [a, b] = await cluster();
	const launcherAddr = randomUUID();
	const launcherOld = await a.connect(
		"l-old",
		"launch3",
		false,
		createReachPolicy("launch3", ["stages3"]),
		launcherAddr,
	);
	const stage3 = await b.connect("stage3", "stages3", true);
	a.send(launcherOld, "stage3", "join-m1");
	await waitFor(() => framesOf(stage3).find((frame) => frame.type === "message" && frame.message.id === "join-m1"));
	a.sessions.delete(launcherOld.info.id);
	a.router.sessionLeft(launcherOld, undefined, false);
	const launcherNew = await a.connect(
		"l-new",
		"launch3",
		false,
		createReachPolicy("launch3", ["stages3"]),
		launcherAddr,
	);

	const outbox = b.opened.state.outbox;
	const realMark = outbox.markDelivered.bind(outbox);
	const gate3 = Promise.withResolvers<void>();
	const entered3 = Promise.withResolvers<void>();
	outbox.markDelivered = async (claim) => {
		entered3.resolve();
		await gate3.promise;
		return realMark(claim);
	};
	assert.equal(b.router.received(stage3, "join-m1"), true);
	await entered3.promise;

	// Address launcherNew by its new ID (reaches enqueueThroughOutbox wait); wait deterministically until parked.
	const parkedInEnqueue = Promise.withResolvers<void>();
	const realWhenOpening = b.returnPaths.whenOpening;
	b.returnPaths.whenOpening = (...args) => {
		const waited = realWhenOpening(...args);
		if (waited) parkedInEnqueue.resolve();
		return waited;
	};
	try {
		b.send(stage3, launcherNew.info.id, "join-ans");
		await parkedInEnqueue.promise;
		b.returnPaths.whenOpening = realWhenOpening;
		stage3.info.groups = [...(stage3.info.groups ?? []), "launch3"];
	} finally {
		b.returnPaths.whenOpening = realWhenOpening;
		outbox.markDelivered = realMark;
		gate3.resolve();
	}
	assert.equal((await waitFor(() => outcomeOf(stage3, "join-ans"))).type, "delivered");
});
