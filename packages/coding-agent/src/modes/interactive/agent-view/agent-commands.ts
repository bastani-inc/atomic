import type { TaskId } from "../../../core/tasks/contracts.js";
import type { TaskCommandCatalog, TaskViewSource } from "../../../core/tasks/task-view-source.js";
import { BUILTIN_SLASH_COMMAND_NAMES } from "../interactive-mode-helpers.ts";
import { getSkillCatalogCommands, prefixAutocompleteDescription } from "../skill-command-autocomplete.ts";
import type { AgentViewRuntime } from "./agent-steering.ts";
import type { AgentViewCommands } from "./contracts.ts";

/** The slash commands the subagent's own session runs, read where it lives. */
export async function localAgentCommands(
	source: TaskViewSource,
	taskId: TaskId,
): Promise<AgentViewCommands | undefined> {
	const catalog = await source.taskCommands?.(taskId);
	return catalog === undefined ? undefined : agentViewCommands(catalog);
}

/** The same, read through the isolated engine for view `viewId`. */
export async function remoteAgentCommands(
	runtime: AgentViewRuntime,
	viewId: string,
): Promise<AgentViewCommands | undefined> {
	const commands = await runtime.requestAgentView<AgentViewCommands | null>({ type: "agent_view_commands", viewId });
	return commands ?? undefined;
}

/**
 * A subagent session's commands as the prompt offers them while it is shown, as plain data that crosses the engine
 * boundary. Names are typed after `/` (`skill:<name>` for skills); descriptions carry their source tag. Built-in names
 * stay main's, and the extension commands Atomic ships run on main, so neither is listed as the subagent's.
 */
export function agentViewCommands(catalog: TaskCommandCatalog): AgentViewCommands {
	const own = (name: string) => !BUILTIN_SLASH_COMMAND_NAMES.has(name);
	return {
		cwd: catalog.cwd,
		skillCommands: getSkillCatalogCommands(catalog.skillCommands).map(({ name, description }) =>
			description === undefined ? { name } : { name, description },
		),
		promptTemplates: (catalog.promptTemplates ?? [])
			.filter((template) => own(template.name))
			.map((template) => described(template.name, template.description, template.sourceInfo)),
		extensionCommands: (catalog.extensionCommands ?? [])
			.filter((command) => own(command.name) && command.sourceInfo?.configurationOrigin !== "bundled")
			.map((command) => described(command.name, command.description, command.sourceInfo)),
	};
}

function described(
	name: string,
	description: string | undefined,
	sourceInfo: Parameters<typeof prefixAutocompleteDescription>[1],
): { readonly name: string; readonly description?: string } {
	const text = prefixAutocompleteDescription(description, sourceInfo);
	return text === undefined ? { name } : { name, description: text };
}
