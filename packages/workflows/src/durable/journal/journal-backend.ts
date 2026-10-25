import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { StorageError } from "@bastani/atomic/storage";
import { STAGE_SESSION_HEARTBEAT_INTERVAL_MS } from "../../runs/foreground/stage-session-heartbeat.js";
import type { PendingStageMessage, PendingStageMessageDelivery } from "../../shared/store-types.js";
import type { WorkflowSerializableValue } from "../../shared/types.js";
import { WorkflowInstanceOwnershipError } from "../../shared/workflow-instance-ownership-error.js";
import {
	createJournalProjection,
	type DurableWorkflowBackend,
	replacePendingStageMessagesForRun,
	type WorkflowRegistrationInput,
} from "../backend.js";
import { DurableNestedTopologyError, validateCheckpointInvocationFingerprint } from "../boundary-topology.js";
import { registerExecutionStorages } from "../execution-context-boundary.js";
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
import {
	type NON_SNAPSHOT_EVENT_TYPES,
	type RunJournalVersions,
	type RunSnapshotTail,
	type RunVersion,
	runJournalVersions,
} from "./internal.js";
import { isWorkflowLeaseExpired } from "./lease-expiry.js";
import { MemoryRunJournal } from "./memory-run-journal.js";
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
} from "./types.js";

const PROCESS_HOLDER_ID = randomUUID();
const CHANGE_APPEND_ATTEMPTS = 4;
const processExitCleanups = new Set<() => void>();

function runProcessExitCleanups(): void {
	for (const cleanup of processExitCleanups) cleanup();
}

function addProcessExitCleanup(cleanup: () => void): void {
	if (processExitCleanups.size === 0) process.once("exit", runProcessExitCleanups);
	processExitCleanups.add(cleanup);
}

function removeProcessExitCleanup(cleanup: () => void): void {
	if (processExitCleanups.delete(cleanup) && processExitCleanups.size === 0)
		process.off("exit", runProcessExitCleanups);
}
type Operation<T> = Generator<Promise<void>, T, void>;
type BackendState = "open" | "closing" | "closed";
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

/** The handle a snapshot event carries, as written: prompt events nest it beside their reservations. */
function writtenHandle(event: BackendEvent): JournalHandle | undefined {
	if (event.type === E.promptAsked || event.type === E.promptReleased) return event.payload.handle as JournalHandle;
	if (event.type === E.checkpointRecorded || event.type === E.messageSettled || event.type === E.messageDelivered)
		return undefined;
	return event.payload as JournalHandle;
}

function snapshotNeedsHistory(tail: RunSnapshotTail): boolean {
	const handle = writtenHandle(tail.snapshot.event as BackendEvent);
	return (
		handle !== undefined &&
		(handle.pendingStageMessageChange !== undefined || hasPendingStageDeliveryDelta(handle.pendingStageMessages))
	);
}

function* invoke<T>(action: () => Promise<T>): Operation<T> {
	try {
		const result = action();
		let value: T;
		yield result.then((resolved) => {
			value = resolved;
		});
		return value!;
	} catch (error) {
		if (error instanceof JournalError || error instanceof StorageError) throw error;
		throw new StorageUnavailableError(
			{ adapter: "custom", location: "custom journal" },
			error instanceof Error ? error : new Error(String(error)),
		);
	}
}

