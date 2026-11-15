import assert from "node:assert/strict";
import type net from "node:net";
import { describe, test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { type BrokerConnectedSession, handleBrokerSend } from "../../packages/intercom/broker/send-handler.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import {
	INTERCOM_MAX_MESSAGE_BYTES,
	INTERCOM_MAX_MESSAGE_TEXT_BYTES,
	intercomMessageSizeError,
} from "../../packages/intercom/message-size.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import type { Attachment, BrokerMessage, Message, SessionInfo } from "../../packages/intercom/types.js";

type ToolResult = { content: Array<{ text: string }>; isError: boolean };
type ToolParams = { action: string; to?: string; message?: string; replyTo?: string; attachments?: Attachment[] };
type Tool = {
	execute(id: string, params: ToolParams, signal: undefined, update: undefined, ctx: object): Promise<ToolResult>;
};

function sessionInfo(id: string): SessionInfo {
	return { id, name: id, cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1, status: "idle" };
}

function connected(id: string, socket: net.Socket): BrokerConnectedSession {
	return { socket, info: sessionInfo(id) };
}

function toolFixture() {
	let tool: Tool | undefined;
	const sent: string[] = [];
	const recipient = sessionInfo("recipient-id");
	const client = {
		sessionId: "self-id",
		async listSessions() {
			return [sessionInfo("self-id"), recipient];
		},
		async send(to: string, message: { messageId?: string }) {
			sent.push(to);
			return { id: message.messageId ?? "sent", delivered: true };
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
			replyTracker: new ReplyTracker(),
		} as never,
	);
	assert.ok(tool);
	return { tool, sent, recipient };
}

const context = { sessionManager: { getSessionId: () => "atomic-session" }, hasUI: false };

function brokerSend(content: Message["content"]): BrokerMessage[] {
	const senderSocket = {} as net.Socket;
	const recipientSocket = {} as net.Socket;
	const sender = connected("sender-id", senderSocket);
	const recipient = connected("recipient-id", recipientSocket);
	const sessions = new Map([
		[sender.info.id, sender],
		[recipient.info.id, recipient],
	]);
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	handleBrokerSend(
		senderSocket,
		{ type: "send", to: recipient.info.id, message: { id: "big", timestamp: 1, content } },
		sender.info.id,
		sessions,
		new DeliveredMessageCache(),
		(socket, message) => {
			writes.push({ socket, message });
			return true;
		},
	);
	assert.equal(
		writes.some((entry) => entry.socket === recipientSocket),
		writes.at(-1)?.message.type === "delivered",
	);
	return writes.map((entry) => entry.message);
}

describe("Intercom per-message size limit (#4896)", () => {
	test("the intercom tool refuses an oversized message before sending it (#4896)", async () => {
		const current = toolFixture();
		const tooLong = await current.tool.execute(
			"send",
			{ action: "send", to: current.recipient.id, message: "é".repeat(INTERCOM_MAX_MESSAGE_TEXT_BYTES / 2 + 1) },
			undefined,
			undefined,
			context,
		);
		assert.equal(tooLong.isError, true);
		assert.match(
			tooLong.content[0]?.text ?? "",
			/message text is 1048578 bytes, over the limit of 1048576 bytes \(1 MiB\); the message was not sent/,
		);

		const attachment: Attachment = { type: "file", name: "a.txt", content: "x".repeat(INTERCOM_MAX_MESSAGE_BYTES) };
		const tooMuch = await current.tool.execute(
			"ask",
			{ action: "ask", to: current.recipient.id, message: "see attached", attachments: [attachment] },
			undefined,
			undefined,
			context,
		);
		assert.equal(tooMuch.isError, true);
		assert.match(
			tooMuch.content[0]?.text ?? "",
			/text and attachments total 8388625 bytes, over the limit of 8388608 bytes \(8 MiB\); the message was not sent/,
		);
		assert.deepEqual(current.sent, []);

		const atLimit = await current.tool.execute(
			"send",
			{ action: "send", to: current.recipient.id, message: "x".repeat(INTERCOM_MAX_MESSAGE_TEXT_BYTES) },
			undefined,
			undefined,
			context,
		);
		assert.equal(atLimit.isError, false, atLimit.content[0]?.text);
		assert.deepEqual(current.sent, [current.recipient.id]);
	});

	test("the broker refuses an oversized message from any client and still delivers one at the limit (#4896)", () => {
		const text = brokerSend({ text: "x".repeat(INTERCOM_MAX_MESSAGE_TEXT_BYTES + 1) });
		assert.equal(text.length, 1);
		assert.equal(text[0]?.type, "delivery_failed");
		assert.match(
			(text[0] as { reason: string }).reason,
			/message text is 1048577 bytes, over the limit of 1048576 bytes \(1 MiB\); the message was not sent/,
		);

		const half = INTERCOM_MAX_MESSAGE_BYTES / 2;
		const total = brokerSend({
			text: "x",
			attachments: [
				{ type: "file", name: "a", content: "y".repeat(half) },
				{ type: "snippet", name: "b", content: "z".repeat(half) },
			],
		});
		assert.equal(total.length, 1);
		assert.equal(total[0]?.type, "delivery_failed");
		assert.match(
			(total[0] as { reason: string }).reason,
			/text and attachments total 8388611 bytes, over the limit of 8388608 bytes \(8 MiB\)/,
		);

		const atLimit = brokerSend({
			text: "x".repeat(INTERCOM_MAX_MESSAGE_TEXT_BYTES),
			attachments: [
				{
					type: "file",
					name: "a",
					content: "y".repeat(INTERCOM_MAX_MESSAGE_BYTES - INTERCOM_MAX_MESSAGE_TEXT_BYTES - 1),
				},
			],
		});
		assert.equal(atLimit.at(-1)?.type, "delivered");
	});

	test("every attachment's name, language and content count toward the whole-message limit (#4896)", () => {
		const content = "c".repeat(INTERCOM_MAX_MESSAGE_BYTES - 12);
		const exact = {
			text: "ab",
			attachments: [{ type: "snippet" as const, name: "n.ts", content, language: "ts✓x" }],
		};
		assert.equal(intercomMessageSizeError(exact), undefined, "2 + 4 + content + 6 bytes is exactly the limit");
		const over = { ...exact, attachments: [{ ...exact.attachments[0]!, language: "ts✓xy" }] };
		assert.match(intercomMessageSizeError(over) ?? "", /total 8388609 bytes/);
		const withoutLanguage = {
			text: "ab",
			attachments: [{ type: "file" as const, name: "n.ts", content: `${content}123456` }],
		};
		assert.equal(intercomMessageSizeError(withoutLanguage), undefined);
	});
});
