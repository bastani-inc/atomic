import type { DurableWorkflowBackend } from "../durable/backend.js";
import {
	isSettledPendingStageMessage,
	PENDING_STAGE_SETTLED_MESSAGE_LIMIT,
	retainPendingStageMessages,
} from "./pending-stage-retention.js";
import type { PendingStageMessage, PendingStageMessageDelivery, RunSnapshot } from "./store-types.js";

/**
 * Per-run bookkeeping that lets one pending-stage transition cost what it changes.
 *
 * A transition produces a new list that differs from the last persisted list in a few positions.
 * Entries the ledger already compacted and reconciled are skipped; only changed entries, plus the
 * entries delivered to a stage that has since ended, are compacted again. The outputs, archive calls
 * and their order are the same as compacting and reconciling every entry, because an unchanged
 * compacted entry produces no archive call and keeps its value until one of its delivered stages ends.
 */
export class PendingStageTransitionLedger {
	/** The last persisted list. Every entry is a compaction fixed point indexed under `stages`. */
	private compacted: readonly PendingStageMessage[] = [];
	/** Settled entries in `compacted`, so retention runs only when it can remove one. */
	private settled = 0;
	/** Entries of `compacted` by the run and stage of each delivery they still keep. */
	private readonly stages = new Map<string, Map<string, Set<PendingStageMessage>>>();
	/** Objects known to be compaction fixed points while they stay indexed. */
	private readonly fixed = new WeakSet<PendingStageMessage>();
	/** The last reconciled list and the backend count version it was reconciled at. */
	private reconciled: readonly PendingStageMessage[] = [];
	private reconciledVersion: number | undefined;

	/**
	 * Raise each sticky entry's delivery count to the durable count, exactly as reading every entry's
	 * count would. Entries of the last reconciled list are read again only when a count may have changed.
	 */
	reconcile(
		backend: DurableWorkflowBackend,
		runId: string,
		messages: readonly PendingStageMessage[],
	): readonly PendingStageMessage[] {
		if (backend.getPendingStageMessageDeliveryCount === undefined) return messages;
		const version = backend.pendingStageDeliveryCountVersion?.(runId);
		const base = version !== undefined && version === this.reconciledVersion ? this.reconciled : undefined;
		let recovered: PendingStageMessage[] | undefined;
		for (let index = 0; index < messages.length; index++) {
			const entry = messages[index]!;
			if (entry.sticky !== true || (base !== undefined && base[index] === entry)) continue;
			const count = backend.getPendingStageMessageDeliveryCount(runId, entry.id, entry.runId);
			if (count <= (entry.deliveryCount ?? entry.deliveries?.length ?? 0)) continue;
			recovered ??= [...messages];
			recovered[index] = { ...entry, deliveryCount: count };
		}
		const result = recovered ?? messages;
		this.reconciled = result;
		this.reconciledVersion = version;
		return result;
	}

	/**
	 * Compact delivery receipts and retain settled entries for one transition. Archives receipts of
	 * entries that settled, of stages that ended, and of sessions a later delivery replaced; then
	 * archives the oldest settled entries beyond the retention limit. Call `commit` once the result
	 * is persisted.
	 */
	async compact(
		backend: CompactingBackend,
		runId: string,
		messages: readonly PendingStageMessage[],
		runs: readonly RunSnapshot[],
		archiveSettled: ((entry: PendingStageMessage) => Promise<void>) | undefined,
	): Promise<CompactedTransition> {
		const stageStatus = createStageStatusLookup(runs);
		const endedStages: (readonly [string, string])[] = [];
		const dirty = new Set<PendingStageMessage>();
		for (const [deliveryRunId, byStage] of this.stages) {
			for (const [stageId, entries] of byStage) {
				if (!isEndedStageStatus(stageStatus(deliveryRunId, stageId))) continue;
				endedStages.push([deliveryRunId, stageId]);
				for (const entry of entries) dirty.add(entry);
			}
		}
		const base = this.compacted;
		const output: PendingStageMessage[] = [];
		const removed: PendingStageMessage[] = [];
		const added: PendingStageMessage[] = [];
		let settled = this.settled;
		const length = Math.max(base.length, messages.length);
		for (let index = 0; index < length; index++) {
			const previous = base[index];
			const entry = messages[index];
			if (previous === entry && !dirty.has(entry!)) {
				output.push(entry!);
				continue;
			}
			if (previous !== undefined) {
				removed.push(previous);
				if (isSettledPendingStageMessage(previous)) settled--;
			}
			if (entry === undefined) continue;
			if (isSettledPendingStageMessage(entry)) settled++;
			const next =
				this.fixed.has(entry) && !dirty.has(entry)
					? entry
					: await compactEntryDeliveries(backend, runId, entry, stageStatus);
			output.push(next);
			added.push(next);
		}
		let retained: readonly PendingStageMessage[] = output;
		if (archiveSettled !== undefined && settled > PENDING_STAGE_SETTLED_MESSAGE_LIMIT) {
			retained = await retainPendingStageMessages(output, archiveSettled);
			settled = PENDING_STAGE_SETTLED_MESSAGE_LIMIT;
		}
		return {
			messages: retained,
			commit: () => {
				for (const [deliveryRunId, stageId] of endedStages) {
					const byStage = this.stages.get(deliveryRunId);
					byStage?.delete(stageId);
					if (byStage?.size === 0) this.stages.delete(deliveryRunId);
				}
				for (const entry of dirty) this.fixed.delete(entry);
				for (const entry of removed) this.unindex(entry);
				for (const entry of added) this.index(entry);
				this.compacted = retained;
				this.settled = settled;
			},
		};
	}

