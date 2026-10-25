/** Durable workflow contract and private journal projection. */
import { closeSync, openSync, readSync } from "node:fs";

import type { PendingStageMessage, PendingStageMessageDelivery } from "../shared/store-types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { PromptReservationToken } from "./prompt-reservation-state.js";
import { isDurableWorkflowResumable } from "./resume-eligibility.js";
import { durableStageGroupKey } from "./stage-topology-validation.js";
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
import { parseWorkflowChildResult } from "./workflow-child-result.js";

const SESSION_HEADER_READ_LIMIT_BYTES = 64 * 1024;

function readSessionHeaderId(sessionFile: string): string | undefined {
	let fd: number;
	try {
		fd = openSync(sessionFile, "r");
	} catch {
		return undefined;
	}
	try {
		const buffer = Buffer.alloc(SESSION_HEADER_READ_LIMIT_BYTES);
		const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
		const firstLine = buffer
			.subarray(0, bytesRead)
			.toString("utf8")
			.replace(/^\uFEFF/, "")
			.split("\n")[0];
		const header: { type?: string; id?: string } = JSON.parse(firstLine ?? "");
		return header.type === "session" && typeof header.id === "string" ? header.id : undefined;
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/**
 * Give a stage checkpoint recorded before #3700 the session ID it now resumes by.
 *
 * Before #3700 a stage checkpoint could identify its session only by transcript
 * path. The session ID is the header `id` of that transcript, which is also the
 * ID the session keeps after it is imported into the default session store. The
 * transcript file name is not used: its UUID can differ from the header ID.
 */
export function migrateStageSessionCheckpoint<T extends { readonly sessionId?: string; readonly sessionFile?: string }>(
	checkpoint: T,
): T {
	if (checkpoint.sessionId !== undefined || checkpoint.sessionFile === undefined) return checkpoint;
	const sessionId = readSessionHeaderId(checkpoint.sessionFile);
	return sessionId === undefined ? checkpoint : { ...checkpoint, sessionId };
}

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
	commitWorkflowRegistration(handle: WorkflowRegistrationInput): Promise<void>;
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
	/**
	 * A token that changes whenever any delivery count under `workflowId` may have changed. Equal tokens
	 * from the same backend promise every count read in between is unchanged, so callers can skip
	 * re-reading counts for entries they already reconciled. `undefined` means counts are not versioned.
	 */
	pendingStageDeliveryCountVersion?(workflowId: string): number | undefined;
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
	/** Persist a checkpoint before exposing its side effect. Duplicate identities retain the first write. */
	commitCheckpoint(checkpoint: DurableCheckpoint, options?: { readonly signal?: AbortSignal }): Promise<void>;

	/** Returns false only when additive metadata could not be stored. */
	commitAdditiveCheckpointBestEffort(checkpoint: DurableCheckpoint): Promise<boolean>;

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

	/**
	 * Version of a root's checkpoint list for nested run reconstruction, or
	 * `undefined` when this backend cannot provide one. It changes whenever a
	 * recorded checkpoint can change the nested runs rebuilt from the list; see
	 * `NestedSnapshotVersion` for the one class of record that leaves it alone.
	 */
	nestedSnapshotVersion?(workflowId: string): number | undefined;

	/** Get the top-level workflow handle, or `undefined` if not registered. */
	getWorkflow(workflowId: string): DurableWorkflowHandle | undefined;
	/**
	 * Return one authoritative loadable handle snapshot. Persistent backends use
	 * this narrow seam to refresh once and classify from that same generation.
	 */
	getLoadableWorkflow(workflowId: string): DurableWorkflowHandle | undefined;

	/** Update workflow status (running/paused/completed/failed/cancelled/blocked). */
	commitWorkflowStatus(
		workflowId: string,
		status: DurableWorkflowStatus,
		pendingPrompts?: number,
		resumable?: boolean,
		failure?: DurableWorkflowFailureMetadata,
	): Promise<void>;
	/**
	 * Atomically update status only when the authoritative status is expected.
	 * `modelOwner` adopts the run for a new session. `releasedModelOwner` durably records that
	 * the session owning the run was disposed; every transition without it clears that record.
	 */
	commitWorkflowStatusTransition(
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
	commitPendingPromptAdjustment(workflowId: string, delta: number): Promise<void>;

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
	commitReset(): Promise<void>;

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

// Nested snapshot version
// ---------------------------------------------------------------------------

/** Checkpoint id prefix of the metadata record replay writes after hydrating a cached root stage. */
export const STAGE_REPLAY_METADATA_CHECKPOINT_PREFIX = "stage-replay-meta:";

let lastVersion = 0;

/** Every tracker draws from one counter, so a recreated root never repeats a version. */
function nextVersion(): number {
	lastVersion += 1;
	return lastVersion;
}

interface ReplayGroupSummary {
	readonly name: string;
	readonly identity: string;
	consistent: boolean;
	hasOutput: boolean;
	hasExitedChildOutput: boolean;
}

/**
 * Version of one root's checkpoint list as nested run reconstruction sees it.
 *
 * Every recorded checkpoint bumps the version except one narrow, documented
 * class that cannot change the nested runs rebuilt from the list: replaying a
 * cached root stage writes one `stage-replay-meta:` record, so without this
 * exemption resuming N cached child boundaries would rebuild every nested run
 * N times. A record is exempt only when all of these hold:
 *
 * - It is a root-owned stage record with the replay-metadata id prefix and no
 *   output, boundary event, or prompt occurrence key.
 * - It sorts after every recorded checkpoint, so existing sequences do not move.
 * - Its replay key already holds stage records that all share its name and
 *   immutable identity (topology version, stage id, parents, source order,
 *   and therefore its root run), and include an output that is not an exited
 *   child.
 *   The record therefore joins an existing root stage group without changing
 *   identity validation, and can change only that root stage's timing and
 *   status. Nested runs read a root stage's timing only to synthesize an
 *   exited child or a pending child, and both are excluded.
 * - No boundary replay key scopes its checkpoint id, so it cannot become raw
 *   evidence against a zero-stage child.
 *
 * Anything else, including any record this rule cannot classify, bumps the
 * version.
 */
export class NestedSnapshotVersion {
	private current = nextVersion();
	private latestCompletedAt = Number.NEGATIVE_INFINITY;
	private readonly replayGroups = new Map<string, ReplayGroupSummary>();
	private readonly boundaryReplayKeys = new Set<string>();

	constructor(private readonly rootWorkflowId: string) {}

	get version(): number {
		return this.current;
	}

	/** Account for one newly recorded checkpoint, in record order. */
	record(checkpoint: DurableCheckpoint): void {
		if (!this.isInert(checkpoint)) this.current = nextVersion();
		this.latestCompletedAt = Math.max(this.latestCompletedAt, checkpoint.completedAt);
		if (checkpoint.kind !== "stage") return;
		if (checkpoint.topology?.boundary !== undefined) this.boundaryReplayKeys.add(checkpoint.replayKey);
		if (checkpoint.topology?.occurrenceKey !== undefined) return;
		const identity = stageIdentity(checkpoint);
		const exited = parseWorkflowChildResult(checkpoint.output)?.exited === true;
		const summary = this.replayGroups.get(checkpoint.replayKey);
		if (summary === undefined) {
			this.replayGroups.set(checkpoint.replayKey, {
				name: checkpoint.name,
				identity,
				consistent: true,
				hasOutput: checkpoint.output !== undefined,
				hasExitedChildOutput: exited,
			});
			return;
		}
		summary.consistent &&= summary.name === checkpoint.name && summary.identity === identity;
		summary.hasOutput ||= checkpoint.output !== undefined;
		summary.hasExitedChildOutput ||= exited;
	}

	private isInert(checkpoint: DurableCheckpoint): boolean {
		if (
			checkpoint.kind !== "stage" ||
			!checkpoint.checkpointId.startsWith(STAGE_REPLAY_METADATA_CHECKPOINT_PREFIX) ||
			checkpoint.output !== undefined ||
			checkpoint.topology === undefined ||
			checkpoint.topology.boundary !== undefined ||
			checkpoint.topology.occurrenceKey !== undefined ||
			!this.isRootOwned(checkpoint) ||
			checkpoint.completedAt < this.latestCompletedAt
		) {
			return false;
		}
		const summary = this.replayGroups.get(checkpoint.replayKey);
		if (
			summary === undefined ||
			!summary.consistent ||
			!summary.hasOutput ||
			summary.hasExitedChildOutput ||
			summary.name !== checkpoint.name ||
			summary.identity !== stageIdentity(checkpoint)
		) {
			return false;
		}
		const id = checkpoint.checkpointId;
		for (let colon = id.indexOf(":"); colon >= 0; colon = id.indexOf(":", colon + 1)) {
			if (this.boundaryReplayKeys.has(id.slice(0, colon))) return false;
		}
		return true;
	}

	private isRootOwned(checkpoint: DurableStageCheckpoint): boolean {
		const runId = checkpoint.topology?.run?.runId;
		return runId === undefined || runId === this.rootWorkflowId;
	}
}

/** Fields `immutableStageGroupError` requires every record in one group to share. */
function stageIdentity(checkpoint: DurableStageCheckpoint): string {
	const topology = checkpoint.topology;
	return JSON.stringify([
		durableStageGroupKey(checkpoint),
		topology?.version,
		topology?.stageId,
		topology?.parentIds,
		topology?.sourceOrder,
		topology?.run === undefined
			? undefined
			: [
					topology.run.runId,
					topology.run.runName,
					topology.run.parentRunId,
					topology.run.parentStageId,
					topology.run.rootRunId,
				],
	]);
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
	nestedSnapshotVersion: NestedSnapshotVersion;
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
			resources: handle.resources ?? existing?.handle.resources,
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
				nestedSnapshotVersion: new NestedSnapshotVersion(handle.workflowId),
			});
	}
	applyWorkflowSnapshot(handle: DurableWorkflowHandle): void {
		if (!this.workflows.has(handle.workflowId)) this.registerWorkflow(handle, true);
		const record = this.workflows.get(handle.workflowId)!;
		record.handle = {
			...handle,
			completedCheckpoints: Math.max(handle.completedCheckpoints, record.checkpoints.size),
		};
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

	private readonly stickyDeliveryCounts = new Map<string, Map<string, Map<string, number>>>();
	private readonly stickyDeliveryCountVersions = new Map<string, number>();

	getPendingStageMessageDeliveryCount(workflowId: string, messageId: string, logicalRunId = workflowId): number {
		return this.stickyDeliveryCounts.get(workflowId)?.get(logicalRunId)?.get(messageId) ?? 0;
	}

	pendingStageDeliveryCountVersion(workflowId: string): number {
		return this.stickyDeliveryCountVersions.get(workflowId) ?? 0;
	}

	private bumpDeliveryCountVersion(workflowId: string): void {
		this.stickyDeliveryCountVersions.set(workflowId, ++deliveryCountEpoch);
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
		const logicalRunId = accounting?.messageRunId;
		const receiptKey = pendingDeliveryReceiptKey(
			messageId,
			delivery.runId,
			delivery.stageId,
			delivery.sessionId,
			delivery.admission,
			logicalRunId,
		);
		const existing = receipts.has(receiptKey);
		receipts.add(receiptKey);
		receipts.add(
			pendingDeliveryReceiptKey(messageId, delivery.runId, delivery.stageId, undefined, undefined, logicalRunId),
		);
		if (delivery.admission === "context" && delivery.sessionId !== undefined)
			receipts.add(
				anySessionReceiptKey(
					pendingDeliveryReceiptKey(
						messageId,
						delivery.runId,
						delivery.stageId,
						undefined,
						"context",
						logicalRunId,
					),
				),
			);
		if (accounting !== undefined && !existing) {
			let byRun = this.stickyDeliveryCounts.get(workflowId);
			if (byRun === undefined) {
				byRun = new Map();
				this.stickyDeliveryCounts.set(workflowId, byRun);
			}
			let counts = byRun.get(accounting.messageRunId);
			if (counts === undefined) {
				counts = new Map();
				byRun.set(accounting.messageRunId, counts);
			}
			const previous = counts.get(messageId) ?? 0;
			counts.set(messageId, Math.max(previous, accounting.deliveryCount));
			if (accounting.deliveryCount > previous) this.bumpDeliveryCountVersion(workflowId);
		}
	}

	async hasPendingStageDeliveryReceipt(
		workflowId: string,
		messageId: string,
		delivery: Omit<PendingStageMessageDelivery, "deliveredAt">,
		logicalRunId = workflowId,
	): Promise<boolean> {
		const receipts = this.stickyReceipts.get(workflowId);
		if (receipts === undefined) return false;
		const { runId, stageId, sessionId, admission } = delivery;
		return (
			receipts.has(pendingDeliveryReceiptKey(messageId, runId, stageId, sessionId, admission, logicalRunId)) ||
			receipts.has(pendingDeliveryReceiptKey(messageId, runId, stageId, sessionId, admission, undefined))
		);
	}

	hasCachedPendingStageDeliveryReceipt(
		workflowId: string,
		messageId: string,
		delivery: Omit<PendingStageMessageDelivery, "deliveredAt">,
		anySession = false,
		logicalRunId = workflowId,
	): boolean {
		const receipts = this.stickyReceipts.get(workflowId);
		if (receipts === undefined) return false;
		const { runId, stageId, admission } = delivery;
		if (anySession && admission === "context")
			return (
				receipts.has(
					anySessionReceiptKey(
						pendingDeliveryReceiptKey(messageId, runId, stageId, undefined, admission, logicalRunId),
					),
				) ||
				receipts.has(
					anySessionReceiptKey(
						pendingDeliveryReceiptKey(messageId, runId, stageId, undefined, admission, undefined),
					),
				)
			);
		const { sessionId } = delivery;
		return (
			receipts.has(pendingDeliveryReceiptKey(messageId, runId, stageId, sessionId, admission, logicalRunId)) ||
			receipts.has(pendingDeliveryReceiptKey(messageId, runId, stageId, sessionId, admission, undefined))
		);
	}

	recordCheckpoint(recorded: DurableCheckpoint): void {
		const checkpoint = recorded.kind === "stage" ? migrateStageSessionCheckpoint(recorded) : recorded;
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
		rec.nestedSnapshotVersion.record(currentCheckpoint);
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

	nestedSnapshotVersion(workflowId: string): number | undefined {
		return this.workflows.get(workflowId)?.nestedSnapshotVersion.version;
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
			...(h.resources !== undefined ? { resources: h.resources } : {}),
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
		this.bumpDeliveryCountVersion(workflowId);
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
		for (const workflowId of this.stickyDeliveryCountVersions.keys()) this.bumpDeliveryCountVersion(workflowId);
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

/** Count-version tokens are unique across projections, so tokens from different backends never compare equal. */
let deliveryCountEpoch = 0;

/**
 * An injective receipt key built by concatenation: each part is length-prefixed and an absent part is `-`,
 * which no length prefix starts with. Counted receipts carry their logical run; uncounted ones do not.
 */
function pendingDeliveryReceiptKey(
	messageId: string,
	runId: string,
	stageId: string,
	sessionId: string | undefined,
	admission: string | undefined,
	logicalRunId: string | undefined,
): string {
	return `${logicalRunId === undefined ? "u" : `c${receiptKeyPart(logicalRunId)}`}${receiptKeyPart(messageId)}${receiptKeyPart(runId)}${receiptKeyPart(stageId)}${receiptKeyPart(sessionId)}${receiptKeyPart(admission)}`;
}

function receiptKeyPart(value: string | undefined): string {
	return value === undefined ? "-" : `${value.length}:${value}`;
}

/** A context admission receipt that matches any session of its stage. */
function anySessionReceiptKey(receiptKey: string): string {
	return `${receiptKey}*`;
}
