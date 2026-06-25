export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createSearchTool,
	createSearchToolDefinition,
	type SearchToolDetails,
	type SearchToolInput,
	type SearchToolOptions,
} from "./search.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
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
} from "./write.ts";
export { createAskUserQuestionToolDefinition } from "./ask-user-question/index.ts";
export {
	STRUCTURED_OUTPUT_TOOL_NAME,
	createStructuredOutputCapture,
	createStructuredOutputTool,
	type JsonObject,
	type JsonPrimitive,
	type JsonValue,
	type StructuredOutputCapture,
	type StructuredOutputFileCapture,
	type StructuredOutputToolOptions,
} from "./structured-output.ts";
export { createTodoToolDefinition } from "./todos.ts";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { createAskUserQuestionToolDefinition } from "./ask-user-question/index.ts";
import { createHashlineSnapshotStore, type HashlineSnapshotStore } from "./hashline.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createSearchTool, createSearchToolDefinition, type SearchToolOptions } from "./search.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createTodoToolDefinition } from "./todos.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<TSchema, unknown>;
export type ToolDef = ToolDefinition<TSchema, unknown>;
export type ToolName =
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "find"
	| "search"
	| "ls"
	| "ask_user_question"
	| "todo";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"find",
	"search",
	"ls",
	"ask_user_question",
	"todo",
]);

export const defaultToolNames: readonly ToolName[] = [
	"read",
	"bash",
	"edit",
	"write",
	"find",
	"search",
	"ask_user_question",
	"todo",
];

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	find?: FindToolOptions;
	search?: SearchToolOptions;
	ls?: LsToolOptions;
	hashlineStore?: HashlineSnapshotStore;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	// Default a shared store so the singular factories don't hand read/edit/
	// write/search isolated stores (which silently degrades drift recovery).
	const hashlineStore = options?.hashlineStore ?? createHashlineSnapshotStore();
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, { ...options?.read, hashlineStore });
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "edit":
			return createEditToolDefinition(cwd, { ...options?.edit, hashlineStore });
		case "write":
			return createWriteToolDefinition(cwd, { ...options?.write, hashlineStore });
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "search":
			return createSearchToolDefinition(cwd, { ...options?.search, hashlineStore });
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "ask_user_question":
			return createAskUserQuestionToolDefinition();
		case "todo":
			return createTodoToolDefinition(cwd);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	const hashlineStore = options?.hashlineStore ?? createHashlineSnapshotStore();
	switch (toolName) {
		case "read":
			return createReadTool(cwd, { ...options?.read, hashlineStore });
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "edit":
			return createEditTool(cwd, { ...options?.edit, hashlineStore });
		case "write":
			return createWriteTool(cwd, { ...options?.write, hashlineStore });
		case "find":
			return createFindTool(cwd, options?.find);
		case "search":
			return createSearchTool(cwd, { ...options?.search, hashlineStore });
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
	const hashlineStore = options?.hashlineStore ?? createHashlineSnapshotStore();
	return [
		createReadToolDefinition(cwd, { ...options?.read, hashlineStore }),
		createBashToolDefinition(cwd, { asyncEnabled: true, ...options?.bash }),
		createEditToolDefinition(cwd, { ...options?.edit, hashlineStore }),
		createWriteToolDefinition(cwd, { ...options?.write, hashlineStore }),
		createFindToolDefinition(cwd, options?.find),
		createSearchToolDefinition(cwd, { ...options?.search, hashlineStore }),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	const hashlineStore = options?.hashlineStore ?? createHashlineSnapshotStore();
	return [
		createReadToolDefinition(cwd, { ...options?.read, hashlineStore }),
		createFindToolDefinition(cwd, options?.find),
		createSearchToolDefinition(cwd, { ...options?.search, hashlineStore }),
		createLsToolDefinition(cwd, options?.ls),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	const hashlineStore = options?.hashlineStore ?? createHashlineSnapshotStore();
	return {
		read: createReadToolDefinition(cwd, { ...options?.read, hashlineStore }),
		bash: createBashToolDefinition(cwd, { asyncEnabled: true, ...options?.bash }),
		edit: createEditToolDefinition(cwd, { ...options?.edit, hashlineStore }),
		write: createWriteToolDefinition(cwd, { ...options?.write, hashlineStore }),
		find: createFindToolDefinition(cwd, options?.find),
		search: createSearchToolDefinition(cwd, { ...options?.search, hashlineStore }),
		ls: createLsToolDefinition(cwd, options?.ls),
		ask_user_question: createAskUserQuestionToolDefinition(),
		todo: createTodoToolDefinition(cwd),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	const hashlineStore = options?.hashlineStore ?? createHashlineSnapshotStore();
	return [
		createReadTool(cwd, { ...options?.read, hashlineStore }),
		createBashTool(cwd, { asyncEnabled: true, ...options?.bash }),
		createEditTool(cwd, { ...options?.edit, hashlineStore }),
		createWriteTool(cwd, { ...options?.write, hashlineStore }),
		createFindTool(cwd, options?.find),
		createSearchTool(cwd, { ...options?.search, hashlineStore }),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	const hashlineStore = options?.hashlineStore ?? createHashlineSnapshotStore();
	return [
		createReadTool(cwd, { ...options?.read, hashlineStore }),
		createFindTool(cwd, options?.find),
		createSearchTool(cwd, { ...options?.search, hashlineStore }),
		createLsTool(cwd, options?.ls),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	const hashlineStore = options?.hashlineStore ?? createHashlineSnapshotStore();
	return {
		read: createReadTool(cwd, { ...options?.read, hashlineStore }),
		bash: createBashTool(cwd, { asyncEnabled: true, ...options?.bash }),
		edit: createEditTool(cwd, { ...options?.edit, hashlineStore }),
		write: createWriteTool(cwd, { ...options?.write, hashlineStore }),
		find: createFindTool(cwd, options?.find),
		search: createSearchTool(cwd, { ...options?.search, hashlineStore }),
		ls: createLsTool(cwd, options?.ls),
		ask_user_question: wrapToolDefinition(createAskUserQuestionToolDefinition()),
		todo: wrapToolDefinition(createTodoToolDefinition(cwd)),
	};
}
