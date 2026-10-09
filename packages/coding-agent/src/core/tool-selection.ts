import {
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	LIST_MCP_RESOURCES_TOOL,
	READ_MCP_RESOURCE_TOOL,
} from "../extensions/mcp/resources.js";
import type { SubagentChildPolicy } from "./extensions/types.ts";

export function createToolNameMatcher(entries: Iterable<string>): (name: string) => boolean {
	const names = new Set<string>();
	const patterns: RegExp[] = [];
	for (const entry of entries) {
		if (!entry.includes("*")) names.add(entry);
		else
			patterns.push(
				new RegExp(
					`^${entry
						.split("*")
						.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
						.join(".*")}$`,
				),
			);
	}
	return (name) => names.has(name) || patterns.some((pattern) => pattern.test(name));
}

export function isMcpToolName(name: string): boolean {
	return (
		name.startsWith("mcp__") ||
		[LIST_MCP_RESOURCES_TOOL, LIST_MCP_RESOURCE_TEMPLATES_TOOL, READ_MCP_RESOURCE_TOOL].includes(name)
	);
}

interface ToolSelection {
	_allowedToolNames?: Set<string>;
	_allowedTools?: (name: string) => boolean;
	_excludedTools?: (name: string) => boolean;
	_subagentPolicy?: SubagentChildPolicy;
}

export function isRegisteredToolAllowed(selection: ToolSelection, name: string): boolean {
	if (selection._excludedTools?.(name)) return false;
	if (
		(selection._subagentPolicy?.depth ?? 0) >= 1 &&
		selection._allowedTools &&
		isMcpToolName(name) &&
		!selection._allowedToolNames?.has(name)
	)
		return false;
	if (!selection._allowedTools || selection._allowedTools(name)) return true;
	if ((selection._subagentPolicy?.depth ?? 0) >= 1) return false;
	return (
		!!selection._allowedToolNames?.size &&
		![...selection._allowedToolNames].some((entry) => entry.startsWith("mcp__")) &&
		isMcpToolName(name)
	);
}

export function isToolActivatable(
	selection: ToolSelection,
	name: string,
	exposure: string,
	hasToolSearch: boolean,
): boolean {
	if (!selection._allowedTools || selection._allowedTools(name) || !isMcpToolName(name)) return true;
	if ((selection._subagentPolicy?.depth ?? 0) >= 1) return true;
	return exposure !== "direct" && exposure !== "hidden" && hasToolSearch;
}

interface SelectedTools {
	_usesDefaultTools: boolean;
	_appliedDefaultTools: ReadonlySet<string>;
	_allowedToolNames?: ReadonlySet<string>;
	_initialActiveToolNames?: readonly string[];
}

/** Tool names the session's selection asked for, whether or not a tool with each name has registered yet. */
export function selectedToolNames(selection: SelectedTools): ReadonlySet<string> {
	if (selection._usesDefaultTools) return selection._appliedDefaultTools;
	return new Set(selection._allowedToolNames ?? selection._initialActiveToolNames ?? []);
}

/**
 * Default-active tools activate as they register. Opt-in tools (`defaultActive: false`) activate only
 * when the selection names them, such as `defaultTools: ["+codemode"]` whose extension loads after
 * the session starts.
 */
export function activatesOnRegistration(
	selection: SelectedTools,
	name: string,
	definition: { exposure?: string; defaultActive?: boolean } | undefined,
): boolean {
	const exposure = definition?.exposure ?? "direct";
	if (exposure !== "direct" && exposure !== "model-only") return false;
	return definition?.defaultActive !== false || selectedToolNames(selection).has(name);
}
