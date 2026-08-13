import { runSync } from "./execution.ts";
import type { SubagentExecutorRuntimeDeps } from "./subagent-executor-types.ts";

const defaultSubagentExecutorRuntimeDeps: SubagentExecutorRuntimeDeps = {
	runSync,
};

export function resolveSubagentExecutorRuntimeDeps(
	overrides?: Partial<SubagentExecutorRuntimeDeps>,
): SubagentExecutorRuntimeDeps {
	return { ...defaultSubagentExecutorRuntimeDeps, ...overrides };
}
