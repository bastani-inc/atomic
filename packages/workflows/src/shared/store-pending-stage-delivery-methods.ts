import type { DurableWorkflowBackend } from "../durable/backend.js";
import {
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
				const result = queueStageMessage(
					run.pendingStageMessages ?? [],
					input,
					senderGroup,
					runGroup,
					stageIdentity,
				);
				if (result.ok && !result.deduplicated) {
					await persistTransition(backend, input.runId, result.messages);
					run.pendingStageMessages = [...result.messages];
					context.bumpAndNotify();
				}
				return result;
			});
		},

		async validateLiveStageMessage(
			input: PendingStageMessageInput,
		): Promise<LiveStageMessageValidationResult | undefined> {
			return await serialize(input.runId, async () => {
				const run = context.findRun(input.runId);
				if (run === undefined) return undefined;
				const result = queueStageMessage(
					run.pendingStageMessages ?? [],
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
				await persistTransition(backend, runId, next);
				run.pendingStageMessages = [...next];
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
				await persistTransition(backend, runId, next);
				run.pendingStageMessages = [...next];
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
				await persistTransition(backend, runId, next);
				run.pendingStageMessages = [...next];
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
				const result = queueStickyStageMessage(run.pendingStageMessages ?? [], input, senderGroup, runGroup);
				if (result.ok && !result.deduplicated) {
					await persistTransition(backend, input.runId, result.messages);
					run.pendingStageMessages = [...result.messages];
					context.bumpAndNotify();
				}
				return result;
			});
		},

		async recordPendingStageMessageDeliveries(
			runId: string,
			messageId: string,
			records: readonly { readonly runId: string; readonly stageId: string; readonly stageName?: string }[],
			deliveredAt: string,
			backend: DurableWorkflowBackend,
		): Promise<boolean> {
			return await serialize(runId, async () => {
				const run = context.findRun(runId);
				if (run === undefined) return false;
				const current = run.pendingStageMessages ?? [];
				const next = recordPendingStageMessageDeliveries(current, runId, messageId, records, deliveredAt);
				if (next === current) return false;
				await persistTransition(backend, runId, next);
				run.pendingStageMessages = [...next];
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
				const current = run.pendingStageMessages ?? [];
				const next = settleStickyPendingStageMessageDelivered(current, runId, messageId, settledAt);
				if (next === current) return false;
				await persistTransition(backend, runId, next);
				run.pendingStageMessages = [...next];
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
): Promise<void> {
	if (!(await backend.persistPendingStageMessages(runId, messages))) {
		throw new Error(`atomic-workflows: durable workflow ${runId} is unavailable for pending-stage persistence`);
	}
}
