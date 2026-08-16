/**
 * Agent discovery and configuration public surface.
 */

export { discoverAgents, discoverAgentsAll } from "./agent-discovery.js";
export type { AgentDirLoadResult, AgentLoadDiagnostic } from "./agent-loaders.js";
export { loadAgentsFromDir, loadAgentsFromDirWithDiagnostics } from "./agent-loaders.js";
export {
	buildBuiltinOverrideConfig,
	removeBuiltinAgentOverride,
	saveBuiltinAgentOverride,
} from "./agent-overrides.js";
export type {
	AgentConfig,
	AgentDefaultContext,
	AgentScope,
	AgentSource,
	BuiltinAgentOverrideBase,
} from "./agent-types.js";
export {
	defaultInheritProjectContext,
	defaultInheritSkills,
	defaultSystemPromptMode,
} from "./agent-types.js";
export { buildRuntimeName, frontmatterNameForConfig, parsePackageName } from "./identity.js";
