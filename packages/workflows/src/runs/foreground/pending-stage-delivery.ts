import type { CreateAgentSessionOptions } from "@bastani/atomic";

type WorkflowPendingStageDelivery = NonNullable<
	NonNullable<CreateAgentSessionOptions["orchestrationContext"]>["pendingStageDelivery"]
>;
type WorkflowPendingStageDeliver = Parameters<WorkflowPendingStageDelivery["deliverPending"]>[0];
type WorkflowPendingStageRecipient = Parameters<WorkflowPendingStageDelivery["deliverPending"]>[1];
type WorkflowPendingStageSender = Parameters<WorkflowPendingStageDeliver>[0];
type WorkflowPendingStageMessage = Parameters<WorkflowPendingStageDeliver>[1];

import { getDurableBackend } from "../../durable/factory.js";
import { durableBackendForRun, durableRootRunIdForRun } from "../../durable/run-owner-backend.js";
import { workflowPendingStageRouteCapability } from "../../shared/pending-stage-route-capability.js";
import { stageMatchesPathPattern, workflowBoundaryHops } from "../../shared/pending-stage-status.js";
import type { Store } from "../../shared/store.js";
import type { PendingStageMessage } from "../../shared/store-types.js";
import { parseWorkflowStageTarget } from "../../shared/workflow-stage-target.js";

const pendingDeliveryClaims = new WeakMap<Store, Set<string>>();

/**
 * Terminal outcome for a stage whose queued Intercom instructions can no longer
 * be delivered.
 *
 * The stage identity lives here rather than in the delivery owner: only the
 * workflows side knows the run, stage id, and stage name, and only a
 * workflow-authored message belongs in a stage snapshot.
 *
 * The delivery owner's reason is kept on `reason` rather than as `cause`
 * deliberately. `structuredSignal` in the host's shared model-failure
 * classifier walks the `cause` chain, and Intercom's reason nests the transport
 * error that lost the broker — so chaining it made a dead delivery classify as
 * `network_timeout`, which is both same-model retryable and fallback-eligible.
 * The reason text is still carried in `message`, and `reason` is not a field the
 * classifier inspects. The lifecycle guard below is the real barrier; this only
 * stops the shared classifier from misreading the error for any other consumer.
 */
export class WorkflowPendingStageDeliveryFailedError extends Error {
	readonly code = "pending_stage_delivery_failed" as const;
	readonly runId: string;
	readonly stageId: string;
	readonly stageName: string;
	/** The delivery owner's own failure, deliberately not chained as `cause`. */
	readonly reason: Error;

	constructor(runId: string, stageId: string, stageName: string, reason: Error) {
		super(
			`atomic-workflows: stage "${stageName}" (${stageId}) did not start because its queued Intercom instructions could not be delivered: ${reason.message}`,
		);
		this.name = "WorkflowPendingStageDeliveryFailedError";
		this.runId = runId;
		this.stageId = stageId;
		this.stageName = stageName;
		this.reason = reason;
	}
}

/**
 * True for a terminal pending-stage delivery failure, by construction.
 *
 * The stage lifecycle consults this before spending a same-model retry or a
 * model-fallback candidate: a stage refused its queued instructions will be
 * refused them by every candidate, so retrying is pure waste and records
 * misleading attempt and `[fallback]` metadata. The `code` branch covers an
 * error that crossed a package or realm boundary and lost `instanceof`.
 */
export function isWorkflowPendingStageDeliveryFailure(error: unknown): boolean {
	if (error instanceof WorkflowPendingStageDeliveryFailedError) return true;
	return (error as { code?: unknown } | null | undefined)?.code === "pending_stage_delivery_failed";
}

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
	let terminalError: WorkflowPendingStageDeliveryFailedError | undefined;
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
		deliverPending(deliver, recipient) {
			if (drainPromise !== undefined) return drainPromise;
			// After a terminal failure the queue is left exactly as it is: consuming
			// entries for a stage that will not run would mark this stage's steering
			// delivered to nobody. Resolving rather than rejecting keeps a late
			// replay silent, which is the whole point of the terminal signal.
			if (terminalError !== undefined) return Promise.resolve();
			drainError = undefined;
			const attempt = deliverPendingStageMessages(activeStore, runId, stageId, stageName, deliver, recipient);
			const drain = attempt.then(
				() => {
					resolveReady?.();
					readyPromise = undefined;
					resolveReady = undefined;
					rejectReady = undefined;
					if (drainPromise === drain) drainPromise = undefined;
				},
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
			return drainPromise;
		},
		ready(sessionId) {
			if (
				activeStore.pendingStageMessagesFor(runId, stageId).length === 0 &&
				(stageId === stageName || activeStore.pendingStageMessagesFor(runId, stageName).length === 0) &&
				stickyPendingStageEntriesForStage(
					activeStore,
					runId,
					stageId,
					stageName,
					sessionId === undefined ? undefined : { sessionId },
				).length === 0
			) {
				// Nothing was queued, so a terminal failure costs this stage nothing:
				// keep the short circuit first and let the stage run.
				return undefined;
			}
			if (terminalError !== undefined) return Promise.reject(terminalError);
			return drainError === undefined ? pendingReady() : Promise.reject(drainError);
		},
		fail(reason) {
			// First terminal wins and is sticky for the life of this delivery, which
			// `executor-stage-factory` creates once per stage context — so a resumed
			// stage builds a fresh delivery and is not poisoned by this attempt.
			if (terminalError !== undefined) return;
			terminalError = new WorkflowPendingStageDeliveryFailedError(runId, stageId, stageName, reason);
			if (readyPromise === undefined) return;
			// The controller may not have reached its `await` yet; an unobserved
			// rejection must not become a process-level unhandled rejection. A caller
			// that does await still sees the rejection.
			readyPromise.catch(() => {});
			rejectReady?.(terminalError);
		},
	};
}

