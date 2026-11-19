import type { RunSnapshot } from "../shared/store-types.js";
import { type DurableWorkflowBackend, resumableEntryFromHandle } from "./backend.js";
import { JournalOwnershipError } from "./journal/journal-backend.js";
import { isDurableWorkflowResumable } from "./resume-eligibility.js";
import type { ResumeDurableResult } from "./resume-runtime.js";
import { foreignInstanceMessage } from "./sdk-owner-release.js";
import type { DurableWorkflowHandle, ResumableWorkflowEntry } from "./types.js";

/** A later claim can change the status before its executor records the next attempt. Match both boundaries. */
export function blockAttemptKey(backend: DurableWorkflowBackend, id: string): string {
	return `${backend.workflowAttempt?.(id) ?? 0}:${backend.getWorkflow(id)?.transitionClaimId ?? ""}`;
}

export function uncommittedBlockKind(
	backend: DurableWorkflowBackend,
	handle: DurableWorkflowHandle,
	block: Pick<RunSnapshot, "blockAttempt"> | undefined,
): "current" | "earlier" | undefined {
	if (!block || handle.status !== "running" || handle.resumable === false) return undefined;
	const current = blockAttemptKey(backend, handle.workflowId);
	if (block.blockAttempt !== undefined) return block.blockAttempt === current ? "current" : undefined;
	// Older claims could keep the same running status and generation. If ordinary durable progress exists,
	// do not repair anything from an unversioned entry: just offer the already-resumable journal version.
	if (isDurableWorkflowResumable(handle)) return "earlier";
	// A first attempt with no progress could not have been claimed by an ordinary durable resume.
	return current === "0:" ? "current" : undefined;
}

type Refusal = Extract<ResumeDurableResult, { ok: false }>;

export function retainedLeaseResult(workflowId: string): Refusal {
	return {
		ok: false,
		reason: "owned_elsewhere",
		message: `Another Atomic process may still own workflow ${workflowId}. Retry after its journal lease expires.`,
	};
}

/** Inside resume admission: finish only a matching block's missing write; ordinary journal admission follows. */
export async function reconcileRestoredRun(
	backend: DurableWorkflowBackend,
	run: RunSnapshot,
	selectedVersion: number | undefined,
	signal?: AbortSignal,
): Promise<ResumableWorkflowEntry | Refusal | undefined> {
	const id = run.id;
	const handle = backend.getLoadableWorkflow(id);
	if (!handle) return undefined;
	if (handle.modelOwner !== run.modelOwner)
		return { ok: false, reason: "owned_elsewhere", message: foreignInstanceMessage(backend, id) };
	const stale: Refusal = {
		ok: false,
		reason: "stale",
		message: `Workflow ${id} changed; reopen /workflows before resuming.`,
	};
	if (
		run.earlierBlockVersion !== undefined &&
		(handle.status !== "running" || handle.updatedAt !== run.earlierBlockVersion)
	)
		return stale;
	if ((await backend.workflowOwnership(id)) === "foreign") return retainedLeaseResult(id);
	if (handle.status !== "running" || run.blockedAt === undefined) return undefined;
	if (selectedVersion !== undefined && selectedVersion !== handle.updatedAt) return stale;
	const kind = uncommittedBlockKind(backend, handle, run);
	if (kind === undefined) return stale;
	if (kind === "earlier") return resumableEntryFromHandle(handle);
	// Repair before the ordinary blocked -> running claim so a zero-checkpoint resume has a fresh generation too.
	signal?.throwIfAborted();
	try {
		if (
			!(await backend.commitWorkflowStatusTransition(
				id,
				["running"],
				"blocked",
				undefined,
				true,
				handle.updatedAt,
				undefined,
				undefined,
				run.runGeneration,
			))
		)
			return stale;
	} catch (error) {
		if (error instanceof JournalOwnershipError) return retainedLeaseResult(id);
		throw error;
	}
	const repaired = backend.getLoadableWorkflow(id);
	return repaired?.status === "blocked" && repaired.modelOwner === run.modelOwner
		? resumableEntryFromHandle(repaired)
		: stale;
}
