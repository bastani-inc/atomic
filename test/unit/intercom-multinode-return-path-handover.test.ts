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
	readonly returnPaths: ReturnPathAuthority = createReturnPathAuthority(new ReturnPaths(), this.sessions);
	writeConfirmedHook:
		| ((socket: net.Socket, frame: BrokerOutboundFrame, onSettled: (written: boolean) => void) => void)
		| undefined;
	router!: MultiNodeRouter;
	opened!: OpenedBrokerState;

	static async start(shared: SqliteDatabase): Promise<Node> {
		const node = new Node();
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
	async connect(name: string, group: string, confirmsSaves: boolean, reach?: IntercomReachPolicy) {
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
			registrationReturnAddress: randomUUID(),
			...(confirmsSaves ? { acknowledgesReceipt: true as const } : {}),
			...(reach === undefined ? {} : { reach }),
		};
		this.sessions.set(info.id, session);
		await this.router.sessionRegistered(session);
		return session;
	}

	send(from: BrokerConnectedSession, to: string, id: string): void {
		handleBrokerSend(
			from.socket,
			{ type: "send", to, message: { id, timestamp: 1, content: { text: id } }, attemptId: randomUUID() },
			from.info.id,
			this.sessions,
			this.deliveredMessages,
			(target, frame) => this.write(target, frame),
			this.supervisorCache,
			this.pendingQuestions,
			(target, frame, onSettled) => onSettled(this.write(target, frame)),
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

async function cluster(): Promise<[Node, Node]> {
	const directory = makeTempDirectory("intercom-multinode-return-path-");
	const shared = await openNodeSqliteDatabase(join(directory, "shared.sqlite"));
	const nodes: Node[] = [];
	cleanups.push(async () => {
		for (const node of nodes) await node.close();
		await shared.close();
		removeTempDirectory(directory);
	});
	for (let index = 0; index < 2; index++) nodes.push(await Node.start(shared));
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
