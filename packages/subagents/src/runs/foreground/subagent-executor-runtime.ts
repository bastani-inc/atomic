import { runSync } from "./execution.js";
import type { SubagentExecutorRuntimeDeps } from "./subagent-executor-types.js";

const defaultSubagentExecutorRuntimeDeps: SubagentExecutorRuntimeDeps = {
	runSync,
};

export function resolveSubagentExecutorRuntimeDeps(
	overrides?: Partial<SubagentExecutorRuntimeDeps>,
): SubagentExecutorRuntimeDeps {
	return { ...defaultSubagentExecutorRuntimeDeps, ...overrides };
}
