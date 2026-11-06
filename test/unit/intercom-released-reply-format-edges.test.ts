import assert from "node:assert/strict";
import { test } from "vitest";
import {
	answerReleasedReplyFormatRequests,
	formatReleasedReply,
	RELEASED_REPLY_FORMAT_EVENT,
	type ReleasedReplyFormatRequest,
	type ReleasedReplyOutcome,
} from "../../packages/intercom/released-reply-format.js";

type Handler = (data: unknown) => void;

function bus() {
	const handlers = new Map<string, Handler[]>();
	return {
		on(channel: string, handler: Handler) {
			handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
			return () =>
				handlers.set(
					channel,
					(handlers.get(channel) ?? []).filter((one) => one !== handler),
				);
		},
		emit(channel: string, data: unknown) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
	};
}

const reply = (text: string): ReleasedReplyOutcome => ({ kind: "reply", reply: { replyTo: "q-1", text } });
const interview = { questions: [{ id: "choice", type: "text", question: "Proceed?" }] };

test("the format event has the name Subagents asks on (#4326)", () => {
	assert.equal(RELEASED_REPLY_FORMAT_EVENT, "intercom:format-released-reply");
});

test("a request is answered only when it is a complete request nobody answered yet (#4326)", () => {
	const events = bus();
	answerReleasedReplyFormatRequests(events);
	const outcome = reply("yes");
	const valid = { toolName: "intercom", args: { to: "peer" }, outcome };
	const malformed: unknown[] = [
		"text",
		null,
		42,
		{},
		{ args: {}, outcome },
		{ toolName: 7, args: {}, outcome },
		{ toolName: "intercom", outcome },
		{ toolName: "intercom", args: null, outcome },
		{ toolName: "intercom", args: "peer", outcome },
		{ toolName: "intercom", args: {} },
		{ toolName: "intercom", args: {}, outcome: null },
		{ toolName: "intercom", args: {}, outcome: "yes" },
	];
	for (const payload of malformed) {
		assert.doesNotThrow(() => events.emit(RELEASED_REPLY_FORMAT_EVENT, payload));
		if (typeof payload === "object" && payload !== null)
			assert.equal((payload as ReleasedReplyFormatRequest).result, undefined, JSON.stringify(payload));
	}
	const request: ReleasedReplyFormatRequest = { ...valid };
	events.emit(RELEASED_REPLY_FORMAT_EVENT, request);
	assert.equal(request.result?.ok, true);

	const answered: ReleasedReplyFormatRequest = {
		...valid,
		result: { ok: false, reason: "an earlier answer" },
	};
	events.emit(RELEASED_REPLY_FORMAT_EVENT, answered);
	assert.deepEqual(answered.result, { ok: false, reason: "an earlier answer" });
});

test("a supervisor reply to a plain decision request is a plain reply, even if the call carried an interview (#4326)", () => {
	const result = formatReleasedReply({
		toolName: "contact_supervisor",
		args: { reason: "need_decision", interview: { questions: "not an interview" } as never },
		outcome: reply("go ahead"),
	});
	assert.deepEqual(result, {
		ok: true,
		formatted: {
			content: [{ type: "text", text: "**Reply from supervisor:**\ngo ahead" }],
			details: {},
			isError: false,
		},
	});
});

test("a supervisor interview that was invalid when it was asked cannot be answered (#4326)", () => {
	const result = formatReleasedReply({
		toolName: "contact_supervisor",
		args: { reason: "interview_request", interview: { questions: "not an interview" } as never },
		outcome: reply("anything"),
	});
	assert.deepEqual(result, { ok: false, reason: "the pending interview is invalid" });
});

test("an interview reply that does not parse is passed on with the parse error, and one that does gives structured answers (#4326)", () => {
	const args = { reason: "interview_request", interview };
	const plain = formatReleasedReply({ toolName: "contact_supervisor", args, outcome: reply("just text") });
	assert.equal(
		plain.ok && Object.keys(plain.formatted.details).length,
		0,
		"prose is a plain reply, not a failed parse",
	);

	const unparsable = formatReleasedReply({ toolName: "contact_supervisor", args, outcome: reply("{not valid json") });
	assert.equal(unparsable.ok, true);
	if (!unparsable.ok) return;
	assert.equal(typeof unparsable.formatted.details.structuredReplyParseError, "string");
	assert.notEqual(unparsable.formatted.details.structuredReplyParseError, "");
	assert.equal(unparsable.formatted.details.structuredReply, undefined);
	assert.equal(unparsable.formatted.isError, false);

	const parsed = formatReleasedReply({
		toolName: "contact_supervisor",
		args,
		outcome: reply('{"responses":[{"id":"choice","value":"yes"}]}'),
	});
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.deepEqual(parsed.formatted.details, { structuredReply: { responses: [{ id: "choice", value: "yes" }] } });
	assert.equal(Object.hasOwn(parsed.formatted.details, "structuredReplyParseError"), false);
});

test("an ask's reply is a successful result carrying the replier's name and text, and a reply error is a failed one (#4326)", () => {
	const ok = formatReleasedReply({ toolName: "intercom", args: { to: "peer" }, outcome: reply("yes") });
	assert.deepEqual(ok, {
		ok: true,
		formatted: { content: [{ type: "text", text: "**Reply from peer:**\nyes" }], details: {}, isError: false },
	});
	const failed = formatReleasedReply({
		toolName: "intercom",
		args: { to: "peer" },
		outcome: { kind: "reply", reply: { replyTo: "q-1", text: "", replyError: "peer is gone" } },
	});
	assert.deepEqual(failed, {
		ok: true,
		formatted: {
			content: [{ type: "text", text: "Failed: peer is gone" }],
			details: { error: true, replyTo: "q-1" },
			isError: true,
		},
	});
});
