import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, test } from "vitest";
import { createMessageReader, type JsonWireValue, writeMessage } from "../../packages/intercom/broker/framing.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

const agentDir = mkdtempSync(join(tmpdir(), "intercom-receipt-capability-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
type Client = InstanceType<typeof IntercomClient>;

const socketPath = getBrokerSocketPath();

afterAll(() => {
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	if (previousLegacyAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousLegacyAgentDir;
	rmSync(agentDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

type WireFrame = { type: string } & Record<string, JsonWireValue>;

/**
 * A broker over the real socket and framing. `legacy` behaves like a broker from before receipts existed: it never
 * echoes the capability, reports `delivered` once the socket write succeeds, and treats an unknown frame type the way
 * that broker did, by throwing and destroying the socket. `receipts` echoes the capability and accepts `received`.
 */
class TestBroker {
	mode: "legacy" | "receipts" = "legacy";
	readonly receivedFrames: string[] = [];
	private readonly sessions = new Map<string, { socket: net.Socket; info: SessionInfo }>();
	private readonly sockets = new Set<net.Socket>();
	private readonly server = net.createServer((socket) => this.accept(socket));
	private nextId = 0;

	async listen(): Promise<void> {
		mkdirSync(dirname(socketPath), { recursive: true });
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(socketPath, () => resolve());
		});
	}

	async close(): Promise<void> {
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private accept(socket: net.Socket): void {
		this.sockets.add(socket);
		let sessionId: string | null = null;
		const reader = createMessageReader(
			(frame) => {
				sessionId = this.handle(socket, frame as WireFrame, sessionId);
			},
			(error) => socket.destroy(error),
		);
		socket.on("data", reader);
		socket.on("error", () => {});
		socket.on("close", () => {
			this.sockets.delete(socket);
			if (sessionId !== null) this.sessions.delete(sessionId);
		});
	}

	private handle(socket: net.Socket, frame: WireFrame, sessionId: string | null): string | null {
		switch (frame.type) {
			case "register": {
				const id = `session-${++this.nextId}`;
				const info = { ...(frame.session as object), id } as SessionInfo;
				this.sessions.set(id, { socket, info });
				const echo = this.mode === "receipts" && frame.acknowledgesReceipt === true;
				writeMessage(socket, { type: "registered", sessionId: id, ...(echo ? { acknowledgesReceipt: true } : {}) });
				return id;
			}
			case "list": {
				const sessions = [...this.sessions.values()].map((session) => session.info);
				writeMessage(socket, { type: "sessions", requestId: frame.requestId, sessions });
				return sessionId;
			}
			case "send": {
				const sender = sessionId === null ? undefined : this.sessions.get(sessionId);
				const target = this.sessions.get(String(frame.to));
				const message = frame.message as unknown as Message;
				if (sender === undefined || target === undefined || target.socket.destroyed) {
					writeMessage(socket, {
						type: "delivery_failed",
						messageId: message.id,
						attemptId: frame.attemptId,
						reason: "Session not found",
					});
					return sessionId;
				}
				writeMessage(target.socket, { type: "message", from: sender.info, message });
				writeMessage(socket, { type: "delivered", messageId: message.id, attemptId: frame.attemptId });
				return sessionId;
			}
			case "unregister":
				if (sessionId !== null) this.sessions.delete(sessionId);
				return null;
			case "received":
				if (this.mode === "receipts") {
					this.receivedFrames.push(String(frame.messageId));
					return sessionId;
				}
				throw new Error(`Unknown client message type: ${frame.type}`);
			default:
				throw new Error(`Unknown client message type: ${frame.type}`);
		}
	}
}

function session(name: string): Omit<SessionInfo, "id"> {
	const now = Date.now();
	return { name, cwd: agentDir, model: "test-model", pid: process.pid, startedAt: now, lastActivity: now };
}

/** A recipient that confirms every message it gets, the way the runtime does once it has saved it. */
function confirmingRecipient() {
	const client = new IntercomClient("recipient-home", { acknowledgesReceipt: true });
	const arrived: string[] = [];
	let disconnects = 0;
	client.on("message", (_from: SessionInfo, message: Message) => {
		arrived.push(message.id);
		try {
			client.acknowledgeReceived(message.id);
		} catch {
			// Mirrors the runtime: a failed confirmation is retried by the broker's redelivery.
		}
	});
	client.on("disconnected", () => {
		disconnects += 1;
	});
	client.on("error", () => {});
	return {
		client,
		arrived,
		get disconnects() {
			return disconnects;
		},
	};
}

let broker: TestBroker | undefined;
const clients: Client[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.disconnect();
	await broker?.close();
	broker = undefined;
});

async function connected(client: Client, name: string): Promise<Client> {
	clients.push(client);
	await client.connect(session(name));
	return client;
}

test("a recipient that confirms saves keeps working through consecutive sends on a broker without receipts (#3761)", async () => {
	broker = new TestBroker();
	await broker.listen();
	const recipient = confirmingRecipient();
	await connected(recipient.client, "recipient");
	const sender = await connected(new IntercomClient("sender-home"), "sender");
	const to = recipient.client.sessionId;
	assert.ok(to);

	for (const id of ["update-0", "update-1"]) {
		const result = await sender.send(to, { messageId: id, text: id });
		assert.deepEqual(result, { id, delivered: true }, `${id} reaches the recipient`);
		// The broker handles a connection's frames in order, so this round trip settles anything the recipient sent.
		await recipient.client.listSessions();
	}

	assert.deepEqual(recipient.arrived, ["update-0", "update-1"]);
	assert.equal(recipient.disconnects, 0, "the recipient stays connected");
	assert.equal(recipient.client.isConnected(), true);
	assert.deepEqual(broker.receivedFrames, []);
});

test("a recipient confirms saves only while its current broker echoes the capability, re-learned on each registration (#3761)", async () => {
	broker = new TestBroker();
	await broker.listen();
	const recipient = confirmingRecipient();
	const sender = await connected(new IntercomClient("sender-home"), "sender");
	const exchange = async (id: string) => {
		const to = recipient.client.sessionId;
		assert.ok(to);
		assert.deepEqual(await sender.send(to, { messageId: id, text: id }), { id, delivered: true });
		await recipient.client.listSessions();
	};

	broker.mode = "receipts";
	await connected(recipient.client, "recipient");
	await exchange("upgraded-0");
	assert.deepEqual(broker.receivedFrames, ["upgraded-0"]);

	await recipient.client.disconnect();
	broker.mode = "legacy";
	await recipient.client.connect(session("recipient"));
	await exchange("legacy-0");
	assert.deepEqual(broker.receivedFrames, ["upgraded-0"], "no confirmation goes to a broker that did not echo it");

	await recipient.client.disconnect();
	broker.mode = "receipts";
	await recipient.client.connect(session("recipient"));
	await exchange("upgraded-1");
	assert.deepEqual(broker.receivedFrames, ["upgraded-0", "upgraded-1"]);

	assert.deepEqual(recipient.arrived, ["upgraded-0", "legacy-0", "upgraded-1"]);
	assert.equal(recipient.disconnects, 0, "only the deliberate disconnects closed the recipient");
});
