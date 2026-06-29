import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition, ToolInfo } from "./extensions/index.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { buildSystemPrompt } from "./system-prompt.ts";

export function getActiveToolNames(this: AgentSession): string[] {
	return this.agent.state.tools.map((t) => t.name);
}

/**
 * Get all configured tools with name, description, parameter schema, and source metadata.
 */

export function getAllTools(this: AgentSession): ToolInfo[] {
	return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
		promptGuidelines: definition.promptGuidelines,
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
	const tools: AgentTool[] = [];
	const validToolNames: string[] = [];
	for (const name of toolNames) {
		const tool = this._toolRegistry.get(name);
		if (tool) {
			tools.push(tool);
			validToolNames.push(name);
		}
	}
	this.agent.state.tools = tools;

	// Rebuild base system prompt with new tool set
	this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
	this.agent.state.systemPrompt = this._baseSystemPrompt;
}

/** Whether compaction or branch summarization is currently running */

export function setScopedModels(this: AgentSession, scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>): void {
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


export function _rebuildSystemPrompt(this: AgentSession, toolNames: string[]): string {
	const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
	const toolSnippets: Record<string, string> = {};
	const promptGuidelines: string[] = [];
	for (const name of validToolNames) {
		const snippet = this._toolPromptSnippets.get(name);
		if (snippet) {
			toolSnippets[name] = snippet;
		}

		const toolGuidelines = this._toolPromptGuidelines.get(name);
		if (toolGuidelines) {
			promptGuidelines.push(...toolGuidelines);
		}
	}

	const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
	const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
	const appendSystemPrompt =
		loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
	const loadedSkills = this._resourceLoader.getSkills().skills;
	const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

	this._baseSystemPromptOptions = {
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
		promptGuidelines,
	};
	return buildSystemPrompt(this._baseSystemPromptOptions);
}


export function _refreshBaseSystemPromptFromActiveTools(this: AgentSession): void {
	this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
	this.agent.state.systemPrompt = this._baseSystemPrompt;
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
	getAllTools,
	getToolDefinition,
	setActiveToolsByName,
	setScopedModels,
	_normalizePromptSnippet,
	_normalizePromptGuidelines,
	_rebuildSystemPrompt,
	_refreshBaseSystemPromptFromActiveTools,
};
