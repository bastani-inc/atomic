import type { DurableWorkflowBackend } from "../durable/backend.js";
import { availableRunDurableBackend, durableBackendForRun } from "../durable/run-owner-backend.js";
import {
	compactStickyStageMessageDeliveries,
	markPendingStageMessageDelivered,
	markPendingStageMessageUndeliverable,
	markPendingStageMessageUndeliverableNotified,
	type PendingStageIdentity,
	type PendingStageMessage,
	type PendingStageMessageInput,
	type PendingStageQueueResult,
	pendingStageMessagesFor,
	queueStageMessage,
	queueStickyStageMessage,
	recordPendingStageMessageDeliveries,
	settleStickyPendingStageMessageDelivered,
} from "./pending-stage-delivery.js";
import { retainPendingStageMessages } from "./pending-stage-retention.js";
import { isCompactingBackend, PendingStageTransitionLedger } from "./pending-stage-transition-ledger.js";
import type { StoreContext } from "./store-internal.js";
import type { Store } from "./store-public-types.js";
import type { LiveStageMessageValidationResult, PendingStickyStageMessageInput, RunSnapshot } from "./store-types.js";

type PendingStageDeliveryStoreMethods = Pick<
	Store,
	| "queueStageMessage"
	| "queueStickyStageMessage"
	| "validateLiveStageMessage"
	| "pendingStageMessagesFor"
	| "markPendingStageMessageDelivered"
	| "markPendingStageMessageUndeliverable"
	| "markPendingStageMessageUndeliverableNotified"
	| "recordPendingStageMessageDeliveries"
	| "settleStickyPendingStageMessageDelivered"
>;

