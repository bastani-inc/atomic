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

/** Inline built-in extension tools that follow the built-in tool selection (`defaultToolSelectionFor`). */
export const DEFAULT_BUILTIN_SELECTION_EXTRA_TOOLS = ["codemode"] as const;
export type BuiltinSelectionExtraToolName = (typeof DEFAULT_BUILTIN_SELECTION_EXTRA_TOOLS)[number];
export type BuiltinHelpToolName = ToolName | BuiltinSelectionExtraToolName;

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

const DEFAULT_AND_PLATFORM_TOOL_NAMES = defaultToolNamesFor(true);

/** Ordered built-in tool names for CLI help, derived from the default and full tool sets. */
export const BUILTIN_HELP_TOOL_NAMES: readonly BuiltinHelpToolName[] = [
	...DEFAULT_AND_PLATFORM_TOOL_NAMES,
	...DEFAULT_BUILTIN_SELECTION_EXTRA_TOOLS,
	...[...allToolNames].filter((name) => !DEFAULT_AND_PLATFORM_TOOL_NAMES.includes(name)),
];
