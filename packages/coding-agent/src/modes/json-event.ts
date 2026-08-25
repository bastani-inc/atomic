import type { Usage } from "@bastani/pi-ai";
import type { AgentSessionEvent } from "../core/agent-session.ts";

type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;
type ToJsonAssistantMessageEvent<T> = T extends { type: "toolcall_start"; partial: unknown }
	? WithoutPartial<T> & { id?: string; toolName?: string }
	: WithoutPartial<T>;

type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type JsonMessageUpdateEvent = {
	type: "message_update";
	usage: Usage;
	endTurn?: boolean;
	assistantMessageEvent: ToJsonAssistantMessageEvent<MessageUpdateEvent["assistantMessageEvent"]>;
};

/** Session event shape emitted by the JSON and RPC stdout protocols. */
export type JsonAgentSessionEvent = Exclude<AgentSessionEvent, { type: "message_update" }> | JsonMessageUpdateEvent;

function toJsonAssistantMessageEvent(
	event: MessageUpdateEvent["assistantMessageEvent"],
): JsonMessageUpdateEvent["assistantMessageEvent"] {
	if (event.type === "toolcall_start") {
		const toolCall = event.partial.content[event.contentIndex];
		if (toolCall?.type !== "toolCall") {
			throw new Error(`toolcall_start content at index ${event.contentIndex} is not a tool call`);
		}
		const { partial: _partial, ...deltaEvent } = event;
		return { ...deltaEvent, id: toolCall.id, toolName: toolCall.name };
	}
	if (!("partial" in event)) return event;
	const { partial: _partial, ...deltaEvent } = event;
	return deltaEvent;
}

/** Remove cumulative assistant snapshots while retaining constant-size metadata. */
export function toJsonEvent(event: MessageUpdateEvent): JsonMessageUpdateEvent;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent {
	if (event.type !== "message_update") return event;
	if (event.message.role !== "assistant") throw new Error("message_update message is not an assistant message");
	return withEndTurn(
		{
			type: "message_update",
			usage: event.message.usage,
			assistantMessageEvent: toJsonAssistantMessageEvent(event.assistantMessageEvent),
		},
		event.message.endTurn,
	);
}

function withEndTurn(update: JsonMessageUpdateEvent, endTurn: boolean | undefined): JsonMessageUpdateEvent {
	if (endTurn === undefined) return update;
	return { ...update, endTurn };
}
