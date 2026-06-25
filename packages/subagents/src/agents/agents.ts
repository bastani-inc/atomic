/**
 * Agent discovery and configuration public surface.
 */

export {
	defaultInheritProjectContext,
	defaultInheritSkills,
	defaultSystemPromptMode,
} from "./agent-types.ts";
export type {
	AgentConfig,
	AgentDefaultContext,
	AgentScope,
	AgentSource,
	BuiltinAgentOverrideBase,
	ChainConfig,
	ChainDiscoveryDiagnostic,
	ChainStepConfig,
} from "./agent-types.ts";
export {
	buildBuiltinOverrideConfig,
	removeBuiltinAgentOverride,
	saveBuiltinAgentOverride,
} from "./agent-overrides.ts";
export { discoverAgents, discoverAgentsAll } from "./agent-discovery.ts";
export { buildRuntimeName, frontmatterNameForConfig, parsePackageName } from "./identity.ts";
