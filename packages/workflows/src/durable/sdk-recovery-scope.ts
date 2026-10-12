import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isDatabaseExecutor } from "./dbos-owner-fence.js";
import { getAtomicExecutorId } from "./dbos-sdk-handle.js";
import { isLiveRunningWorkflow } from "./resume-eligibility.js";
import type { DurableWorkflowHandle } from "./types.js";

export function canonicalDirectory(path: string): string {
	const absolute = resolve(path);
	try {
		const canonical = realpathSync.native(absolute);
		return process.platform === "win32" ? canonical.toLowerCase() : canonical;
	} catch {
		return process.platform === "win32" ? absolute.toLowerCase() : absolute;
	}
}

export function isSdkDurableRunInScope<
	Handle extends Pick<DurableWorkflowHandle, "workflowId" | "invocationCwd" | "modelOwner" | "rootWorkflowId">,
>(handle: Handle, cwd: string | undefined, canonicalize: (path: string) => string = canonicalDirectory): boolean {
	return (
		cwd !== undefined &&
		handle.invocationCwd !== undefined &&
		handle.modelOwner !== undefined &&
		(handle.rootWorkflowId === undefined || handle.rootWorkflowId === handle.workflowId) &&
		canonicalize(cwd) === canonicalize(handle.invocationCwd)
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

/** A paused run whose owning session was disposed and durably released it for adoption. */
export function isSdkReleasedRunAdoptable(handle: DurableWorkflowHandle, cwd: string | undefined): boolean {
	return (
		isSdkDurableRunInScope(handle, cwd) &&
		handle.status === "paused" &&
		handle.releasedModelOwner !== undefined &&
		handle.releasedModelOwner === handle.modelOwner
	);
}

/** Another SDK session may take over a run its owner crashed on or disposed its session over. */
export function isSdkRunAdoptable(handle: DurableWorkflowHandle, cwd: string | undefined): boolean {
	return isSdkCrashedRunAdoptable(handle, cwd) || isSdkReleasedRunAdoptable(handle, cwd);
}
