import type { SubagentChildPolicy } from "@bastani/atomic";

export type ChildModePolicy = SubagentChildPolicy;

/**
 * Resolve the child-mode capabilities at the in-process admission door.
 *
 * Every admitted child is management-restricted. Fanout is granted only when
 * the admitted tool allowlist explicitly includes the subagent tool; an
 * omitted allowlist cannot widen a descendant's capabilities.
 */
export function resolveChildModePolicy(spec: {
	readonly tools?: readonly string[];
	readonly agent: {
		readonly tools?: readonly string[];
		readonly inheritProjectContext: boolean;
		readonly inheritSkills: boolean;
	};
}): ChildModePolicy {
	const tools = spec.tools ?? spec.agent.tools;
	return {
		managementActions: "restricted",
		fanoutAuthorized: tools?.includes("subagent") === true,
		inheritProjectContext: spec.agent.inheritProjectContext,
		inheritSkills: spec.agent.inheritSkills,
	};
}
