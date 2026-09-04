import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import type { SendOptions, SendResult } from "../../packages/intercom/broker/client.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { Attachment, Message, SessionInfo } from "../../packages/intercom/types.js";

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
		params: { action: string; to?: string; message?: string; attachments?: Attachment[]; replyTo?: string },
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

function attachmentsInDeclaredOrder(): Attachment[] {
	return [
		{ type: "snippet", name: "proof", content: "raw payload", language: "ts" },
		{ type: "context", name: "support", content: "second" },
	];
}

function attachmentsInReorderedMemberOrder(): Attachment[] {
	return [
		{ language: "ts", content: "raw payload", name: "proof", type: "snippet" },
		{ content: "second", name: "support", type: "context" },
	];
}

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

function registerTool(
	sender: Client,
	options: { readonly connectionName?: string; readonly replyTracker?: ReplyTracker } = {},
): Tool {
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
				if (!sender.isConnected()) await connect(sender, options.connectionName ?? "sender");
				return sender;
			},
			syncPresenceIdentity() {},
			resolveSessionTarget: async (_activeClient: Client, target: string) => {
				const exact = liveClients.find((candidate) => candidate.isConnected() && candidate.sessionId === target);
				if (exact !== undefined) return exact.sessionId;
				if (target.toLowerCase() !== "recipient") return null;
				return liveClients.find((candidate) => candidate !== sender && candidate.isConnected())?.sessionId ?? null;
			},
			homeGroup: () => "default",
			setJoinedGroups() {},
			clearJoinedGroups() {},
			confirmSend: false,
			beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) => waiters.begin(from, replyTo, signal),
			replyTracker: options.replyTracker ?? new ReplyTracker(),
		} as never,
	);
	assert.ok(tool);
	return tool;
}

const context = { sessionManager: { getSessionId: () => "host-session" }, hasUI: false };

async function startBroker(): Promise<void> {
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: "ignore",
	});
	await waitForBroker();
}

async function stopBroker(signal: NodeJS.Signals): Promise<void> {
	const running = broker;
	if (running === undefined || running.exitCode !== null) return;
	await new Promise<void>((resolveExit) => {
		running.once("exit", () => resolveExit());
		running.kill(signal);
	});
}

beforeAll(startBroker);

afterEach(async () => {
	for (const client of liveClients.splice(0)) {
		try {
			await client.disconnect();
		} catch {
			// Acknowledgement loss intentionally destroys the sender connection.
		}
	}
	if (broker === undefined || broker.exitCode !== null) await startBroker();
});