export function createPendingStageDeliveryStoreMethods(context: StoreContext): PendingStageDeliveryStoreMethods {
	const ledgers = new PendingStageLedgers();
	const batches = new PendingStageTransitionBatches(context, ledgers);

	return {
		async queueStageMessage(
			input: PendingStageMessageInput,
			senderGroup: string | undefined,
			runGroup: string | undefined,
			backend: DurableWorkflowBackend,
		): Promise<PendingStageQueueResult | undefined> {
			return await batches.run(input.runId, backend, async (batch) => {
				const run = context.findRun(input.runId);
				if (run === undefined) return undefined;
				const stageIdentity = resolvePendingStageIdentity(run, input.stageKey);
				const receipt = await backend.readSettledPendingStageMessage?.(input.runId, input.message.id);
				const result = queueStageMessage(
					receipt === undefined ? batch.messages(run) : [...batch.messages(run), receipt],
					input,
					senderGroup,
					runGroup,
					stageIdentity,
				);
				if (result.ok && !result.deduplicated) {
					await batch.apply(backend, input.runId, result.messages);
				}
				return result.ok ? { ...result, messages: batch.messages(context.findRun(input.runId) ?? run) } : result;
			});
		},

		async validateLiveStageMessage(
			input: PendingStageMessageInput,
		): Promise<LiveStageMessageValidationResult | undefined> {
			return await batches.run(input.runId, undefined, async (batch) => {
				const run = context.findRun(input.runId);
				if (run === undefined) return undefined;
				const availableBackend = availableRunDurableBackend(context.state.runs, input.runId) ?? context.backend;
				const backend =
					availableBackend === undefined
						? undefined
						: durableBackendForRun(availableBackend, context.state.runs, input.runId);
				const receipt = await backend?.readSettledPendingStageMessage?.(input.runId, input.message.id);
				const result = queueStageMessage(
					receipt === undefined ? batch.messages(run) : [...batch.messages(run), receipt],
					input,
					undefined,
					undefined,
					resolvePendingStageIdentity(run, input.stageKey),
				);
				if (!result.ok) {
					return result.reason === "message_id_conflict"
						? { outcome: "message_id_conflict", messageId: result.messageId }
						: { outcome: "forward" };
				}
				if (!result.deduplicated) return { outcome: "forward" };
				if (result.entry.status === "delivered") return { outcome: "delivered" };
				if (result.entry.status === "undeliverable") {
					return { outcome: "undeliverable", reason: result.entry.undeliverableReason };
				}
				if (result.position === undefined) {
					throw new Error(`atomic-workflows: queued message ${input.message.id} has no active position`);
				}
				return { outcome: "queued", position: result.position };
			});
		},

		pendingStageMessagesFor(runId: string, stageKey: string): readonly PendingStageMessage[] {
			const run = context.findRun(runId);
			return pendingStageMessagesFor(
				run?.pendingStageMessages ?? [],
				runId,
				stageKey,
				run === undefined ? undefined : resolvePendingStageIdentity(run, stageKey),
			);
		},

		async markPendingStageMessageDelivered(
			runId: string,
			stageKey: string,
			messageId: string,
			deliveredAt: string,
			backend: DurableWorkflowBackend,
		): Promise<boolean> {
			return await batches.run(runId, backend, async (batch) => {
				const run = context.findRun(runId);
				if (run === undefined) return false;
				const current = batch.messages(run);
				const next = markPendingStageMessageDelivered(
					current,
					runId,
					stageKey,
					messageId,
					deliveredAt,
					resolvePendingStageIdentity(run, stageKey),
				);
				if (next === current) return false;
				await batch.apply(backend, runId, next);
				return true;
			});
		},

		async markPendingStageMessageUndeliverable(
			runId: string,
			stageKey: string,
			messageId: string,
			reason: string,
			backend: DurableWorkflowBackend,
		): Promise<boolean> {
			return await batches.run(runId, backend, async (batch) => {
				const run = context.findRun(runId);
				if (run === undefined) return false;
				const current = batch.messages(run);
				const next = markPendingStageMessageUndeliverable(
					current,
					runId,
					stageKey,
					messageId,
					reason,
					resolvePendingStageIdentity(run, stageKey),
				);
				if (next === current) return false;
				await batch.apply(backend, runId, next);
				return true;
			});
		},

		async markPendingStageMessageUndeliverableNotified(
			runId: string,
			stageKey: string,
			messageId: string,
			notificationId: string,
			notifiedAt: string,
			backend: DurableWorkflowBackend,
		): Promise<boolean> {
			return await batches.run(runId, backend, async (batch) => {
				const run = context.findRun(runId);
				if (run === undefined) return false;
				const current = batch.messages(run);
				const next = markPendingStageMessageUndeliverableNotified(
					current,
					runId,
					stageKey,
					messageId,
					notificationId,
					notifiedAt,
				);
				if (next === current) return false;
				await batch.apply(backend, runId, next);
				return true;
			});
		},
		async queueStickyStageMessage(
			input: PendingStickyStageMessageInput,
			senderGroup: string | undefined,
			runGroup: string | undefined,
			backend: DurableWorkflowBackend,
		): Promise<PendingStageQueueResult | undefined> {
			return await batches.run(input.runId, backend, async (batch) => {
				const run = context.findRun(input.runId);
				if (run === undefined) return undefined;
				const receipt = await backend.readSettledPendingStageMessage?.(input.runId, input.message.id);
				const result = queueStickyStageMessage(
					receipt === undefined ? batch.messages(run) : [...batch.messages(run), receipt],
					input,
					senderGroup,
					runGroup,
				);
				if (result.ok && !result.deduplicated) {
					await batch.apply(backend, input.runId, result.messages);
				}
				return result.ok ? { ...result, messages: batch.messages(context.findRun(input.runId) ?? run) } : result;
			});
		},

		async recordPendingStageMessageDeliveries(
			runId: string,
			messageId: string,
			records: readonly {
				readonly runId: string;
				readonly stageId: string;
				readonly stageName?: string;
				readonly sessionId?: string;
				readonly admission?: "context" | "transport";
			}[],
			deliveredAt: string,
			backend: DurableWorkflowBackend,
		): Promise<boolean> {
			return await batches.run(runId, backend, async (batch) => {
				const run = context.findRun(runId);
				if (run === undefined) return false;
				if (records.length === 0) await backend.readPendingStageMessageDeliveryCount?.(runId, messageId, runId);
				let current = ledgers.for(run).reconcile(backend, runId, batch.messages(run));
				const unconfirmedRecords = [];
				for (const record of records) {
					const contextReceipt =
						record.admission === "transport" ? { ...record, admission: "context" as const } : undefined;
					if (
						!(await backend.hasPendingStageDeliveryReceipt?.(runId, messageId, record)) &&
						(contextReceipt === undefined ||
							(!current
								.find((entry) => entry.id === messageId)
								?.deliveries?.some(
									(delivery) =>
										delivery.runId === record.runId &&
										delivery.stageId === record.stageId &&
										delivery.sessionId === record.sessionId &&
										delivery.admission === "context",
								) &&
								!(await backend.hasPendingStageDeliveryReceipt?.(runId, messageId, contextReceipt))))
					) {
						unconfirmedRecords.push(record);
					}
				}
				current = ledgers.for(run).reconcile(backend, runId, current);
				batch.reconciled(run, current);
				const next = recordPendingStageMessageDeliveries(
					current,
					runId,
					messageId,
					unconfirmedRecords,
					deliveredAt,
				);
				if (next === current) return false;
				await batch.apply(backend, runId, next);
				return true;
			});
		},

		async settleStickyPendingStageMessageDelivered(
			runId: string,
			messageId: string,
			settledAt: string,
			backend: DurableWorkflowBackend,
		): Promise<boolean> {
			return await batches.run(runId, backend, async (batch) => {
				const run = context.findRun(runId);
				if (run === undefined) return false;
				await backend.readPendingStageMessageDeliveryCount?.(runId, messageId, runId);
				const current = ledgers.for(run).reconcile(backend, runId, batch.messages(run));
				const next = settleStickyPendingStageMessageDelivered(current, runId, messageId, settledAt);
				if (next === current) return false;
				await batch.apply(backend, runId, next);
				return true;
			});
		},
	};
}

