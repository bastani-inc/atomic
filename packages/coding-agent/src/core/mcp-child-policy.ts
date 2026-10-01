import { getBuiltinExtensionEntryLabel } from "./extensions/builtin-extension-entry-labels.ts";
import type { ToolDefinition } from "./extensions/tool-types.ts";
import type { RegisteredTool, SubagentChildPolicy } from "./extensions/types.ts";

export interface NativeMcpToolIdentity {
	readonly server: string;
	readonly tool: string;
}

const nativeToolIdentities = new WeakMap<ToolDefinition, NativeMcpToolIdentity>();

export function markNativeMcpToolDefinition(definition: ToolDefinition, identity: NativeMcpToolIdentity): void {
	nativeToolIdentities.set(definition, identity);
}

export function getNativeMcpToolIdentity(definition: ToolDefinition): NativeMcpToolIdentity | undefined {
	return nativeToolIdentities.get(definition);
}

export function matchesMcpDirectToolSelection(selections: readonly string[], server: string, tool: string): boolean {
	return selections.some((selection) => {
		let end = selection.length;
		while (end > 0 && selection[end - 1] === "/") end--;
		const value = selection.slice(0, end);
		return value === server || value === `${server}/${tool}`;
	});
}

export function isSelectedNativeMcpTool(
	registration: RegisteredTool,
	policy: SubagentChildPolicy | undefined,
): boolean {
	if ((policy?.depth ?? 0) < 1 || !policy?.mcpDirectTools?.length) return false;
	if (registration.definition.exposure === "hidden") return false;
	const { sourceInfo } = registration;
	if (sourceInfo.configurationOrigin !== "bundled") return false;
	if (sourceInfo.path !== "builtin:mcp" && getBuiltinExtensionEntryLabel(sourceInfo.path) !== "mcp") return false;
	const identity = getNativeMcpToolIdentity(registration.definition);
	return (
		identity !== undefined && matchesMcpDirectToolSelection(policy.mcpDirectTools, identity.server, identity.tool)
	);
}
