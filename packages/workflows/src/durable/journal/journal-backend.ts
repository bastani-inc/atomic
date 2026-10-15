import { randomUUID } from "node:crypto";
import { WorkflowInstanceOwnershipError } from "../../extension/workflow-instance-owner.js";
import { STAGE_SESSION_HEARTBEAT_INTERVAL_MS } from "../../runs/foreground/stage-session-heartbeat.js";
import type { PendingStageMessage, PendingStageMessageDelivery } from "../../shared/store-types.js";
import type { WorkflowSerializableValue } from "../../shared/types.js";
import {
	type DurableWorkflowBackend,
	InMemoryDurableBackend,
	replacePendingStageMessagesForRun,
	type WorkflowRegistrationInput,
} from "../backend.js";
import {
	inactivePromptReservationToken,
	type PromptReservationSnapshot,
	PromptReservationState,
	type PromptReservationToken,
} from "../prompt-reservation-state.js";
import { FOREIGN_LIVE_WORKFLOW_WINDOW_MS } from "../resume-eligibility.js";
import type {
	DurableCheckpoint,
	DurableWorkflowFailureMetadata,
	DurableWorkflowHandle,
	DurableWorkflowStatus,
} from "../types.js";
import { SqliteRunJournal } from "./sqlite-run-journal.js";
import {
	RUN_EVENT_TYPES as E,
	JournalCasConflictError,
	type JournalEntry,
	JournalError,
	type Lease,
	type RunEvent,
	type RunJournal,
	RunNotFoundError,
	StaleLeaseError,
	StorageUnavailableError,
	type SynchronousRunJournal,
} from "./types.js";

const PROCESS_HOLDER_ID = randomUUID();

type BackendJournal = RunJournal & SynchronousRunJournal;
type SnapshotPayload = { readonly handle: DurableWorkflowHandle; readonly prompts?: PromptReservationSnapshot };
type DeliveryPayload = {
	readonly messageId: string;
	readonly delivery: PendingStageMessageDelivery;
	readonly accounting?: { readonly messageRunId: string; readonly deliveryCount: number };
};

type JsonPayload<Value> = Value extends WorkflowSerializableValue | undefined
	? Value
	: Value extends object
		? { [Key in keyof Value]: JsonPayload<Value[Key]> }
		: Value;
type BackendEventOf<Type extends RunEvent["type"], Payload> = {
	[Tag in Type]: { readonly type: Tag; readonly payload: JsonPayload<Payload> };
}[Type];
type BackendEvent =
	| BackendEventOf<typeof E.checkpointRecorded, DurableCheckpoint>
	| BackendEventOf<typeof E.messageSettled, { readonly message: PendingStageMessage }>
	| BackendEventOf<typeof E.messageDelivered, DeliveryPayload>
	| BackendEventOf<typeof E.promptAsked | typeof E.promptReleased, SnapshotPayload>
	| BackendEventOf<
			typeof E.runStarted | typeof E.statusChanged | typeof E.messageQueued | typeof E.summaryRecorded,
			DurableWorkflowHandle
	  >;

export class JournalOwnershipError extends WorkflowInstanceOwnershipError {
	constructor(
		readonly runId: string,
		readonly holderId: string | null,
		override readonly cause?: StaleLeaseError,
	) {
		super(`Workflow ${runId} is owned by another execution`);
		this.name = "JournalOwnershipError";
	}
}

export class JournalBackendClosedError extends JournalError {
	constructor() {
		super("Journal backend is closed");
		this.name = "JournalBackendClosedError";
	}
}

export class JournalOperationAbortedError extends JournalError {
	constructor(
		readonly runId: string,
		override readonly cause?: Error,
	) {
		super(`Journal operation aborted for ${runId}`, { cause });
		this.name = "JournalOperationAbortedError";
	}
}

export class JournalMessageScopeError extends JournalError {
	constructor(
		readonly runId: string,
		readonly messageRunId: string,
	) {
		super(`Message run ${messageRunId} does not match ${runId}`);
		this.name = "JournalMessageScopeError";
	}
}

