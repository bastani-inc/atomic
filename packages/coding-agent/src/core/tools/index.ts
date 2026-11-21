export { createAskUserQuestionToolDefinition } from "./ask-user-question/index.ts";
export {
	BASH_SHELL_PRESENTATION,
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	bashToolSystemPromptContribution,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
	type ShellToolPresentation,
} from "./bash.js";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
	editToolSystemPromptContribution,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	EditInputError,
	type EditInputErrorCode,
	EditMatchError,
	type EditMatchErrorCode,
	EditTargetError,
	type EditTargetErrorCode,
	EditToolError,
	type EditToolErrorCode,
	type EditToolErrorFields,
	FileToolAbortedError,
	isEditInputError,
	isEditMatchError,
	isEditTargetError,
	isEditToolError,
	isFileToolAbortedError,
	isWriteSelectorError,
	rehydrateEditToolError,
	rehydrateWriteSelectorError,
	type SerializedErrorCause,
	type SerializedFileToolError,
	serializeFileToolError,
	WriteSelectorError,
	type WriteSelectorErrorCode,
	type WriteSelectorErrorFields,
} from "./file-tool-errors.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
	findToolSystemPromptContribution,
} from "./find.ts";
export { createKillTool, createKillToolDefinition, type KillToolOptions } from "./kill.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
	lsToolSystemPromptContribution,
} from "./ls.ts";
export {
	createLocalPowerShellOperations,
	createPowerShellTool,
	createPowerShellToolDefinition,
	type PowerShellOperations,
	type PowerShellSpawnContext,
	type PowerShellSpawnHook,
	type PowerShellToolDetails,
	type PowerShellToolInput,
	type PowerShellToolOptions,
} from "./powershell.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	readToolSystemPromptContribution,
} from "./read.ts";
export {
	createSearchTool,
	createSearchToolDefinition,
	type SearchToolDetails,
	type SearchToolInput,
	type SearchToolOptions,
	searchToolSystemPromptContribution,
} from "./search.ts";
export {
	createStructuredOutputCapture,
	createStructuredOutputTool,
	type JsonObject,
	type JsonPrimitive,
	type JsonValue,
	STRUCTURED_OUTPUT_TOOL_NAME,
	type StructuredOutputCapture,
	type StructuredOutputFileCapture,
	type StructuredOutputToolOptions,
} from "./structured-output.ts";
export { createTodoToolDefinition } from "./todos.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	sliceHead,
	sliceTail,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
	writeToolSystemPromptContribution,
} from "./write.ts";

import type { AgentTool } from "@bastani/atomic-agent-core";
import type { TSchema } from "@bastani/atomic-ai/utils/typebox";
import { isPowerShellAvailable, isPowerShellAvailableAsync } from "../../utils/shell.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	createAskUserQuestionToolDefinition,
	createLoadedAskUserQuestionToolDefinition,
} from "./ask-user-question/index.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.js";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createKillTool, createKillToolDefinition, type KillToolOptions } from "./kill.ts";
import { localEditOperations, localWriteOperations, withNotebookEditPreview } from "./local-file-operations.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createPowerShellTool, createPowerShellToolDefinition, type PowerShellToolOptions } from "./powershell.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createSearchTool, createSearchToolDefinition, type SearchToolOptions } from "./search.ts";
import { createTodoToolDefinition } from "./todos.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { createWriteToolDefinition, type WriteToolOptions } from "./write.ts";
import { withWriteSelectors } from "./write-selectors.ts";

export type Tool = AgentTool<TSchema, unknown>;
export type ToolDef = ToolDefinition<TSchema, unknown>;
export type ToolName =
	| "read"
	| "bash"
	| "powershell"
	| "kill"
	| "edit"
	| "write"
	| "find"
	| "search"
	| "ls"
	| "ask_user_question"
	| "todo";
export type BuiltinToolMap<T> = Omit<Record<ToolName, T>, "powershell"> & { powershell?: T };
// The universe of built-in tool names, matching the `ToolName` union exactly.
// Availability is decided per platform in `getDefaultToolNames()` and
// `createAllToolDefinitions()`; this set stays static so a name is never
// "unknown" merely because the host cannot run it.
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"powershell",
	"kill",
	"edit",
	"write",
	"find",
	"search",
	"ls",
	"ask_user_question",
	"todo",
]);

/**
 * Built-in tools enabled at startup.
 *
 * `powershell` is conditional: it is Windows-only and additionally needs a
 * resolvable `pwsh.exe`/`powershell.exe`. That probe reads PATH, so it runs per
 * call rather than at module load, and callers can decide it explicitly through
 * `powerShellAvailable` instead of depending on the host running the process.
 */
export function defaultToolNamesFor(powerShellAvailable: boolean): readonly ToolName[] {
	return [
		"read",
		"bash",
		...(powerShellAvailable ? (["powershell"] as const satisfies readonly ToolName[]) : []),
		"kill",
		"edit",
		"write",
		"find",
		"search",
		"ask_user_question",
		"todo",
	];
}

/** Codemode is an inline extension, but follows the built-in selection (lists, modifiers and suppression),
 * not the auto-activation policy for other extension tools. A loader that disables it selects nothing missing. */
export function defaultToolSelectionFor(
	powerShellAvailable: boolean,
	loader?: Pick<import("../resource-loader.ts").ResourceLoader, "getExtensions">,
): readonly string[] {
	const names = defaultToolNamesFor(powerShellAvailable);
	const hasCodemode =
		!loader ||
		loader
			.getExtensions()
			.extensions.some((extension) => extension.path === "builtin:codemode" && extension.tools.has("codemode"));
	return hasCodemode ? [...names, "codemode"] : names;
}

