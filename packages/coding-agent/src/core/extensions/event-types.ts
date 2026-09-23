import type { CacheWarmingDecisionEvent } from "../cache-warmer.ts";
import type {
	AfterProviderResponseEvent,
	AgentBeforeSettleEvent,
	AgentEndEvent,
	AgentSettledEvent,
	AgentStartEvent,
	BeforeAgentStartEvent,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	ContextEvent,
	ContextWithSystemEvent,
	InputEvent,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ModelSelectEvent,
	ProjectTrustEvent,
	ProviderStreamEvent,
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
import type { ResourcesDiscoverEvent, SessionEvent } from "./session-events.ts";
import type { ToolCallEvent, ToolResultEvent } from "./tool-events.ts";
import type { WorkflowEvent } from "./workflow-events.js";

/** Union of all event types */
export type ExtensionEvent =
	| CacheWarmingDecisionEvent
	| WorkflowEvent
	| ResourcesDiscoverEvent
	| SessionEvent
	| ContextEvent
	| ContextWithSystemEvent
	| BeforeProviderRequestEvent
	| BeforeProviderHeadersEvent
	| AfterProviderResponseEvent
	| ProviderStreamEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| AgentBeforeSettleEvent
	| AgentSettledEvent
	| UIPromptStartEvent
	| UIPromptEndEvent
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
