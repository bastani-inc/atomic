import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import { sleep } from "../helpers/runtime.js";

type ToolResult = {
	content: Array<{ text: string }>;
	isError: boolean;
};

type Tool = {
	execute(
		id: string,
		params: { action?: string; to?: string; message?: string; group?: string },
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: object,
	): Promise<ToolResult>;
};

function session(id: string, name: string): SessionInfo {
	return {
		id,
		name,
		cwd: "/worktree",
		model: "test",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
		status: "idle",
	};
}

function ask(id: string): Message {
	return {
		id,
		timestamp: 1,
		expectsReply: true,
		content: { text: `question ${id}` },
	};
}

function toolFixture(replyTracker: ReplyTracker, sessions: SessionInfo[] = []) {
	let tool: Tool | undefined;
	const sent: Array<{
		to: string;
		messageId?: string;
		replyTo?: string;
		expectsReply?: boolean;
	}> = [];
	const client = {
		sessionId: "self-session-id",
		async listSessions(): Promise<SessionInfo[]> {
			return sessions;
		},
		async send(
			to: string,
			message: {
				messageId?: string;
				replyTo?: string;
				expectsReply?: boolean;
			},
		) {
			if (sessions.length > 0 && !sessions.some((entry) => entry.id === to)) {
				return { id: message.messageId ?? "failed-message", delivered: false, reason: "Session not found" };
			}
			sent.push({
				to,
				...(message.messageId !== undefined ? { messageId: message.messageId } : {}),
				...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
				...(message.expectsReply !== undefined ? { expectsReply: message.expectsReply } : {}),
			});
			return { id: message.messageId ?? "reply-message", delivered: true };
		},
	};
	const waiterSlot = new ReplyWaiterRegistry();
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
			confirmSend: false,
			beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) =>
				waiterSlot.begin(from, replyTo, signal),
			replyTracker,
		} as never,
	);
	assert.ok(tool);
	return { tool, sent, waiterSlot };
}

const context = {
	sessionManager: { getSessionId: () => "atomic-session" },
	hasUI: false,
};

