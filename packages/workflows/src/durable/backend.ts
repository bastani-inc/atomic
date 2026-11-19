/** Durable workflow contract and private journal projection. */

import { type FileHandle, open } from "node:fs/promises";
import type { JournalShardUnavailableError, RunJournal } from "@bastani/atomic/storage";
import type { PendingStageMessage, PendingStageMessageDelivery } from "../shared/store-types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import { completedRunAttempt, stampCheckpointAttempt, workflowAttemptOf } from "./attempt-identity.js";
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

async function readSessionHeaderId(sessionFile: string): Promise<string | undefined> {
	let handle: FileHandle;
	try {
		handle = await open(sessionFile, "r");
	} catch {
		return undefined;
	}
	try {
		const buffer = Buffer.alloc(SESSION_HEADER_READ_LIMIT_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
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
		await handle.close();
	}
}

/**
 * Give a stage checkpoint recorded before #3700 the session ID it now resumes by.
 *
 * Before #3700 a stage checkpoint could identify its session only by transcript
 * path. The session ID is the header `id` of that transcript, which is also the
 * ID the session keeps after it is imported into the default session store. The
 * transcript file name is not used: its UUID can differ from the header ID. A journal backend migrates each checkpoint
 * it reads before folding it.
 */
export async function migrateStageSessionCheckpoint<
	T extends { readonly sessionId?: string; readonly sessionFile?: string },
>(checkpoint: T): Promise<T> {
	if (checkpoint.sessionId !== undefined || checkpoint.sessionFile === undefined) return checkpoint;
	const sessionId = await readSessionHeaderId(checkpoint.sessionFile);
	return sessionId === undefined ? checkpoint : { ...checkpoint, sessionId };
}

export interface DurableWorkflowCatalogEntries {
	readonly inspectableIds?: readonly string[];
	readonly resumable: readonly ResumableWorkflowEntry[];
	readonly completed: readonly ResumableWorkflowEntry[];
	readonly completedAll?: readonly ResumableWorkflowEntry[];
	/** Shard files of the journal store that could not be opened, so their runs are missing from this listing. */
	readonly unavailableShards?: readonly JournalShardUnavailableError[];
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

/**
 * What `backend.listCheckpoints(workflowId)` lists plus the checkpoints under one child boundary scope (every
 * checkpoint when `scope` is undefined), including any the backend leaves in storage (`readCheckpoints`).
 */
export async function readDurableCheckpoints(
	backend: DurableWorkflowBackend,
	workflowId: string,
	scope?: string,
): Promise<readonly DurableCheckpoint[]> {
	return backend.readCheckpoints === undefined
		? backend.listCheckpoints(workflowId)
		: await backend.readCheckpoints(workflowId, scope);
}

/** A position in one workflow's receipt change log; a reset workflow starts a new log. */
export interface PendingStageReceiptCursor {
	readonly log: object;
	readonly length: number;
}

/** Messages whose delivery receipts changed since a cursor; `undefined` when any message may have changed. */
export interface PendingStageReceiptChanges {
	readonly cursor: PendingStageReceiptCursor;
	readonly messageIds: readonly string[] | undefined;
}

type Admissions = Set<string | undefined>;

/**
 * One stage's receipts for one message. A receipt is keyed by its logical run (`undefined` for receipts
 * recorded without accounting), its session and its admission, each possibly absent. A context admission
 * with a session also records a receipt that matches any session of the stage.
 */
class StageReceipts {
	private readonly exact = new Map<string | undefined, Map<string | undefined, Admissions>>();
	private readonly anySession = new Map<string | undefined, Admissions>();

	has(logicalRunId: string | undefined, sessionId: string | undefined, admission: string | undefined): boolean {
		return this.exact.get(logicalRunId)?.get(sessionId)?.has(admission) ?? false;
	}

	hasAnySession(logicalRunId: string | undefined, admission: string | undefined): boolean {
		return this.anySession.get(logicalRunId)?.has(admission) ?? false;
	}

	/** Add a receipt; returns whether it was new. */
	add(logicalRunId: string | undefined, sessionId: string | undefined, admission: string | undefined): boolean {
		let bySession = this.exact.get(logicalRunId);
		if (bySession === undefined) {
			bySession = new Map();
			this.exact.set(logicalRunId, bySession);
		}
		let admissions = bySession.get(sessionId);
		if (admissions === undefined) {
			admissions = new Set();
			bySession.set(sessionId, admissions);
		}
		if (admissions.has(admission)) return false;
		admissions.add(admission);
		return true;
	}

	addAnySession(logicalRunId: string | undefined, admission: string | undefined): boolean {
		let admissions = this.anySession.get(logicalRunId);
		if (admissions === undefined) {
			admissions = new Set();
			this.anySession.set(logicalRunId, admissions);
		}
		if (admissions.has(admission)) return false;
		admissions.add(admission);
		return true;
	}
}

interface WorkflowReceipts {
	/** message → delivery run → stage → receipts */
	readonly byMessage: Map<string, Map<string, Map<string, StageReceipts>>>;
	/** Message ids in the order their receipts changed. */
	readonly log: string[];
}

/** Archived sticky delivery receipts per durable workflow, looked up through nested maps without key building. */
class PendingStageReceiptIndex {
	private readonly workflows = new Map<string, WorkflowReceipts>();

	/**
	 * Record one archived delivery. Returns whether the exact receipt was new, which decides whether its
	 * accounting may raise the delivery count.
	 */
	add(workflowId: string, messageId: string, delivery: PendingStageMessageDelivery, logicalRunId?: string): boolean {
		let workflow = this.workflows.get(workflowId);
		if (workflow === undefined) {
			workflow = { byMessage: new Map(), log: [] };
			this.workflows.set(workflowId, workflow);
		}
		let byRun = workflow.byMessage.get(messageId);
		if (byRun === undefined) {
			byRun = new Map();
			workflow.byMessage.set(messageId, byRun);
		}
		let byStage = byRun.get(delivery.runId);
		if (byStage === undefined) {
			byStage = new Map();
			byRun.set(delivery.runId, byStage);
		}
		let receipts = byStage.get(delivery.stageId);
		if (receipts === undefined) {
			receipts = new StageReceipts();
			byStage.set(delivery.stageId, receipts);
		}
		const added = receipts.add(logicalRunId, delivery.sessionId, delivery.admission);
		let changed = added;
		if (receipts.add(logicalRunId, undefined, undefined)) changed = true;
		if (
			delivery.admission === "context" &&
			delivery.sessionId !== undefined &&
			receipts.addAnySession(logicalRunId, "context")
		)
			changed = true;
		if (changed) workflow.log.push(messageId);
		return added;
	}

	/** Whether a receipt exists for the delivery, counted under `logicalRunId` or recorded without accounting. */
	has(
		workflowId: string,
		messageId: string,
		delivery: Omit<PendingStageMessageDelivery, "deliveredAt">,
		logicalRunId: string,
		anySession = false,
	): boolean {
		const receipts = this.workflows
			.get(workflowId)
			?.byMessage.get(messageId)
			?.get(delivery.runId)
			?.get(delivery.stageId);
		if (receipts === undefined) return false;
		if (anySession && delivery.admission === "context")
			return (
				receipts.hasAnySession(logicalRunId, delivery.admission) ||
				receipts.hasAnySession(undefined, delivery.admission)
			);
		return (
			receipts.has(logicalRunId, delivery.sessionId, delivery.admission) ||
			receipts.has(undefined, delivery.sessionId, delivery.admission)
		);
	}

	changesSince(workflowId: string, cursor: PendingStageReceiptCursor | undefined): PendingStageReceiptChanges {
		let workflow = this.workflows.get(workflowId);
		if (workflow === undefined) {
			workflow = { byMessage: new Map(), log: [] };
			this.workflows.set(workflowId, workflow);
		}
		const next = { log: workflow.log, length: workflow.log.length };
		if (cursor === undefined || cursor.log !== workflow.log || cursor.length > workflow.log.length)
			return { cursor: next, messageIds: undefined };
		return { cursor: next, messageIds: workflow.log.slice(cursor.length) };
	}

	delete(workflowId: string): void {
		this.workflows.delete(workflowId);
	}

	/** Takes `staged`'s receipts of `workflowId` in place of this index's. */
	adopt(workflowId: string, staged: PendingStageReceiptIndex): void {
		const workflow = staged.workflows.get(workflowId);
		if (workflow === undefined) this.workflows.delete(workflowId);
		else this.workflows.set(workflowId, workflow);
	}

	clear(): void {
		this.workflows.clear();
	}
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

/** How long a caller of a catalog read waits: until `signal` aborts, when it rejects with the signal's reason. */
export interface CatalogReadOptions {
	readonly signal?: AbortSignal;
}

/** Await mutations before observing their persisted result. */
export interface DurableWorkflowBackend {
	/** Whether state survives the current process. */
	readonly persistent: boolean;
	/** The root journal used for snapshot blobs and full-sequence frontier reads, when available. */
	readonly snapshotJournal?: RunJournal;
	workflowOwnership(
		workflowId: string,
	): "local" | "foreign" | "available" | Promise<"local" | "foreign" | "available">;
	/**
	 * Whether this backend itself holds `workflowId`'s lease without an executor running the run: it took a crashed
	 * owner's lease over to write to the run, for example to answer a prompt (#5167).
	 */
	holdsIdleWorkflowLease?(workflowId: string): boolean;
	persistSummary?(workflowId: string, summary: string, summarizedThrough: number): Promise<boolean>;
	/** Register or update a workflow's top-level metadata. */
	commitWorkflowRegistration(handle: WorkflowRegistrationInput): Promise<void>;
	/**
	 * Update the top-level metadata of a run a resume claimed, only while it is still as the claim left it: `running`
	 * under `modelOwner`. Its pending prompts and resumability stay as they are. False when another write changed it.
	 */
	commitClaimedWorkflowRegistration?(
		handle: WorkflowRegistrationInput,
		modelOwner: string | undefined,
	): Promise<boolean>;
	/**
	 * Undo an aborted adoption by `adopter`, merging into whatever was written since: only while `adopter` still owns
	 * the run, the run goes back to `modelOwner` and `releasedModelOwner`, and back to `status` if it is still `running`
	 * from the adoption. A pause, its pending prompts and its resumability stay; a run left paused is released by
	 * `modelOwner` when it was not already, so it stays adoptable. False when another owner has it.
	 */
	commitAdoptionRollback?(
		workflowId: string,
		adopter: string,
		status: DurableWorkflowStatus,
		modelOwner: string | undefined,
		releasedModelOwner: string | undefined,
	): Promise<boolean>;
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
	/**
	 * Messages whose cached delivery receipts changed since `cursor`, so a caller that caches receipt
	 * lookups can refresh only those messages. `messageIds` is `undefined` when any message may have changed.
	 */
	pendingStageDeliveryReceiptChanges?(
		workflowId: string,
		cursor: PendingStageReceiptCursor | undefined,
	): PendingStageReceiptChanges | undefined;
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
				/** The attempt the session record was written in (#4874). */
				attempt?: number;
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
	/**
	 * The attempt the run is in: the highest attempt record its root holds, 0 before its first resume (#4874). A child
	 * run's backend answers for its root.
	 */
	workflowAttempt?(workflowId: string): number;

	/**
	 * What `listCheckpoints` lists for the run plus the checkpoints recorded under its child boundary scope `scope`
	 * (`<scope>:…`), or every checkpoint of the run when `scope` is undefined, including those this backend left in
	 * storage. Only a backend that can keep a run's own checkpoints in memory without its children's implements it (a
	 * pooled root, #4318); call it through `readDurableCheckpoints`, which falls back to `listCheckpoints`.
	 */
	readCheckpoints?(workflowId: string, scope?: string): Promise<readonly DurableCheckpoint[]>;
	readRunOverviewCheckpoints?(workflowId: string): Promise<readonly DurableCheckpoint[]>;
	peekRunOverviewCheckpoints?(workflowId: string): readonly DurableCheckpoint[] | undefined;
	/**
	 * Lets go of the checkpoints of the child boundary scope `scope` the run still keeps in memory, once the run read
	 * them for that boundary's replay or checks; a backend that keeps every checkpoint ignores it.
	 */
	releaseCheckpointScope?(workflowId: string, scope: string): void;
	/**
	 * Whether the checkpoints of the child boundary scope `scope` are left in storage rather than listed by
	 * `listCheckpoints`: reconstruction then reads that child as not loaded rather than as missing.
	 */
	checkpointScopeReleased?(workflowId: string, scope: string): boolean;

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
		runGeneration?: number,
		finishSequence?: number,
	): Promise<void>;
	/**
	 * Atomically update status only when the authoritative status is expected.
	 * `modelOwner` adopts the run for a new session. `releasedModelOwner` durably records that
	 * the session owning the run was disposed, so another session may adopt it; `null` clears that record.
	 * Without either, a run that stays paused keeps its release, and a running run whose owner's process died
	 * (its executor's lease expired unreleased) is released by that owner as it is paused (#5167). A run that
	 * leaves paused, or is handed to a new `modelOwner`, loses its release.
	 */
	commitWorkflowStatusTransition(
		workflowId: string,
		expectedStatuses: readonly DurableWorkflowStatus[],
		status: DurableWorkflowStatus,
		pendingPrompts?: number,
		resumable?: boolean,
		expectedUpdatedAt?: number,
		modelOwner?: string,
		releasedModelOwner?: string | null,
		runGeneration?: number,
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
	/** Current resumable and completed catalog. A caller whose `signal` aborts stops waiting for it. */
	prepareWorkflowCatalog(options?: CatalogReadOptions): Promise<DurableWorkflowCatalogEntries>;

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
	/** Hydrate all catalog candidates from persistent storage. A caller whose `signal` aborts stops waiting for it. */
	hydrateResumableWorkflows(options?: CatalogReadOptions): Promise<void>;
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
	sortedCheckpoints?: readonly DurableCheckpoint[];
	toolByHash: Map<string, DurableToolCheckpoint>;
	uiByHash: Map<string, DurableUiCheckpoint>;
	stageOutputByReplayKey: Map<string, DurableStageCheckpoint>;
	stageSessionByReplayKey: Map<string, DurableStageCheckpoint>;
	nestedSnapshotVersion: NestedSnapshotVersion;
	/** Checkpoints counted as recorded but not kept in memory (see `releaseCheckpoints`). */
	released: number;
	/** The highest attempt record folded, kept or only counted (#4874). */
	attempt: number;
	/**
	 * Keys of locally acknowledged checkpoints whose journal events this reader has not folded, in receipt order.
	 * A lost reply can delay a receipt past its checkpoint's shipment and past another checkpoint's receipt.
	 */
	noted?: Set<string>;
	/** The last pending receipt in that order, so folding FIFO shipments need not scan the remaining receipts. */
	lastNotedKey?: string;
	/** Receipts in order and the journal's best completion-time candidate before applying those receipts. */
	notedByLookup?: Map<string, { keys: Set<string>; folded?: DurableToolCheckpoint | DurableStageCheckpoint }>;
}

function checkpointLookupGroup(c: DurableCheckpoint): string {
	return c.kind === "stage" ? `stage:${c.replayKey}` : c.kind === "tool" ? `tool:${c.argsHash}` : `ui:${c.promptHash}`;
}

function removeNoted(rec: JournalWorkflowRecord, key: string, c: DurableCheckpoint): boolean {
	if (!rec.noted?.delete(key)) return false;
	if (rec.lastNotedKey === key) {
		rec.lastNotedKey = undefined;
		for (const pending of rec.noted) rec.lastNotedKey = pending;
	}
	const identity = checkpointLookupGroup(c);
	const group = rec.notedByLookup!.get(identity)!;
	group.keys.delete(key);
	if (group.keys.size === 0) rec.notedByLookup!.delete(identity);
	return true;
}

export function checkpointKey(c: DurableCheckpoint): string {
	return `${c.kind}:${c.checkpointId}`;
}

/**
 * A journal decodes each field of a stage checkpoint into a string of its own, so a result the stage's output also
 * holds would sit in memory twice. A checkpoint that keeps one text under both names keeps one string (#4642).
 */
function sharingOutputAsResult(checkpoint: DurableCheckpoint): DurableCheckpoint {
	return checkpoint.kind === "stage" &&
		typeof checkpoint.output === "string" &&
		checkpoint.result === checkpoint.output
		? { ...checkpoint, result: checkpoint.output }
		: checkpoint;
}

export function normalizedCheckpoint(recorded: DurableCheckpoint): DurableCheckpoint {
	const checkpoint = sharingOutputAsResult(recorded);
	return checkpoint.kind === "stage" && checkpoint.topology === undefined
		? {
				...checkpoint,
				topology: {
					version: DURABLE_STAGE_TOPOLOGY_VERSION,
					stageId: checkpoint.checkpointId,
					parentIds: [],
				},
			}
		: checkpoint;
}

export function createJournalProjection() {
	return new JournalProjection();
}

class JournalProjection {
	private readonly workflows = new Map<string, JournalWorkflowRecord>();
	private readonly deletedWorkflowIds = new Set<string>();
	private readonly pendingReceipts = new Map<string, Map<string, PendingStageMessage>>();
	private readonly stickyReceipts = new PendingStageReceiptIndex();

	registerWorkflow(handle: WorkflowRegistrationInput, authoritativeOwner = false): void {
		this.deletedWorkflowIds.delete(handle.workflowId);
		const existing = this.workflows.get(handle.workflowId);
		const completedCheckpoints = handle.completedCheckpoints ?? existing?.handle.completedCheckpoints ?? 0;
		const pendingPrompts = handle.pendingPrompts ?? existing?.handle.pendingPrompts ?? 0;
		const updatedAt = handle.updatedAt ?? Date.now();
		const forkedFrom = handle.forkedFrom ?? existing?.handle.forkedFrom;
		const workspace = handle.workspace ?? existing?.handle.workspace;
		const snapshot = handle.snapshot ?? existing?.handle.snapshot;
		const full: DurableWorkflowHandle = {
			workflowId: handle.workflowId,
			name: handle.name,
			inputs: handle.inputs,
			createdAt: handle.createdAt,
			status: handle.status,
			transitionClaimId: handle.transitionClaimId ?? existing?.handle.transitionClaimId,
			...((handle.runGeneration ?? existing?.handle.runGeneration) !== undefined
				? { runGeneration: Math.max(handle.runGeneration ?? 0, existing?.handle.runGeneration ?? 0) }
				: {}),
			...(handle.finishSequence === undefined ? {} : { finishSequence: handle.finishSequence }),
			...((handle.definitionSource ?? existing?.handle.definitionSource) !== undefined
				? { definitionSource: handle.definitionSource ?? existing?.handle.definitionSource }
				: {}),
			resources: handle.resources ?? existing?.handle.resources,
			snapshots: handle.snapshots ?? existing?.handle.snapshots,
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
			...(handle.branch !== undefined
				? { branch: handle.branch }
				: existing?.handle.branch !== undefined
					? { branch: existing.handle.branch }
					: {}),
			...((handle.worktreeRootMappings ?? existing?.handle.worktreeRootMappings) !== undefined
				? { worktreeRootMappings: handle.worktreeRootMappings ?? existing?.handle.worktreeRootMappings }
				: {}),
			...((handle.worktreeRestoreOutcomes ?? existing?.handle.worktreeRestoreOutcomes) !== undefined
				? { worktreeRestoreOutcomes: handle.worktreeRestoreOutcomes ?? existing?.handle.worktreeRestoreOutcomes }
				: {}),
			pendingStageMessages: handle.pendingStageMessages ?? existing?.handle.pendingStageMessages ?? [],
			...(handle.possibleStages !== undefined
				? { possibleStages: handle.possibleStages }
				: existing?.handle.possibleStages !== undefined
					? { possibleStages: existing.handle.possibleStages }
					: {}),
			...(forkedFrom !== undefined ? { forkedFrom } : {}),
			...(workspace !== undefined ? { workspace } : {}),
			...(snapshot !== undefined ? { snapshot } : {}),
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
				released: 0,
				attempt: 0,
			});
	}
	applyWorkflowSnapshot(handle: DurableWorkflowHandle): void {
		if (!this.workflows.has(handle.workflowId)) this.registerWorkflow(handle, true);
		const record = this.workflows.get(handle.workflowId)!;
		record.handle = {
			...handle,
			completedCheckpoints: Math.max(handle.completedCheckpoints, record.checkpoints.size + record.released),
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
		const added = this.stickyReceipts.add(workflowId, messageId, delivery, accounting?.messageRunId);
		if (accounting !== undefined && added) {
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
		return this.stickyReceipts.has(workflowId, messageId, delivery, logicalRunId);
	}

	hasCachedPendingStageDeliveryReceipt(
		workflowId: string,
		messageId: string,
		delivery: Omit<PendingStageMessageDelivery, "deliveredAt">,
		anySession = false,
		logicalRunId = workflowId,
	): boolean {
		return this.stickyReceipts.has(workflowId, messageId, delivery, logicalRunId, anySession);
	}

	pendingStageDeliveryReceiptChanges(
		workflowId: string,
		cursor: PendingStageReceiptCursor | undefined,
	): PendingStageReceiptChanges {
		return this.stickyReceipts.changesSince(workflowId, cursor);
	}

	recordCheckpoint(recorded: DurableCheckpoint): void {
		const rec = this.workflows.get(recorded.workflowId);
		if (!rec) return;
		const key = checkpointKey(recorded);
		// The event of a noted checkpoint: the run holds it and counts it already, and from here on the journal orders it.
		const noted = rec.noted;
		let shipped: DurableCheckpoint | undefined;
		if (noted?.has(key)) {
			// A retry after a lost reply can note an already shipped event after a newer unshipped receipt.
			const group = rec.notedByLookup!.get(checkpointLookupGroup(recorded))!;
			const outOfOrder = group.keys.size > 1 && group.keys.values().next().value !== key;
			// A re-recorded checkpoint may carry the replay's clock. Restore the durable time winner before replacing
			// that provisional value: even a checkpoint folded before any receipt can now be the winner again.
			const retimed = rec.checkpoints.get(key)!.completedAt !== recorded.completedAt;
			if (retimed && recorded.kind === "stage") {
				if (group.folded?.kind === "stage") rec.stageSessionByReplayKey.set(recorded.replayKey, group.folded);
				else rec.stageSessionByReplayKey.delete(recorded.replayKey);
			} else if (retimed && recorded.kind === "tool") {
				if (group.folded?.kind === "tool") rec.toolByHash.set(recorded.argsHash, group.folded);
				else rec.toolByHash.delete(recorded.argsHash);
			}
			removeNoted(rec, key, recorded);
			shipped = normalizedCheckpoint(recorded);
			// Use the journal's payload: a snapshot whose blobs were collected before shipping is no longer in it.
			rec.checkpoints.delete(key);
			rec.checkpoints.set(key, shipped);
			rec.sortedCheckpoints = undefined;
			rec.nestedSnapshotVersion.record(shipped);
			this.indexLookups(rec, shipped, false);
			// The folded event belongs before the remaining receipts, including ones it had displaced at note time.
			// In-order shipments with an unchanged completion time need no replay.
			if (outOfOrder || retimed) for (const id of group.keys) this.indexLookups(rec, rec.checkpoints.get(id)!, true);
		}
		const checkpoint = shipped ?? this.index(rec, recorded);
		if (checkpoint !== undefined) {
			// A shipment precedes every receipt still waiting, even when their clocks disagree.
			const last = shipped && rec.lastNotedKey !== undefined ? rec.checkpoints.get(rec.lastNotedKey) : undefined;
			this.recordInHandle(rec, checkpoint, last?.completedAt);
		}
	}

	/**
	 * Records a pooled worker's locally accepted checkpoint before the reader folds its journal event (#4768). Until
	 * that event is folded, pending receipts follow the folded prefix in receipt order. The event then places the
	 * checkpoint at its journal position without counting it again, including after a lost reply and retry.
	 */
	noteCheckpoint(recorded: DurableCheckpoint): void {
		const rec = this.workflows.get(recorded.workflowId);
		if (!rec) return;
		const identity = checkpointLookupGroup(recorded);
		const folded =
			recorded.kind === "stage"
				? rec.stageSessionByReplayKey.get(recorded.replayKey)
				: recorded.kind === "tool"
					? rec.toolByHash.get(recorded.argsHash)
					: undefined;
		const checkpoint = this.index(rec, recorded, true);
		if (checkpoint === undefined) return;
		const key = checkpointKey(checkpoint);
		rec.noted ??= new Set();
		rec.noted.add(key);
		rec.lastNotedKey = key;
		rec.notedByLookup ??= new Map();
		const group = rec.notedByLookup.get(identity);
		if (group) group.keys.add(key);
		else rec.notedByLookup.set(identity, { keys: new Set([key]), folded });
		this.recordInHandle(rec, checkpoint);
	}

	/**
	 * Counts a recorded checkpoint, as `recordCheckpoint` does, without keeping it in memory: the run's handle reads as
	 * if it were recorded, and its reads do not find it. Unlike `recordCheckpoint` it cannot tell a repeat, which it
	 * never sees: a journal folds each checkpoint event once, keyed uniquely in its run.
	 */
	countCheckpoint(recorded: DurableCheckpoint): void {
		const rec = this.workflows.get(recorded.workflowId);
		if (!rec) return;
		rec.attempt = Math.max(rec.attempt, workflowAttemptOf(recorded) ?? 0);
		rec.released++;
		this.recordInHandle(rec, recorded);
	}

	/** Sets the run's handle as recording `checkpoint`, the run's latest, sets it. */
	private recordInHandle(
		rec: JournalWorkflowRecord,
		checkpoint: DurableCheckpoint,
		updatedAt = checkpoint.completedAt,
	): void {
		// A run still `running` that recorded its definition completed in its current attempt is completed: the store
		// refused its terminal status write (#5133).
		const completed = rec.handle.status === "running" && completedRunAttempt(checkpoint) === rec.attempt;
		rec.handle = {
			...rec.handle,
			completedCheckpoints: rec.checkpoints.size + rec.released,
			updatedAt,
			...(completed ? { status: "completed" as const } : {}),
		};
	}

	/**
	 * Drops the held checkpoints so `restoreCheckpoint` can restore the selected journal prefix. Pending receipts
	 * have no journal entry to restore: return them in order so the caller can keep those still selected.
	 */
	releaseCheckpoints(workflowId: string): readonly DurableCheckpoint[] {
		const rec = this.workflows.get(workflowId);
		if (!rec) return [];
		const pending = Array.from(rec.noted ?? [], (key) => rec.checkpoints.get(key)!);
		rec.released += rec.checkpoints.size - pending.length;
		if (pending.length) rec.handle = { ...rec.handle, completedCheckpoints: rec.released };
		rec.noted = undefined;
		rec.lastNotedKey = undefined;
		rec.notedByLookup = undefined;
		rec.checkpoints.clear();
		rec.sortedCheckpoints = undefined;
		rec.toolByHash.clear();
		rec.uiByHash.clear();
		rec.stageOutputByReplayKey.clear();
		rec.stageSessionByReplayKey.clear();
		rec.nestedSnapshotVersion = new NestedSnapshotVersion(workflowId);
		return pending;
	}

	/**
	 * Drops the checkpoints with these keys from memory; they stay counted, as `releaseCheckpoints` leaves them. The keys
	 * name every checkpoint a run kept under one child boundary scope, whose lookup identities (tool args hash, prompt
	 * hash, replay key) are all that scope's, so their lookups go with them: a lookup of another scope or of the run's
	 * own checkpoints finds what it found before, and the run's nested snapshot version does not change. The version's
	 * replay group summaries keep the scope's entries; they are read only for the run's own replay records. A noted
	 * checkpoint is counted once its event is folded instead.
	 */
	forgetCheckpoints(workflowId: string, keys: readonly string[]): void {
		const rec = this.workflows.get(workflowId);
		if (!rec) return;
		const pendingBefore = rec.noted?.size;
		for (const key of keys) {
			const checkpoint = rec.checkpoints.get(key);
			if (checkpoint === undefined) continue;
			rec.checkpoints.delete(key);
			rec.sortedCheckpoints = undefined;
			if (!removeNoted(rec, key, checkpoint)) rec.released++;
			if (checkpoint.kind === "tool") rec.toolByHash.delete(checkpoint.argsHash);
			else if (checkpoint.kind === "ui") rec.uiByHash.delete(checkpoint.promptHash);
			else {
				rec.stageOutputByReplayKey.delete(checkpoint.replayKey);
				rec.stageSessionByReplayKey.delete(checkpoint.replayKey);
			}
		}
		if (rec.noted?.size !== pendingBefore)
			rec.handle = { ...rec.handle, completedCheckpoints: rec.checkpoints.size + rec.released };
	}

	/**
	 * Keeps again a checkpoint that was counted and released. Checkpoints are restored in the order they were recorded,
	 * so each read finds what it found when every checkpoint was kept; the run's handle does not change.
	 */
	restoreCheckpoint(recorded: DurableCheckpoint): void {
		const rec = this.workflows.get(recorded.workflowId);
		if (rec !== undefined && this.index(rec, recorded) !== undefined && rec.released > 0) rec.released--;
	}

	/**
	 * Adds a checkpoint to its run's indexes; the normalized checkpoint, or undefined when the run already has it. A
	 * checkpoint being noted (`noteCheckpoint`) is the latest of its lookups.
	 */
	private index(
		rec: JournalWorkflowRecord,
		recorded: DurableCheckpoint,
		noting = false,
	): DurableCheckpoint | undefined {
		const currentCheckpoint = normalizedCheckpoint(recorded);
		const key = checkpointKey(currentCheckpoint);
		if (rec.checkpoints.has(key)) return undefined;
		rec.checkpoints.set(key, currentCheckpoint);
		rec.sortedCheckpoints = undefined;
		rec.attempt = Math.max(rec.attempt, workflowAttemptOf(currentCheckpoint) ?? 0);
		rec.nestedSnapshotVersion.record(currentCheckpoint);
		this.indexLookups(rec, currentCheckpoint, noting);
		return currentCheckpoint;
	}

	/**
	 * Points the lookups of `checkpoint` at it where it is the latest: a tool's or a stage session's lookup keeps the
	 * checkpoint completed last, and the later of two completed at once; the others keep the later checkpoint. A noted
	 * checkpoint whose event is not recorded yet is later than `checkpoint`, unless `checkpoint` is being noted after it.
	 */
	private indexLookups(rec: JournalWorkflowRecord, checkpoint: DurableCheckpoint, noting: boolean): void {
		if (
			!noting &&
			rec.notedByLookup?.size &&
			((checkpoint.kind === "stage" && checkpoint.sessionId !== undefined) ||
				(checkpoint.kind === "tool" && checkpoint.throwingFailureError === undefined))
		) {
			const group = rec.notedByLookup.get(checkpointLookupGroup(checkpoint));
			if (group && (!group.folded || checkpoint.completedAt >= group.folded.completedAt)) group.folded = checkpoint;
		}
		const later = (existing: DurableCheckpoint | undefined): boolean =>
			!noting && existing !== undefined && rec.noted?.has(checkpointKey(existing)) === true;
		const completedLater = (existing: DurableCheckpoint | undefined): boolean =>
			existing === undefined ||
			checkpoint.completedAt > existing.completedAt ||
			(checkpoint.completedAt === existing.completedAt && !later(existing));
		if (checkpoint.kind === "tool") {
			if (checkpoint.throwingFailureError === undefined && completedLater(rec.toolByHash.get(checkpoint.argsHash)))
				rec.toolByHash.set(checkpoint.argsHash, checkpoint);
		} else if (checkpoint.kind === "ui") {
			if (!later(rec.uiByHash.get(checkpoint.promptHash))) rec.uiByHash.set(checkpoint.promptHash, checkpoint);
		} else {
			if ("output" in checkpoint && !later(rec.stageOutputByReplayKey.get(checkpoint.replayKey)))
				rec.stageOutputByReplayKey.set(checkpoint.replayKey, checkpoint);
			if (
				checkpoint.sessionId !== undefined &&
				completedLater(rec.stageSessionByReplayKey.get(checkpoint.replayKey))
			)
				rec.stageSessionByReplayKey.set(checkpoint.replayKey, checkpoint);
		}
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
				/** The attempt the session record was written in (#4874). */
				attempt?: number;
		  }
		| undefined {
		const checkpoint = this.workflows.get(workflowId)?.stageSessionByReplayKey.get(replayKey);
		if (checkpoint?.sessionId === undefined) return undefined;
		return {
			...(checkpoint.sessionId !== undefined ? { sessionId: checkpoint.sessionId } : {}),
			...(checkpoint.sessionFile !== undefined ? { sessionFile: checkpoint.sessionFile } : {}),
			...(checkpoint.startedAt !== undefined ? { startedAt: checkpoint.startedAt } : {}),
			...(checkpoint.durationMs !== undefined ? { durationMs: checkpoint.durationMs } : {}),
			...(checkpoint.attempt !== undefined ? { attempt: checkpoint.attempt } : {}),
		};
	}

	/** The folded prefix followed by pending local receipts, including when both finished in the same millisecond. */
	private inRecordOrder(rec: JournalWorkflowRecord): DurableCheckpoint[] {
		if (!rec.noted?.size) return [...rec.checkpoints.values()];
		const ordered: DurableCheckpoint[] = [];
		for (const [key, checkpoint] of rec.checkpoints) if (!rec.noted.has(key)) ordered.push(checkpoint);
		for (const key of rec.noted) ordered.push(rec.checkpoints.get(key)!);
		return ordered;
	}

	recordedCheckpoints(workflowId: string): readonly DurableCheckpoint[] | undefined {
		const rec = this.workflows.get(workflowId);
		if (rec === undefined || rec.released > 0) return undefined;
		return this.inRecordOrder(rec);
	}

	listCheckpoints(workflowId: string): readonly DurableCheckpoint[] {
		const rec = this.workflows.get(workflowId);
		if (!rec) return [];
		if (rec.sortedCheckpoints === undefined) {
			rec.sortedCheckpoints = Object.freeze(this.inRecordOrder(rec).sort((a, b) => a.completedAt - b.completedAt));
		}
		return rec.sortedCheckpoints;
	}

	/** The checkpoint kept under `checkpointKey(checkpoint)`, if any. */
	getStoredCheckpoint(checkpoint: DurableCheckpoint): DurableCheckpoint | undefined {
		return this.workflows.get(checkpoint.workflowId)?.checkpoints.get(checkpointKey(checkpoint));
	}

	workflowAttempt(workflowId: string): number {
		return this.workflows.get(workflowId)?.attempt ?? 0;
	}

	/**
	 * `checkpoint` stamped with its run's attempt, as it is committed (#4874): every writer of the run's records commits
	 * through here or through a pool worker, which stamps the same way.
	 */
	stampAttempt(checkpoint: DurableCheckpoint): DurableCheckpoint {
		return stampCheckpointAttempt(
			checkpoint,
			this.workflowAttempt(checkpoint.workflowId),
			this.getStoredCheckpoint(checkpoint),
		);
	}

	/** One stage checkpoint by id, without listing the run's checkpoints. */
	getStageCheckpoint(workflowId: string, checkpointId: string): DurableStageCheckpoint | undefined {
		const checkpoint = this.workflows.get(workflowId)?.checkpoints.get(`stage:${checkpointId}`);
		return checkpoint?.kind === "stage" ? checkpoint : undefined;
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
			completedAll: this.listFinishedRootWorkflows(),
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
		runGeneration?: number,
		finishSequence?: number,
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
			failedToolUnrecorded: undefined,
			...(runGeneration === undefined
				? {}
				: { runGeneration: Math.max(runGeneration, rec.handle.runGeneration ?? 0) }),
			status,
			finishSequence: finishSequence ?? (status === rec.handle.status ? rec.handle.finishSequence : undefined),
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

	/** Every root run that reached a terminal status, whatever progress it recorded. */
	listFinishedRootWorkflows(): readonly ResumableWorkflowEntry[] {
		return [...this.workflows.values()]
			.filter((rec) => isRootWorkflow(rec.handle) && isTerminalStatus(rec.handle.status))
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
			...(h.runGeneration !== undefined ? { runGeneration: h.runGeneration } : {}),
			...(h.finishSequence !== undefined ? { finishSequence: h.finishSequence } : {}),
			createdAt: h.createdAt,
			completedCheckpoints: h.completedCheckpoints,
			pendingPrompts: h.pendingPrompts,
			pendingStageMessages: h.pendingStageMessages ?? [],
			...(h.possibleStages !== undefined ? { possibleStages: h.possibleStages } : {}),
			...(h.definitionSource !== undefined ? { definitionSource: h.definitionSource } : {}),
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
			...(h.branch !== undefined ? { branch: h.branch } : {}),
			...(h.snapshots !== undefined ? { snapshots: h.snapshots } : {}),
			...(h.worktreeRootMappings !== undefined ? { worktreeRootMappings: h.worktreeRootMappings } : {}),
			...(h.worktreeRestoreOutcomes !== undefined ? { worktreeRestoreOutcomes: h.worktreeRestoreOutcomes } : {}),
			...(h.forkedFrom !== undefined ? { forkedFrom: h.forkedFrom } : {}),
			...(h.workspace !== undefined ? { workspace: h.workspace } : {}),
			...(h.snapshot !== undefined ? { snapshot: h.snapshot } : {}),
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

	/**
	 * Takes `staged`'s state of `workflowId` in place of this projection's, as deleting the workflow here and folding its
	 * events again would leave it: a journal backend folds a long history into a staging projection over several turns
	 * of the event loop, and readers of this one see the workflow change in one step (#5480).
	 */
	adoptWorkflow(workflowId: string, staged: JournalProjection): void {
		const take = <Value>(into: Map<string, Value>, from: Map<string, Value>) => {
			const value = from.get(workflowId);
			if (value === undefined) into.delete(workflowId);
			else into.set(workflowId, value);
		};
		// A direct rebuild removes the old catalog entry and appends the rebuilt one.
		this.workflows.delete(workflowId);
		take(this.workflows, staged.workflows);
		take(this.pendingReceipts, staged.pendingReceipts);
		this.stickyReceipts.adopt(workflowId, staged.stickyReceipts);
		take(this.stickyDeliveryCounts, staged.stickyDeliveryCounts);
		this.bumpDeliveryCountVersion(workflowId);
		if (this.workflows.has(workflowId)) this.deletedWorkflowIds.delete(workflowId);
		else this.deletedWorkflowIds.add(workflowId);
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

function isTerminalStatus(status: DurableWorkflowStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
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
		...(handle.branch !== undefined ? { branch: handle.branch } : {}),
		...(handle.forkedFrom !== undefined ? { forkedFrom: handle.forkedFrom } : {}),
		createdAt: handle.createdAt,
		updatedAt: handle.updatedAt,
	};
}

/** Count-version tokens are unique across projections, so tokens from different backends never compare equal. */
let deliveryCountEpoch = 0;
