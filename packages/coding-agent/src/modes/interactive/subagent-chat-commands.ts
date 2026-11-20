import type { CORE_COMMAND_NAMES } from "@bastani/atomic-tui/dist/builtin-command-names.js";
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

/**
 * What a slash command typed while the main screen shows a subagent does.
 * - `main`: main's own handler runs it, exactly as when main is shown. It acts on the main session or on Atomic itself.
 *   `showMain`: its answer is printed into the main transcript, so the screen shows main first.
 * - `confirm`: it replaces, rewrites or switches the main conversation. It runs as `main` (main shown) after Yes.
 * - `refuse`: it sets the main conversation's model or thinking level, which is not done from a subagent's view.
 * - `copy`: `/copy` copies the viewed subagent's last message, the one on screen.
 * - `agent`: anything else goes to the subagent's own session, which expands its skills and prompt templates and runs
 *   its extension commands, and takes the rest as a message, as main's session does with what main sends it.
 */
export type ViewedAgentCommand =
	| { readonly kind: "main"; readonly name: string; readonly showMain: boolean }
	| { readonly kind: "confirm"; readonly name: string }
	| { readonly kind: "refuse"; readonly name: string }
	| { readonly kind: "copy" }
	| { readonly kind: "agent" };

/**
 * Where one of the main session's extension commands comes from. `bundled`: an extension Atomic ships (`/agents`,
 * `/mcp`, `/intercom`, `/curator`, `/google-account`, `/search`, `/websearch`, `/llama`); `configured`: one the user or
 * the project installed.
 */
export type MainCommandOrigin = "bundled" | "configured";

type BuiltinName = (typeof CORE_COMMAND_NAMES)[number] | (typeof UNLISTED_COMMANDS)[number];
type ViewedScope = "here" | "showMain" | "confirm" | "refuse" | "copy";

/**
 * Every built-in, as it behaves while a subagent is viewed. A built-in added to the registry must be placed here.
 * - `here`: a menu, a dialog, or a status line, which show over the subagent's view as they do over main's;
 * - `showMain`: prints into the main transcript;
 * - `confirm`: replaces, rewrites or switches the main conversation;
 * - `refuse`: sets the main conversation's model or thinking level.
 */
const VIEWED_BUILTINS: Readonly<Record<BuiltinName, ViewedScope>> = {
	settings: "here",
	model: "refuse",
	tree: "confirm",
	thinking: "refuse",
	"scoped-models": "here",
	export: "here",
	import: "confirm",
	share: "here",
	copy: "copy",
	name: "showMain",
	session: "showMain",
	tools: "showMain",
	tasks: "here",
	changelog: "showMain",
	hotkeys: "showMain",
	fork: "confirm",
	clone: "confirm",
	trust: "here",
	login: "here",
	logout: "here",
	new: "confirm",
	compact: "confirm",
	resume: "confirm",
	reload: "here",
	exit: "here",
	quit: "here",
	debug: "showMain",
	arminsayshi: "showMain",
	dementedelves: "showMain",
};

/**
 * Names that would replace or rewind the main conversation. Neither is a command today, so typed alone they reach the
 * subagent as text, as main sends them to its model; a command registered under either name asks first.
 */
const MAIN_REWRITE_NAMES: ReadonlySet<string> = new Set(["clear", "rewind"]);

/**
 * How `text`, typed as one submission while a subagent is viewed, is handled. `mainCommandOrigin` names where one of
 * the main session's extension commands comes from, or answers undefined for a name main has no extension command for.
 *
 * Extension commands follow one convention: those Atomic ships act on Atomic itself (its subagent catalog, MCP servers,
 * accounts, web search, Intercom, local models) and need the interactive interface, which a subagent's session does not
 * have, so they run on main; those the user or the project installed act on a session and go to the subagent, whose own
 * session runs them.
 */
export function viewedAgentCommand(
	text: string,
	mainCommandOrigin: (name: string) => MainCommandOrigin | undefined,
): ViewedAgentCommand {
	if (!text.startsWith("/")) return { kind: "agent" };
	const builtin = mainChatBuiltin(text);
	if (builtin !== undefined) {
		const scope = VIEWED_BUILTINS[builtin as BuiltinName];
		if (scope === "copy") return { kind: "copy" };
		if (scope === "confirm" || scope === "refuse") return { kind: scope, name: builtin };
		return { kind: "main", name: builtin, showMain: scope === "showMain" };
	}
	const { name } = parseSlashCommand(text);
	const origin = mainCommandOrigin(name);
	if (origin !== undefined && MAIN_REWRITE_NAMES.has(name)) return { kind: "confirm", name };
	if (origin === "bundled") return { kind: "main", name, showMain: false };
	return { kind: "agent" };
}
