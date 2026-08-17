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
	UIPromptEndEvent,
	UIPromptStartEvent,
	UserBashEvent,
} from "./agent-events.ts";
import type { AgentBlockedEvent, AgentUnblockedEvent } from "./block-types.js";
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
	| UIPromptStartEvent
	| UIPromptEndEvent
	| AgentBlockedEvent
	| AgentUnblockedEvent
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
