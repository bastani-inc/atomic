import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type net from "node:net";
import { join } from "node:path";
import { openNodeSqliteDatabase, type SqliteDatabase } from "@bastani/atomic/storage";
import { vi } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { writeMessage } from "../../packages/intercom/broker/framing.js";
import { MultiNodeRouter } from "../../packages/intercom/broker/multinode-router.js";
import {
	borrowedDatabase,
	type OpenedBrokerState,
	openIntercomBrokerState,
} from "../../packages/intercom/broker/open-broker-state.js";
import { PendingQuestionIndex } from "../../packages/intercom/broker/pending-question-index.js";
import {
	type BrokerConnectedSession,
	handleBrokerSend,
	type SendClientMessage,
} from "../../packages/intercom/broker/send-handler.js";
import type { BrokerOutboundFrame } from "../../packages/intercom/broker/socket-writes.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import type { WakeUpBus } from "../../packages/intercom/broker/wake-up-bus.js";
import { normalizeGroup } from "../../packages/intercom/group.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { type ConnectionRequestTracker, trackConnectionRequests } from "../helpers/sqlite-connection-requests.js";

/** Cross-node hops ride the database-polled bus; this bounds a healthy delivery, far above the poll interval. */
export const CROSS_NODE_WAIT_MS = 10_000;
export const BUS_POLL_INTERVAL_MS = 20;
const ATTACHMENTS = [{ type: "snippet" as const, name: " a.ts ", content: "const x = 1;\r\n", language: "ts" }];
const VERBATIM = "  cross-node\tparity\u0000 ünïcödé ✓  \n";

export type FakeSocket = net.Socket & { frames: BrokerOutboundFrame[]; written?: () => void };

function fakeSocket(): FakeSocket {
	return { destroyed: false, writableEnded: false, frames: [] } as unknown as FakeSocket;
}

export class Node {
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
	/** The reader handles this node's broker opened on `database`, which its bounded reads go through (#6560). */
	readonly readers: SqliteDatabase[] = [];

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
		/** The broker state's table prefix: a storage backend scope's, on a server other scopes share. */
		prefix = "mn_",
	): Promise<Node> {
		const node = new Node(name, directory);
		node.database = shared;
		const openReader = shared.openReader?.bind(shared);
		const borrowed = borrowedDatabase(shared);
		const recording =
			openReader === undefined
				? borrowed
				: new Proxy(borrowed, {
						get: (target, key) =>
							key === "openReader"
								? async () => {
										const reader = await openReader();
										node.readers.push(reader);
										return reader;
									}
								: Reflect.get(target, key),
					});
		node.opened = await openIntercomBrokerState(
			{ openDatabase: async () => recording, prefix },
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

export function message(overrides: Partial<Message> = {}): Message {
	return {
		id: randomUUID(),
		timestamp: 1_700_000_000_000,
		content: { text: VERBATIM, attachments: ATTACHMENTS },
		...overrides,
	};
}

export function framesOf(session: BrokerConnectedSession): BrokerOutboundFrame[] {
	return (session.socket as FakeSocket).frames;
}

export function messageFrames(session: BrokerConnectedSession, id: string) {
	return framesOf(session).filter((frame) => frame.type === "message" && frame.message.id === id);
}

export function outcomeOf(session: BrokerConnectedSession, id: string) {
	return framesOf(session).find(
		(frame) =>
			(frame.type === "delivered" || frame.type === "delivery_failed" || frame.type === "queued") &&
			frame.messageId === id,
	);
}

export async function waitFor<T>(read: () => T | undefined, timeout = CROSS_NODE_WAIT_MS): Promise<T> {
	return vi.waitFor(
		() => {
			const value = read();
			assert.ok(value !== undefined, "not yet");
			return value;
		},
		{ timeout, interval: 10 },
	);
}

export const cleanups: Array<() => Promise<void>> = [];

export async function runCleanups(): Promise<void> {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

export async function cluster(count = 2, wrapBus?: (node: number, bus: WakeUpBus) => WakeUpBus): Promise<Node[]> {
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

let connectionRequests: ConnectionRequestTracker | undefined;

export function startConnectionTracking(): void {
	connectionRequests = trackConnectionRequests();
}

export function stopConnectionTracking(): void {
	connectionRequests?.restore();
	connectionRequests = undefined;
}

/**
 * Lets the store finish the file I/O a fake-time step started before time moves on: the store's transactions check
 * their writers' queue and records off the event loop, so a step's work can need several real turns. It waits for
 * that I/O to finish, not for a number of turns: on a loaded machine a fixed count of turns can pass while the I/O is
 * still running, and fake time would then run ahead of the work it is meant to time. Every file request completes,
 * so the wait ends; the test's own timeout bounds a store that never does.
 */
export async function settleFileIo(): Promise<void> {
	do await new Promise((resolveTurn) => setImmediate(resolveTurn));
	while (
		process.getActiveResourcesInfo().some((kind) => kind.startsWith("FSReq")) ||
		// A connection answers on its own thread, on a real turn too (#5376).
		(connectionRequests?.pending ?? 0) > 0
	);
}

export async function advanceUntil<T>(
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

/** Steps fake time forward, letting the real store and bus settle between steps. */
export async function advance(totalMs: number, stepMs = 500): Promise<void> {
	for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
		await vi.advanceTimersByTimeAsync(stepMs);
		await settleFileIo();
	}
}

/** Wait until no live presence lease names this session, so a send to it is queued for an offline session. */
export async function waitOffline(node: Node, session: BrokerConnectedSession): Promise<void> {
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

export function reasonOf(frame: BrokerOutboundFrame | undefined): string | undefined {
	return frame?.type === "delivery_failed" ? frame.reason : undefined;
}

/**
 * Run `act`, then resolve with `read()` once it is defined, checked as each frame is written to `session` rather than
 * polled: a flood polled for its frames took a timer tick apiece (about 16 ms on Windows) on top of the work itself.
 */
export async function whenWritten<T>(
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
export function sendAndSettle(node: Node, from: BrokerConnectedSession, to: string, sent: Message) {
	return whenWritten(
		from,
		() => outcomeOf(from, sent.id),
		`outcome for ${sent.id}`,
		() => node.send(from, to, sent),
	);
}