function resolvePendingStageIdentity(
	run: {
		readonly stages: readonly { readonly id: string; readonly name: string; readonly replayKey?: string }[];
	},
	stageKey: string,
): PendingStageIdentity | undefined {
	const exactIds = run.stages.filter((stage) => stage.id === stageKey);
	const candidates = exactIds.length > 0 ? exactIds : run.stages.filter((stage) => stage.name === stageKey);
	if (candidates.length !== 1) return undefined;
	const stage = candidates[0]!;
	return {
		id: stage.id,
		...(stage.replayKey !== undefined ? { replayKey: stage.replayKey } : {}),
		aliases: stage.id === stage.name ? [stage.id] : [stage.id, stage.name],
	};
}

/** Most transitions of one run applied in memory before their one shared persist. */
export const PENDING_STAGE_TRANSITION_BATCH_LIMIT = 256;

interface QueuedTransition {
	readonly backend: DurableWorkflowBackend | undefined;
	readonly step: (batch: PendingStageTransitionBatch) => Promise<unknown>;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
}

type TransitionOutcome =
	| { readonly ok: true; readonly value: unknown; readonly uncommitted: boolean }
	| { readonly ok: false; readonly error: unknown };

/**
 * Per-run FIFO of pending-stage transitions with group commit. A transition that arrives while
 * its run's previous batch is persisting waits; when that persist settles, every waiting transition
 * runs in order against the previous one's in-memory result, the batch persists its final list once,
 * and only then does each caller get its own result. A transition with nothing queued behind it
 * runs and persists alone, as before.
 */
class PendingStageTransitionBatches {
	private readonly queues = new Map<string, QueuedTransition[]>();
	private readonly context: StoreContext;
	private readonly ledgers: PendingStageLedgers;

