import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { ToolDefinitionEntry } from "./agent-session-types.js";
import { ExtensionRunner, type ToolDefinition, wrapRegisteredTools } from "./extensions/index.js";
import { isMandatoryRuntimeTool, isTrustedMandatoryRuntimeTool } from "./mandatory-runtime-tools.ts";
import { ModelRegistry } from "./model-registry.ts";
import { createSyntheticSourceInfo } from "./source-info.ts";
import { createLocalBashOperations } from "./tools/bash.js";
import { buildMutationRequester } from "./tools/file-mutation-coordinator.ts";
import { createAllToolDefinitions, getDefaultToolNames } from "./tools/index.ts";
import { createLocalPowerShellOperations } from "./tools/powershell.ts";
import { resolveSessionTempDirPath } from "./tools/session-temp-dir.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";

export function _refreshToolRegistry(
	this: AgentSession,
	options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean },
): void {
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

	const registeredTools = this._extensionRunner
		.getAllRegisteredTools()
		.filter((tool) => !isMandatoryRuntimeTool(tool.definition.name) || isTrustedMandatoryRuntimeTool(tool));
	const allCustomTools = [
		...registeredTools,
		...this._customTools
			.filter((definition) => !isMandatoryRuntimeTool(definition.name))
			.map((definition) => ({
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
	this._toolRegistry = toolRegistry;

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

export function _buildRuntime(
	this: AgentSession,
	options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
		preserveRunner?: boolean;
	},
): void {
	const autoResizeImages = this.settingsManager.getImageAutoResize();
	const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
	const shellPath = this.settingsManager.getShellPath();
	const isAllowedBuiltinTool = (name: string): boolean => {
		if (this._allowedToolNames && !this._allowedToolNames.has(name)) return false;
		if (this._excludedToolNames?.has(name)) return false;
		return true;
	};
	const activeBuiltinTools = (options.activeToolNames ?? [...getDefaultToolNames()]).filter(isAllowedBuiltinTool);
	// Resolve ownership per call, just like command execution. Each wait receives
	// a stable binding so observation cleanup can finish after session disposal.
	// Subagent children resolve their parent's owner, so their shells appear in its `/tasks`.
	const getTaskOwner = () => this._getCommandTaskOwner();
	const baseToolDefinitions = this._baseToolsOverride
		? Object.fromEntries(
				Object.entries(this._baseToolsOverride).map(([name, tool]) => [
					name,
					createToolDefinitionFromAgentTool(tool),
				]),
			)
		: createAllToolDefinitions(this._cwd, {
				// Resolved per execution for the same reason as `sessionTempDir` below: a
				// requester captured at construction would keep a stale session id across
				// fork/branch/resume, which is exactly the relaunch this makes legible.
				resolveMutationRequester: (toolCallId) =>
					buildMutationRequester({
						sessionId: this.sessionManager.getSessionId(),
						...(this._orchestrationContext ? { orchestration: this._orchestrationContext } : {}),
						...(this._subagentPolicy?.intercom ? { intercom: this._subagentPolicy.intercom } : {}),
						toolCallId,
					}),
				read: { autoResizeImages },
				bash: {
					commandPrefix: shellCommandPrefix,
					shellPath,
					get taskOwner() {
						return getTaskOwner();
					},
					operations: {
						exec: (command, cwd, options) =>
							createLocalBashOperations({ shellPath, taskOwner: getTaskOwner() }).exec(command, cwd, options),
					},
					interceptorEnabled: () => this.settingsManager.getBashInterceptorEnabled(),
					availableTools: activeBuiltinTools,
					// Resolved per execution so bash spill files follow the live
					// transcript session across fork/branch/resume.
					sessionTempDir: () => resolveSessionTempDirPath(this.sessionManager.getSessionId()),
					interceptor: async (context) => {
						const result = await this._extensionRunner.emitUserBash({
							type: "user_bash",
							command: context.command,
							excludeFromContext: false,
							cwd: context.cwd,
						});
						return result;
					},
				},
				powershell: {
					get taskOwner() {
						return getTaskOwner();
					},
					operations: {
						exec: (command, cwd, options) =>
							createLocalPowerShellOperations({ taskOwner: getTaskOwner() }).exec(command, cwd, options),
					},
				},
				kill: {
					taskOwner: getTaskOwner,
				},
				search: {
					contextBefore: this.settingsManager.getSearchContextBefore(),
					contextAfter: this.settingsManager.getSearchContextAfter(),
				},
			});

	this._baseToolDefinitions = new Map(
		Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
	);

	const extensionsResult = this._resourceLoader.getExtensions();
	if (options.flagValues) {
		for (const [name, value] of options.flagValues) {
			extensionsResult.runtime.flagValues.set(name, value);
			extensionsResult.runtime.explicitFlagNames ??= new Set();
			extensionsResult.runtime.explicitFlagNames.add(name);
		}
	}

	if (!options.preserveRunner) {
		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			new ModelRegistry(this._modelRuntime),
			this._orchestrationContext,
			this._subagentPolicy,
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);
	}

	const defaultActiveToolNames = this._baseToolsOverride
		? Object.keys(this._baseToolsOverride)
		: [...getDefaultToolNames()];
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
