import type {
	AfterProviderResponseEvent,
	AgentEndEvent,
	AgentSettledEvent,
	AgentStartEvent,
	BeforeAgentStartEvent,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	ContextEvent,
	InputEvent,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ModelSelectEvent,
	ProjectTrustEvent,
	ThinkingLevelSelectEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TurnEndEvent,
	TurnStartEvent,
	UserBashEvent,
} from "./agent-events.ts";
import type { ResourcesDiscoverEvent, SessionEvent } from "./session-events.ts";
import type { ToolCallEvent, ToolResultEvent } from "./tool-events.ts";

/** Union of all event types */
export type ExtensionEvent =
	| ResourcesDiscoverEvent
	| SessionEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| BeforeProviderHeadersEvent
	| AfterProviderResponseEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| AgentSettledEvent
	| TurnStartEvent
	| TurnEndEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| ModelSelectEvent
	| ThinkingLevelSelectEvent
	| UserBashEvent
	| ProjectTrustEvent
	| InputEvent
	| ToolCallEvent
	| ToolResultEvent;
