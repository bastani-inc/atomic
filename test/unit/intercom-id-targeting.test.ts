import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import { resolveSessionTarget } from "../../packages/intercom/session-target.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import { sleep } from "../helpers/runtime.js";

type ToolResult = {
	content: Array<{ text: string }>;
	isError: boolean;
};

type Tool = {
	execute(
		id: string,
		params: { action?: string; to?: string; message?: string; group?: string; replyTo?: string },
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
			async appendEntry() {},
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
		assert.ok(text.includes(`- \`${recipient.id}\` [same cwd, idle] /worktree (test) name: recipient`));
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
		assert.equal(current.sent.length, 1);
		assert.equal(current.sent[0]?.to, recipient.id);
		assert.equal(typeof current.sent[0]?.messageId, "string");
	});

	test("an ordinary exact-session-id ask performs no session directory lookup", async () => {
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
				async appendEntry() {},
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
		assert.equal(directoryCalls, 0, "an ordinary id-targeted ask must not query the session directory");

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
		assert.equal(directoryCalls, 0, "no directory lookup may occur across the whole ask lifecycle");
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
		assert.equal(current.sent.length, 1);
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
		assert.equal(current.sent.length, 1);
		assert.equal(current.sent[0]?.to, recipient.id);
		assert.equal(typeof current.sent[0]?.messageId, "string");
	});

	test("a unique 8-character UUID prefix resolves for send", async () => {
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

		// Regression: #2603 — Intercom resolves within its current visible session set.
		assert.equal(result.isError, false, result.content[0]?.text);
		assert.equal(current.sent.length, 1);
		assert.equal(current.sent[0]?.to, recipient.id);
		assert.ok(current.sent[0]?.messageId);
	});

	test("an ambiguous 8-character UUID prefix lists the matching sessions", async () => {
		// Regression: #2603 — Intercom must never select the first colliding session.
		const first = session("2603abcd-1111-4222-8333-123456789abc", "first");
		const second = session("2603abcd-9999-4222-8333-123456789abc", "second");
		const current = toolFixture(new ReplyTracker(), [session("self-session-id", "self"), first, second]);

		const result = await current.tool.execute(
			"send-ambiguous-prefix",
			{ action: "send", to: "2603abcd", message: "hello" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /ambiguous/);
		assert.match(result.content[0]?.text ?? "", new RegExp(first.id));
		assert.match(result.content[0]?.text ?? "", new RegExp(second.id));
		assert.deepEqual(current.sent, []);
	});

	test("an exact 8-hex custom ID or session name keeps precedence", () => {
		// Regression: #2603 — non-UUID Intercom identifiers retain their existing priority.
		const uuid = session("2603abcd-1111-4222-8333-123456789abc", "uuid-session");
		const customId = session("2603abcd", "custom-id");
		const named = session("different-custom-id", "2603abcd");
		assert.deepEqual(resolveSessionTarget([uuid, customId], "2603abcd"), {
			kind: "resolved",
			session: customId,
		});
		assert.deepEqual(resolveSessionTarget([uuid, named], "2603abcd"), {
			kind: "resolved",
			session: named,
		});
	});

	test("a unique 8-character UUID prefix resolves for blocking ask", async () => {
		const self = session("self-session-id", "self");
		const recipient = session("df014c6d-1111-4222-8333-123456789abc", "recipient");
		const current = toolFixture(new ReplyTracker(), [self, recipient]);

		const pending = current.tool.execute(
			"ask-prefix",
			{ action: "ask", to: recipient.id.slice(0, 8), message: "question" },
			undefined,
			undefined,
			context,
		);

		await sleep(10);
		const waiter = current.waiterSlot.pending()[0];
		assert.ok(waiter);
		waiter.resolve({
			id: "prefix-answer",
			timestamp: 2,
			replyTo: waiter.replyTo,
			content: { text: "answer" },
		});
		const result = await pending;
		assert.equal(result.isError, false, result.content[0]?.text);
		assert.equal(current.sent[0]?.to, recipient.id);
	});

	test("a unique 8-character UUID prefix resolves for targeted reply", async () => {
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

		assert.equal(result.isError, false, result.content[0]?.text);
		assert.equal(current.sent.length, 1);
		assert.equal(current.sent[0]?.to, sender.id);
		assert.equal(current.sent[0]?.replyTo, "question-sender");
		assert.ok(current.sent[0]?.messageId);
	});

	test("targeted reply prefix refuses exact name, custom ID, and UUID collisions without consuming the ask", async () => {
		// Regression: #2603 — explicit reply prefixes must not canonicalize against only the pending sender.
		const sender = session("2603abcd-1111-4111-8111-111111111111", "peer");
		const self = session("self-session-id", "self");
		const conflicts: Array<{ name: string; extra: SessionInfo }> = [
			{ name: "name", extra: session("other", "2603abcd") },
			{ name: "custom-id", extra: session("2603abcd", "other") },
			{ name: "uuid", extra: session("2603abcd-2222-4222-8222-222222222222", "other") },
		];
		for (const conflict of conflicts) {
			const replies = new ReplyTracker();
			replies.recordIncomingMessage(sender, ask("question"));
			const current = toolFixture(replies, [self, sender, conflict.extra]);
			const result = await current.tool.execute(
				`reply-conflict-${conflict.name}`,
				{ action: "reply", to: "2603abcd", replyTo: "question", message: "answer" },
				undefined,
				undefined,
				context,
			);
			assert.equal(result.isError, true, conflict.name);
			assert.deepEqual(current.sent, [], conflict.name);
			assert.equal(replies.listPending().length, 1, conflict.name);
		}
	});

	test("a unique reply prefix still canonicalizes when the sender is listed", async () => {
		const sender = session("ee903b5c-1111-4222-8333-123456789abc", "sender");
		const self = session("self-session-id", "self");
		const replies = new ReplyTracker();
		replies.recordIncomingMessage(sender, ask("question-sender"));
		const current = toolFixture(replies, [self, sender]);
		const result = await current.tool.execute(
			"reply-prefix-listed",
			{ action: "reply", to: sender.id.slice(0, 8), message: "answer" },
			undefined,
			undefined,
			context,
		);
		assert.equal(result.isError, false, result.content[0]?.text);
		assert.equal(current.sent.length, 1);
		assert.equal(current.sent[0]?.to, sender.id);
		assert.equal(replies.listPending().length, 0);
	});

	test("explicit reply names and full IDs keep their original selector", async () => {
		// Regression: #2603 — blanket canonicalization bypassed hidden broker collisions.
		const sender = session("ee903b5c-1111-4222-8333-123456789abc", "Parent");
		for (const to of [sender.id, "Parent", "parent"]) {
			const replies = new ReplyTracker();
			replies.recordIncomingMessage(sender, ask("question-sender"));
			const current = toolFixture(replies);
			const result = await current.tool.execute(
				`reply-original-${to}`,
				{ action: "reply", to, message: "answer" },
				undefined,
				undefined,
				context,
			);
			assert.equal(result.isError, false, `${to}: ${result.content[0]?.text}`);
			assert.equal(current.sent.length, 1, to);
			assert.equal(current.sent[0]?.to, to);
			assert.equal(replies.listPending().length, 0, to);
		}
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

describe("intercom list group peek", () => {
	test("a peek outside the session's reach says so instead of reporting an empty group", async () => {
		const self = session("self-session-id", "self");
		self.groups = ["default"];
		const peekedGroup = "outside-reach";
		let tool: Tool | undefined;
		const client = {
			sessionId: "self-session-id",
			groups: ["default"],
			async listSessions(): Promise<SessionInfo[]> {
				return [self];
			},
			async listDirectory(group?: string) {
				return group === undefined ? { sessions: [self] } : { sessions: [], restricted: true };
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
				confirmSend: false,
				beginReplyWait: () => ({ ok: false, reason: "busy" as const, limit: 0 }),
				replyTracker: new ReplyTracker(),
			} as never,
		);
		assert.ok(tool);
		const result = await tool!.execute(
			"restricted-peek-call",
			{ action: "list", group: peekedGroup },
			undefined,
			undefined,
			context,
		);
		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, false);
		assert.doesNotMatch(text, /No sessions in this group/);
		assert.match(text, /Group outside-reach is outside this session's Intercom reach/);
		const details = (result as unknown as { details?: { restricted?: boolean } }).details;
		assert.equal(details?.restricted, true);
	});
});

test("agent list leads with copyable IDs and keeps meaningful names secondary", async () => {
	const self = session("self-session-id", "subagent-chat-self-session-id");
	const peer = session("6332faab-1111-4222-8333-123456789abc", "research");
	const custom = session("custom-id", "subagent-chat-my-project");
	const current = toolFixture(new ReplyTracker(), [self, peer, custom]);
	const result = await current.tool.execute("list-targets", { action: "list" }, undefined, undefined, context);
	assert.equal(result.isError, false);
	const rows = result.content[0]!.text.split("\n").filter((row) => row.startsWith("- "));
	assert.deepEqual(rows, [
		"- `self-session-id` [self, idle] /worktree (test)",
		"- `6332faab-1111-4222-8333-123456789abc` [same cwd, idle] /worktree (test) name: research",
		"- `custom-id` [same cwd, idle] /worktree (test) name: subagent-chat-my-project",
	]);
});

test("explicit invalid and ambiguous reply selectors send nothing and preserve pending asks", async () => {
	const sender = session("sender-id", "sender");
	const tracker = new ReplyTracker();
	tracker.queueTurnContext(tracker.recordIncomingMessage(sender, ask("first")));
	tracker.beginTurn();
	tracker.admitTurnMessage("first");
	tracker.recordIncomingMessage(sender, ask("second"));
	const current = toolFixture(tracker, [sender]);
	for (const selectors of [
		{ to: sender.id },
		{ replyTo: "missing" },
		{ replyTo: "" },
		{ to: "", replyTo: "first" },
		{ to: "other", replyTo: "first" },
	]) {
		const result = await current.tool.execute(
			"invalid-reply",
			{ action: "reply", message: "must not send", ...selectors },
			undefined,
			undefined,
			context,
		);
		assert.equal(result.isError, true, JSON.stringify(selectors));
		assert.deepEqual(current.sent, []);
		assert.deepEqual(
			tracker.listPending().map((pending) => pending.message.id),
			["first", "second"],
		);
	}
	const result = await current.tool.execute(
		"exact-reply",
		{ action: "reply", to: sender.id, replyTo: "second", message: "answer" },
		undefined,
		undefined,
		context,
	);
	assert.equal(result.isError, false);
	assert.equal(current.sent[0]!.to, sender.id);
	assert.equal(current.sent[0]!.replyTo, "second");
	assert.deepEqual(
		tracker.listPending().map((pending) => pending.message.id),
		["first"],
	);
});
