/**
 * Agent discovery and configuration public surface.
 */

export { discoverAgents, discoverAgentsAll } from "./agent-discovery.ts";
export type { AgentDirLoadResult, AgentLoadDiagnostic } from "./agent-loaders.ts";
export { loadAgentsFromDir, loadAgentsFromDirWithDiagnostics } from "./agent-loaders.ts";
export {
	buildBuiltinOverrideConfig,
	removeBuiltinAgentOverride,
	saveBuiltinAgentOverride,
} from "./agent-overrides.ts";
export type {
	AgentConfig,
	AgentDefaultContext,
	AgentScope,
	AgentSource,
	BuiltinAgentOverrideBase,
} from "./agent-types.ts";
export {
	defaultInheritProjectContext,
	defaultInheritSkills,
	defaultSystemPromptMode,
} from "./agent-types.ts";
export { buildRuntimeName, frontmatterNameForConfig, parsePackageName } from "./identity.js";
