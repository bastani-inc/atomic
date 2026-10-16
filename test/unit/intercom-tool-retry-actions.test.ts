import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { SendOptions, SendResult } from "../../packages/intercom/broker/client.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { IntercomClientDisconnectedError } from "../../packages/intercom/recoverable-disconnect.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import { ASK_REPLY_TIMEOUT_MS, RETRY_IDENTITY_TTL_MS } from "../../packages/intercom/retry-policy.js";
import type { Attachment, Message, SessionInfo } from "../../packages/intercom/types.js";

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
			retryToken?: string;
		},
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: object,
	): Promise<ToolResult>;
};

const peer: SessionInfo = {
	id: "peer-id",
	name: "peer",
	cwd: "/tmp",
	model: "test",
	pid: 2,
	startedAt: 1,
	lastActivity: 1,
};
const question: Message = {
	id: "incoming-question",
	timestamp: 1,
	expectsReply: true,
	content: { text: "question" },
};

// Vitest's fake clock does not replace node:timers/promises. Keep the real
// delay/abort contract, but schedule it on the fake global timer in mock-client tests.
vi.mock("node:timers/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:timers/promises")>()),
	setTimeout: (ms: number, value: unknown, options?: { signal?: AbortSignal }) =>
		new Promise((resolve, reject) => {
			const signal = options?.signal;
			if (signal?.aborted) return reject(signal.reason);
			const onAbort = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				reject(signal?.reason);
			};
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			}, ms);
			signal?.addEventListener("abort", onAbort, { once: true });
		}),
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function assertNoRetryToken(result: ToolResult): void {
	assert.doesNotMatch(JSON.stringify(result), /retryToken/);
	assert.equal(result.details?.retryable, undefined, "internal recovery metadata stays private");
}

const context = { sessionManager: { getSessionId: () => "host-session" }, hasUI: false };

function fixture(firstFailure?: Error, secondFailure?: Error, maxEntries?: number) {
	let tool: Tool | undefined;
	const sent: SendOptions[] = [];
	let resolverCalls = 0;
	let connectionCalls = 0;
	const replyTracker = new ReplyTracker();
	replyTracker.recordIncomingMessage(peer, question);
	const waiters = new ReplyWaiterRegistry();
	const client = {
		sessionId: "self-id",
		groups: ["default"],
		async listSessions() {
			return [peer];
		},
		async send(_target: string, options: SendOptions): Promise<SendResult> {
			sent.push(options);
			if (sent.length === 1 && firstFailure !== undefined) throw firstFailure;
			if (sent.length === 2 && secondFailure !== undefined) throw secondFailure;
			return { id: options.messageId ?? "missing", delivered: false, reason: "test settled failure" };
		},
	};
	registerIntercomTool(
		{
			registerTool(value: Tool) {
				tool = value;
			},
			async appendEntry() {},
		} as never,
		{
			ensureConnected: async () => {
				connectionCalls += 1;
				return client;
			},
			syncPresenceIdentity() {},
			resolveSessionTarget: async () => {
				resolverCalls += 1;
				return peer.id;
			},
			homeGroup: () => "default",
			setJoinedGroups() {},
			clearJoinedGroups() {},
			confirmSend: false,
			beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) => waiters.begin(from, replyTo, signal),
			replyTracker,
			retryIdentityMaxEntries: maxEntries,
		} as never,
	);
	assert.ok(tool);
	return { tool, client, sent, waiters, resolverCalls: () => resolverCalls, connectionCalls: () => connectionCalls };
}

for (const action of ["send", "ask", "reply"] as const) {
	test(`${action} internally retains one identity through intermediate resolved nondelivery and stops after three retries`, async () => {
		const { tool, sent } = fixture(new IntercomClientDisconnectedError());
		const params =
			action === "reply"
				? { action, message: "same operation", replyTo: question.id }
				: { action, to: peer.name, message: "same operation" };
		const execution = tool.execute("single-invocation", params, undefined, undefined, context);
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(sent.length, 1);
		await vi.advanceTimersByTimeAsync(999);
		assert.equal(sent.length, 1, "recovery must back off before retrying");
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(sent.length, 2);
		await vi.advanceTimersByTimeAsync(2_000);
		assert.equal(sent.length, 3);
		await vi.advanceTimersByTimeAsync(5_000);
		const result = await execution;
		assert.equal(result.isError, true);
		assert.equal(result.details?.messageId, undefined, "terminal errors do not expose internal identity");
		assert.deepEqual(result.details, { error: true, terminal: true, automaticRetries: 3, outcome: "unknown" });
		assert.match(result.content[0]?.text ?? "", /Do not repeat this operation automatically/);
		assertNoRetryToken(result);
		assert.equal(sent.length, 4);
		assert.deepEqual(
			sent.map(({ messageId }) => messageId),
			Array(4).fill(sent[0]?.messageId),
		);
		assert.equal(vi.getTimerCount(), 0, "bounded recovery leaves no timers behind");
		const intentionalRepeat = await tool.execute("intentional-repeat", params, undefined, undefined, context);
		assert.equal(intentionalRepeat.isError, true);
		assertNoRetryToken(intentionalRepeat);
		assert.equal(sent.length, 5, "initial nondelivery must not retry");
		assert.notEqual(sent[4]?.messageId, sent[0]?.messageId, "a separate invocation is always fresh");
	});
}

