import type { AssistantMessageEvent } from "@bastani/pi-ai/compat";
import type {
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionCompactFailedEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
} from "../../src/index.ts";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Condition extends true> = Condition;

export type MessageStartEventRootExport = Assert<Equal<MessageStartEvent["type"], "message_start">>;
export type MessageUpdateEventRootExport = Assert<
	Equal<MessageUpdateEvent, { type: "message_update"; assistantMessageEvent: AssistantMessageEvent }>
>;
export type MessageEndEventRootExport = Assert<Equal<MessageEndEvent["type"], "message_end">>;
export type ToolExecutionStartEventRootExport = Assert<Equal<ToolExecutionStartEvent["type"], "tool_execution_start">>;
export type ToolExecutionUpdateEventRootExport = Assert<
	Equal<ToolExecutionUpdateEvent["type"], "tool_execution_update">
>;
export type ToolExecutionEndEventRootExport = Assert<Equal<ToolExecutionEndEvent["type"], "tool_execution_end">>;
export type SessionBeforeCompactEventRootExport = Assert<
	Equal<SessionBeforeCompactEvent["type"], "session_before_compact">
>;
export type SessionCompactEventRootExport = Assert<Equal<SessionCompactEvent["type"], "session_compact">>;
export type SessionCompactFailedEventRootExport = Assert<
	Equal<
		SessionCompactFailedEvent,
		{
			type: "session_compact_failed";
			reason: "manual" | "threshold" | "overflow";
			errorMessage?: string;
			aborted: boolean;
			willRetry: boolean;
			fromExtension: boolean;
		}
	>
>;
