import { getDurableBackend } from "../durable/factory.js";
import { durableBackendForRun, durableRootRunIdForRun } from "../durable/run-owner-backend.js";
import { workflowInvocationIntercomGroup } from "../shared/intercom-group.js";
import { workflowPendingStageRouteCapability } from "../shared/pending-stage-route-capability.js";
import type { Store } from "../shared/store.js";
import { isTerminalRunStatus } from "../shared/store-internal.js";
import type {
	PendingStageMessage,
	PendingStageMessageInput,
	PendingStageQueueResult,
	PendingStageSender,
} from "../shared/store-types.js";

const PENDING_STAGE_ROUTE_EVENT = "atomic:workflow-pending-stage-route";
const PENDING_STAGE_MESSAGE_EVENT = "atomic:workflow-pending-stage-message";
const PENDING_STAGE_UNDELIVERABLE_EVENT = "atomic:workflow-pending-stage-undeliverable";
const PENDING_STAGE_ASK_REFUSAL =
	"Cannot ask a workflow stage whose session has not initialized. Use send; Atomic will queue the message until the stage session initializes.";

interface WorkflowEventSurface {
	readonly events?: {
		emit?(event: string, payload: Record<string, unknown>): void;
		on?(event: string, listener: (payload: unknown) => void): unknown;
	};
	on?(event: "session_shutdown", listener: () => void): void;
}

interface PendingStageMessageEvent {
	handled: boolean;
	completion?: Promise<
		| { readonly outcome: "queued"; readonly position: number }
		| { readonly outcome: "delivered" }
		| { readonly outcome: "forward" }
		| { readonly outcome: "refused"; readonly reason: string; readonly reasonCode?: "message_id_conflict" }
	>;
	readonly requestId?: string;
	readonly senderRegistrationName?: string;
	readonly senderReturnAddress?: string;
	readonly from?: PendingStageSender;
	readonly runId?: string;
	readonly stageKey?: string;
	readonly message?: PendingStageMessageInput["message"];
}

interface PendingStageUndeliverableEvent extends Record<string, unknown> {
	handled: boolean;
	completion?: Promise<boolean>;
	readonly runId: string;
	readonly senderId: string;
	readonly senderRegistrationName?: string;
	readonly senderReturnAddress?: string;
	readonly messageId: string;
	readonly notificationId: string;
	readonly reason: string;
}

export function registerPendingStageIntercomBridge(pi: WorkflowEventSurface, activeStore: Store): () => void {
	let disposed = false;
	let sweepPromise: Promise<void> = Promise.resolve();
	const notifyUndeliverable = async (
		entry: PendingStageMessage,
		reason: string,
		notificationId: string,
	): Promise<boolean> => {
		const payload: PendingStageUndeliverableEvent = {
			handled: false,
			runId: entry.runId,
			senderId: entry.from.id,
			...(entry.senderRegistrationName === undefined
				? {}
				: { senderRegistrationName: entry.senderRegistrationName }),
			...(entry.senderReturnAddress === undefined ? {} : { senderReturnAddress: entry.senderReturnAddress }),
			messageId: entry.message.id,
			notificationId,
			reason,
		};
		pi.events?.emit?.(PENDING_STAGE_UNDELIVERABLE_EVENT, payload);
		return payload.handled && (await payload.completion) === true;
	};
	const announceRoutes = (): void => {
		if (disposed) return;
		const runs = activeStore.runs();
		for (const run of runs) {
			const rootRunId = durableRootRunIdForRun(runs, run.id);
			if (rootRunId === undefined) continue;
			pi.events?.emit?.(PENDING_STAGE_ROUTE_EVENT, {
				runId: run.id,
				group: workflowInvocationIntercomGroup(rootRunId),
				capability: workflowPendingStageRouteCapability(activeStore, run.id),
			});
		}
		sweepPromise = sweepPromise
			.then(() => settleUndeliverablePendingStageMessages(activeStore, notifyUndeliverable))
			.then(() => undefined)
			.catch((error: Error) => console.warn("atomic-workflows: pending stage delivery sweep failed", error));
	};
	const unsubscribeStore = activeStore.subscribeInvalidation(announceRoutes);
	announceRoutes();
	const subscription = pi.events?.on?.(PENDING_STAGE_MESSAGE_EVENT, (payload) => {
		if (disposed || !isPendingStageMessageEvent(payload) || payload.handled) return;
		const runs = activeStore.runs();
		const run = runs.find((candidate) => candidate.id === payload.runId);
		if (run === undefined) return;
		const rootRunId = durableRootRunIdForRun(runs, run.id);
		if (rootRunId === undefined) return;
		if (payload.live === true) {
			if (knownLiveStage(run, payload.stageKey) === undefined) return;
			payload.handled = true;
			payload.completion = validateLiveDelivery(activeStore, payload);
			return;
		}
		const stage = knownUninitializedStage(run, payload.stageKey);
		if (stage === undefined) return;
		payload.handled = true;
		payload.completion = queueAndPersist(
			activeStore,
			payload,
			workflowInvocationIntercomGroup(rootRunId),
			stage.pendingStageDeliveryAvailable === true,
		);
	});
	const dispose = (): void => {
		disposed = true;
		unsubscribeStore();
		if (typeof subscription === "function") subscription();
	};
	pi.on?.("session_shutdown", dispose);
	return dispose;
}

