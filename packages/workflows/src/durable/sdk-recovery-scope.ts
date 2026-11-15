import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { DurableWorkflowBackend } from "./backend.js";
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

/** A root run recorded for `cwd`, whoever started it: a model session or the user's own `/workflow` command. */
export function isProjectRootRun<
	Handle extends Pick<DurableWorkflowHandle, "workflowId" | "invocationCwd" | "rootWorkflowId">,
>(handle: Handle, cwd: string | undefined, canonicalize: (path: string) => string = canonicalDirectory): boolean {
	return (
		cwd !== undefined &&
		handle.invocationCwd !== undefined &&
		(handle.rootWorkflowId === undefined || handle.rootWorkflowId === handle.workflowId) &&
		canonicalize(cwd) === canonicalize(handle.invocationCwd)
	);
}

export function isSdkDurableRunInScope<
	Handle extends Pick<DurableWorkflowHandle, "workflowId" | "invocationCwd" | "modelOwner" | "rootWorkflowId">,
>(handle: Handle, cwd: string | undefined, canonicalize: (path: string) => string = canonicalDirectory): boolean {
	return handle.modelOwner !== undefined && isProjectRootRun(handle, cwd, canonicalize);
}

/**
 * A running run whose owner crashed: nothing executes it. `resuming` is set by a resume of the run, which holds the
 * run's execution scope itself while it decides; no other executor of this process can hold it meanwhile.
 */
export async function isSdkCrashedRunAdoptable(
	handle: DurableWorkflowHandle,
	cwd: string | undefined,
	backend: DurableWorkflowBackend,
	resuming = false,
): Promise<boolean> {
	if (!isSdkDurableRunInScope(handle, cwd) || handle.status !== "running") return false;
	const ownership = await backend.workflowOwnership(handle.workflowId);
	// #5167: a lease this process took over from the crashed owner (to answer a prompt, say) runs nothing here.
	return (
		ownership === "available" ||
		(ownership === "local" &&
			handle.ownerLiveness !== "alive" &&
			(resuming || backend.hasWorkflowExecution?.(handle.workflowId) === false))
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
export async function isSdkRunAdoptable(
	handle: DurableWorkflowHandle,
	cwd: string | undefined,
	backend: DurableWorkflowBackend,
	resuming = false,
): Promise<boolean> {
	return (await isSdkCrashedRunAdoptable(handle, cwd, backend, resuming)) || isSdkReleasedRunAdoptable(handle, cwd);
}
