import { executeAsyncChain, executeAsyncSingle, formatAsyncStartedMessage, isAsyncAvailable } from "../background/async-execution.ts";
import { runSync } from "./execution.ts";
import type { SubagentExecutorRuntimeDeps } from "./subagent-executor-types.ts";

const defaultSubagentExecutorRuntimeDeps: SubagentExecutorRuntimeDeps = {
	runSync,
	executeAsyncChain,
	executeAsyncSingle,
	isAsyncAvailable,
	formatAsyncStartedMessage,
};

export function resolveSubagentExecutorRuntimeDeps(
	overrides?: Partial<SubagentExecutorRuntimeDeps>,
): SubagentExecutorRuntimeDeps {
	return { ...defaultSubagentExecutorRuntimeDeps, ...overrides };
}
