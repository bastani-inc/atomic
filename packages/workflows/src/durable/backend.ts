/** Durable workflow contract and private journal projection. */

import type { PendingStageMessage, PendingStageMessageDelivery } from "../shared/store-types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { PromptReservationToken } from "./prompt-reservation-state.js";
import { isDurableWorkflowResumable } from "./resume-eligibility.js";
import type {
	DurableCheckpoint,
	DurableStageCheckpoint,
	DurableToolCheckpoint,
	DurableUiCheckpoint,
	DurableWorkflowFailureMetadata,
	DurableWorkflowHandle,
	DurableWorkflowMetadata,
	DurableWorkflowStatus,
	ResumableWorkflowEntry,
} from "./types.js";
import { DURABLE_STAGE_TOPOLOGY_VERSION } from "./types.js";
export interface DurableWorkflowCatalogEntries {
	readonly inspectableIds?: readonly string[];
	readonly resumable: readonly ResumableWorkflowEntry[];
	readonly completed: readonly ResumableWorkflowEntry[];
	readonly completedAll?: readonly ResumableWorkflowEntry[];
}
export { durableHash } from "./durable-hash.js";
/** Replace one logical run's bucket without mutating root or sibling run messages. */
export function replacePendingStageMessagesForRun(
	existing: readonly PendingStageMessage[],
	logicalRunId: string,
	messages: readonly PendingStageMessage[],
): readonly PendingStageMessage[] {
	if (messages.some((entry) => entry.runId !== logicalRunId)) {
		throw new Error(`atomic-workflows: pending-stage persistence mixed logical run ${logicalRunId}`);
	}
	const firstOwnedIndex = existing.findIndex((entry) => entry.runId === logicalRunId);
	if (firstOwnedIndex < 0) return [...existing, ...messages];
	const merged: PendingStageMessage[] = [];
	for (let index = 0; index < existing.length; index += 1) {
		const entry = existing[index]!;
		if (index === firstOwnedIndex) merged.push(...messages);
		if (entry.runId !== logicalRunId) merged.push(entry);
	}
	return merged;
}
/** Read one logical run's bucket from its root durable metadata handle. */
export function pendingStageMessagesForDurableRun(
	backend: DurableWorkflowBackend,
	logicalRunId: string,
	rootWorkflowId = logicalRunId,
): readonly PendingStageMessage[] {
	return (backend.getWorkflow(rootWorkflowId)?.pendingStageMessages ?? []).filter(
		(entry) => entry.runId === logicalRunId,
	);
}

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

/**
 * Input for registering/updating a workflow in the durable backend.
 * Optional fields default to existing values or zero.
 */
export type WorkflowRegistrationInput = Omit<
	DurableWorkflowHandle,
	"completedCheckpoints" | "pendingPrompts" | "updatedAt"
> &
	Partial<Pick<DurableWorkflowHandle, "completedCheckpoints" | "pendingPrompts" | "updatedAt">>;

export type DurableInactiveDeleteResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: "not_found" | "running" };

/** Await mutations before observing their persisted result. */
export interface DurableWorkflowBackend {
	/** Whether state survives the current process. */
	readonly persistent: boolean;
	workflowOwnership(
		workflowId: string,
	): "local" | "foreign" | "available" | Promise<"local" | "foreign" | "available">;
	persistSummary?(workflowId: string, summary: string, summarizedThrough: number): Promise<boolean>;
	/** Register or update a workflow's top-level metadata. */
	registerWorkflow(handle: WorkflowRegistrationInput): void | Promise<void>;
	/** Persist one logical run's pending-stage transition under its durable owner. */
	persistPendingStageMessages(
		workflowId: string,
		messages: readonly PendingStageMessage[],
		logicalRunId?: string,
	): Promise<boolean>;
	archivePendingStageMessage?(workflowId: string, entry: PendingStageMessage): Promise<void>;
	readSettledPendingStageMessage?(
		workflowId: string,
		messageId: string,
		logicalRunId?: string,
	): Promise<PendingStageMessage | undefined>;

