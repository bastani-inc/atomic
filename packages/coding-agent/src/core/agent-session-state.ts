import { getCurrentSystemMessage, type SystemMessage } from "@bastani/pi-ai";
import type { Api, Model } from "@bastani/pi-ai/compat";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { getCallableTools } from "./agent-session-nested-tools.js";
import type { ToolDefinition, ToolInfo } from "./extensions/index.js";
import { getSkillCatalog } from "./skill-catalog.ts";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	diffSystemPromptSections,
	type NormalizedBuildSystemPromptOptions,
	normalizeBuildSystemPromptOptions,
} from "./system-prompt.ts";
import { applyToolLoadout, isToolDeclarationHidden } from "./tool-loadout.js";

export function getActiveToolNames(this: AgentSession): string[] {
	return this.agent.state.tools.map((t) => t.name);
}

export function getCallableToolNames(this: AgentSession): string[] {
	return getCallableTools(this).map((tool) => tool.name);
}

/**
 * Get all configured tools with name, description, parameter schema, and source metadata.
 */

export function getAllTools(this: AgentSession): ToolInfo[] {
	return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
		...(Object.hasOwn(definition, "constrainedSampling")
			? { constrainedSampling: definition.constrainedSampling }
			: {}),
		promptGuidelines: definition.promptGuidelines,
		exposure: definition.exposure ?? "direct",
		namespace: definition.namespace,
		annotations: definition.annotations,
		sourceInfo,
	}));
}

export function getToolDefinition(this: AgentSession, name: string): ToolDefinition | undefined {
	return this._toolDefinitions.get(name)?.definition;
}

/**
 * Set active tools by name.
 * Only tools in the registry can be enabled. Unknown tool names are ignored.
 * Also rebuilds the system prompt to reflect the new tool set.
 * Changes take effect on the next agent turn.
 */

export function setActiveToolsByName(this: AgentSession, toolNames: string[]): void {
	const previous = this.getActiveToolNames();
	this._setActiveTools(toolNames);
	const active = new Set(this.getActiveToolNames());
	if (previous.some((name) => !active.has(name))) this._pendingToolNames.clear();
}

export function _setActiveTools(this: AgentSession, toolNames: string[]): void {
	const tools = applyToolLoadout(this, toolNames);
	for (const tool of tools) this._pendingToolNames.delete(tool.name);
	this._rebuildSystemPrompt(tools.map((tool) => tool.name));
}

/** Whether compaction or branch summarization is currently running */

export function setScopedModels(
	this: AgentSession,
	scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>,
): void {
	this._scopedModels = scopedModels;
}

/** File-based prompt templates */

export function _normalizePromptSnippet(this: AgentSession, text: string | undefined): string | undefined {
	if (!text) return undefined;
	const oneLine = text
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return oneLine.length > 0 ? oneLine : undefined;
}

export function _normalizePromptGuidelines(this: AgentSession, guidelines: string[] | undefined): string[] {
	if (!guidelines || guidelines.length === 0) {
		return [];
	}

	const unique = new Set<string>();
	for (const guideline of guidelines) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			unique.add(normalized);
		}
	}
	return Array.from(unique);
}

export function _rebuildSystemPrompt(this: AgentSession, toolNames: string[]): void {
	const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
	const toolSnippets: Record<string, string> = {};
	for (const name of this._toolRegistry.keys()) {
		const snippet = this._toolPromptSnippets.get(name);
		if (snippet && !isToolDeclarationHidden(this, name)) {
			toolSnippets[name] = snippet;
		}
	}

	const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
	const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
	const appendSystemPrompt = loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
	const loadedSkills = getSkillCatalog(this._resourceLoader).modelSkills();
	const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

	this._baseSystemPromptOptions = normalizeBuildSystemPromptOptions({
		cwd: this._cwd,
		selectedModel: this.model,
		selectedThinkingLevel: this.thinkingLevel,
		skills: loadedSkills,
		contextFiles: loadedContextFiles,
		customPrompt: loaderSystemPrompt,
		appendSystemPrompt,
		selectedTools: validToolNames,
		excludedTools: this._excludedToolNames ? Array.from(this._excludedToolNames) : undefined,
		toolSnippets,
		toolGuidelines: Object.fromEntries(this._toolPromptGuidelines),
	});
	if (this._systemPromptTransform) {
		this._baseSystemPromptOptions.forceSystemPrompt = this._systemPromptTransform(
			buildSystemPrompt(this._baseSystemPromptOptions),
		);
	}
}

export function _refreshBaseSystemPromptFromActiveTools(this: AgentSession): void {
	this._rebuildSystemPrompt(this.getActiveToolNames());
}

/** Diff structured prompt state; executable tool changes are declared by the agent loop. */
export function _preparePromptAndToolLoadout(
	this: AgentSession,
	options: NormalizedBuildSystemPromptOptions,
	messages: AgentMessage[] = this.agent.state.messages,
): SystemMessage | undefined {
	const current = getCurrentSystemMessage(messages);
	const selected = [...new Set(options.selectedTools)].filter((name) => this._toolRegistry.has(name));
	const recorded = (current?.toolsAdded ?? []).map((tool) => tool.name).filter((name) => selected.includes(name));
	options.selectedTools = [...recorded, ...selected.filter((name) => !recorded.includes(name))];
	options.selectedTools = applyToolLoadout(this, options.selectedTools).map((tool) => tool.name);
	options.toolSnippets = Object.fromEntries(
		Object.entries(options.toolSnippets).filter(([name]) => !isToolDeclarationHidden(this, name)),
	);
	const sections = diffSystemPromptSections(current?.sections ?? {}, buildSystemPromptSections(options));
	return sections ? { role: "system", content: "", sections, timestamp: Date.now() } : undefined;
}

/** Restore registered tools from the selected transcript, not another branch's live state. */
export function _restoreToolsFromTranscript(this: AgentSession): void {
	this._pendingToolNames.clear();
	const current = getCurrentSystemMessage(this.sessionManager.buildSessionContext().messages);
	if (!current) return;
	const names = (current.toolsAdded ?? []).map((tool) => tool.name);
	this._pendingToolNames = new Set(names);
	this._setActiveTools(names);
}

// =========================================================================
// Prompting
// =========================================================================

/**
 * Send a prompt to the agent.
 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
 * - Expands file-based prompt templates by default
 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
 * - Validates model and API key before sending (when not streaming)
 * @throws Error if streaming and no streamingBehavior specified
 * @throws Error if no model selected or no API key available (when not streaming)
 */

export const agentSessionStateMethods = {
	getActiveToolNames,
	getCallableToolNames,
	getAllTools,
	getToolDefinition,
	setActiveToolsByName,
	_setActiveTools,
	setScopedModels,
	_normalizePromptSnippet,
	_normalizePromptGuidelines,
	_rebuildSystemPrompt,
	_preparePromptAndToolLoadout,
	_restoreToolsFromTranscript,
	_refreshBaseSystemPromptFromActiveTools,
};
