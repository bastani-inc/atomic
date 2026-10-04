import { resolve } from "node:path";
import { isDatabaseExecutor } from "./dbos-owner-fence.js";
import { getAtomicExecutorId } from "./dbos-sdk-handle.js";
import { isLiveRunningWorkflow } from "./resume-eligibility.js";
import type { DurableWorkflowHandle } from "./types.js";

export function isSdkDurableRunInScope(handle: DurableWorkflowHandle, cwd: string | undefined): boolean {
	return (
		cwd !== undefined &&
		handle.invocationCwd !== undefined &&
		resolve(cwd) === resolve(handle.invocationCwd) &&
		handle.modelOwner !== undefined &&
		(handle.rootWorkflowId === undefined || handle.rootWorkflowId === handle.workflowId)
	);
}

export function isSdkCrashedRunAdoptable(handle: DurableWorkflowHandle, cwd: string | undefined): boolean {
	return (
		isSdkDurableRunInScope(handle, cwd) &&
		handle.status === "running" &&
		handle.ownerExecutorId !== undefined &&
		handle.ownerExecutorId !== getAtomicExecutorId() &&
		!isLiveRunningWorkflow(handle) &&
		isDatabaseExecutor(handle.ownerExecutorId) &&
		handle.ownerLiveness === "dead"
	);
}