describe("Intercom full session ID targeting", () => {
	test("list displays the full session ID", async () => {
		const self = session("self-session-id", "self");
		const recipient = session("aa56071e-1111-4222-8333-123456789abc", "recipient");
		const current = toolFixture(new ReplyTracker(), [self, recipient]);

		const listed = await current.tool.execute("list-call", { action: "list" }, undefined, undefined, context);
		const text = listed.content[0]?.text ?? "";
		assert.match(text, new RegExp(`recipient \\(${recipient.id}\\)`));
	});

	test("send accepts an exact full session ID", async () => {
		const self = session("self-session-id", "self");
		const recipient = session("cc78193a-1111-4222-8333-123456789abc", "recipient");
		const current = toolFixture(new ReplyTracker(), [self, recipient]);

		const result = await current.tool.execute(
			"send",
			{ action: "send", to: recipient.id, message: "hello" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, false, result.content[0]?.text);
		assert.equal(current.sent[0]?.to, recipient.id);
		assert.equal(typeof current.sent[0]?.messageId, "string");
	});

	test("ask by a workflow stage name alias keys its reply waiter on the live stage session", async () => {
		// Regression: #2784 — the broker registers BOTH `<runId>:<stageId>` and `<runId>:<stageName>`
		// as live aliases, but the roster publishes only the id form. Matching the id form alone left a
		// name-addressed ask delivered but keyed on a string inbound reply routing never produces, so
		// it blocked to the 10-minute timeout instead of settling.
		const runId = "27840002-3528-413e-84c4-87a43e5037a2";
		const stageSession = session("ee02315c-1111-4222-8333-123456789abc", "reviewer-stage");
		const nameTarget = `workflow:${runId}/reviewer`;
		let tool: Tool | undefined;
		const client = {
			sessionId: "self-session-id",
			async listSessions(): Promise<SessionInfo[]> {
				return [stageSession];
			},
			async listDirectory() {
				return {
					sessions: [stageSession],
					workflowStages: [
						{
							kind: "workflow-stage" as const,
							runId,
							stageId: "reviewer-id",
							stageName: "reviewer",
							target: `workflow:${runId}/reviewer-id`,
							lifecycle: "running" as const,
							group: `workflow:${runId}/reviewers`,
							sessionId: stageSession.id,
						},
					],
				};
			},
			async send(to: string, message: { messageId?: string }) {
				return { id: message.messageId ?? "reply-message", delivered: true, to };
			},
		};
		const waiterSlot = new ReplyWaiterRegistry();
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
				confirmSend: false,
				beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) =>
					waiterSlot.begin(from, replyTo, signal),
				replyTracker: new ReplyTracker(),
			} as never,
		);
		assert.ok(tool);

		const pending = tool.execute(
			"ask-name-alias",
			{ action: "ask", to: nameTarget, message: "question" },
			undefined,
			undefined,
			context,
		);
		await sleep(10);
		const waiter = waiterSlot.pending()[0];
		assert.ok(waiter, "the name-aliased ask should register a reply waiter");
		assert.equal(
			waiter.from,
			stageSession.id,
			"waiter must key on the stage's live broker session, not the literal name-alias target",
		);
		const routed = routeIncomingReply(waiter, stageSession, {
			id: "alias-reply",
			timestamp: 2,
			replyTo: waiter.replyTo,
			content: { text: "answer" },
		});
		assert.equal(routed, true, "the stage's correlated reply must settle the name-aliased ask");
		const result = await pending;
		assert.equal(result.isError, false, result.content[0]?.text);
	});

	test("an ordinary exact-session-id ask performs no workflow-roster directory lookup", async () => {
		// Regression: #2784 — resolveReplySender short-circuited only when the logical and send
		// targets differed, but an exact session id resolves to itself, so every ordinary ask paid a
		// listDirectory round-trip and inherited its 5s "List sessions timeout" as a new failure mode.
		const self = session("self-session-id", "self");
		const recipient = session("dd91204b-1111-4222-8333-123456789abc", "recipient");
		let directoryCalls = 0;
		let tool: Tool | undefined;
		const client = {
			sessionId: self.id,
			async listSessions(): Promise<SessionInfo[]> {
				return [self, recipient];
			},
			async listDirectory() {
				directoryCalls += 1;
				throw new Error("List sessions timeout");
			},
			async send(to: string, message: { messageId?: string }) {
				return { id: message.messageId ?? "reply-message", delivered: true, to };
			},
		};
		const waiterSlot = new ReplyWaiterRegistry();
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
				confirmSend: false,
				beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) =>
					waiterSlot.begin(from, replyTo, signal),
				replyTracker: new ReplyTracker(),
			} as never,
		);
		assert.ok(tool);

		const pending = tool.execute(
			"ask-ordinary",
			{ action: "ask", to: recipient.id, message: "question" },
			undefined,
			undefined,
			context,
		);
		await sleep(10);
		assert.equal(directoryCalls, 0, "an ordinary id-targeted ask must not query the workflow roster");

		const waiter = waiterSlot.pending()[0];
		assert.ok(waiter, "ask should have registered a reply waiter rather than erroring out");
		assert.equal(waiter.from, recipient.id, "waiter must key on the recipient session id");
		const routed = routeIncomingReply(waiter, recipient, {
			id: "threaded-reply",
			timestamp: 2,
			replyTo: waiter.replyTo,
			content: { text: "answer" },
		});
		assert.equal(routed, true, "the correlated reply must settle the waiter");
		const result = await pending;
		assert.equal(result.isError, false, result.content[0]?.text);
		assert.equal(directoryCalls, 0, "no roster lookup may occur across the whole ask lifecycle");
	});

	test("blocking ask accepts an exact full session ID and correlates the reply", async () => {
		const self = session("self-session-id", "self");
		const recipient = session("aa56071e-1111-4222-8333-123456789abc", "recipient");
		const current = toolFixture(new ReplyTracker(), [self, recipient]);

		const execution = current.tool.execute(
			"ask-call",
			{ action: "ask", to: recipient.id, message: "question" },
			undefined,
			undefined,
			context,
		);
		await sleep(0);
		const waiter = current.waiterSlot.pending()[0];
		const routed =
			waiter === undefined
				? false
				: routeIncomingReply(waiter, recipient, {
						id: "threaded-reply",
						timestamp: 2,
						replyTo: waiter.replyTo,
						content: { text: "answer" },
					});
		const result = await execution;

		assert.equal(routed, true);
		assert.equal(result.isError, false, result.content[0]?.text);
		assert.equal(current.sent[0]?.to, recipient.id);
		assert.match(result.content[0]?.text ?? "", /answer/);
	});

	test("targeted reply accepts an exact full session ID", async () => {
		const sender = session("bb67082f-1111-4222-8333-123456789abc", "sender");
		const replies = new ReplyTracker();
		replies.recordIncomingMessage(sender, ask("question-sender"));
		const current = toolFixture(replies);

		const result = await current.tool.execute(
			"reply-call",
			{ action: "reply", to: sender.id, message: "answer" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, false, result.content[0]?.text);
		assert.equal(current.sent[0]?.to, sender.id);
		assert.equal(current.sent[0]?.replyTo, "question-sender");
		assert.equal(typeof current.sent[0]?.messageId, "string");
	});

	test("exact case-insensitive session names resolve to the full ID", async () => {
		const self = session("self-session-id", "self");
		const recipient = session("dd892a4b-1111-4222-8333-123456789abc", "Recipient");
		const current = toolFixture(new ReplyTracker(), [self, recipient]);

		const result = await current.tool.execute(
			"send-name",
			{ action: "send", to: "recipient", message: "by name" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, false, result.content[0]?.text);
		assert.equal(current.sent[0]?.to, recipient.id);
		assert.equal(typeof current.sent[0]?.messageId, "string");
	});

	test("an 8-character ID prefix is rejected for send", async () => {
		const self = session("self-session-id", "self");
		const recipient = session("de903b5c-1111-4222-8333-123456789abc", "recipient");
		const current = toolFixture(new ReplyTracker(), [self, recipient]);

		const result = await current.tool.execute(
			"send-prefix",
			{ action: "send", to: recipient.id.slice(0, 8), message: "hello" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Session not found/);
		assert.deepEqual(current.sent, []);
	});

	test("an 8-character ID prefix is rejected for blocking ask", async () => {
		const self = session("self-session-id", "self");
		const recipient = session("df014c6d-1111-4222-8333-123456789abc", "recipient");
		const current = toolFixture(new ReplyTracker(), [self, recipient]);

		const result = await current.tool.execute(
			"ask-prefix",
			{ action: "ask", to: recipient.id.slice(0, 8), message: "question" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Session not found/);
		assert.deepEqual(current.sent, []);
	});

	test("an 8-character ID prefix is rejected for targeted reply", async () => {
		const sender = session("ee903b5c-1111-4222-8333-123456789abc", "sender");
		const replies = new ReplyTracker();
		replies.recordIncomingMessage(sender, ask("question-sender"));
		const current = toolFixture(replies);

		const result = await current.tool.execute(
			"reply-prefix",
			{ action: "reply", to: sender.id.slice(0, 8), message: "answer" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /No pending ask/);
		assert.deepEqual(current.sent, []);
	});

	test("an unknown target is not found", async () => {
		const self = session("self-session-id", "self");
		const recipient = session("ff014c6d-1111-4222-8333-123456789abc", "recipient");
		const current = toolFixture(new ReplyTracker(), [self, recipient]);

		const result = await current.tool.execute(
			"send-missing",
			{ action: "send", to: "missing-session-id", message: "hello" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Session not found/);
		assert.deepEqual(current.sent, []);
	});

	test("an exact full self ID is rejected before delivery", async () => {
		const self = session("self-session-id", "self");
		const current = toolFixture(new ReplyTracker(), [self]);

		const result = await current.tool.execute(
			"send-self",
			{ action: "send", to: self.id, message: "loop" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Cannot message the current session/);
		assert.deepEqual(current.sent, []);
	});

	test("an 8-character self ID prefix is not resolvable", async () => {
		const self = session("self-session-id", "self");
		const current = toolFixture(new ReplyTracker(), [self]);

		const result = await current.tool.execute(
			"send-self-prefix",
			{ action: "send", to: self.id.slice(0, 8), message: "loop" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Session not found/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Cannot message the current session/);
		assert.deepEqual(current.sent, []);
	});
});

describe("intercom list renders possible future stage rows (D7)", () => {
	const futureRow = {
		kind: "workflow-future-stage" as const,
		runId: "d7000009-0000-4000-8000-000000000009",
		target: "workflow:d7000009-0000-4000-8000-000000000009/orchestrator-*",
		queuedCount: 2,
		group: "workflow:d7000009-0000-4000-8000-000000000009",
	};
	const broadcastRow = {
		kind: "workflow-future-stage" as const,
		runId: "d7000009-0000-4000-8000-000000000009",
		target: "workflow:d7000009-0000-4000-8000-000000000009/**",
		queuedCount: 1,
		group: "workflow:d7000009-0000-4000-8000-000000000009",
	};

	function futureFixture(directory: {
		sessions: SessionInfo[];
		workflowStages: never[];
		workflowFutureStages: readonly unknown[];
	}) {
		let tool: Tool | undefined;
		const client = {
			sessionId: "self-session-id",
			groups: ["default"],
			async listSessions(): Promise<SessionInfo[]> {
				return directory.sessions;
			},
			async listDirectory(group?: string): Promise<typeof directory> {
				return group === undefined ? directory : directory;
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
				confirmSend: false,
				beginReplyWait: () => ({ ok: false, reason: "busy" as const, limit: 0 }),
				replyTracker: new ReplyTracker(),
			} as never,
		);
		assert.ok(tool);
		return { tool: tool! };
	}

	test("list renders the canonical target and the queued count for every future row", async () => {
		const self = session("self-session-id", "self");
		const { tool } = futureFixture({
			sessions: [self],
			workflowStages: [],
			workflowFutureStages: [futureRow, broadcastRow],
		});
		const result = await tool.execute("list-call", { action: "list" }, undefined, undefined, context);
		const text = result.content[0]?.text ?? "";
		assert.match(
			text,
			/- future workflow stage `workflow:d7000009-0000-4000-8000-000000000009\/orchestrator-\*` — 2 queued messages\n/,
		);
		assert.match(
			text,
			/- future workflow stage `workflow:d7000009-0000-4000-8000-000000000009\/\*\*` — 1 queued message(\n|$)/,
		);
		const details = (result as unknown as { details?: { workflowFutureStages?: unknown[] } }).details;
		assert.deepEqual(details?.workflowFutureStages, [futureRow, broadcastRow]);
	});

	test("the singular count form renders without the plural suffix", async () => {
		const self = session("self-session-id", "self");
		const { tool } = futureFixture({
			sessions: [self],
			workflowStages: [],
			workflowFutureStages: [{ ...futureRow, queuedCount: 1 }],
		});
		const result = await tool.execute("list-call", { action: "list" }, undefined, undefined, context);
		const rowLine = (result.content[0]?.text ?? "").split("\n").find((line) => line.includes("orchestrator-"));
		assert.match(rowLine ?? "", /— 1 queued message$/);
	});

	test("read-only group peek renders future rows returned for the peeked group", async () => {
		const self = session("self-session-id", "self");
		self.groups = ["default"];
		const peekedDirectory = {
			sessions: [],
			workflowStages: [],
			workflowFutureStages: [futureRow],
		};
		let tool: Tool | undefined;
		const client = {
			sessionId: "self-session-id",
			groups: ["default"],
			async listSessions(): Promise<SessionInfo[]> {
				return [self];
			},
			async listDirectory(group?: string) {
				return group === undefined
					? { sessions: [self], workflowStages: [], workflowFutureStages: [] }
					: peekedDirectory;
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
				confirmSend: false,
				beginReplyWait: () => ({ ok: false, reason: "busy" as const, limit: 0 }),
				replyTracker: new ReplyTracker(),
			} as never,
		);
		assert.ok(tool);
		const result = await tool!.execute(
			"peek-call",
			{ action: "list", group: "workflow:d7000009-0000-4000-8000-000000000009" },
			undefined,
			undefined,
			context,
		);
		assert.match(
			result.content[0]?.text ?? "",
			/- future workflow stage `workflow:d7000009-0000-4000-8000-000000000009\/orchestrator-\*` — 2 queued messages/,
		);
		const details = (result as unknown as { details?: { workflowFutureStages?: unknown[] } }).details;
		assert.deepEqual(details?.workflowFutureStages, [futureRow]);
	});
});
