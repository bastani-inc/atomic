import assert from "node:assert/strict";
import { test } from "vitest";
import type { SendOptions } from "../../packages/intercom/broker/client.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { IntercomClientDisconnectedError } from "../../packages/intercom/recoverable-disconnect.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";

type ToolResult = { content: Array<{ text: string }>; isError: boolean; details?: Record<string, unknown> };
type Tool = {
	execute(
		id: string,
		params: { action: string; to?: string; message?: string; replyTo?: string; retryToken?: string },
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

async function waitForSendCount(sent: readonly SendOptions[], count: number): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (sent.length < count) {
		assert.ok(Date.now() < deadline, `timed out waiting for ${count} sends`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
	}
}

const context = { sessionManager: { getSessionId: () => "host-session" }, hasUI: false };

function fixture(firstFailure: Error, secondFailure?: Error) {
	let tool: Tool | undefined;
	const sent: SendOptions[] = [];
	let resolverCalls = 0;
	const replyTracker = new ReplyTracker();
	replyTracker.recordIncomingMessage(peer, question);
	const waiters = new ReplyWaiterRegistry();
	const client = {
		sessionId: "self-id",
		groups: ["default"],
		async listSessions() {
			return [peer];
		},
		async send(_target: string, options: SendOptions) {
			sent.push(options);
			if (sent.length === 1) throw firstFailure;
			if (sent.length === 2 && secondFailure !== undefined) throw secondFailure;
			return { id: options.messageId ?? "missing", delivered: false, reason: "test settled failure" };
		},
	};
	registerIntercomTool(
		{
			registerTool(value: Tool) {
				tool = value;
			},
			appendEntry() {},
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
			confirmSend: false,
			beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) => waiters.begin(from, replyTo, signal),
			replyTracker,
		} as never,
	);
	assert.ok(tool);
	return { tool, sent, resolverCalls: () => resolverCalls };
}

for (const action of ["send", "ask", "reply"] as const) {
	test(`${action} preserves one explicit retry identity through an intermediate resolved nondelivery`, async () => {
		const { tool, sent } = fixture(new IntercomClientDisconnectedError());
		const params =
			action === "reply"
				? { action, message: "same operation", replyTo: question.id }
				: { action, to: peer.name, message: "same operation" };
		const first = await tool.execute("first", params, undefined, undefined, context);
		const retryToken = first.details?.retryToken;
		assert.equal(typeof retryToken, "string");
		const retry = await tool.execute(
			"retry",
			{ ...params, retryToken: retryToken as string },
			undefined,
			undefined,
			context,
		);
		assert.equal(retry.details?.retryToken, retryToken, "resolved nondelivery keeps the claim visible");
		const guidedRetry = await tool.execute(
			"guided-retry",
			{ ...params, retryToken: retryToken as string },
			undefined,
			undefined,
			context,
		);
		const intentionalRepeat = await tool.execute("intentional-repeat", params, undefined, undefined, context);
		assert.equal(first.isError, true);
		assert.match(first.content[0]?.text ?? "", /Client disconnected/);
		assert.equal(retry.isError, true);
		assert.equal(guidedRetry.isError, true);
		assert.equal(intentionalRepeat.isError, true);
		assert.equal(sent.length, 4);
		assert.deepEqual(
			sent.slice(0, 3).map(({ messageId }) => messageId),
			Array(3).fill(sent[0]?.messageId),
		);
		assert.notEqual(sent[3]?.messageId, sent[0]?.messageId, "a tokenless repeat is always fresh");
	});
}

test("invalid, mismatched, foreign-session, and exhausted retry claims fail without sending", async () => {
	const { tool, sent, resolverCalls } = fixture(new IntercomClientDisconnectedError());
	const params = { action: "send", to: peer.name, message: "bounded operation" };
	const first = await tool.execute("first", params, undefined, undefined, context);
	const retryToken = first.details?.retryToken;
	assert.equal(typeof retryToken, "string");
	const token = retryToken as string;

	for (const [id, candidate, candidateContext] of [
		["mismatch", { ...params, message: "different", retryToken: token }, context],
		["invalid", { ...params, retryToken: "not-a-real-token" }, context],
		[
			"foreign-session",
			{ ...params, retryToken: token },
			{ sessionManager: { getSessionId: () => "other-host" }, hasUI: false },
		],
		["wrong-action", { action: "list", retryToken: token }, context],
	] as const) {
		const result = await tool.execute(id, candidate, undefined, undefined, candidateContext);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /retry token/i);
		assert.equal(sent.length, 1, `${id} must not send or consume the valid identity`);
		assert.equal(resolverCalls(), 1, `${id} must fail before target resolution`);
	}

	let lastClaim: ToolResult | undefined;
	for (let claim = 1; claim <= 3; claim += 1) {
		lastClaim = await tool.execute(`claim-${claim}`, { ...params, retryToken: token }, undefined, undefined, context);
	}
	assert.equal(lastClaim?.details?.messageId, undefined, "an exhausted retry never exposes its internal message ID");
	assert.equal(sent.length, 4);
	const fourth = await tool.execute("fourth-claim", { ...params, retryToken: token }, undefined, undefined, context);
	assert.equal(fourth.isError, true);
	assert.match(fourth.content[0]?.text ?? "", /exhausted its 3 retry attempts/);
	assert.equal(sent.length, 4, "the fourth claimed retry must not reach the client");
});

