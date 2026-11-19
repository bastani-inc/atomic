/**
 * Agent discovery and configuration public surface.
 */

export {
	type AgentDiscoveryOptions,
	contextAgentDiscoveryOptions,
	discoverAgents,
	discoverAgentsAll,
	packageAgentInScope,
} from "./agent-discovery.js";
export type { AgentDirLoadResult, AgentLoadDiagnostic } from "./agent-loaders.js";
export {
	loadAgentsFromDir,
	loadAgentsFromDirWithDiagnostics,
	loadPackageAgentsWithDiagnostics,
} from "./agent-loaders.js";
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
	PackageAgentOrigin,
} from "./agent-types.js";
export {
	defaultInheritProjectContext,
	defaultInheritSkills,
	defaultSystemPromptMode,
} from "./agent-types.js";
export { buildRuntimeName, frontmatterNameForConfig, packageAgentNamespace, parsePackageName } from "./identity.js";
