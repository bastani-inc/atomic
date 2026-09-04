import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import type { SendResult } from "../../packages/intercom/broker/client.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "intercom-tool-retry-real-"));
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

const liveClients: Client[] = [];
let broker: ChildProcess | undefined;

const session = {
	cwd: "/tmp/retry-real-test",
	model: "test",
	pid: process.pid,
	startedAt: 1,
	lastActivity: 1,
};

async function waitUntil(condition: () => boolean, description: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, `timed out waiting until ${description}`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
}

async function waitForSessionDeparture(observer: Client, sessionId: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while ((await observer.listSessions()).some((candidate) => candidate.id === sessionId)) {
		assert.ok(Date.now() < deadline, `timed out waiting for broker cleanup of ${sessionId}`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
}

async function waitForBroker(): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const connected = await new Promise<boolean>((resolveConnected) => {
			const probe = net.createConnection(socketPath);
			probe.once("connect", () => {
				probe.destroy();
				resolveConnected(true);
			});
			probe.once("error", () => resolveConnected(false));
		});
		if (connected) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
	throw new Error("Broker socket did not become ready");
}

async function connect(client: Client, name: string): Promise<void> {
	await client.connect({ ...session, name });
}

function createClient(name: string): Promise<Client> {
	const client = new IntercomClient();
	client.on("error", () => {});
	liveClients.push(client);
	return connect(client, name).then(() => client);
}

function registerTool(sender: Client): Tool {
	let tool: Tool | undefined;
	const waiters = new ReplyWaiterRegistry();
	sender.on("message", (from: SessionInfo, message: Message) => {
		routeIncomingReply(waiters.pending(), from, message);
	});
	sender.on("disconnected", (error: Error) => {
		waiters.rejectAll(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
	});
	registerIntercomTool(
		{
			registerTool(value: Tool) {
				tool = value;
			},
			appendEntry() {},
		} as never,
		{
			ensureConnected: async () => {
				if (!sender.isConnected()) await connect(sender, "sender");
				return sender;
			},
			syncPresenceIdentity() {},
			resolveSessionTarget: async () => "recipient",
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
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: "ignore",
	});
	await waitForBroker();
});

afterEach(async () => {
	for (const client of liveClients.splice(0)) {
		try {
			await client.disconnect();
		} catch {
			// Acknowledgement loss intentionally destroys the sender connection.
		}
	}
});

afterAll(async () => {
	if (broker && broker.exitCode === null) {
		broker.kill("SIGTERM");
		await new Promise<void>((resolveExit) => broker?.once("exit", () => resolveExit()));
	}
	if (originalAtomicAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAtomicAgentDir;
	if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

test("a tool retry is acknowledged after the real broker assigns a new sender session id", async () => {
	const received: Message[] = [];
	const recipient = await createClient("recipient");
	recipient.on("message", (_from: SessionInfo, message: Message) => received.push(message));
	const sender = await createClient("sender");
	const firstSenderId = sender.sessionId;
	assert.ok(firstSenderId);
	const tool = registerTool(sender);
	const brokerResults: SendResult[] = [];
	const send = sender.send.bind(sender);
	sender.send = async (...args: Parameters<Client["send"]>) => {
		const result = await send(...args);
		brokerResults.push(result);
		return result;
	};

	const socket = (sender as unknown as { socket: net.Socket }).socket;
	socket.pause();
	const firstExecution = tool.execute(
		"first-attempt",
		{ action: "send", to: "recipient", message: "one logical operation" },
		undefined,
		undefined,
		context,
	);
	await waitUntil(() => received.length === 1, "the broker forwards the first operation");
	socket.destroy();
	const first = await firstExecution;
	assert.equal(first.isError, true);
	assert.match(first.content[0]?.text ?? "", /Client disconnected/);

	const firstMessage = received[0];
	assert.ok(firstMessage);
	const retry = await tool.execute(
		"model-retry",
		{ action: "send", to: "recipient", message: "one logical operation" },
		undefined,
		undefined,
		context,
	);

	assert.notEqual(sender.sessionId, firstSenderId, "the real broker must assign a new id on re-registration");
	assert.deepEqual(retry, {
		content: [{ type: "text", text: "Message sent to recipient" }],
		isError: false,
		details: { messageId: firstMessage.id, delivered: true },
	});
	assert.deepEqual(brokerResults, [{ id: firstMessage.id, delivered: true }]);
	assert.equal(received.length, 1, "the broker must not forward a duplicate delivery");
});

test("two concurrent accepted operations survive acknowledgement loss without a third delivery", async () => {
	const received: Message[] = [];
	const recipient = await createClient("recipient");
	recipient.on("message", (_from: SessionInfo, message: Message) => received.push(message));
	const sender = await createClient("sender");
	const tool = registerTool(sender);
	const brokerResults: SendResult[] = [];
	const send = sender.send.bind(sender);
	sender.send = async (...args: Parameters<Client["send"]>) => {
		const result = await send(...args);
		brokerResults.push(result);
		return result;
	};

	const socket = (sender as unknown as { socket: net.Socket }).socket;
	socket.pause();
	const firstExecution = tool.execute(
		"first-concurrent-attempt",
		{ action: "send", to: "recipient", message: "identical concurrent operation" },
		undefined,
		undefined,
		context,
	);
	const secondExecution = tool.execute(
		"second-concurrent-attempt",
		{ action: "send", to: "recipient", message: "identical concurrent operation" },
		undefined,
		undefined,
		context,
	);
	await waitUntil(() => received.length === 2, "the broker forwards both intentional operations");
	socket.destroy();
	for (const failed of await Promise.all([firstExecution, secondExecution])) {
		assert.equal(failed.isError, true);
		assert.match(failed.content[0]?.text ?? "", /Client disconnected/);
	}
	const acceptedIds = received.map((message) => message.id);
	assert.equal(new Set(acceptedIds).size, 2);

	const firstRetry = await tool.execute(
		"first-concurrent-retry",
		{ action: "send", to: "recipient", message: "identical concurrent operation" },
		undefined,
		undefined,
		context,
	);
	const secondRetry = await tool.execute(
		"second-concurrent-retry",
		{ action: "send", to: "recipient", message: "identical concurrent operation" },
		undefined,
		undefined,
		context,
	);

	assert.equal(firstRetry.isError, false, firstRetry.content[0]?.text);
	assert.equal(secondRetry.isError, false, secondRetry.content[0]?.text);
	assert.deepEqual(
		brokerResults.map(({ id, delivered }) => ({ id, delivered })),
		acceptedIds.map((id) => ({ id, delivered: true })),
		"FIFO retry calls must claim identities in the original call order",
	);
	assert.equal(received.length, 2, "two accepted operations must never become three recipient deliveries");
});

test("a cross-group workflow ask retry rebinds its reply route after sender reconnection", async () => {
	const runId = "9f3c0cb8-f495-42de-9e4d-7f58f973ac55";
	const invocationGroup = `workflow:${runId}`;
	const stageGroup = `${invocationGroup}/reviewers`;
	const capability = "retry-rebind-workflow-capability";
	const target = `workflow:${runId}/reviewer`;
	const owner = new IntercomClient();
	const stage = new IntercomClient();
	const sender = new IntercomClient();
	for (const client of [owner, stage, sender]) {
		client.on("error", () => {});
		liveClients.push(client);
	}
	await owner.connect({ ...session, name: "workflow-owner", group: invocationGroup });
	await stage.connect({ ...session, name: "workflow-reviewer", group: stageGroup });
	await sender.connect({ ...session, name: "workflow-sender", group: "default" });
	await sender.joinGroup(invocationGroup);
	owner.registerPendingStageRoute(runId, invocationGroup, capability);
	await owner.listSessions();
	await stage.registerLiveWorkflowStageRoute(runId, ["reviewer"], capability);

	let routeValidations = 0;
	owner.on("pending_stage_message", (request) => {
		routeValidations += 1;
		owner.respondPendingStageMessage(request.requestId, { outcome: "forward", target });
	});
	const questions: Array<{ from: SessionInfo; message: Message }> = [];
	stage.on("message", (from: SessionInfo, message: Message) => questions.push({ from, message }));
	const originalSenderId = sender.sessionId;
	assert.ok(originalSenderId);
	const messageId = "cross-group-reconnect-question";
	const senderSocket = (sender as unknown as { socket: net.Socket }).socket;
	senderSocket.pause();
	const firstAttempt = sender.send(target, {
		text: "answer after I reconnect",
		expectsReply: true,
		messageId,
	});
	await waitUntil(() => questions.length === 1, "the workflow stage receives the accepted question");
	senderSocket.destroy();
	await assert.rejects(firstAttempt, /Client disconnected/);
	await waitForSessionDeparture(owner, originalSenderId);

	await sender.connect({ ...session, name: "workflow-sender", group: "default" });
	await sender.joinGroup(invocationGroup);
	const reconnectedSenderId = sender.sessionId;
	assert.ok(reconnectedSenderId);
	assert.notEqual(reconnectedSenderId, originalSenderId);
	const retry = await sender.send(target, {
		text: "answer after I reconnect",
		expectsReply: true,
		messageId,
	});
	assert.deepEqual(retry, { id: messageId, delivered: true });
	assert.equal(routeValidations, 1, "the deduplicated retry must not redeliver or reroute the question");
	assert.equal(questions.length, 1);

	const replies: Message[] = [];
	sender.on("message", (_from: SessionInfo, message: Message) => replies.push(message));
	const reply = await stage.send(reconnectedSenderId, {
		text: "correlated cross-group answer",
		replyTo: messageId,
	});
	assert.equal(reply.delivered, true, reply.reason);
	await waitUntil(() => replies.length === 1, "the rebound route delivers the correlated reply");
	assert.equal(replies[0]?.replyTo, messageId);
});

test("an ask retry reuses its real-broker question after disconnecting during the reply wait", async () => {
	const questions: Array<{ from: SessionInfo; message: Message }> = [];
	const recipient = await createClient("recipient");
	recipient.on("message", (from: SessionInfo, message: Message) => questions.push({ from, message }));
	const sender = await createClient("sender");
	const tool = registerTool(sender);
	const brokerResults: SendResult[] = [];
	const send = sender.send.bind(sender);
	sender.send = async (...args: Parameters<Client["send"]>) => {
		const result = await send(...args);
		brokerResults.push(result);
		return result;
	};

	const firstExecution = tool.execute(
		"first-ask",
		{ action: "ask", to: "recipient", message: "one accepted question" },
		undefined,
		undefined,
		context,
	);
	await waitUntil(
		() => questions.length === 1 && brokerResults.length === 1,
		"the broker accepts the question and the tool enters its reply wait",
	);
	(sender as unknown as { socket: net.Socket }).socket.destroy();
	const first = await firstExecution;
	assert.equal(first.isError, true);
	assert.match(first.content[0]?.text ?? "", /Client disconnected/);

	const originalQuestion = questions[0]?.message;
	assert.ok(originalQuestion);
	const retryExecution = tool.execute(
		"retry-ask",
		{ action: "ask", to: "recipient", message: "one accepted question" },
		undefined,
		undefined,
		context,
	);
	await waitUntil(() => brokerResults.length === 2, "the reconnected ask receives its retained acknowledgement");
	assert.equal(questions.length, 1, "the recipient must not receive the accepted question twice");
	assert.deepEqual(
		brokerResults.map(({ id, delivered }) => ({ id, delivered })),
		[
			{ id: originalQuestion.id, delivered: true },
			{ id: originalQuestion.id, delivered: true },
		],
	);

	const reply = await recipient.send("sender", {
		text: "reply after sender re-registration",
		replyTo: originalQuestion.id,
	});
	assert.equal(reply.delivered, true);
	const retried = await retryExecution;
	assert.equal(retried.isError, false);
	assert.match(retried.content[0]?.text ?? "", /reply after sender re-registration/);

	const intentionalExecution = tool.execute(
		"intentional-ask",
		{ action: "ask", to: "recipient", message: "one accepted question" },
		undefined,
		undefined,
		context,
	);
	await waitUntil(
		() => questions.length === 2 && brokerResults.length === 3,
		"a settled ask releases its identity for an intentional repeat",
	);
	const intentionalQuestion = questions[1]?.message;
	assert.ok(intentionalQuestion);
	assert.notEqual(intentionalQuestion.id, originalQuestion.id);
	const intentionalReply = await recipient.send("sender", {
		text: "reply to intentional repeat",
		replyTo: intentionalQuestion.id,
	});
	assert.equal(intentionalReply.delivered, true);
	const intentional = await intentionalExecution;
	assert.equal(intentional.isError, false);
});
