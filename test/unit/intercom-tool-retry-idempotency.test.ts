import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
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
		params: { action: string; to?: string; message?: string; retryToken?: string },
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
let beforeAcknowledgement: (() => void) | undefined;

function brokerWrite(target: net.Socket, message: BrokerMessage): boolean {
	if (message.type === "delivered") beforeAcknowledgement?.();
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

function registerTool(sender: Client, onResolve?: () => void): Tool {
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
			resolveSessionTarget: async () => {
				onResolve?.();
				return "recipient-id";
			},
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
	beforeAcknowledgement = undefined;
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
	const retryToken = first.details?.retryToken;
	assert.equal(typeof retryToken, "string", "the recoverable result must expose the retry claim to the model");
	assert.match(first.content[0]?.text ?? "", /retryToken/);
	assert.equal(first.details?.messageId, undefined, "recoverable results do not expose the internal message ID");
	assert.equal(received.length, 1, "the broker accepted and forwarded the first operation");

	const retry = await tool.execute(
		"model-retry",
		{ action: "send", to: "recipient", message: "one logical operation", retryToken: retryToken as string },
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
	const settledReplay = await tool.execute(
		"settled-replay",
		{ action: "send", to: "recipient", message: "one logical operation", retryToken: retryToken as string },
		undefined,
		undefined,
		context,
	);
	assert.equal(settledReplay.isError, true);
	assert.match(settledReplay.content[0]?.text ?? "", /already settled/);
	assert.equal(attemptedIds.length, 2, "a settled token must fail before the client send");
});

test("a byte-identical tokenless call remains distinct while the failed operation is retained", async () => {
	const recipient = await connect("recipient");
	recipient.on("message", (_from: SessionInfo, message: Message) => received.push(message));
	const sender = await connect("sender");
	const tool = registerTool(sender);
	dropNextSenderAcknowledgement = true;
	const params = { action: "send", to: "recipient", message: "identical intentional bytes" };

	const first = await tool.execute("retained-a", params, undefined, undefined, context);
	const retryToken = first.details?.retryToken;
	assert.equal(typeof retryToken, "string");
	const intentional = await tool.execute("fresh-b", params, undefined, undefined, context);
	assert.equal(intentional.isError, false, intentional.content[0]?.text);
	const retry = await tool.execute(
		"claimed-a",
		{ ...params, retryToken: retryToken as string },
		undefined,
		undefined,
		context,
	);
	assert.equal(retry.isError, false, retry.content[0]?.text);
	assert.deepEqual(attemptedIds, [received[0]?.id, received[1]?.id, received[0]?.id]);
	assert.equal(received.length, 2);
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

// #2840: stage cancellation must not erase retry authority for an accepted send.
test("stage closure before a lost acknowledgement preserves the accepted send's retry identity", async () => {
	const recipient = await connect("recipient");
	recipient.on("message", (_from: SessionInfo, message: Message) => received.push(message));
	const sender = await connect("sender");
	const tool = registerTool(sender);
	const boundary = new WorkflowStageAdmissionBoundary();
	beforeAcknowledgement = () => {
		void boundary.close();
	};
	dropNextSenderAcknowledgement = true;

	const first = await tool.execute(
		"stage-send",
		{ action: "send", to: "recipient", message: "accepted before closure" },
		boundary.closeSignal,
		undefined,
		context,
	);
	assert.equal(boundary.closeSignal.aborted, true);
	assert.equal(first.isError, true);
	assert.match(first.content[0]?.text ?? "", /Client disconnected/);
	const retryToken = first.details?.retryToken;
	assert.equal(typeof retryToken, "string");
	const retry = await tool.execute(
		"resolve-accepted-send",
		{ action: "send", to: "recipient", message: "accepted before closure", retryToken: retryToken as string },
		undefined,
		undefined,
		context,
	);
	assert.equal(retry.isError, false);
	assert.equal(attemptedIds.length, 2);
	assert.equal(attemptedIds[1], attemptedIds[0]);
	assert.equal(received.length, 1, "retry must not deliver the accepted message twice");
});

// #2840: a receipt still describes transport acceptance when the stage closes.
test("stage closure before acknowledgement preserves a successful transport receipt", async () => {
	const recipient = await connect("recipient");
	recipient.on("message", (_from: SessionInfo, message: Message) => received.push(message));
	const sender = await connect("sender");
	const tool = registerTool(sender);
	const boundary = new WorkflowStageAdmissionBoundary();
	beforeAcknowledgement = () => {
		void boundary.close();
	};
	const result = await tool.execute(
		"stage-send",
		{ action: "send", to: "recipient", message: "accepted before closure" },
		boundary.closeSignal,
		undefined,
		context,
	);
	assert.equal(boundary.closeSignal.aborted, true);
	assert.equal(result.isError, false);
	assert.equal(result.details?.delivered, true);
	assert.equal(result.details?.messageId, attemptedIds[0]);
	assert.equal(received.length, 1);
});

// #2840: cancelling before retry transport must not settle the original operation.
test("cancellation during retry target resolution retains the original retry token", async () => {
	const recipient = await connect("recipient");
	recipient.on("message", (_from: SessionInfo, message: Message) => received.push(message));
	const sender = await connect("sender");
	const boundary = new WorkflowStageAdmissionBoundary();
	let cancelAtResolution = false;
	const tool = registerTool(sender, () => {
		if (cancelAtResolution) void boundary.close();
	});
	const params = { action: "send", to: "recipient", message: "retry after cancelled resolution" };
	dropNextSenderAcknowledgement = true;
	const first = await tool.execute("first", params, undefined, undefined, context);
	const retryToken = first.details?.retryToken;
	assert.equal(typeof retryToken, "string");
	const retryParams = { ...params, retryToken: retryToken as string };
	cancelAtResolution = true;
	const cancelled = await tool.execute("cancelled", retryParams, boundary.closeSignal, undefined, context);
	assert.equal(cancelled.isError, true);
	assert.equal(cancelled.details?.retryToken, retryToken);
	assert.equal(attemptedIds.length, 1, "cancelled retry must not reach transport");
	cancelAtResolution = false;
	const retry = await tool.execute("retry", retryParams, undefined, undefined, context);
	assert.equal(retry.isError, false);
	assert.equal(attemptedIds.length, 2);
	assert.equal(attemptedIds[1], attemptedIds[0]);
	assert.equal(received.length, 1);
});
