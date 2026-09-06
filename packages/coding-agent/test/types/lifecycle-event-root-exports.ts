import type { AssistantMessageEvent } from "@bastani/pi-ai/compat";
import type {
	UIPromptEndEvent as CoreUIPromptEndEvent,
	UIPromptKind as CoreUIPromptKind,
	UIPromptStartEvent as CoreUIPromptStartEvent,
} from "../../src/core/extensions/index.ts";
import type {
	ExtensionAPI,
	ExtensionEvent,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionCompactFailedEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	UIPromptEndEvent,
	UIPromptKind,
	UIPromptStartEvent,
} from "../../src/index.ts";
import type {
	UIPromptEndEvent as ExtensionBarrelUIPromptEndEvent,
	UIPromptKind as ExtensionBarrelUIPromptKind,
	UIPromptStartEvent as ExtensionBarrelUIPromptStartEvent,
} from "../../src/index-extensions.ts";

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

export type UIPromptKindRootExport = Assert<Equal<UIPromptKind, "select" | "confirm" | "input" | "editor" | "custom">>;
// #2873: the public lifecycle payload also identifies host-owned /trust waits.
export type UIPromptStartEventRootExport = Assert<
	Equal<
		UIPromptStartEvent,
		{
			type: "ui_prompt_start";
			reason: "ui_prompt" | "project_trust";
			kind: UIPromptKind;
			title?: string;
		}
	>
>;
export type UIPromptEndEventRootExport = Assert<
	Equal<
		UIPromptEndEvent,
		{
			type: "ui_prompt_end";
			reason: "ui_prompt" | "project_trust";
			kind: UIPromptKind;
			title?: string;
		}
	>
>;
export type UIPromptStartExtensionEvent = Assert<
	Equal<Extract<ExtensionEvent, { type: "ui_prompt_start" }>, UIPromptStartEvent>
>;
export type UIPromptEndExtensionEvent = Assert<
	Equal<Extract<ExtensionEvent, { type: "ui_prompt_end" }>, UIPromptEndEvent>
>;
export type UIPromptCoreBarrelExports = Assert<
	Equal<
		[CoreUIPromptKind, CoreUIPromptStartEvent, CoreUIPromptEndEvent],
		[UIPromptKind, UIPromptStartEvent, UIPromptEndEvent]
	>
>;
export type UIPromptExtensionBarrelExports = Assert<
	Equal<
		[ExtensionBarrelUIPromptKind, ExtensionBarrelUIPromptStartEvent, ExtensionBarrelUIPromptEndEvent],
		[UIPromptKind, UIPromptStartEvent, UIPromptEndEvent]
	>
>;

export function subscribeToUIPromptEvents(api: ExtensionAPI): void {
	api.on("ui_prompt_start", (event) => {
		const prompt: UIPromptStartEvent = event;
		void prompt;
	});
	api.on("ui_prompt_end", (event) => {
		const prompt: UIPromptEndEvent = event;
		void prompt;
	});
}