export class JournalDurableBackend implements DurableWorkflowBackend {
	readonly persistent = true;
	private readonly projection = new InMemoryDurableBackend();
	private readonly sequences = new Map<string, number>();
	private readonly leases = new Map<string, Lease>();
	private readonly lost = new Map<string, Error>();
	private readonly prompts = new Map<string, PromptReservationState>();
	private readonly timer: ReturnType<typeof setInterval>;
	private closed = false;

	constructor(
		readonly journal: BackendJournal = new SqliteRunJournal(),
		readonly holderId = `${PROCESS_HOLDER_ID}:${randomUUID()}`,
	) {
		for (const run of journal.listRunsSync()) this.refresh(run.runId);
		this.timer = setInterval(() => this.renewLeases(), STAGE_SESSION_HEARTBEAT_INTERVAL_MS);
		this.timer.unref();
	}

	static async open(path?: string): Promise<JournalDurableBackend> {
		const journal = new SqliteRunJournal(path);
		try {
			const backend = new JournalDurableBackend(journal);
			backend.projection.reset();
			backend.sequences.clear();
			backend.prompts.clear();
			for (const run of await journal.listRuns()) {
				for await (const entry of journal.read(run.runId)) backend.fold(entry);
			}
			return backend;
		} catch (error) {
			await journal.close();
			throw error;
		}
	}

	private fold(entry: JournalEntry): void {
		const event = entry.event as BackendEvent;
		if (event.type === E.checkpointRecorded) {
			this.projection.recordCheckpoint(event.payload);
		} else if (event.type === E.messageSettled) {
			const payload = event.payload;
			void this.projection.archivePendingStageMessage(entry.runId, payload.message);
		} else if (event.type === E.messageDelivered) {
			const payload = event.payload;
			void this.projection.archivePendingStageDeliveryReceipt(
				entry.runId,
				payload.messageId,
				payload.delivery,
				payload.accounting,
			);
		} else if (event.type === E.promptAsked || event.type === E.promptReleased) {
			const payload = event.payload;
			this.projection.applyWorkflowSnapshot(payload.handle);
			this.prompts.set(entry.runId, new PromptReservationState(payload.handle.pendingPrompts, payload.prompts));
		} else {
			const handle = event.payload;
			const previous = this.projection.getWorkflow(entry.runId);
			this.projection.applyWorkflowSnapshot(handle);
			if (event.type === E.runStarted || previous?.pendingPrompts !== handle.pendingPrompts)
				this.prompts.delete(entry.runId);
		}
		this.sequences.set(entry.runId, entry.seq);
	}

	private rebuild(runId: string): void {
		const entries = this.journal.readEntries(runId);
		void this.projection.deleteWorkflow(runId);
		this.sequences.delete(runId);
		this.prompts.delete(runId);
		for (const entry of entries) this.fold(entry);
	}

	private refresh(runId: string): void {
		if (!this.leases.has(runId)) {
			this.rebuild(runId);
			return;
		}
		for (const entry of this.journal.readEntries(runId, (this.sequences.get(runId) ?? 0) + 1)) this.fold(entry);
	}

	private current(runId: string): DurableWorkflowHandle | undefined {
		this.ensureOpen();
		this.refresh(runId);
		if (this.projection.getWorkflow(runId) === undefined) return undefined;
		try {
			this.ownership(runId);
		} catch (error) {
			if (!(error instanceof RunNotFoundError)) throw error;
			this.rebuild(runId);
			return undefined;
		}
		this.refresh(runId);
		return this.projection.getWorkflow(runId);
	}

	private ensureOpen(): void {
		if (this.closed) throw new JournalBackendClosedError();
	}

	private ownership(runId: string): Lease {
		this.ensureOpen();
		const lost = this.lost.get(runId);
		if (lost) throw lost;
		const existing = this.leases.get(runId);
		if (existing) return existing;
		const result = this.journal.takeoverExpiredSync(
			runId,
			this.holderId,
			Date.now() - FOREIGN_LIVE_WORKFLOW_WINDOW_MS,
		);
		if (result.status === "held") throw new JournalOwnershipError(runId, result.holderId);
		this.rebuild(runId);
		this.leases.set(runId, result.lease);
		return result.lease;
	}