for (const action of ["send", "ask", "reply"] as const) {
	test(`${action} settles a claimed identity after a conclusive non-recoverable exception`, async () => {
		const { tool, sent } = fixture(new IntercomClientDisconnectedError(), new Error("protocol failure"));
		const params =
			action === "reply"
				? { action, message: "same operation", replyTo: question.id }
				: { action, to: peer.name, message: "same operation" };
		const first = await tool.execute("first", params, undefined, undefined, context);
		const retryToken = first.details?.retryToken;
		assert.equal(typeof retryToken, "string");
		const conclusive = await tool.execute(
			"conclusive",
			{ ...params, retryToken: retryToken as string },
			undefined,
			undefined,
			context,
		);
		assert.equal(conclusive.isError, true);
		assert.match(conclusive.content[0]?.text ?? "", /protocol failure/);
		assert.equal(conclusive.details?.retryToken, undefined);
		const settled = await tool.execute(
			"settled",
			{ ...params, retryToken: retryToken as string },
			undefined,
			undefined,
			context,
		);
		assert.match(settled.content[0]?.text ?? "", /already settled/);
		assert.equal(sent.length, 2);
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
			appendEntry() {},
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
	await waitForSendCount(sent, 1);
	waiters.rejectAll(
		new Error("Disconnected while waiting for reply: Client disconnected", {
			cause: new IntercomClientDisconnectedError(),
		}),
	);
	const first = await firstExecution;
	assert.equal(first.isError, true);
	assert.match(first.content[0]?.text ?? "", /Client disconnected/);

	const retryToken = first.details?.retryToken;
	assert.equal(typeof retryToken, "string");
	const retryExecution = tool.execute(
		"retry",
		{ action: "ask", to: peer.name, message: "same question", retryToken: retryToken as string },
		undefined,
		undefined,
		context,
	);
	await waitForSendCount(sent, 2);
	const originalQuestionId = sent[0]?.messageId;
	assert.ok(originalQuestionId);
	const routed = routeIncomingReply(waiters.pending(), peer, {
		id: "peer-reply",
		timestamp: 2,
		replyTo: originalQuestionId,
		content: { text: "reply after reconnect" },
	});
	if (!routed) waiters.rejectAll(new Error("test cleanup after correlation failure"));
	const retry = await retryExecution;

	assert.deepEqual(
		sent.map(({ messageId }) => messageId),
		[originalQuestionId, originalQuestionId],
	);
	assert.deepEqual(recipientQuestions, [originalQuestionId]);
	assert.equal(routed, true, "the retried waiter must use the original question correlation");
	assert.equal(retry.isError, false);
	assert.match(retry.content[0]?.text ?? "", /reply after reconnect/);
});
