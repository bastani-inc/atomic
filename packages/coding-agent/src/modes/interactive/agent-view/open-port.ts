// S-A (view) owns this module. C0 stub: no subagent can be shown yet.
import type { TaskId } from "../../../core/tasks/contracts.js";
import type { InteractiveModeBase } from "../interactive-mode-base.ts";
import type { AgentViewPort } from "./contracts.ts";

/**
 * Open the port of the subagent `taskId` is an attempt of: over the owner's task view in this process, or through the
 * isolated engine. Undefined when there is no such subagent.
 */
export async function openAgentViewPort(
	_mode: InteractiveModeBase,
	_taskId: TaskId,
): Promise<AgentViewPort | undefined> {
	return undefined;
}