	getPendingStageMessageDeliveryCount?(workflowId: string, messageId: string, logicalRunId?: string): number;
	readPendingStageMessageDeliveryCount?(workflowId: string, messageId: string, logicalRunId?: string): Promise<number>;
	archivePendingStageDeliveryReceipt?(
		workflowId: string,
		messageId: string,
		delivery: PendingStageMessageDelivery,
		accounting?: { readonly messageRunId: string; readonly deliveryCount: number },
	): Promise<void>;
	hasCachedPendingStageDeliveryReceipt?(
		workflowId: string,
		messageId: string,
		delivery: Omit<PendingStageMessageDelivery, "deliveredAt">,
		anySession?: boolean,
		logicalRunId?: string,
	): boolean;
	hasPendingStageDeliveryReceipt?(
		workflowId: string,
		messageId: string,
		delivery: Omit<PendingStageMessageDelivery, "deliveredAt">,
		logicalRunId?: string,
	): Promise<boolean>;
	/** Record a completed checkpoint. Idempotent: same (kind, checkpointId) is a no-op. */
	recordCheckpoint(checkpoint: DurableCheckpoint): void | Promise<void>;

	/** Persist a checkpoint before exposing its side effect. */
	recordCheckpointAsync(checkpoint: DurableCheckpoint, options?: { readonly signal?: AbortSignal }): Promise<void>;

	/** Returns false only when additive metadata could not be stored. */
	recordAdditiveCheckpointBestEffort(checkpoint: DurableCheckpoint): Promise<boolean>;

	/**
	 * Look up a cached tool output by content hash. Returns `undefined` if the
	 * tool has not completed. This is how `ctx.tool` avoids re-executing side
	 * effects on resume.
	 */
	getToolOutput(workflowId: string, argsHash: string): WorkflowSerializableValue | undefined;
	/** Return the full cached tool checkpoint so graph topology can be replayed. */
	getToolCheckpoint(workflowId: string, argsHash: string): DurableToolCheckpoint | undefined;

	/**
	 * Look up a cached UI response by prompt hash. Returns `undefined` if the
	 * prompt has not been answered. This is how `ctx.ui.*` resumes at pending
	 * prompts instead of re-asking completed ones.
	 */
	getUiResponse(workflowId: string, promptHash: string): WorkflowSerializableValue | undefined;

	/** Look up a cached stage output by replay key. */
	getStageOutput(workflowId: string, replayKey: string): WorkflowSerializableValue | undefined;

	/** Look up the latest resumable stage session and accumulated active timing. */
	getStageSession(
		workflowId: string,
		replayKey: string,
	):
		| {
				sessionId?: string;
				sessionFile?: string;
				startedAt?: number;
				durationMs?: number;
				routerSelection?: import("@bastani/atomic").ModelRouterOutput;
		  }
		| undefined;

	/** List all checkpoints for a workflow (in completion order). */
	listCheckpoints(workflowId: string): readonly DurableCheckpoint[];

	/** Get the top-level workflow handle, or `undefined` if not registered. */
	getWorkflow(workflowId: string): DurableWorkflowHandle | undefined;
	/**
	 * Return one authoritative loadable handle snapshot. Persistent backends use
	 * this narrow seam to refresh once and classify from that same generation.
	 */
	getLoadableWorkflow(workflowId: string): DurableWorkflowHandle | undefined;

	/** Update workflow status (running/paused/completed/failed/cancelled/blocked). */
	setWorkflowStatus(
		workflowId: string,
		status: DurableWorkflowStatus,
		pendingPrompts?: number,
		resumable?: boolean,
		failure?: DurableWorkflowFailureMetadata,
	): void | Promise<void>;
	/**
	 * Atomically update status only when the authoritative status is expected.
	 * `modelOwner` adopts the run for a new session. `releasedModelOwner` durably records that
	 * the session owning the run was disposed; every transition without it clears that record.
	 */
	transitionWorkflowStatus(
		workflowId: string,
		expectedStatuses: readonly DurableWorkflowStatus[],
		status: DurableWorkflowStatus,
		pendingPrompts?: number,
		resumable?: boolean,
		expectedUpdatedAt?: number,
		modelOwner?: string,
		releasedModelOwner?: string,
	): Promise<boolean>;
	/** Atomically adjust unresolved UI prompt count, clamped at zero. */
	adjustPendingPrompts(workflowId: string, delta: number): void | Promise<void>;

