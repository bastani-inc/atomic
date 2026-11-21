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
				writeConfirmed: (socket, frame, onSettled) => onSettled(node.write(socket, frame)),
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