	private index(entry: PendingStageMessage): void {
		this.fixed.add(entry);
		for (const delivery of entry.deliveries ?? []) {
			let byStage = this.stages.get(delivery.runId);
			if (byStage === undefined) {
				byStage = new Map();
				this.stages.set(delivery.runId, byStage);
			}
			let entries = byStage.get(delivery.stageId);
			if (entries === undefined) {
				entries = new Set();
				byStage.set(delivery.stageId, entries);
			}
			entries.add(entry);
		}
	}

	private unindex(entry: PendingStageMessage): void {
		this.fixed.delete(entry);
		for (const delivery of entry.deliveries ?? []) {
			const byStage = this.stages.get(delivery.runId);
			const entries = byStage?.get(delivery.stageId);
			if (entries === undefined) continue;
			entries.delete(entry);
			if (entries.size > 0) continue;
			byStage!.delete(delivery.stageId);
			if (byStage!.size === 0) this.stages.delete(delivery.runId);
		}
	}
}

export type CompactingBackend = DurableWorkflowBackend &
	Required<Pick<DurableWorkflowBackend, "archivePendingStageDeliveryReceipt" | "hasPendingStageDeliveryReceipt">>;

export interface CompactedTransition {
	readonly messages: readonly PendingStageMessage[];
	/** Record the result as the run's persisted list; call only after it is durable. */
	readonly commit: () => void;
}

/** Whether the backend archives delivery receipts, which enables receipt compaction. */
export function isCompactingBackend(backend: DurableWorkflowBackend): backend is CompactingBackend {
	return (
		backend.archivePendingStageDeliveryReceipt !== undefined && backend.hasPendingStageDeliveryReceipt !== undefined
	);
}

type StageStatusLookup = (runId: string, stageId: string) => string | undefined;

/** Stage status by run and stage id, with the first run and stage of each id winning as `find` would. */
function createStageStatusLookup(runs: readonly RunSnapshot[]): StageStatusLookup {
	let runById: Map<string, RunSnapshot> | undefined;
	return (runId, stageId) => {
		if (runById === undefined) {
			runById = new Map();
			for (const run of runs) if (!runById.has(run.id)) runById.set(run.id, run);
		}
		return runById.get(runId)?.stages.find((stage) => stage.id === stageId)?.status;
	};
}

function isEndedStageStatus(status: string | undefined): boolean {
	return status === "completed" || status === "skipped" || status === "failed";
}

/**
 * Archive and drop one entry's delivery receipts that no longer gate delivery. A receipt is archived
 * with every receipt before it, so the durable count always covers a prefix of the entry's deliveries.
 */
async function compactEntryDeliveries(
	backend: CompactingBackend,
	runId: string,
	entry: PendingStageMessage,
	stageStatus: StageStatusLookup,
): Promise<PendingStageMessage> {
	if (entry.sticky !== true || entry.deliveries === undefined) return entry;
	const latest = new Map<string, number>();
	entry.deliveries.forEach((delivery, index) => {
		latest.set(deliverySlot(delivery), index);
	});
	const deliveries: PendingStageMessageDelivery[] = [];
	let archivedThrough = -1;
	for (let index = 0; index < entry.deliveries.length; index++) {
		const delivery = entry.deliveries[index]!;
		if (
			entry.status !== "queued" ||
			isEndedStageStatus(stageStatus(delivery.runId, delivery.stageId)) ||
			(latest.get(deliverySlot(delivery)) !== index && delivery.sessionId !== undefined)
		) {
			while (archivedThrough < index) {
				const prefixIndex = archivedThrough + 1;
				await backend.archivePendingStageDeliveryReceipt(runId, entry.id, entry.deliveries[prefixIndex]!, {
					messageRunId: entry.runId,
					deliveryCount:
						(entry.deliveryCount ?? entry.deliveries.length) - entry.deliveries.length + prefixIndex + 1,
				});
				archivedThrough = prefixIndex;
			}
		} else {
			deliveries.push(delivery);
		}
	}
	return deliveries.length === entry.deliveries.length ? entry : { ...entry, deliveries };
}

/** One delivery slot per run, stage and admission; a later session's delivery replaces an earlier one. */
function deliverySlot(delivery: PendingStageMessageDelivery): string {
	return `${delivery.runId.length}:${delivery.runId}${delivery.stageId.length}:${delivery.stageId}${delivery.admission === undefined ? "-" : `+${delivery.admission}`}`;
}