	/**
	 * List resumable root workflows: running/paused runs with progress and
	 * failed/blocked runs unless explicitly marked non-resumable.
	 */
	listResumableWorkflows(): readonly ResumableWorkflowEntry[];
	/** List successful completed root workflows with durable checkpoint progress. */
	listCompletedWorkflows(): readonly ResumableWorkflowEntry[];
	/** Current resumable and completed catalog. */
	prepareWorkflowCatalog(): Promise<DurableWorkflowCatalogEntries>;

	/** Current run metadata. */
	toMetadata(workflowId: string): Omit<DurableWorkflowMetadata, "promptReservationEpoch"> | undefined;

	/** Permanently remove one root workflow and its durable checkpoints. */
	deleteWorkflow(workflowId: string): Promise<void>;
	/** Atomically delete only when authoritative state is not currently running. */
	deleteWorkflowIfInactive(workflowId: string): Promise<DurableInactiveDeleteResult>;

	/** Whether a workflow id may be exposed or resumed from live/restored metadata. */
	isWorkflowLoadable(workflowId: string): boolean;

	/** Clear all state (for tests). */
	reset(): void | Promise<void>;

	/** Hydrate one workflow from persistent storage. */
	hydrateWorkflow(workflowId: string): Promise<void>;
	/** Hydrate all catalog candidates from persistent storage. */
	hydrateResumableWorkflows(): Promise<void>;
	promptReservationScope(workflowId: string): { readonly rootWorkflowId: string; readonly scope: string };
	pendingPromptToken(
		workflowId: string,
		reservationId: string,
	): PromptReservationToken | undefined | Promise<PromptReservationToken | undefined>;
	reservePendingPrompt(
		workflowId: string,
		reservationId: string,
	): PromptReservationToken | Promise<PromptReservationToken>;
	releasePendingPrompt(workflowId: string, reservationId: string, token: PromptReservationToken): void | Promise<void>;
}

// Journal projection
// ---------------------------------------------------------------------------

interface JournalWorkflowRecord {
	handle: DurableWorkflowHandle;
	checkpoints: Map<string, DurableCheckpoint>;
	toolByHash: Map<string, DurableToolCheckpoint>;
	uiByHash: Map<string, DurableUiCheckpoint>;
	stageOutputByReplayKey: Map<string, DurableStageCheckpoint>;
	stageSessionByReplayKey: Map<string, DurableStageCheckpoint>;
}

function checkpointKey(c: DurableCheckpoint): string {
	return `${c.kind}:${c.checkpointId}`;
}

export function createJournalProjection() {
	return new JournalProjection();
}

class JournalProjection {
	private readonly workflows = new Map<string, JournalWorkflowRecord>();
	private readonly deletedWorkflowIds = new Set<string>();
	private readonly pendingReceipts = new Map<string, Map<string, PendingStageMessage>>();
	private readonly stickyReceipts = new Map<string, Set<string>>();