test("caller-supplied retry tokens are rejected before connecting, resolving, or sending", async () => {
	const { tool, sent, resolverCalls, connectionCalls } = fixture();
	for (const action of ["send", "ask", "reply", "list"]) {
		for (const retryToken of ["not-a-real-token", "", undefined]) {
			const result = await tool.execute(
				"unsupported-token",
				{ action, to: peer.name, message: "not sent", retryToken },
				undefined,
				undefined,
				context,
			);
			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /manages retries internally.*not sent/);
			assertNoRetryToken(result);
		}
	}
	assert.equal(sent.length, 0);
	assert.equal(resolverCalls(), 0);
	assert.equal(connectionCalls(), 0);
});

test("internal retries preserve omitted attachments versus an explicit empty list", async () => {
	for (const firstAttachments of [undefined, []] as const) {
		const { tool, sent } = fixture(new IntercomClientDisconnectedError());
		const params = {
			action: "send",
			to: peer.name,
			message: "attachment presence is exact",
			attachments: firstAttachments === undefined ? undefined : [...firstAttachments],
		};
		const execution = tool.execute("single-call", params, undefined, undefined, context);
		await vi.advanceTimersByTimeAsync(0);
		params.attachments = firstAttachments === undefined ? [] : undefined;
		await vi.advanceTimersByTimeAsync(8_000);
		assertNoRetryToken(await execution);
		assert.equal(sent.length, 4);
		assert.deepEqual(
			sent.map(({ attachments }) => attachments),
			Array(4).fill(firstAttachments),
		);
		assert.deepEqual(
			sent.map(({ messageId }) => messageId),
			Array(4).fill(sent[0]?.messageId),
		);
	}
});

test("actual send tool refuses fresh capacity before confirmation, target resolution, ID use, or send", async () => {
	let replyResolutions = 0;
	let tool: Tool | undefined;
	let confirmations = 0;
	let resolverCalls = 0;
	const sent: SendOptions[] = [];
	const client = {
		sessionId: "self-id",
		groups: ["default"],
		async send(_target: string, options: SendOptions) {
			sent.push(options);
			if (sent.length === 1) throw new IntercomClientDisconnectedError();
			return { id: options.messageId, delivered: true };
		},
	};
	registerIntercomTool(
		{
			registerTool(value: Tool) {
				tool = value;
			},
			async appendEntry() {},
		} as never,
		{
			ensureConnected: async () => client,
			syncPresenceIdentity() {},
			resolveSessionTarget: async () => {
				resolverCalls += 1;
				return peer.id;
			},
			homeGroup: () => "default",
			setJoinedGroups() {},
			clearJoinedGroups() {},
			confirmSend: true,
			beginReplyWait: () => {
				throw new Error("send must not allocate a reply waiter");
			},
			replyTracker: {
				resolveReplyTarget() {
					replyResolutions += 1;
					throw new Error("capacity refusal must precede mutable reply resolution");
				},
			} as never,
			retryIdentityMaxEntries: 1,
		} as never,
	);
	assert.ok(tool);
	const uiContext = {
		sessionManager: { getSessionId: () => "host-session" },
		hasUI: true,
		ui: {
			async confirm() {
				confirmations += 1;
				return true;
			},
		},
	};
	const firstExecution = tool.execute(
		"retained",
		{ action: "send", to: peer.name, message: "first" },
		undefined,
		undefined,
		uiContext,
	);
	await vi.advanceTimersByTimeAsync(0);
	const retainedMessageId = sent[0]?.messageId;
	assert.ok(retainedMessageId);

	const refused = await tool.execute(
		"capacity-refused",
		{ action: "send", to: peer.name, message: "fresh" },
		undefined,
		undefined,
		uiContext,
	);
	assert.equal(refused.isError, true);
	assert.match(refused.content[0]?.text ?? "", /capacity is exhausted/);
	const refusedReply = await tool.execute(
		"reply-capacity-refused",
		{ action: "reply", message: "fresh reply" },
		undefined,
		undefined,
		uiContext,
	);
	assert.equal(refusedReply.isError, true);
	assert.match(refusedReply.content[0]?.text ?? "", /capacity is exhausted/);
	assert.equal(replyResolutions, 0, "capacity refusal happens before mutable reply resolution");
	assert.equal(sent.length, 1);
	assert.equal(confirmations, 1, "capacity refusal happens before the fresh UI confirmation");
	assert.equal(resolverCalls, 1, "capacity refusal happens before fresh target resolution");
	assert.equal(sent.length, 1, "capacity refusal never reaches client.send");

	await vi.advanceTimersByTimeAsync(1_000);
	const recovered = await firstExecution;
	assert.equal(recovered.isError, false, recovered.content[0]?.text);
	assertNoRetryToken(recovered);
	assert.equal(sent[1]?.messageId, retainedMessageId, "the internal retry can use its own occupied slot");
	assert.equal(confirmations, 1, "internal retries must not repeat the UI confirmation");
	const fresh = await tool.execute(
		"after-settlement",
		{ action: "send", to: peer.name, message: "fresh" },
		undefined,
		undefined,
		uiContext,
	);
	assert.equal(fresh.isError, false, "settlement releases capacity for a new call");
	assert.equal(confirmations, 2);
	assert.notEqual(sent[2]?.messageId, retainedMessageId);
});

