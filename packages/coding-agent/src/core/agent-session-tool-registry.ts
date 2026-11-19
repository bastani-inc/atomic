import type { AgentTool } from "@bastani/atomic-agent-core";
import { shellCommandPrefixFor } from "./agent-session-blueprint-environment.ts";
import { detachableTool, forgetDetachableTools } from "./agent-session-detached-tools.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { isWorkflowStageTaskOwner } from "./agent-session-tasks.js";
import type { ToolDefinitionEntry } from "./agent-session-types.js";
import { SESSION_HISTORY_TOOL_NAME } from "./compaction/context-clear.js";
import { hostInputError } from "./extensions/host-input.js";
import { ExtensionRunner, type ToolDefinition, wrapRegisteredTools } from "./extensions/index.js";
import { isMandatoryRuntimeTool, isTrustedMandatoryRuntimeTool } from "./mandatory-runtime-tools.ts";
import { isSelectedNativeMcpTool } from "./mcp-child-policy.ts";
import { ModelRegistry } from "./model-registry.ts";
import { withWorktreeRootMappings } from "./resume/path-mapping.ts";
import { getLatestCompactionBoundaryEntry } from "./session-manager-history.ts";
import { createSyntheticSourceInfo } from "./source-info.ts";
import { notifyAgentPanelSourceHubRebound } from "./tasks/agent-panel-source.ts";
import {
	isRegisteredToolAllowed,
	isToolActivatable,
	activatesOnRegistration as toolActivatesOnRegistration,
} from "./tool-selection.ts";
import { createLocalBashOperations } from "./tools/bash.js";
import { createHistoryRouter } from "./tools/history-protocol.ts";
import { createToolDefinitionsFor, defaultToolSelectionFor } from "./tools/index.js";
import { rejectMalformedToolArguments } from "./tools/malformed-tool-arguments.ts";
import { createLocalPowerShellOperations } from "./tools/powershell.ts";
import { createSessionHistoryToolDefinition } from "./tools/session-history.ts";
import { resolveSessionTempDirPath } from "./tools/session-temp-dir.ts";
import { withToolAbortGrace } from "./tools/tool-abort-grace.ts";
import { scheduleToolExecution } from "./tools/tool-concurrency.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";

/** Whether the branch has a clear-or-compact boundary, so a restricted agent may need its history tool. */
function hasClearOrCompactBoundary(session: AgentSession): boolean {
	const boundary = getLatestCompactionBoundaryEntry(session.sessionManager.getBranch());
	return boundary !== null && boundary.firstKeptEntryId === null && boundary.details?.form !== undefined;
}

