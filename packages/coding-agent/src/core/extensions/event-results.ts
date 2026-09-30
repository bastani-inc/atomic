import type { ImageContent, TextContent } from "@bastani/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BashResult } from "../bash-executor.ts";
import type { CustomMessage } from "../messages.ts";
import type { BashOperations } from "../tools/bash.js";
import type { BoundaryResult } from "./agent-events.ts";

export interface ContextEventResult {
	messages?: AgentMessage[];
}

export type TurnEndEventResult = BoundaryResult;
export type AgentBeforeSettleEventResult = BoundaryResult;

export type BeforeProviderRequestEventResult = unknown;

export interface ToolCallEventResult {
	/** Block tool execution. To modify arguments, mutate `event.input` in place instead. */
	block?: boolean;
	reason?: string;
	/**
	 * Hint that the agent should stop after the current tool batch when this call is blocked.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

/** Result from user_bash event handler */
export type UserBashEventResult =
	| { operations: BashOperations; result?: never }
	| { operations?: never; result: BashResult };

export interface ToolResultEventResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	/** Content replacement without this field drops machine-readable data to prevent redaction leaks. */
	structuredContent?: import("@bastani/pi-ai").JsonValue;
	usage?: import("@bastani/pi-ai").Usage;
}

export interface MessageEndEventResult {
	/** Replace the finalized message. The replacement must keep the original message role. */
	message?: AgentMessage;
}

export interface BeforeAgentStartEventResult {
	message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
	/** Replace the system prompt for this turn. If multiple extensions return this, they are chained. */
	systemPrompt?: string;
}

export interface SessionBeforeSwitchResult {
	cancel?: boolean;
}

export interface SessionBeforeForkResult {
	cancel?: boolean;
	skipConversationRestore?: boolean;
}

export interface SessionBeforeCompactResult {
	cancel?: boolean;
	/** Full verbatim replacement for the compactable region. */
	compactedText?: string;
}

export interface SessionBeforeTreeResult {
	cancel?: boolean;
	summary?: {
		summary: string;
		details?: unknown;
	};
	/** Override custom instructions for summarization */
	customInstructions?: string;
	/** Override whether customInstructions replaces the default prompt */
	replaceInstructions?: boolean;
	/** Override label to attach to the branch summary entry */
	label?: string;
}
