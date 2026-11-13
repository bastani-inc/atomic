import type { JsonValue } from "@bastani/pi-ai";
import { formatAttachments, parseStructuredSupervisorReply, validateSupervisorInterviewRequest } from "./intercom-utils.js";
import { ASK_REPLY_TIMEOUT_MS } from "./retry-policy.js";
import type { Message } from "./types.js";

/** Subagents → Intercom: turn a released asker's saved reply or deadline into the result its inline call returns. */
export const RELEASED_REPLY_FORMAT_EVENT = "intercom:format-released-reply";

export interface ReleasedReplyPayload {
	readonly replyTo: string;
	readonly text: string;
	readonly replyError?: string;
	readonly attachments?: Message["content"]["attachments"];
}

export type ReleasedReplyOutcome =
	| { readonly kind: "reply"; readonly reply: ReleasedReplyPayload }
	| { readonly kind: "timeout"; readonly from: string; readonly retryCount: number };

export interface FormattedReleasedReply {
	readonly content: { type: "text"; text: string }[];
	readonly details: Record<string, JsonValue>;
	readonly isError: boolean;
}

export type ReleasedReplyFormatResult =
	| { readonly ok: true; readonly formatted: FormattedReleasedReply }
	| { readonly ok: false; readonly reason: string };

export interface ReleasedReplyFormatRequest {
	readonly toolName: string;
	readonly args: { readonly to?: string; readonly reason?: string; readonly interview?: object };
	readonly outcome: ReleasedReplyOutcome;
	result?: ReleasedReplyFormatResult;
}

function isReleasedReplyFormatRequest(payload: unknown): payload is ReleasedReplyFormatRequest {
	if (typeof payload !== "object" || payload === null) return false;
	const request = payload as Partial<ReleasedReplyFormatRequest>;
	return (
		typeof request.toolName === "string" &&
		typeof request.args === "object" &&
		request.args !== null &&
		typeof request.outcome === "object" &&
		request.outcome !== null
	);
}

function formatTimeout(toolName: string, from: string): FormattedReleasedReply {
	// #4751: an `ask` has no reply timeout; its wait ended and the ask stays pending.
	if (toolName === "intercom")
		return {
			content: [{ type: "text", text: `No reply from "${from}" yet; stopped waiting. The ask stays pending.` }],
			details: { pending: true },
			isError: false,
		};
	const reason = `Failed: No reply from "${from}" within ${Math.round(ASK_REPLY_TIMEOUT_MS / 60_000)} minutes`;
	return { content: [{ type: "text", text: reason }], details: { error: true }, isError: true };
}

/** The result an `intercom` ask or a `contact_supervisor` request returns inline for the same reply or deadline. */
export function formatReleasedReply(request: Omit<ReleasedReplyFormatRequest, "result">): ReleasedReplyFormatResult {
	const { toolName, args, outcome } = request;
	if (outcome.kind === "timeout")
		return { ok: true, formatted: formatTimeout(toolName, outcome.from) };
	const reply = outcome.reply;
	const attachments = reply.attachments?.length ? formatAttachments(reply.attachments) : "";
	if (toolName === "intercom") {
		if (reply.replyError !== undefined)
			return {
				ok: true,
				formatted: {
					content: [{ type: "text", text: `Failed: ${reply.replyError}` }],
					details: { error: true, replyTo: reply.replyTo },
					isError: true,
				},
			};
		return {
			ok: true,
			formatted: {
				content: [{ type: "text", text: `**Reply from ${args.to}:**\n${reply.text}${attachments}` }],
				details: {},
				isError: false,
			},
		};
	}
	const interview = args.reason === "interview_request" ? validateSupervisorInterviewRequest(args.interview) : undefined;
	if (interview?.ok === false) return { ok: false, reason: "the pending interview is invalid" };
	const structured = interview?.ok === true ? parseStructuredSupervisorReply(reply.text, interview.interview) : undefined;
	const details: Record<string, JsonValue> = {};
	if (structured?.value !== undefined)
		details.structuredReply = {
			responses: structured.value.responses.map(({ id, value }) => ({ id, value: value as string | string[] })),
		};
	else if (structured !== undefined) details.structuredReplyParseError = structured.error ?? "";
	return {
		ok: true,
		formatted: {
			content: [{ type: "text", text: `**Reply from supervisor:**\n${reply.text}${attachments}` }],
			details,
			isError: false,
		},
	};
}

/** Answer format requests on `events`; returns the function that stops answering them. */
export function answerReleasedReplyFormatRequests(events: {
	on(channel: string, handler: (data: unknown) => void): () => void;
}): () => void {
	return events.on(RELEASED_REPLY_FORMAT_EVENT, (payload) => {
		if (!isReleasedReplyFormatRequest(payload) || payload.result !== undefined) return;
		payload.result = formatReleasedReply(payload);
	});
}