function isPendingStageMessageEvent(value: unknown): value is PendingStageMessageEvent &
	Required<Pick<PendingStageMessageEvent, "from" | "runId" | "stageKey" | "message">> & {
		readonly live?: boolean;
	} {
	if (typeof value !== "object" || value === null) return false;
	const event = value as PendingStageMessageEvent & { readonly live?: unknown };
	return (
		typeof event.handled === "boolean" &&
		(event.live === undefined || typeof event.live === "boolean") &&
		typeof event.runId === "string" &&
		typeof event.stageKey === "string" &&
		typeof event.from?.id === "string" &&
		(event.from.name === undefined || typeof event.from.name === "string") &&
		(event.senderRegistrationName === undefined || typeof event.senderRegistrationName === "string") &&
		(event.senderReturnAddress === undefined || typeof event.senderReturnAddress === "string") &&
		typeof event.message?.id === "string" &&
		typeof event.message.timestamp === "number" &&
		typeof event.message.content?.text === "string"
	);
}

function knownLiveStage(
	run: ReturnType<Store["runs"]>[number],
	stageKey: string,
): ReturnType<Store["runs"]>[number]["stages"][number] | undefined {
	const exactIds = run.stages.filter((stage) => stage.id === stageKey);
	const candidates = exactIds.length > 0 ? exactIds : run.stages.filter((stage) => stage.name === stageKey);
	return candidates.length === 1 ? candidates[0] : undefined;
}

async function validateLiveDelivery(
	activeStore: Store,
	event: PendingStageMessageEvent &
		Required<Pick<PendingStageMessageEvent, "from" | "runId" | "stageKey" | "message">>,
): Promise<
	| { readonly outcome: "queued"; readonly position: number }
	| { readonly outcome: "delivered" }
	| { readonly outcome: "forward" }
	| { readonly outcome: "refused"; readonly reason: string; readonly reasonCode?: "message_id_conflict" }
> {
	const result = await activeStore.validateLiveStageMessage({
		runId: event.runId,
		stageKey: event.stageKey,
		from: event.from,
		message: event.message,
		queuedAt: new Date().toISOString(),
	});
	if (result === undefined) return { outcome: "refused", reason: "Session not found" };
	if (result.outcome === "forward" || result.outcome === "delivered" || result.outcome === "queued") return result;
	if (result.outcome === "undeliverable") {
		return { outcome: "refused", reason: result.reason ?? "Pending-stage delivery was refused" };
	}
	return {
		outcome: "refused",
		reason: `Intercom message ID '${result.messageId}' conflicts with the durable identity for ${event.runId}:${event.stageKey}`,
		reasonCode: "message_id_conflict",
	};
}

async function queueAndPersist(
	activeStore: Store,
	event: PendingStageMessageEvent &
		Required<Pick<PendingStageMessageEvent, "from" | "runId" | "stageKey" | "message">>,
	runGroup: string,
	pendingStageDeliveryAvailable: boolean,
): Promise<
	| { readonly outcome: "queued"; readonly position: number }
	| { readonly outcome: "delivered" }
	| { readonly outcome: "refused"; readonly reason: string }
> {
	if (event.message.expectsReply === true) {
		return { outcome: "refused", reason: PENDING_STAGE_ASK_REFUSAL };
	}
	if (!pendingStageDeliveryAvailable) {
		return {
			outcome: "refused",
			reason: `Workflow stage ${event.runId}:${event.stageKey} cannot receive Intercom messages before startup`,
		};
	}
	const request: PendingStageMessageInput = {
		runId: event.runId,
		stageKey: event.stageKey,
		from: event.from,
		...(event.senderRegistrationName === undefined ? {} : { senderRegistrationName: event.senderRegistrationName }),
		...(event.senderReturnAddress === undefined ? {} : { senderReturnAddress: event.senderReturnAddress }),
		message: event.message,
		queuedAt: new Date().toISOString(),
	};
	const rootBackend = getDurableBackend();
	const backend = durableBackendForRun(rootBackend, activeStore.runs(), event.runId);
	if (backend === undefined) return { outcome: "refused", reason: "Session not found" };
	const result: PendingStageQueueResult | undefined = await activeStore.queueStageMessage(
		request,
		event.from.group,
		runGroup,
		backend,
	);
	if (result === undefined) return { outcome: "refused", reason: "Session not found" };
	if (!result.ok) {
		if (result.reason === "capacity") {
			return {
				outcome: "refused",
				reason: `Pending stage message queue is full (limit ${result.limit}) for ${result.runId}:${result.stageKey}`,
			};
		}
		if (result.reason === "message_id_conflict") {
			return {
				outcome: "refused",
				reason: `Intercom message ID '${result.messageId}' was already queued for ${result.runId}:${result.stageKey} with a different target, sender, or payload`,
			};
		}
		return { outcome: "refused", reason: "Target workflow run is in a different intercom group" };
	}
	if (result.entry.status === "delivered") return { outcome: "delivered" };
	if (result.entry.status === "undeliverable") {
		return {
			outcome: "refused",
			reason: result.entry.undeliverableReason ?? "Pending-stage delivery was refused",
		};
	}
	if (result.position === undefined) return { outcome: "refused", reason: "Pending-stage delivery was refused" };
	return { outcome: "queued", position: result.position };
}

