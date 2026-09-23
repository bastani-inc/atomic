import type { ProviderHeaders, ProviderId } from "@bastani/pi-ai";
import type {
	Api,
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolResultMessage,
	Usage,
} from "@bastani/pi-ai/compat";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ContextEditEntry, ProjectedSessionEntry } from "../session-manager-types.ts";
import type { NormalizedBuildSystemPromptOptions } from "../system-prompt.ts";
import type { ExtensionMode } from "./context-types.ts";
import type { ExtensionUIContext } from "./ui-types.js";

// ============================================================================
// Agent Events
// ============================================================================

/**
 * Fired before each LLM call. Can modify messages.
 *
 * `messages` holds the conversation without system messages. The prompt and tool state
 * belong to Atomic: it restores them after the handler returns, so a handler cannot drop
 * them and does not need to preserve them.
 */
export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

/**
 * Fired before each LLM call, after every `context` handler has run and Atomic has restored
 * the prompt and tool state. `messages` is the full transcript including system messages,
 * and the result is sent as returned: the handler owns the prompt and tool declarations.
 */
export interface ContextWithSystemEvent {
	type: "context_with_system";
	messages: AgentMessage[];
}

/** Fired before a provider request is sent. Can replace the payload. */
export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	payload: unknown;
}

/** Fired after request headers are assembled and immediately before provider dispatch. */
export interface BeforeProviderHeadersEvent {
	type: "before_provider_headers";
	headers: ProviderHeaders;
}

/** Fired after a provider response is received and before the response stream is consumed. */
export interface AfterProviderResponseEvent {
	type: "after_provider_response";
	status: number;
	headers: Record<string, string>;
}

/** Fired for a parsed provider stream event before Atomic normalizes it. */
export interface ProviderStreamEvent {
	type: "provider_stream_event";
	provider: ProviderId;
	api: Api;
	model: string;
	data: unknown;
}

/** Fired after user submits prompt but before agent loop. */
export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	/** The raw user prompt text (after expansion). */
	prompt: string;
	/** Images attached to the user prompt, if any. */
	images?: ImageContent[];
	/** The fully assembled system prompt string. */
	systemPrompt: string;
	/** Mutable prompt options for this run. Later handlers see earlier edits. */
	systemPromptOptions: NormalizedBuildSystemPromptOptions;
}

/** Fired when an agent loop starts */
export interface AgentStartEvent {
	type: "agent_start";
}

/** Fired when an agent loop ends */
export interface AgentEndEvent {
	type: "agent_end";
	messages: AgentMessage[];
}

export type AgentActivityOutcome = "completed" | "aborted" | "error";

export interface CustomEntryDraft {
	type: "custom";
	customType: string;
	data?: unknown;
}

export interface CustomMessageEntryDraft {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: unknown;
}

export interface ContextEditEntryDraft {
	type: "context_edit";
	targetId: string;
	replacement: ContextEditEntry["replacement"];
}

export interface CompactionEntryDraft {
	type: "compaction";
	/** Compacted transcript text that replaces everything before `firstKeptEntryId`. */
	summary: string;
	/** Null keeps no preceding entries: the summary replaces the entire pre-boundary transcript. */
	firstKeptEntryId: string | null;
	usage?: Usage;
}

export type SessionBoundaryDraft =
	| CustomEntryDraft
	| CustomMessageEntryDraft
	| ContextEditEntryDraft
	| CompactionEntryDraft;

export interface BoundaryContextPreview {
	contextEntries: ProjectedSessionEntry[];
	contextMessages: AgentMessage[];
	llmMessages: Message[];
	pendingMessages: AgentMessage[];
	canContinue: boolean;
}

export interface BoundaryState {
	entries: SessionBoundaryDraft[];
	continue: boolean;
	context: BoundaryContextPreview;
	outcome: AgentActivityOutcome;
}

export interface BoundaryResult {
	entries?: SessionBoundaryDraft[];
	continue?: boolean;
}

/** Fired before final settlement. May append entries and ensure one next provider request. */
export interface AgentBeforeSettleEvent extends BoundaryState {
	type: "agent_before_settle";
}

