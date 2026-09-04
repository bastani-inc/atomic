import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { type BrokerConnectedSession, handleBrokerSend } from "../../packages/intercom/broker/send-handler.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { BrokerMessage, ClientMessage, Message, SessionInfo } from "../../packages/intercom/types.js";

const agentDir = mkdtempSync(join(tmpdir(), "intercom-tool-retry-"));
const socketPath = getBrokerSocketPath(process.platform, agentDir);
const originalAtomicAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;
mkdirSync(join(agentDir, "intercom"), { recursive: true });
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");

type Client = InstanceType<typeof IntercomClient>;
type ToolResult = { content: Array<{ text: string }>; isError: boolean; details?: Record<string, unknown> };
type Tool = {
	execute(
		id: string,
		params: { action: string; to?: string; message?: string },
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: object,
	): Promise<ToolResult>;
};

const sessions = new Map<string, BrokerConnectedSession>();
const delivered = new DeliveredMessageCache();
const liveClients: Client[] = [];
const received: Message[] = [];
const attemptedIds: string[] = [];
let server: net.Server;
let dropNextSenderAcknowledgement = false;

function brokerWrite(target: net.Socket, message: BrokerMessage): boolean {
	if (dropNextSenderAcknowledgement && message.type === "delivered") {
		dropNextSenderAcknowledgement = false;
		target.destroy();
		return true;
	}
	writeMessage(target, message);
	return true;
}

function acceptConnection(socket: net.Socket): void {
	let sessionId: string | null = null;
	socket.on("error", () => {});
	socket.on(
		"data",
		createMessageReader(
			(value) => {
				const message = value as ClientMessage;
				if (message.type === "register") {
					sessionId = message.session.name === "sender" ? "sender-id" : "recipient-id";
					const info: SessionInfo = { ...message.session, id: sessionId };
					sessions.set(sessionId, { socket, info });
					writeMessage(socket, { type: "registered", sessionId });
					return;
				}
				if (message.type !== "send") return;
				attemptedIds.push(message.message.id);
				handleBrokerSend(socket, message, sessionId, sessions, delivered, brokerWrite);
			},
			(error) => socket.destroy(error),
		),
	);
	socket.on("close", () => {
		if (sessionId !== null && sessions.get(sessionId)?.socket === socket) sessions.delete(sessionId);
	});
}

async function connect(name: string): Promise<Client> {
	const client = new IntercomClient();
	client.on("error", () => {});
	await client.connect({
		name,
		cwd: "/tmp/retry-test",
		model: "test",
		pid: process.pid,
		startedAt: Date.now(),
		lastActivity: Date.now(),
	});
	liveClients.push(client);
	return client;
}

function registerTool(sender: Client): Tool {
	let tool: Tool | undefined;
	const waiters = new ReplyWaiterRegistry();
	registerIntercomTool(
		{
			registerTool(value: Tool) {
				tool = value;
			},
			appendEntry() {},
		} as never,
		{
			ensureConnected: async () => {
				if (!sender.isConnected()) {
					await sender.connect({
						name: "sender",
						cwd: "/tmp/retry-test",
						model: "test",
						pid: process.pid,
						startedAt: Date.now(),
						lastActivity: Date.now(),
					});
				}
				return sender;
			},
			syncPresenceIdentity() {},
			resolveSessionTarget: async () => "recipient-id",
			homeGroup: () => "default",
			setJoinedGroups() {},
			clearJoinedGroups() {},
			confirmSend: false,
			beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) => waiters.begin(from, replyTo, signal),
			replyTracker: new ReplyTracker(),
		} as never,
	);
	assert.ok(tool);
	return tool;
}

const context = { sessionManager: { getSessionId: () => "host-session" }, hasUI: false };

beforeAll(async () => {
	server = net.createServer(acceptConnection);
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterEach(async () => {
	for (const client of liveClients.splice(0)) {
		try {
			await client.disconnect();
		} catch {
			// The acknowledgement-loss scenario intentionally destroys one connection.
		}
	}
	sessions.clear();
	received.length = 0;
	attemptedIds.length = 0;
	dropNextSenderAcknowledgement = false;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (originalAtomicAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAtomicAgentDir;
	if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

test("an identical tool retry after broker acceptance and acknowledgement loss is delivered once", async () => {
	const recipient = await connect("recipient");
	recipient.on("message", (_from: SessionInfo, message: Message) => received.push(message));
	const sender = await connect("sender");
	const tool = registerTool(sender);
	dropNextSenderAcknowledgement = true;

	const first = await tool.execute(
		"first-attempt",
		{ action: "send", to: "recipient", message: "one logical operation" },
		undefined,
		undefined,
		context,
	);
	assert.equal(first.isError, true);
	assert.match(first.content[0]?.text ?? "", /Client disconnected/);
	assert.equal(received.length, 1, "the broker accepted and forwarded the first operation");

	const retry = await tool.execute(
		"model-retry",
		{ action: "send", to: "recipient", message: "one logical operation" },
		undefined,
		undefined,
		context,
	);
	assert.equal(retry.isError, false);
	assert.equal(retry.content[0]?.text, "Message sent to recipient");
	assert.equal(attemptedIds.length, 2);
	assert.equal(attemptedIds[1], attemptedIds[0], "the model retry must retain the accepted operation identity");
	assert.equal(retry.details?.messageId, attemptedIds[0]);
	assert.equal(received.length, 1, "the broker must not forward a duplicate delivery");
});

test("an intentional identical send after a successful result gets a fresh identity and delivery", async () => {
	const recipient = await connect("recipient");
	recipient.on("message", (_from: SessionInfo, message: Message) => received.push(message));
	const sender = await connect("sender");
	const tool = registerTool(sender);

	for (const toolCallId of ["intentional-one", "intentional-two"]) {
		const result = await tool.execute(
			toolCallId,
			{ action: "send", to: "recipient", message: "repeat me intentionally" },
			undefined,
			undefined,
			context,
		);
		assert.equal(result.isError, false);
	}
	assert.equal(attemptedIds.length, 2);
	assert.notEqual(attemptedIds[0], attemptedIds[1]);
	assert.equal(received.length, 2);
});
