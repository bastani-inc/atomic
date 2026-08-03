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

import type { ExtensionContext } from "./context-types.ts";

export type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode } from "@earendil-works/pi-agent-core";
export type { ExecOptions, ExecResult } from "../exec.ts";
export type { AppKeybinding, KeybindingsManager } from "../keybindings.ts";
export type { ScopedModel } from "../model-resolver.ts";
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
export {
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isLsToolResult,
	isReadToolResult,
	isSearchToolResult,
	isToolCallEventType,
	isWriteToolResult,
} from "./tool-events.ts";
export type * from "./tool-types.ts";

export { defineTool } from "./tool-types.ts";
export type * from "./ui-types.ts";

/**
 * The read-only model scope an extension reads as `ctx.scopedModels`.
 *
 * The member itself is declared on `ExtensionContext` in `./context-types.ts`,
 * which this barrel re-exports. The alias re-states it here, at the public
 * import path, so an extension can name the accessor's type without reaching
 * into an internal module, and so dropping or renaming `scopedModels` on
 * `ExtensionContext` fails this file at compile time instead of silently
 * removing it from the published surface.
 */
export type ExtensionScopedModels = ExtensionContext["scopedModels"];