/** Fired when the agent has fully settled after retries, compaction, and queued continuations. */
export interface AgentSettledEvent {
	type: "agent_settled";
}

export type UIPromptKind = "select" | "confirm" | "input" | "editor" | "custom";

/** Fired when Atomic starts waiting on a blocking extension UI prompt or the built-in /trust selector. */
export interface UIPromptStartEvent {
	type: "ui_prompt_start";
	reason: "ui_prompt" | "project_trust";
	kind: UIPromptKind;
	title?: string;
}

/** Fired when Atomic is no longer waiting on a blocking extension UI prompt or the built-in /trust selector. */
export interface UIPromptEndEvent {
	type: "ui_prompt_end";
	reason: "ui_prompt" | "project_trust";
	kind: UIPromptKind;
	title?: string;
}

/** Fired at the start of each turn */
export interface TurnStartEvent {
	type: "turn_start";
	turnIndex: number;
	timestamp: number;
}

/** Fired at the end of each turn */
export interface TurnEndEvent extends BoundaryState {
	type: "turn_end";
	turnIndex: number;
	message: AgentMessage;
	toolResults: ToolResultMessage[];
	messageEntryId: string;
	toolResultEntryIds: string[];
}

/** Fired when a message starts (user, assistant, or toolResult) */
export interface MessageStartEvent {
	type: "message_start";
	message: AgentMessage;
}

/** Fired during assistant message streaming with token-by-token updates */
export interface MessageUpdateEvent {
	type: "message_update";
	assistantMessageEvent: AssistantMessageEvent;
}

/** Fired when a message ends */
export interface MessageEndEvent {
	type: "message_end";
	message: AgentMessage;
}

/** Fired when a tool starts executing */
export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: unknown;
}

/** Fired during tool execution with partial/streaming output */
export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	args: unknown;
	partialResult: unknown;
}

/** Fired when a tool finishes executing */
export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
}

// ============================================================================
// Model Events
// ============================================================================

export type ModelSelectSource = "set" | "cycle" | "restore" | "fallback";

/** Fired when a new model is selected */
export interface ModelSelectEvent {
	type: "model_select";
	model: Model<Api>;
	previousModel: Model<Api> | undefined;
	source: ModelSelectSource;
}

/** Fired when a new thinking level is selected */
export interface ThinkingLevelSelectEvent {
	type: "thinking_level_select";
	level: ThinkingLevel;
	previousLevel: ThinkingLevel;
}

// ============================================================================
// Project Trust Events
// ============================================================================

export interface ProjectTrustEvent {
	type: "project_trust";
	cwd: string;
}

export type ProjectTrustEventDecision = "yes" | "no" | "undecided";

export interface ProjectTrustEventResult {
	trusted: ProjectTrustEventDecision;
	remember?: boolean;
}

export interface ProjectTrustContext {
	cwd: string;
	mode: ExtensionMode;
	hasUI: boolean;
	ui: Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify">;
}

export type ProjectTrustHandler = (
	event: ProjectTrustEvent,
	ctx: ProjectTrustContext,
) => Promise<ProjectTrustEventResult> | ProjectTrustEventResult;

// ============================================================================
// User Bash Events
// ============================================================================

/** Fired when user executes a bash command via ! or !! prefix */
export interface UserBashEvent {
	type: "user_bash";
	/** The command to execute */
	command: string;
	/** True if !! prefix was used (excluded from LLM context) */
	excludeFromContext: boolean;
	/** Current working directory */
	cwd: string;
}

// ============================================================================
// Input Events
// ============================================================================

/** Source of user input */
export type InputSource = "interactive" | "rpc" | "extension";

/** Fired when user input is received, before agent processing */
export interface InputEvent {
	type: "input";
	/** The input text */
	text: string;
	/** Attached images, if any */
	images?: ImageContent[];
	/** Where the input came from */
	source: InputSource;
	/** How the input will be queued when streaming. Undefined means immediate/normal handling. */
	streamingBehavior?: "steer" | "followUp";
}

/** Result from input event handler */
export type InputEventResult =
	| { action: "continue" }
	| { action: "transform"; text: string; images?: ImageContent[] }
	| { action: "handled" };
