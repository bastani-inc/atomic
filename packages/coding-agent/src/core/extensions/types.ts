/**
 * Extension system types.
 *
 * Extensions are TypeScript modules that can:
 * - Subscribe to agent lifecycle events
 * - Register LLM-callable tools
 * - Register commands, keyboard shortcuts, and CLI flags
 * - Interact with the user via UI primitives
 *
 * This file preserves the public import path for extension authors while the
 * declarations live in responsibility-focused sibling modules.
 */

export type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode } from "@earendil-works/pi-agent-core";
export type { ExecOptions, ExecResult } from "../exec.ts";
export type { AppKeybinding, KeybindingsManager } from "../keybindings.ts";
export type { BuildSystemPromptOptions } from "../system-prompt.ts";
export type * from "./agent-events.ts";
export type * from "./api-types.ts";
export type * from "./command-types.ts";
export type * from "./context-types.ts";
export type * from "./event-results.ts";
export type * from "./event-types.ts";
export type * from "./message-types.ts";
export type * from "./provider-types.ts";
export type * from "./runtime-types.ts";
export type * from "./session-events.ts";
export type * from "./tool-events.ts";
export type * from "./tool-types.ts";
export type * from "./ui-types.ts";

export { defineTool } from "./tool-types.ts";
export {
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWriteToolResult,
} from "./tool-events.ts";
