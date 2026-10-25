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
	const transitions = new Map<string, Promise<void>>();
	const ledgers = new PendingStageLedgers();
	const serialize = async <T>(runId: string, transition: () => Promise<T>): Promise<T> => {
		const previous = transitions.get(runId) ?? Promise.resolve();
		const result = previous.catch(() => undefined).then(transition);
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		transitions.set(runId, settled);
		settled.finally(() => {
			if (transitions.get(runId) === settled) transitions.delete(runId);
		});
		return await result;
	};

	return {
		async queueStageMessage(
			input: PendingStageMessageInput,
			senderGroup: string | undefined,
			runGroup: string | undefined,
			backend: DurableWorkflowBackend,
		): Promise<PendingStageQueueResult | undefined> {
			return await serialize(input.runId, async () => {
				const run = context.findRun(input.runId);
				if (run === undefined) return undefined;
				const stageIdentity = resolvePendingStageIdentity(run, input.stageKey);
				const receipt = await backend.readSettledPendingStageMessage?.(input.runId, input.message.id);
				const result = queueStageMessage(
					receipt === undefined
						? (run.pendingStageMessages ?? [])
						: [...(run.pendingStageMessages ?? []), receipt],
					input,
					senderGroup,
					runGroup,
					stageIdentity,
				);
				if (result.ok && !result.deduplicated) {
					const messages = await persistTransition(backend, input.runId, result.messages, context, ledgers);
					const live = context.findRun(input.runId) ?? run;
					live.pendingStageMessages = [...messages];
					context.bumpAndNotify();
				}
				return result.ok
					? { ...result, messages: (context.findRun(input.runId) ?? run).pendingStageMessages ?? [] }
					: result;
			});
		},

		async validateLiveStageMessage(
			input: PendingStageMessageInput,
		): Promise<LiveStageMessageValidationResult | undefined> {
			return await serialize(input.runId, async () => {
				const run = context.findRun(input.runId);
				if (run === undefined) return undefined;
				const availableBackend = availableRunDurableBackend(context.state.runs, input.runId) ?? context.backend;
				const backend =
					availableBackend === undefined
						? undefined
						: durableBackendForRun(availableBackend, context.state.runs, input.runId);
				const receipt = await backend?.readSettledPendingStageMessage?.(input.runId, input.message.id);
				const result = queueStageMessage(
					receipt === undefined
						? (run.pendingStageMessages ?? [])
						: [...(run.pendingStageMessages ?? []), receipt],
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
			return await serialize(runId, async () => {
				const run = context.findRun(runId);
				if (run === undefined) return false;
				const current = run.pendingStageMessages ?? [];
				const next = markPendingStageMessageDelivered(
					current,
					runId,
					stageKey,
					messageId,
					deliveredAt,
					resolvePendingStageIdentity(run, stageKey),
				);
				if (next === current) return false;
				const messages = await persistTransition(backend, runId, next, context, ledgers);
				const live = context.findRun(runId) ?? run;
				live.pendingStageMessages = [...messages];
				context.bumpAndNotify();
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
			return await serialize(runId, async () => {
				const run = context.findRun(runId);
				if (run === undefined) return false;
				const current = run.pendingStageMessages ?? [];
				const next = markPendingStageMessageUndeliverable(
					current,
					runId,
					stageKey,
					messageId,
					reason,
					resolvePendingStageIdentity(run, stageKey),
				);
				if (next === current) return false;
				const messages = await persistTransition(backend, runId, next, context, ledgers);
				const live = context.findRun(runId) ?? run;
				live.pendingStageMessages = [...messages];
				context.bumpAndNotify();
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
			return await serialize(runId, async () => {
				const run = context.findRun(runId);
				if (run === undefined) return false;
				const current = run.pendingStageMessages ?? [];
				const next = markPendingStageMessageUndeliverableNotified(
					current,
					runId,
					stageKey,
					messageId,
					notificationId,
					notifiedAt,
				);
				if (next === current) return false;
				const messages = await persistTransition(backend, runId, next, context, ledgers);
				const live = context.findRun(runId) ?? run;
				live.pendingStageMessages = [...messages];
				context.bumpAndNotify();
				return true;
			});
		},
		async queueStickyStageMessage(
			input: PendingStickyStageMessageInput,
			senderGroup: string | undefined,
			runGroup: string | undefined,
			backend: DurableWorkflowBackend,
		): Promise<PendingStageQueueResult | undefined> {
			return await serialize(input.runId, async () => {
				const run = context.findRun(input.runId);
				if (run === undefined) return undefined;
				const receipt = await backend.readSettledPendingStageMessage?.(input.runId, input.message.id);
				const result = queueStickyStageMessage(
					receipt === undefined
						? (run.pendingStageMessages ?? [])
						: [...(run.pendingStageMessages ?? []), receipt],
					input,
					senderGroup,
					runGroup,
				);
				if (result.ok && !result.deduplicated) {
					const messages = await persistTransition(backend, input.runId, result.messages, context, ledgers);
					const live = context.findRun(input.runId) ?? run;
					live.pendingStageMessages = [...messages];
					context.bumpAndNotify();
				}
				return result.ok
					? { ...result, messages: (context.findRun(input.runId) ?? run).pendingStageMessages ?? [] }
					: result;
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
			return await serialize(runId, async () => {
				const run = context.findRun(runId);
				if (run === undefined) return false;
				if (records.length === 0) await backend.readPendingStageMessageDeliveryCount?.(runId, messageId, runId);
				let current = ledgers.reconcile(backend, run);
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
				if (current !== run.pendingStageMessages) {
					run.pendingStageMessages = [...current];
					context.bumpAndNotify();
				}
				const next = recordPendingStageMessageDeliveries(
					current,
					runId,
					messageId,
					unconfirmedRecords,
					deliveredAt,
				);
				if (next === current) return false;
				const messages = await persistTransition(backend, runId, next, context, ledgers);
				const live = context.findRun(runId) ?? run;
				live.pendingStageMessages = [...messages];
				context.bumpAndNotify();
				return true;
			});
		},

		async settleStickyPendingStageMessageDelivered(
			runId: string,
			messageId: string,
			settledAt: string,
			backend: DurableWorkflowBackend,
		): Promise<boolean> {
			return await serialize(runId, async () => {
				const run = context.findRun(runId);
				if (run === undefined) return false;
				await backend.readPendingStageMessageDeliveryCount?.(runId, messageId, runId);
				const current = ledgers.reconcile(backend, run);
				const next = settleStickyPendingStageMessageDelivered(current, runId, messageId, settledAt);
				if (next === current) return false;
				const messages = await persistTransition(backend, runId, next, context, ledgers);
				const live = context.findRun(runId) ?? run;
				live.pendingStageMessages = [...messages];
				context.bumpAndNotify();
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

async function persistTransition(
	backend: DurableWorkflowBackend,
	runId: string,
	messages: readonly PendingStageMessage[],
	context: StoreContext,
	ledgers: PendingStageLedgers,
): Promise<readonly PendingStageMessage[]> {
	const run = context.findRun(runId);
	const ledger = run === undefined ? new PendingStageTransitionLedger() : ledgers.for(run);
	let retained = ledger.reconcile(backend, runId, messages);
	try {
		const archiveSettled =
			backend.archivePendingStageMessage !== undefined && backend.readSettledPendingStageMessage !== undefined
				? (entry: PendingStageMessage) => backend.archivePendingStageMessage!(runId, entry)
				: undefined;
		let commit: (() => void) | undefined;
		if (isCompactingBackend(backend)) {
			// Receipt compaction already drops every completed or skipped stage's deliveries, so the
			// full-list sticky compaction below cannot change the result and is skipped.
			const compacted = await ledger.compact(backend, runId, retained, context.state.runs, archiveSettled);
			retained = compacted.messages;
			commit = compacted.commit;
		} else {
			retained = compactStickyStageMessageDeliveries(retained, context.state.runs);
			if (archiveSettled !== undefined) retained = await retainPendingStageMessages(retained, archiveSettled);
			if (run !== undefined) ledgers.reset(run);
		}
		if (!(await backend.persistPendingStageMessages(runId, retained))) {
			throw new Error(`atomic-workflows: durable workflow ${runId} is unavailable for pending-stage persistence`);
		}
		commit?.();
		return retained;
	} finally {
		const current = context.findRun(runId);
		if (current !== undefined) {
			const messages = current.pendingStageMessages ?? [];
			const recovered = ledgers.for(current).reconcile(backend, runId, messages);
			if (recovered !== messages) {
				current.pendingStageMessages = [...recovered];
				context.bumpAndNotify();
			}
		}
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

	reconcile(backend: DurableWorkflowBackend, run: RunSnapshot): readonly PendingStageMessage[] {
		return this.for(run).reconcile(backend, run.id, run.pendingStageMessages ?? []);
	}
}
