import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentWakeDispatcher, DetachedToolCall, DetachedToolResult, SessionManager } from "@bastani/atomic";
import type { JsonValue } from "@bastani/pi-ai";
import {
	formatAttachments,
	parseStructuredSupervisorReply,
	validateSupervisorInterviewRequest,
} from "../../../../intercom/intercom-utils.js";
import { RELEASED_REPLY_WAIT_ENTRY, type ReleasedReplyWaitData } from "../../../../intercom/released-reply-wait.js";
import { ASK_REPLY_TIMEOUT_MS } from "../../../../intercom/retry-policy.js";
import { intercomRecoveryStoppedText } from "../../../../intercom/tool-retry.js";
import type { Message } from "../../../../intercom/types.js";
import { ReleasedChildError } from "./released-child-errors.js";
import type { SubagentChildWaitingCall } from "./subagent-child-records.js";

/** Read only plain correlation facts from the child's saved session, for calls that actually detached. */
export function releasedChildWaitingCalls(
	manager: Pick<SessionManager, "getEntries">,
	calls: readonly DetachedToolCall[],
): SubagentChildWaitingCall[] {
	const waits = new Map<string, ReleasedReplyWaitData>();
	for (const entry of manager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== RELEASED_REPLY_WAIT_ENTRY) continue;
		const data = entry.data as Partial<ReleasedReplyWaitData> | undefined;
		if (
			typeof data?.toolCallId !== "string" ||
			typeof data.questionId !== "string" ||
			typeof data.deadline !== "number" ||
			typeof data.from !== "string" ||
			typeof data.retryCount !== "number"
		)
			continue;
		waits.set(data.toolCallId, data as ReleasedReplyWaitData);
	}
	return calls.map(({ toolCallId, toolName }) => {
		const wait = waits.get(toolCallId);
		return {
			toolCallId,
			toolName,
			...(wait === undefined
				? {}
				: {
						replyWait: {
							questionId: wait.questionId,
							deadline: wait.deadline,
							from: wait.from,
							retryCount: wait.retryCount,
						},
					}),
		};
	});
}

export function releasedReplyTimeoutId(questionId: string): string {
	return `reply-timeout:${questionId}`;
}

const outsideAnyTask = AsyncLocalStorage.snapshot();

/** All deadlines share the wake dispatcher's timer. */
export function scheduleReleasedReplyTimeouts(
	dispatcher: AgentWakeDispatcher,
	wakeKey: string,
	calls: readonly SubagentChildWaitingCall[],
): void {
	outsideAnyTask(() => {
		for (const call of calls) {
			const wait = call.replyWait;
			if (wait === undefined) continue;
			dispatcher.schedule(
				wakeKey,
				{
					id: releasedReplyTimeoutId(wait.questionId),
					kind: "tool-result",
					toolResult: releasedReplyTimeout(call),
				},
				wait.deadline - Date.now(),
			);
		}
	});
}

/** Hold the broker's reply durably; formatting happens with the reopened child's own transcript. */
export function releasedReplyToolResult(
	call: Pick<SubagentChildWaitingCall, "toolCallId" | "toolName">,
	message: Message,
): DetachedToolResult {
	if (message.replyTo === undefined)
		throw new ReleasedChildError("wake-failed", { reason: "the reply has no question id" });
	const reply = {
		replyTo: message.replyTo,
		text: message.content.text,
		...(message.replyError === undefined ? {} : { replyError: message.replyError }),
		...(message.content.attachments === undefined
			? {}
			: {
					attachments: message.content.attachments.map(({ type, name, content, language }) => ({
						type,
						name,
						content,
						...(language === undefined ? {} : { language }),
					})),
				}),
	};
	return { ...call, result: { content: [], details: { releasedIntercomReply: reply } }, isError: false };
}

export function releasedReplyTimeout(call: SubagentChildWaitingCall): DetachedToolResult {
	const reason = `Failed: No reply from "${call.replyWait?.from}" within ${Math.round(ASK_REPLY_TIMEOUT_MS / 60_000)} minutes`;
	const retries = call.replyWait?.retryCount ?? 0;
	const intercom = call.toolName === "intercom";
	return {
		toolCallId: call.toolCallId,
		toolName: call.toolName,
		result: {
			content: [{ type: "text", text: intercom ? intercomRecoveryStoppedText(reason, retries) : reason }],
			details: intercom
				? { error: true, terminal: true, automaticRetries: retries, outcome: "unknown" }
				: { error: true },
		},
		isError: true,
	};
}

/** Convert held replies using the reopened child's pending calls, exactly as their inline tools do. */
export function formatReleasedReplyResults(
	manager: Pick<SessionManager, "buildSessionProjection">,
	results: readonly DetachedToolResult[],
): DetachedToolResult[] {
	const messages = manager.buildSessionProjection().messages;
	return results.map((result): DetachedToolResult => {
		const message = (
			result.result.details as
				| {
						releasedIntercomReply?: {
							replyTo: string;
							text: string;
							replyError?: string;
							attachments?: Message["content"]["attachments"];
						};
				  }
				| undefined
		)?.releasedIntercomReply;
		if (message === undefined) return result;
		const call = messages
			.flatMap((entry) => (entry.role === "assistant" ? entry.content : []))
			.find((part) => part.type === "toolCall" && part.id === result.toolCallId);
		if (call?.type !== "toolCall")
			throw new ReleasedChildError("child-unrestorable", { reason: "the pending reply call is missing" });
		const args = call.arguments as { to?: string; reason?: string; interview?: object };
		const attachments = message.attachments?.length ? formatAttachments(message.attachments) : "";
		if (result.toolName === "intercom") {
			if (message.replyError !== undefined)
				return {
					...result,
					isError: true,
					result: {
						content: [{ type: "text", text: `Failed: ${message.replyError}` }],
						details: { error: true, replyTo: message.replyTo },
					},
				};
			return {
				...result,
				result: {
					content: [{ type: "text", text: `**Reply from ${args.to}:**\n${message.text}${attachments}` }],
					details: {},
				},
			};
		}
		const interview =
			args.reason === "interview_request" ? validateSupervisorInterviewRequest(args.interview) : undefined;
		if (interview?.ok === false)
			throw new ReleasedChildError("child-unrestorable", { reason: "the pending interview is invalid" });
		const structured =
			interview?.ok === true ? parseStructuredSupervisorReply(message.text, interview.interview) : undefined;
		const details: Record<string, JsonValue> = {};
		if (structured?.value !== undefined)
			details.structuredReply = {
				responses: structured.value.responses.map(({ id, value }) => ({ id, value: value as string | string[] })),
			};
		else if (structured !== undefined) details.structuredReplyParseError = structured.error ?? "";
		return {
			...result,
			result: {
				content: [{ type: "text", text: `**Reply from supervisor:**\n${message.text}${attachments}` }],
				details,
			},
		};
	});
}
