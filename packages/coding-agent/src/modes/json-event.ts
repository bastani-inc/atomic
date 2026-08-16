import type { Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../core/agent-session.ts";

type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

type ToJsonEvent<T> = T extends {
	type: "message_update";
	assistantMessageEvent: infer TAssistantMessageEvent;
}
	? {
			type: "message_update";
			usage: Usage;
			endTurn?: boolean;
			assistantMessageEvent: WithoutPartial<TAssistantMessageEvent>;
		}
	: T;

/** Session event shape emitted by the JSON and RPC stdout protocols. */
export type JsonAgentSessionEvent = ToJsonEvent<AgentSessionEvent>;

type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type JsonMessageUpdateEvent = Extract<JsonAgentSessionEvent, { type: "message_update" }>;

/**
 * Remove cumulative assistant snapshots from streaming wire events.
 * `message_start` provides the initial message, deltas build it, and
 * `message_end` provides the final authoritative message. Cumulative usage
 * and the provider's end-of-turn signal remain available because their size
 * is constant.
 */
export function toJsonEvent(event: MessageUpdateEvent): JsonMessageUpdateEvent;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent {
	if (event.type !== "message_update") {
		return event;
	}
	if (event.message.role !== "assistant") {
		throw new Error("message_update message is not an assistant message");
	}

	const assistantMessageEvent = event.assistantMessageEvent;
	const usage = event.message.usage;
	const endTurn = event.message.endTurn;
	if (!("partial" in assistantMessageEvent)) {
		return withEndTurn({ type: "message_update", usage, assistantMessageEvent }, endTurn);
	}

	const { partial: _partial, ...deltaEvent } = assistantMessageEvent;
	return withEndTurn({ type: "message_update", usage, assistantMessageEvent: deltaEvent }, endTurn);
}

/**
 * Carry the provider's end-of-turn signal only when the provider reported one.
 * A present-but-undefined key would make "the provider said nothing" look like
 * a reported value, so an unreported signal leaves the key off the frame.
 */
function withEndTurn(update: JsonMessageUpdateEvent, endTurn: boolean | undefined): JsonMessageUpdateEvent {
	if (endTurn === undefined) return update;
	return { ...update, endTurn };
}