	private mapOwnership(error: Error, runId: string): Error {
		if (!(error instanceof StaleLeaseError)) return error;
		const failure = new JournalOwnershipError(runId, this.journal.leaseState(runId)?.holderId ?? null, error);
		this.lost.set(runId, failure);
		return failure;
	}

	private append(
		runId: string,
		event: BackendEvent,
		options?: { readonly key?: string; readonly expectSeq?: number },
	): void {
		const lease = this.ownership(runId);
		try {
			this.journal.appendSync(lease, event, options);
			this.refresh(runId);
		} catch (error) {
			if (error instanceof Error) throw this.mapOwnership(error, runId);
			throw error;
		}
	}

	private snapshot(
		handle: DurableWorkflowHandle,
		type:
			| typeof E.statusChanged
			| typeof E.runStarted
			| typeof E.messageQueued
			| typeof E.summaryRecorded = E.statusChanged,
		expectSeq?: number,
	): void {
		this.append(handle.workflowId, { type, payload: handle }, expectSeq === undefined ? undefined : { expectSeq });
	}

	private draft(runId: string): InMemoryDurableBackend {
		const draft = new InMemoryDurableBackend();
		const handle = this.current(runId);
		if (handle) draft.registerWorkflow(handle, true);
		return draft;
	}

	registerWorkflow(input: WorkflowRegistrationInput): void {
		this.ensureOpen();
		this.journal.createRunSync({
			runId: input.workflowId,
			name: input.name,
			cwd: input.invocationCwd ?? process.cwd(),
			createdAt: input.createdAt,
			status: input.status,
			inputs: input.inputs,
		});
		this.ownership(input.workflowId);
		this.refresh(input.workflowId);
		const draft = this.draft(input.workflowId);
		draft.registerWorkflow(input, true);
		this.snapshot(
			draft.getWorkflow(input.workflowId)!,
			this.sequences.has(input.workflowId) ? E.statusChanged : E.runStarted,
		);
	}

	recordCheckpoint(checkpoint: DurableCheckpoint): void {
		if (!this.current(checkpoint.workflowId)) return;
		this.append(
			checkpoint.workflowId,
			{ type: E.checkpointRecorded, payload: checkpoint },
			{
				key: JSON.stringify([E.checkpointRecorded, checkpoint.kind, checkpoint.checkpointId]),
			},
		);
	}

	async recordCheckpointAsync(
		checkpoint: DurableCheckpoint,
		options?: { readonly signal?: AbortSignal },
	): Promise<void> {
		if (options?.signal?.aborted)
			throw new JournalOperationAbortedError(
				checkpoint.workflowId,
				options.signal.reason instanceof Error ? options.signal.reason : undefined,
			);
		this.recordCheckpoint(checkpoint);
	}

	async recordAdditiveCheckpointBestEffort(checkpoint: DurableCheckpoint): Promise<boolean> {
		try {
			await this.recordCheckpointAsync(checkpoint);
			return true;
		} catch (error) {
			if (!(error instanceof StorageUnavailableError)) throw error;
			return false;
		}
	}

	async flush(): Promise<void> {
		this.ensureOpen();
	}

	setWorkflowStatus(
		runId: string,
		status: DurableWorkflowStatus,
		pendingPrompts?: number,
		resumable?: boolean,
		failure?: DurableWorkflowFailureMetadata,
	): void {
		const draft = this.draft(runId);
		draft.setWorkflowStatus(runId, status, pendingPrompts, resumable, failure);
		const handle = draft.getWorkflow(runId);
		if (handle) this.snapshot(handle);
	}

	async transitionWorkflowStatus(
		runId: string,
		expected: readonly DurableWorkflowStatus[],
		status: DurableWorkflowStatus,
		pendingPrompts?: number,
		resumable?: boolean,
		expectedUpdatedAt?: number,
		modelOwner?: string,
		releasedModelOwner?: string,
	): Promise<boolean> {
		this.refresh(runId);
		const current = this.projection.getWorkflow(runId);
		if (
			!current ||
			!expected.includes(current.status) ||
			(expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt)
		)
			return false;
		const draft = this.draft(runId);
		const acquired = draft.getWorkflow(runId);
		if (
			!acquired ||
			!expected.includes(acquired.status) ||
			(expectedUpdatedAt !== undefined && acquired.updatedAt !== expectedUpdatedAt)
		)
			return false;
		const seq = this.sequences.get(runId) ?? 0;
		draft.setWorkflowStatus(runId, status, pendingPrompts, resumable);
		const { releasedModelOwner: _oldRelease, ...handle } = draft.getWorkflow(runId)!;
		try {
			this.snapshot(
				{
					...handle,
					...(modelOwner !== undefined ? { modelOwner } : {}),
					...(releasedModelOwner !== undefined ? { releasedModelOwner } : {}),
				},
				E.statusChanged,
				seq,
			);
			return true;
		} catch (error) {
			if (error instanceof JournalCasConflictError) {
				this.refresh(runId);
				return false;
			}
			throw error;
		}
	}

