import { BUILTIN_SLASH_COMMANDS, parseSlashCommand } from "../../core/slash-commands.js";

/**
 * What a slash command typed into a subagent's chat does there.
 * - `local`: a built-in the chat runs itself at once, as the main chat does: `/tasks` lists the subagent's own tasks,
 *   `/copy` copies its last message, `/hotkeys` shows the chat's keys.
 * - `unavailable`: a built-in that acts on the main chat's session or on Atomic itself (`/model`, `/new`, `/resume`,
 *   `/quit`, …). It is refused with a notice and never reaches the subagent as text.
 * - `agent`: anything else goes to the subagent's own session, which expands its skills and prompt templates and runs
 *   its extension commands, and queues the rest as a message, exactly as the main chat's session does.
 */
export type SubagentChatCommand =
	| { readonly kind: "local"; readonly name: SubagentLocalCommand }
	| { readonly kind: "unavailable"; readonly name: string }
	| { readonly kind: "agent" };

export type SubagentLocalCommand = "tasks" | "copy" | "hotkeys";

const LOCAL_COMMANDS: ReadonlySet<string> = new Set<SubagentLocalCommand>(["tasks", "copy", "hotkeys"]);

/** Built-ins the main chat runs with whatever follows their name. */
const COMMANDS_WITH_ARGUMENTS: ReadonlySet<string> = new Set([
	"tasks",
	"model",
	"thinking",
	"export",
	"import",
	"name",
	"login",
	"logout",
	"compact",
	"resume",
]);

/** Built-ins the main chat runs without being listed among its commands. */
const UNLISTED_COMMANDS = ["debug", "arminsayshi", "dementedelves"] as const;

const BUILTIN_COMMANDS: ReadonlySet<string> = new Set([
	...BUILTIN_SLASH_COMMANDS.map((command) => command.name),
	...UNLISTED_COMMANDS,
]);

/**
 * Whether the main chat runs `text` as one of its built-in commands: a command that takes arguments runs with any,
 * the others only bare (`/session snapshot` too). Main sends any other text, such as `/copy that`, to its model.
 */
function mainChatBuiltin(text: string): string | undefined {
	if (!text.startsWith("/")) return undefined;
	const { name, args } = parseSlashCommand(text);
	if (!BUILTIN_COMMANDS.has(name)) return undefined;
	if (COMMANDS_WITH_ARGUMENTS.has(name) || args === "" || (name === "session" && args === "snapshot")) return name;
	return undefined;
}

/** How a subagent's chat handles `text`, typed as one submission. */
export function subagentChatCommand(text: string): SubagentChatCommand {
	const name = mainChatBuiltin(text);
	if (name === undefined) return { kind: "agent" };
	if (LOCAL_COMMANDS.has(name)) return { kind: "local", name: name as SubagentLocalCommand };
	return { kind: "unavailable", name };
}

/** The notice a refused built-in shows in a subagent's chat. */
export function subagentChatUnavailableNotice(name: string): string {
	return `/${name} is not available in a subagent chat`;
}
