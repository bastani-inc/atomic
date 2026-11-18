import type { StageSnapshot } from "./store-types.js";

/** A weak identity for the conversation shown by a stage, not just its reusable run and stage IDs. */
export interface StageRecordOwner {
	readonly identity: WeakRef<object>;
	readonly stageId: string;
	readonly sessionId?: string;
}

export function stageRecordOwner(stage: StageSnapshot): StageRecordOwner {
	// The worker republishes finished rows as new objects but keeps the lease object the stage ended under.
	return { identity: new WeakRef(stage.workerExecution ?? stage), stageId: stage.id, sessionId: stage.sessionId };
}

export function ownsStageRecord(owner: StageRecordOwner | undefined, candidate: StageSnapshot | undefined): boolean {
	if (!owner || !candidate) return owner === undefined && candidate === undefined;
	return (
		owner.stageId === candidate.id &&
		owner.identity.deref() === (candidate.workerExecution ?? candidate) &&
		(owner.sessionId === candidate.sessionId || (!candidate.workerExecution && owner.sessionId === undefined))
	);
}