for (const action of ["send", "ask", "reply"] as const) {
	test(`${action} stops internal recovery after a conclusive non-recoverable exception`, async () => {
		const { tool, sent } = fixture(new IntercomClientDisconnectedError(), new Error("protocol failure"));
		const params =
			action === "reply"
				? { action, message: "same operation", replyTo: question.id }
				: { action, to: peer.name, message: "same operation" };
		const execution = tool.execute("single-call", params, undefined, undefined, context);
		await vi.advanceTimersByTimeAsync(1_000);
		const result = await execution;
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /protocol failure/);
		assertNoRetryToken(result);
		assert.equal(sent.length, 2);
		assert.equal(sent[0]?.messageId, sent[1]?.messageId);
		assert.equal(vi.getTimerCount(), 0);
		await tool.execute("fresh-after-failure", params, undefined, undefined, context);
		assert.equal(sent.length, 3);
		assert.notEqual(sent[2]?.messageId, sent[0]?.messageId);
	});
}

test("a non-recoverable failure never reserves the operation identity", async () => {
	const { tool, sent } = fixture(new Error("protocol failure"));
	const params = { action: "send", to: peer.name, message: "same operation" };
	await tool.execute("first", params, undefined, undefined, context);
	await tool.execute("retry", params, undefined, undefined, context);
	assert.equal(sent.length, 2);
	assert.notEqual(sent[0]?.messageId, sent[1]?.messageId);
});

test("ask retains its question identity across a recoverable disconnect during the reply wait", async () => {
	let tool: Tool | undefined;
	const sent: SendOptions[] = [];
	const deliveredQuestionIds = new Set<string>();
	const recipientQuestions: string[] = [];
	const waiters = new ReplyWaiterRegistry();
	const client = {
		sessionId: "self-id",
		groups: ["default"],
		async send(_target: string, options: SendOptions) {
			sent.push(options);
			const messageId = options.messageId ?? "missing";
			if (!deliveredQuestionIds.has(messageId)) recipientQuestions.push(messageId);
			deliveredQuestionIds.add(messageId);
			return { id: messageId, delivered: true };
		},
	};
	registerIntercomTool(
		{
			registerTool(value: Tool) {
				tool = value;
			},
			async appendEntry() {},
		} as never,
		{
			ensureConnected: async () => client,
			syncPresenceIdentity() {},
			resolveSessionTarget: async () => peer.id,
			homeGroup: () => "default",
			setJoinedGroups() {},
			clearJoinedGroups() {},
			confirmSend: false,
			beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) => waiters.begin(from, replyTo, signal),
			replyTracker: new ReplyTracker(),
		} as never,
	);
	assert.ok(tool);

	const firstExecution = tool.execute(
		"first",
		{ action: "ask", to: peer.name, message: "same question" },
		undefined,
		undefined,
		context,
	);
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(sent.length, 1);
	waiters.rejectAll(
		new Error("Disconnected while waiting for reply: Client disconnected", {
			cause: new IntercomClientDisconnectedError(),
		}),
	);
	await vi.advanceTimersByTimeAsync(1_000);
	assert.equal(sent.length, 2);
	const originalQuestionId = sent[0]?.messageId;
	assert.ok(originalQuestionId);
	const routed = routeIncomingReply(waiters.pending(), peer, {
		id: "peer-reply",
		timestamp: 2,
		replyTo: originalQuestionId,
		content: { text: "reply after reconnect" },
	});
	if (!routed) waiters.rejectAll(new Error("test cleanup after correlation failure"));
	const retry = await firstExecution;

	assert.deepEqual(
		sent.map(({ messageId }) => messageId),
		[originalQuestionId, originalQuestionId],
	);
	assert.deepEqual(recipientQuestions, [originalQuestionId]);
	assert.equal(routed, true, "the retried waiter must use the original question correlation");
	assert.equal(retry.isError, false);
	assert.match(retry.content[0]?.text ?? "", /reply after reconnect/);
	assertNoRetryToken(retry);
	assert.equal(vi.getTimerCount(), 0);
});