	registerWorkflow(handle: WorkflowRegistrationInput, authoritativeOwner = false): void {
		this.deletedWorkflowIds.delete(handle.workflowId);
		const existing = this.workflows.get(handle.workflowId);
		const completedCheckpoints = handle.completedCheckpoints ?? existing?.handle.completedCheckpoints ?? 0;
		const pendingPrompts = handle.pendingPrompts ?? existing?.handle.pendingPrompts ?? 0;
		const updatedAt = handle.updatedAt ?? Date.now();
		const full: DurableWorkflowHandle = {
			workflowId: handle.workflowId,
			name: handle.name,
			inputs: handle.inputs,
			createdAt: handle.createdAt,
			status: handle.status,
			transitionClaimId: handle.transitionClaimId ?? existing?.handle.transitionClaimId,
			...(handle.invocationCwd !== undefined
				? { invocationCwd: handle.invocationCwd }
				: existing?.handle.invocationCwd !== undefined
					? { invocationCwd: existing.handle.invocationCwd }
					: {}),
			...(handle.origin !== undefined
				? { origin: handle.origin }
				: existing?.handle.origin !== undefined
					? { origin: existing.handle.origin }
					: {}),
			modelOwner: authoritativeOwner ? handle.modelOwner : (existing?.handle.modelOwner ?? handle.modelOwner),
			...(handle.releasedModelOwner !== undefined ? { releasedModelOwner: handle.releasedModelOwner } : {}),
			...(handle.workflowCwd !== undefined
				? { workflowCwd: handle.workflowCwd }
				: existing?.handle.workflowCwd !== undefined
					? { workflowCwd: existing.handle.workflowCwd }
					: {}),
			...(handle.repositoryRoot !== undefined
				? { repositoryRoot: handle.repositoryRoot }
				: existing?.handle.repositoryRoot !== undefined
					? { repositoryRoot: existing.handle.repositoryRoot }
					: {}),
			...(handle.gitWorktreeRoot !== undefined
				? { gitWorktreeRoot: handle.gitWorktreeRoot }
				: existing?.handle.gitWorktreeRoot !== undefined
					? { gitWorktreeRoot: existing.handle.gitWorktreeRoot }
					: {}),
			pendingStageMessages: handle.pendingStageMessages ?? existing?.handle.pendingStageMessages ?? [],
			...(handle.possibleStages !== undefined
				? { possibleStages: handle.possibleStages }
				: existing?.handle.possibleStages !== undefined
					? { possibleStages: existing.handle.possibleStages }
					: {}),
			...(handle.sessionFile !== undefined ? { sessionFile: handle.sessionFile } : {}),
			completedCheckpoints,
			pendingPrompts,
			updatedAt,
			...((handle.label ?? existing?.handle.label) !== undefined
				? { label: handle.label ?? existing?.handle.label }
				: {}),
			...((handle.summary ?? existing?.handle.summary) !== undefined
				? {
						summary: handle.summary ?? existing?.handle.summary,
						summarizedThrough: handle.summarizedThrough ?? existing?.handle.summarizedThrough,
					}
				: {}),
			...(handle.rootWorkflowId !== undefined ? { rootWorkflowId: handle.rootWorkflowId } : {}),
			...(handle.resumable !== undefined ? { resumable: handle.resumable } : {}),
			...workflowFailureFields(
				hasWorkflowFailureMetadata(handle) ? handle : handle.status === "running" ? undefined : existing?.handle,
			),
			...(handle.ownerExecutorId !== undefined
				? { ownerExecutorId: handle.ownerExecutorId }
				: existing?.handle.ownerExecutorId !== undefined
					? { ownerExecutorId: existing.handle.ownerExecutorId }
					: {}),
			...(handle.ownerLiveness !== undefined ? { ownerLiveness: handle.ownerLiveness } : {}),
		};
		if (existing) existing.handle = full;
		else
			this.workflows.set(handle.workflowId, {
				handle: full,
				checkpoints: new Map(),
				toolByHash: new Map(),
				uiByHash: new Map(),
				stageOutputByReplayKey: new Map(),
				stageSessionByReplayKey: new Map(),
			});
	}
	applyWorkflowSnapshot(handle: DurableWorkflowHandle): void {
		if (!this.workflows.has(handle.workflowId)) this.registerWorkflow(handle, true);
		this.workflows.get(handle.workflowId)!.handle = handle;
	}

	async archivePendingStageMessage(workflowId: string, entry: PendingStageMessage): Promise<void> {
		let receipts = this.pendingReceipts.get(workflowId);
		if (receipts === undefined) {
			receipts = new Map();
			this.pendingReceipts.set(workflowId, receipts);
		}
		const key = JSON.stringify([entry.runId, entry.id]);
		if (!receipts.has(key)) receipts.set(key, entry);
	}

	async readSettledPendingStageMessage(
		workflowId: string,
		messageId: string,
		logicalRunId = workflowId,
	): Promise<PendingStageMessage | undefined> {
		return this.pendingReceipts.get(workflowId)?.get(JSON.stringify([logicalRunId, messageId]));
	}