	constructor(context: StoreContext, ledgers: PendingStageLedgers) {
		this.context = context;
		this.ledgers = ledgers;
	}

	run<T>(
		runId: string,
		backend: DurableWorkflowBackend | undefined,
		step: (batch: PendingStageTransitionBatch) => Promise<T>,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const transition: QueuedTransition = {
				backend,
				step,
				resolve: (value) => resolve(value as T),
				reject,
			};
			const queue = this.queues.get(runId);
			if (queue !== undefined) {
				queue.push(transition);
				return;
			}
			const created = [transition];
			this.queues.set(runId, created);
			void Promise.resolve().then(() => this.drain(runId, created));
		});
	}

	private async drain(runId: string, queue: QueuedTransition[]): Promise<void> {
		while (queue.length > 0) await this.runBatch(runId, takeBatch(queue));
		this.queues.delete(runId);
	}

	private async runBatch(runId: string, transitions: readonly QueuedTransition[]): Promise<void> {
		const batch = new PendingStageTransitionBatch(this.context, this.ledgers, runId);
		const outcomes: TransitionOutcome[] = [];
		for (const transition of transitions) {
			const changedBefore = batch.changed;
			try {
				const value = await transition.step(batch);
				outcomes.push({ ok: true, value, uncommitted: changedBefore || batch.changed });
			} catch (error) {
				outcomes.push({ ok: false, error });
			}
		}
		let failure: { readonly error: unknown } | undefined;
		try {
			await batch.persist();
		} catch (error) {
			failure = { error };
		}
		transitions.forEach((transition, index) => {
			const outcome = outcomes[index]!;
			if (!outcome.ok) transition.reject(outcome.error);
			// A result computed from unpersisted entries fails with the persist, as its own persist would have.
			else if (failure !== undefined && outcome.uncommitted) transition.reject(failure.error);
			else transition.resolve(outcome.value);
		});
	}
}

/** The next batch: queued transitions in order, up to the limit, sharing one durable backend. */
function takeBatch(queue: QueuedTransition[]): QueuedTransition[] {
	let count = 1;
	let backend = queue[0]!.backend;
	while (count < queue.length && count < PENDING_STAGE_TRANSITION_BATCH_LIMIT) {
		const next = queue[count]!.backend;
		if (next !== undefined && backend !== undefined && next !== backend) break;
		backend ??= next;
		count++;
	}
	return queue.splice(0, count);
}

/**
 * One batch's in-memory pending list. Each transition reads the list the previous one produced and
 * compacts its own change, archiving receipts as it would alone; the final list is persisted once.
 */
class PendingStageTransitionBatch {
	changed = false;
	private list: readonly PendingStageMessage[] | undefined;
	private pending:
		| {
				readonly backend: DurableWorkflowBackend;
				readonly messages: readonly PendingStageMessage[];
				readonly commit: (() => void) | undefined;
				readonly run: RunSnapshot | undefined;
		  }
		| undefined;
	private readonly context: StoreContext;
	private readonly ledgers: PendingStageLedgers;
	private readonly runId: string;

	constructor(context: StoreContext, ledgers: PendingStageLedgers, runId: string) {
		this.context = context;
		this.ledgers = ledgers;
		this.runId = runId;
	}

	/** The run's pending list as the previous transition in this batch left it. */
	messages(run: RunSnapshot): readonly PendingStageMessage[] {
		return this.list ?? run.pendingStageMessages ?? [];
	}

	/** Publish recovered delivery counts: live while nothing is unpersisted, otherwise in the batch. */
	reconciled(run: RunSnapshot, messages: readonly PendingStageMessage[]): void {
		if (this.changed) {
			this.list = messages;
			return;
		}
		if (messages !== run.pendingStageMessages) {
			run.pendingStageMessages = [...messages];
			this.context.bumpAndNotify();
		}
	}

