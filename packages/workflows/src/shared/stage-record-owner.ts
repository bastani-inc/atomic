import type { StageSnapshot } from "./store-types.js";

/** A weak identity for the conversation shown by a stage, not just its reusable run and stage IDs. */
export interface StageRecordOwner {
	readonly identity: WeakRef<object>;
	readonly stageId: string;
	readonly sessionId?: string;
}

const identityKey = Symbol.for("atomic-workflows/stage-record-identities@1");
const processState = globalThis as typeof globalThis & Record<symbol, WeakMap<StageSnapshot, object> | undefined>;
const identities = processState[identityKey] ?? new WeakMap<StageSnapshot, object>();
processState[identityKey] = identities;

export function stageRecordIdentity(stage: StageSnapshot): object {
	const known = identities.get(stage) ?? stage.workerExecution;
	if (known) return known;
	const identity = {};
	identities.set(stage, identity);
	return identity;
}

/** A verified refresh of the very same held chat keeps its owner without retaining its old snapshot. */
export function continueStageRecord(previous: StageSnapshot, refreshed: StageSnapshot): void {
	identities.set(refreshed, stageRecordIdentity(previous));
}

export function stageRecordOwner(stage: StageSnapshot): StageRecordOwner {
	// The worker republishes finished rows as new objects but keeps the lease object the stage ended under.
	return { identity: new WeakRef(stageRecordIdentity(stage)), stageId: stage.id, sessionId: stage.sessionId };
}

export function ownsStageRecord(owner: StageRecordOwner | undefined, candidate: StageSnapshot | undefined): boolean {
	if (!owner || !candidate) return owner === undefined && candidate === undefined;
	return (
		owner.stageId === candidate.id &&
		owner.identity.deref() === stageRecordIdentity(candidate) &&
		(owner.sessionId === candidate.sessionId || (!candidate.workerExecution && owner.sessionId === undefined))
	);
}
