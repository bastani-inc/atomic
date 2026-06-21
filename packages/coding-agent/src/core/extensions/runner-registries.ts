import type {
	Extension,
	ExtensionFlag,
	MessageRenderer,
	RegisteredCommand,
	RegisteredTool,
	ResolvedCommand,
} from "./types.ts";

export function collectRegisteredTools(extensions: Extension[]): RegisteredTool[] {
	const toolsByName = new Map<string, RegisteredTool>();
	for (const ext of extensions) {
		for (const tool of ext.tools.values()) {
			if (!toolsByName.has(tool.definition.name)) {
				toolsByName.set(tool.definition.name, tool);
			}
		}
	}
	return Array.from(toolsByName.values());
}

export function findToolDefinition(
	extensions: Extension[],
	toolName: string,
): RegisteredTool["definition"] | undefined {
	for (const ext of extensions) {
		const tool = ext.tools.get(toolName);
		if (tool) {
			return tool.definition;
		}
	}
	return undefined;
}

export function collectFlags(extensions: Extension[]): Map<string, ExtensionFlag> {
	const allFlags = new Map<string, ExtensionFlag>();
	for (const ext of extensions) {
		for (const [name, flag] of ext.flags) {
			if (!allFlags.has(name)) {
				allFlags.set(name, flag);
			}
		}
	}
	return allFlags;
}

export function hasExtensionHandlers(extensions: Extension[], eventType: string): boolean {
	for (const ext of extensions) {
		const handlers = ext.handlers.get(eventType);
		if (handlers && handlers.length > 0) {
			return true;
		}
	}
	return false;
}

export function findMessageRenderer(extensions: Extension[], customType: string): MessageRenderer | undefined {
	for (const ext of extensions) {
		const renderer = ext.messageRenderers.get(customType);
		if (renderer) {
			return renderer;
		}
	}
	return undefined;
}

export function resolveRegisteredCommands(extensions: Extension[]): ResolvedCommand[] {
	const commands: RegisteredCommand[] = [];
	const counts = new Map<string, number>();

	for (const ext of extensions) {
		for (const command of ext.commands.values()) {
			commands.push(command);
			counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
		}
	}

	const seen = new Map<string, number>();
	const takenInvocationNames = new Set<string>();

	return commands.map((command) => {
		const occurrence = (seen.get(command.name) ?? 0) + 1;
		seen.set(command.name, occurrence);
		let invocationName = (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;

		if (takenInvocationNames.has(invocationName)) {
			let suffix = occurrence;
			do {
				suffix++;
				invocationName = `${command.name}:${suffix}`;
			} while (takenInvocationNames.has(invocationName));
		}

		takenInvocationNames.add(invocationName);
		return { ...command, invocationName };
	});
}
