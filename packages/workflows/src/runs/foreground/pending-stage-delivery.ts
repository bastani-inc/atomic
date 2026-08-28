import type { CreateAgentSessionOptions } from "@bastani/atomic";

type WorkflowPendingStageDelivery = NonNullable<
	NonNullable<CreateAgentSessionOptions["orchestrationContext"]>["pendingStageDelivery"]
>;
type WorkflowPendingStageDeliver = Parameters<WorkflowPendingStageDelivery["deliverPending"]>[0];
type WorkflowPendingStageSender = Parameters<WorkflowPendingStageDeliver>[0];
type WorkflowPendingStageMessage = Parameters<WorkflowPendingStageDeliver>[1];

import { getDurableBackend } from "../../durable/factory.js";
import { durableBackendForRun } from "../../durable/run-owner-backend.js";
import { workflowPendingStageRouteCapability } from "../../shared/pending-stage-route-capability.js";
import type { Store } from "../../shared/store.js";
import type { PendingStageMessage } from "../../shared/store-types.js";

const pendingDeliveryClaims = new WeakMap<Store, Set<string>>();

export function createWorkflowPendingStageDelivery(
	activeStore: Store,
	runId: string,
	stageId: string,
	stageName: string,
): WorkflowPendingStageDelivery {
	let resolveReady: (() => void) | undefined;
	let rejectReady: ((error: Error) => void) | undefined;
	let readyPromise: Promise<void> | undefined;
	let drainError: Error | undefined;
	let drainPromise: Promise<void> | undefined;
	const pendingReady = (): Promise<void> => {
		if (readyPromise === undefined) {
			readyPromise = new Promise<void>((resolve, reject) => {
				resolveReady = resolve;
				rejectReady = reject;
			});
		}
		return readyPromise;
	};
	return {
		routeCapability: workflowPendingStageRouteCapability(activeStore, runId),
		deliverPending(deliver) {
			if (drainPromise === undefined) {
				drainError = undefined;
				const attempt = deliverPendingStageMessages(activeStore, runId, stageId, stageName, deliver);
				const drain = attempt.then(
					() => resolveReady?.(),
					(error: Error) => {
						drainError = error;
						rejectReady?.(error);
						readyPromise = undefined;
						resolveReady = undefined;
						rejectReady = undefined;
						if (drainPromise === drain) drainPromise = undefined;
						throw error;
					},
				);
				drainPromise = drain;
			}
			return drainPromise;
		},
		ready() {
			if (
				activeStore.pendingStageMessagesFor(runId, stageId).length === 0 &&
				(stageId === stageName || activeStore.pendingStageMessagesFor(runId, stageName).length === 0)
			) {
				return undefined;
			}
			return drainError === undefined ? pendingReady() : Promise.reject(drainError);
		},
	};
}

async function deliverPendingStageMessages(
	activeStore: Store,
	runId: string,
	stageId: string,
	stageName: string,
	deliver: (from: WorkflowPendingStageSender, message: WorkflowPendingStageMessage) => void | Promise<void>,
): Promise<void> {
	const candidateIds = new Set(
		[
			...activeStore.pendingStageMessagesFor(runId, stageId),
			...activeStore.pendingStageMessagesFor(runId, stageName),
		].map((entry) => entry.id),
	);
	const entries = (activeStore.runs().find((run) => run.id === runId)?.pendingStageMessages ?? [])
		.map((entry, index) => ({ entry, index }))
		.filter(({ entry }) => candidateIds.has(entry.id))
		.sort(
			(left, right) =>
				(left.entry.admissionOrder ?? left.index + 1) - (right.entry.admissionOrder ?? right.index + 1) ||
				left.index - right.index,
		)
		.map(({ entry }) => entry);
	const rootBackend = getDurableBackend();
	const backend = durableBackendForRun(rootBackend, activeStore.runs(), runId);
	if (backend === undefined) {
		throw new Error(`atomic-workflows: workflow run ${runId} has no durable owner for pending-stage delivery`);
	}
	for (const entry of entries) {
		const releaseClaim = claimPendingDelivery(activeStore, runId, entry.stageKey, entry.id);
		if (releaseClaim === undefined) continue;
		try {
			await deliver(toPendingStageSender(entry), entry.message);
			if (
				!(await activeStore.markPendingStageMessageDelivered(
					runId,
					entry.stageKey,
					entry.id,
					new Date().toISOString(),
					backend,
				))
			) {
				throw new Error(`atomic-workflows: pending-stage message ${entry.id} changed during delivery`);
			}
		} finally {
			releaseClaim();
		}
	}
}

function claimPendingDelivery(
	store: Store,
	runId: string,
	stageKey: string,
	messageId: string,
): (() => void) | undefined {
	let claims = pendingDeliveryClaims.get(store);
	if (claims === undefined) {
		claims = new Set();
		pendingDeliveryClaims.set(store, claims);
	}
	const key = JSON.stringify([runId, stageKey, messageId]);
	if (claims.has(key)) return undefined;
	claims.add(key);
	return () => {
		claims?.delete(key);
		if (claims?.size === 0) pendingDeliveryClaims.delete(store);
	};
}

function toPendingStageSender(entry: PendingStageMessage): WorkflowPendingStageSender {
	return {
		...entry.from,
		cwd: entry.from.cwd ?? "",
		model: entry.from.model ?? "unknown",
		pid: entry.from.pid ?? 0,
		startedAt: entry.from.startedAt ?? entry.message.timestamp,
		lastActivity: entry.from.lastActivity ?? entry.message.timestamp,
	};
}
