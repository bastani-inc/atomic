/**
 * Custom entry recording which of the tools a system message removed were deactivated on purpose, through
 * `setActiveToolsByName` (an extension's or SDK caller's `setActiveTools`). Restoring a transcript keeps only these
 * removals: any other removal was declared because the tool was not registered when a turn started (#4660).
 */
export const TOOL_DEACTIVATION_ENTRY_TYPE = "atomic.tool-deactivation";

export interface ToolDeactivationEntryData {
	readonly tools: readonly string[];
}

export function isToolDeactivationEntryData(data: unknown): data is ToolDeactivationEntryData {
	if (typeof data !== "object" || data === null || !("tools" in data)) return false;
	const { tools } = data;
	return Array.isArray(tools) && tools.every((name) => typeof name === "string");
}