	private readonly stickyDeliveryCounts = new Map<string, Map<string, number>>();

	getPendingStageMessageDeliveryCount(workflowId: string, messageId: string, logicalRunId = workflowId): number {
		return this.stickyDeliveryCounts.get(workflowId)?.get(JSON.stringify([logicalRunId, messageId])) ?? 0;
	}

	async archivePendingStageDeliveryReceipt(
		workflowId: string,
		messageId: string,
		delivery: PendingStageMessageDelivery,
		accounting?: { readonly messageRunId: string; readonly deliveryCount: number },
	): Promise<void> {
		let receipts = this.stickyReceipts.get(workflowId);
		if (receipts === undefined) {
			receipts = new Set();
			this.stickyReceipts.set(workflowId, receipts);
		}
		const receiptKey = pendingDeliveryReceiptKey(messageId, delivery, accounting?.messageRunId);
		const existing = receipts.has(receiptKey);
		receipts.add(receiptKey);
		receipts.add(
			pendingDeliveryReceiptKey(
				messageId,
				{ ...delivery, sessionId: undefined, admission: undefined },
				accounting?.messageRunId,
			),
		);
		if (delivery.admission === "context" && delivery.sessionId !== undefined)
			receipts.add(
				`${pendingDeliveryReceiptKey(messageId, { ...delivery, sessionId: undefined }, accounting?.messageRunId)}:context-any-session`,
			);
		if (accounting !== undefined && !existing) {
			let counts = this.stickyDeliveryCounts.get(workflowId);
			if (counts === undefined) {
				counts = new Map();
				this.stickyDeliveryCounts.set(workflowId, counts);
			}
			const key = JSON.stringify([accounting.messageRunId, messageId]);
			counts.set(key, Math.max(counts.get(key) ?? 0, accounting.deliveryCount));
		}
	}

	async hasPendingStageDeliveryReceipt(
		workflowId: string,
		messageId: string,
		delivery: Omit<PendingStageMessageDelivery, "deliveredAt">,
		logicalRunId = workflowId,
	): Promise<boolean> {
		return [logicalRunId, undefined].some(
			(logicalId) =>
				this.stickyReceipts.get(workflowId)?.has(pendingDeliveryReceiptKey(messageId, delivery, logicalId)) ??
				false,
		);
	}

	hasCachedPendingStageDeliveryReceipt(
		workflowId: string,
		messageId: string,
		delivery: Omit<PendingStageMessageDelivery, "deliveredAt">,
		anySession = false,
		logicalRunId = workflowId,
	): boolean {
		return [logicalRunId, undefined].some((logicalId) => {
			const name =
				anySession && delivery.admission === "context"
					? `${pendingDeliveryReceiptKey(messageId, { ...delivery, sessionId: undefined }, logicalId)}:context-any-session`
					: pendingDeliveryReceiptKey(messageId, delivery, logicalId);
			return this.stickyReceipts.get(workflowId)?.has(name) ?? false;
		});
	}

	recordCheckpoint(checkpoint: DurableCheckpoint): void {
		const currentCheckpoint =
			checkpoint.kind === "stage" && checkpoint.topology === undefined
				? {
						...checkpoint,
						topology: {
							version: DURABLE_STAGE_TOPOLOGY_VERSION,
							stageId: checkpoint.checkpointId,
							parentIds: [],
						},
					}
				: checkpoint;
		const rec = this.workflows.get(currentCheckpoint.workflowId);
		if (!rec) return;
		const key = checkpointKey(currentCheckpoint);
		if (rec.checkpoints.has(key)) return;
		rec.checkpoints.set(key, currentCheckpoint);
		if (currentCheckpoint.kind === "tool") {
			const existing = rec.toolByHash.get(currentCheckpoint.argsHash);
			if (
				currentCheckpoint.throwingFailureError === undefined &&
				(existing === undefined || currentCheckpoint.completedAt >= existing.completedAt)
			) {
				rec.toolByHash.set(currentCheckpoint.argsHash, currentCheckpoint);
			}
		} else if (currentCheckpoint.kind === "ui") {
			rec.uiByHash.set(currentCheckpoint.promptHash, currentCheckpoint);
		} else {
			if ("output" in currentCheckpoint)
				rec.stageOutputByReplayKey.set(currentCheckpoint.replayKey, currentCheckpoint);
			if (currentCheckpoint.sessionId !== undefined) {
				const existing = rec.stageSessionByReplayKey.get(currentCheckpoint.replayKey);
				if (existing === undefined || currentCheckpoint.completedAt >= existing.completedAt) {
					rec.stageSessionByReplayKey.set(currentCheckpoint.replayKey, currentCheckpoint);
				}
			}
		}
		rec.handle = {
			...rec.handle,
			completedCheckpoints: rec.checkpoints.size,
			updatedAt: currentCheckpoint.completedAt,
		};
	}

