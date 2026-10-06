import type { DurableWorkflowBackend } from "../durable/backend.js";
import { durableBackendForRun } from "../durable/run-owner-backend.js";
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
import type { StoreContext } from "./store-internal.js";
import type { Store } from "./store-public-types.js";
import type { LiveStageMessageValidationResult, PendingStickyStageMessageInput } from "./store-types.js";

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
					const messages = await persistTransition(backend, input.runId, result.messages, context);
					run.pendingStageMessages = [...messages];
					context.bumpAndNotify();
				}
				return result.ok ? { ...result, messages: run.pendingStageMessages ?? [] } : result;
			});
		},

		async validateLiveStageMessage(
			input: PendingStageMessageInput,
		): Promise<LiveStageMessageValidationResult | undefined> {
			return await serialize(input.runId, async () => {
				const run = context.findRun(input.runId);
				if (run === undefined) return undefined;
				const { getDurableBackend } = await import("../durable/factory.js");
				const backend = durableBackendForRun(getDurableBackend(), context.state.runs, input.runId);
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
				const messages = await persistTransition(backend, runId, next, context);
				run.pendingStageMessages = [...messages];
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
				const messages = await persistTransition(backend, runId, next, context);
				run.pendingStageMessages = [...messages];
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
				const messages = await persistTransition(backend, runId, next, context);
				run.pendingStageMessages = [...messages];
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
					const messages = await persistTransition(backend, input.runId, result.messages, context);
					run.pendingStageMessages = [...messages];
					context.bumpAndNotify();
				}
				return result.ok ? { ...result, messages: run.pendingStageMessages ?? [] } : result;
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
				let current = reconcileDeliveryCounts(backend, runId, run.pendingStageMessages ?? []);
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
				current = reconcileDeliveryCounts(backend, runId, current);
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
				const messages = await persistTransition(backend, runId, next, context);
				run.pendingStageMessages = [...messages];
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
				const current = reconcileDeliveryCounts(backend, runId, run.pendingStageMessages ?? []);
				const next = settleStickyPendingStageMessageDelivered(current, runId, messageId, settledAt);
				if (next === current) return false;
				const messages = await persistTransition(backend, runId, next, context);
				run.pendingStageMessages = [...messages];
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
): Promise<readonly PendingStageMessage[]> {
	let retained = reconcileDeliveryCounts(backend, runId, messages);
	try {
		if (
			backend.archivePendingStageDeliveryReceipt !== undefined &&
			backend.hasPendingStageDeliveryReceipt !== undefined
		) {
			const compacted: PendingStageMessage[] = [];
			for (const entry of retained) {
				if (entry.sticky !== true || entry.deliveries === undefined) {
					compacted.push(entry);
					continue;
				}
				const latest = new Map<string, number>();
				entry.deliveries.forEach((delivery, index) => {
					latest.set(JSON.stringify([delivery.runId, delivery.stageId, delivery.admission]), index);
				});
				const deliveries = [];
				let archivedThrough = -1;
				for (let index = 0; index < entry.deliveries.length; index++) {
					const delivery = entry.deliveries[index]!;
					const stage = context.state.runs
						.find((run) => run.id === delivery.runId)
						?.stages.find((stage) => stage.id === delivery.stageId);
					if (
						entry.status !== "queued" ||
						stage?.status === "completed" ||
						stage?.status === "skipped" ||
						stage?.status === "failed" ||
						(latest.get(JSON.stringify([delivery.runId, delivery.stageId, delivery.admission])) !== index &&
							delivery.sessionId !== undefined)
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
				compacted.push(deliveries.length === entry.deliveries.length ? entry : { ...entry, deliveries });
			}
			retained = compacted;
		}
		retained = compactStickyStageMessageDeliveries(retained, context.state.runs);
		if (backend.archivePendingStageMessage !== undefined && backend.readSettledPendingStageMessage !== undefined) {
			retained = await retainPendingStageMessages(retained, (entry) =>
				backend.archivePendingStageMessage!(runId, entry),
			);
		}
		if (!(await backend.persistPendingStageMessages(runId, retained))) {
			throw new Error(`atomic-workflows: durable workflow ${runId} is unavailable for pending-stage persistence`);
		}
		return retained;
	} finally {
		const run = context.findRun(runId);
		if (run !== undefined) {
			const current = run.pendingStageMessages ?? [];
			const recovered = reconcileDeliveryCounts(backend, runId, current);
			if (recovered !== current) {
				run.pendingStageMessages = [...recovered];
				context.bumpAndNotify();
			}
		}
	}
}

function reconcileDeliveryCounts(
	backend: DurableWorkflowBackend,
	runId: string,
	messages: readonly PendingStageMessage[],
): readonly PendingStageMessage[] {
	let changed = false;
	const recovered = messages.map((entry) => {
		if (entry.sticky !== true) return entry;
		const count = backend.getPendingStageMessageDeliveryCount?.(runId, entry.id, entry.runId) ?? 0;
		if (count <= (entry.deliveryCount ?? entry.deliveries?.length ?? 0)) return entry;
		changed = true;
		return { ...entry, deliveryCount: count };
	});
	return changed ? recovered : messages;
}
