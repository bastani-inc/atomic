import type { OutputMode } from "../shared/types.ts";

export type AgentScope = "user" | "project" | "both";

export type AgentSource = "builtin" | "user" | "project";
export type SystemPromptMode = "append" | "replace";
export type AgentDefaultContext = "fresh" | "fork";

export function defaultSystemPromptMode(name: string): SystemPromptMode {
	return name === "delegate" ? "append" : "replace";
}

export function defaultInheritProjectContext(name: string): boolean {
	return name === "delegate";
}

export function defaultInheritSkills(): boolean {
	return false;
}

export interface BuiltinAgentOverrideBase {
	model?: string;
	fallbackModels?: string[];
	fallbackThinkingLevels?: string[];
	thinking?: string;
	systemPromptMode: SystemPromptMode;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	defaultContext?: AgentDefaultContext;
	disabled?: boolean;
	systemPrompt: string;
	skills?: string[];
	tools?: string[];
	mcpDirectTools?: string[];
}

export interface BuiltinAgentOverrideConfig {
	model?: string | false;
	fallbackModels?: string[] | false;
	fallbackThinkingLevels?: string[] | false;
	thinking?: string | false;
	systemPromptMode?: SystemPromptMode;
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
	defaultContext?: AgentDefaultContext | false;
	disabled?: boolean;
	systemPrompt?: string;
	skills?: string[] | false;
	tools?: string[] | false;
}

export interface BuiltinAgentOverrideInfo {
	scope: "user" | "project";
	path: string;
	base: BuiltinAgentOverrideBase;
}

export interface AgentConfig {
	name: string;
	localName?: string;
	packageName?: string;
	description: string;
	tools?: string[];
	mcpDirectTools?: string[];
	model?: string;
	fallbackModels?: string[];
	fallbackThinkingLevels?: string[];
	thinking?: string;
	systemPromptMode: SystemPromptMode;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	defaultContext?: AgentDefaultContext;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
	skills?: string[];
	extensions?: string[];
	output?: string;
	defaultReads?: string[];
	defaultProgress?: boolean;
	interactive?: boolean;
	maxSubagentDepth?: number;
	disabled?: boolean;
	extraFields?: Record<string, string>;
	override?: BuiltinAgentOverrideInfo;
}

export interface SubagentSettings {
	overrides: Record<string, BuiltinAgentOverrideConfig>;
	disableBuiltins?: boolean;
}

export const EMPTY_SUBAGENT_SETTINGS: SubagentSettings = { overrides: {} };

export interface ChainStepConfig {
	agent?: string;
	task?: string;
	phase?: string;
	label?: string;
	as?: string;
	outputSchema?: string | Record<string, unknown>;
	output?: string | false;
	outputMode?: OutputMode;
	reads?: string[] | false;
	model?: string;
	skills?: string[] | false;
	progress?: boolean;
	parallel?: unknown;
	expand?: unknown;
	collect?: unknown;
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
}

export interface ChainConfig {
	name: string;
	localName?: string;
	packageName?: string;
	description: string;
	source: AgentSource;
	filePath: string;
	steps: ChainStepConfig[];
	extraFields?: Record<string, string>;
}

export interface ChainDiscoveryDiagnostic {
	source: "user" | "project";
	filePath: string;
	error: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}
