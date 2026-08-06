import { formatAsyncStartedMessage, isAsyncAvailable } from "../inprocess/background.ts";
import { executeAsyncSingle } from "../inprocess/background-single.ts";
import { runSync } from "./execution.ts";
import type { SubagentExecutorRuntimeDeps } from "./subagent-executor-types.ts";

const defaultSubagentExecutorRuntimeDeps: SubagentExecutorRuntimeDeps = {
	runSync,
	executeAsyncSingle,
	isAsyncAvailable,
	formatAsyncStartedMessage,
};

export function resolveSubagentExecutorRuntimeDeps(
	overrides?: Partial<SubagentExecutorRuntimeDeps>,
): SubagentExecutorRuntimeDeps {
	return { ...defaultSubagentExecutorRuntimeDeps, ...overrides };
}
