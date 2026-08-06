import type { AgentConfig } from "../../agents/agent-types.ts";
import type { RunSyncOptions, SingleResult } from "../../shared/types.ts";
import { runSingleInProcess } from "./inprocess-run-sync.ts";

/**
 * Kept as the local foreground seam while callers migrate to the in-process door.
 * Structured output correction is handled by the SDK custom-tool policy in the
 * new runner; no process retry or stdout parser remains here.
 */
export function runSingleAttemptWithStructuredOutputRetries(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	_model: string | undefined,
	options: RunSyncOptions,
	_shared: object,
): Promise<SingleResult> {
	return runSingleInProcess(runtimeCwd, agent, task, options);
}
