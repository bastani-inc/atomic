import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { getCallableTools } from "./agent-session-nested-tools.js";
import type { ToolLoadout } from "./extensions/tool-types.ts";
import { isToolActivatable } from "./tool-selection.ts";

const hiddenDeclarations = new WeakMap<AgentSession, ReadonlySet<string>>();
export function isToolDeclarationHidden(session: AgentSession, name: string): boolean {
	return hiddenDeclarations.get(session)?.has(name) ?? false;
}
export function applyToolLoadout(session: AgentSession, names: readonly string[]): AgentTool[] {
	const tools = [...new Set(names)].flatMap((name) => {
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
	const declared = tools.map((tool) => {
		const description = descriptions.get(tool.name);
		return description === undefined ? tool : { ...tool, description };
	});
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