export function getDefaultToolNames(options?: { powerShellAvailable?: boolean }): readonly ToolName[] {
	return defaultToolNamesFor(options?.powerShellAvailable ?? isPowerShellAvailable());
}

export async function getDefaultToolNamesAsync(options?: {
	powerShellAvailable?: boolean;
}): Promise<readonly ToolName[]> {
	return defaultToolNamesFor(options?.powerShellAvailable ?? (await isPowerShellAvailableAsync()));
}

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	powershell?: PowerShellToolOptions;
	kill?: KillToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	find?: FindToolOptions;
	search?: SearchToolOptions;
	ls?: LsToolOptions;
}

function builtinEditOptions(options?: EditToolOptions): EditToolOptions {
	return { ...options, operations: options?.operations ?? localEditOperations };
}

function createBuiltinEditToolDefinition(cwd: string, options?: EditToolOptions) {
	return withNotebookEditPreview(createEditToolDefinition(cwd, builtinEditOptions(options)));
}

function createBuiltinWriteToolDefinition(cwd: string, options?: WriteToolOptions) {
	return withWriteSelectors(
		createWriteToolDefinition(cwd, { ...options, operations: options?.operations ?? localWriteOperations }),
		cwd,
	);
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	return toolName === "ask_user_question"
		? createAskUserQuestionToolDefinition()
		: createLoadedToolDefinition(toolName, cwd, options);
}

export function createLoadedToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "powershell":
			return createPowerShellToolDefinition(cwd, options?.powershell);
		case "kill":
			return createKillToolDefinition(options?.kill);
		case "edit":
			return createBuiltinEditToolDefinition(cwd, options?.edit);
		case "write":
			return createBuiltinWriteToolDefinition(cwd, options?.write);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "search":
			return createSearchToolDefinition(cwd, options?.search);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "ask_user_question":
			return createLoadedAskUserQuestionToolDefinition();
		case "todo":
			return createTodoToolDefinition(cwd);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "powershell":
			return createPowerShellTool(cwd, options?.powershell);
		case "kill":
			return createKillTool(options?.kill);
		case "edit":
			return createEditTool(cwd, builtinEditOptions(options?.edit));
		case "write":
			return wrapToolDefinition(createBuiltinWriteToolDefinition(cwd, options?.write));
		case "find":
			return createFindTool(cwd, options?.find);
		case "search":
			return createSearchTool(cwd, options?.search);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "ask_user_question":
			return wrapToolDefinition(createAskUserQuestionToolDefinition());
		case "todo":
			return wrapToolDefinition(createTodoToolDefinition(cwd));
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createKillToolDefinition(options?.kill),
		createBuiltinEditToolDefinition(cwd, options?.edit),
		createBuiltinWriteToolDefinition(cwd, options?.write),
		createFindToolDefinition(cwd, options?.find),
		createSearchToolDefinition(cwd, options?.search),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createFindToolDefinition(cwd, options?.find),
		createSearchToolDefinition(cwd, options?.search),
		createLsToolDefinition(cwd, options?.ls),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): BuiltinToolMap<ToolDef> {
	return {
		...createToolDefinitionsFor(cwd, options, isPowerShellAvailable()),
		ask_user_question: createAskUserQuestionToolDefinition(),
	};
}

export function createToolDefinitionsFor(
	cwd: string,
	options: ToolsOptions | undefined,
	powerShellAvailable: boolean,
): BuiltinToolMap<ToolDef> {
	const definitions: BuiltinToolMap<ToolDef> = {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		kill: createKillToolDefinition(options?.kill),
		edit: createBuiltinEditToolDefinition(cwd, options?.edit),
		write: createBuiltinWriteToolDefinition(cwd, options?.write),
		find: createFindToolDefinition(cwd, options?.find),
		search: createSearchToolDefinition(cwd, options?.search),
		ls: createLsToolDefinition(cwd, options?.ls),
		ask_user_question: createLoadedAskUserQuestionToolDefinition(),
		todo: createTodoToolDefinition(cwd),
	};
	if (powerShellAvailable) {
		definitions.powershell = createPowerShellToolDefinition(cwd, options?.powershell);
	}
	return definitions;
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createKillTool(options?.kill),
		createEditTool(cwd, builtinEditOptions(options?.edit)),
		wrapToolDefinition(createBuiltinWriteToolDefinition(cwd, options?.write)),
		createFindTool(cwd, options?.find),
		createSearchTool(cwd, options?.search),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createFindTool(cwd, options?.find),
		createSearchTool(cwd, options?.search),
		createLsTool(cwd, options?.ls),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): BuiltinToolMap<Tool> {
	const tools: BuiltinToolMap<Tool> = {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		kill: createKillTool(options?.kill),
		edit: createEditTool(cwd, builtinEditOptions(options?.edit)),
		write: wrapToolDefinition(createBuiltinWriteToolDefinition(cwd, options?.write)),
		find: createFindTool(cwd, options?.find),
		search: createSearchTool(cwd, options?.search),
		ls: createLsTool(cwd, options?.ls),
		ask_user_question: wrapToolDefinition(createAskUserQuestionToolDefinition()),
		todo: wrapToolDefinition(createTodoToolDefinition(cwd)),
	};
	if (isPowerShellAvailable()) {
		tools.powershell = createPowerShellTool(cwd, options?.powershell);
	}
	return tools;
}
