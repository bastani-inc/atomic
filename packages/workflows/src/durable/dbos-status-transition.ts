import { dbosAdmissionContext } from "./dbos-admission.js";
import type { DbosMetadataClassification } from "./dbos-metadata.js";
import type { DurableWorkflowHandle, DurableWorkflowMetadata, DurableWorkflowStatus } from "./types.js";
import { isAbsorbingDurableStatus } from "./workflow-status-transition.js";

interface DbosStatusTransitionInput {
	readonly expectedStatuses: readonly DurableWorkflowStatus[];
	readonly status: DurableWorkflowStatus;
	readonly flush: () => Promise<void>;
	readonly read: () => Promise<DbosMetadataClassification>;
	readonly local: () => DurableWorkflowHandle | undefined;
	readonly reconcile: (metadata: DurableWorkflowMetadata) => void;
	/** Atomically claim this generation's transition against concurrent processes. */
	readonly claim?: (authoritative: DurableWorkflowMetadata, generation: number) => Promise<boolean>;
	readonly write: () => Promise<void>;
}

/**
 * Serialize local writes around authoritative generations and verify the
 * persisted result. DBOS metadata classification makes terminal generations
 * absorbing, so a stale nonterminal append cannot reopen a completed run.
 * The optional claim step makes the read→write window safe across processes:
 * every racer that observed the same generation competes for one durable
 * first-writer-wins record before it may write.
 */
export async function transitionDbosWorkflowStatus(input: DbosStatusTransitionInput): Promise<boolean> {
	const signal = dbosAdmissionContext.getStore();
	signal?.throwIfAborted();
	await input.flush();
	signal?.throwIfAborted();
	const authoritative = await input.read();
	signal?.throwIfAborted();
	const local = input.local();
	if (
		local === undefined ||
		authoritative.kind !== "current" ||
		!input.expectedStatuses.includes(authoritative.metadata.status)
	) {
		if (authoritative.kind === "current") input.reconcile(authoritative.metadata);
		return false;
	}

	const claimed = input.claim === undefined || (await input.claim(authoritative.metadata, authoritative.generation));
	signal?.throwIfAborted();
	if (!claimed) {
		const current = await input.read();
		signal?.throwIfAborted();
		if (current.kind === "current") input.reconcile(current.metadata);
		return false;
	}

	try {
		await input.write();
	} catch (error) {
		signal?.throwIfAborted();
		const persisted = await input.read();
		signal?.throwIfAborted();
		if (persisted.kind === "current" && persisted.metadata.status === input.status) {
			input.reconcile(persisted.metadata);
			return true;
		}
		if (
			persisted.kind === "current" &&
			isAbsorbingDurableStatus(persisted.metadata.status, persisted.metadata.resumable)
		) {
			input.reconcile(persisted.metadata);
			return false;
		}
		throw error;
	}
	signal?.throwIfAborted();
	const persisted = await input.read();
	signal?.throwIfAborted();
	if (persisted.kind !== "current" || persisted.metadata.status !== input.status) {
		if (persisted.kind === "current") input.reconcile(persisted.metadata);
		return false;
	}
	return true;
}