async function deliverPendingStageMessages(
	activeStore: Store,
	runId: string,
	stageId: string,
	stageName: string,
	deliver: (from: WorkflowPendingStageSender, message: WorkflowPendingStageMessage) => void | Promise<void>,
	recipient?: WorkflowPendingStageRecipient,
): Promise<void> {
	const stickyEntries = stickyPendingStageEntriesForStage(activeStore, runId, stageId, stageName, recipient);
	const candidateIds = new Set(
		[
			...activeStore.pendingStageMessagesFor(runId, stageId),
			...activeStore.pendingStageMessagesFor(runId, stageName),
			...stickyEntries,
		].map((entry) => entry.id),
	);
	const runs = activeStore.runs();
	// Sticky entries live in the ROOT run's bucket, so they are appended explicitly rather
	// than discovered in the stage's own run bucket.
	const entries = [
		...(runs.find((run) => run.id === runId)?.pendingStageMessages ?? [])
			.map((entry, index) => ({ entry, index }))
			.filter(({ entry }) => candidateIds.has(entry.id) && entry.sticky !== true),
		...stickyEntries.map((entry) => ({ entry, index: Number.MAX_SAFE_INTEGER })),
	]
		.sort(
			(left, right) =>
				(left.entry.admissionOrder ?? left.index + 1) - (right.entry.admissionOrder ?? right.index + 1) ||
				left.index - right.index,
		)
		.map(({ entry }) => entry);
	const rootBackend = getDurableBackend();
	const backend = durableBackendForRun(rootBackend, runs, runId);
	if (backend === undefined) {
		throw new Error(`atomic-workflows: workflow run ${runId} has no durable owner for pending-stage delivery`);
	}
	for (const entry of entries) {
		// Sticky entries are claimed per (entry, delivering stage): the stageKey is the
		// shared target path, so without the stage identity two concurrently draining
		// matching stages (ctx.parallel) would race and the loser would silently skip
		// the entry (round-1 review). Exact entries consume the whole entry on delivery,
		// so their per-entry claim is already exclusive.
		const claimOwner = entry.sticky === true ? `${entry.runId}\u0000${runId}:${stageId}` : entry.runId;
		const releaseClaim = claimPendingDelivery(activeStore, claimOwner, entry.stageKey, entry.id);
		if (releaseClaim === undefined) continue;
		try {
			if (!recipient?.receivedMessageIds.includes(entry.message.id))
				await deliver(toPendingStageSender(entry), entry.message);
			if (entry.sticky === true) {
				// D3: sticky entries stay queued for future matching stages; only this
				// stage's exactly-once delivery record is written.
				const entryBackend = durableBackendForRun(rootBackend, activeStore.runs(), entry.runId);
				if (entryBackend === undefined) {
					throw new Error(
						`atomic-workflows: workflow run ${entry.runId} has no durable owner for sticky pending-stage delivery`,
					);
				}
				if (
					!(await activeStore.recordPendingStageMessageDeliveries(
						entry.runId,
						entry.id,
						[
							{
								runId,
								stageId,
								...(stageName === stageId ? {} : { stageName }),
								...(recipient === undefined
									? {}
									: { sessionId: recipient.sessionId, admission: "context" as const }),
							},
						],
						new Date().toISOString(),
						entryBackend,
					))
				) {
					throw new Error(`atomic-workflows: pending-stage message ${entry.id} changed during delivery`);
				}
				continue;
			}
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

/**
 * Sticky (D3) queued entries in the ROOT run's bucket whose target path matches this
 * stage's depth-faithful id-form or name-form path and that have not been delivered to
 * this stage yet.
 */
function stickyPendingStageEntriesForStage(
	activeStore: Store,
	runId: string,
	stageId: string,
	stageName: string,
	recipient?: { readonly sessionId: string; readonly receivedMessageIds?: readonly string[] },
): readonly PendingStageMessage[] {
	const runs = activeStore.runs();
	const rootRunId = durableRootRunIdForRun(runs, runId);
	if (rootRunId === undefined) return [];
	const rootRun = runs.find((run) => run.id === rootRunId);
	if (rootRun === undefined) return [];
	// Hops keep both depth-faithful spellings per ancestor (boundary-stage name or
	// materialized child-run id, D5/D8 clarification), so a sticky target addressed
	// through a materialized run id matches the same future stage as the name form.
	const hops = workflowBoundaryHops(runs, runId);
	if (hops === undefined) return [];
	return (rootRun.pendingStageMessages ?? []).filter((entry) => {
		if (entry.sticky !== true || entry.status !== "queued") return false;
		const parsed = entry.targetPath === undefined ? undefined : parseWorkflowStageTarget(entry.targetPath);
		if (parsed === undefined || parsed.rootRunId !== rootRunId) return false;
		if (
			(entry.deliveries ?? []).some(
				(delivery) =>
					delivery.runId === runId &&
					delivery.stageId === stageId &&
					(recipient === undefined ||
						(delivery.admission === "context" &&
							delivery.sessionId === recipient.sessionId &&
							(recipient.receivedMessageIds === undefined ||
								recipient.receivedMessageIds.includes(entry.message.id)))),
			)
		)
			return false;
		return stageMatchesPathPattern(parsed.segments, hops, [stageId, stageName]);
	});
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
