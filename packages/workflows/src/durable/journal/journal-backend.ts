import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
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
import { DurableNestedTopologyError } from "../boundary-topology.js";
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
import { type SynchronousRunJournal, synchronousJournal } from "./internal.js";
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
const DEFER_REBUILD = Symbol("defer-rebuild");
type Operation<T> = Generator<Promise<void>, T, void>;
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

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
	return typeof (value as Promise<T> | undefined)?.then === "function";
}

function* invoke<T>(action: () => T | Promise<T>, synchronous = false): Operation<T> {
	try {
		const result = action();
		if (synchronous) return result as T;
		let value: T;
		yield Promise.resolve(result).then((resolved) => {
			value = resolved;
		});
		return value!;
	} catch (error) {
		if (error instanceof JournalError) throw error;
		throw new StorageUnavailableError("custom journal", error instanceof Error ? error : new Error(String(error)));
	}
}

function execute<T>(operation: Operation<T>, step = operation.next()): T | Promise<T> {
	if (step.done) return step.value;
	return step.value.then(
		() => execute(operation),
		(error: Error) => execute(operation, operation.throw(error)),
	);
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
	private readonly synchronous: SynchronousRunJournal | undefined;
	private readonly sequences = new Map<string, number>();
	private readonly leases = new Map<string, Lease>();
	private readonly executions = new Map<string, WorkflowLeaseExecution>();
	private readonly executionContext = new AsyncLocalStorage<ReadonlyMap<string, WorkflowLeaseExecution>>();
	private readonly pending = new Map<string, Promise<void>>();
	private readonly lost = new Map<string, Error>();
	private readonly prompts = new Map<string, PromptReservationState>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private closed = false;
	private processExitCleanup: (() => void) | undefined;

	constructor(
		readonly journal: Journal,
		readonly holderId = `${PROCESS_HOLDER_ID}:${randomUUID()}`,
		rebuild?: typeof DEFER_REBUILD,
		private readonly ownsJournal = true,
	) {
		this.synchronous = synchronousJournal(journal);
		this.persistent = !(journal instanceof MemoryRunJournal);
		if (rebuild !== DEFER_REBUILD && this.synchronous !== undefined)
			for (const run of this.synchronous.listRunsSync()) execute(this.refresh(run.runId));
	}

	static async open<Journal extends RunJournal>(
		journal: Journal,
		options: { ownsJournal?: boolean } = {},
	): Promise<JournalDurableBackend<Journal>> {
		let backend: JournalDurableBackend<Journal> | undefined;
		try {
			backend = new JournalDurableBackend(journal, undefined, DEFER_REBUILD, options.ownsJournal ?? true);
			for (const run of await journal.listRuns())
				for await (const entry of journal.read(run.runId)) backend.fold(entry);
			return backend;
		} catch (error) {
			if (backend === undefined) {
				if (options.ownsJournal !== false) await journal.close();
			} else await backend.close();
			if (error instanceof JournalError || error instanceof DurableNestedTopologyError) throw error;
			throw new StorageUnavailableError("custom journal", error instanceof Error ? error : new Error(String(error)));
		}
	}

	private serialize<T>(runId: string, action: () => Operation<T>): T | Promise<T> {
		const prior = this.pending.get(runId);
		if (prior !== undefined) return prior.then(() => this.serialize(runId, action));
		const result = execute(action());
		if (!isPromise(result)) return result;
		const settled = result.then(
			() => {},
			() => {},
		);
		this.pending.set(runId, settled);
		return result.finally(() => {
			if (this.pending.get(runId) === settled) this.pending.delete(runId);
		});
	}

	private fold(entry: JournalEntry): void {
		const event = entry.event as BackendEvent;
		if (event.type === E.checkpointRecorded) {
			const checkpoint = event.payload;
			this.validateCheckpoint(checkpoint);
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
			this.projection.applyWorkflowSnapshot(event.payload.handle);
			this.prompts.set(
				entry.runId,
				new PromptReservationState(event.payload.handle.pendingPrompts, event.payload.prompts),
			);
		} else {
			const handle = event.payload;
			const previous = this.projection.getWorkflow(entry.runId);
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
	}

	private *entries(runId: string, fromSeq?: number): Operation<readonly JournalEntry[]> {
		if (this.synchronous !== undefined) return this.synchronous.readEntries(runId, fromSeq);
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
		this.prompts.delete(runId);
		for (const entry of entries) this.fold(entry);
	}
	private *refresh(runId: string): Operation<void> {
		if (!this.leases.has(runId)) return yield* this.rebuild(runId);
		for (const entry of yield* this.entries(runId, (this.sequences.get(runId) ?? 0) + 1)) this.fold(entry);
	}
	private *current(runId: string): Operation<DurableWorkflowHandle | undefined> {
		this.ensureOpen();
		this.assertExecutionActive(runId);
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
		if (this.closed) throw new JournalBackendClosedError();
	}
	private assertExecutionActive(runId: string): void {
		for (const execution of this.executionContext.getStore()?.values() ?? [])
			if (execution.retired) throw new JournalExecutionRetiredError(runId);
	}
	private *ownership(runId: string): Operation<Lease> {
		this.ensureOpen();
		this.assertExecutionActive(runId);
		const lost = this.lost.get(runId);
		if (lost) throw lost;
		const existing = this.leases.get(runId);
		if (existing) return existing;
		const result = yield* invoke(
			() =>
				this.synchronous !== undefined
					? this.synchronous.takeoverExpiredSync(runId, this.holderId, FOREIGN_LIVE_WORKFLOW_WINDOW_MS)
					: this.journal.takeoverExpired(runId, this.holderId, FOREIGN_LIVE_WORKFLOW_WINDOW_MS),
			this.synchronous !== undefined,
		);
		if (result.status === "held") throw new JournalOwnershipError(runId, result.holderId);
		this.leases.set(runId, result.lease);
		if (this.timer === undefined) {
			this.timer = setInterval(() => void this.renewLeases(), STAGE_SESSION_HEARTBEAT_INTERVAL_MS);
			this.timer.unref();
		}
		const execution = this.executions.get(runId);
		if (execution !== undefined) execution.lease = result.lease;
		yield* this.rebuild(runId);
		return result.lease;
	}
	private mapOwnership(error: Error, runId: string): Error {
		if (!(error instanceof StaleLeaseError)) return error;
		const failure = new JournalOwnershipError(
			runId,
			this.synchronous?.leaseStateSync(runId)?.holderId ?? null,
			error,
		);
		this.lost.set(runId, failure);
		return failure;
	}
	private *append(
		runId: string,
		event: BackendEvent,
		options?: { readonly key?: string; readonly expectSeq?: number },
	): Operation<void> {
		const lease = yield* this.ownership(runId);
		try {
			yield* invoke(
				() =>
					this.synchronous !== undefined
						? this.synchronous.appendSync(lease, event, options)
						: this.journal.append(lease, event, options),
				this.synchronous !== undefined,
			);
			yield* this.refresh(runId);
		} catch (error) {
			if (error instanceof Error) throw this.mapOwnership(error, runId);
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

	registerWorkflow(input: WorkflowRegistrationInput): void | Promise<void> {
		return this.serialize(input.workflowId, () => this.register(input));
	}
	private *register(input: WorkflowRegistrationInput): Operation<void> {
		this.assertExecutionActive(input.workflowId);
		this.ensureOpen();
		const header = {
			runId: input.workflowId,
			name: input.name,
			cwd: input.invocationCwd ?? process.cwd(),
			createdAt: input.createdAt,
			status: input.status,
			inputs: input.inputs,
		};
		yield* invoke(
			() => this.synchronous?.createRunSync(header) ?? this.journal.createRun(header),
			this.synchronous !== undefined,
		);
		yield* this.ownership(input.workflowId);
		yield* this.refresh(input.workflowId);
		const draft = yield* this.draft(input.workflowId);
		draft.registerWorkflow(input, true);
		yield* this.snapshot(
			draft.getWorkflow(input.workflowId)!,
			this.sequences.has(input.workflowId) ? E.statusChanged : E.runStarted,
		);
	}
	private validateCheckpoint(checkpoint: DurableCheckpoint): void {
		if (
			checkpoint.kind === "stage" &&
			checkpoint.topology?.boundary !== undefined &&
			typeof checkpoint.topology.boundary.invocationFingerprint !== "string"
		)
			throw new DurableNestedTopologyError(`missing invocation fingerprint at ${checkpoint.checkpointId}`);
	}
	recordCheckpoint(checkpoint: DurableCheckpoint): void | Promise<void> {
		return this.serialize(checkpoint.workflowId, () => this.checkpoint(checkpoint));
	}
	private *checkpoint(checkpoint: DurableCheckpoint): Operation<void> {
		this.validateCheckpoint(checkpoint);
		if (!(yield* this.current(checkpoint.workflowId))) return;
		yield* this.append(
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
		await this.recordCheckpoint(checkpoint);
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
	workflowOwnership(runId: string): "local" | "foreign" | "available" | Promise<"local" | "foreign" | "available"> {
		if (this.synchronous !== undefined) {
			const lease = this.synchronous.leaseStateSync(runId);
			if (lease === undefined || Date.now() - lease.renewedAt >= FOREIGN_LIVE_WORKFLOW_WINDOW_MS) return "available";
			return lease.holderId === this.holderId ? "local" : "foreign";
		}
		return this.serialize(runId, () => this.probeOwnership(runId));
	}
	private *probeOwnership(runId: string): Operation<"local" | "foreign" | "available"> {
		this.ensureOpen();
		const lease = yield* invoke(() => this.journal.leaseState(runId));
		if (lease === undefined || Date.now() - lease.renewedAt >= FOREIGN_LIVE_WORKFLOW_WINDOW_MS) return "available";
		return lease.holderId === this.holderId ? "local" : "foreign";
	}
	setWorkflowStatus(
		runId: string,
		status: DurableWorkflowStatus,
		pendingPrompts?: number,
		resumable?: boolean,
		failure?: DurableWorkflowFailureMetadata,
	): void | Promise<void> {
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
	adjustPendingPrompts(runId: string, delta: number): void | Promise<void> {
		return this.serialize(runId, () =>
			this.promptChange(runId, delta >= 0 ? E.promptAsked : E.promptReleased, (state) => state.adjust(delta)),
		);
	}
	promptReservationScope(runId: string) {
		return { rootWorkflowId: runId, scope: "root" };
	}
	pendingPromptToken(
		runId: string,
		reservationId: string,
	): PromptReservationToken | undefined | Promise<PromptReservationToken | undefined> {
		return this.serialize(runId, () =>
			this.promptChange(runId, E.promptAsked, (state) => state.claim(reservationId), true),
		);
	}
	reservePendingPrompt(
		runId: string,
		reservationId: string,
	): PromptReservationToken | Promise<PromptReservationToken> {
		return this.serialize(runId, () => this.reserve(runId, reservationId));
	}
	private *reserve(runId: string, reservationId: string): Operation<PromptReservationToken> {
		return (
			(yield* this.promptChange(runId, E.promptAsked, (state) => state.reserve(reservationId))) ??
			inactivePromptReservationToken(reservationId)
		);
	}
	releasePendingPrompt(runId: string, reservationId: string, token: PromptReservationToken): void | Promise<void> {
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
		yield* this.snapshot(
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
		await this.serialize(runId, () => this.rebuild(runId));
	}
	async hydrateResumableWorkflows(): Promise<void> {
		const runs = await execute(invoke(() => this.journal.listRuns()));
		for (const runId of new Set([...this.sequences.keys(), ...runs.map((run) => run.runId)]))
			await this.hydrateWorkflow(runId);
	}
	async prepareWorkflowCatalog() {
		await this.hydrateResumableWorkflows();
		return this.projection.prepareWorkflowCatalog();
	}
	private *deleteOwned(runId: string, expectSeq?: number): Operation<void> {
		try {
			const lease = yield* this.ownership(runId);
			if (expectSeq !== undefined) {
				const entries = yield* this.entries(runId);
				const actualSeq = entries.at(-1)?.seq ?? 0;
				if (actualSeq !== expectSeq) throw new JournalCasConflictError(runId, expectSeq, actualSeq);
			}
			yield* invoke(() => this.journal.deleteOwnedRun(lease));
		} catch (error) {
			if (!(error instanceof RunNotFoundError)) {
				if (error instanceof Error) throw this.mapOwnership(error, runId);
				throw error;
			}
		}
		this.leases.delete(runId);
		this.sequences.delete(runId);
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
	reset(): void | Promise<void> {
		return execute(this.resetJournal());
	}
	private *resetJournal(): Operation<void> {
		const runs = yield* invoke(
			() => this.synchronous?.listRunsSync() ?? this.journal.listRuns(),
			this.synchronous !== undefined,
		);
		for (const run of runs)
			yield* invoke(() => {
				if (this.synchronous !== undefined) return this.synchronous.deleteRunSync(run.runId);
				return this.journal.deleteRun(run.runId);
			}, this.synchronous !== undefined);
		this.projection.reset();
		this.sequences.clear();
		this.leases.clear();
		this.lost.clear();
		this.prompts.clear();
	}
	private async renewLeases(): Promise<void> {
		for (const [runId, lease] of this.leases) {
			await this.serialize(runId, () => this.renewLease(runId, lease));
		}
	}
	private *renewLease(runId: string, lease: Lease): Operation<void> {
		if (this.leases.get(runId) !== lease || this.lost.has(runId)) return;
		try {
			yield* invoke(() => {
				if (this.synchronous !== undefined) return this.synchronous.renewSync(lease);
				return this.journal.renew(lease);
			}, this.synchronous !== undefined);
		} catch (error) {
			if (this.leases.get(runId) === lease && error instanceof Error)
				this.lost.set(runId, this.mapOwnership(error, runId));
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
		process.once("exit", this.processExitCleanup);
	}
	async withWorkflowLease<T>(runId: string, action: () => Promise<T>): Promise<T> {
		this.ensureOpen();
		this.assertExecutionActive(runId);
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
		if (execution.lease !== undefined && this.leases.get(runId) === execution.lease)
			return this.serialize(runId, () => this.release(runId));
	}
	releaseWorkflow(runId: string): void | Promise<void> {
		this.assertExecutionActive(runId);
		return this.serialize(runId, () => this.release(runId));
	}
	private *release(runId: string): Operation<void> {
		const lease = this.leases.get(runId);
		if (lease === undefined) return;
		try {
			yield* invoke(() => {
				if (this.synchronous !== undefined) return this.synchronous.releaseSync(lease);
				return this.journal.release(lease);
			}, this.synchronous !== undefined);
		} catch (error) {
			if (!(error instanceof StaleLeaseError)) throw error;
		} finally {
			this.leases.delete(runId);
			if (this.leases.size === 0) {
				clearInterval(this.timer);
				this.timer = undefined;
			}
		}
	}
	private *releaseAll(): Operation<void> {
		for (const runId of this.leases.keys()) yield* this.release(runId);
	}
	async close(): Promise<void> {
		if (this.processExitCleanup !== undefined) {
			process.off("exit", this.processExitCleanup);
			this.processExitCleanup = undefined;
		}
		if (this.closed) return;
		if (this.timer !== undefined) clearInterval(this.timer);
		if (this.pending.size > 0) await Promise.all(this.pending.values());
		try {
			const released = execute(this.releaseAll());
			if (isPromise(released)) await released;
		} finally {
			this.closed = true;
			if (this.ownsJournal) await execute(invoke(() => this.journal.close()));
		}
	}
}
