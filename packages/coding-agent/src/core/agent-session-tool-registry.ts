import type { AgentTool } from "@earendil-works/pi-agent-core";
import { normalizeToolArgumentsForModel } from "./copilot-gemini-tool-arguments.ts";
import { ExtensionRunner, wrapRegisteredTools, type ToolDefinition } from "./extensions/index.ts";
import { createSyntheticSourceInfo } from "./source-info.ts";
import { createAllToolDefinitions, defaultToolNames } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { ToolDefinitionEntry } from "./agent-session-types.ts";

export function _refreshToolRegistry(this: AgentSession, options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
	const previousRegistryNames = new Set(this._toolRegistry.keys());
	const previousActiveToolNames = this.getActiveToolNames();
	const allowedToolNames = this._allowedToolNames;
	const excludedToolNames = this._excludedToolNames;
	const isExposedTool = (name: string): boolean => {
		if (allowedToolNames && !allowedToolNames.has(name)) {
			return false;
		}
		if (excludedToolNames?.has(name)) {
			return false;
		}
		return true;
	};

	const registeredTools = this._extensionRunner.getAllRegisteredTools();
	const allCustomTools = [
		...registeredTools,
		...this._customTools.map((definition) => ({
			definition,
			sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
		})),
	].filter((tool) => isExposedTool(tool.definition.name));
	const definitionRegistry = new Map<string, ToolDefinitionEntry>(
		Array.from(this._baseToolDefinitions.entries())
			.filter(([name]) => isExposedTool(name))
			.map(([name, definition]) => [
				name,
				{
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
				},
			]),
	);
	for (const tool of allCustomTools) {
		definitionRegistry.set(tool.definition.name, {
			definition: tool.definition,
			sourceInfo: tool.sourceInfo,
		});
	}
	this._toolDefinitions = definitionRegistry;
	this._toolPromptSnippets = new Map(
		Array.from(definitionRegistry.values())
			.map(({ definition }) => {
				const snippet = this._normalizePromptSnippet(definition.promptSnippet);
				return snippet ? ([definition.name, snippet] as const) : undefined;
			})
			.filter((entry): entry is readonly [string, string] => entry !== undefined),
	);
	this._toolPromptGuidelines = new Map(
		Array.from(definitionRegistry.values())
			.map(({ definition }) => {
				const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
				return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
			})
			.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
	);
	const runner = this._extensionRunner;
	const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
	const wrappedBuiltInTools = wrapRegisteredTools(
		Array.from(this._baseToolDefinitions.values())
			.filter((definition) => isExposedTool(definition.name))
			.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
			})),
		runner,
	);

	const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
	for (const tool of wrappedExtensionTools as AgentTool[]) {
		toolRegistry.set(tool.name, tool);
	}
	// GitHub Copilot Gemini serializes array/object tool-call arguments as
	// flattened `name[index]` keys (confirmed on the raw CAPI wire). Reconstruct
	// them into proper arrays/objects before per-tool preparation and schema
	// validation, so tool calls (notably structured_output) don't fail and loop.
	// Gated to Copilot Gemini at call time via this.model; a no-op otherwise.
	// `prepareArguments` is a plain function field (no `this` binding), and the
	// `{ ...tool }` spread assumes AgentTools are plain objects — matching the
	// existing tool-definition-wrapper pattern; a class-instance tool would lose
	// prototype members here.
	this._toolRegistry = new Map(
		Array.from(toolRegistry, ([name, tool]) => {
			const basePrepareArguments = tool.prepareArguments;
			const prepareArguments = (args: unknown): unknown => {
				const normalized = normalizeToolArgumentsForModel(args, this.model, tool.parameters);
				return basePrepareArguments ? basePrepareArguments(normalized) : normalized;
			};
			return [name, { ...tool, prepareArguments } as AgentTool] as const;
		}),
	);

	const nextActiveToolNames = (
		options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
	).filter((name) => isExposedTool(name));

	if (allowedToolNames) {
		for (const toolName of this._toolRegistry.keys()) {
			if (allowedToolNames.has(toolName)) {
				nextActiveToolNames.push(toolName);
			}
		}
	} else if (options?.includeAllExtensionTools) {
		for (const tool of wrappedExtensionTools) {
			nextActiveToolNames.push(tool.name);
		}
	} else if (!options?.activeToolNames) {
		for (const toolName of this._toolRegistry.keys()) {
			if (!previousRegistryNames.has(toolName)) {
				nextActiveToolNames.push(toolName);
			}
		}
	}

	this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
}


export function _buildRuntime(this: AgentSession, options: {
	activeToolNames?: string[];
	flagValues?: Map<string, boolean | string>;
	includeAllExtensionTools?: boolean;
}): void {
	const autoResizeImages = this.settingsManager.getImageAutoResize();
	const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
	const shellPath = this.settingsManager.getShellPath();
	const baseToolDefinitions = this._baseToolsOverride
		? Object.fromEntries(
				Object.entries(this._baseToolsOverride).map(([name, tool]) => [
					name,
					createToolDefinitionFromAgentTool(tool),
				]),
			)
		: createAllToolDefinitions(this._cwd, {
				read: { autoResizeImages },
				bash: {
					commandPrefix: shellCommandPrefix,
					shellPath,
				},
			});

	this._baseToolDefinitions = new Map(
		Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
	);

	const extensionsResult = this._resourceLoader.getExtensions();
	if (options.flagValues) {
		for (const [name, value] of options.flagValues) {
			extensionsResult.runtime.flagValues.set(name, value);
		}
	}

	this._extensionRunner = new ExtensionRunner(
		extensionsResult.extensions,
		extensionsResult.runtime,
		this._cwd,
		this.sessionManager,
		this._modelRegistry,
		this._orchestrationContext,
	);
	if (this._extensionRunnerRef) {
		this._extensionRunnerRef.current = this._extensionRunner;
	}
	this._bindExtensionCore(this._extensionRunner);
	this._applyExtensionBindings(this._extensionRunner);

	const defaultActiveToolNames = this._baseToolsOverride
		? Object.keys(this._baseToolsOverride)
		: [...defaultToolNames];
	const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
	this._refreshToolRegistry({
		activeToolNames: baseActiveToolNames,
		includeAllExtensionTools: options.includeAllExtensionTools,
	});
}


export const agentSessionToolRegistryMethods = {
	_refreshToolRegistry,
	_buildRuntime,
};
