import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import {
	answerReleasedReplyFormatRequests,
	RELEASED_REPLY_FORMAT_EVENT as INTERCOM_FORMAT_EVENT,
} from "../../packages/intercom/released-reply-format.js";
import {
	RELEASED_CHILD_REPLY_EVENT as INTERCOM_REPLY_EVENT,
	RELEASED_REPLY_WAIT_ENTRY as INTERCOM_REPLY_WAIT_ENTRY,
	releasedReplyHandoffResult,
} from "../../packages/intercom/released-reply-wait.js";
import type { Message } from "../../packages/intercom/types.js";
import { isReleasedChildError } from "../../packages/subagents/src/runs/foreground/released-child-errors.js";
import {
	formatReleasedReplyResults,
	releasedReplyTimeout,
	releasedReplyToolResult,
} from "../../packages/subagents/src/runs/foreground/released-child-replies.js";
import {
	isReleasedReplyHandoffResult,
	RELEASED_REPLY_FORMAT_EVENT as SUBAGENTS_FORMAT_EVENT,
	RELEASED_CHILD_REPLY_EVENT as SUBAGENTS_REPLY_EVENT,
	RELEASED_REPLY_WAIT_ENTRY as SUBAGENTS_REPLY_WAIT_ENTRY,
} from "../../packages/subagents/src/runs/foreground/released-reply-protocol.js";
import { moduleDir } from "../helpers/runtime.js";

const intercomEvents = createEventBus();
answerReleasedReplyFormatRequests(intercomEvents);

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
	const [formatted] = formatReleasedReplyResults(session, [held], intercomEvents);
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
	const [formatted] = formatReleasedReplyResults(session, [releasedReplyToolResult(call, attached)], intercomEvents);
	assert.deepEqual(formatted?.result, {
		content: [{ type: "text", text: "**Reply from peer:**\nanswer\n\n---\n📎 notes\nline" }],
		details: {},
	});
	const [failed] = formatReleasedReplyResults(
		session,
		[releasedReplyToolResult(call, { ...reply, replyError: "not available" })],
		intercomEvents,
	);
	assert.equal(failed?.isError, true);
	assert.deepEqual(failed?.result, {
		content: [{ type: "text", text: "Failed: not available" }],
		details: { error: true, replyTo: "q-1" },
	});
});

test("a released reply is not delivered when Intercom is not loaded to format it: typed child-unrestorable (#4326)", () => {
	const call = { toolCallId: "call-3", toolName: "intercom" };
	assert.throws(
		() =>
			formatReleasedReplyResults(
				SessionManager.inMemory("/repo"),
				[
					releasedReplyTimeout({
						...call,
						replyWait: { questionId: "q-3", deadline: 1, from: "peer", retryCount: 0 },
					}),
				],
				createEventBus(),
			),
		(error: Error) => isReleasedChildError(error) && error.code === "child-unrestorable",
	);
});

test("the subagents package names the released-reply protocol exactly as Intercom does (#4326)", () => {
	assert.equal(SUBAGENTS_REPLY_WAIT_ENTRY, INTERCOM_REPLY_WAIT_ENTRY);
	assert.equal(SUBAGENTS_REPLY_EVENT, INTERCOM_REPLY_EVENT);
	assert.equal(SUBAGENTS_FORMAT_EVENT, INTERCOM_FORMAT_EVENT);
	assert.equal(isReleasedReplyHandoffResult(releasedReplyHandoffResult().details as never), true);
	assert.equal(isReleasedReplyHandoffResult({ handoff: true }), false);
});

test("the subagents package imports only types from other packages' sources, so it loads from its own directory (#4326)", () => {
	const packageRoot = join(moduleDir(import.meta.url), "../../packages/subagents");
	const sourceRoot = join(packageRoot, "src");
	const typeOnly = (clause: string) =>
		clause.startsWith("type ") ||
		(clause.startsWith("{") &&
			clause
				.slice(1, -1)
				.split(",")
				.map((part) => part.trim())
				.filter(Boolean)
				.every((part) => part.startsWith("type ")));
	const offenders = readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
		.filter((file) => file.endsWith(".ts"))
		.flatMap((file) =>
			[
				...readFileSync(join(sourceRoot, file), "utf8").matchAll(
					/^(?:import|export)\s+([^;]*?)\s+from\s+"(\.[^"]+)";/gms,
				),
			]
				.filter(([, clause = "", specifier = ""]) => {
					const target = relative(packageRoot, resolve(dirname(join(sourceRoot, file)), specifier));
					return target.startsWith("..") && !typeOnly(clause.trim());
				})
				.map(([, , specifier]) => `${file}: ${specifier}`),
		);
	assert.deepEqual(offenders, []);
});
