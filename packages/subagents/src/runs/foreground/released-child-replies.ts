import { AsyncLocalStorage } from "node:async_hooks";
import type {
	AgentWake,
	AgentWakeDispatcher,
	DetachedToolCall,
	DetachedToolResult,
	SessionManager,
} from "@bastani/atomic";
import type { Message } from "../../../../intercom/types.js";
import type { IntercomEventBus } from "../../shared/types.js";
import { ReleasedChildError } from "./released-child-errors.js";
import {
	RELEASED_REPLY_FORMAT_EVENT,
	RELEASED_REPLY_WAIT_ENTRY,
	type ReleasedReplyFormatRequest,
	type ReleasedReplyPayload,
	type ReleasedReplyWaitData,
} from "./released-reply-protocol.js";
import type { SubagentChildRecord, SubagentChildWaitingCall } from "./subagent-child-records.js";

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

const REPLY_TIMEOUT_PREFIX = "reply-timeout:";

export function releasedReplyTimeoutId(questionId: string): string {
	return `${REPLY_TIMEOUT_PREFIX}${questionId}`;
}

/**
 * Give each deadline wake the timeout result of the call it is for, built from the child's record, and drop one whose
 * call already has its result or is no longer waited on: a deadline carries no payload of its own, so a released
 * asker costs the dispatcher one plain node, and a reply that came first is never overtaken by its own deadline.
 */
export function withReleasedReplyTimeouts(
	record: Pick<SubagentChildRecord, "waitingOn" | "heldToolResults">,
	wakes: readonly AgentWake[],
): AgentWake[] {
	return wakes.flatMap((wake): AgentWake[] => {
		if (!wake.id.startsWith(REPLY_TIMEOUT_PREFIX)) return [wake];
		const questionId = wake.id.slice(REPLY_TIMEOUT_PREFIX.length);
		const call = record.waitingOn?.find((waiting) => waiting.replyWait?.questionId === questionId);
		if (call === undefined || (record.heldToolResults ?? []).some((held) => held.toolCallId === call.toolCallId))
			return [];
		return [{ ...wake, toolResult: releasedReplyTimeout(call) }];
	});
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
				{ id: releasedReplyTimeoutId(wait.questionId), kind: "tool-result" },
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

/** A plain marker the child's wake turns into the timeout result its inline call returns. */
export function releasedReplyTimeout(call: SubagentChildWaitingCall): DetachedToolResult {
	return {
		toolCallId: call.toolCallId,
		toolName: call.toolName,
		result: {
			content: [],
			details: {
				releasedIntercomTimeout: { from: call.replyWait?.from ?? "", retryCount: call.replyWait?.retryCount ?? 0 },
			},
		},
		isError: true,
	};
}

type ReleasedReplyTimeoutMarker = { readonly from: string; readonly retryCount: number };

type ReleasedReplyMarker =
	| { readonly releasedIntercomReply: ReleasedReplyPayload }
	| { readonly releasedIntercomTimeout: ReleasedReplyTimeoutMarker };

function releasedReplyMarker(result: DetachedToolResult): ReleasedReplyMarker | undefined {
	const details = result.result.details as
		| { releasedIntercomReply?: ReleasedReplyPayload; releasedIntercomTimeout?: ReleasedReplyTimeoutMarker }
		| undefined;
	if (details?.releasedIntercomReply !== undefined) return { releasedIntercomReply: details.releasedIntercomReply };
	if (details?.releasedIntercomTimeout !== undefined)
		return { releasedIntercomTimeout: details.releasedIntercomTimeout };
	return undefined;
}

function pendingCallArguments(
	messages: ReturnType<SessionManager["buildSessionProjection"]>["messages"],
	toolCallId: string,
): ReleasedReplyFormatRequest["args"] {
	const call = messages
		.flatMap((entry) => (entry.role === "assistant" ? entry.content : []))
		.find((part) => part.type === "toolCall" && part.id === toolCallId);
	if (call?.type !== "toolCall")
		throw new ReleasedChildError("child-unrestorable", { reason: "the pending reply call is missing" });
	return call.arguments as ReleasedReplyFormatRequest["args"];
}

/**
 * Convert held replies and deadlines into the results their inline calls return, using the reopened child's pending
 * calls. Intercom does the formatting; without it loaded the child cannot be given its reply.
 */
export function formatReleasedReplyResults(
	manager: Pick<SessionManager, "buildSessionProjection">,
	results: readonly DetachedToolResult[],
	events: Pick<IntercomEventBus, "emit">,
): DetachedToolResult[] {
	if (!results.some((result) => releasedReplyMarker(result) !== undefined)) return [...results];
	const messages = manager.buildSessionProjection().messages;
	return results.map((result): DetachedToolResult => {
		const marker = releasedReplyMarker(result);
		if (marker === undefined) return result;
		const request: ReleasedReplyFormatRequest =
			"releasedIntercomReply" in marker
				? {
						toolName: result.toolName,
						args: pendingCallArguments(messages, result.toolCallId),
						outcome: { kind: "reply", reply: marker.releasedIntercomReply },
					}
				: {
						toolName: result.toolName,
						args: {},
						outcome: { kind: "timeout", ...marker.releasedIntercomTimeout },
					};
		events.emit(RELEASED_REPLY_FORMAT_EVENT, request);
		const answer = request.result;
		if (answer === undefined)
			throw new ReleasedChildError("child-unrestorable", {
				reason: "Intercom is not loaded in the session that launched it, so its reply cannot be delivered",
			});
		if (!answer.ok) throw new ReleasedChildError("child-unrestorable", { reason: answer.reason });
		const { content, details, isError } = answer.formatted;
		return { ...result, result: { content, details }, isError };
	});
}