	getToolOutput(workflowId: string, argsHash: string): WorkflowSerializableValue | undefined {
		return this.workflows.get(workflowId)?.toolByHash.get(argsHash)?.output;
	}

	getToolCheckpoint(workflowId: string, argsHash: string): DurableToolCheckpoint | undefined {
		return this.workflows.get(workflowId)?.toolByHash.get(argsHash);
	}

	getUiResponse(workflowId: string, promptHash: string): WorkflowSerializableValue | undefined {
		return this.workflows.get(workflowId)?.uiByHash.get(promptHash)?.response;
	}

	getStageOutput(workflowId: string, replayKey: string): WorkflowSerializableValue | undefined {
		const checkpoint = this.workflows.get(workflowId)?.stageOutputByReplayKey.get(replayKey);
		return checkpoint !== undefined && "output" in checkpoint ? checkpoint.output : undefined;
	}

	getStageSession(
		workflowId: string,
		replayKey: string,
	):
		| {
				sessionId?: string;
				sessionFile?: string;
				startedAt?: number;
				durationMs?: number;
				routerSelection?: import("@bastani/atomic").ModelRouterOutput;
		  }
		| undefined {
		const checkpoint = this.workflows.get(workflowId)?.stageSessionByReplayKey.get(replayKey);
		if (checkpoint?.sessionId === undefined) return undefined;
		return {
			...(checkpoint.sessionId !== undefined ? { sessionId: checkpoint.sessionId } : {}),
			...(checkpoint.sessionFile !== undefined ? { sessionFile: checkpoint.sessionFile } : {}),
			...(checkpoint.startedAt !== undefined ? { startedAt: checkpoint.startedAt } : {}),
			...(checkpoint.durationMs !== undefined ? { durationMs: checkpoint.durationMs } : {}),
			...(checkpoint.routerSelection !== undefined ? { routerSelection: checkpoint.routerSelection } : {}),
		};
	}

	listCheckpoints(workflowId: string): readonly DurableCheckpoint[] {
		const rec = this.workflows.get(workflowId);
		if (!rec) return [];
		return [...rec.checkpoints.values()].sort((a, b) => a.completedAt - b.completedAt);
	}

	getWorkflow(workflowId: string): DurableWorkflowHandle | undefined {
		return this.workflows.get(workflowId)?.handle;
	}
	getLoadableWorkflow(workflowId: string): DurableWorkflowHandle | undefined {
		return this.getWorkflow(workflowId);
	}

	async prepareWorkflowCatalog(): Promise<DurableWorkflowCatalogEntries> {
		return {
			resumable: this.listResumableWorkflows(),
			completed: this.listCompletedWorkflows(),
			inspectableIds: [...this.workflows.values()]
				.filter((rec) => isRootWorkflow(rec.handle))
				.map((rec) => rec.handle.workflowId),
		};
	}

