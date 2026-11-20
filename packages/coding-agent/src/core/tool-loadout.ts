import type { AgentMessage, AgentTool } from "@bastani/atomic-agent-core";
import { declarationsEqual, getCurrentTools } from "@bastani/atomic-ai";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { getCallableTools } from "./agent-session-nested-tools.js";
import type { ToolLoadout } from "./extensions/tool-types.ts";
import { isToolActivatable } from "./tool-selection.ts";

const hiddenDeclarations = new WeakMap<AgentSession, ReadonlySet<string>>();
export function isToolDeclarationHidden(session: AgentSession, name: string): boolean {
	return hiddenDeclarations.get(session)?.has(name) ?? false;
}
/** Code point order, the same on every host and locale. */
function compareNames(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The active tools are a set, ordered so that the same set always gives the same order (#11495). Tools the
 * transcript already declares keep their declared order and come first. The others follow in a canonical order,
 * built-in tools in their requested order and then extension and MCP tools by name, so the order in which
 * extensions or MCP servers registered or connected never changes the tool declarations a request sends.
 */
export function applyToolLoadout(session: AgentSession, names: readonly string[]): AgentTool[] {
	const requested = new Set(names);
	const recordedTools = getCurrentTools(session.agent.state.messages);
	const transcriptOrder = recordedTools.map((tool) => tool.name).filter((name) => requested.has(name));
	const inTranscript = new Set(transcriptOrder);
	const kept = session.getActiveToolNames().filter((name) => requested.has(name) && !inTranscript.has(name));
	const undeclared = [...new Set([...kept, ...requested])].filter((name) => !inTranscript.has(name));
	const builtIn = undeclared.filter((name) => session._baseToolDefinitions.has(name));
	const others = undeclared.filter((name) => !session._baseToolDefinitions.has(name)).sort(compareNames);
	const tools = [...transcriptOrder, ...builtIn, ...others].flatMap((name) => {
		const tool = session._toolRegistry.get(name);
		const exposure = session.getToolDefinition(name)?.exposure ?? "direct";
		return tool &&
			exposure !== "hidden" &&
			isToolActivatable(session, name, exposure, session._toolRegistry.has("tool_search"))
			? [tool]
			: [];
	});
	const loadout: ToolLoadout = {
		declared: tools,
		callable: getCallableTools(session, new Set(tools.map((tool) => tool.name))),
		registered: [...session._toolRegistry.values()],
		getExposure: (name) => session.getToolDefinition(name)?.exposure ?? "direct",
		getNamespace: (name) => session.getToolDefinition(name)?.namespace,
		getPromptGuidelines: (name) => session._toolPromptGuidelines.get(name) ?? [],
	};
	const descriptions = new Map<string, string>();
	const hidden = new Set<string>();
	for (const tool of tools) {
		const entry = session._toolDefinitions.get(tool.name);
		if (!entry?.definition.prepareLoadout) continue;
		try {
			const changes = entry.definition.prepareLoadout(loadout);
			for (const [name, description] of Object.entries(changes?.descriptions ?? {}))
				descriptions.set(name, description);
			for (const name of changes?.hiddenDeclarations ?? []) hidden.add(name);
		} catch (error) {
			session.extensionRunner.emitError({
				extensionPath: entry.sourceInfo.path,
				event: "prepare_loadout",
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
		}
	}
	hiddenDeclarations.set(session, hidden);
	const withDescriptions = tools.map((tool) => {
		const description = descriptions.get(tool.name);
		return description === undefined ? tool : { ...tool, description };
	});
	// A tool whose declaration changes is declared again after the unchanged ones. Ordering the active tools that way
	// now keeps the system prompt's tool list from changing order once more on the next request.
	const byName = new Map(withDescriptions.map((tool) => [tool.name, tool]));
	const unchanged = recordedTools.flatMap((recorded) => {
		const tool = byName.get(recorded.name);
		return tool && declarationsEqual(recorded, tool) ? [tool] : [];
	});
	const unchangedNames = new Set(unchanged.map((tool) => tool.name));
	const declared = [...unchanged, ...withDescriptions.filter((tool) => !unchangedNames.has(tool.name))];
	session.agent.state.tools = declared;
	return declared;
}

/** Hide only request declarations. The transcript retains activation and branch history. */
export function projectToolLoadout(session: AgentSession, messages: AgentMessage[]): AgentMessage[] {
	const hidden = hiddenDeclarations.get(session);
	if (!hidden?.size) return messages;
	return messages.map((message) => {
		if (message.role !== "system" || (!message.toolsAdded && !message.toolsRemoved)) return message;
		const { toolsAdded, toolsRemoved, ...rest } = message;
		const added = toolsAdded?.filter((tool) => !hidden.has(tool.name)) ?? [];
		const removed = toolsRemoved?.filter((tool) => !hidden.has(tool.name)) ?? [];
		return {
			...rest,
			...(added.length ? { toolsAdded: added } : {}),
			...(removed.length ? { toolsRemoved: removed } : {}),
		};
	});
}
