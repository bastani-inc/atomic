import type { AutocompleteItem } from "@bastani/atomic-tui";
import { BUNDLED_COMMAND_NAMES, CORE_COMMAND_NAMES } from "@bastani/atomic-tui/dist/builtin-command-names.js";
import { APP_NAME } from "../config.js";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface ParsedSlashCommand {
	/** Command name without the leading `/`. */
	name: string;
	/** Everything after the separator, with its own line breaks intact. */
	args: string;
}

/**
 * Split `/name args` at the first whitespace character (space, tab or line break).
 * Only the separator is removed; a CRLF separator counts as one line break.
 */
export function parseSlashCommand(text: string): ParsedSlashCommand {
	const separator = /\r\n|\s/.exec(text);
	if (!separator) return { name: text.slice(1), args: "" };
	return { name: text.slice(1, separator.index), args: text.slice(separator.index + separator[0].length) };
}

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
}

/** The terminal and command registry use the same ordered names; descriptions belong to the application. */
function commandList<const Name extends string>(
	names: readonly Name[],
	commands: readonly (BuiltinSlashCommand & { name: NoInfer<Name> })[],
): readonly BuiltinSlashCommand[] {
	const byName = new Map(commands.map((command) => [command.name, command]));
	return names.map((name) => {
		const command = byName.get(name);
		if (!command) throw new Error(`Missing built-in command description: /${name}`);
		return command;
	});
}

export const BUILTIN_SLASH_COMMANDS = commandList(CORE_COMMAND_NAMES, [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "thinking", description: "Set thinking level", argumentHint: "<level>" },
	{ name: "scoped-models", description: "Enable/disable models for ctrl+p cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{
		name: "session",
		description:
			"Show session info and stats; `snapshot` shows worktree snapshots and diffs them against the current tree",
		argumentHint: "[snapshot]",
	},
	{ name: "tools", description: "Show which tools are active, inactive (and why), or missing" },
	{ name: "tasks", description: "Inspect agents and shells, view output, and manage running tasks" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
	{ name: "logout", description: "Remove provider authentication", argumentHint: "<provider>" },
	{ name: "new", description: "Start a new session" },
	{
		name: "compact",
		description: "Clear or compact the context window; the agent recovers what it needs from session history",
		argumentHint: "[instructions]",
	},
	{ name: "resume", description: "Resume a session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{ name: "exit", description: `Exit ${APP_NAME}` },
	{ name: "quit", description: `Quit ${APP_NAME}` },
]);

export const BUNDLED_EXTENSION_SLASH_COMMANDS = commandList(BUNDLED_COMMAND_NAMES, [
	{ name: "agents", description: "Browse available subagents and inspect their configuration" },
	{ name: "mcp", description: "Manage MCP servers: sign in, reconnect, enable or disable, and change exposure" },
	{ name: "curator", description: "Toggle or configure the search curator workflow" },
	{ name: "google-account", description: "Show the active Google account for Gemini Web" },
	{ name: "search", description: "Browse stored web search results" },
	{ name: "websearch", description: "Open web search curator" },
	{ name: "intercom", description: "Open session intercom overlay" },
	{ name: "llama", description: "Manage llama.cpp router models" },
]);