async function execute<T>(operation: Operation<T>): Promise<T> {
	let step = operation.next();
	while (!step.done) {
		try {
			await step.value;
			step = operation.next();
		} catch (error) {
			step = operation.throw(error);
		}
	}
	return step.value;
}

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
export class JournalExecutionRetiredError extends JournalError {
	constructor(readonly runId: string) {
		super(`Workflow execution for ${runId} is retired`);
		this.name = "JournalExecutionRetiredError";
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
interface WorkflowLeaseExecution {
	lease?: Lease;
	users: number;
	retired: boolean;
}

export class JournalDurableBackend<Journal extends RunJournal = RunJournal> implements DurableWorkflowBackend {
	readonly persistent: boolean;
	private readonly projection = createJournalProjection();
	private readonly sequences = new Map<string, number>();
	/** `at` of the event folded at `sequences`, so a run whose history was replaced is rebuilt, not extended. */
	private readonly foldedAt = new Map<string, number>();
	/**
	 * Runs whose handle came from their latest snapshot event without folding their history, with the journal
	 * version that snapshot was read at. Their checkpoints are read when the run is hydrated.
	 */
	private readonly summarized = new Map<string, RunVersion>();
	/** Journal change token at the last complete catalog hydration. */
	private catalogToken: string | undefined;
	private readonly leases = new Map<string, Lease>();
	private readonly executions = new Map<string, WorkflowLeaseExecution>();
	private readonly executionContext = new AsyncLocalStorage<ReadonlyMap<string, WorkflowLeaseExecution>>();
	private readonly pending = new Map<string | symbol, Promise<void>>();
	private readonly catalogQueue = Symbol("catalog");
	private readonly lost = new Map<string, Error>();
	private readonly prompts = new Map<string, PromptReservationState>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private state: BackendState = "open";
	private closing: Promise<void> | undefined;
	private renewing: Promise<void> | undefined;
	private readonly mutationContext = new AsyncLocalStorage<ReadonlySet<WorkflowLeaseExecution>>();
	private processExitCleanup: (() => void) | undefined;
	private readonly unregisterExecutionStorages = registerExecutionStorages(
		this.executionContext,
		this.mutationContext,
	);

	private constructor(
		readonly journal: Journal,
		readonly holderId = `${PROCESS_HOLDER_ID}:${randomUUID()}`,
		private readonly ownsJournal = true,
	) {
		this.persistent = !(journal instanceof MemoryRunJournal);
	}

	static async open<Journal extends RunJournal>(
		journal: Journal,
		options: { ownsJournal?: boolean; runs?: readonly string[] } = {},
	): Promise<JournalDurableBackend<Journal>> {
		let backend: JournalDurableBackend<Journal> | undefined;
		try {
			backend = new JournalDurableBackend(journal, undefined, options.ownsJournal ?? true);
			for (const runId of options.runs ?? (await journal.listRuns()).map((run) => run.runId))
				for await (const entry of journal.read(runId)) backend.fold(entry);
			return backend;
		} catch (error) {
			if (backend === undefined) {
				if (options.ownsJournal !== false) await journal.close();
			} else await backend.close();
			if (
				error instanceof JournalError ||
				error instanceof StorageError ||
				error instanceof DurableNestedTopologyError
			)
				throw error;
			throw new StorageUnavailableError(
				{ adapter: "custom", location: "custom journal" },
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	private serialize<T>(
		runId: string | symbol,
		action: () => Operation<T>,
		requiresActiveExecution = true,
	): Promise<T> {
		try {
			this.ensureOpen();
			if (requiresActiveExecution) this.assertExecutionActive();
		} catch (error) {
			return Promise.reject(error);
		}
		const admitted = new Set(
			[...(this.executionContext.getStore()?.values() ?? [])].filter((execution) => !execution.retired),
		);
		return this.enqueue(runId, action, admitted);
	}

	// Internal nested work inherits admission; public mutations must enter through serialize.
	private enqueue<T>(
		runId: string | symbol,
		action: () => Operation<T>,
		admitted = this.mutationContext.getStore() ?? new Set<WorkflowLeaseExecution>(),
	): Promise<T> {
		const prior = this.pending.get(runId) ?? Promise.resolve();
		const result = prior.then(() => this.mutationContext.run(admitted, () => execute(action())));
		const settled = result.then(
			() => {},
			() => {},
		);
		this.pending.set(runId, settled);
		void settled.then(() => {
			if (this.pending.get(runId) === settled) this.pending.delete(runId);
		});
		return result;
	}

	private fold(entry: JournalEntry): void {
		if (entry.seq <= (this.sequences.get(entry.runId) ?? 0)) return;
		const event = entry.event as BackendEvent;
		if (event.type === E.checkpointRecorded) {
			const checkpoint = event.payload;
			validateCheckpointInvocationFingerprint(checkpoint);
			this.projection.recordCheckpoint(checkpoint);
		} else if (event.type === E.messageSettled) {
			void this.projection.archivePendingStageMessage(entry.runId, event.payload.message);
		} else if (event.type === E.messageDelivered) {
			const payload = event.payload;
			void this.projection.archivePendingStageDeliveryReceipt(
				entry.runId,
				payload.messageId,
				payload.delivery,
				payload.accounting,
			);
		} else if (event.type === E.promptAsked || event.type === E.promptReleased) {
			this.projection.applyWorkflowSnapshot(
				decodeHandle(
					event.payload.handle as JournalHandle,
					this.projection.getWorkflow(entry.runId)?.pendingStageMessages,
				),
			);
			this.prompts.set(
				entry.runId,
				new PromptReservationState(event.payload.handle.pendingPrompts, event.payload.prompts),
			);
		} else {
			const previous = this.projection.getWorkflow(entry.runId);
			const handle = decodeHandle(event.payload as JournalHandle, previous?.pendingStageMessages);
			this.projection.applyWorkflowSnapshot(handle);
			if (event.type === E.runStarted || previous?.pendingPrompts !== handle.pendingPrompts)
				this.prompts.delete(entry.runId);
		}
		const handle = this.projection.getWorkflow(entry.runId);
		if (handle?.pendingStageMessages !== undefined) {
			const messages = handle.pendingStageMessages.map((message) => {
				if (message.sticky !== true) return message;
				const count = this.projection.getPendingStageMessageDeliveryCount(entry.runId, message.id, message.runId);
				return count > (message.deliveryCount ?? message.deliveries?.length ?? 0)
					? { ...message, deliveryCount: count }
					: message;
			});
			if (messages.some((message, index) => message !== handle.pendingStageMessages?.[index]))
				this.projection.applyWorkflowSnapshot({ ...handle, pendingStageMessages: messages });
		}
		this.sequences.set(entry.runId, entry.seq);
		this.foldedAt.set(entry.runId, entry.at);
	}
	/**
	 * Record a run's handle from its latest snapshot without folding its history. Each snapshot already counts
	 * the checkpoints before it, so the ones recorded after it are added and the last of them sets `updatedAt`,
	 * as folding them does. The run's checkpoints, prompt reservations and receipts are read when it is hydrated.
	 */
	private summarize(runId: string, tail: RunSnapshotTail): void {
		const event = tail.snapshot.event as Exclude<BackendEvent, { type: (typeof NON_SNAPSHOT_EVENT_TYPES)[number] }>;
		const handle =
			event.type === E.promptAsked || event.type === E.promptReleased ? event.payload.handle : event.payload;
		void this.projection.deleteWorkflow(runId);
		this.prompts.delete(runId);
		this.projection.applyWorkflowSnapshot({
			...handle,
			completedCheckpoints: handle.completedCheckpoints + tail.laterCheckpoints,
			...(tail.lastCheckpointAt === undefined ? {} : { updatedAt: tail.lastCheckpointAt }),
		});
		this.summarized.set(runId, tail.version);
	}

	private *entries(runId: string, fromSeq?: number): Operation<readonly JournalEntry[]> {
		return yield* invoke(async () => {
			const entries: JournalEntry[] = [];
			for await (const entry of this.journal.read(runId, fromSeq)) entries.push(entry);
			return entries;
		});
	}
	private *rebuild(runId: string): Operation<void> {
		const entries = yield* this.entries(runId);
		void this.projection.deleteWorkflow(runId);
		this.sequences.delete(runId);
		this.foldedAt.delete(runId);
		this.summarized.delete(runId);
		this.prompts.delete(runId);
		for (const entry of entries) this.fold(entry);
	}
	private *refresh(runId: string): Operation<void> {
		if (!this.leases.has(runId)) return yield* this.rebuild(runId);
		for (const entry of yield* this.entries(runId, (this.sequences.get(runId) ?? 0) + 1)) this.fold(entry);
	}
	private *current(runId: string): Operation<DurableWorkflowHandle | undefined> {
		this.ensureOpen();
		this.assertExecutionActive(true);
		yield* this.refresh(runId);
		if (this.projection.getWorkflow(runId) === undefined) return undefined;
		try {
			yield* this.ownership(runId);
		} catch (error) {
			if (!(error instanceof RunNotFoundError)) throw error;
			yield* this.rebuild(runId);
			return undefined;
		}
		yield* this.refresh(runId);
		return this.projection.getWorkflow(runId);
	}
	private ensureOpen(): void {
		if (this.state === "closed" || (this.state === "closing" && !this.mutationContext.getStore()))
			throw new JournalBackendClosedError();
	}
	private assertExecutionActive(admitted = false): void {
		for (const [executionRunId, execution] of this.executionContext.getStore() ?? [])
			if (execution.retired && !(admitted && this.mutationContext.getStore()?.has(execution)))
				throw new JournalExecutionRetiredError(executionRunId);
	}
	private *ownership(runId: string): Operation<Lease> {
		this.ensureOpen();
		this.assertExecutionActive(true);
		const lost = this.lost.get(runId);
		if (lost) throw lost;
		const existing = this.leases.get(runId);
		if (existing) return existing;
		const result = yield* invoke(() =>
			this.journal.takeoverExpired(runId, this.holderId, FOREIGN_LIVE_WORKFLOW_WINDOW_MS),
		);
		if (result.status === "held") throw new JournalOwnershipError(runId, result.holderId);
		this.leases.set(runId, result.lease);
		if (this.timer === undefined) {
			this.timer = setInterval(() => {
				void this.renewLeases().catch((error: Error) => console.error(error));
			}, STAGE_SESSION_HEARTBEAT_INTERVAL_MS);
			this.timer.unref();
		}
		const execution = this.executionContext.getStore()?.get(runId) ?? this.executions.get(runId);
		if (execution !== undefined) execution.lease = result.lease;
		yield* this.rebuild(runId);
		return result.lease;
	}
	private *mapOwnership(error: Error, runId: string): Operation<Error> {
		if (!(error instanceof StaleLeaseError)) return error;
		let failure = new JournalOwnershipError(runId, null, error);
		this.lost.set(runId, failure);
		try {
			const current = yield* invoke(() => this.journal.leaseState(runId));
			failure = new JournalOwnershipError(runId, current?.holderId ?? null, error);
			this.lost.set(runId, failure);
		} catch {
			// The stale fencing token already proves ownership loss; the current holder is best effort.
		}
		return failure;
	}
	/**
	 * Append an event. An event carrying the run's handle writes its pending-stage entries as a change to the
	 * entries folded at the run's current sequence, pinned to that sequence. When another writer appends first,
	 * the change is rebuilt on the entries folded at the new sequence, a bounded number of times, before the full
	 * entries are written instead. A caller that pinned the sequence itself gets the conflict (#3929).
	 */
	private *append(
		runId: string,
		event: BackendEvent,
		options?: { readonly key?: string; readonly expectSeq?: number },
	): Operation<void> {
		const lease = yield* this.ownership(runId);
		const pinned = options?.expectSeq;
		for (let attempt = 0; attempt < CHANGE_APPEND_ATTEMPTS; attempt++) {
			const base = this.sequences.get(runId);
			const encoded =
				base !== undefined && (pinned === undefined || pinned === base) && event.type !== E.runStarted
					? encodeHandleEvent(event, this.projection.getWorkflow(runId)?.pendingStageMessages)
					: undefined;
			if (encoded === undefined) break;
			try {
				return yield* this.write(runId, lease, encoded, { ...options, expectSeq: base });
			} catch (error) {
				if (!(error instanceof JournalCasConflictError) || pinned !== undefined) throw error;
			}
			for (const entry of yield* this.entries(runId, (this.sequences.get(runId) ?? 0) + 1)) this.fold(entry);
		}
		yield* this.write(runId, lease, event, options);
	}
	private *write(
		runId: string,
		lease: Lease,
		event: BackendEvent,
		options?: { readonly key?: string; readonly expectSeq?: number },
	): Operation<void> {
		try {
			const outcome = yield* invoke(() => this.journal.append(lease, event, options));
			const nextSeq = (this.sequences.get(runId) ?? 0) + 1;
			if (outcome.entry.seq > nextSeq) {
				for (const entry of yield* this.entries(runId, nextSeq)) this.fold(entry);
			}
			this.fold(outcome.entry);
		} catch (error) {
			if (error instanceof Error) throw yield* this.mapOwnership(error, runId);
			throw error;
		}
	}
	private *snapshot(
		handle: DurableWorkflowHandle,
		type:
			| typeof E.statusChanged
			| typeof E.runStarted
			| typeof E.messageQueued
			| typeof E.summaryRecorded = E.statusChanged,
		expectSeq?: number,
	): Operation<void> {
		yield* this.append(
			handle.workflowId,
			{ type, payload: handle },
			expectSeq === undefined ? undefined : { expectSeq },
		);
	}
	private *draft(runId: string): Operation<ReturnType<typeof createJournalProjection>> {
		const draft = createJournalProjection();
		const handle = yield* this.current(runId);
		if (handle) draft.registerWorkflow(handle, true);
		return draft;
	}

	commitWorkflowRegistration(input: WorkflowRegistrationInput): Promise<void> {
		return this.serialize(input.workflowId, () => this.register(input));
	}
	private *register(input: WorkflowRegistrationInput): Operation<void> {
		this.assertExecutionActive(true);
		this.ensureOpen();
		const header = {
			runId: input.workflowId,
			name: input.name,
			cwd: input.invocationCwd ?? process.cwd(),
			createdAt: input.createdAt,
			status: input.status,
			inputs: input.inputs,
		};
		yield* invoke(() => this.journal.createRun(header));
		yield* this.ownership(input.workflowId);
		yield* this.refresh(input.workflowId);
		const draft = yield* this.draft(input.workflowId);
		draft.registerWorkflow(input, true);
		yield* this.snapshot(
			draft.getWorkflow(input.workflowId)!,
			this.sequences.has(input.workflowId) ? E.statusChanged : E.runStarted,
		);
	}
	commitCheckpoint(checkpoint: DurableCheckpoint, options?: { readonly signal?: AbortSignal }): Promise<void> {
		if (options?.signal?.aborted)
			return Promise.reject(
				new JournalOperationAbortedError(
					checkpoint.workflowId,
					options.signal.reason instanceof Error ? options.signal.reason : undefined,
				),
			);
		return this.serialize(checkpoint.workflowId, () => this.checkpoint(checkpoint));
	}
	private *checkpoint(checkpoint: DurableCheckpoint): Operation<void> {
		validateCheckpointInvocationFingerprint(checkpoint);
		if (!(yield* this.current(checkpoint.workflowId))) return;
		yield* this.append(
			checkpoint.workflowId,
			{ type: E.checkpointRecorded, payload: checkpoint },
			{
				key: JSON.stringify([E.checkpointRecorded, checkpoint.kind, checkpoint.checkpointId]),
			},
		);
	}
	async commitAdditiveCheckpointBestEffort(checkpoint: DurableCheckpoint): Promise<boolean> {
		try {
			await this.commitCheckpoint(checkpoint);
			return true;
		} catch (error) {
			if (!(error instanceof StorageUnavailableError)) throw error;
			return false;
		}
	}
	workflowOwnership(runId: string): Promise<"local" | "foreign" | "available"> {
		return this.serialize(runId, () => this.probeOwnership(runId), false);
	}
	private *probeOwnership(runId: string): Operation<"local" | "foreign" | "available"> {
		this.ensureOpen();
		const lease = yield* invoke(() => this.journal.leaseState(runId));
		if (lease === undefined || isWorkflowLeaseExpired(0, FOREIGN_LIVE_WORKFLOW_WINDOW_MS, lease.ageMs))
			return "available";
		return lease.holderId === this.holderId ? "local" : "foreign";
	}
	commitWorkflowStatus(
		runId: string,
		status: DurableWorkflowStatus,
		pendingPrompts?: number,
		resumable?: boolean,
		failure?: DurableWorkflowFailureMetadata,
	): Promise<void> {
		return this.serialize(runId, () => this.setStatus(runId, status, pendingPrompts, resumable, failure));
	}
	private *setStatus(
		runId: string,
		status: DurableWorkflowStatus,
		pendingPrompts?: number,
		resumable?: boolean,
		failure?: DurableWorkflowFailureMetadata,
	): Operation<void> {
		const draft = yield* this.draft(runId);
		draft.setWorkflowStatus(runId, status, pendingPrompts, resumable, failure);
		const handle = draft.getWorkflow(runId);
		if (handle) yield* this.snapshot(handle);
	}
	async commitWorkflowStatusTransition(
		runId: string,
		expected: readonly DurableWorkflowStatus[],
		status: DurableWorkflowStatus,
		pendingPrompts?: number,
		resumable?: boolean,
		expectedUpdatedAt?: number,
		modelOwner?: string,
		releasedModelOwner?: string,
	): Promise<boolean> {
		return await this.serialize(runId, () =>
			this.transition(
				runId,
				expected,
				status,
				pendingPrompts,
				resumable,
				expectedUpdatedAt,
				modelOwner,
				releasedModelOwner,
			),
		);
	}
	private *transition(
		runId: string,
		expected: readonly DurableWorkflowStatus[],
		status: DurableWorkflowStatus,
		pendingPrompts?: number,
		resumable?: boolean,
		expectedUpdatedAt?: number,
		modelOwner?: string,
		releasedModelOwner?: string,
	): Operation<boolean> {
		yield* this.refresh(runId);
		const current = this.projection.getWorkflow(runId);
		if (
			!current ||
			!expected.includes(current.status) ||
			(expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt)
		)
			return false;
		const draft = yield* this.draft(runId);
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
			yield* this.snapshot(
				{
					...handle,
					...(modelOwner !== undefined ? { modelOwner } : {}),
					...(releasedModelOwner !== undefined ? { releasedModelOwner } : {}),
				},
				E.statusChanged,
				seq,
			);
			if (releasedModelOwner !== undefined) yield* this.release(runId);
			return true;
		} catch (error) {
			if (error instanceof JournalCasConflictError) {
				yield* this.refresh(runId);
				return false;
			}
			throw error;
		}
	}
	private *promptChange<T>(
		runId: string,
		type: typeof E.promptAsked | typeof E.promptReleased,
		change: (state: PromptReservationState) => T,
		skipUnchanged = false,
	): Operation<T | undefined> {
		const handle = yield* this.current(runId);
		if (!handle) return undefined;
		const state = new PromptReservationState(handle.pendingPrompts, this.prompts.get(runId)?.snapshot());
		const before = skipUnchanged ? JSON.stringify(state.snapshot()) : undefined;
		const result = change(state);
		if (before !== undefined && before === JSON.stringify(state.snapshot())) return result;
		yield* this.append(runId, {
			type,
			payload: {
				handle: { ...handle, pendingPrompts: state.pendingPrompts, updatedAt: Date.now() },
				prompts: state.snapshot(),
			},
		});
		return result;
	}
	commitPendingPromptAdjustment(runId: string, delta: number): Promise<void> {
		return this.serialize(runId, () =>
			this.promptChange(runId, delta >= 0 ? E.promptAsked : E.promptReleased, (state) => state.adjust(delta)),
		);
	}
	promptReservationScope(runId: string) {
		return { rootWorkflowId: runId, scope: "root" };
	}
	pendingPromptToken(runId: string, reservationId: string): Promise<PromptReservationToken | undefined> {
		return this.serialize(runId, () =>
			this.promptChange(runId, E.promptAsked, (state) => state.claim(reservationId), true),
		);
	}
	reservePendingPrompt(runId: string, reservationId: string): Promise<PromptReservationToken> {
		return this.serialize(runId, () => this.reserve(runId, reservationId));
	}
	private *reserve(runId: string, reservationId: string): Operation<PromptReservationToken> {
		return (
			(yield* this.promptChange(runId, E.promptAsked, (state) => state.reserve(reservationId))) ??
			inactivePromptReservationToken(reservationId)
		);
	}
	releasePendingPrompt(runId: string, reservationId: string, token: PromptReservationToken): Promise<void> {
		return this.serialize(runId, () =>
			this.promptChange(runId, E.promptReleased, (state) => state.release(reservationId, token)),
		);
	}
	async persistSummary(runId: string, summary: string, summarizedThrough: number): Promise<boolean> {
		return await this.serialize(runId, () => this.summary(runId, summary, summarizedThrough));
	}
	private *summary(runId: string, summary: string, summarizedThrough: number): Operation<boolean> {
		const handle = yield* this.current(runId);
		if (!handle || (handle.summarizedThrough ?? -Infinity) > summarizedThrough) return false;
		yield* this.snapshot({ ...handle, summary, summarizedThrough }, E.summaryRecorded);
		return true;
	}
	async persistPendingStageMessages(
		runId: string,
		messages: readonly PendingStageMessage[],
		logicalRunId = runId,
	): Promise<boolean> {
		return await this.serialize(runId, () => this.messages(runId, messages, logicalRunId));
	}
	private *messages(
		runId: string,
		messages: readonly PendingStageMessage[],
		logicalRunId: string,
	): Operation<boolean> {
		const handle = yield* this.current(runId);
		if (!handle) return false;
		for (const message of messages)
			if (message.runId !== logicalRunId) throw new JournalMessageScopeError(logicalRunId, message.runId);
		const next: DurableWorkflowHandle = {
			...handle,
			pendingStageMessages: replacePendingStageMessagesForRun(
				handle.pendingStageMessages ?? [],
				logicalRunId,
				messages,
			),
			updatedAt: Math.max(Date.now(), handle.updatedAt + 1),
		};
		yield* this.snapshot(next, E.messageQueued);
		return true;
	}
	async archivePendingStageMessage(runId: string, message: PendingStageMessage): Promise<void> {
		await this.serialize(runId, () =>
			this.append(
				runId,
				{ type: E.messageSettled, payload: { message } },
				{ key: JSON.stringify([E.messageSettled, message.runId, message.id]) },
			),
		);
	}
	async archivePendingStageDeliveryReceipt(
		runId: string,
		messageId: string,
		delivery: PendingStageMessageDelivery,
		accounting?: { readonly messageRunId: string; readonly deliveryCount: number },
	): Promise<void> {
		await this.serialize(runId, () =>
			this.append(runId, {
				type: E.messageDelivered,
				payload: { messageId, delivery, ...(accounting === undefined ? {} : { accounting }) },
			}),
		);
	}

	getToolOutput(...args: Parameters<DurableWorkflowBackend["getToolOutput"]>) {
		return this.projection.getToolOutput(...args);
	}
	getToolCheckpoint(...args: Parameters<DurableWorkflowBackend["getToolCheckpoint"]>) {
		return this.projection.getToolCheckpoint(...args);
	}
	getUiResponse(...args: Parameters<DurableWorkflowBackend["getUiResponse"]>) {
		return this.projection.getUiResponse(...args);
	}
	getStageOutput(...args: Parameters<DurableWorkflowBackend["getStageOutput"]>) {
		return this.projection.getStageOutput(...args);
	}
	getStageSession(...args: Parameters<DurableWorkflowBackend["getStageSession"]>) {
		return this.projection.getStageSession(...args);
	}
	listCheckpoints(runId: string) {
		return this.projection.listCheckpoints(runId);
	}
	getWorkflow(runId: string) {
		return this.projection.getWorkflow(runId);
	}
	getLoadableWorkflow(runId: string) {
		return this.projection.getLoadableWorkflow(runId);
	}
	listResumableWorkflows() {
		return this.projection.listResumableWorkflows();
	}
	listCompletedWorkflows() {
		return this.projection.listCompletedWorkflows();
	}
	toMetadata(runId: string) {
		return this.projection.toMetadata(runId);
	}
	isWorkflowLoadable(runId: string) {
		return this.projection.isWorkflowLoadable(runId);
	}
	readSettledPendingStageMessage(
		...args: Parameters<NonNullable<DurableWorkflowBackend["readSettledPendingStageMessage"]>>
	) {
		return this.projection.readSettledPendingStageMessage(...args);
	}
	getPendingStageMessageDeliveryCount(
		...args: Parameters<NonNullable<DurableWorkflowBackend["getPendingStageMessageDeliveryCount"]>>
	) {
		return this.projection.getPendingStageMessageDeliveryCount(...args);
	}
	pendingStageDeliveryCountVersion(runId: string): number {
		return this.projection.pendingStageDeliveryCountVersion(runId);
	}
	hasPendingStageDeliveryReceipt(
		...args: Parameters<NonNullable<DurableWorkflowBackend["hasPendingStageDeliveryReceipt"]>>
	) {
		return this.projection.hasPendingStageDeliveryReceipt(...args);
	}
	hasCachedPendingStageDeliveryReceipt(
		...args: Parameters<NonNullable<DurableWorkflowBackend["hasCachedPendingStageDeliveryReceipt"]>>
	) {
		return this.projection.hasCachedPendingStageDeliveryReceipt(...args);
	}

	async readPendingStageMessageDeliveryCount(runId: string, messageId: string, logicalRunId = runId): Promise<number> {
		return this.getPendingStageMessageDeliveryCount(runId, messageId, logicalRunId);
	}
	async hydrateWorkflow(runId: string): Promise<void> {
		await this.serialize(runId, () => this.rebuild(runId), false);
	}
	async catchUpWorkflow(runId: string): Promise<void> {
		await this.serialize(runId, () => this.extend(runId), false);
	}
	/**
	 * Brings every run up to date for the resume catalog. With a versioned journal an unchanged store is
	 * detected from one token read, and otherwise only runs whose latest event moved are read: appended
	 * events are folded onto a hydrated run, a run that is not hydrated is summarized again from its latest
	 * snapshot, and a run whose history was replaced or removed is rebuilt. Ownership is never cached here;
	 * resume checks the lease when an entry is selected.
	 */
	hydrateResumableWorkflows(): Promise<void> {
		return this.serialize(this.catalogQueue, () =>
			invoke(async () => {
				const journal = runJournalVersions(this.journal);
				if (journal === undefined) {
					const runs = await this.journal.listRuns();
					for (const runId of new Set([...this.sequences.keys(), ...runs.map((run) => run.runId)]))
						await this.hydrateWorkflow(runId);
					return;
				}
				// Read the token first: a commit racing the version read moves it again before the next call.
				const token = await journal.changeToken();
				if (token === this.catalogToken) return;
				const versions = await journal.runVersions();
				for (const runId of new Set([...this.sequences.keys(), ...this.summarized.keys(), ...versions.keys()]))
					await this.serialize(runId, () => this.catchUp(runId, versions.get(runId), journal), false);
				this.catalogToken = token;
			}),
		);
	}
	private *catchUp(runId: string, version: RunVersion | undefined, journal: RunJournalVersions): Operation<void> {
		const folded = this.sequences.get(runId) ?? 0;
		if (folded === 0 && version !== undefined) {
			const summarized = this.summarized.get(runId);
			if (summarized !== undefined && summarized.seq === version.seq && summarized.at === version.at) return;
			const tail = yield* invoke(() => journal.snapshotTail(runId));
			// A snapshot holding delivery changes needs the events before it, so the run is read in full.
			if (tail !== undefined && !snapshotNeedsHistory(tail)) return this.summarize(runId, tail);
			if (summarized === undefined && version.seq === 0) return;
			return yield* this.rebuild(runId);
		}
		if (version !== undefined && version.seq === folded && version.at === (this.foldedAt.get(runId) ?? 0)) return;
		if (version !== undefined && folded > 0 && version.seq > folded) return yield* this.extend(runId);
		yield* this.rebuild(runId);
	}
	private *extend(runId: string): Operation<void> {
		const folded = this.sequences.get(runId) ?? 0;
		if (folded > 0) {
			const entries = yield* this.entries(runId, folded);
			if (entries[0]?.seq === folded && entries[0].at === this.foldedAt.get(runId)) {
				for (const entry of entries) this.fold(entry);
				return;
			}
		}
		yield* this.rebuild(runId);
	}
	async prepareWorkflowCatalog() {
		await this.hydrateResumableWorkflows();
		return this.projection.prepareWorkflowCatalog();
	}
	private *deleteOwned(runId: string, expectSeq?: number): Operation<void> {
		try {
			const lease = yield* this.ownership(runId);
			yield* invoke(() => this.journal.deleteOwnedRun(lease, expectSeq));
		} catch (error) {
			if (!(error instanceof RunNotFoundError)) {
				if (error instanceof Error) throw yield* this.mapOwnership(error, runId);
				throw error;
			}
		}
		this.leases.delete(runId);
		this.sequences.delete(runId);
		this.foldedAt.delete(runId);
		this.summarized.delete(runId);
		this.prompts.delete(runId);
		void this.projection.deleteWorkflow(runId);
	}
	async deleteWorkflow(runId: string): Promise<void> {
		await this.serialize(runId, () => this.deleteOwned(runId));
	}
	async deleteWorkflowIfInactive(runId: string) {
		return await this.serialize(runId, () => this.deleteInactive(runId));
	}
	private *deleteInactive(
		runId: string,
	): Operation<{ readonly ok: true } | { readonly ok: false; readonly reason: "not_found" | "running" }> {
		for (;;) {
			yield* this.refresh(runId);
			const handle = this.projection.getWorkflow(runId);
			if (!handle) return { ok: false, reason: "not_found" };
			if (handle.status === "running") return { ok: false, reason: "running" };
			const acquired = yield* this.current(runId);
			if (!acquired) return { ok: false, reason: "not_found" };
			if (acquired.status === "running") return { ok: false, reason: "running" };
			try {
				yield* this.deleteOwned(runId, this.sequences.get(runId) ?? 0);
				return { ok: true };
			} catch (error) {
				if (!(error instanceof JournalCasConflictError)) throw error;
			}
		}
	}
	commitReset(): Promise<void> {
		return this.serialize(this.catalogQueue, () => this.resetJournal());
	}
	private *resetJournal(): Operation<void> {
		const runIds = new Set(this.sequences.keys());
		const runs = yield* invoke(() => this.journal.listRuns());
		for (const run of runs) runIds.add(run.runId);
		for (const runId of runIds) yield this.enqueue(runId, () => this.deleteOwned(runId));
	}
	private renewLeases(): Promise<void> {
		if (this.renewing !== undefined) return this.renewing;
		if (this.state !== "open") return Promise.resolve();
		this.renewing = this.renewOwnedLeases().finally(() => {
			this.renewing = undefined;
		});
		return this.renewing;
	}
	private async renewOwnedLeases(): Promise<void> {
		for (const [runId, lease] of this.leases) {
			if (this.state !== "open") return;
			try {
				await this.serialize(runId, () => this.renewLease(runId, lease), false);
			} catch (error) {
				if (error instanceof Error) this.lost.set(runId, error);
				this.dropLease(runId);
			}
		}
	}
	private *renewLease(runId: string, lease: Lease): Operation<void> {
		if (this.leases.get(runId) !== lease || this.lost.has(runId)) return;
		try {
			yield* invoke(() => this.journal.renew(lease));
		} catch (error) {
			if (this.leases.get(runId) === lease) {
				if (error instanceof Error) this.lost.set(runId, yield* this.mapOwnership(error, runId));
				this.dropLease(runId);
			}
		}
	}
	closeOnProcessExit(): void {
		this.ensureOpen();
		if (this.processExitCleanup !== undefined) return;
		this.processExitCleanup = () => {
			void this.close().catch((error: Error) => {
				console.error(error);
				process.exitCode = 1;
			});
		};
		addProcessExitCleanup(this.processExitCleanup);
	}
	async withWorkflowLease<T>(runId: string, action: () => Promise<T>): Promise<T> {
		this.ensureOpen();
		this.assertExecutionActive();
		const context = this.executionContext.getStore();
		const active = this.executions.get(runId);
		if (active !== undefined && context?.get(runId) !== active) throw new JournalOwnershipError(runId, this.holderId);
		const execution = active ?? { lease: this.leases.get(runId), users: 0, retired: false };
		execution.users++;
		this.executions.set(runId, execution);
		const ownedContext = new Map<string, WorkflowLeaseExecution>();
		ownedContext.set(runId, execution);
		try {
			return await this.executionContext.run(ownedContext, action);
		} finally {
			if (--execution.users === 0) await this.retireExecution(runId, execution);
		}
	}
	captureWorkflowRetirement(runId: string): () => void | Promise<void> {
		const execution = this.executionContext.getStore()?.get(runId);
		return () => {
			if (execution !== undefined) return this.retireExecution(runId, execution);
		};
	}
	private retireExecution(runId: string, execution: WorkflowLeaseExecution): void | Promise<void> {
		if (execution.retired) return;
		execution.retired = true;
		if (this.executions.get(runId) === execution) this.executions.delete(runId);
		if (this.state !== "open") return this.closing;
		return this.serialize(runId, () => this.release(runId, execution), false);
	}
	releaseWorkflow(runId: string): Promise<void> {
		this.assertExecutionActive();
		return this.serialize(runId, () => this.release(runId));
	}
	private *release(runId: string, execution?: WorkflowLeaseExecution): Operation<void> {
		const lease = this.leases.get(runId);
		if (lease === undefined || (execution !== undefined && execution.lease !== lease)) return;
		try {
			yield* invoke(() => this.journal.release(lease));
		} catch (error) {
			if (!(error instanceof StaleLeaseError)) throw error;
		} finally {
			this.dropLease(runId);
		}
	}
	private dropLease(runId: string): void {
		this.leases.delete(runId);
		if (this.leases.size === 0) {
			if (this.timer !== undefined) clearInterval(this.timer);
			this.timer = undefined;
		}
	}
	close(): Promise<void> {
		if (this.closing !== undefined) return this.closing;
		this.state = "closing";
		if (this.processExitCleanup !== undefined) {
			removeProcessExitCleanup(this.processExitCleanup);
			this.processExitCleanup = undefined;
		}
		if (this.timer !== undefined) clearInterval(this.timer);
		this.timer = undefined;
		this.closing = this.drainAndClose();
		return this.closing;
	}
	private async drainAndClose(): Promise<void> {
		try {
			await this.renewing;
			while (this.pending.size > 0) await Promise.all(this.pending.values());
			for (const runId of this.leases.keys()) await execute(this.release(runId));
		} finally {
			if (this.timer !== undefined) clearInterval(this.timer);
			this.timer = undefined;
			this.state = "closed";
			this.unregisterExecutionStorages();
			if (this.ownsJournal) await execute(invoke(() => this.journal.close()));
		}
	}
}

/**
 * A sticky entry's deliveries written as a change to the same entry in the run's previous event: drop these
 * indexes of the previous deliveries, then append `add`. Recording a delivery then costs the delivery, not
 * every live delivery again (#3920).
 */
interface PendingStageDeliveryDelta {
	readonly drop?: readonly number[];
	readonly add: readonly PendingStageMessageDelivery[];
}
type DeltaEncodedMessage = Omit<PendingStageMessage, "deliveries"> & {
	readonly deliveryDelta: PendingStageDeliveryDelta;
};
type JournalPendingStageMessage = PendingStageMessage | DeltaEncodedMessage;

/** Identities, kept per object like `entryJson`: an entry's run and id never change. */
const entryIdentity = new WeakMap<Pick<PendingStageMessage, "runId" | "id">, string>();
function identity(message: Pick<PendingStageMessage, "runId" | "id">): string {
	let key = entryIdentity.get(message);
	if (key === undefined) {
		key = JSON.stringify([message.runId, message.id]);
		entryIdentity.set(message, key);
	}
	return key;
}

/** Entries whose identity occurs once; a duplicated identity cannot name its base unambiguously. */
function uniqueByIdentity<Message extends Pick<PendingStageMessage, "runId" | "id">>(
	messages: readonly Message[],
): Map<string, Message> {
	const result = new Map<string, Message>();
	const repeated = new Set<string>();
	for (const message of messages) {
		const key = identity(message);
		if (result.has(key)) repeated.add(key);
		result.set(key, message);
	}
	for (const key of repeated) result.delete(key);
	return result;
}

function isDeltaEncoded(message: JournalPendingStageMessage): message is DeltaEncodedMessage {
	return (message as Partial<DeltaEncodedMessage>).deliveryDelta !== undefined;
}

/** `base`'s deliveries changed into `deliveries`: drop these indexes of the base, then append `add`. */
function deliveryDelta(
	base: readonly PendingStageMessageDelivery[],
	deliveries: readonly PendingStageMessageDelivery[],
): PendingStageDeliveryDelta {
	const drop: number[] = [];
	let kept = 0;
	base.forEach((delivery, index) => {
		if (kept < deliveries.length && JSON.stringify(delivery) === JSON.stringify(deliveries[kept])) kept++;
		else drop.push(index);
	});
	const add = deliveries.slice(kept);
	return drop.length === 0 ? { add } : { drop, add };
}

type PendingStageField = keyof PendingStageMessage;
/** The fields a pending-stage entry may omit, the only ones a patch can remove. */
type OptionalPendingStageField = {
	[K in PendingStageField]-?: undefined extends PendingStageMessage[K] ? K : never;
}[PendingStageField];
type MutablePendingStageMessage = { -readonly [K in keyof PendingStageMessage]: PendingStageMessage[K] };
type PendingStageMessageFields = { -readonly [K in PendingStageField]?: PendingStageMessage[K] };

/**
 * An entry written as a change to the previous entry at index `patch`: the fields it sets and removes, and
 * its deliveries as a change to that entry's deliveries.
 */
interface PatchedPendingStageMessage {
	readonly patch: number;
	readonly set?: Readonly<PendingStageMessageFields>;
	readonly unset?: readonly OptionalPendingStageField[];
	readonly deliveryDelta?: PendingStageDeliveryDelta;
}

function pendingStageFields(message: PendingStageMessage): PendingStageField[] {
	return Object.keys(message) as PendingStageField[];
}

function copyField<K extends PendingStageField>(
	target: PendingStageMessageFields,
	source: PendingStageMessage,
	key: K,
): void {
	target[key] = source[key];
}

/** Whether `key` is absent from `message`; an absent field is necessarily optional. */
function isRemovedField(message: PendingStageMessage, key: PendingStageField): key is OptionalPendingStageField {
	return message[key] === undefined;
}

/**
 * A run's pending-stage entries written as a change to the entries folded before the event: `[start, count]`
 * reuses that run of the previous entries unchanged, a `patch` item changes one previous entry, and any other
 * item is an entry written in full. Queueing, settling or updating one entry then costs that change, not every
 * pending entry again (#3929).
 */
type PendingStageListItem = readonly [start: number, count: number] | PatchedPendingStageMessage | PendingStageMessage;
type JournalHandle = Omit<DurableWorkflowHandle, "pendingStageMessages"> & {
	readonly pendingStageMessages?: readonly JournalPendingStageMessage[];
	readonly pendingStageMessageChange?: readonly PendingStageListItem[];
};

/** Serialized entries, kept per object: unchanged entries keep their objects from event to event. */
const entryJson = new WeakMap<PendingStageMessage, string>();
function json(message: PendingStageMessage): string {
	let text = entryJson.get(message);
	if (text === undefined) {
		text = JSON.stringify(message);
		entryJson.set(message, text);
	}
	return text;
}

function patchEntry(
	index: number,
	base: PendingStageMessage,
	message: PendingStageMessage,
): PatchedPendingStageMessage {
	const set: PendingStageMessageFields = {};
	const unset = pendingStageFields(base).filter(
		(key): key is OptionalPendingStageField => base[key] !== undefined && isRemovedField(message, key),
	);
	for (const key of pendingStageFields(message)) {
		if (message[key] === undefined || key === "deliveries") continue;
		if (JSON.stringify(message[key]) !== JSON.stringify(base[key])) copyField(set, message, key);
	}
	let delta: PendingStageDeliveryDelta | undefined;
	if (message.deliveries !== undefined) {
		if (base.deliveries === undefined) set.deliveries = message.deliveries;
		else if (JSON.stringify(base.deliveries) !== JSON.stringify(message.deliveries))
			delta = deliveryDelta(base.deliveries, message.deliveries);
	}
	return {
		patch: index,
		...(Object.keys(set).length === 0 ? {} : { set }),
		...(unset.length === 0 ? {} : { unset }),
		...(delta === undefined ? {} : { deliveryDelta: delta }),
	};
}

function encodePendingStageList(
	previous: readonly PendingStageMessage[],
	next: readonly PendingStageMessage[],
): readonly PendingStageListItem[] | undefined {
	const positions = new Map<string, number>();
	const repeated = new Set<string>();
	previous.forEach((message, index) => {
		const key = identity(message);
		if (positions.has(key)) repeated.add(key);
		positions.set(key, index);
	});
	for (const key of repeated) positions.delete(key);
	const items: (PendingStageListItem | [number, number])[] = [];
	let reused = 0;
	for (const message of next) {
		const index = positions.get(identity(message));
		const base = index === undefined ? undefined : previous[index]!;
		if (base === undefined) {
			items.push(message);
			continue;
		}
		reused++;
		const patched = base === message || json(base) === json(message) ? undefined : patchEntry(index!, base, message);
		if (patched === undefined || Object.keys(patched).length === 1) {
			const last = items.at(-1);
			if (Array.isArray(last) && last[0] + last[1] === index) last[1]++;
			else items.push([index!, 1]);
			continue;
		}
		items.push(JSON.stringify(patched).length < json(message).length ? patched : message);
	}
	return reused > 0 ? items : undefined;
}

function decodePendingStageList(
	previous: readonly PendingStageMessage[],
	items: readonly PendingStageListItem[],
): readonly PendingStageMessage[] {
	const base = (index: number): PendingStageMessage => {
		if (!Number.isInteger(index) || index < 0 || index >= previous.length)
			throw new Error(`atomic-workflows: journal pending-stage change names missing entry ${index}`);
		return previous[index]!;
	};
	const result: PendingStageMessage[] = [];
	for (const item of items) {
		if (Array.isArray(item)) {
			const [start, count] = item as readonly [number, number];
			for (let index = start; index < start + count; index++) result.push(base(index));
		} else if (typeof (item as Partial<PatchedPendingStageMessage>).patch === "number") {
			const { patch, set, unset, deliveryDelta: delta } = item as PatchedPendingStageMessage;
			const entry: MutablePendingStageMessage = { ...base(patch), ...set };
			for (const key of unset ?? []) delete entry[key];
			if (delta !== undefined) {
				const dropped = new Set(delta.drop ?? []);
				const deliveries = base(patch).deliveries ?? [];
				entry.deliveries = [...deliveries.filter((_, index) => !dropped.has(index)), ...delta.add];
			}
			result.push(entry);
		} else result.push(item as PendingStageMessage);
	}
	return result;
}

/** The event with its handle's pending-stage entries written as a change, or undefined to write it in full. */
function encodeHandleEvent(
	event: BackendEvent,
	previous: readonly PendingStageMessage[] | undefined,
): BackendEvent | undefined {
	const handle = writtenHandle(event) as DurableWorkflowHandle | undefined;
	if (handle?.pendingStageMessages === undefined || previous === undefined) return undefined;
	const change = encodePendingStageList(previous, handle.pendingStageMessages);
	if (change === undefined) return undefined;
	const { pendingStageMessages: _full, ...rest } = handle;
	const encoded = { ...rest, pendingStageMessageChange: change };
	if (event.type === E.promptAsked || event.type === E.promptReleased)
		return { ...event, payload: { ...event.payload, handle: encoded } } as BackendEvent;
	return { ...event, payload: encoded } as BackendEvent;
}

/** The full handle from an event's handle and the run's entries before that event. */
function decodeHandle(
	handle: JournalHandle,
	previous: readonly PendingStageMessage[] | undefined,
): DurableWorkflowHandle {
	const { pendingStageMessageChange: change, ...rest } = handle;
	if (change !== undefined)
		return { ...rest, pendingStageMessages: decodePendingStageList(previous ?? [], change) } as DurableWorkflowHandle;
	// Journals written before #3929 hold full entries, possibly with delivery changes (#3920).
	if (!hasPendingStageDeliveryDelta(handle.pendingStageMessages)) return handle as DurableWorkflowHandle;
	return {
		...handle,
		pendingStageMessages: decodePendingStageDeliveries(previous ?? [], handle.pendingStageMessages ?? []),
	} as DurableWorkflowHandle;
}

/** Rebuild full entries from an event's entries and the run's entries before that event. */
function decodePendingStageDeliveries(
	previous: readonly PendingStageMessage[],
	messages: readonly JournalPendingStageMessage[],
): readonly PendingStageMessage[] {
	if (!messages.some(isDeltaEncoded)) return messages as readonly PendingStageMessage[];
	const bases = uniqueByIdentity(previous);
	return messages.map((message) => {
		if (!isDeltaEncoded(message)) return message;
		const base = bases.get(identity(message))?.deliveries;
		if (base === undefined)
			throw new Error(`atomic-workflows: journal delivery change for ${identity(message)} has no base entry`);
		const { deliveryDelta, ...rest } = message;
		const dropped = new Set(deliveryDelta.drop ?? []);
		return { ...rest, deliveries: [...base.filter((_, index) => !dropped.has(index)), ...deliveryDelta.add] };
	});
}

/** Whether an event's entries need the run's earlier events to be read. */
function hasPendingStageDeliveryDelta(messages: readonly JournalPendingStageMessage[] | undefined): boolean {
	return messages?.some(isDeltaEncoded) === true;
}
