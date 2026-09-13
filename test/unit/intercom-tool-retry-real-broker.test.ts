import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
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
		params: {
			action: string;
			to?: string;
			message?: string;
			attachments?: Attachment[];
			replyTo?: string;
		},
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

function assertNoRetryToken(result: ToolResult): void {
	assert.doesNotMatch(JSON.stringify(result), /retryToken/);
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
	options: {
		readonly connectionName?: string;
		readonly replyTracker?: ReplyTracker;
		readonly beforeReconnect?: () => Promise<void>;
	} = {},
): Tool {
	let tool: Tool | undefined;
	const waiters = new ReplyWaiterRegistry();
	// Match the runtime's single-flight reconnect admission for concurrent tool calls.
	let reconnecting: Promise<void> | undefined;
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
				if (!sender.isConnected()) {
					reconnecting ??= (async () => {
						await options.beforeReconnect?.();
						if (!sender.isConnected()) await connect(sender, options.connectionName ?? "sender");
					})().finally(() => {
						reconnecting = undefined;
					});
					await reconnecting;
				}
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

for (const activeAsk of [false, true]) {
	for (const useName of [false, true]) {
		test(`explicit reply ${useName ? "name" : "ID"} settles the requested ask beside an active ${activeAsk ? "ask" : "send"}`, async () => {
			const recipient = await createClient("recipient");
			const unrelated = await createClient("unrelated");
			const asker = await createClient("questioner");
			const tracker = new ReplyTracker();
			const incoming: Message[] = [];
			recipient.on("message", (from: SessionInfo, message: Message) => {
				const incomingContext = tracker.recordIncomingMessage(from, message);
				tracker.queueTurnContext(incomingContext);
				incoming.push(message);
			});
			const recipientTool = registerTool(recipient, { replyTracker: tracker });
			const askerTool = registerTool(asker);
			await unrelated.send(recipient.sessionId!, { text: "active unrelated context", expectsReply: activeAsk });
			await waitUntil(() => incoming.length === 1, "ordinary context delivery");
			tracker.beginTurn();
			const cancellation = new AbortController();
			let answer: ToolResult | undefined;
			const asking = askerTool
				.execute(
					"question",
					{ action: "ask", to: recipient.sessionId!, message: "answer me" },
					cancellation.signal,
					undefined,
					context,
				)
				.then((result) => {
					answer = result;
					return result;
				});
			try {
				await waitUntil(() => incoming.length === 2, "pending question delivery");
				const replies: Message[] = [];
				asker.on("message", (_from: SessionInfo, message: Message) => replies.push(message));
				const result = await recipientTool.execute(
					"answer",
					{ action: "reply", to: useName ? "questioner" : asker.sessionId!, message: "correct answer" },
					undefined,
					undefined,
					context,
				);
				assert.equal(result.isError, false, JSON.stringify(result));
				await waitUntil(() => replies.length === 1, "reply delivery");
				assert.equal(replies[0]!.replyTo, incoming[1]!.id);
				await waitUntil(() => answer !== undefined, "original ask completion");
				assert.equal(answer!.isError, false);
				assert.match(answer!.content[0]!.text, /correct answer/);
				assert.deepEqual(
					tracker.listPending().map((pending) => pending.message.id),
					activeAsk ? [incoming[0]!.id] : [],
				);
			} finally {
				cancellation.abort();
				await asking;
			}
		});
	}
}

for (const hidden of [false, true]) {
	for (const collision of ["exact ID", "duplicate name"]) {
		test(`explicit replies reject a ${hidden ? "hidden-group" : "visible"} ${collision} collision instead of delivering to a pending namesake`, async () => {
			const recipient = await createClient("recipient");
			const selected = await createClient("duplicate");
			if (hidden) {
				await selected.joinGroup("hidden-collision-group");
				await selected.leaveGroup("default");
			}
			const selector = collision === "exact ID" ? selected.sessionId! : "duplicate";
			const namesake = await createClient(selector);
			const tracker = new ReplyTracker();
			recipient.on("message", (from: SessionInfo, message: Message) => tracker.recordIncomingMessage(from, message));
			await namesake.send(recipient.sessionId!, { text: "pending namesake question", expectsReply: true });
			await waitUntil(() => tracker.listPending().length === 1, "namesake question");
			const questionId = tracker.listPending()[0]!.message.id;
			const tool = registerTool(recipient, { replyTracker: tracker });
			const delivered: Message[] = [];
			for (const client of [selected, namesake])
				client.on("message", (_from: SessionInfo, message: Message) => delivered.push(message));
			for (const replyTo of [undefined, questionId]) {
				const result = await tool.execute(
					"reply-collision",
					{ action: "reply", to: selector, replyTo, message: "private answer" },
					undefined,
					undefined,
					context,
				);
				assert.equal(result.isError, true, JSON.stringify(result));
				assert.deepEqual(delivered, []);
				assert.equal(tracker.listPending()[0]!.message.id, questionId);
			}
		});
	}
}

for (const namesakeTarget of ["ID", "name"]) {
	test(`replyTo-only ordinary replies retain the exact recipient after sender departure beside a ${namesakeTarget} namesake`, async () => {
		const sender = await createClient("ordinary-sender");
		const recipient = await createClient("recipient");
		const tracker = new ReplyTracker();
		const incoming: Message[] = [];
		recipient.on("message", (from: SessionInfo, message: Message) => {
			incoming.push(message);
			tracker.queueTurnContext(tracker.recordIncomingMessage(from, message));
		});
		const tool = registerTool(recipient, { replyTracker: tracker });
		const replies: Message[] = [];
		sender.on("message", (_from: SessionInfo, message: Message) => replies.push(message));
		await sender.send(recipient.sessionId!, { text: "connected ordinary message" });
		await waitUntil(() => incoming.length === 1, "connected ordinary context");
		tracker.beginTurn();
		const connected = await tool.execute(
			"connected-reply",
			{
				action: "reply",
				replyTo: incoming[0]!.id,
				message: "connected answer",
			},
			undefined,
			undefined,
			context,
		);
		assert.equal(connected.isError, false);
		await waitUntil(() => replies.length === 1, "connected ordinary reply");
		assert.equal(replies[0]!.replyTo, incoming[0]!.id);
		assert.throws(() => tracker.resolveReplyTarget({ replyTo: incoming[0]!.id }));

		await sender.send(recipient.sessionId!, { text: "ordinary message before departure" });
		await waitUntil(() => incoming.length === 2, "departing sender context");
		tracker.beginTurn();
		const replyTo = incoming[1]!.id;
		const originalContext = tracker.resolveReplyTarget({ replyTo });
		const senderId = sender.sessionId!;
		sender.disconnect();
		await waitForSessionDeparture(recipient, senderId);
		const namesake = await createClient(namesakeTarget === "ID" ? senderId : "ordinary-sender");
		const misdeliveries: Message[] = [];
		namesake.on("message", (_from: SessionInfo, message: Message) => misdeliveries.push(message));
		const attempts: string[] = [];
		const send = recipient.send.bind(recipient);
		recipient.send = async (...args: Parameters<Client["send"]>) => {
			attempts.push(args[0]);
			return send(...args);
		};
		const result = await tool.execute(
			"departed-reply",
			{
				action: "reply",
				replyTo,
				message: "private answer",
			},
			undefined,
			undefined,
			context,
		);
		assert.equal(result.isError, true, JSON.stringify(result));
		assert.deepEqual(misdeliveries, []);
		assert.deepEqual(attempts, [senderId], "explicit thread selection never falls back to a sender name");
		assert.equal(tracker.resolveReplyTarget({ replyTo }), originalContext);
	});
}

test("one send invocation keeps its broker-accepted ID when reconnect transport reorders attachment members", async () => {
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
	let attempts = 0;
	sender.send = async (...args: Parameters<Client["send"]>) => {
		if (++attempts > 1) args[1] = { ...args[1], attachments: retryAttachments };
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
	const result = await firstExecution;
	assertNoRetryToken(result);
	const firstMessage = received[0];
	assert.ok(firstMessage);

	assert.notEqual(sender.sessionId, firstSenderId, "the real broker must assign a new id on re-registration");
	assert.deepEqual(result, {
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

for (const explicitTo of [true, false]) {
	test(`one ${explicitTo ? "to and replyTo" : "replyTo-only"} reply invocation keeps its broker-accepted ID and correlation when transport reorders attachment members`, async () => {
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
			if (attempts.length > 1) args[1] = { ...args[1], attachments: retryAttachments };
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
				...(explicitTo ? { to: asker.sessionId! } : {}),
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
		assert.equal(
			replyTracker.listPending().length,
			1,
			"acknowledgement loss keeps the question replyable during recovery",
		);
		const retry = await firstExecution;
		assertNoRetryToken(retry);

		assert.equal(retry.isError, false, retry.content[0]?.text);
		assert.notEqual(replier.sessionId, firstReplierId);
		assert.deepEqual(
			attempts.map(({ messageId }) => messageId),
			[replies[0]?.id, replies[0]?.id],
			"the retried reply retains the broker-accepted identity",
		);
		assert.deepEqual(
			attempts.map(({ expectedRecipientId }) => expectedRecipientId),
			[asker.sessionId, asker.sessionId],
		);
		assert.equal(replies.length, 1, "the asker observes one correlated reply");
		assert.equal(replies[0]?.replyTo, question.id);
		assert.deepEqual(Object.keys(replies[0]?.content.attachments?.[0] ?? {}), [
			"type",
			"name",
			"content",
			"language",
		]);
		assert.deepEqual(Object.keys(retryAttachments[0] ?? {}), ["language", "content", "name", "type"]);
		assert.deepEqual(replyTracker.listPending(), [], "the retained acknowledgement settles the exact pending ask");
	});
}

test("a name-addressed tool retry keeps one identity and delivery after the recipient reconnects", async () => {
	const received: Message[] = [];
	const recipient = await createClient("recipient");
	recipient.on("message", (_from: SessionInfo, message: Message) => received.push(message));
	const originalRecipientId = recipient.sessionId;
	assert.ok(originalRecipientId);
	const sender = await createClient("sender");
	const reconnectReady = Promise.withResolvers<void>();
	const tool = registerTool(sender, { beforeReconnect: () => reconnectReady.promise });
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
	try {
		await recipient.disconnect();
		await connect(recipient, "recipient");
		assert.notEqual(recipient.sessionId, originalRecipientId);
	} finally {
		reconnectReady.resolve();
	}
	const retry = await firstExecution;
	assertNoRetryToken(retry);
	assert.equal(retry.isError, false, retry.content[0]?.text);
	assert.equal(retry.details?.messageId, received[0]?.id);
	assert.equal(received.length, 1, "recipient churn must not produce a second logical delivery");
});

test("one send invocation keeps its ID through intermediate Session not found and broker dedupe", async () => {
	const received: Message[] = [];
	const recipient = await createClient("recipient");
	recipient.on("message", (_from: SessionInfo, message: Message) => received.push(message));
	const sender = await createClient("sender");
	const reconnectReady = Promise.withResolvers<void>();
	const tool = registerTool(sender, { beforeReconnect: () => reconnectReady.promise });
	const attemptedIds: Array<string | undefined> = [];
	const brokerResults: SendResult[] = [];
	const rawSend = sender.send.bind(sender);
	sender.send = async (...args: Parameters<Client["send"]>) => {
		attemptedIds.push(args[1].messageId);
		const result = await rawSend(...args);
		brokerResults.push(result);
		if (!result.delivered) await connect(recipient, "recipient");
		return result;
	};

	const socket = (sender as unknown as { socket: net.Socket }).socket;
	socket.pause();
	const firstExecution = tool.execute(
		"accepted-before-ack-loss",
		{ action: "send", to: "recipient", message: "one durable operation" },
		undefined,
		undefined,
		context,
	);
	await waitUntil(() => received.length === 1, "the raw operation is accepted once");
	socket.destroy();
	try {
		await recipient.disconnect();
	} finally {
		reconnectReady.resolve();
	}
	const settled = await firstExecution;
	assertNoRetryToken(settled);
	assert.equal(brokerResults[0]?.delivered, false);
	assert.match(brokerResults[0]?.reason ?? "", /Session not found/);
	assert.equal(brokerResults[1]?.delivered, true);
	assert.equal(settled.isError, false, settled.content[0]?.text);
	assert.deepEqual(attemptedIds, Array(3).fill(received[0]?.id), "all three wire attempts use identity A");
	assert.equal(received.length, 1, "the accepted operation has one raw delivery");
});

test("a raw name and its exact resolved ID remain distinct intentional tool calls", async () => {
	const received: Message[] = [];
	const recipient = await createClient("recipient");
	recipient.on("message", (_from: SessionInfo, message: Message) => received.push(message));
	const recipientId = recipient.sessionId;
	assert.ok(recipientId);
	const sender = await createClient("sender");
	const reconnectReady = Promise.withResolvers<void>();
	const reconnectStarted = Promise.withResolvers<void>();
	const tool = registerTool(sender, {
		beforeReconnect: async () => {
			reconnectStarted.resolve();
			await reconnectReady.promise;
		},
	});
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
	const disconnected = once(sender, "disconnected");
	socket.destroy();
	await disconnected;
	await reconnectStarted.promise;
	await connect(sender, "sender");
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

	reconnectReady.resolve();
	const nameRetry = await firstExecution;
	assertNoRetryToken(nameRetry);
	assert.equal(nameRetry.isError, false, nameRetry.content[0]?.text);
	assert.equal(nameRetry.details?.messageId, received[0]?.id);
	assert.equal(received.length, 2);
});

test("one accepted ask invocation survives reordered attachment members and broker replacement and remains replyable", async () => {
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
	const reconnectReady = Promise.withResolvers<void>();
	const senderTool = registerTool(sender, { beforeReconnect: () => reconnectReady.promise });
	const recipientTool = registerTool(recipient, { connectionName: "recipient", replyTracker: tracker });
	const senderSocket = (sender as unknown as { socket: net.Socket }).socket;
	const rawSend = sender.send.bind(sender);
	const successfulSends: SendResult[] = [];
	let loseFirstAcknowledgement = true;
	sender.send = async (...args: Parameters<Client["send"]>) => {
		if (loseFirstAcknowledgement) {
			loseFirstAcknowledgement = false;
			senderSocket.pause();
		} else args[1] = { ...args[1], attachments: retryAttachments };
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
	const retryController = new AbortController();
	const firstAttempt = senderTool.execute("single-ask", firstParams, retryController.signal, undefined, context);
	await waitUntil(() => questions.length === 1, "the old broker forwards the accepted ask");
	const questionId = questions[0]?.message.id;
	assert.ok(questionId);
	const senderDisconnected = once(sender, "disconnected");
	const recipientDisconnected = once(recipient, "disconnected");
	try {
		await stopBroker("SIGKILL");
		senderSocket.destroy();
		await Promise.all([senderDisconnected, recipientDisconnected]);
		await startBroker();
		await connect(recipient, "recipient");
		assert.notEqual(recipient.sessionId, originalRecipientId);
	} finally {
		reconnectReady.resolve();
	}
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
	const result = await firstAttempt;
	assertNoRetryToken(result);
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
	const attemptedIds: Array<string | undefined> = [];
	const send = sender.send.bind(sender);
	sender.send = async (...args: Parameters<Client["send"]>) => {
		attemptedIds.push(args[1].messageId);
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
	const results = await Promise.all([firstExecution, secondExecution]);
	for (const result of results) {
		assert.equal(result.isError, false, result.content[0]?.text);
		assertNoRetryToken(result);
	}
	const acceptedIds = received.map((message) => message.id);
	assert.equal(new Set(acceptedIds).size, 2);

	assert.deepEqual(
		results.map((result) => result.details?.messageId),
		acceptedIds,
		"each concurrent invocation must retain its own accepted identity",
	);
	for (const id of acceptedIds) assert.equal(attemptedIds.filter((attempt) => attempt === id).length, 2);
	assert.deepEqual(
		brokerResults.map(({ id, delivered }) => ({ id, delivered })).sort((a, b) => a.id.localeCompare(b.id)),
		acceptedIds.map((id) => ({ id, delivered: true })).sort((a, b) => a.id.localeCompare(b.id)),
		"both internal retries receive their retained broker receipts",
	);
	assert.equal(received.length, 2, "two accepted operations must never become three recipient deliveries");
});

test("an implicit public reply prefers the exact live sender ID when a duplicate name is connected", async () => {
	const exactReplies: Message[] = [];
	const imposterReplies: Message[] = [];
	const exactSender = await createClient("duplicate-sender");
	exactSender.on("message", (_from: SessionInfo, message: Message) => exactReplies.push(message));
	const replyTracker = new ReplyTracker();
	const questions: Array<{ from: SessionInfo; message: Message }> = [];
	const replier = await createClient("reply-worker");
	replier.on("message", (from: SessionInfo, message: Message) => {
		questions.push({ from, message });
		replyTracker.recordIncomingMessage(from, message);
	});
	const question = await exactSender.send("reply-worker", { text: "which exact sender?", expectsReply: true });
	assert.equal(question.delivered, true, question.reason);
	await waitUntil(() => questions.length === 1, "the exact sender's question is recorded");
	const duplicate = await createClient("duplicate-sender");
	duplicate.on("message", (_from: SessionInfo, message: Message) => imposterReplies.push(message));

	const tool = registerTool(replier, { connectionName: "reply-worker", replyTracker });
	const reply = await tool.execute(
		"exact-live-reply",
		{ action: "reply", message: "only the recorded live sender receives this" },
		undefined,
		undefined,
		context,
	);
	assert.equal(reply.isError, false, reply.content[0]?.text);
	await waitUntil(() => exactReplies.length === 1, "the exact recorded sender receives the reply");
	assert.equal(imposterReplies.length, 0);
	assert.equal(exactReplies[0]?.replyTo, questions[0]?.message.id);
});

test("an accepted implicit reply retry stays bound to its original ask after a new ask arrives", async () => {
	const originalReplies: Message[] = [];
	const newReplies: Message[] = [];
	const originalAsker = await createClient("original-asker");
	originalAsker.on("message", (_from: SessionInfo, message: Message) => originalReplies.push(message));
	const newAsker = await createClient("new-asker");
	newAsker.on("message", (_from: SessionInfo, message: Message) => newReplies.push(message));
	const replyTracker = new ReplyTracker();
	const questions: Array<{ from: SessionInfo; message: Message }> = [];
	const replier = await createClient("reply-worker");
	replier.on("message", (from: SessionInfo, message: Message) => {
		questions.push({ from, message });
		replyTracker.recordIncomingMessage(from, message);
	});

	const originalQuestion = await originalAsker.send("reply-worker", {
		text: "original question",
		expectsReply: true,
	});
	assert.equal(originalQuestion.delivered, true, originalQuestion.reason);
	await waitUntil(() => questions.length === 1, "the original implicit reply route is recorded");
	const originalQuestionId = questions[0]?.message.id;
	assert.ok(originalQuestionId);

	const reconnectReady = Promise.withResolvers<void>();
	const reconnectStarted = Promise.withResolvers<void>();
	const tool = registerTool(replier, {
		connectionName: "reply-worker",
		replyTracker,
		beforeReconnect: async () => {
			reconnectStarted.resolve();
			await reconnectReady.promise;
		},
	});
	const attempts: SendOptions[] = [];
	const rawSend = replier.send.bind(replier);
	const firstSocket = (replier as unknown as { socket: net.Socket }).socket;
	let loseFirstAcknowledgement = true;
	replier.send = async (...args: Parameters<Client["send"]>) => {
		attempts.push(args[1]);
		if (loseFirstAcknowledgement) {
			loseFirstAcknowledgement = false;
			firstSocket.pause();
		}
		return rawSend(...args);
	};
	const firstExecution = tool.execute(
		"implicit-reply-before-ack-loss",
		{ action: "reply", message: "answer only the original" },
		undefined,
		undefined,
		context,
	);
	await waitUntil(() => originalReplies.length === 1, "the broker accepts the original implicit reply");
	const disconnected = once(replier, "disconnected");
	firstSocket.destroy();
	await disconnected;
	await reconnectStarted.promise;

	await connect(replier, "reply-worker");
	const secondQuestion = await newAsker.send("reply-worker", {
		text: "new ambient question",
		expectsReply: true,
	});
	assert.equal(secondQuestion.delivered, true, secondQuestion.reason);
	await waitUntil(() => questions.length === 2, "the new ambient ask is recorded before retry");
	const newQuestionId = questions[1]?.message.id;
	assert.ok(newQuestionId);
	assert.equal(attempts.length, 1, "recovery stays gated while the ambient reply route changes");
	assert.deepEqual(
		replyTracker.listPending().map(({ message }) => message.id),
		[originalQuestionId, newQuestionId],
	);

	reconnectReady.resolve();
	const retry = await firstExecution;
	assertNoRetryToken(retry);
	assert.equal(retry.isError, false, retry.content[0]?.text);
	assert.deepEqual(
		attempts.map(({ messageId, replyTo }) => ({ messageId, replyTo })),
		[
			{ messageId: originalReplies[0]?.id, replyTo: originalQuestionId },
			{ messageId: originalReplies[0]?.id, replyTo: originalQuestionId },
		],
		"the retry uses the original message identity and correlation snapshot",
	);
	assert.equal(originalReplies.length, 1, "durable broker authority suppresses duplicate delivery");
	assert.equal(newReplies.length, 0, "the ambient ask cannot steal the retry");
	assert.deepEqual(
		replyTracker.listPending().map(({ message }) => message.id),
		[newQuestionId],
		"only the original question settles after the retained acknowledgement",
	);
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
	const reconnectReady = Promise.withResolvers<void>();
	const reconnectStarted = Promise.withResolvers<void>();
	const senderTool = registerTool(sender, {
		connectionName: "workflow-sender",
		beforeReconnect: async () => {
			reconnectStarted.resolve();
			await reconnectReady.promise;
		},
	});
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
	const retryController = new AbortController();
	const firstAttempt = senderTool.execute("single-public-ask", params, retryController.signal, undefined, context);
	await waitUntil(() => questions.length === 1, "the workflow stage receives the accepted public ask");
	const questionId = questions[0]?.message.id;
	assert.ok(questionId);
	const disconnected = once(sender, "disconnected");
	senderSocket.destroy();
	await disconnected;
	await reconnectStarted.promise;
	await waitForSessionDeparture(owner, originalSenderId);

	await sender.connect({ ...session, name: "workflow-sender", group: "default" });
	await sender.joinGroup(invocationGroup);
	assert.notEqual(sender.sessionId, originalSenderId);
	reconnectReady.resolve();
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
	// An explicit departed ID must not silently fall back to a namesake after reconnect.
	const departedReply = await recipientTool.execute(
		"departed-explicit-reply",
		{ action: "reply", to: originalSenderId, message: "must not redirect" },
		undefined,
		undefined,
		context,
	);
	assert.equal(departedReply.isError, true);
	assert.equal(recipientTracker.listPending().length, 1);

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
	const retried = await firstAttempt;
	assertNoRetryToken(retried);
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
	const originalQuestion = questions[0]?.message;
	assert.ok(originalQuestion);
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
	const retried = await firstExecution;
	assertNoRetryToken(retried);
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