	private promptChange<T>(
		runId: string,
		type: typeof E.promptAsked | typeof E.promptReleased,
		change: (state: PromptReservationState) => T,
	): T | undefined {
		const handle = this.current(runId);
		if (!handle) return undefined;
		const state = new PromptReservationState(handle.pendingPrompts, this.prompts.get(runId)?.snapshot());
		const result = change(state);
		this.append(runId, {
			type,
			payload: {
				handle: { ...handle, pendingPrompts: state.pendingPrompts, updatedAt: Date.now() },
				prompts: state.snapshot(),
			},
		});
		return result;
	}

	adjustPendingPrompts(runId: string, delta: number): void {
		this.promptChange(runId, delta >= 0 ? E.promptAsked : E.promptReleased, (state) => state.adjust(delta));
	}
	promptReservationScope(runId: string) {
		return { rootWorkflowId: runId, scope: "root" };
	}
	pendingPromptToken(runId: string, reservationId: string): PromptReservationToken | undefined {
		return this.promptChange(runId, E.promptAsked, (state) => state.claim(reservationId));
	}
	reservePendingPrompt(runId: string, reservationId: string): PromptReservationToken {
		return (
			this.promptChange(runId, E.promptAsked, (state) => state.reserve(reservationId)) ??
			inactivePromptReservationToken(reservationId)
		);
	}
	releasePendingPrompt(runId: string, reservationId: string, token: PromptReservationToken): void {
		this.promptChange(runId, E.promptReleased, (state) => state.release(reservationId, token));
	}

	async persistSummary(runId: string, summary: string, summarizedThrough: number): Promise<boolean> {
		const handle = this.current(runId);
		if (!handle || (handle.summarizedThrough ?? -Infinity) > summarizedThrough) return false;
		this.snapshot({ ...handle, summary, summarizedThrough }, E.summaryRecorded);
		return true;
	}

	async persistPendingStageMessages(
		runId: string,
		messages: readonly PendingStageMessage[],
		logicalRunId = runId,
	): Promise<boolean> {
		const handle = this.current(runId);
		if (!handle) return false;
		for (const message of messages)
			if (message.runId !== logicalRunId) throw new JournalMessageScopeError(logicalRunId, message.runId);
		this.snapshot(
			{
				...handle,
				pendingStageMessages: replacePendingStageMessagesForRun(
					handle.pendingStageMessages ?? [],
					logicalRunId,
					messages,
				),
				updatedAt: Math.max(Date.now(), handle.updatedAt + 1),
			},
			E.messageQueued,
		);
		return true;
	}

	async archivePendingStageMessage(runId: string, message: PendingStageMessage): Promise<void> {
		this.append(
			runId,
			{ type: E.messageSettled, payload: { message } },
			{ key: JSON.stringify([E.messageSettled, message.runId, message.id]) },
		);
	}
	async archivePendingStageDeliveryReceipt(
		runId: string,
		messageId: string,
		delivery: PendingStageMessageDelivery,
		accounting?: { readonly messageRunId: string; readonly deliveryCount: number },
	): Promise<void> {
		this.append(runId, {
			type: E.messageDelivered,
			payload: { messageId, delivery, ...(accounting === undefined ? {} : { accounting }) },
		});
	}