	setWorkflowStatus(
		workflowId: string,
		status: DurableWorkflowStatus,
		pendingPrompts?: number,
		resumable?: boolean,
		failure?: DurableWorkflowFailureMetadata,
	): void {
		const rec = this.workflows.get(workflowId);
		if (!rec) return;
		rec.handle = {
			...rec.handle,
			error: undefined,
			exited: undefined,
			exitReason: undefined,
			failureKind: undefined,
			failureCode: undefined,
			failureRecoverability: undefined,
			failureDisposition: undefined,
			failedToolNodeId: undefined,
			status,
			transitionClaimId: status === rec.handle.status ? rec.handle.transitionClaimId : crypto.randomUUID(),
			updatedAt: Math.max(Date.now(), rec.handle.updatedAt + 1),
			...(pendingPrompts !== undefined ? { pendingPrompts } : {}),
			...(resumable !== undefined ? { resumable } : {}),
			...(status === "failed" ? (failure ?? {}) : {}),
		};
	}

	listResumableWorkflows(): readonly ResumableWorkflowEntry[] {
		return [...this.workflows.values()]
			.filter((rec) => isDurableWorkflowResumable(rec.handle))
			.map((rec) => toResumableEntry(rec.handle));
	}

	listCompletedWorkflows(): readonly ResumableWorkflowEntry[] {
		return [...this.workflows.values()]
			.filter((rec) => isRootWorkflow(rec.handle) && isHistoricalHandle(rec.handle))
			.map((rec) => toResumableEntry(rec.handle));
	}

	/** Current run metadata. */
	toMetadata(workflowId: string): Omit<DurableWorkflowMetadata, "promptReservationEpoch"> | undefined {
		const rec = this.workflows.get(workflowId);
		if (!rec) return undefined;
		const h = rec.handle;
		return {
			workflowId: h.workflowId,
			name: h.name,
			inputs: h.inputs,
			status: h.status,
			...(h.transitionClaimId !== undefined ? { transitionClaimId: h.transitionClaimId } : {}),
			createdAt: h.createdAt,
			completedCheckpoints: h.completedCheckpoints,
			pendingPrompts: h.pendingPrompts,
			pendingStageMessages: h.pendingStageMessages ?? [],
			...(h.possibleStages !== undefined ? { possibleStages: h.possibleStages } : {}),
			...(h.ownerExecutorId !== undefined ? { ownerExecutorId: h.ownerExecutorId } : {}),
			...(h.sessionFile !== undefined ? { sessionFile: h.sessionFile } : {}),
			...(h.label !== undefined ? { label: h.label } : {}),
			...(h.summary !== undefined ? { summary: h.summary, summarizedThrough: h.summarizedThrough } : {}),
			...(h.rootWorkflowId !== undefined ? { rootWorkflowId: h.rootWorkflowId } : {}),
			...(h.resumable !== undefined ? { resumable: h.resumable } : {}),
			...workflowFailureFields(h),
			...(h.invocationCwd !== undefined ? { invocationCwd: h.invocationCwd } : {}),
			...(h.origin !== undefined ? { origin: h.origin } : {}),
			modelOwner: h.modelOwner,
			...(h.releasedModelOwner !== undefined ? { releasedModelOwner: h.releasedModelOwner } : {}),
			...(h.workflowCwd !== undefined ? { workflowCwd: h.workflowCwd } : {}),
			...(h.repositoryRoot !== undefined ? { repositoryRoot: h.repositoryRoot } : {}),
			...(h.gitWorktreeRoot !== undefined ? { gitWorktreeRoot: h.gitWorktreeRoot } : {}),
			updatedAt: h.updatedAt,
		};
	}

	async deleteWorkflow(workflowId: string): Promise<void> {
		this.workflows.delete(workflowId);
		this.pendingReceipts.delete(workflowId);
		this.stickyReceipts.delete(workflowId);
		this.stickyDeliveryCounts.delete(workflowId);
		this.deletedWorkflowIds.add(workflowId);
	}

	isWorkflowLoadable(workflowId: string): boolean {
		return !this.deletedWorkflowIds.has(workflowId);
	}

	reset(): void {
		this.workflows.clear();
		this.pendingReceipts.clear();
		this.stickyReceipts.clear();
		this.stickyDeliveryCounts.clear();
		this.deletedWorkflowIds.clear();
	}
}

function isRootWorkflow(handle: DurableWorkflowHandle): boolean {
	return handle.rootWorkflowId === undefined || handle.rootWorkflowId === handle.workflowId;
}

