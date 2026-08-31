import type { Extension, RegisteredTool, ToolDefinition } from "./extensions/index.ts";

const MANDATORY_TOOL_NAMES = new Set(["intercom"]);
const TRUSTED_MANDATORY_DEFINITIONS = new WeakSet<ToolDefinition>();

/** Mark an extension instance loaded through Atomic's internally owned mandatory package path. */
export function markTrustedMandatoryRuntimeExtension(extension: Extension): void {
	extension.sourceInfo = { ...extension.sourceInfo, configurationOrigin: "bundled" };
	for (const registration of extension.tools.values()) {
		registration.sourceInfo = extension.sourceInfo;
		if (MANDATORY_TOOL_NAMES.has(registration.definition.name)) {
			TRUSTED_MANDATORY_DEFINITIONS.add(registration.definition);
		}
	}
	for (const command of extension.commands.values()) command.sourceInfo = extension.sourceInfo;
}

export function isTrustedMandatoryRuntimeTool(registration: RegisteredTool): boolean {
	return (
		MANDATORY_TOOL_NAMES.has(registration.definition.name) &&
		TRUSTED_MANDATORY_DEFINITIONS.has(registration.definition)
	);
}

/** Tools that every Atomic model session must keep registered and active. */
export function isMandatoryRuntimeTool(name: string): boolean {
	return MANDATORY_TOOL_NAMES.has(name);
}

export function appendRegisteredMandatoryTools<T extends { name: string }>(
	tools: T[],
	registry: ReadonlyMap<string, T>,
): T[] {
	for (const name of MANDATORY_TOOL_NAMES) {
		const tool = registry.get(name);
		if (tool && !tools.some((candidate) => candidate.name === name)) tools.push(tool);
	}
	return tools;
}