	getToolOutput = this.projection.getToolOutput.bind(this.projection);
	getToolCheckpoint = this.projection.getToolCheckpoint.bind(this.projection);
	getUiResponse = this.projection.getUiResponse.bind(this.projection);
	getStageOutput = this.projection.getStageOutput.bind(this.projection);
	getStageSession = this.projection.getStageSession.bind(this.projection);
	listCheckpoints = this.projection.listCheckpoints.bind(this.projection);
	getWorkflow = this.projection.getWorkflow.bind(this.projection);
	getLoadableWorkflow = this.projection.getLoadableWorkflow.bind(this.projection);
	listResumableWorkflows = this.projection.listResumableWorkflows.bind(this.projection);
	listCompletedWorkflows = this.projection.listCompletedWorkflows.bind(this.projection);
	toMetadata = this.projection.toMetadata.bind(this.projection);
	isWorkflowLoadable = this.projection.isWorkflowLoadable.bind(this.projection);
	readSettledPendingStageMessage = this.projection.readSettledPendingStageMessage.bind(this.projection);
	getPendingStageMessageDeliveryCount = this.projection.getPendingStageMessageDeliveryCount.bind(this.projection);
	hasPendingStageDeliveryReceipt = this.projection.hasPendingStageDeliveryReceipt.bind(this.projection);
	hasCachedPendingStageDeliveryReceipt = this.projection.hasCachedPendingStageDeliveryReceipt.bind(this.projection);

	async readPendingStageMessageDeliveryCount(runId: string, messageId: string, logicalRunId = runId): Promise<number> {
		return this.getPendingStageMessageDeliveryCount(runId, messageId, logicalRunId);
	}
	async hydrateWorkflow(runId: string): Promise<void> {
		this.rebuild(runId);
	}
	async hydrateResumableWorkflows(): Promise<void> {
		const runIds = new Set([...this.sequences.keys(), ...this.journal.listRunsSync().map((run) => run.runId)]);
		for (const runId of runIds) await this.hydrateWorkflow(runId);
	}
	async prepareWorkflowCatalog() {
		await this.hydrateResumableWorkflows();
		return this.projection.prepareWorkflowCatalog();
	}

	private async deleteOwned(runId: string, expectSeq?: number): Promise<void> {
		if (this.leases.has(runId) || this.journal.listRunsSync().some((run) => run.runId === runId)) {
			try {
				this.journal.deleteOwnedRunSync(this.ownership(runId), expectSeq);
			} catch (error) {
				if (!(error instanceof RunNotFoundError)) {
					if (error instanceof Error) throw this.mapOwnership(error, runId);
					throw error;
				}
			}
		}
		this.leases.delete(runId);
		this.sequences.delete(runId);
		this.prompts.delete(runId);
		await this.projection.deleteWorkflow(runId);
	}

	async deleteWorkflow(runId: string): Promise<void> {
		await this.deleteOwned(runId);
	}

	async deleteWorkflowIfInactive(runId: string) {
		for (;;) {
			this.refresh(runId);
			const handle = this.projection.getWorkflow(runId);
			if (!handle) return { ok: false, reason: "not_found" } as const;
			if (handle.status === "running") return { ok: false, reason: "running" } as const;
			const acquired = this.current(runId);
			if (!acquired) return { ok: false, reason: "not_found" } as const;
			if (acquired.status === "running") return { ok: false, reason: "running" } as const;
			try {
				await this.deleteOwned(runId, this.sequences.get(runId) ?? 0);
				return { ok: true } as const;
			} catch (error) {
				if (!(error instanceof JournalCasConflictError)) throw error;
			}
		}
	}

	reset(): void {
		for (const run of this.journal.listRunsSync()) this.journal.deleteRunSync(run.runId);
		this.projection.reset();
		this.sequences.clear();
		this.leases.clear();
		this.lost.clear();
		this.prompts.clear();
	}

	private renewLeases(): void {
		for (const [runId, lease] of this.leases) {
			if (this.lost.has(runId)) continue;
			try {
				this.journal.renewSync(lease);
			} catch (error) {
				if (error instanceof Error) this.lost.set(runId, this.mapOwnership(error, runId));
			}
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		clearInterval(this.timer);
		try {
			for (const lease of this.leases.values()) {
				try {
					this.journal.releaseSync(lease);
				} catch (error) {
					if (!(error instanceof StaleLeaseError)) throw error;
				}
			}
		} finally {
			this.closed = true;
			await this.journal.close();
		}
	}
}