function hasResumeProgress(handle: DurableWorkflowHandle): boolean {
	return handle.completedCheckpoints > 0 || handle.pendingPrompts > 0;
}

function isHistoricalHandle(handle: DurableWorkflowHandle): boolean {
	return (
		(handle.status === "completed" && hasResumeProgress(handle)) ||
		(handle.status === "failed" && !isDurableWorkflowResumable(handle) && hasResumeProgress(handle))
	);
}

function hasWorkflowFailureMetadata(handle: Partial<DurableWorkflowHandle>): boolean {
	return (
		handle.error !== undefined ||
		handle.exited !== undefined ||
		handle.exitReason !== undefined ||
		handle.failureKind !== undefined ||
		handle.failureCode !== undefined ||
		handle.failureRecoverability !== undefined ||
		handle.failureDisposition !== undefined ||
		handle.failedToolNodeId !== undefined
	);
}

function workflowFailureFields(
	handle: Partial<DurableWorkflowHandle> | undefined,
): Partial<DurableWorkflowFailureMetadata> {
	if (handle === undefined) return {};
	return {
		...(handle.error !== undefined ? { error: handle.error } : {}),
		...(handle.exited !== undefined ? { exited: handle.exited } : {}),
		...(handle.exitReason !== undefined ? { exitReason: handle.exitReason } : {}),
		...(handle.failureKind !== undefined ? { failureKind: handle.failureKind } : {}),
		...(handle.failureCode !== undefined ? { failureCode: handle.failureCode } : {}),
		...(handle.failureRecoverability !== undefined ? { failureRecoverability: handle.failureRecoverability } : {}),
		...(handle.failureDisposition !== undefined ? { failureDisposition: handle.failureDisposition } : {}),
		...(handle.failedToolNodeId !== undefined ? { failedToolNodeId: handle.failedToolNodeId } : {}),
	};
}

/** Convert a durable workflow handle into a resume-catalog entry. */
export function resumableEntryFromHandle(handle: DurableWorkflowHandle): ResumableWorkflowEntry {
	return toResumableEntry(handle);
}

function toResumableEntry(handle: DurableWorkflowHandle): ResumableWorkflowEntry {
	return {
		workflowId: handle.workflowId,
		name: handle.name,
		inputs: handle.inputs,
		status: handle.status,
		completedCheckpoints: handle.completedCheckpoints,
		pendingPrompts: handle.pendingPrompts,
		...(handle.sessionFile !== undefined ? { sessionFile: handle.sessionFile } : {}),
		...(handle.label !== undefined ? { label: handle.label } : {}),
		...(handle.summary !== undefined ? { summary: handle.summary, summarizedThrough: handle.summarizedThrough } : {}),
		...(handle.rootWorkflowId !== undefined ? { rootWorkflowId: handle.rootWorkflowId } : {}),
		...(handle.resumable !== undefined ? { resumable: handle.resumable } : {}),
		...workflowFailureFields(handle),
		...(handle.invocationCwd !== undefined ? { invocationCwd: handle.invocationCwd } : {}),
		...(handle.origin !== undefined ? { origin: handle.origin } : {}),
		modelOwner: handle.modelOwner,
		...(handle.workflowCwd !== undefined ? { workflowCwd: handle.workflowCwd } : {}),
		...(handle.repositoryRoot !== undefined ? { repositoryRoot: handle.repositoryRoot } : {}),
		...(handle.gitWorktreeRoot !== undefined ? { gitWorktreeRoot: handle.gitWorktreeRoot } : {}),
		createdAt: handle.createdAt,
		updatedAt: handle.updatedAt,
	};
}

function pendingDeliveryReceiptKey(
	messageId: string,
	delivery: Omit<PendingStageMessageDelivery, "deliveredAt">,
	logicalRunId?: string,
): string {
	const identity = [messageId, delivery.runId, delivery.stageId, delivery.sessionId, delivery.admission];
	return JSON.stringify(logicalRunId === undefined ? identity : ["counted", logicalRunId, ...identity]);
}