export function _refreshToolRegistry(
	this: AgentSession,
	options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean },
): void {
	const previousRegistryNames = new Set(this._toolRegistry.keys());
	const previousActiveToolNames = this.getActiveToolNames();
	const allowedTools = this._allowedTools;
	const isExposedTool = (name: string): boolean => isRegisteredToolAllowed(this, name);

	const registeredTools = this._extensionRunner
		.getAllRegisteredTools()
		.filter((tool) => !isMandatoryRuntimeTool(tool.definition.name) || isTrustedMandatoryRuntimeTool(tool));
	const selectedMcpTools = new Set(
		registeredTools.filter(
			(tool) => !this._excludedTools?.(tool.definition.name) && isSelectedNativeMcpTool(tool, this._subagentPolicy),
		),
	);
	const selectedMcpNames = new Set([...selectedMcpTools].map((tool) => tool.definition.name));
	const allCustomTools = [
		...registeredTools,
		...this._customTools
			.filter((definition) => !isMandatoryRuntimeTool(definition.name))
			.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
	].filter((tool) => isExposedTool(tool.definition.name) || selectedMcpTools.has(tool));
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

	const toolRegistry = new Map<string, AgentTool>();
	forgetDetachableTools(this);
	// A built-in question belongs to the UI of the session that asks it, and ends with that session, except on a workflow
	// stage, whose own UI keeps it: only there may it outlive its run.
	const questionsDetach = isWorkflowStageTaskOwner(this);
	const wrapSessionTool = (tool: AgentTool): AgentTool => {
		const builtInQuestion =
			!this._baseToolsOverride && tool.name === "ask_user_question" && wrappedBuiltInTools.includes(tool);
		const abortError = builtInQuestion
			? () =>
					runner.createContext().hasHumanInput
						? hostInputError("HumanInputCancelled")
						: new Error("Operation aborted")
			: undefined;
		const scoped: AgentTool = {
			...tool,
			execute: (...args) =>
				withWorktreeRootMappings(
					this.sessionManager.getWorktreeRootMappings(),
					() => tool.execute(...args),
					this._outerWorktreeRootMappings,
					this.sessionManager.getWorktreePathContinuations(),
				),
		};
		const guarded = rejectMalformedToolArguments(scoped, () => this.agent.state.messages);
		// Inside the scheduler: a call its interrupted turn stopped waiting for no longer holds back later calls (#5486).
		const scheduled = scheduleToolExecution(withToolAbortGrace(guarded), this._toolExecutionScheduler, abortError);
		const definition = definitionRegistry.get(tool.name)?.definition;
		const detachable = builtInQuestion && !questionsDetach ? undefined : definition?.detachable;
		return definition !== undefined && (detachable === true || typeof detachable === "function")
			? detachableTool(
					this,
					scheduled,
					(id, params, signal, onUpdate, context) => definition.execute(id, params, signal, onUpdate, context),
					(id, signal) => runner.createToolContext(id, signal),
					typeof detachable === "function" ? (params) => detachable(params) : undefined,
					definition.detachmentRequiresReady === true,
					abortError,
				)
			: scheduled;
	};
	for (const tool of [...wrappedBuiltInTools, ...(wrappedExtensionTools as AgentTool[])]) {
		toolRegistry.set(tool.name, wrapSessionTool(tool));
	}
	this._toolRegistry = toolRegistry;

	const nextActiveToolNames = (
		options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
	).filter((name) => name !== SESSION_HISTORY_TOOL_NAME && (isExposedTool(name) || selectedMcpNames.has(name)));

	const activatesOnRegistration = (name: string): boolean =>
		toolActivatesOnRegistration(
			this,
			name,
			this._toolDefinitions.get(name)?.definition,
			previousRegistryNames.has(name),
		);
	if (allowedTools) {
		for (const toolName of this._toolRegistry.keys()) {
			const exposure = this._toolDefinitions.get(toolName)?.definition.exposure ?? "direct";
			if (
				(allowedTools(toolName) && (exposure === "direct" || exposure === "model-only")) ||
				(selectedMcpNames.has(toolName) && activatesOnRegistration(toolName))
			) {
				nextActiveToolNames.push(toolName);
			}
		}
	} else if (options?.includeAllExtensionTools) {
		for (const tool of wrappedExtensionTools) {
			if (activatesOnRegistration(tool.name)) nextActiveToolNames.push(tool.name);
		}
	} else if (!options?.activeToolNames) {
		for (const toolName of this._toolRegistry.keys()) {
			if (!previousRegistryNames.has(toolName) && activatesOnRegistration(toolName)) {
				nextActiveToolNames.push(toolName);
			}
		}
	}

	for (const name of this._pendingToolNames) {
		if (name !== SESSION_HISTORY_TOOL_NAME && (isExposedTool(name) || selectedMcpNames.has(name))) {
			nextActiveToolNames.push(name);
		}
	}

	this._setActiveTools([...new Set(nextActiveToolNames)]);
}

/**
 * Ensure `session_history` is registered and active whenever the branch has a clear-or-compact boundary and the
 * active tools lack `read` or `search`, and absent when both `read` and `search` are active.
 */