afterAll(async () => {
	await stopBroker("SIGTERM");
	if (originalAtomicAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAtomicAgentDir;
	if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

test("a send retry with reordered attachment members keeps its broker-accepted ID and one raw delivery", async () => {
	const received: Message[] = [];
	const recipient = await createClient("recipient");
	recipient.on("message", (_from: SessionInfo, message: Message) => received.push(message));
	const sender = await createClient("sender");
	const firstSenderId = sender.sessionId;
	assert.ok(firstSenderId);
	const tool = registerTool(sender);
	const firstAttachments = attachmentsInDeclaredOrder();
	const retryAttachments = attachmentsInReorderedMemberOrder();
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
		{ action: "send", to: "recipient", message: "one logical operation", attachments: firstAttachments },
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
		{ action: "send", to: "recipient", message: "one logical operation", attachments: retryAttachments },
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
	assert.deepEqual(Object.keys(received[0]?.content.attachments?.[0] ?? {}), ["type", "name", "content", "language"]);
	assert.deepEqual(Object.keys(firstAttachments[0] ?? {}), ["type", "name", "content", "language"]);
	assert.deepEqual(Object.keys(retryAttachments[0] ?? {}), ["language", "content", "name", "type"]);
});

test("a reply retry with reordered attachment members keeps its broker-accepted ID and correlation", async () => {
	const replies: Message[] = [];
	const asker = await createClient("asker");
	asker.on("message", (_from: SessionInfo, message: Message) => replies.push(message));
	const replyTracker = new ReplyTracker();
	const questions: Array<{ from: SessionInfo; message: Message }> = [];
	const replier = await createClient("recipient");
	replier.on("message", (from: SessionInfo, message: Message) => {
		questions.push({ from, message });
		replyTracker.recordIncomingMessage(from, message);
	});
	const questionResult = await asker.send("recipient", {
		text: "question awaiting one durable reply",
		expectsReply: true,
	});
	assert.equal(questionResult.delivered, true, questionResult.reason);
	await waitUntil(() => questions.length === 1, "the replier records the pending question");
	const question = questions[0]?.message;
	assert.ok(question);

	const tool = registerTool(replier, { connectionName: "recipient", replyTracker });
	const firstAttachments = attachmentsInDeclaredOrder();
	const retryAttachments = attachmentsInReorderedMemberOrder();
	const attempts: SendOptions[] = [];
	const firstReplierId = replier.sessionId;
	const socket = (replier as unknown as { socket: net.Socket }).socket;
	const send = replier.send.bind(replier);
	let loseFirstAcknowledgement = true;
	replier.send = async (...args: Parameters<Client["send"]>) => {
		attempts.push(args[1]);
		if (loseFirstAcknowledgement) {
			loseFirstAcknowledgement = false;
			socket.pause();
		}
		return send(...args);
	};
	const firstExecution = tool.execute(
		"first-reply",
		{
			action: "reply",
			message: "one correlated answer",
			attachments: firstAttachments,
			replyTo: question.id,
		},
		undefined,
		undefined,
		context,
	);
	await waitUntil(() => replies.length === 1, "the broker forwards the accepted reply");
	socket.destroy();
	const first = await firstExecution;
	assert.equal(first.isError, true);
	assert.match(first.content[0]?.text ?? "", /Client disconnected/);
	assert.equal(replyTracker.listPending().length, 1, "acknowledgement loss keeps the question replyable");

	const retry = await tool.execute(
		"retry-reply",
		{
			action: "reply",
			message: "one correlated answer",
			attachments: retryAttachments,
			replyTo: question.id,
		},
		undefined,
		undefined,
		context,
	);

	assert.equal(retry.isError, false, retry.content[0]?.text);
	assert.notEqual(replier.sessionId, firstReplierId);
	assert.deepEqual(
		attempts.map(({ messageId }) => messageId),
		[replies[0]?.id, replies[0]?.id],
		"the retried reply retains the broker-accepted identity",
	);
	assert.equal(replies.length, 1, "the asker observes one correlated reply");
	assert.equal(replies[0]?.replyTo, question.id);
	assert.deepEqual(Object.keys(replies[0]?.content.attachments?.[0] ?? {}), ["type", "name", "content", "language"]);
	assert.deepEqual(Object.keys(retryAttachments[0] ?? {}), ["language", "content", "name", "type"]);
	assert.deepEqual(replyTracker.listPending(), [], "the retained acknowledgement settles the exact pending ask");
});

test("a name-addressed tool retry keeps one identity and delivery after the recipient reconnects", async () => {
	const received: Message[] = [];
	const recipient = await createClient("recipient");
	recipient.on("message", (_from: SessionInfo, message: Message) => received.push(message));
	const originalRecipientId = recipient.sessionId;
	assert.ok(originalRecipientId);
	const sender = await createClient("sender");
	const tool = registerTool(sender);
	const socket = (sender as unknown as { socket: net.Socket }).socket;
	socket.pause();
	const firstExecution = tool.execute(
		"first-recipient-generation",
		{ action: "send", to: "recipient", message: "stable raw target" },
		undefined,
		undefined,
		context,
	);
	await waitUntil(() => received.length === 1, "the first recipient generation receives the operation");
	socket.destroy();
	assert.equal((await firstExecution).isError, true);
	await recipient.disconnect();
	await connect(recipient, "recipient");
	assert.notEqual(recipient.sessionId, originalRecipientId);

	const retry = await tool.execute(
		"retry-recipient-generation",
		{ action: "send", to: "recipient", message: "stable raw target" },
		undefined,
		undefined,
		context,
	);
	assert.equal(retry.isError, false, retry.content[0]?.text);
	assert.equal(retry.details?.messageId, received[0]?.id);
	assert.equal(received.length, 1, "recipient churn must not produce a second logical delivery");
});

test("a raw name and its exact resolved ID remain distinct intentional tool calls", async () => {
	const received: Message[] = [];
	const recipient = await createClient("recipient");
	recipient.on("message", (_from: SessionInfo, message: Message) => received.push(message));
	const recipientId = recipient.sessionId;
	assert.ok(recipientId);
	const sender = await createClient("sender");
	const tool = registerTool(sender);
	const socket = (sender as unknown as { socket: net.Socket }).socket;
	socket.pause();
	const firstExecution = tool.execute(
		"name-call",
		{ action: "send", to: "recipient", message: "same payload" },
		undefined,
		undefined,
		context,
	);
	await waitUntil(() => received.length === 1, "the name-addressed operation is accepted");
	socket.destroy();
	assert.equal((await firstExecution).isError, true);

	const exactCall = await tool.execute(
		"exact-id-call",
		{ action: "send", to: recipientId, message: "same payload" },
		undefined,
		undefined,
		context,
	);
	assert.equal(exactCall.isError, false, exactCall.content[0]?.text);
	assert.equal(received.length, 2, "the caller's distinct exact-ID operation must be delivered");
	assert.notEqual(received[1]?.id, received[0]?.id);

	const nameRetry = await tool.execute(
		"name-retry",
		{ action: "send", to: "recipient", message: "same payload" },
		undefined,
		undefined,
		context,
	);
	assert.equal(nameRetry.isError, false, nameRetry.content[0]?.text);
	assert.equal(nameRetry.details?.messageId, received[0]?.id);
	assert.equal(received.length, 2);
});

test("an accepted ask retry with reordered attachment members survives broker replacement and remains replyable", async () => {
	const tracker = new ReplyTracker();
	const questions: Array<{ from: SessionInfo; message: Message }> = [];
	const recipient = await createClient("recipient");
	recipient.on("message", (from: SessionInfo, incoming: Message) => {
		questions.push({ from, message: incoming });
		tracker.recordIncomingMessage(from, incoming);
	});
	const originalRecipientId = recipient.sessionId;
	assert.ok(originalRecipientId);
	const sender = await createClient("sender");
	const senderTool = registerTool(sender);
	const recipientTool = registerTool(recipient, { connectionName: "recipient", replyTracker: tracker });
	const senderSocket = (sender as unknown as { socket: net.Socket }).socket;
	const rawSend = sender.send.bind(sender);
	const successfulSends: SendResult[] = [];
	let loseFirstAcknowledgement = true;
	sender.send = async (...args: Parameters<Client["send"]>) => {
		if (loseFirstAcknowledgement) {
			loseFirstAcknowledgement = false;
			senderSocket.pause();
		}
		const result = await rawSend(...args);
		successfulSends.push(result);
		return result;
	};
	const firstAttachments = attachmentsInDeclaredOrder();
	const retryAttachments = attachmentsInReorderedMemberOrder();
	const firstParams = {
		action: "ask",
		to: "recipient",
		message: "survive broker replacement",
		attachments: firstAttachments,
	};
	const retryParams = {
		action: "ask",
		to: "recipient",
		message: "survive broker replacement",
		attachments: retryAttachments,
	};
	const firstAttempt = senderTool.execute("before-broker-crash", firstParams, undefined, undefined, context);
	await waitUntil(() => questions.length === 1, "the old broker forwards the accepted ask");
	const questionId = questions[0]?.message.id;
	assert.ok(questionId);
	await stopBroker("SIGKILL");
	senderSocket.destroy();
	const first = await firstAttempt;
	assert.equal(first.isError, true);
	assert.match(first.content[0]?.text ?? "", /Client disconnected/);
	await waitUntil(
		() => !recipient.isConnected() && !sender.isConnected(),
		"clients observe the old broker process exit",
	);
	await startBroker();
	await connect(recipient, "recipient");
	assert.notEqual(recipient.sessionId, originalRecipientId);

	const retryController = new AbortController();
	const retry = senderTool.execute("after-broker-restart", retryParams, retryController.signal, undefined, context);
	await waitUntil(() => successfulSends.length === 1, "the replacement broker proves the accepted ask");
	if (questions.length !== 1) retryController.abort();
	assert.equal(successfulSends[0]?.id, questionId);
	assert.equal(questions.length, 1, "replacement broker authority suppresses a duplicate delivery");
	assert.deepEqual(Object.keys(questions[0]?.message.content.attachments?.[0] ?? {}), [
		"type",
		"name",
		"content",
		"language",
	]);
	assert.deepEqual(Object.keys(retryAttachments[0] ?? {}), ["language", "content", "name", "type"]);
	const reply = await recipientTool.execute(
		"reply-after-broker-restart",
		{ action: "reply", message: "durable answer" },
		undefined,
		undefined,
		context,
	);
	if (reply.isError) retryController.abort();
	assert.equal(reply.isError, false, reply.content[0]?.text);
	assert.deepEqual(tracker.listPending(), []);
	const result = await retry;
	assert.equal(result.isError, false, result.content[0]?.text);
	assert.match(result.content[0]?.text ?? "", /durable answer/);
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

test("a public reply reaches a retried cross-group ask after the asker reconnects", async () => {
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
	owner.registerPendingStageRoute(runId, invocationGroup, capability, [
		{
			stageId: "reviewer",
			stageName: "reviewer",
			target,
			lifecycle: "running",
			routeEligible: true,
			group: stageGroup,
		},
	]);
	await owner.listSessions();
	await stage.registerLiveWorkflowStageRoute(runId, ["reviewer"], capability);

	let routeValidations = 0;
	owner.on("pending_stage_message", (request) => {
		routeValidations += 1;
		owner.respondPendingStageMessage(request.requestId, { outcome: "forward", target });
	});
	const recipientTracker = new ReplyTracker();
	const questions: Array<{ from: SessionInfo; message: Message }> = [];
	stage.on("message", (from: SessionInfo, incoming: Message) => {
		questions.push({ from, message: incoming });
		recipientTracker.recordIncomingMessage(from, incoming);
	});
	const senderTool = registerTool(sender, { connectionName: "workflow-sender" });
	const recipientTool = registerTool(stage, {
		connectionName: "workflow-reviewer",
		replyTracker: recipientTracker,
	});
	const originalSenderId = sender.sessionId;
	assert.ok(originalSenderId);
	const senderSocket = (sender as unknown as { socket: net.Socket }).socket;
	const rawSend = sender.send.bind(sender);
	const successfulSends: SendResult[] = [];
	let loseFirstAcknowledgement = true;
	sender.send = async (...args: Parameters<Client["send"]>) => {
		if (loseFirstAcknowledgement) {
			loseFirstAcknowledgement = false;
			senderSocket.pause();
		}
		const result = await rawSend(...args);
		successfulSends.push(result);
		return result;
	};
	const params = { action: "ask", to: target, message: "answer after I reconnect" };
	const firstAttempt = senderTool.execute("first-public-ask", params, undefined, undefined, context);
	await waitUntil(() => questions.length === 1, "the workflow stage receives the accepted public ask");
	const questionId = questions[0]?.message.id;
	assert.ok(questionId);
	senderSocket.destroy();
	const first = await firstAttempt;
	assert.equal(first.isError, true);
	assert.match(first.content[0]?.text ?? "", /Client disconnected/);
	await waitForSessionDeparture(owner, originalSenderId);

	await sender.connect({ ...session, name: "workflow-sender", group: "default" });
	await sender.joinGroup(invocationGroup);
	assert.notEqual(sender.sessionId, originalSenderId);
	const retryController = new AbortController();
	const retry = senderTool.execute("retry-public-ask", params, retryController.signal, undefined, context);
	await waitUntil(() => successfulSends.length === 1, "the retried ask receives its retained acknowledgement");
	assert.equal(successfulSends[0]?.id, questionId);
	assert.equal(routeValidations, 1, "deduplication must not reroute the accepted question");
	assert.equal(questions.length, 1, "the recipient sees exactly one question");
	const imposter = await createClient("workflow-sender");
	const imposterId = imposter.sessionId;
	assert.ok(imposterId);
	const ambiguousReply = await recipientTool.execute(
		"ambiguous-public-reply",
		{ action: "reply", message: "must not reach an ambiguous sender" },
		undefined,
		undefined,
		context,
	);
	assert.equal(ambiguousReply.isError, true);
	assert.match(ambiguousReply.content[0]?.text ?? "", /Multiple sessions named/);
	assert.equal(recipientTracker.listPending().length, 1, "an ambiguous name must not consume the reply route");
	await imposter.disconnect();
	await waitForSessionDeparture(sender, imposterId);

	const publicReply = await recipientTool.execute(
		"public-reply",
		{ action: "reply", message: "correlated cross-group answer" },
		undefined,
		undefined,
		context,
	);
	if (publicReply.isError) retryController.abort();
	assert.equal(publicReply.isError, false, publicReply.content[0]?.text);
	assert.deepEqual(recipientTracker.listPending(), [], "the public reply marks the exact pending ask as replied");
	const retried = await retry;
	assert.equal(retried.isError, false, retried.content[0]?.text);
	assert.match(retried.content[0]?.text ?? "", /correlated cross-group answer/);
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
