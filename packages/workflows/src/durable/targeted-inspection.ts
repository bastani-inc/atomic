import { inspectRun, type RunDetail } from "../runs/background/run-inspect.js";
import { createStore, type Store } from "../shared/store.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { durableWorkflowRunSnapshots } from "./completed-catalog.js";
import { getAtomicExecutorId } from "./dbos-sdk-handle.js";
import { isForeignLiveWorkflow, isLiveRunningWorkflow } from "./resume-eligibility.js";

export type TargetedDurableInspection =
	| {
			readonly kind: "found";
			readonly detail: RunDetail;
			readonly runs: readonly RunSnapshot[];
			readonly store: Store;
	  }
	| { readonly kind: "absent" | "deleted" | "malformed"; readonly message: string };

/**
 * Hydrate and reconstruct one exact durable root for inspection only.
 *
 * This path never claims ownership, changes durable status, starts execution,
 * or restores snapshots into the current session store.
 */
export async function inspectTargetedDurableWorkflow(
	backend: DurableWorkflowBackend,
	workflowId: string,
	now: number = Date.now(),
): Promise<TargetedDurableInspection> {
	const hydrated = backend.hydrateWorkflowForInspection
		? await backend.hydrateWorkflowForInspection(workflowId)
		: await hydrateWithoutClassification(backend, workflowId);
	if (hydrated.kind !== "current") return hydrationFailure(workflowId, hydrated.kind);
	const handle = hydrated.handle;
	if (handle.rootWorkflowId !== undefined && handle.rootWorkflowId !== handle.workflowId) {
		return malformed(workflowId, "the requested id belongs to a nested workflow rather than a durable root");
	}
	const reconstructed = durableWorkflowRunSnapshots(backend, handle);
	if (reconstructed.length === 0)
		return malformed(workflowId, "durable checkpoint topology is malformed or incomplete");
	const runs = structuredClone(reconstructed);

	const inspectionStore = createStore();
	for (const run of runs) inspectionStore.recordRunStart(structuredClone(run));
	const inspected = inspectRun(workflowId, { store: inspectionStore });
	if (!inspected.ok) return malformed(workflowId, "the durable checkpoint graph has no reciprocal root");

	const foreignLive = isForeignLiveWorkflow(handle, getAtomicExecutorId(), now);
	const live = isLiveRunningWorkflow(handle, now);
	const crashed = handle.status === "running" && !live;
	const resumeGuidance = crashed
		? inspected.detail.resumable === true
			? `This workflow appears to have crashed and is resumable. Resume it explicitly with /workflow resume ${workflowId}.`
			: "This workflow appears to have crashed, but its retained state is not resumable."
		: foreignLive
			? "This workflow is actively running in another Atomic session. Inspect it here, but control it from its owner session."
			: live
				? "This workflow still has a fresh durable heartbeat. Inspect it here without starting another executor."
				: terminalGuidance(handle.status, workflowId, inspected.detail.resumable === true);
	return {
		kind: "found",
		runs,
		store: inspectionStore,
		detail: {
			...inspected.detail,
			...(crashed ? { status: "crashed" as const } : {}),
			...(live ? { resumable: false } : {}),
			...(foreignLive ? { ownerActiveElsewhere: true } : {}),
			resumeGuidance,
		},
	};
}

function terminalGuidance(status: string, workflowId: string, resumable: boolean): string {
	if (resumable)
		return `This retained workflow is ${status} and resumable. Resume it explicitly with /workflow resume ${workflowId}.`;
	return `This retained workflow is ${status} and available for read-only inspection.`;
}

async function hydrateWithoutClassification(
	backend: DurableWorkflowBackend,
	workflowId: string,
): Promise<import("./backend.js").DurableWorkflowHydrationResult> {
	await backend.hydrateWorkflow(workflowId);
	const handle = backend.getLoadableWorkflow(workflowId);
	return handle === undefined ? { kind: "absent" } : { kind: "current", handle };
}

function hydrationFailure(
	workflowId: string,
	kind: Exclude<TargetedDurableInspection["kind"], "found">,
): TargetedDurableInspection {
	switch (kind) {
		case "absent":
			return {
				kind,
				message: `Run not found: ${workflowId} (not present in the current session or durable store).`,
			};
		case "deleted":
			return { kind, message: `Durable workflow was deleted: ${workflowId}` };
		case "malformed":
			return malformed(workflowId, "current DBOS metadata or checkpoints are malformed");
	}
}

function malformed(workflowId: string, reason: string): TargetedDurableInspection {
	return {
		kind: "malformed",
		message: `Durable workflow ${workflowId} cannot be inspected safely: ${reason}.`,
	};
}