for (const action of ["send", "ask", "reply"] as const) {
	test(`${action} cancelled before invocation does not connect or send`, async () => {
		const { tool, sent, connectionCalls } = fixture();
		const controller = new AbortController();
		controller.abort();
		const result = await tool.execute(
			"already-cancelled",
			{ action, to: peer.name, message: "never sent" },
			controller.signal,
			undefined,
			context,
		);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Cancelled/);
		assertNoRetryToken(result);
		assert.equal(connectionCalls(), 0);
		assert.equal(sent.length, 0);
		assert.equal(vi.getTimerCount(), 0);
	});

	test(`${action} cancellation during backoff stops recovery with unknown outcome and releases capacity`, async () => {
		const { tool, sent } = fixture(new IntercomClientDisconnectedError(), undefined, 1);
		const params =
			action === "reply"
				? { action, message: "one operation", replyTo: question.id }
				: { action, to: peer.name, message: "one operation" };
		const controller = new AbortController();
		const execution = tool.execute("cancel-during-backoff", params, controller.signal, undefined, context);
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(sent.length, 1);
		controller.abort();
		const result = await execution;
		assert.deepEqual(result.details, { error: true, terminal: true, automaticRetries: 0, outcome: "unknown" });
		assert.match(result.content[0]?.text ?? "", /Cancelled/);
		assertNoRetryToken(result);
		await vi.advanceTimersByTimeAsync(8_000);
		assert.equal(sent.length, 1, "aborted recovery must not submit another send");
		assert.equal(vi.getTimerCount(), 0);
		await tool.execute("intentional-new-call", params, undefined, undefined, context);
		assert.equal(sent.length, 2, "cancellation releases its occupied capacity slot");
		assert.notEqual(sent[1]?.messageId, sent[0]?.messageId);
	});
}

test("ask recovery retains the original operation deadline instead of granting a fresh reply timeout", async () => {
	const { tool, client, sent, waiters } = fixture();
	client.send = async (_target, options) => {
		sent.push(options);
		return { id: options.messageId ?? "missing", delivered: true };
	};
	const execution = tool.execute(
		"bounded-ask",
		{ action: "ask", to: peer.name, message: "one question" },
		undefined,
		undefined,
		context,
	);
	await vi.advanceTimersByTimeAsync(ASK_REPLY_TIMEOUT_MS - 10_000);
	assert.equal(sent.length, 1);
	waiters.rejectAll(new IntercomClientDisconnectedError());
	await vi.advanceTimersByTimeAsync(1_000);
	assert.equal(sent.length, 2);
	assert.equal(sent[0]?.messageId, sent[1]?.messageId);
	let settled = false;
	void execution.then(() => {
		settled = true;
	});
	await vi.advanceTimersByTimeAsync(RETRY_IDENTITY_TTL_MS - ASK_REPLY_TIMEOUT_MS + 9_000 - 1);
	assert.equal(settled, false, "recovery remains pending until the original deadline");
	await vi.advanceTimersByTimeAsync(1);
	const result = await execution;
	assert.equal(result.isError, true);
	assert.equal(result.details?.terminal, true);
	assert.equal(result.details?.outcome, "unknown");
	assert.equal(result.details?.automaticRetries, 1);
	assertNoRetryToken(result);
	assert.equal(sent.length, 2, "deadline must not trigger a fresh operation");
	assert.equal(waiters.size(), 0);
	assert.equal(vi.getTimerCount(), 0);
});

test("cancelling an accepted ask during its first reply wait reports terminal unknown outcome", async () => {
	const { tool, client, sent, waiters } = fixture();
	client.send = async (_target, options) => {
		sent.push(options);
		return { id: options.messageId ?? "missing", delivered: true };
	};
	const controller = new AbortController();
	const execution = tool.execute(
		"cancel-accepted-ask",
		{ action: "ask", to: peer.name, message: "accepted question" },
		controller.signal,
		undefined,
		context,
	);
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(sent.length, 1);
	assert.equal(waiters.size(), 1, "the accepted ask is waiting for its reply");
	controller.abort();
	const result = await execution;
	assert.equal(result.isError, true);
	assertNoRetryToken(result);
	assert.deepEqual(result.details, { error: true, terminal: true, automaticRetries: 0, outcome: "unknown" });
	assert.match(result.content[0]?.text ?? "", /Delivery may already have occurred/);
	assert.equal(sent.length, 1);
	assert.equal(waiters.size(), 0);
	assert.equal(vi.getTimerCount(), 0);
});