	/** Reconcile, compact and retain one transition's list in memory; it is persisted with the batch. */
	async apply(
		backend: DurableWorkflowBackend,
		runId: string,
		messages: readonly PendingStageMessage[],
	): Promise<readonly PendingStageMessage[]> {
		const run = this.context.findRun(runId);
		try {
			const compacted = await compactTransition(backend, runId, messages, this.context, this.ledgers, run);
			this.list = compacted.messages;
			this.changed = true;
			this.pending = { backend, messages: compacted.messages, commit: compacted.commit, run };
			return compacted.messages;
		} catch (error) {
			reconcileLive(backend, runId, this.context, this.ledgers);
			throw error;
		}
	}

	/** Persist the batch's final list once, then publish it to the live run. */
	async persist(): Promise<void> {
		if (this.pending === undefined) return;
		const { backend, messages, commit, run } = this.pending;
		try {
			if (!(await backend.persistPendingStageMessages(this.runId, messages))) {
				throw new Error(
					`atomic-workflows: durable workflow ${this.runId} is unavailable for pending-stage persistence`,
				);
			}
			commit?.();
		} finally {
			reconcileLive(backend, this.runId, this.context, this.ledgers);
		}
		const live = this.context.findRun(this.runId) ?? run;
		if (live !== undefined) live.pendingStageMessages = [...messages];
		this.context.bumpAndNotify();
	}
}

/** Reconcile, compact and retain one transition's list, archiving receipts; the caller persists it. */
async function compactTransition(
	backend: DurableWorkflowBackend,
	runId: string,
	messages: readonly PendingStageMessage[],
	context: StoreContext,
	ledgers: PendingStageLedgers,
	run: RunSnapshot | undefined,
): Promise<{ readonly messages: readonly PendingStageMessage[]; readonly commit?: () => void }> {
	const ledger = run === undefined ? new PendingStageTransitionLedger() : ledgers.for(run);
	const reconciled = ledger.reconcile(backend, runId, messages);
	const archiveSettled =
		backend.archivePendingStageMessage !== undefined && backend.readSettledPendingStageMessage !== undefined
			? (entry: PendingStageMessage) => backend.archivePendingStageMessage!(runId, entry)
			: undefined;
	if (isCompactingBackend(backend)) {
		// Receipt compaction already drops every completed or skipped stage's deliveries, so the
		// full-list sticky compaction below cannot change the result and is skipped. The ledger
		// commits only once the batch's final list, which contains this change, is persisted.
		return await ledger.compact(backend, runId, reconciled, context.state.runs, archiveSettled);
	}
	let retained = compactStickyStageMessageDeliveries(reconciled, context.state.runs);
	if (archiveSettled !== undefined) retained = await retainPendingStageMessages(retained, archiveSettled);
	if (run !== undefined) ledgers.reset(run);
	return { messages: retained };
}

/** Raise the live run's delivery counts to the durable counts, as every transition did on exit. */
function reconcileLive(
	backend: DurableWorkflowBackend,
	runId: string,
	context: StoreContext,
	ledgers: PendingStageLedgers,
): void {
	const current = context.findRun(runId);
	if (current === undefined) return;
	const messages = current.pendingStageMessages ?? [];
	const recovered = ledgers.for(current).reconcile(backend, runId, messages);
	if (recovered !== messages) {
		current.pendingStageMessages = [...recovered];
		context.bumpAndNotify();
	}
}

/** One transition ledger per live run snapshot; a replaced snapshot starts from a full pass. */
class PendingStageLedgers {
	private readonly ledgers = new WeakMap<RunSnapshot, PendingStageTransitionLedger>();

	for(run: RunSnapshot): PendingStageTransitionLedger {
		let ledger = this.ledgers.get(run);
		if (ledger === undefined) {
			ledger = new PendingStageTransitionLedger();
			this.ledgers.set(run, ledger);
		}
		return ledger;
	}

	reset(run: RunSnapshot): void {
		this.ledgers.delete(run);
	}
}