export function syncSessionHistoryTool(session: AgentSession, toolNames: readonly string[]): string[] {
	const customHistory =
		session._toolDefinitions.has(SESSION_HISTORY_TOOL_NAME) &&
		session._toolDefinitions.get(SESSION_HISTORY_TOOL_NAME)?.sourceInfo.source !== "builtin";
	const names = customHistory ? [...toolNames] : toolNames.filter((name) => name !== SESSION_HISTORY_TOOL_NAME);
	const active = new Set(
		names.filter((name) => {
			const tool = session._toolRegistry.get(name);
			const exposure = session.getToolDefinition(name)?.exposure ?? "direct";
			return (
				tool !== undefined &&
				exposure !== "hidden" &&
				isToolActivatable(session, name, exposure, session._toolRegistry.has("tool_search"))
			);
		}),
	);
	const needsHistory =
		!customHistory &&
		(session._sessionHistoryToolEnabled || hasClearOrCompactBoundary(session)) &&
		(!active.has("read") || !active.has("search"));
	if (needsHistory) {
		if (!session._toolDefinitions.has(SESSION_HISTORY_TOOL_NAME)) {
			const historyTool = {
				definition: createSessionHistoryToolDefinition(SESSION_HISTORY_TOOL_NAME, {
					sessionId: () => session.sessionManager.getSessionId(),
					router: () =>
						createHistoryRouter({
							cwd: session._cwd,
							currentSessionId: session.sessionManager.getSessionId(),
							sessionStore: () => session.sessionManager.getSessionStore(),
						}),
				}) as ToolDefinition,
				sourceInfo: createSyntheticSourceInfo(`<builtin:${SESSION_HISTORY_TOOL_NAME}>`, { source: "builtin" }),
			};
			session._toolDefinitions.set(SESSION_HISTORY_TOOL_NAME, historyTool);
			const snippet = session._normalizePromptSnippet(historyTool.definition.promptSnippet);
			if (snippet) session._toolPromptSnippets.set(SESSION_HISTORY_TOOL_NAME, snippet);
			const guidelines = session._normalizePromptGuidelines(historyTool.definition.promptGuidelines);
			if (guidelines.length > 0) session._toolPromptGuidelines.set(SESSION_HISTORY_TOOL_NAME, guidelines);
			for (const tool of wrapRegisteredTools([historyTool], session._extensionRunner)) {
				const scoped: AgentTool = {
					...tool,
					execute: (...args) =>
						withWorktreeRootMappings(
							session.sessionManager.getWorktreeRootMappings(),
							() => tool.execute(...args),
							session._outerWorktreeRootMappings,
							session.sessionManager.getWorktreePathContinuations(),
						),
				};
				const guarded = rejectMalformedToolArguments(scoped, () => session.agent.state.messages);
				session._toolRegistry.set(tool.name, scheduleToolExecution(guarded, session._toolExecutionScheduler));
			}
		}
		return [...names, SESSION_HISTORY_TOOL_NAME];
	}
	if (!customHistory && session._toolDefinitions.has(SESSION_HISTORY_TOOL_NAME)) {
		session._toolDefinitions.delete(SESSION_HISTORY_TOOL_NAME);
		session._toolPromptSnippets.delete(SESSION_HISTORY_TOOL_NAME);
		session._toolPromptGuidelines.delete(SESSION_HISTORY_TOOL_NAME);
		session._toolRegistry.delete(SESSION_HISTORY_TOOL_NAME);
	}
	return names;
}

export function _buildRuntime(
	this: AgentSession,
	options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
		preserveRunner?: boolean;
		powerShellAvailable: boolean;
	},
): void {
	const autoResizeImages = this.settingsManager.getImageAutoResize();
	// Resolved per command, so `$ENVRC` written by a blueprint build that ends after the tool is created still applies.
	const shellCommandPrefix = () => shellCommandPrefixFor(this, this.settingsManager.getShellCommandPrefix());
	const shellPath = this.settingsManager.getShellPath();
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
		: createToolDefinitionsFor(
				this._cwd,
				{
					read: { autoResizeImages },
					bash: {
						get commandPrefix() {
							return shellCommandPrefix();
						},
						shellPath,
						get taskOwner() {
							return getTaskOwner();
						},
						operations: {
							exec: (command, cwd, options) =>
								createLocalBashOperations({ shellPath, taskOwner: getTaskOwner() }).exec(command, cwd, options),
						},
						// Resolved per execution so bash spill files follow the live
						// transcript session across fork/branch/resume.
						sessionTempDir: () => resolveSessionTempDirPath(this.sessionManager.getSessionId()),
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
				},
				options.powerShellAvailable,
			);

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
			this._intercomPolicy,
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);
		notifyAgentPanelSourceHubRebound(this);
	}

	const defaultActiveToolNames = this._baseToolsOverride
		? Object.keys(this._baseToolsOverride)
		: [...defaultToolSelectionFor(options.powerShellAvailable, this._resourceLoader)];
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
