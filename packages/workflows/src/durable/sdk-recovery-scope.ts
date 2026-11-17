import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
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

export async function canonicalDirectoryAsync(path: string): Promise<string> {
	const absolute = resolve(path);
	try {
		const canonical = await realpath(absolute);
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

export async function isProjectRootRunAsync<
	Handle extends Pick<DurableWorkflowHandle, "workflowId" | "invocationCwd" | "rootWorkflowId">,
>(
	handle: Handle,
	cwd: string | undefined,
	canonicalize: (path: string) => Promise<string> = canonicalDirectoryAsync,
): Promise<boolean> {
	if (
		cwd === undefined ||
		handle.invocationCwd === undefined ||
		(handle.rootWorkflowId !== undefined && handle.rootWorkflowId !== handle.workflowId)
	) {
		return false;
	}
	const [resolvedCwd, resolvedInvocationCwd] = await Promise.all([
		canonicalize(cwd),
		canonicalize(handle.invocationCwd),
	]);
	return resolvedCwd === resolvedInvocationCwd;
}

export function isSdkDurableRunInScope<
	Handle extends Pick<DurableWorkflowHandle, "workflowId" | "invocationCwd" | "modelOwner" | "rootWorkflowId">,
>(handle: Handle, cwd: string | undefined, canonicalize: (path: string) => string = canonicalDirectory): boolean {
	return handle.modelOwner !== undefined && isProjectRootRun(handle, cwd, canonicalize);
}

export async function isSdkDurableRunInScopeAsync<
	Handle extends Pick<DurableWorkflowHandle, "workflowId" | "invocationCwd" | "modelOwner" | "rootWorkflowId">,
>(
	handle: Handle,
	cwd: string | undefined,
	canonicalize: (path: string) => Promise<string> = canonicalDirectoryAsync,
): Promise<boolean> {
	return handle.modelOwner !== undefined && (await isProjectRootRunAsync(handle, cwd, canonicalize));
}

/** A running run whose owner crashed: nothing executes it. */
export async function isSdkCrashedRunAdoptable(
	handle: DurableWorkflowHandle,
	cwd: string | undefined,
	backend: DurableWorkflowBackend,
): Promise<boolean> {
	if (handle.status !== "running" || !(await isSdkDurableRunInScopeAsync(handle, cwd))) return false;
	const ownership = await backend.workflowOwnership(handle.workflowId);
	// #5167: a lease this backend took over from the crashed owner (to answer a prompt, say) runs nothing here. A lease
	// another session of this process holds is that session's, so it is not adoptable.
	return (
		ownership === "available" ||
		(ownership === "local" &&
			handle.ownerLiveness !== "alive" &&
			backend.holdsIdleWorkflowLease?.(handle.workflowId) === true)
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

export async function isSdkReleasedRunAdoptableAsync(
	handle: DurableWorkflowHandle,
	cwd: string | undefined,
): Promise<boolean> {
	return (
		handle.status === "paused" &&
		handle.releasedModelOwner !== undefined &&
		handle.releasedModelOwner === handle.modelOwner &&
		(await isSdkDurableRunInScopeAsync(handle, cwd))
	);
}

/** Another SDK session may take over a run its owner crashed on or disposed its session over. */
export async function isSdkRunAdoptable(
	handle: DurableWorkflowHandle,
	cwd: string | undefined,
	backend: DurableWorkflowBackend,
): Promise<boolean> {
	return (await isSdkCrashedRunAdoptable(handle, cwd, backend)) || (await isSdkReleasedRunAdoptableAsync(handle, cwd));
}