function knownUninitializedStage(
	run: ReturnType<Store["runs"]>[number],
	stageKey: string,
): ReturnType<Store["runs"]>[number]["stages"][number] | undefined {
	const exactIds = run.stages.filter((stage) => stage.id === stageKey);
	const candidates = exactIds.length > 0 ? exactIds : run.stages.filter((stage) => stage.name === stageKey);
	if (candidates.length !== 1) return undefined;
	const stage = candidates[0]!;
	return (stage.status === "pending" || stage.status === "running") &&
		stage.sessionId === undefined &&
		stage.sessionFile === undefined
		? stage
		: undefined;
}

function pendingStageDestination(
	run: ReturnType<Store["runs"]>[number],
	entry: PendingStageMessage,
): ReturnType<Store["runs"]>[number]["stages"][number] | undefined {
	if (entry.stageId !== undefined) {
		const candidates = run.stages.filter((stage) => stage.id === entry.stageId);
		return candidates.length === 1 ? candidates[0] : undefined;
	}
	if (entry.stageReplayKey !== undefined) {
		const candidates = run.stages.filter((stage) => stage.replayKey === entry.stageReplayKey);
		return candidates.length === 1 ? candidates[0] : undefined;
	}
	const exactIds = run.stages.filter((stage) => stage.id === entry.stageKey);
	const candidates = exactIds.length > 0 ? exactIds : run.stages.filter((stage) => stage.name === entry.stageKey);
	return candidates.length === 1 ? candidates[0] : undefined;
}

function pendingStageUndeliverableReason(
	run: ReturnType<Store["runs"]>[number],
	entry: PendingStageMessage,
): string | undefined {
	const stage = pendingStageDestination(run, entry);
	if (run.status === "cancelled") {
		return `Workflow run ${run.id} terminated with status cancelled before stage ${entry.stageKey} started`;
	}
	if (stage?.status === "skipped") {
		return `Workflow stage ${entry.stageKey} was skipped${stage.skippedReason ? ` (${stage.skippedReason})` : ""}`;
	}
	if (isTerminalRunStatus(run.status)) {
		return `Workflow run ${run.id} terminated with status ${run.status} before stage ${entry.stageKey} started`;
	}
	return undefined;
}

function needsUndeliverableSettlement(run: ReturnType<Store["runs"]>[number], entry: PendingStageMessage): boolean {
	if (entry.status === "queued") return pendingStageUndeliverableReason(run, entry) !== undefined;
	return (
		entry.status === "undeliverable" &&
		entry.undeliverableNotificationId !== undefined &&
		entry.undeliverableNotifiedAt === undefined &&
		entry.undeliverableReason !== undefined
	);
}

/** Settle queued messages whose destination can no longer enter the pre-start lifecycle window. */
export async function settleUndeliverablePendingStageMessages(
	activeStore: Store,
	notify: (entry: PendingStageMessage, reason: string, notificationId: string) => Promise<boolean>,
): Promise<number> {
	const runs = activeStore.runs();
	if (!runs.some((run) => run.pendingStageMessages?.some((entry) => needsUndeliverableSettlement(run, entry)))) {
		return 0;
	}
	let settled = 0;
	const rootBackend = getDurableBackend();
	for (const run of runs) {
		const backend = durableBackendForRun(rootBackend, runs, run.id);
		if (backend === undefined) {
			throw new Error(`atomic-workflows: workflow run ${run.id} has no durable owner for pending-stage settlement`);
		}
		for (const snapshotEntry of run.pendingStageMessages ?? []) {
			let entry = snapshotEntry;
			if (entry.status === "queued") {
				const reason = pendingStageUndeliverableReason(run, entry);
				if (reason === undefined) continue;
				if (
					await activeStore.markPendingStageMessageUndeliverable(run.id, entry.stageKey, entry.id, reason, backend)
				) {
					settled += 1;
				}
				const currentRun = activeStore.runs().find((candidate) => candidate.id === run.id);
				const currentEntry = currentRun?.pendingStageMessages?.find(
					(candidate) => candidate.stageKey === entry.stageKey && candidate.id === entry.id,
				);
				if (currentEntry === undefined) continue;
				entry = currentEntry;
			}
			if (
				entry.status !== "undeliverable" ||
				entry.undeliverableNotificationId === undefined ||
				entry.undeliverableNotifiedAt !== undefined ||
				entry.undeliverableReason === undefined
			)
				continue;
			if (!(await notify(entry, entry.undeliverableReason, entry.undeliverableNotificationId))) continue;
			await activeStore.markPendingStageMessageUndeliverableNotified(
				run.id,
				entry.stageKey,
				entry.id,
				entry.undeliverableNotificationId,
				new Date().toISOString(),
				backend,
			);
		}
	}
	return settled;
}
