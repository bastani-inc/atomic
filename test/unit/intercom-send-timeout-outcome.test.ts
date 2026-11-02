import assert from "node:assert/strict";
import { test } from "vitest";
import { PendingSendTimeoutError } from "../../packages/intercom/broker/pending-send-registry.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { IntercomBrokerTimeoutError } from "../../packages/intercom/recoverable-disconnect.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { SessionInfo } from "../../packages/intercom/types.js";

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

function session(id: string): SessionInfo {
	return {
		id,
		name: id,
		cwd: "/worktree",
		model: "test",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
		status: "idle",
		groups: ["team"],
		group: "team",
	};
}

/** The intercom tool over a client whose `send` fails with `failure`, as the broker client does when its response times out. */
function toolWhoseSendFails(failure: Error): { readonly tool: Tool; readonly sends: () => number } {
	let tool: Tool | undefined;
	let sends = 0;
	const client = {
		sessionId: "self",
		groups: ["team"],
		async listSessions(): Promise<SessionInfo[]> {
			return [session("self"), session("peer")];
		},
		updatePresence: () => true,
		async send(): Promise<never> {
			sends += 1;
			throw failure;
		},
	};
	const waiters = new ReplyWaiterRegistry();
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
			homeGroup: () => "team",
			setJoinedGroups() {},
			clearJoinedGroups() {},
			confirmSend: false,
			beginReplyWait: (from: string, replyTo: string, signal?: AbortSignal) => waiters.begin(from, replyTo, signal),
			replyTracker: new ReplyTracker(),
		} as never,
	);
	assert.ok(tool);
	return { tool, sends: () => sends };
}

const context = { sessionManager: { getSessionId: () => "atomic-session" }, hasUI: false };

test("a send the broker never answered, though it answered its health check, is an unknown outcome", async () => {
	const { tool, sends } = toolWhoseSendFails(new PendingSendTimeoutError());
	const result = await tool.execute(
		"send",
		{ action: "send", to: "peer", message: "hi" },
		undefined,
		undefined,
		context,
	);

	const text = result.content[0]?.text ?? "";
	assert.equal(sends(), 1);
	assert.equal(result.isError, true);
	assert.equal(result.details?.outcome, "unknown");
	assert.doesNotMatch(text, /^Failed to send/u);
	assert.match(text, /whether the message was queued or delivered is unknown/u);
	assert.match(text, /before sending it again/u);
});

test("a send whose broker also missed its health check is retried and reported as an unknown outcome", async () => {
	const { tool, sends } = toolWhoseSendFails(new IntercomBrokerTimeoutError("Send timeout"));
	const result = await tool.execute(
		"send",
		{ action: "send", to: "peer", message: "hi" },
		undefined,
		undefined,
		context,
	);

	assert.ok(sends() > 1);
	assert.equal(result.isError, true);
	assert.equal(result.details?.outcome, "unknown");
	assert.match(result.content[0]?.text ?? "", /Delivery may already have occurred/u);
});

test("a send the broker refused outright still reports a failure", async () => {
	const { tool } = toolWhoseSendFails(new Error("Message to peer was rejected by the broker"));
	const result = await tool.execute(
		"send",
		{ action: "send", to: "peer", message: "hi" },
		undefined,
		undefined,
		context,
	);

	assert.equal(result.isError, true);
	assert.equal(result.details?.outcome, undefined);
	assert.match(result.content[0]?.text ?? "", /^Failed to send: Message to peer was rejected by the broker/u);
});
