import assert from "node:assert/strict";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { Message } from "../../packages/intercom/types.js";
import {
	formatReleasedReplyResults,
	releasedReplyToolResult,
} from "../../packages/subagents/src/runs/foreground/released-child-replies.js";

const reply: Message = {
	id: "reply-1",
	replyTo: "q-1",
	timestamp: 1,
	content: { text: '{"responses":[{"id":"choice","value":"yes"}]}' },
};

test("a released supervisor interview continues with the same structured reply as an inline wait (#4326)", async () => {
	const session = SessionManager.inMemory("/repo");
	await session.appendMessage({
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call-1",
				name: "contact_supervisor",
				arguments: {
					reason: "interview_request",
					interview: { questions: [{ id: "choice", type: "text", question: "Proceed?" }] },
				},
			},
		],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	});
	const held = releasedReplyToolResult({ toolCallId: "call-1", toolName: "contact_supervisor" }, reply);
	const [formatted] = formatReleasedReplyResults(session, [held]);
	assert.equal(formatted?.isError, false);
	assert.deepEqual(formatted?.result.details, { structuredReply: { responses: [{ id: "choice", value: "yes" }] } });
	assert.deepEqual(formatted?.result.content, [
		{ type: "text", text: `**Reply from supervisor:**\n${reply.content.text}` },
	]);
});

test("a released ask preserves its target and attachment formatting, and returns a reply error as an error (#4326)", async () => {
	const session = SessionManager.inMemory("/repo");
	await session.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "call-2", name: "intercom", arguments: { action: "ask", to: "peer" } }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	});
	const call = { toolCallId: "call-2", toolName: "intercom" };
	const attached: Message = {
		...reply,
		content: { text: "answer", attachments: [{ type: "file", name: "notes", content: "line" }] },
	};
	const [formatted] = formatReleasedReplyResults(session, [releasedReplyToolResult(call, attached)]);
	assert.deepEqual(formatted?.result, {
		content: [{ type: "text", text: "**Reply from peer:**\nanswer\n\n---\n📎 notes\nline" }],
		details: {},
	});
	const [failed] = formatReleasedReplyResults(session, [
		releasedReplyToolResult(call, { ...reply, replyError: "not available" }),
	]);
	assert.equal(failed?.isError, true);
	assert.deepEqual(failed?.result, {
		content: [{ type: "text", text: "Failed: not available" }],
		details: { error: true, replyTo: "q-1" },
	});
});
