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

function registerTool(sender: Client, onResolve?: () => void | Promise<void>): Tool {
	let tool: Tool | undefined;
	const waiters = new ReplyWaiterRegistry();
	registerIntercomTool(
		{
			registerTool(value: Tool) {
				tool = value;
			},
			async appendEntry() {},
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
				await onResolve?.();
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

test("one tool invocation recovers after broker acceptance and acknowledgement loss with one delivery", async () => {
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
	assert.equal(first.isError, false, first.content[0]?.text);
	assert.equal(first.content[0]?.text, "Message sent to recipient");
	assert.doesNotMatch(JSON.stringify(first), /retryToken/);
	assert.equal(attemptedIds.length, 2);
	assert.equal(attemptedIds[1], attemptedIds[0], "internal recovery retains the accepted operation identity");
	assert.equal(first.details?.messageId, attemptedIds[0]);
	assert.equal(received.length, 1, "the broker must not forward a duplicate delivery");
});

test("a byte-identical concurrent call remains distinct while the first invocation recovers", async () => {
	const recipient = await connect("recipient");
	recipient.on("message", (_from: SessionInfo, message: Message) => received.push(message));
	const sender = await connect("sender");
	const recoveryGate = Promise.withResolvers<void>();
	const recoveryStarted = Promise.withResolvers<void>();
	let resolutions = 0;
	const tool = registerTool(sender, async () => {
		if (++resolutions === 2) {
			recoveryStarted.resolve();
			await recoveryGate.promise;
		}
	});
	dropNextSenderAcknowledgement = true;
	const params = { action: "send", to: "recipient", message: "identical intentional bytes" };

	const firstExecution = tool.execute("recovering-a", params, undefined, undefined, context);
	await recoveryStarted.promise;
	try {
		const intentional = await tool.execute("fresh-b", params, undefined, undefined, context);
		assert.equal(intentional.isError, false, intentional.content[0]?.text);
		assert.doesNotMatch(JSON.stringify(intentional), /retryToken/);
	} finally {
		recoveryGate.resolve();
	}
	const recovered = await firstExecution;
	assert.equal(recovered.isError, false, recovered.content[0]?.text);
	assert.doesNotMatch(JSON.stringify(recovered), /retryToken/);
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

// #2840: an accepted send may have been delivered even when cancellation stops recovery.
test("stage closure after acceptance and acknowledgement loss stops retries with unknown outcome", async () => {
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
	assert.match(first.content[0]?.text ?? "", /Cancelled/);
	assert.match(first.content[0]?.text ?? "", /Delivery may already have occurred/);
	assert.match(first.content[0]?.text ?? "", /Do not repeat this operation automatically/);
	assert.deepEqual(first.details, { error: true, terminal: true, automaticRetries: 0, outcome: "unknown" });
	assert.doesNotMatch(JSON.stringify(first), /retryToken/);
	assert.equal(attemptedIds.length, 1, "stage cancellation must prevent internal retries");
	assert.equal(received.length, 1, "cancellation cannot undo the already accepted delivery");
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

// #2840: cancelled recovery must neither send again nor report certain nondelivery.
test("cancellation during internal retry target resolution stops with unknown outcome", async () => {
	const recipient = await connect("recipient");
	recipient.on("message", (_from: SessionInfo, message: Message) => received.push(message));
	const sender = await connect("sender");
	const boundary = new WorkflowStageAdmissionBoundary();
	let resolutions = 0;
	const tool = registerTool(sender, () => {
		if (++resolutions === 2) void boundary.close();
	});
	const params = { action: "send", to: "recipient", message: "retry after cancelled resolution" };
	dropNextSenderAcknowledgement = true;
	const cancelled = await tool.execute("single-call", params, boundary.closeSignal, undefined, context);
	assert.equal(cancelled.isError, true);
	assert.equal(resolutions, 2, "cancellation happens during the internal retry's resolution");
	assert.deepEqual(cancelled.details, { error: true, terminal: true, automaticRetries: 1, outcome: "unknown" });
	assert.match(cancelled.content[0]?.text ?? "", /Cancelled/);
	assert.doesNotMatch(JSON.stringify(cancelled), /retryToken/);
	assert.equal(attemptedIds.length, 1, "cancelled retry must not reach transport");
	assert.equal(received.length, 1);
});
